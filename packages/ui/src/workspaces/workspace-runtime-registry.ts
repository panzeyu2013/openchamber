import { createOpencodeServiceForSdk, createWorkspaceOpencodeClient } from '@/lib/opencode/client';
import { openRuntimeWebSocket } from '@/lib/relay/runtime-socket';
import { TerminalTransport } from '@/lib/terminalApi';
import { withRuntimeUrlAuthToken } from '@/lib/runtime-url';
import { createControlPlaneFetch, getControlPlaneBaseUrl } from './control-plane-fetch';
import { workspaceScopeKey } from './identity';
import { rewriteRuntimePathToWorkspace, workspaceRuntimePrefix, workspaceSdkBaseUrl } from './workspace-runtime-fetch';
import type { WorkspaceDescriptor, WorkspaceId } from './types';
import type {
  CreateTerminalOptions,
  DirectoryListResult,
  FileSearchQuery,
  FileSearchResult,
  FilesAPI,
  ForceKillOptions,
  GitAPI,
  ResizeTerminalPayload,
  RuntimeAPIs,
  TerminalAPI,
  TerminalHandlers,
  TerminalSession,
  TerminalShellOption,
} from '@/lib/api/types';
import { FilesystemError, parseFilesystemErrorReason } from '@/lib/api/files-errors';

export interface RuntimeUrlResolver {
  api(path: string): string;
  health(path: string): string;
  auth(path: string): string;
}

export interface WorkspaceRuntimeHandle {
  workspaceId: WorkspaceId;
  scopeKey: string;
  directory: string;
  sdk: ReturnType<typeof createWorkspaceOpencodeClient>;
  /**
   * The service facade over the same bound SDK. Session actions and prompt
   * sends use this instead of the ambient `opencodeClient` singleton.
   */
  service: ReturnType<typeof createOpencodeServiceForSdk>;
  /** Workspace-bound RuntimeAPIs: OpenChamber-owned capabilities (files, git,
   * terminal, …) route through the workspace runtime proxy prefix on the
   * CURRENT control plane with the workspace directory header. Terminal
   * streaming owns a workspace-scoped socket and URL-auth token. */
  apis: RuntimeAPIs;
  urls: RuntimeUrlResolver;
  retain(): () => void;
  dispose(): void;
}

export interface WorkspaceRuntimeRegistry {
  get(workspace: WorkspaceDescriptor): WorkspaceRuntimeHandle;
  invalidate(workspaceId: WorkspaceId): void;
  dispose(): void;
}

/**
 * A workspace-scoped capability whose server contract does not exist yet.
 * Callers can distinguish this from a transient transport failure and must
 * keep the operation visibly unavailable instead of falling back to the
 * ambient runtime.
 */
class WorkspaceCapabilityUnavailableError extends Error {
  readonly code = 'capability_unavailable';
  readonly status = 501;

  constructor(capability: string) {
    super(`${capability} is not available for a workspace runtime`);
    this.name = 'WorkspaceCapabilityUnavailableError';
  }
}

/**
 * Workspace Runtime Registry.
 *
 * Builds one workspace-bound handle per workspace: an SDK client whose base
 * URL is the control-plane workspace prefix (`/api/workspaces/:id/runtime/api`)
 * and a URL resolver scoped to the same prefix. No global endpoint mutation
 * ever happens here — every request stays on the current control plane and
 * the server resolves the workspace to its connection adapter.
 *
 * - Handles carry a lease (`retain()` / release); the last release schedules
 *   disposal, so a handle can never be evicted while a consumer (full sync,
 *   mini-chat window, notification click) still uses it.
 * - Non-retained handles are held in a bounded LRU; overflow evicts the
 *   least-recently-used handle only after its idle grace.
 * - A handle's SDK client is a lightweight factory product; disposing it
 *   releases nothing server-side (the server connection lifecycle is owned by
 *   the broker's leases).
 */

const MAX_RETAINED_HANDLES = 8;
const DISPOSE_GRACE_MS = 5_000;

const createWorkspaceUrlResolver = (workspaceId: WorkspaceId): RuntimeUrlResolver => {
  const prefix = workspaceSdkBaseUrl(workspaceId);
  return {
    api: (path) => `${prefix}${path}`,
    health: (path) => `${prefix}${path}`,
    auth: (path) => `${prefix}${path}`,
  };
};

// ---------------------------------------------------------------------------
// Workspace-bound RuntimeAPIs
//
// The shared UI has no parameterizable RuntimeAPIs factory (the web assembly
// lives in `packages/web/src/api` and is wired to the ACTIVE runtime), so the
// registry builds a minimal workspace-bound implementation here: every
// OpenChamber-owned request goes to the workspace runtime proxy prefix
// (`/api/workspaces/:id/runtime/...`) on the CURRENT control plane with the
// workspace directory header. Terminal streaming uses the same workspace
// prefix for its WebSocket upgrade and never falls back to the ambient socket.
// ---------------------------------------------------------------------------

const WORKSPACE_DIRECTORY_HEADER = 'x-opencode-directory';

