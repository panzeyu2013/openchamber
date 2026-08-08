import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { useFleetLiveStore } from './fleet-live-store';
import { useFleetStore } from './fleet-store';
import type { HostProbeResult } from '@/lib/desktopHosts';

let probeResult: HostProbeResult | null = { status: 'ok', latencyMs: 5 };
let probeCallCount = 0;

// The probe lives in its own module (fleet-probe.ts), so this mock never
// touches the real @/lib/desktopHosts or @/lib/desktop modules that other
// test files exercise.
mock.module('@/fleet/fleet-probe', () => ({
  probeFleetServer: async () => { probeCallCount += 1; return probeResult ?? { status: 'unreachable', latencyMs: 0 }; },
}));

const upsertRemoteServer = (status: 'connected' | 'disconnected' | 'degraded' | 'error') => {
  useFleetStore.getState().upsertServer({
    id: 'desktop:alpha', label: 'Alpha', kind: 'remote-url', status,
    descriptor: { apiBaseUrl: 'http://alpha.test', runtimeKey: 'desktop-host:alpha' },
  });
};

describe('Fleet activation', () => {
  beforeEach(() => {
    probeResult = { status: 'ok', latencyMs: 5 };
    probeCallCount = 0;
    useFleetStore.setState({ servers: new Map(), activeServerId: 'local' });
    useFleetLiveStore.setState({ sessions: new Map() });
  });

  test('drops a server transient live index when it becomes active', async () => {
    useFleetLiveStore.getState().applySessionState({
      serverId: 'desktop:alpha', sessionId: 'ses_1', activity: 'busy', hasPendingPermission: true, hasPendingQuestion: false,
    });
    upsertRemoteServer('connected');

    expect(await useFleetStore.getState().probeAndActivateServer('desktop:alpha')).toBe(true);
    expect(useFleetStore.getState().activeServerId).toBe('desktop:alpha');
    expect(useFleetLiveStore.getState().sessions.size).toBe(0);
  });

  test('already-connected servers switch without a probe', async () => {
    upsertRemoteServer('connected');

    expect(await useFleetStore.getState().probeAndActivateServer('desktop:alpha')).toBe(true);
    expect(probeCallCount).toBe(0);
    expect(useFleetStore.getState().activeServerId).toBe('desktop:alpha');
  });

  test('an unverified server is probed before switching and marked connected on success', async () => {
    upsertRemoteServer('disconnected');

    expect(await useFleetStore.getState().probeAndActivateServer('desktop:alpha')).toBe(true);
    expect(probeCallCount).toBe(1);
    expect(useFleetStore.getState().activeServerId).toBe('desktop:alpha');
    expect(useFleetStore.getState().servers.get('desktop:alpha')?.status).toBe('connected');
  });

  test('failed probe leaves the current runtime and transient state intact', async () => {
    upsertRemoteServer('degraded');
    useFleetLiveStore.getState().applySessionState({
      serverId: 'desktop:alpha', sessionId: 'ses_1', activity: 'busy', hasPendingPermission: true, hasPendingQuestion: false,
    });
    probeResult = { status: 'unreachable', latencyMs: 10_000 };

    expect(await useFleetStore.getState().probeAndActivateServer('desktop:alpha')).toBe(false);
    expect(useFleetStore.getState().activeServerId).toBe('local');
    expect(useFleetStore.getState().servers.get('desktop:alpha')?.status).toBe('error');
    expect(useFleetStore.getState().servers.get('desktop:alpha')?.errorMessage).toBe('Host is unreachable');
    expect(useFleetLiveStore.getState().sessions.size).toBe(1);
  });

  test('a relay descriptor is probed and never switches on a failed probe', async () => {
    useFleetStore.getState().upsertServer({
      id: 'desktop:relay', label: 'Relay', kind: 'relay', status: 'disconnected',
      descriptor: {
        apiBaseUrl: 'http://relay.test',
        runtimeKey: 'desktop-host:relay',
        clientToken: 'tok',
        requestHeaders: { 'x-custom': 'yes' },
        relay: { relayUrl: 'wss://relay.example', serverId: 'srv-1', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } as JsonWebKey },
      },
    });
    probeResult = { status: 'unreachable', latencyMs: 0 };

    expect(await useFleetStore.getState().probeAndActivateServer('desktop:relay')).toBe(false);
    expect(probeCallCount).toBe(1);
    expect(useFleetStore.getState().activeServerId).toBe('local');
    expect(useFleetStore.getState().servers.get('desktop:relay')?.status).toBe('error');
  });

  test('unverifiable endpoint (no probe result) never switches', async () => {
    upsertRemoteServer('disconnected');
    probeResult = null;

    expect(await useFleetStore.getState().probeAndActivateServer('desktop:alpha')).toBe(false);
    expect(useFleetStore.getState().activeServerId).toBe('local');
    expect(useFleetStore.getState().servers.get('desktop:alpha')?.status).toBe('error');
  });

  test('a probe already in flight ignores repeat clicks', async () => {
    upsertRemoteServer('disconnected');
    useFleetStore.getState().updateServerStatus('desktop:alpha', 'connecting');

    expect(await useFleetStore.getState().probeAndActivateServer('desktop:alpha')).toBe(false);
    expect(useFleetStore.getState().activeServerId).toBe('local');
  });
});
