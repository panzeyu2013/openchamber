import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { McpStatus } from '@opencode-ai/sdk/v2';
import type { OpencodeService } from '@/lib/opencode/client';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { getSyncOpencodeService } from '@/sync/sync-refs';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { resolveActiveProjectId, useProjectSessionIndexStore } from '@/projects/session-index-store';
import { projectScopeKey } from '@/projects/identity';
import { isProjectRuntimeActive } from '@/contexts/runtimeAPIRegistry';

export type McpStatusMap = Record<string, McpStatus>;
type McpRuntimeDiagnostic = {
  status: 'failed';
  error: string;
};
type McpRuntimeDiagnosticMap = Record<string, McpRuntimeDiagnostic>;

const EMPTY_STATUS: McpStatusMap = {};
const EMPTY_DIAGNOSTICS: McpRuntimeDiagnosticMap = {};

type McpHealth = {
  connected: number;
  total: number;
  hasFailed: boolean;
  hasAuthRequired: boolean;
};

const normalizeDirectory = (directory: string | null | undefined): string | null => {
  if (typeof directory !== 'string') return null;
  const trimmed = directory.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\\/g, '/');
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
};

const toKey = (directory: string | null | undefined): string => normalizeDirectory(directory) ?? '__global__';

const resolveMcpScopeKey = (): string => {
  const { currentSessionId, currentSessionDirectory } = useSessionUIStore.getState();
  const sessions = useProjectSessionIndexStore.getState().snapshot?.sessions;
  const projectId = resolveActiveProjectId(sessions, currentSessionId, currentSessionDirectory);
  return projectId ? projectScopeKey(projectId) : '';
};

type McpTransport = Pick<OpencodeService, 'getApiClient' | 'getScopedApiClient'> & {
  getDirectory?: OpencodeService['getDirectory'];
};
type McpRequestContext = {
  scopeKey?: string;
  service?: McpTransport;
};

const scopedDirectoryKey = (scopeKey: string, directory: string): string => `${scopeKey}\u0000${directory}`;

const resolveMcpContext = (context?: McpRequestContext): { scopeKey: string; service: McpTransport } => ({
  scopeKey: context?.scopeKey ?? resolveMcpScopeKey(),
  service: context?.service ?? getSyncOpencodeService(),
});

const getMcpApiClient = (directory: string | null | undefined, service: McpTransport) => {
  const normalized = normalizeDirectory(directory);
  if (!normalized) {
    return service.getApiClient();
  }
  return service.getScopedApiClient(normalized);
};

const getDefaultMcpDirectory = (service?: McpTransport): string | null => {
  if (!isProjectRuntimeActive()) {
    return useDirectoryStore.getState().currentDirectory;
  }

  // MCP status/actions are already SDK-backed, but an omitted directory used
  // to fall back to the legacy DirectoryStore. Prefer the mounted service's
  // directory so same-path projects cannot borrow one another's state.
  return service?.getDirectory?.() ?? getSyncOpencodeService().getDirectory() ?? null;
};

export const computeMcpHealth = (status: McpStatusMap | null | undefined): McpHealth => {
  const entries = Object.entries(status ?? {});
  const connected = entries.filter(([, s]) => s?.status === 'connected').length;
  const total = entries.length;
  const hasFailed = entries.some(([, s]) => s?.status === 'failed');
  const hasAuthRequired = entries.some(([, s]) => s?.status === 'needs_auth' || s?.status === 'needs_client_registration');
  return { connected, total, hasFailed, hasAuthRequired };
};

type RefreshOptions = {
  directory?: string | null;
  silent?: boolean;
  scopeKey?: string;
  service?: McpTransport;
};

type TestConnectionResult = {
  status?: McpStatus;
  error?: string;
  warning?: string;
};

interface McpStore {
  byDirectory: Record<string, McpStatusMap>;
  diagnosticsByDirectory: Record<string, McpRuntimeDiagnosticMap>;
  loadingKeys: Record<string, boolean>;
  lastErrorKeys: Record<string, string | null>;

  getStatusForDirectory: (directory?: string | null) => McpStatusMap;
  getDiagnosticForDirectory: (directory?: string | null) => McpRuntimeDiagnosticMap;
  getErrorForDirectory: (directory?: string | null) => string | null;
  refresh: (options?: RefreshOptions) => Promise<void>;
  connect: (name: string, directory?: string | null) => Promise<void>;
  disconnect: (name: string, directory?: string | null) => Promise<void>;
  startAuth: (name: string, directory?: string | null) => Promise<string>;
  completeAuth: (name: string, code: string, directory?: string | null) => Promise<void>;
  clearAuth: (name: string, directory?: string | null) => Promise<void>;
  testConnection: (name: string, directory?: string | null) => Promise<TestConnectionResult>;
}

