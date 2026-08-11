import { afterEach, describe, expect, test } from 'bun:test';
import type { McpStatus } from '@opencode-ai/sdk/v2';
import type { OpencodeService } from '@/lib/opencode/client';
import { clearSyncRefs, setSyncRefs } from '@/sync/sync-refs';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useWorkspaceSessionIndexStore } from '@/workspaces/session-index-store';
import type { WorkspaceSessionSnapshot } from '@/workspaces/types';
import { setWorkspaceRuntimeActive } from '@/contexts/runtimeAPIRegistry';
import { useMcpStore } from './useMcpStore';

const makeSnapshot = (workspaceId: string): WorkspaceSessionSnapshot => ({
  revision: 1,
  sessions: [{
    key: `${workspaceId}\u0000session-${workspaceId}`,
    workspaceId,
    connectionId: 'connection',
    upstreamSessionId: `session-${workspaceId}`,
    directory: '/repo',
    title: workspaceId,
    updatedAt: 1,
    archived: false,
  }],
  freshnessByConnection: {},
});

const setWorkspaceSession = (workspaceId: string): void => {
  useWorkspaceSessionIndexStore.setState({ snapshot: makeSnapshot(workspaceId) });
  useSessionUIStore.setState({
    currentSessionId: `session-${workspaceId}`,
    currentSessionDirectory: '/repo',
  });
};

const clearWorkspaceSession = (): void => {
  useWorkspaceSessionIndexStore.setState({ snapshot: null });
  useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null });
};

const resetStore = (): void => {
  useMcpStore.setState({
    byDirectory: {},
    diagnosticsByDirectory: {},
    loadingKeys: {},
    lastErrorKeys: {},
  });
};

afterEach(() => {
  setWorkspaceRuntimeActive(false);
  clearWorkspaceSession();
  resetStore();
});

describe('useMcpStore workspace scope', () => {
  test('does not reuse same-directory status across workspaces', () => {
    const connected = { status: 'connected' } as McpStatus;
    useMcpStore.setState({
      byDirectory: { 'workspace:ws-a\u0000/repo': { server: connected } },
    });

    setWorkspaceSession('ws-a');
    expect(useMcpStore.getState().getStatusForDirectory('/repo').server).toBe(connected);

    setWorkspaceSession('ws-b');
    expect(useMcpStore.getState().getStatusForDirectory('/repo')).toEqual({});
  });

  test('uses the currently mounted SyncProvider service for workspace requests', async () => {
    setWorkspaceSession('ws-a');
    const requestedDirectories: string[] = [];
    const api = {
      mcp: {
        status: async () => ({ data: { server: { status: 'connected' } } }),
      },
    };
    const service = {
      getApiClient: () => api,
      getScopedApiClient: (directory: string) => {
        requestedDirectories.push(directory);
        return api;
      },
    } as unknown as OpencodeService;
    const sdk = {} as never;
    const childStores = {} as never;
    setSyncRefs(sdk, childStores, '/repo', undefined, service, 'workspace:ws-a');

    await useMcpStore.getState().refresh({ directory: '/repo' });

    expect(requestedDirectories).toEqual(['/repo']);
    expect(useMcpStore.getState().getStatusForDirectory('/repo').server?.status).toBe('connected');
    clearSyncRefs(sdk, childStores);
  });

  test('uses the bound service directory when a workspace action omits one', async () => {
    setWorkspaceRuntimeActive(true);
    setWorkspaceSession('ws-a');
    const requestedDirectories: string[] = [];
    const api = {
      mcp: {
        status: async () => ({ data: { server: { status: 'connected' } } }),
      },
    };
    const service = {
      getDirectory: () => '/bound/workspace',
      getApiClient: () => api,
      getScopedApiClient: (directory: string) => {
        requestedDirectories.push(directory);
        return api;
      },
    } as unknown as OpencodeService;
    const sdk = {} as never;
    const childStores = {} as never;
    setSyncRefs(sdk, childStores, '/bound/workspace', undefined, service, 'workspace:ws-a');

    await useMcpStore.getState().refresh();

    expect(requestedDirectories).toEqual(['/bound/workspace']);
    expect(useMcpStore.getState().getStatusForDirectory()).toEqual({
      server: { status: 'connected' },
    });
    clearSyncRefs(sdk, childStores);
  });

  test('commits a late response to its captured workspace bucket only', async () => {
    setWorkspaceSession('ws-a');
    let resolveStatus!: (value: { data: Record<string, McpStatus> }) => void;
    const statusPromise = new Promise<{ data: Record<string, McpStatus> }>((resolve) => {
      resolveStatus = resolve;
    });
    const api = {
      mcp: {
        status: () => statusPromise,
      },
    };
    const service = {
      getApiClient: () => api,
      getScopedApiClient: () => api,
    } as unknown as OpencodeService;
    const sdk = {} as never;
    const childStores = {} as never;
    setSyncRefs(sdk, childStores, '/repo', undefined, service, 'workspace:ws-a');

    const pending = useMcpStore.getState().refresh({ directory: '/repo' });
    setWorkspaceSession('ws-b');
    resolveStatus({ data: { server: { status: 'connected' } as McpStatus } });
    await pending;

    expect(useMcpStore.getState().getStatusForDirectory('/repo')).toEqual({});
    clearSyncRefs(sdk, childStores);
  });
});
