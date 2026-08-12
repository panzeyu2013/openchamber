import { describe, expect, test } from 'bun:test';

const { desktopHostRuntimeNeedsRestore } = await import('./desktopRelayRestore');

describe('desktop host runtime restore', () => {
  test('repairs a stale endpoint even when the injected host identity already matches', () => {
    expect(desktopHostRuntimeNeedsRestore({
      activeRuntimeKey: 'host:remote-1',
      targetRuntimeKey: 'host:remote-1',
      activeApiBaseUrl: 'http://127.0.0.1:3000',
      directUrl: 'https://remote.example',
      relayActive: false,
    })).toBe(true);
  });

  test('does not restart an already active direct or relay transport', () => {
    expect(desktopHostRuntimeNeedsRestore({
      activeRuntimeKey: 'host:remote-1',
      targetRuntimeKey: 'host:remote-1',
      activeApiBaseUrl: 'https://remote.example/',
      directUrl: 'https://remote.example',
      relayActive: false,
    })).toBe(false);
    expect(desktopHostRuntimeNeedsRestore({
      activeRuntimeKey: 'host:remote-1',
      targetRuntimeKey: 'host:remote-1',
      activeApiBaseUrl: 'openchamber-ui://app',
      directUrl: null,
      relayActive: true,
    })).toBe(false);
  });
});
