import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useWorkspaceSessionIndexStore } from '@/workspaces/session-index-store';
import { workspaceScopeKey } from '@/workspaces/identity';
import type { ProjectFileSearchHit } from '@/lib/opencode/client';
import type { WorkspaceSessionSnapshot } from '@/workspaces/types';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

const searchRequests: Array<Deferred<Array<{ path: string }>>> = [];
const boundSearchRequests: Array<Deferred<ProjectFileSearchHit[]>> = [];
let runtimeKey = 'runtime-a';

const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const searchFilesMock = mock(() => {
  const request = createDeferred<Array<{ path: string }>>();
  searchRequests.push(request);
  return request.promise;
});

const boundSearchFilesMock = mock((
  query: string,
  options?: { directory?: string | null; limit?: number; includeHidden?: boolean; respectGitignore?: boolean; dirs?: boolean; type?: 'file' | 'directory' },
) => {
  void query;
  void options;
  const request = createDeferred<ProjectFileSearchHit[]>();
  boundSearchRequests.push(request);
  return request.promise;
});

const realControlPlane = await import('@/lib/control-plane');
mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    searchFiles: searchFilesMock,
  },
}));
mock.module('@/lib/control-plane', () => ({
  ...realControlPlane,
  getControlPlaneKey: () => runtimeKey,
}));

const { useFileSearchStore } = await import('./useFileSearchStore');

describe('useFileSearchStore', () => {
  beforeEach(() => {
    searchRequests.length = 0;
    boundSearchRequests.length = 0;
    runtimeKey = 'runtime-a';
    useFileSearchStore.setState({
      cache: {},
      cacheKeys: [],
      inFlight: {},
    });
  });

  test('does not cache a stale in-flight search after invalidation', async () => {
    const searchPromise = useFileSearchStore.getState().searchFiles('/project', 'foo');
    expect(Object.keys(useFileSearchStore.getState().inFlight)).toHaveLength(1);

    useFileSearchStore.getState().invalidateDirectory('/project');
    expect(Object.keys(useFileSearchStore.getState().inFlight)).toHaveLength(0);

    searchRequests[0].resolve([{ path: 'stale.ts' }]);
    await searchPromise;

    expect(useFileSearchStore.getState().cache).toEqual({});
    expect(useFileSearchStore.getState().cacheKeys).toEqual([]);
  });

  test('does not notify subscribers when stale search handlers make no state change', async () => {
    const searchPromise = useFileSearchStore.getState().searchFiles('/project', 'foo');
    useFileSearchStore.getState().invalidateDirectory('/project');

    let updateCount = 0;
    const unsubscribe = useFileSearchStore.subscribe(() => {
      updateCount += 1;
    });

    searchRequests[0].resolve([{ path: 'stale.ts' }]);
    await searchPromise;
    unsubscribe();

    expect(updateCount).toBe(0);
  });

  test('does not let a stale request remove a newer in-flight search', async () => {
    const stalePromise = useFileSearchStore.getState().searchFiles('/project', 'foo');
    useFileSearchStore.getState().invalidateDirectory('/project');
    const freshPromise = useFileSearchStore.getState().searchFiles('/project', 'foo');

    searchRequests[0].resolve([{ path: 'stale.ts' }]);
    await stalePromise;

    expect(Object.keys(useFileSearchStore.getState().inFlight)).toHaveLength(1);

    searchRequests[1].resolve([{ path: 'fresh.ts' }]);
    await freshPromise;

    const cacheEntries = Object.values(useFileSearchStore.getState().cache);
    expect(cacheEntries).toHaveLength(1);
    expect(cacheEntries[0]?.files).toEqual([{ path: 'fresh.ts' }]);
  });

  test('keeps directory and query separators from colliding in cache keys', async () => {
    const firstPromise = useFileSearchStore.getState().searchFiles('/project::nested', 'foo');
    searchRequests[0].resolve([{ path: 'first.ts' }]);
    await firstPromise;

    const secondPromise = useFileSearchStore.getState().searchFiles('/project', 'nested::foo');
    expect(searchRequests).toHaveLength(2);

    searchRequests[1].resolve([{ path: 'second.ts' }]);
    expect(await secondPromise).toEqual([{ path: 'second.ts' }]);
  });

  test('isolates cache and in-flight ownership by workspace scope', async () => {
    setWorkspaceSession('ws-a');
    const firstPromise = useFileSearchStore.getState().searchFiles('/project', 'foo');
    setWorkspaceSession('ws-b');
    const secondPromise = useFileSearchStore.getState().searchFiles('/project', 'foo');
    expect(searchRequests).toHaveLength(2);

    searchRequests[1].resolve([{ path: 'ws-b.ts' }]);
    expect(await secondPromise).toEqual([{ path: 'ws-b.ts' }]);
    searchRequests[0].resolve([{ path: 'ws-a.ts' }]);
    await firstPromise;

    setWorkspaceSession('ws-b');
    expect(await useFileSearchStore.getState().searchFiles('/project', 'foo')).toEqual([{ path: 'ws-b.ts' }]);
    expect(searchRequests).toHaveLength(2);
  });
});

