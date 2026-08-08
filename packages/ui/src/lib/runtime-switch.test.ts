import { describe, expect, test } from 'bun:test';
import {
  getRuntimeApiBaseUrl,
  getRuntimeKey,
  subscribeRuntimeEndpointChanged,
  subscribeRuntimeEndpointWillChange,
  switchRuntimeEndpoint,
} from './runtime-switch';
import { clearRuntimeUrlAuthToken, setRuntimeExtraHeaders } from './runtime-auth';
import {
  activateRelayTunnel,
  deactivateRelayTunnel,
  getActiveRelayDescriptor,
} from './relay/runtime-tunnel';

const withWindow = async <T>(value: unknown, callback: () => T | Promise<T>): Promise<T> => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  try {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value,
    });
    return await callback();
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, 'window', previousWindow);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  }
};

const importFreshRuntimeSwitch = async () => (
  import(`./runtime-switch?test=${Date.now()}-${Math.random()}`)
);

describe('runtime endpoint switching', () => {
  test('exposes a credential-free copy of the active relay descriptor', () => {
    const descriptor = {
      relayUrl: 'wss://relay.example.com',
      serverId: 'server-1',
      hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'public-x', y: 'public-y' },
      grant: 'one-time-secret',
    };

    try {
      activateRelayTunnel(descriptor);
      const exposed = getActiveRelayDescriptor();
      expect(exposed).toEqual({
        relayUrl: descriptor.relayUrl,
        serverId: descriptor.serverId,
        hostEncPubJwk: descriptor.hostEncPubJwk,
      });
      expect(exposed).not.toBe(descriptor);
      expect(exposed?.hostEncPubJwk).not.toBe(descriptor.hostEncPubJwk);
    } finally {
      deactivateRelayTunnel();
    }
  });

  test('notifies listeners before and after mutating the active endpoint', () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const previousFetch = globalThis.fetch;
    const events = new EventTarget();
    const runtimeWindow = {
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
    };

    try {
      globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: runtimeWindow,
      });
      switchRuntimeEndpoint({ apiBaseUrl: 'https://runtime-a.example', runtimeKey: 'runtime-a' });
      const observed: Array<[string, string, string]> = [];
      const unsubscribeWillChange = subscribeRuntimeEndpointWillChange((detail) => {
        observed.push(['will-change', getRuntimeKey(), detail.previousRuntimeKey]);
      });
      const unsubscribeChanged = subscribeRuntimeEndpointChanged((detail) => {
        observed.push(['changed', getRuntimeKey(), detail.runtimeKey]);
      });

      switchRuntimeEndpoint({ apiBaseUrl: 'https://runtime-b.example', runtimeKey: 'runtime-b' });

      expect(observed).toEqual([
        ['will-change', 'runtime-a', 'runtime-a'],
        ['changed', 'runtime-b', 'runtime-b'],
      ]);
      unsubscribeWillChange();
      unsubscribeChanged();
    } finally {
      globalThis.fetch = previousFetch;
      if (previousWindow) {
        Object.defineProperty(globalThis, 'window', previousWindow);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });

  test('does not throw when Electron preload globals are read-only', () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const previousFetch = globalThis.fetch;
    const runtimeWindow = {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
    };

    try {
      clearRuntimeUrlAuthToken();
      setRuntimeExtraHeaders(null);
      globalThis.fetch = (async () => new Response(JSON.stringify({ token: 'url-token', expiresAt: Date.now() + 60_000 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
      Object.defineProperty(runtimeWindow, '__OPENCHAMBER_API_BASE_URL__', {
        configurable: true,
        value: 'http://127.0.0.1:3000',
        writable: false,
      });
      Object.defineProperty(runtimeWindow, '__OPENCHAMBER_CLIENT_TOKEN__', {
        configurable: true,
        value: '',
        writable: false,
      });
      Object.defineProperty(runtimeWindow, '__OPENCHAMBER_RUNTIME_HEADERS__', {
        configurable: true,
        value: {},
        writable: false,
      });
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: runtimeWindow,
      });

      let thrown: unknown = null;
      try {
        switchRuntimeEndpoint({
          apiBaseUrl: 'https://remote.example',
          clientToken: 'client-token',
          requestHeaders: null,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeNull();
      expect(getRuntimeApiBaseUrl()).toBe('https://remote.example');
    } finally {
      globalThis.fetch = previousFetch;
      clearRuntimeUrlAuthToken();
      setRuntimeExtraHeaders(null);
      if (previousWindow) {
        Object.defineProperty(globalThis, 'window', previousWindow);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });

  test('ignores stale injected loopback API base and keys same-origin SSH pages by current origin', async () => {
    await withWindow({
      location: {
        origin: 'http://127.0.0.1:60782',
        href: 'http://127.0.0.1:60782/index',
        protocol: 'http:',
      },
      __OPENCHAMBER_LOCAL_ORIGIN__: 'http://127.0.0.1:5173',
      __OPENCHAMBER_API_BASE_URL__: 'http://127.0.0.1:60788',
    }, async () => {
      const runtimeSwitch = await importFreshRuntimeSwitch();

      expect(runtimeSwitch.getRuntimeApiBaseUrl()).toBe('');
      expect(runtimeSwitch.getRuntimeKey()).toBe('url:http://127.0.0.1:60782');
    });
  });

  test('preserves explicit same-origin SSH host identity when API base is relative', async () => {
    await withWindow({
      location: {
        origin: 'http://127.0.0.1:60782',
        href: 'http://127.0.0.1:60782/index?oc_desktop_host_id=ssh-1',
        protocol: 'http:',
      },
      __OPENCHAMBER_LOCAL_ORIGIN__: 'http://127.0.0.1:5173',
      __OPENCHAMBER_API_BASE_URL__: '',
    }, async () => {
      const runtimeSwitch = await importFreshRuntimeSwitch();
      runtimeSwitch.initializeRuntimeEndpoint({ apiBaseUrl: '', runtimeKey: 'host:ssh-1' });

      expect(runtimeSwitch.getRuntimeApiBaseUrl()).toBe('');
      expect(runtimeSwitch.getRuntimeKey()).toBe('host:ssh-1');
    });
  });

  test('infers the runtime key when switching to relative same-origin transport', async () => {
    await withWindow({
      location: {
        origin: 'http://127.0.0.1:60782',
        href: 'http://127.0.0.1:60782/index',
        protocol: 'http:',
      },
      dispatchEvent: () => true,
      __OPENCHAMBER_LOCAL_ORIGIN__: 'http://127.0.0.1:5173',
    }, async () => {
      const runtimeSwitch = await importFreshRuntimeSwitch();
      runtimeSwitch.switchRuntimeEndpoint({ apiBaseUrl: '' });

      expect(runtimeSwitch.getRuntimeApiBaseUrl()).toBe('');
      expect(runtimeSwitch.getRuntimeKey()).toBe('url:http://127.0.0.1:60782');
    });
  });

  test('uses injected desktop SSH host identity after the URL query is removed', async () => {
    await withWindow({
      location: {
        origin: 'http://127.0.0.1:60782',
        href: 'http://127.0.0.1:60782/index',
        protocol: 'http:',
      },
      dispatchEvent: () => true,
      __OPENCHAMBER_LOCAL_ORIGIN__: 'http://127.0.0.1:5173',
      __OPENCHAMBER_DESKTOP_HOST_ID__: 'ssh-1',
    }, async () => {
      const runtimeSwitch = await importFreshRuntimeSwitch();
      runtimeSwitch.switchRuntimeEndpoint({ apiBaseUrl: '' });

      expect(runtimeSwitch.getRuntimeApiBaseUrl()).toBe('');
      expect(runtimeSwitch.getRuntimeKey()).toBe('host:ssh-1');
    });
  });

  test('drops stale explicit loopback API base and runtime key on remote page', async () => {
    await withWindow({
      location: {
        origin: 'http://127.0.0.1:49932',
        href: 'http://127.0.0.1:49932/index',
        protocol: 'http:',
      },
      dispatchEvent: () => true,
      __OPENCHAMBER_LOCAL_ORIGIN__: 'http://127.0.0.1:3901',
      __OPENCHAMBER_API_BASE_URL__: 'http://127.0.0.1:65500',
    }, async () => {
      const runtimeSwitch = await importFreshRuntimeSwitch();
      runtimeSwitch.switchRuntimeEndpoint({
        apiBaseUrl: 'http://127.0.0.1:65500',
        runtimeKey: 'url:http://127.0.0.1:65500',
      });

      expect(runtimeSwitch.getRuntimeApiBaseUrl()).toBe('');
      expect(runtimeSwitch.getRuntimeKey()).toBe('url:http://127.0.0.1:49932');
    });
  });
});
