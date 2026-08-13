import { afterEach, describe, expect, test } from 'bun:test';
import type { McpStatus } from '@opencode-ai/sdk/v2';
import type { OpencodeService } from '@/lib/opencode/client';
import { clearSyncRefs, setSyncRefs } from '@/sync/sync-refs';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useProjectSessionIndexStore } from '@/projects/session-index-store';
import type { ProjectSessionSnapshot } from '@/projects/types';
import { setProjectRuntimeActive } from '@/contexts/runtimeAPIRegistry';
import { useMcpStore } from './useMcpStore';

const makeSnapshot = (projectId: string): ProjectSessionSnapshot => ({
  revision: 1,
  sessions: [{
    key: `${projectId}\u0000session-${projectId}`,
    projectId,
    connectionId: 'connection',
    upstreamSessionId: `session-${projectId}`,
    directory: '/repo',
    title: projectId,
    updatedAt: 1,
    archived: false,
    createdAt: 1,
  }],
  freshnessByConnection: {},
});

const setProjectSession = (projectId: string): void => {
  useProjectSessionIndexStore.setState({ snapshot: makeSnapshot(projectId) });
  useSessionUIStore.setState({
    currentSessionId: `session-${projectId}`,
    currentSessionDirectory: '/repo',
  });
};

const clearProjectSession = (): void => {
  useProjectSessionIndexStore.setState({ snapshot: null });
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
  setProjectRuntimeActive(false);
  clearProjectSession();
  resetStore();
});

describe('useMcpStore project scope', () => {
  test('does not reuse same-directory status across projects', () => {
    const connected = { status: 'connected' } as McpStatus;
    useMcpStore.setState({
      byDirectory: { 'project:ws-a\u0000/repo': { server: connected } },
    });

    setProjectSession('ws-a');
    expect(useMcpStore.getState().getStatusForDirectory('/repo').server).toBe(connected);

    setProjectSession('ws-b');
    expect(useMcpStore.getState().getStatusForDirectory('/repo')).toEqual({});
  });

  test('uses the currently mounted SyncProvider service for project requests', async () => {
    setProjectSession('ws-a');
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
    setSyncRefs(sdk, childStores, '/repo', undefined, service, 'project:ws-a');

    await useMcpStore.getState().refresh({ directory: '/repo' });

    expect(requestedDirectories).toEqual(['/repo']);
    expect(useMcpStore.getState().getStatusForDirectory('/repo').server?.status).toBe('connected');
    clearSyncRefs(sdk, childStores);
  });

  test('uses the bound service directory when a project action omits one', async () => {
    setProjectRuntimeActive(true);
    setProjectSession('ws-a');
    const requestedDirectories: string[] = [];
    const api = {
      mcp: {
        status: async () => ({ data: { server: { status: 'connected' } } }),
      },
    };
    const service = {
      getDirectory: () => '/bound/project',
      getApiClient: () => api,
      getScopedApiClient: (directory: string) => {
        requestedDirectories.push(directory);
        return api;
      },
    } as unknown as OpencodeService;
    const sdk = {} as never;
    const childStores = {} as never;
    setSyncRefs(sdk, childStores, '/bound/project', undefined, service, 'project:ws-a');

    await useMcpStore.getState().refresh();

    expect(requestedDirectories).toEqual(['/bound/project']);
    expect(useMcpStore.getState().getStatusForDirectory()).toEqual({
      server: { status: 'connected' },
    });
    clearSyncRefs(sdk, childStores);
  });

  test('commits a late response to its captured project bucket only', async () => {
    setProjectSession('ws-a');
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
    setSyncRefs(sdk, childStores, '/repo', undefined, service, 'project:ws-a');

    const pending = useMcpStore.getState().refresh({ directory: '/repo' });
    setProjectSession('ws-b');
    resolveStatus({ data: { server: { status: 'connected' } as McpStatus } });
    await pending;

    expect(useMcpStore.getState().getStatusForDirectory('/repo')).toEqual({});
    clearSyncRefs(sdk, childStores);
  });
});