const makeSnapshot = (workspaceId: string): WorkspaceSessionSnapshot => {
  const upstreamSessionId = `ses-${workspaceId}`;
  return {
    revision: 1,
    sessions: [{
      key: `${workspaceId}\u0000${upstreamSessionId}`,
      workspaceId,
      connectionId: 'conn',
      upstreamSessionId,
      directory: '/project',
      title: 'title',
      updatedAt: 1,
      archived: false,
    createdAt: 1,
    }],
    freshnessByConnection: {},
  };
};

const setWorkspaceSession = (workspaceId: string) => {
  useWorkspaceSessionIndexStore.setState({ snapshot: makeSnapshot(workspaceId) });
  useSessionUIStore.setState({ currentSessionId: `ses-${workspaceId}`, currentSessionDirectory: '/project' });
};

const clearWorkspaceSession = () => {
  useWorkspaceSessionIndexStore.setState({ snapshot: null });
  useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null });
};

describe('useFileSearchStore workspace scope', () => {
  beforeEach(() => {
    searchRequests.length = 0;
    boundSearchRequests.length = 0;
    runtimeKey = 'runtime-a';
    useFileSearchStore.setState({ cache: {}, cacheKeys: [], inFlight: {} });
    clearWorkspaceSession();
  });

  afterEach(clearWorkspaceSession);

  test('isolates cache and in-flight ownership per workspace', async () => {
    setWorkspaceSession('ws-a');
    const firstPromise = useFileSearchStore.getState().searchFiles('/project', 'foo');
    setWorkspaceSession('ws-b');
    const secondPromise = useFileSearchStore.getState().searchFiles('/project', 'foo');
    expect(searchRequests).toHaveLength(2);

    searchRequests[1].resolve([{ path: 'ws-b.ts' }]);
    expect(await secondPromise).toEqual([{ path: 'ws-b.ts' }]);
    searchRequests[0].resolve([{ path: 'ws-a.ts' }]);
    await firstPromise;

    expect(await useFileSearchStore.getState().searchFiles('/project', 'foo')).toEqual([{ path: 'ws-b.ts' }]);
    expect(searchRequests).toHaveLength(2);
  });

  test('uses the bound workspace transport instead of the ambient client', async () => {
    setWorkspaceSession('ws-a');
    const promise = useFileSearchStore.getState().searchFiles(
      '/project',
      'foo',
      60,
      undefined,
      {
        scopeKey: workspaceScopeKey('ws-a'),
        transport: { searchFiles: boundSearchFilesMock },
      },
    );

    expect(searchRequests).toHaveLength(0);
    expect(boundSearchRequests).toHaveLength(1);
    boundSearchRequests[0].resolve([{ name: 'bound.ts', path: 'bound.ts', relativePath: 'bound.ts' }]);
    expect(await promise).toEqual([{ name: 'bound.ts', path: 'bound.ts', relativePath: 'bound.ts' }]);
  });

  test('invalidateDirectory clears only the active workspace scope', async () => {
    setWorkspaceSession('ws-a');
    const searchA = useFileSearchStore.getState().searchFiles('/project', 'foo');
    searchRequests[0].resolve([{ path: 'first.ts' }]);
    await searchA;
    expect(Object.values(useFileSearchStore.getState().cache)).toHaveLength(1);

    setWorkspaceSession('ws-b');
    const searchB = useFileSearchStore.getState().searchFiles('/project', 'foo');
    searchRequests[1].resolve([{ path: 'second.ts' }]);
    await searchB;
    expect(Object.values(useFileSearchStore.getState().cache)).toHaveLength(2);

    useFileSearchStore.getState().invalidateDirectory('/project');

    const remaining = Object.values(useFileSearchStore.getState().cache);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.files).toEqual([{ path: 'first.ts' }]);
  });
});