type WorkspaceApiFetch = (
  restPath: string,
  init?: RequestInit,
  directoryOverride?: string,
) => Promise<Response>;

const createWorkspaceApiFetch = (
  workspaceId: WorkspaceId,
  directory: string,
  controlPlaneFetch: typeof fetch,
): WorkspaceApiFetch => {
  return (restPath, init = {}, directoryOverride) => {
    const rewritten = rewriteRuntimePathToWorkspace(workspaceId, restPath);
    if (!rewritten) {
      return Promise.reject(new Error(`Not a runtime API path: ${restPath}`));
    }
    const headers = new Headers(init.headers);
    const targetDirectory = directoryOverride ?? directory;
    if (targetDirectory && !headers.has(WORKSPACE_DIRECTORY_HEADER)) {
      headers.set(WORKSPACE_DIRECTORY_HEADER, targetDirectory);
    }
    return controlPlaneFetch(rewritten.rewritten, { ...init, headers });
  };
};

const responseError = async (response: Response, fallback: string): Promise<Error> => {
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  return new Error(typeof body?.error === 'string' && body.error ? body.error : fallback);
};

const jsonResponse = async <T,>(response: Response, fallback: string): Promise<T> => {
  if (!response.ok) throw await responseError(response, fallback);
  return response.json() as Promise<T>;
};

const noContentResponse = async (response: Response, fallback: string): Promise<void> => {
  if (!response.ok) throw await responseError(response, fallback);
};

const responseDataUrl = async (response: Response): Promise<string> => {
  const blob = await response.blob();
  if (typeof FileReader === 'undefined') {
    throw new Error('Binary file preview is unavailable in this runtime');
  }
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('Binary file preview returned an invalid data URL'));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read binary file preview'));
    reader.readAsDataURL(blob);
  });
};

const normalizeApiPath = (path: string): string => path.replace(/\\/g, '/');

