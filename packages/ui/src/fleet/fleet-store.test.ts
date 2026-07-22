import { beforeEach, describe, expect, test } from 'bun:test';
import { useFleetLiveStore } from './fleet-live-store';
import { useFleetStore } from './fleet-store';

describe('Fleet activation', () => {
  beforeEach(() => {
    useFleetStore.setState({ servers: new Map(), activeServerId: 'local' });
    useFleetLiveStore.setState({ sessions: new Map() });
  });

  test('drops a server transient live index when it becomes active', () => {
    useFleetLiveStore.getState().applySessionState({
      serverId: 'desktop:alpha', sessionId: 'ses_1', activity: 'busy', hasPendingPermission: true, hasPendingQuestion: false,
    });
    useFleetStore.getState().upsertServer({
      id: 'desktop:alpha', label: 'Alpha', kind: 'remote-url', status: 'connected',
      descriptor: { apiBaseUrl: 'http://alpha.test', runtimeKey: 'desktop-host:alpha' },
    });

    expect(useFleetStore.getState().activateServer('desktop:alpha')).toBe(true);
    expect(useFleetStore.getState().activeServerId).toBe('desktop:alpha');
    expect(useFleetLiveStore.getState().sessions.size).toBe(0);
  });
});
