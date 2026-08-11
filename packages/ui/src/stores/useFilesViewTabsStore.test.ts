import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useWorkspaceSessionIndexStore } from '@/workspaces/session-index-store';
import type { WorkspaceSessionSnapshot } from '@/workspaces/types';

const { useFilesViewTabsStore } = await import('./useFilesViewTabsStore');

describe('useFilesViewTabsStore', () => {
  beforeEach(() => {
    useFilesViewTabsStore.setState({ byRoot: {}, activeRuntimeKey: 'runtime-a', runtimeSnapshots: {} });
  });

  test('ignores runtime paths outside the requested root', () => {
    const root = '/repo';
    const store = useFilesViewTabsStore.getState();

    store.addOpenPath(root, '/other/file.ts');
    store.setSelectedPath(root, '/other/file.ts');
    store.expandPath(root, '/other');
    store.toggleExpandedPath(root, '/other');

    expect(useFilesViewTabsStore.getState().byRoot).toEqual({});
  });

  test('filters expanded path batches to the requested root', () => {
    const root = '/repo';

    useFilesViewTabsStore.getState().expandPaths(root, [
      '/repo/src',
      '/other/src',
    ]);

    expect(useFilesViewTabsStore.getState().byRoot[root]?.expandedPaths).toEqual(['/repo/src']);
  });

  test('rejects realpath children of workspace symlinks (issue 2627)', () => {
    const root = '/workspace';
    const store = useFilesViewTabsStore.getState();

    store.toggleExpandedPath(root, '/workspace/pkg');
    store.toggleExpandedPath(root, '/real/pkg/src');
    store.toggleExpandedPath(root, '/workspace/pkg/src');

    expect(useFilesViewTabsStore.getState().byRoot[root]?.expandedPaths).toEqual([
      '/workspace/pkg',
      '/workspace/pkg/src',
    ]);
  });

  test('removes stale expanded paths by prefix without closing files', () => {
    const root = '/repo';
    const store = useFilesViewTabsStore.getState();

    store.addOpenPath(root, '/repo/src/index.ts');
    store.expandPaths(root, [
      '/repo/src',
      '/repo/bun test packages',
      '/repo/bun test packages/web',
      '/repo/other',
    ]);

    store.removeExpandedPathsByPrefix(root, '/repo/bun test packages');

    const state = useFilesViewTabsStore.getState().byRoot[root];
    expect(state?.openPaths).toEqual(['/repo/src/index.ts']);
    expect(state?.expandedPaths).toEqual(['/repo/src', '/repo/other']);
  });

  test('restores independent active projections across runtime switches', () => {
    useFilesViewTabsStore.getState().addOpenPath('/repo', '/repo/a.ts');
    useFilesViewTabsStore.getState().resetForRuntimeSwitch('runtime-b');
    expect(useFilesViewTabsStore.getState().byRoot).toEqual({});
    useFilesViewTabsStore.getState().addOpenPath('/repo', '/repo/b.ts');

    useFilesViewTabsStore.getState().resetForRuntimeSwitch('runtime-a');
    expect(useFilesViewTabsStore.getState().byRoot['/repo']?.openPaths).toEqual(['/repo/a.ts']);
    useFilesViewTabsStore.getState().resetForRuntimeSwitch('runtime-b');
    expect(useFilesViewTabsStore.getState().byRoot['/repo']?.openPaths).toEqual(['/repo/b.ts']);
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
      directory: '/repo',
      title: 'title',
      updatedAt: 1,
      archived: false,
    }],
    freshnessByConnection: {},
  };
};

const setWorkspaceSession = (workspaceId: string) => {
  useWorkspaceSessionIndexStore.setState({ snapshot: makeSnapshot(workspaceId) });
  useSessionUIStore.setState({ currentSessionId: `ses-${workspaceId}`, currentSessionDirectory: '/repo' });
};

const clearWorkspaceSession = () => {
  useWorkspaceSessionIndexStore.setState({ snapshot: null });
  useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null });
};

describe('useFilesViewTabsStore workspace scope', () => {
  beforeEach(() => {
    clearWorkspaceSession();
    useFilesViewTabsStore.setState({ byRoot: {}, activeRuntimeKey: 'runtime-a', runtimeSnapshots: {} });
  });

  afterEach(clearWorkspaceSession);

  test('keeps open tabs isolated per workspace for the same directory', () => {
    setWorkspaceSession('ws-a');
    useFilesViewTabsStore.getState().addOpenPath('/repo', '/repo/a.ts');
    expect(useFilesViewTabsStore.getState().byRoot['/repo']?.openPaths).toEqual(['/repo/a.ts']);

    setWorkspaceSession('ws-b');
    expect(useFilesViewTabsStore.getState().byRoot['/repo'] ?? undefined).toBe(undefined);
    useFilesViewTabsStore.getState().addOpenPath('/repo', '/repo/b.ts');
    expect(useFilesViewTabsStore.getState().byRoot['/repo']?.openPaths).toEqual(['/repo/b.ts']);

    setWorkspaceSession('ws-a');
    expect(useFilesViewTabsStore.getState().byRoot['/repo']?.openPaths).toEqual(['/repo/a.ts']);
  });
});
