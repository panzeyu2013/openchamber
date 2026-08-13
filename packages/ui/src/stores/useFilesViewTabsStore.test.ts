import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useProjectSessionIndexStore } from '@/projects/session-index-store';
import type { ProjectSessionSnapshot } from '@/projects/types';

const { useFilesViewTabsStore } = await import('./useFilesViewTabsStore');

describe('useFilesViewTabsStore', () => {
  beforeEach(() => {
    useFilesViewTabsStore.setState({ byRoot: {}, activeScopeKey: 'scope-a', scopeSnapshots: {} });
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

  test('rejects realpath children of project symlinks (issue 2627)', () => {
    const root = '/project';
    const store = useFilesViewTabsStore.getState();

    store.toggleExpandedPath(root, '/project/pkg');
    store.toggleExpandedPath(root, '/real/pkg/src');
    store.toggleExpandedPath(root, '/project/pkg/src');

    expect(useFilesViewTabsStore.getState().byRoot[root]?.expandedPaths).toEqual([
      '/project/pkg',
      '/project/pkg/src',
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

  test('restores independent active projections across project scope switches', () => {
    setProjectSession('ws-a');
    useFilesViewTabsStore.getState().addOpenPath('/repo', '/repo/a.ts');
    setProjectSession('ws-b');
    expect(useFilesViewTabsStore.getState().byRoot).toEqual({});
    useFilesViewTabsStore.getState().addOpenPath('/repo', '/repo/b.ts');

    setProjectSession('ws-a');
    expect(useFilesViewTabsStore.getState().byRoot['/repo']?.openPaths).toEqual(['/repo/a.ts']);
    setProjectSession('ws-b');
    expect(useFilesViewTabsStore.getState().byRoot['/repo']?.openPaths).toEqual(['/repo/b.ts']);
  });
});

const makeSnapshot = (projectId: string): ProjectSessionSnapshot => {
  const upstreamSessionId = `ses-${projectId}`;
  return {
    revision: 1,
    sessions: [{
      key: `${projectId}\u0000${upstreamSessionId}`,
      projectId,
      connectionId: 'conn',
      upstreamSessionId,
      directory: '/repo',
      title: 'title',
      updatedAt: 1,
      archived: false,
    createdAt: 1,
    }],
    freshnessByConnection: {},
  };
};

const setProjectSession = (projectId: string) => {
  useProjectSessionIndexStore.setState({ snapshot: makeSnapshot(projectId) });
  useSessionUIStore.setState({ currentSessionId: `ses-${projectId}`, currentSessionDirectory: '/repo' });
};

const clearProjectSession = () => {
  useProjectSessionIndexStore.setState({ snapshot: null });
  useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null });
};

describe('useFilesViewTabsStore project scope', () => {
  beforeEach(() => {
    clearProjectSession();
    useFilesViewTabsStore.setState({ byRoot: {}, activeScopeKey: 'scope-a', scopeSnapshots: {} });
  });

  afterEach(clearProjectSession);

  test('keeps open tabs isolated per project for the same directory', () => {
    setProjectSession('ws-a');
    useFilesViewTabsStore.getState().addOpenPath('/repo', '/repo/a.ts');
    expect(useFilesViewTabsStore.getState().byRoot['/repo']?.openPaths).toEqual(['/repo/a.ts']);

    setProjectSession('ws-b');
    expect(useFilesViewTabsStore.getState().byRoot['/repo'] ?? undefined).toBe(undefined);
    useFilesViewTabsStore.getState().addOpenPath('/repo', '/repo/b.ts');
    expect(useFilesViewTabsStore.getState().byRoot['/repo']?.openPaths).toEqual(['/repo/b.ts']);

    setProjectSession('ws-a');
    expect(useFilesViewTabsStore.getState().byRoot['/repo']?.openPaths).toEqual(['/repo/a.ts']);
  });
});