const createWorkspaceFilesApi = (apiFetch: WorkspaceApiFetch, directory: string): FilesAPI => ({
  async listDirectory(path: string, options): Promise<DirectoryListResult> {
    const target = normalizeApiPath(path);
    const params = new URLSearchParams();
    if (target) params.set('path', target);
    if (options?.respectGitignore) params.set('respectGitignore', 'true');
    const response = await apiFetch('/api/fs/list', { query: params } as RequestInit);
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText, reason: undefined })) as {
        error?: string;
        reason?: unknown;
      };
      throw new FilesystemError(error.error || 'Failed to list directory', {
        reason: parseFilesystemErrorReason(error.reason),
        status: response.status,
      });
    }
    const payload = await response.json() as {
      directory?: string;
      path?: string;
      entries?: Array<{ name?: string; path?: string; isDirectory?: boolean; isFile?: boolean; isSymbolicLink?: boolean }>;
    };
    if (!payload || !Array.isArray(payload.entries)) {
      throw new FilesystemError('Directory listing returned an invalid response', { reason: 'invalid-response' });
    }
    return {
      directory: normalizeApiPath(payload?.directory || payload?.path || target),
      entries: payload.entries
        .filter((entry): entry is { name: string; path: string; isDirectory?: boolean } => (
          Boolean(entry && typeof entry.name === 'string' && typeof entry.path === 'string')
        ))
        .map((entry) => ({
          name: entry.name,
          path: normalizeApiPath(entry.path),
          isDirectory: Boolean(entry.isDirectory),
        })),
    };
  },

  async search(payload: FileSearchQuery): Promise<FileSearchResult[]> {
    const directory = normalizeApiPath(payload.directory);
    const params = new URLSearchParams();
    if (directory) params.set('directory', directory);
    params.set('query', payload.query);
    params.set('dirs', 'false');
    params.set('type', 'file');
    if (typeof payload.maxResults === 'number' && Number.isFinite(payload.maxResults)) {
      params.set('limit', String(payload.maxResults));
    }
    const response = await apiFetch('/api/find/file', { query: params } as RequestInit);
    if (!response.ok) throw await responseError(response, 'Failed to search files');
    const result = await response.json() as unknown;
    const files = Array.isArray(result) ? result.filter((entry): entry is string => typeof entry === 'string') : [];
    return files.map((relativePath) => ({
      path: normalizeApiPath(`${directory}/${relativePath}`),
      preview: [normalizeApiPath(relativePath)],
    }));
  },

  async createDirectory(path: string): Promise<{ success: boolean; path: string }> {
    const target = normalizeApiPath(path);
    const response = await apiFetch('/api/fs/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: target }),
    });
    const result = await jsonResponse<{ success?: unknown; path?: unknown }>(response, 'Failed to create directory');
    return {
      success: Boolean(result?.success),
      path: typeof result?.path === 'string' ? normalizeApiPath(result.path) : target,
    };
  },

  async statFile(path: string, options): Promise<{ path: string; isFile: boolean; size: number; mtimeMs?: number }> {
    const target = normalizeApiPath(path);
    const params = new URLSearchParams({ path: target });
    if (options?.allowOutsideWorkspace) params.set('allowOutsideWorkspace', 'true');
    if (options?.outsideFileGrant) params.set('outsideFileGrant', options.outsideFileGrant);
    const response = await apiFetch('/api/fs/stat', { query: params } as RequestInit, options?.directory ?? directory);
    const result = await jsonResponse<{ path?: unknown; isFile?: unknown; size?: unknown; mtimeMs?: unknown }>(
      response,
      'Failed to stat file',
    );
    return {
      path: typeof result?.path === 'string' ? normalizeApiPath(result.path) : target,
      isFile: Boolean(result?.isFile),
      size: typeof result?.size === 'number' ? result.size : 0,
      mtimeMs: typeof result?.mtimeMs === 'number' ? result.mtimeMs : undefined,
    };
  },

  async readFile(path: string, options): Promise<{ content: string; path: string }> {
    const target = normalizeApiPath(path);
    const params = new URLSearchParams({ path: target });
    if (options?.allowOutsideWorkspace) params.set('allowOutsideWorkspace', 'true');
    if (options?.outsideFileGrant) params.set('outsideFileGrant', options.outsideFileGrant);
    if (options?.optional) params.set('optional', 'true');
    const response = await apiFetch('/api/fs/read', {
      query: params,
      cache: options?.optional ? 'no-store' : 'default',
    } as RequestInit, options?.directory ?? directory);
    if (!response.ok) throw await responseError(response, 'Failed to read file');
    return { content: await response.text(), path: target };
  },

  async readFileBinary(path: string, options): Promise<{ dataUrl: string; path: string }> {
    const target = normalizeApiPath(path);
    const params = new URLSearchParams({ path: target });
    if (options?.allowOutsideWorkspace) params.set('allowOutsideWorkspace', 'true');
    if (options?.outsideFileGrant) params.set('outsideFileGrant', options.outsideFileGrant);
    const response = await apiFetch('/api/fs/raw', {
      query: params,
      cache: 'no-store',
    } as RequestInit, options?.directory ?? directory);
    if (!response.ok) throw await responseError(response, 'Failed to read binary file');
    return { dataUrl: await responseDataUrl(response), path: target };
  },

  async writeFile(path: string, content: string): Promise<{ success: boolean; path: string }> {
    const target = normalizeApiPath(path);
    const response = await apiFetch('/api/fs/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: target, content }),
    });
    const result = await jsonResponse<{ success?: unknown; path?: unknown }>(response, 'Failed to write file');
    return {
      success: Boolean(result?.success),
      path: typeof result?.path === 'string' ? normalizeApiPath(result.path) : target,
    };
  },

  async delete(path: string): Promise<{ success: boolean }> {
    const target = normalizeApiPath(path);
    const response = await apiFetch('/api/fs/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: target }),
    });
    const result = await jsonResponse<{ success?: unknown }>(response, 'Failed to delete file');
    return { success: Boolean(result?.success) };
  },

  async rename(oldPath: string, newPath: string): Promise<{ success: boolean; path: string }> {
    const response = await apiFetch('/api/fs/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPath, newPath }),
    });
    const result = await jsonResponse<{ success?: unknown; path?: unknown }>(response, 'Failed to rename file');
    return {
      success: Boolean(result?.success),
      path: typeof result?.path === 'string' ? normalizeApiPath(result.path) : newPath,
    };
  },

  async revealPath(targetPath: string): Promise<{ success: boolean }> {
    const response = await apiFetch('/api/fs/reveal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: normalizeApiPath(targetPath) }),
    });
    const result = await jsonResponse<{ success?: unknown }>(response, 'Failed to reveal path');
    return { success: Boolean(result?.success) };
  },

  async downloadFile(path: string): Promise<void> {
    const target = normalizeApiPath(path);
    const response = await apiFetch('/api/fs/raw', {
      query: { path: target, download: true },
    } as RequestInit);
    if (!response.ok) throw new Error(`Download failed (${response.status})`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = target.split('/').pop() || 'file';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(() => URL.revokeObjectURL(url), 100);
  },
});

const WORKSPACE_URL_AUTH_SKEW_MS = 10_000;

type WorkspaceTerminalApiBundle = {
  api: TerminalAPI;
  dispose: () => void;
};

const createWorkspaceTerminalSocketUrl = (workspaceId: WorkspaceId, token: string): string => {
  const path = `${workspaceRuntimePrefix(workspaceId)}/api/terminal/ws`;
  const controlPlaneBase = getControlPlaneBaseUrl();
  const fallbackBase = typeof window !== 'undefined' ? window.location.href : 'http://openchamber.local';
  const rawUrl = controlPlaneBase
    ? `${controlPlaneBase.replace(/\/+$/, '')}${path}`
    : path;
  const url = new URL(rawUrl, fallbackBase);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return withRuntimeUrlAuthToken(url.toString(), token);
};

