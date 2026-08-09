import { beforeEach, describe, expect, test } from 'bun:test';
import { useFleetLiveStore } from './fleet-live-store';
import { fleetSessionKey } from './types';

describe('Fleet live state', () => {
  beforeEach(() => {
    useFleetLiveStore.setState({ sessions: new Map(), serverRevisions: new Map() });
  });

  test('does not let a late state overwrite a newer observation', () => {
    const store = useFleetLiveStore.getState();
    store.applySessionState({ serverId: 'desktop:alpha', sessionId: 'ses_1', activity: 'busy', hasPendingPermission: false, hasPendingQuestion: false, updatedAt: 200 });
    store.applySessionState({ serverId: 'desktop:alpha', sessionId: 'ses_1', activity: 'idle', hasPendingPermission: false, hasPendingQuestion: false, updatedAt: 100 });

    expect(useFleetLiveStore.getState().sessions.get(fleetSessionKey('desktop:alpha', 'ses_1'))?.activity).toBe('busy');
  });

  test('marks a server stale without clearing its live indicator', () => {
    const store = useFleetLiveStore.getState();
    store.applySessionState({ serverId: 'desktop:alpha', sessionId: 'ses_1', activity: 'retry', hasPendingPermission: false, hasPendingQuestion: false, updatedAt: 200 });
    store.markServerStale('desktop:alpha');

    const state = useFleetLiveStore.getState().sessions.get(fleetSessionKey('desktop:alpha', 'ses_1'));
    expect(state?.activity).toBe('retry');
    expect(state?.stale).toBe(true);
  });

  test('removes just the deleted session from a server', () => {
    const store = useFleetLiveStore.getState();
    store.applySessionState({ serverId: 'desktop:alpha', sessionId: 'ses_1', activity: 'busy', hasPendingPermission: false, hasPendingQuestion: false, updatedAt: 200 });
    store.applySessionState({ serverId: 'desktop:alpha', sessionId: 'ses_2', activity: 'idle', hasPendingPermission: false, hasPendingQuestion: false, updatedAt: 200 });
    store.removeSession('desktop:alpha', 'ses_1');

    expect(useFleetLiveStore.getState().sessions.has(fleetSessionKey('desktop:alpha', 'ses_1'))).toBe(false);
    expect(useFleetLiveStore.getState().sessions.has(fleetSessionKey('desktop:alpha', 'ses_2'))).toBe(true);
  });

  test('prunes live state omitted by an authoritative server summary', () => {
    const store = useFleetLiveStore.getState();
    store.applySessionState({ serverId: 'desktop:alpha', sessionId: 'ses_keep', activity: 'busy', hasPendingPermission: false, hasPendingQuestion: false });
    store.applySessionState({ serverId: 'desktop:alpha', sessionId: 'ses_gone', activity: 'idle', hasPendingPermission: true, hasPendingQuestion: false });
    store.applySessionState({ serverId: 'desktop:beta', sessionId: 'ses_other', activity: 'idle', hasPendingPermission: false, hasPendingQuestion: false });

    store.reconcileServerSessions('desktop:alpha', new Set(['ses_keep']));

    expect(useFleetLiveStore.getState().sessions.has(fleetSessionKey('desktop:alpha', 'ses_keep'))).toBe(true);
    expect(useFleetLiveStore.getState().sessions.has(fleetSessionKey('desktop:alpha', 'ses_gone'))).toBe(false);
    expect(useFleetLiveStore.getState().sessions.has(fleetSessionKey('desktop:beta', 'ses_other'))).toBe(true);
  });

  test('applies a large server snapshot with one store notification', () => {
    let notifications = 0;
    const unsubscribe = useFleetLiveStore.subscribe(() => { notifications += 1; });
    const inputs = Array.from({ length: 100 }, (_, index) => ({
      sessionId: `ses_${index}`,
      activity: index % 2 === 0 ? 'busy' as const : 'idle' as const,
      hasPendingPermission: index === 1,
      hasPendingQuestion: index === 2,
      updatedAt: 500,
    }));

    useFleetLiveStore.getState().replaceServerSnapshot('desktop:alpha', inputs, 500);
    unsubscribe();

    expect(notifications).toBe(1);
    expect(useFleetLiveStore.getState().sessions.size).toBe(100);
  });

  test('does not prune an SSE observation newer than the snapshot start', () => {
    useFleetLiveStore.getState().applySessionState({
      serverId: 'desktop:alpha',
      sessionId: 'ses_new',
      activity: 'busy',
      hasPendingPermission: false,
      hasPendingQuestion: false,
      updatedAt: 600,
    });

    useFleetLiveStore.getState().replaceServerSnapshot('desktop:alpha', [], 500);

    expect(useFleetLiveStore.getState().sessions.has(fleetSessionKey('desktop:alpha', 'ses_new'))).toBe(true);
  });

  test('preserves an SSE observation at the exact snapshot boundary', () => {
    useFleetLiveStore.getState().applySessionState({
      serverId: 'desktop:alpha',
      sessionId: 'ses_new',
      activity: 'busy',
      hasPendingPermission: true,
      hasPendingQuestion: false,
      updatedAt: 500,
    });

    useFleetLiveStore.getState().replaceServerSnapshot('desktop:alpha', [{
      sessionId: 'ses_new',
      activity: 'idle',
      hasPendingPermission: false,
      hasPendingQuestion: false,
      updatedAt: 500,
    }], 500);

    const state = useFleetLiveStore.getState().sessions.get(fleetSessionKey('desktop:alpha', 'ses_new'));
    expect(state?.activity).toBe('busy');
    expect(state?.hasPendingPermission).toBe(true);
  });

  test('merges authoritative pending flags when only activity changed after snapshot start', () => {
    useFleetLiveStore.getState().applySessionState({
      serverId: 'desktop:alpha',
      sessionId: 'ses_1',
      activity: 'busy',
      hasPendingPermission: false,
      hasPendingQuestion: false,
      updatedAt: 600,
      activityUpdatedAt: 600,
      pendingUpdatedAt: 0,
    });

    useFleetLiveStore.getState().replaceServerSnapshot('desktop:alpha', [{
      sessionId: 'ses_1',
      activity: 'idle',
      hasPendingPermission: true,
      hasPendingQuestion: false,
      updatedAt: 500,
    }], 500);

    const state = useFleetLiveStore.getState().sessions.get(fleetSessionKey('desktop:alpha', 'ses_1'));
    expect(state?.activity).toBe('busy');
    expect(state?.hasPendingPermission).toBe(true);
  });

  test('increments only the affected server revision', () => {
    useFleetLiveStore.getState().applySessionState({
      serverId: 'desktop:alpha', sessionId: 'ses_1', activity: 'idle', hasPendingPermission: false, hasPendingQuestion: false,
    });
    const alphaRevision = useFleetLiveStore.getState().serverRevisions.get('desktop:alpha');

    useFleetLiveStore.getState().applySessionState({
      serverId: 'desktop:beta', sessionId: 'ses_2', activity: 'busy', hasPendingPermission: false, hasPendingQuestion: false,
    });

    expect(useFleetLiveStore.getState().serverRevisions.get('desktop:alpha')).toBe(alphaRevision);
    expect(useFleetLiveStore.getState().serverRevisions.get('desktop:beta')).toBe(1);
  });
});
