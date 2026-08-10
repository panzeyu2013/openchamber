import type { WorkspaceId } from './types';

/**
 * Workspace runtime path rewriting (renderer).
 *
 * The workspace runtime proxy contract (server side:
 * packages/web/server/lib/workspaces/runtime-proxy.js):
 *   /api/workspaces/:workspaceId/runtime/<restPath>
 *
 * SDK base URL for a workspace: `/api/workspaces/:workspaceId/runtime/api`.
 * SDK calls then land on `/api/workspaces/:workspaceId/runtime/api/...`,
 * which the control plane forwards to the workspace's connection adapter.
 *
 * These helpers are pure and shared by the runtime registry and any
 * workspace-scoped fetch; they never mutate global endpoint state.
 */

/** SDK base URL for a workspace handle. */
export const workspaceSdkBaseUrl = (workspaceId: WorkspaceId): string =>
  `/api/workspaces/${encodeURIComponent(workspaceId)}/runtime/api`;

/** Prefix for raw runtime paths (SSE, etc.). */
export const workspaceRuntimePrefix = (workspaceId: WorkspaceId): string =>
  `/api/workspaces/${encodeURIComponent(workspaceId)}/runtime`;

export interface WorkspacePathRewrite {
  rewritten: string;
  restPath: string;
}

/**
 * Rewrites a control-plane runtime path to the workspace prefix. Only
 * `/api/...` paths (the OpenCode/OpenChamber API surface) are rewritten;
 * anything else returns null so callers can decide (never silently forward).
 */
export const rewriteRuntimePathToWorkspace = (
  workspaceId: WorkspaceId,
  inputPath: string,
): WorkspacePathRewrite | null => {
  if (typeof inputPath !== 'string') return null;
  let pathname = inputPath;
  let search = '';
  const queryIndex = inputPath.indexOf('?');
  if (queryIndex >= 0) {
    pathname = inputPath.slice(0, queryIndex);
    search = inputPath.slice(queryIndex);
  }
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    const restPath = pathname === '/api' ? '/api' : pathname;
    return {
      rewritten: `${workspaceRuntimePrefix(workspaceId)}${restPath}${search}`,
      restPath: `${restPath}${search}`,
    };
  }
  return null;
};

/**
 * Rewrites an absolute same-origin URL to the workspace prefix while keeping
 * foreign URLs untouched. Used by workspace-scoped fetch implementations.
 */
export const rewriteRuntimeUrlToWorkspace = (
  workspaceId: WorkspaceId,
  input: string | URL | Request,
): string | null => {
  if (input == null) return null;
  if (input instanceof Request) {
    const url = new URL(input.url);
    if (!isControlPlaneOrigin(url)) return null;
    return rewriteRuntimePathToWorkspace(workspaceId, url.pathname + url.search)?.rewritten ?? null;
  }
  const raw = input.toString();
  if (raw.startsWith('/')) {
    return rewriteRuntimePathToWorkspace(workspaceId, raw)?.rewritten ?? null;
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!isControlPlaneOrigin(url)) return null;
  return rewriteRuntimePathToWorkspace(workspaceId, url.pathname + url.search)?.rewritten ?? null;
};

/** Same-origin with the current control plane (window origin, or any
 * localhost/loopback origin when the window is unavailable, e.g. tests/SSR). */
const isControlPlaneOrigin = (url: URL): boolean => {
  if (typeof window !== 'undefined') {
    if (url.origin === window.location.origin) return true;
  }
  const hostname = url.hostname;
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
};