const createWorkspaceTerminalTransport = (
  workspaceId: WorkspaceId,
  controlPlaneFetch: typeof fetch,
): TerminalTransport => {
  let token = '';
  let expiresAt = 0;
  let refreshPromise: Promise<string> | null = null;

  const clearToken = (): void => {
    token = '';
    expiresAt = 0;
  };

  const refreshAuth = async (): Promise<string> => {
    if (token && expiresAt > Date.now() + WORKSPACE_URL_AUTH_SKEW_MS) return token;
    if (refreshPromise) return refreshPromise;

    const request = (async () => {
      const response = await controlPlaneFetch('/auth/url-token', {
        method: 'POST',
        credentials: 'include',
      });
      if (!response.ok) {
        clearToken();
        throw new Error(`Failed to mint workspace terminal URL auth token (${response.status})`);
      }
      const payload = await response.json().catch(() => null) as { token?: unknown; expiresAt?: unknown } | null;
      const nextToken = typeof payload?.token === 'string' ? payload.token.trim() : '';
      const nextExpiresAt = typeof payload?.expiresAt === 'number' ? payload.expiresAt : 0;
      if (!nextToken || !Number.isFinite(nextExpiresAt)) {
        clearToken();
        throw new Error('Workspace terminal URL auth token response was invalid');
      }
      token = nextToken;
      expiresAt = nextExpiresAt;
      return token;
    })();
    const trackedPromise = request.finally(() => {
      if (refreshPromise === trackedPromise) refreshPromise = null;
    });
    refreshPromise = trackedPromise;
    return trackedPromise;
  };

  return new TerminalTransport({
    refreshAuth,
    openSocket: () => openRuntimeWebSocket(createWorkspaceTerminalSocketUrl(workspaceId, token)),
    clearUrlAuthToken: clearToken,
  });
};

const createWorkspaceTerminalApi = (
  workspaceId: WorkspaceId,
  apiFetch: WorkspaceApiFetch,
  controlPlaneFetch: typeof fetch,
): WorkspaceTerminalApiBundle => {
  const transport = createWorkspaceTerminalTransport(workspaceId, controlPlaneFetch);
  const command = async (path: string, method: string, body?: unknown): Promise<Response> => {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const response = await apiFetch(path, init);
    if (!response.ok) throw await responseError(response, 'Terminal command failed');
    return response;
  };

  return {
    api: {
    async listShells(): Promise<TerminalShellOption[]> {
      const response = await apiFetch('/api/terminal/shells');
      if (!response.ok) throw await responseError(response, 'Failed to list terminal shells');
      const payload = await response.json().catch(() => []) as unknown;
      return Array.isArray(payload) ? payload as TerminalShellOption[] : [];
    },
    async createSession(options: CreateTerminalOptions): Promise<TerminalSession> {
      return jsonResponse(await command('/api/terminal/create', 'POST', options), 'Failed to create terminal session');
    },
    connect(sessionId: string, handlers: TerminalHandlers) {
      return { close: transport.subscribe(sessionId, handlers) };
    },
    async sendInput(sessionId: string, input: string): Promise<void> {
      await transport.write(sessionId, input);
    },
    async resize(payload: ResizeTerminalPayload): Promise<void> {
      await noContentResponse(
        await command(`/api/terminal/${payload.sessionId}/resize`, 'POST', { cols: payload.cols, rows: payload.rows }),
        'Failed to resize terminal',
      );
    },
    async updateAppearance(sessionId, appearance): Promise<void> {
      await noContentResponse(
        await command(`/api/terminal/${sessionId}/appearance`, 'POST', appearance),
        'Failed to update terminal appearance',
      );
    },
    async close(sessionId: string): Promise<void> {
      await noContentResponse(await command(`/api/terminal/${sessionId}`, 'DELETE'), 'Failed to close terminal');
      transport.forget(sessionId);
    },
    async restartSession(currentSessionId: string, options: CreateTerminalOptions): Promise<TerminalSession> {
      return jsonResponse(
        await command(`/api/terminal/${currentSessionId}/restart`, 'POST', options),
        'Failed to restart terminal session',
      );
    },
    async forceKill(options: ForceKillOptions): Promise<void> {
      await noContentResponse(await command('/api/terminal/force-kill', 'POST', options), 'Failed to kill terminal');
      if (options.sessionId) transport.forget(options.sessionId);
    },
    },
    dispose: () => transport.dispose(),
  };
};

