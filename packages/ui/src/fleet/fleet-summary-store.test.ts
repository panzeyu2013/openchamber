import { beforeEach, describe, expect, test } from 'bun:test';
import { useFleetSummaryStore } from './fleet-summary-store';

describe('Fleet summary snapshots', () => {
  beforeEach(() => {
    useFleetSummaryStore.setState({ servers: new Map() });
  });

  test('keeps the prior successful snapshot when a refresh fails', () => {
    useFleetSummaryStore.getState().replaceServerSummary('desktop:alpha', [{
      serverId: 'desktop:alpha',
      sessionId: 'ses_1',
      title: 'Deploy',
      directory: '/workspace',
      updatedAt: 100,
      archived: false,
    }], 100);

    useFleetSummaryStore.getState().markServerFailed('desktop:alpha', 'network offline');

    const summary = useFleetSummaryStore.getState().servers.get('desktop:alpha');
    expect(summary?.complete).toBe(false);
    expect(summary?.errorMessage).toBe('network offline');
    expect(summary?.sessions.size).toBe(1);
  });

  test('replaces a successful server snapshot authoritatively', () => {
    useFleetSummaryStore.getState().replaceServerSummary('desktop:alpha', [{
      serverId: 'desktop:alpha',
      sessionId: 'ses_old',
      title: 'Old',
      directory: '/old',
      updatedAt: 100,
      archived: false,
    }]);
    useFleetSummaryStore.getState().replaceServerSummary('desktop:alpha', [{
      serverId: 'desktop:alpha',
      sessionId: 'ses_new',
      title: 'New',
      directory: '/new',
      updatedAt: 200,
      archived: false,
    }]);

    const summary = useFleetSummaryStore.getState().servers.get('desktop:alpha');
    expect(summary?.complete).toBe(true);
    expect([...summary?.sessions.values() ?? []].map((session) => session.sessionId)).toEqual(['ses_new']);
  });

  test('removes a deleted session without clearing sibling summaries', () => {
    useFleetSummaryStore.getState().replaceServerSummary('desktop:alpha', [
      { serverId: 'desktop:alpha', sessionId: 'ses_1', title: 'One', directory: '/one', updatedAt: 100, archived: false },
      { serverId: 'desktop:alpha', sessionId: 'ses_2', title: 'Two', directory: '/two', updatedAt: 100, archived: false },
    ]);
    useFleetSummaryStore.getState().removeSession('desktop:alpha', 'ses_1');

    expect([...useFleetSummaryStore.getState().servers.get('desktop:alpha')?.sessions.values() ?? []].map((session) => session.sessionId)).toEqual(['ses_2']);
  });
});