export const useMcpStore = create<McpStore>()(
  devtools((set, get) => ({
    byDirectory: {},
    diagnosticsByDirectory: {},
    loadingKeys: {},
    lastErrorKeys: {},

    getStatusForDirectory: (directory) => {
      const key = scopedDirectoryKey(
        resolveMcpScopeKey(),
        toKey(directory ?? getDefaultMcpDirectory()),
      );
      return get().byDirectory[key] ?? EMPTY_STATUS;
    },

    getDiagnosticForDirectory: (directory) => {
      const key = scopedDirectoryKey(
        resolveMcpScopeKey(),
        toKey(directory ?? getDefaultMcpDirectory()),
      );
      return get().diagnosticsByDirectory[key] ?? EMPTY_DIAGNOSTICS;
    },

    getErrorForDirectory: (directory) => {
      const key = scopedDirectoryKey(
        resolveMcpScopeKey(),
        toKey(directory ?? getDefaultMcpDirectory()),
      );
      return get().lastErrorKeys[key] ?? null;
    },

    refresh: async (options) => {
      const context = resolveMcpContext(options);
      const directory = normalizeDirectory(options?.directory ?? getDefaultMcpDirectory(context.service));
      const key = scopedDirectoryKey(context.scopeKey, toKey(directory));

      if (!options?.silent) {
        set((state) => ({
          loadingKeys: { ...state.loadingKeys, [key]: true },
          lastErrorKeys: { ...state.lastErrorKeys, [key]: null },
        }));
      }

      try {
        const api = getMcpApiClient(directory, context.service);
        const result = await api.mcp.status();
        const data = (result.data ?? {}) as McpStatusMap;

        set((state) => ({
          byDirectory: { ...state.byDirectory, [key]: data },
          diagnosticsByDirectory: {
            ...state.diagnosticsByDirectory,
            [key]: Object.fromEntries(
              Object.entries(state.diagnosticsByDirectory[key] ?? {}).filter(([name]) => !data[name])
            ),
          },
          loadingKeys: { ...state.loadingKeys, [key]: false },
          lastErrorKeys: { ...state.lastErrorKeys, [key]: null },
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to load MCP status';
        set((state) => ({
          loadingKeys: { ...state.loadingKeys, [key]: false },
          lastErrorKeys: { ...state.lastErrorKeys, [key]: message },
        }));
      }
    },

    connect: async (name, directory) => {
      const context = resolveMcpContext();
      const normalized = normalizeDirectory(directory ?? getDefaultMcpDirectory(context.service));
      const key = scopedDirectoryKey(context.scopeKey, toKey(normalized));
      const api = getMcpApiClient(normalized, context.service);
      try {
        await api.mcp.connect({ name }, { throwOnError: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Connection failed';
        set((state) => ({
          diagnosticsByDirectory: {
            ...state.diagnosticsByDirectory,
            [key]: {
              ...(state.diagnosticsByDirectory[key] ?? {}),
              [name]: { status: 'failed', error: message },
            },
          },
        }));
        throw error;
      }
      await get().refresh({ directory: normalized, silent: true, ...context });
    },

    disconnect: async (name, directory) => {
      const context = resolveMcpContext();
      const normalized = normalizeDirectory(directory ?? getDefaultMcpDirectory(context.service));
      const api = getMcpApiClient(normalized, context.service);
      await api.mcp.disconnect({ name }, { throwOnError: true });
      await get().refresh({ directory: normalized, silent: true, ...context });
    },

    startAuth: async (name, directory) => {
      const context = resolveMcpContext();
      const normalized = normalizeDirectory(directory ?? getDefaultMcpDirectory(context.service));
      const api = getMcpApiClient(normalized, context.service);
      const result = await api.mcp.auth.start({ name }, { throwOnError: true });
      const authorizationUrl = result.data?.authorizationUrl;

      if (!authorizationUrl) {
        throw new Error('Authorization URL was not returned');
      }

      return authorizationUrl;
    },


    completeAuth: async (name, code, directory) => {
      const context = resolveMcpContext();
      const normalized = normalizeDirectory(directory ?? getDefaultMcpDirectory(context.service));
      const api = getMcpApiClient(normalized, context.service);
      await api.mcp.auth.callback({ name, code }, { throwOnError: true });
      await get().refresh({ directory: normalized, silent: true, ...context });
    },

    clearAuth: async (name, directory) => {
      const context = resolveMcpContext();
      const normalized = normalizeDirectory(directory ?? getDefaultMcpDirectory(context.service));
      const api = getMcpApiClient(normalized, context.service);
      await api.mcp.auth.remove({ name }, { throwOnError: true });

      // Removing the stored tokens does not touch the live session, so the
      // server kept reporting `connected` until something forced a reconnect —
      // the user had to run a connection test to see that authorization was
      // gone. Dropping the connection makes the reported state match the
      // credentials that remain.
      await api.mcp.disconnect({ name }).catch(() => undefined);

      await get().refresh({ directory: normalized, silent: true, ...context });
    },

    testConnection: async (name, directory) => {
      const context = resolveMcpContext();
      const normalized = normalizeDirectory(directory ?? getDefaultMcpDirectory(context.service));
      const key = scopedDirectoryKey(context.scopeKey, toKey(normalized));
      const api = getMcpApiClient(normalized, context.service);
      const previousStatus = get().byDirectory[key]?.[name];
      const wasConnected = previousStatus?.status === 'connected';
      let errorMessage: string | undefined;
      let warningMessage: string | undefined;

      try {
        await api.mcp.connect({ name }, { throwOnError: true });
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : 'Connection failed';
        set((state) => ({
          diagnosticsByDirectory: {
            ...state.diagnosticsByDirectory,
            [key]: {
              ...(state.diagnosticsByDirectory[key] ?? {}),
              [name]: { status: 'failed', error: errorMessage ?? 'Connection failed' },
            },
          },
        }));
      }

      await get().refresh({ directory: normalized, silent: true, ...context });
      const currentStatus = get().byDirectory[key]?.[name];
      const observedStatus = currentStatus;

      if (!wasConnected && currentStatus?.status === 'connected') {
        try {
          await api.mcp.disconnect({ name }, { throwOnError: true });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Disconnect failed';
          warningMessage = `Connection test succeeded, but cleanup disconnect failed: ${message}`;
        }
        await get().refresh({ directory: normalized, silent: true, ...context });
      }

      return {
        status: observedStatus ?? get().byDirectory[key]?.[name],
        error: errorMessage,
        warning: warningMessage,
      };
    },

  }))
);