const createWorkspaceGitApi = (apiFetch: WorkspaceApiFetch, directory: string): GitAPI => {
  const get = async <T,>(route: string, params?: Record<string, string | number | boolean | undefined>, fallback?: string): Promise<T> => {
    const query: Record<string, string | number | boolean | undefined> = { ...params };
    const response = await apiFetch(route, { query } as RequestInit);
    if (!response.ok) throw await responseError(response, fallback ?? `Failed to ${route}`);
    return response.json() as Promise<T>;
  };
  const post = async <T,>(route: string, body?: unknown, fallback?: string): Promise<T> => {
    const response = await apiFetch(route, {
      method: 'POST',
      query: directory ? { directory } : undefined,
      headers: { 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    } as RequestInit);
    if (!response.ok) throw await responseError(response, fallback ?? `Failed to ${route}`);
    return response.json() as Promise<T>;
  };

  return {
    checkIsGitRepository: async (dir) => {
      const data = await get<{ isGitRepository?: unknown }>('/api/git/check', { directory: dir }, 'Failed to check git repository');
      return Boolean(data.isGitRepository);
    },
    resolveGitPrimaryRoot: async (dir) => {
      const data = await get<{ root?: unknown }>('/api/git/primary-root', { directory: dir }, 'Failed to resolve git primary root');
      return { root: typeof data.root === 'string' && data.root ? data.root : dir };
    },
    resolveGitTopLevel: async (dir) => {
      const data = await get<{ root?: unknown }>('/api/git/toplevel', { directory: dir }, 'Failed to resolve git toplevel');
      return { root: typeof data.root === 'string' && data.root ? data.root : dir };
    },
    getGitStatus: (dir, options) => get<import('@/lib/api/types').GitStatus>('/api/git/status', { directory: dir, mode: options?.mode }, 'Failed to get git status'),
    getGitDiff: (dir, options) => get<import('@/lib/api/types').GitDiffResponse>('/api/git/diff', {
      directory: dir,
      path: options.path,
      staged: options.staged ? 'true' : undefined,
      contextLines: options.contextLines,
    }, 'Failed to get git diff'),
    getGitFileDiff: (dir, options) => get<import('@/lib/api/types').GitFileDiffResponse>('/api/git/file-diff', {
      directory: dir,
      path: options.path,
      staged: options.staged ? 'true' : undefined,
    }, 'Failed to get git file diff'),
    getGitRangeDiff: (dir, options) => get<import('@/lib/api/types').GitDiffResponse>('/api/git/range-diff', {
      directory: dir,
      base: options.base,
      head: options.head,
      path: options.path,
      contextLines: options.contextLines,
    }, 'Failed to get git range diff'),
    revertGitFile: async (dir, filePath, options) => {
      await post('/api/git/revert', { path: filePath, scope: options?.scope }, 'Failed to revert git changes');
    },
    stageGitFile: async (dir, filePath) => {
      await post('/api/git/stage', { paths: [filePath] }, 'Failed to stage git changes');
    },
    stageGitFiles: async (dir, filePaths) => {
      await post('/api/git/stage', { paths: filePaths }, 'Failed to stage git changes');
    },
    unstageGitFile: async (dir, filePath) => {
      await post('/api/git/unstage', { paths: [filePath] }, 'Failed to unstage git changes');
    },
    unstageGitFiles: async (dir, filePaths) => {
      await post('/api/git/unstage', { paths: filePaths }, 'Failed to unstage git changes');
    },
    stageGitHunk: async (dir, filePath, patch) => {
      await post('/api/git/apply-hunk', { path: filePath, patch, action: 'stage' }, 'Failed to stage git hunk');
    },
    unstageGitHunk: async (dir, filePath, patch) => {
      await post('/api/git/apply-hunk', { path: filePath, patch, action: 'unstage' }, 'Failed to unstage git hunk');
    },
    revertGitHunk: async (dir, filePath, patch) => {
      await post('/api/git/apply-hunk', { path: filePath, patch, action: 'discard' }, 'Failed to discard git hunk');
    },
    isLinkedWorktree: async (dir) => {
      if (!dir) return false;
      const data = await get<{ linked?: unknown }>('/api/git/worktree-type', { directory: dir }, 'Failed to detect worktree type');
      return Boolean(data.linked);
    },
    getGitBranches: (dir) => get<import('@/lib/api/types').GitBranch>('/api/git/branches', { directory: dir }, 'Failed to get branches'),
    deleteGitBranch: (dir, payload) => post<{ success: boolean }>('/api/git/branches', payload, 'Failed to delete branch'),
    deleteRemoteBranch: (dir, payload) => post<{ success: boolean }>('/api/git/remote-branches', payload, 'Failed to delete remote branch'),
    removeRemote: (dir, payload) => post<{ success: boolean }>('/api/git/remotes', payload, 'Failed to remove remote'),
    generateCommitMessage: (dir, files, options) => post<{ message: import('@/lib/api/types').GeneratedCommitMessage }>('/api/git/commit-message', {
      files,
      ...(options?.providerId ? { providerId: options.providerId } : {}),
      ...(options?.modelId ? { modelId: options.modelId } : {}),
    }, 'Failed to generate commit message'),
    generatePullRequestDescription: (dir, payload) => post<import('@/lib/api/types').GeneratedPullRequestDescription>('/api/git/pr-description', payload, 'Failed to generate PR description'),
    listGitWorktrees: (dir) => get<import('@/lib/api/types').GitWorktreeInfo[]>('/api/git/worktrees', { directory: dir }, 'Failed to list git worktrees'),
    validateGitWorktree: (dir, payload) => post<import('@/lib/api/types').GitWorktreeValidationResult>('/api/git/worktrees/validate', payload, 'Failed to validate worktree'),
    getGitWorktreeBootstrapStatus: (dir) => get<import('@/lib/api/types').GitWorktreeBootstrapStatus>('/api/git/worktrees/bootstrap-status', { directory: dir }, 'Failed to get worktree bootstrap status'),
    previewGitWorktree: (dir, payload) => post<import('@/lib/api/types').GitWorktreeCreateResult>('/api/git/worktrees/preview', payload, 'Failed to preview worktree'),
    createGitWorktree: (dir, payload) => post<import('@/lib/api/types').GitWorktreeCreateResult>('/api/git/worktrees', payload, 'Failed to create worktree'),
    deleteGitWorktree: (dir, payload) => post<{ success: boolean }>('/api/git/worktrees/delete', payload, 'Failed to delete worktree'),
    createGitCommit: async (dir, message, options = {}) => {
      const result = await post<import('@/lib/api/types').GitCommitResult>('/api/git/commit', {
        message,
        addAll: options.addAll ?? false,
        files: options.files,
        stageFiles: options.stageFiles,
      }, 'Failed to create commit');
      return result;
    },
    gitPush: (dir, options) => post<import('@/lib/api/types').GitPushResult>('/api/git/push', options, 'Failed to push'),
    gitPull: (dir, options) => post<import('@/lib/api/types').GitPullResult>('/api/git/pull', options, 'Failed to pull'),
    gitFetch: (dir, options) => post<{ success: boolean }>('/api/git/fetch', options, 'Failed to fetch'),
    listGitStashes: (dir) => get<{ stashes: import('@/lib/api/types').GitStashEntry[] }>('/api/git/stashes', { directory: dir }, 'Failed to list stashes'),
    countGitStashFiles: (dir, refs) => post<{ counts: Record<string, number> }>('/api/git/stashes/file-counts', { refs }, 'Failed to count stash files'),
    stashGitChanges: (dir, options = {}) => post<{ success: boolean; created: boolean; message: string; output: string }>('/api/git/stash', options, 'Failed to stash changes'),
    applyGitStash: (dir, options) => post<{ success: boolean; ref: string }>('/api/git/stash/apply', options, 'Failed to apply stash'),
    popGitStash: (dir, options) => post<{ success: boolean; ref: string }>('/api/git/stash/pop', options, 'Failed to pop stash'),
    dropGitStash: (dir, options) => post<{ success: boolean; ref: string }>('/api/git/stash/drop', options, 'Failed to drop stash'),
    checkoutBranch: (dir, branch) => post<{ success: boolean; branch: string }>('/api/git/checkout', { branch }, 'Failed to checkout branch'),
    createBranch: (dir, name, startPoint) => post<{ success: boolean; branch: string }>('/api/git/branches', { name, startPoint }, 'Failed to create branch'),
    renameBranch: async (dir, oldName, newName) => {
      const response = await apiFetch('/api/git/branches/rename', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldName, newName }),
      });
      return jsonResponse(response, 'Failed to rename branch');
    },
    getGitLog: (dir, options = {}) => get<import('@/lib/api/types').GitLogResponse>('/api/git/log', {
      directory: dir,
      maxCount: options.maxCount,
      from: options.from,
      to: options.to,
      file: options.file,
      all: options.all ? 'true' : undefined,
    }, 'Failed to get git log'),
    getCommitFiles: (dir, hash) => get<import('@/lib/api/types').GitCommitFilesResponse>('/api/git/commit-files', { directory: dir, hash }, 'Failed to get commit files'),
    getCommitFileDiff: (dir, hash, filePath, isBinary) => get<import('@/lib/api/types').CommitFileDiffResponse>('/api/git/commit-file-diff', {
      directory: dir,
      hash,
      filePath,
      isBinary: isBinary ? 'true' : undefined,
    }, 'Failed to get commit file diff'),
    getGitIdentities: () => get<import('@/lib/api/types').GitIdentityProfile[]>('/api/git/identities', undefined, 'Failed to get git identities'),
    createGitIdentity: (profile) => post<import('@/lib/api/types').GitIdentityProfile>('/api/git/identities', profile, 'Failed to create git identity'),
    updateGitIdentity: async (id, updates) => {
      const response = await apiFetch(`/api/git/identities/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      return jsonResponse(response, 'Failed to update git identity');
    },
    deleteGitIdentity: async (id) => {
      const response = await apiFetch(`/api/git/identities/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await noContentResponse(response, 'Failed to delete git identity');
    },
    getCurrentGitIdentity: async (dir) => {
      if (!dir) return null;
      const data = await get<{ userName?: unknown; userEmail?: unknown; sshCommand?: unknown } | null>(
        '/api/git/current-identity',
        { directory: dir },
        'Failed to get current git identity',
      );
      if (!data) return null;
      return {
        userName: typeof data.userName === 'string' ? data.userName : null,
        userEmail: typeof data.userEmail === 'string' ? data.userEmail : null,
        sshCommand: typeof data.sshCommand === 'string' ? data.sshCommand : null,
      };
    },
    hasLocalIdentity: async (dir) => {
      if (!dir) return false;
      const data = await get<{ hasLocalIdentity?: unknown }>('/api/git/has-local-identity', { directory: dir }, 'Failed to check local identity');
      return data?.hasLocalIdentity === true;
    },
    getGlobalGitIdentity: async () => {
      const data = await get<{ userName?: unknown; userEmail?: unknown; sshCommand?: unknown } | null>(
        '/api/git/global-identity',
        undefined,
        'Failed to get global git identity',
      );
      if (!data || (!data.userName && !data.userEmail)) return null;
      return {
        userName: typeof data.userName === 'string' ? data.userName : null,
        userEmail: typeof data.userEmail === 'string' ? data.userEmail : null,
        sshCommand: typeof data.sshCommand === 'string' ? data.sshCommand : null,
      };
    },
    setGitIdentity: (dir, profileId) => post<{ success: boolean; profile: import('@/lib/api/types').GitIdentityProfile }>('/api/git/set-identity', { profileId }, 'Failed to set git identity'),
    discoverGitCredentials: () => get('/api/git/discover-credentials', undefined, 'Failed to discover git credentials'),
    getRemoteUrl: async (dir, remote) => {
      if (!dir) return null;
      const data = await get<{ url?: unknown } | null>('/api/git/remote-url', { directory: dir, remote }, 'Failed to get remote url');
      return typeof data?.url === 'string' ? data.url : null;
    },
    getRemotes: (dir) => get<import('@/lib/api/types').GitRemote[]>('/api/git/remotes', { directory: dir }, 'Failed to get remotes'),
    rebase: (dir, options) => post<import('@/lib/api/types').GitRebaseResult>('/api/git/rebase', options, 'Failed to rebase'),
    abortRebase: () => post<{ success: boolean }>('/api/git/rebase/abort', undefined, 'Failed to abort rebase'),
    continueRebase: () => post<{ success: boolean; conflict: boolean; conflictFiles?: string[] }>('/api/git/rebase/continue', undefined, 'Failed to continue rebase'),
    merge: (dir, options) => post<import('@/lib/api/types').GitMergeResult>('/api/git/merge', options, 'Failed to merge'),
    abortMerge: () => post<{ success: boolean }>('/api/git/merge/abort', undefined, 'Failed to abort merge'),
    continueMerge: () => post<{ success: boolean; conflict: boolean; conflictFiles?: string[] }>('/api/git/merge/continue', undefined, 'Failed to continue merge'),
    checkoutCommit: (dir, hash) => post<import('@/lib/api/types').CheckoutCommitResponse>('/api/git/checkout-commit', { hash }, 'Failed to checkout commit'),
    cherryPick: (dir, hash) => post<import('@/lib/api/types').CherryPickResponse>('/api/git/cherry-pick', { hash }, 'Failed to cherry-pick'),
    revertCommit: (dir, hash) => post<import('@/lib/api/types').RevertCommitResponse>('/api/git/revert-commit', { hash }, 'Failed to revert commit'),
    resetToCommit: (dir, hash, mode, force) => post<import('@/lib/api/types').ResetToCommitResponse>('/api/git/reset-to-commit', { hash, mode, force }, 'Failed to reset to commit'),
    stash: (dir, options = {}) => post<{ success: boolean }>('/api/git/stash', options, 'Failed to stash'),
    stashPop: () => post<{ success: boolean }>('/api/git/stash/pop', undefined, 'Failed to pop stash'),
    getConflictDetails: (dir) => get<import('@/lib/api/types').MergeConflictDetails>('/api/git/conflict-details', { directory: dir }, 'Failed to get conflict details'),
    validateWorktreeDirectory: (dir, worktreeRoot) => post<import('@/lib/api/types').GitAPI['validateWorktreeDirectory'] extends (d: string, w: string) => Promise<infer R> ? R : never>('/api/git/validate-directory', { directory: dir, worktreeRoot }, 'Failed to validate worktree directory'),
    canonicalizeWorktreeState: (dir) => post<import('@/lib/api/types').GitAPI['canonicalizeWorktreeState'] extends (d: string) => Promise<infer R> ? R : never>('/api/git/canonicalize-worktree-state', { directory: dir }, 'Failed to canonicalize worktree state'),
  };
};

