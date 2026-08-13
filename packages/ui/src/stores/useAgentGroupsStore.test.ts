import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';

let scopeKey = 'project:one';
let listCalls = 0;
let listSessions: () => Promise<{ data: Session[] }>;

const service = {
  getSdkClient: () => ({
    session: {
      list: async () => {
        listCalls += 1;
        return listSessions();
      },
    },
  }),
};

mock.module('@/lib/worktrees/worktreeManager', () => ({
  listProjectWorktrees: async () => [{
    path: '/repo/worktree',
    projectDirectory: '/repo',
    branch: 'feature',
    label: 'feature',
  }],
  removeProjectWorktree: async () => undefined,
}));
mock.module('./useDirectoryStore', () => ({
  useDirectoryStore: { getState: () => ({ currentDirectory: '/repo' }) },
}));
mock.module('./useProjectsStore', () => ({
  useProjectsStore: {
    getState: () => ({
      activeProjectId: 'project',
      projects: [{ id: 'project', path: '/repo' }],
    }),
  },
}));
mock.module('@/sync/session-actions', () => ({ deleteSessionInDirectory: async () => true }));
mock.module('@/sync/retry', () => ({ retry: async <T,>(operation: () => Promise<T>) => operation() }));
mock.module('@/sync/sync-refs', () => ({
  getSyncOpencodeService: () => service,
  getSyncScopeKey: () => scopeKey,
}));

const { useAgentGroupsStore } = await import('./useAgentGroupsStore');

const makeSession = (id: string): Session => ({
  id,
  title: 'group/provider/model/1',
  directory: '/repo/worktree',
  time: { created: 1, updated: 2 },
} as Session);

describe('useAgentGroupsStore project ownership', () => {
  beforeEach(() => {
    scopeKey = 'project:one';
    listCalls = 0;
    listSessions = async () => ({ data: [makeSession('session-one')] });
    useAgentGroupsStore.setState({
      groups: [],
      selectedGroupName: null,
      selectedSessionId: null,
      isLoading: false,
      error: null,
    });
  });

  test('lists worktree sessions through the bound SyncProvider service', async () => {
    await useAgentGroupsStore.getState().loadGroups();

    expect(listCalls).toBe(1);
    expect(useAgentGroupsStore.getState().groups[0]?.sessions[0]?.id).toBe('session-one');
  });

  test('does not publish a late result after the project scope changes', async () => {
    let resolveList!: (value: { data: Session[] }) => void;
    listSessions = () => new Promise((resolve) => { resolveList = resolve; });

    const load = useAgentGroupsStore.getState().loadGroups();
    await Promise.resolve();
    await Promise.resolve();
    scopeKey = 'project:two';
    resolveList({ data: [makeSession('stale-session')] });
    await load;

    expect(useAgentGroupsStore.getState().groups).toEqual([]);
  });
});
