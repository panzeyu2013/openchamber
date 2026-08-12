import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useWorkspaceSessionIndexStore } from '@/workspaces/session-index-store';
import type { WorkspaceSessionSnapshot } from '@/workspaces/types';
import { useUIStore } from './useUIStore';

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
    createdAt: 1,
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

describe('useUIStore context panel workspace scope', () => {
  beforeEach(() => {
    clearWorkspaceSession();
    useUIStore.setState({
      contextPanelScopeKey: '',
      contextPanelByDirectory: {},
      contextPanelByScope: {},
    });
  });

  afterEach(() => {
    clearWorkspaceSession();
    useUIStore.setState({
      contextPanelScopeKey: '',
      contextPanelByDirectory: {},
      contextPanelByScope: {},
    });
  });

  test('keeps same-directory context tabs isolated per workspace', () => {
    setWorkspaceSession('ws-a');
    useUIStore.getState().openContextFile('/repo', '/repo/a.ts');
    const tabA = useUIStore.getState().contextPanelByDirectory['/repo']?.tabs[0]?.id;

    setWorkspaceSession('ws-b');
    expect(useUIStore.getState().contextPanelByDirectory['/repo']).toBe(undefined);
    useUIStore.getState().openContextFile('/repo', '/repo/b.ts');
    const tabB = useUIStore.getState().contextPanelByDirectory['/repo']?.tabs[0]?.id;
    expect(tabB).not.toBe(tabA);

    setWorkspaceSession('ws-a');
    expect(useUIStore.getState().contextPanelByDirectory['/repo']?.tabs[0]?.targetPath).toBe('/repo/a.ts');

    setWorkspaceSession('ws-b');
    expect(useUIStore.getState().contextPanelByDirectory['/repo']?.tabs[0]?.targetPath).toBe('/repo/b.ts');
  });
});