const createWorkspaceRuntimeApis = (
  workspaceId: WorkspaceId,
  directory: string,
  controlPlaneFetch: typeof fetch,
): { apis: RuntimeAPIs; dispose: () => void } => {
  const apiFetch = createWorkspaceApiFetch(workspaceId, directory, controlPlaneFetch);
  const terminal = createWorkspaceTerminalApi(workspaceId, apiFetch, controlPlaneFetch);
  return {
    apis: {
      runtime: { platform: 'web', isDesktop: false, isVSCode: false, label: `workspace:${workspaceId}` },
      files: createWorkspaceFilesApi(apiFetch, directory),
      git: createWorkspaceGitApi(apiFetch, directory),
      terminal: terminal.api,
      settings: {
        load: () => Promise.reject(new WorkspaceCapabilityUnavailableError('Workspace settings')),
        save: () => Promise.reject(new WorkspaceCapabilityUnavailableError('Workspace settings')),
      },
      permissions: {
        requestDirectoryAccess: () => Promise.resolve({ success: false, error: 'Directory access is managed by the workspace connection' }),
        startAccessingDirectory: () => Promise.resolve({ success: false }),
        stopAccessingDirectory: () => Promise.resolve({ success: false }),
      },
      notifications: {
        notifyAgentCompletion: () => Promise.resolve(false),
      },
      tools: {
        getAvailableTools: () => Promise.resolve([]),
      },
    },
    dispose: terminal.dispose,
  };
};

