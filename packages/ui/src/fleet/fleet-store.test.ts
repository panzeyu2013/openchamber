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
  probeFleetServer: async () => { probeCallCount += 1; return probeResult; },
}));

// The runtime switch is the single global endpoint mutation. These tests pin
// the CURRENT behavior — activation switches the Active Runtime, and a session
// click therefore tears down and rebuilds global sync state. Later phases must
// flip these assertions to "no switch is called on session navigation" before
// removing the runtime-switch path entirely.
let switchCallCount = 0;
const switchedKeys: string[] = [];
mock.module('@/lib/runtime-switch', () => ({
  getRuntimeKey: () => useFleetStore.getState().activeServerId === 'desktop:alpha'
    ? 'desktop-host:alpha'
    : 'local',
  switchRuntimeEndpoint: (descriptor: { runtimeKey?: string }) => {
    switchCallCount += 1;
    switchedKeys.push(descriptor.runtimeKey ?? '');
  },
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
    switchCallCount = 0;
    switchedKeys.length = 0;
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
    expect(useFleetStore.getState().servers.get('desktop:alpha')?.errorMessage).toBe('Unable to verify the server');
  });

  test('a disconnected SSH row must activate through the SSH connect flow', async () => {
    useFleetStore.getState().upsertServer({
      id: 'desktop:ssh-1', label: 'SSH', kind: 'ssh', status: 'disconnected',
      descriptor: { apiBaseUrl: '', runtimeKey: 'desktop-host:ssh-1' },
    });

    expect(await useFleetStore.getState().probeAndActivateServer('desktop:ssh-1')).toBe(false);
    expect(probeCallCount).toBe(0);
    expect(useFleetStore.getState().activeServerId).toBe('local');
  });

  test('a probe completing for a replaced descriptor never switches', async () => {
    useFleetStore.getState().upsertServer({
      id: 'desktop:alpha', label: 'Alpha', kind: 'remote-url', status: 'disconnected',
      descriptor: { apiBaseUrl: 'http://alpha.test', runtimeKey: 'desktop-host:alpha' },
    });
    // The probe starts against the OLD descriptor...
    const inFlight = useFleetStore.getState().probeAndActivateServer('desktop:alpha');
    // ...and the registry re-registers the server (new endpoint) while it is
    // pending. The probe result only certifies the OLD descriptor.
    useFleetStore.getState().upsertServer({
      id: 'desktop:alpha', label: 'Alpha', kind: 'remote-url', status: 'disconnected',
      descriptor: { apiBaseUrl: 'http://beta.test', runtimeKey: 'desktop-host:alpha' },
    });

    expect(await inFlight).toBe(false);
    expect(useFleetStore.getState().activeServerId).toBe('local');
  });

  test('an activation that finishes after another server was activated is abandoned', async () => {
    upsertRemoteServer('disconnected');
    useFleetStore.getState().upsertServer({
      id: 'desktop:beta', label: 'Beta', kind: 'remote-url', status: 'connected',
      descriptor: { apiBaseUrl: 'http://beta.test', runtimeKey: 'desktop-host:beta' },
    });
    // Alpha's probe is in flight (awaiting the mock) when Beta activates;
    // when alpha's probe completes it must not override the later click.
    const alphaProbe = useFleetStore.getState().probeAndActivateServer('desktop:alpha');

    expect(await useFleetStore.getState().probeAndActivateServer('desktop:beta')).toBe(true);
    expect(useFleetStore.getState().activeServerId).toBe('desktop:beta');
    expect(await alphaProbe).toBe(false);
    expect(useFleetStore.getState().activeServerId).toBe('desktop:beta');
  });

  test('a probe already in flight ignores repeat clicks', async () => {
    upsertRemoteServer('disconnected');
    useFleetStore.getState().updateServerStatus('desktop:alpha', 'connecting');

    expect(await useFleetStore.getState().probeAndActivateServer('desktop:alpha')).toBe(false);
    expect(useFleetStore.getState().activeServerId).toBe('local');
  });

  // ---- Reverse assertions: these pin the CURRENT "activation = global
  // runtime switch" coupling. The unified workspace architecture replaces
  // session navigation with workspace-scoped handles; these tests must be
  // flipped (switch must NOT be called) before that coupling is removed. ----

  test('CURRENT BEHAVIOR: activating a different server calls the global runtime switch', async () => {
    upsertRemoteServer('connected');

    expect(await useFleetStore.getState().probeAndActivateServer('desktop:alpha')).toBe(true);
    expect(switchCallCount).toBe(1);
    expect(switchedKeys).toEqual(['desktop-host:alpha']);
  });

  test('CURRENT BEHAVIOR: activating a server whose runtime key is already active skips the switch', async () => {
    // A re-registration of the active server reuses its runtime key; the
    // endpoint mutation must not fire when the target runtime is unchanged.
    useFleetStore.setState({ activeServerId: 'desktop:alpha' });
    upsertRemoteServer('connected');

    expect(await useFleetStore.getState().probeAndActivateServer('desktop:alpha')).toBe(true);
    expect(switchCallCount).toBe(0);
  });

  test('CURRENT BEHAVIOR: a failed probe never calls the global runtime switch', async () => {
    upsertRemoteServer('disconnected');
    probeResult = { status: 'unreachable', latencyMs: 10_000 };

    expect(await useFleetStore.getState().probeAndActivateServer('desktop:alpha')).toBe(false);
    expect(switchCallCount).toBe(0);
    expect(useFleetStore.getState().activeServerId).toBe('local');
  });
});
