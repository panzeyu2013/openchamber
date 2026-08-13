import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useProjectSessionIndexStore } from '@/projects/session-index-store';
import type { ProjectSessionSnapshot } from '@/projects/types';
import { useUIStore } from './useUIStore';

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

describe('useUIStore context panel project scope', () => {
  beforeEach(() => {
    clearProjectSession();
    useUIStore.setState({
      contextPanelScopeKey: '',
      contextPanelByDirectory: {},
      contextPanelByScope: {},
    });
  });

  afterEach(() => {
    clearProjectSession();
    useUIStore.setState({
      contextPanelScopeKey: '',
      contextPanelByDirectory: {},
      contextPanelByScope: {},
    });
  });

  test('keeps same-directory context tabs isolated per project', () => {
    setProjectSession('ws-a');
    useUIStore.getState().openContextFile('/repo', '/repo/a.ts');
    const tabA = useUIStore.getState().contextPanelByDirectory['/repo']?.tabs[0]?.id;

    setProjectSession('ws-b');
    expect(useUIStore.getState().contextPanelByDirectory['/repo']).toBe(undefined);
    useUIStore.getState().openContextFile('/repo', '/repo/b.ts');
    const tabB = useUIStore.getState().contextPanelByDirectory['/repo']?.tabs[0]?.id;
    expect(tabB).not.toBe(tabA);

    setProjectSession('ws-a');
    expect(useUIStore.getState().contextPanelByDirectory['/repo']?.tabs[0]?.targetPath).toBe('/repo/a.ts');

    setProjectSession('ws-b');
    expect(useUIStore.getState().contextPanelByDirectory['/repo']?.tabs[0]?.targetPath).toBe('/repo/b.ts');
  });
});