export const createWorkspaceRuntimeRegistry = (dependencies: {
  maxRetained?: number;
  disposeGraceMs?: number;
  /** Pinned fetch seam for focused workspace transport tests. */
  controlPlaneFetch?: typeof fetch;
  /** SDK factory seam for tests; defaults to the workspace-bound SDK
   * factory on the control-plane pinned fetch. */
  createSdkClient?: (config: { baseUrl: string; directory: string; fetch?: typeof fetch }) => unknown;
} = {}): WorkspaceRuntimeRegistry => {
  const maxRetained = dependencies.maxRetained ?? MAX_RETAINED_HANDLES;
  const disposeGraceMs = dependencies.disposeGraceMs ?? DISPOSE_GRACE_MS;
  const createSdkClient = dependencies.createSdkClient ?? ((config: { baseUrl: string; directory: string; fetch?: typeof fetch }) => (
    createWorkspaceOpencodeClient(config as { baseUrl: string; directory: string })
  ));

  const handles = new Map<WorkspaceId, WorkspaceRuntimeHandle>();
  const leaseCounts = new Map<WorkspaceId, number>();
  const idleTimers = new Map<WorkspaceId, ReturnType<typeof setTimeout>>();
  let evictionScheduled = false;
  // One pinned control-plane fetch shared by every workspace SDK client: the
  // workspace prefix is resolved against the CURRENT control plane, never the
  // Active Runtime.
  const controlPlaneFetch = dependencies.controlPlaneFetch ?? createControlPlaneFetch();

  const clearIdleTimer = (workspaceId: WorkspaceId): void => {
    const timer = idleTimers.get(workspaceId);
    if (timer) {
      clearTimeout(timer);
      idleTimers.delete(workspaceId);
    }
  };

  const scheduleEviction = (): void => {
    if (evictionScheduled) return;
    evictionScheduled = true;
    // Coalesced deferred pass: a render mounting many handles scans once.
    setTimeout(() => {
      evictionScheduled = false;
      for (const [workspaceId, handle] of handles) {
        if ((leaseCounts.get(workspaceId) ?? 0) === 0 && handles.size > maxRetained) {
          handles.delete(workspaceId);
          handle.dispose();
        }
      }
    }, 0);
  };

  const get = (workspace: WorkspaceDescriptor): WorkspaceRuntimeHandle => {
    const existing = handles.get(workspace.id);
    if (existing) {
      clearIdleTimer(workspace.id);
      return existing;
    }
    const sdk = createSdkClient({
      baseUrl: workspaceSdkBaseUrl(workspace.id),
      directory: workspace.canonicalPath,
      fetch: controlPlaneFetch,
    }) as WorkspaceRuntimeHandle['sdk'];
    const service = createOpencodeServiceForSdk({
      client: sdk,
      baseUrl: workspaceSdkBaseUrl(workspace.id),
      directory: workspace.canonicalPath,
      scopeKey: workspaceScopeKey(workspace.id),
      fetch: controlPlaneFetch,
      createScopedClient: (directory) => createWorkspaceOpencodeClient({
        baseUrl: workspaceSdkBaseUrl(workspace.id),
        directory,
        fetch: controlPlaneFetch,
      }),
    });
    const workspaceApis = createWorkspaceRuntimeApis(workspace.id, workspace.canonicalPath, controlPlaneFetch);
    const handle: WorkspaceRuntimeHandle = {
      workspaceId: workspace.id,
      scopeKey: workspaceScopeKey(workspace.id),
      directory: workspace.canonicalPath,
      sdk,
      service,
      apis: workspaceApis.apis,
      urls: createWorkspaceUrlResolver(workspace.id),
      retain: () => {
        leaseCounts.set(workspace.id, (leaseCounts.get(workspace.id) ?? 0) + 1);
        clearIdleTimer(workspace.id);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          const next = Math.max(0, (leaseCounts.get(workspace.id) ?? 1) - 1);
          leaseCounts.set(workspace.id, next);
          if (next === 0) {
            const timer = setTimeout(() => {
              idleTimers.delete(workspace.id);
              if ((leaseCounts.get(workspace.id) ?? 0) === 0) {
                handles.delete(workspace.id);
                handle.dispose();
              }
            }, disposeGraceMs);
            idleTimers.set(workspace.id, timer);
          }
        };
      },
      dispose: () => {
        clearIdleTimer(workspace.id);
        leaseCounts.delete(workspace.id);
        handles.delete(workspace.id);
        workspaceApis.dispose();
      },
    };
    handles.set(workspace.id, handle);
    scheduleEviction();
    return handle;
  };

  const invalidate = (workspaceId: WorkspaceId): void => {
    const handle = handles.get(workspaceId);
    if (handle) handle.dispose();
  };

  const dispose = (): void => {
    for (const handle of handles.values()) {
      clearIdleTimer(handle.workspaceId);
      handle.dispose();
    }
    handles.clear();
    leaseCounts.clear();
  };

  return { get, invalidate, dispose };
};
