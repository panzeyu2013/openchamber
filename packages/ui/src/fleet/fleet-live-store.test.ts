import { beforeEach, describe, expect, test } from 'bun:test';
import { useFleetLiveStore } from './fleet-live-store';
import { fleetSessionKey } from './types';

describe('Fleet live state', () => {
  beforeEach(() => {
    useFleetLiveStore.setState({ sessions: new Map() });
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
});
