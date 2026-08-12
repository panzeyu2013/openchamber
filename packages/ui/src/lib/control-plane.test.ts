import { describe, expect, test } from 'bun:test';
import {
  getControlPlaneBaseUrl,
  getControlPlaneKey,
  subscribeControlPlaneChanged,
  subscribeControlPlaneWillChange,
  setControlPlane,
} from './control-plane';
import { clearRuntimeUrlAuthToken, setRuntimeExtraHeaders } from './runtime-auth';
import {
  activateRelayTunnel,
  deactivateRelayTunnel,
  getActiveRelayDescriptor,
  getActiveRelayTunnel,
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

const importFreshControlPlane = async () => (
  import(`./control-plane?test=${Date.now()}-${Math.random()}`)
);

describe('control-plane switching', () => {
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
      setControlPlane({ apiBaseUrl: 'https://runtime-a.example', runtimeKey: 'runtime-a' });
      const observed: Array<[string, string, string]> = [];
      const unsubscribeWillChange = subscribeControlPlaneWillChange((detail) => {
        observed.push(['will-change', getControlPlaneKey(), detail.previousRuntimeKey]);
      });
      const unsubscribeChanged = subscribeControlPlaneChanged((detail) => {
        observed.push(['changed', getControlPlaneKey(), detail.runtimeKey]);
      });

      setControlPlane({ apiBaseUrl: 'https://runtime-b.example', runtimeKey: 'runtime-b' });

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
        setControlPlane({
          apiBaseUrl: 'https://remote.example',
          clientToken: 'client-token',
          requestHeaders: null,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeNull();
      expect(getControlPlaneBaseUrl()).toBe('https://remote.example');
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
      const controlPlane = await importFreshControlPlane();

      expect(controlPlane.getControlPlaneBaseUrl()).toBe('');
      expect(controlPlane.getControlPlaneKey()).toBe('url:http://127.0.0.1:60782');
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
      const controlPlane = await importFreshControlPlane();
      controlPlane.initializeControlPlane({ apiBaseUrl: '', runtimeKey: 'host:ssh-1' });

      expect(controlPlane.getControlPlaneBaseUrl()).toBe('');
      expect(controlPlane.getControlPlaneKey()).toBe('host:ssh-1');
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
      const controlPlane = await importFreshControlPlane();
      controlPlane.setControlPlane({ apiBaseUrl: '' });

      expect(controlPlane.getControlPlaneBaseUrl()).toBe('');
      expect(controlPlane.getControlPlaneKey()).toBe('url:http://127.0.0.1:60782');
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
      const controlPlane = await importFreshControlPlane();
      controlPlane.setControlPlane({ apiBaseUrl: '' });

      expect(controlPlane.getControlPlaneBaseUrl()).toBe('');
      expect(controlPlane.getControlPlaneKey()).toBe('host:ssh-1');
    });
  });

  test('treats an explicit local desktop window identity as local', async () => {
    await withWindow({
      location: {
        origin: 'openchamber-ui://app',
        href: 'openchamber-ui://app/index.html',
        protocol: 'openchamber-ui:',
      },
      dispatchEvent: () => true,
      __OPENCHAMBER_LOCAL_ORIGIN__: 'http://127.0.0.1:5173',
      __OPENCHAMBER_DESKTOP_HOST_ID__: 'local',
    }, async () => {
      const controlPlane = await importFreshControlPlane();
      expect(controlPlane.getControlPlaneKey()).toBe('local');
    });
  });

  test('honors an explicit switch between distinct loopback runtimes', async () => {
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
      const controlPlane = await importFreshControlPlane();
      controlPlane.setControlPlane({
        apiBaseUrl: 'http://127.0.0.1:65500',
        runtimeKey: 'url:http://127.0.0.1:65500',
      });

      expect(controlPlane.getControlPlaneBaseUrl()).toBe('http://127.0.0.1:65500');
      expect(controlPlane.getControlPlaneKey()).toBe('url:http://127.0.0.1:65500');
      const { getRuntimeUrlResolver } = await import('./runtime-url');
      expect(getRuntimeUrlResolver().api('/api/version')).toBe('http://127.0.0.1:65500/api/version');
    });
  });

  test('classifies a main-process-verified Electron HMR page as local', async () => {
    await withWindow({
      location: {
        origin: 'http://127.0.0.1:5173',
        href: 'http://127.0.0.1:5173/index',
        protocol: 'http:',
      },
      __OPENCHAMBER_LOCAL_ORIGIN__: 'http://127.0.0.1:3901',
      __OPENCHAMBER_API_BASE_URL__: '',
      __OPENCHAMBER_DESKTOP_LOCAL_UI__: true,
    }, async () => {
      const controlPlane = await importFreshControlPlane();

      expect(controlPlane.getControlPlaneBaseUrl()).toBe('');
      expect(controlPlane.getControlPlaneKey()).toBe('local');
    });
  });

  test('allows an explicit switch from a remote loopback page to the authoritative local runtime', async () => {
    await withWindow({
      location: {
        origin: 'http://127.0.0.1:49932',
        href: 'http://127.0.0.1:49932/index',
        protocol: 'http:',
      },
      dispatchEvent: () => true,
      __OPENCHAMBER_LOCAL_ORIGIN__: 'http://127.0.0.1:3901',
    }, async () => {
      const controlPlane = await importFreshControlPlane();
      controlPlane.setControlPlane({
        apiBaseUrl: 'http://127.0.0.1:3901',
        runtimeKey: 'local',
      });

      expect(controlPlane.getControlPlaneBaseUrl()).toBe('http://127.0.0.1:3901');
      expect(controlPlane.getControlPlaneKey()).toBe('local');
    });
  });
});

describe('resetControlPlane', () => {
  test('leaves the control-plane key as mobile-disconnected on a virtual mobile origin', async () => {
    await withWindow({
      location: {
        origin: 'capacitor://localhost',
        href: 'capacitor://localhost/index',
        protocol: 'capacitor:',
      },
      dispatchEvent: () => true,
    }, async () => {
      const controlPlane = await importFreshControlPlane();
      controlPlane.setControlPlane({ apiBaseUrl: 'http://192.168.1.5:3901', runtimeKey: 'url:http://192.168.1.5:3901' });
      expect(controlPlane.getControlPlaneKey()).toBe('url:http://192.168.1.5:3901');

      controlPlane.resetControlPlane();

      expect(controlPlane.getControlPlaneBaseUrl()).toBe('');
      expect(controlPlane.getControlPlaneKey()).toBe('mobile-disconnected');
    });
  });

  test('keeps mobile-disconnected even when a desktop host identity is injected', async () => {
    await withWindow({
      location: {
        origin: 'openchamber-ui://app',
        href: 'openchamber-ui://app/index.html',
        protocol: 'openchamber-ui:',
      },
      dispatchEvent: () => true,
      __OPENCHAMBER_DESKTOP_HOST_ID__: 'local',
    }, async () => {
      const controlPlane = await importFreshControlPlane();
      controlPlane.resetControlPlane();

      expect(controlPlane.getControlPlaneKey()).toBe('mobile-disconnected');
    });
  });

  test('clears bearer and extra headers and fires change notifications', async () => {
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
      const controlPlane = await importFreshControlPlane();
      controlPlane.setControlPlane({
        apiBaseUrl: 'https://cp.example',
        clientToken: 'client-token',
        requestHeaders: { 'x-runtime': 'value' },
        runtimeKey: 'host:cp',
      });
      expect(controlPlane.getControlPlaneBearerTokenSync()).toBe('client-token');
      expect(controlPlane.getControlPlaneExtraHeadersSync()).toEqual({ 'x-runtime': 'value' });

      const observed: string[] = [];
      const unsubscribeWillChange = controlPlane.subscribeControlPlaneWillChange((detail: { previousRuntimeKey: string; runtimeKey: string }) => {
        observed.push(`will-change:${detail.previousRuntimeKey}->${detail.runtimeKey}`);
      });
      const unsubscribeChanged = controlPlane.subscribeControlPlaneChanged((detail: { previousRuntimeKey: string; runtimeKey: string }) => {
        observed.push(`changed:${detail.previousRuntimeKey}->${detail.runtimeKey}`);
      });

      controlPlane.resetControlPlane();

      expect(observed).toEqual([
        'will-change:host:cp->mobile-disconnected',
        'changed:host:cp->mobile-disconnected',
      ]);
      expect(controlPlane.getControlPlaneBearerTokenSync()).toBe('');
      expect(controlPlane.getControlPlaneExtraHeadersSync()).toEqual({});
      expect(controlPlane.getControlPlaneKey()).toBe('mobile-disconnected');
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

  test('deactivates an active relay tunnel', async () => {
    const descriptor = {
      relayUrl: 'wss://relay.example.com',
      serverId: 'server-1',
      hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'public-x', y: 'public-y' },
    };

    await withWindow({
      location: {
        origin: 'http://127.0.0.1:5173',
        href: 'http://127.0.0.1:5173/index',
        protocol: 'http:',
      },
      dispatchEvent: () => true,
    }, async () => {
      const controlPlane = await importFreshControlPlane();
      controlPlane.setControlPlane({ apiBaseUrl: 'http://127.0.0.1:3901', runtimeKey: 'local', relay: descriptor });
      expect(getActiveRelayTunnel()).not.toBeNull();

      controlPlane.resetControlPlane();

      expect(getActiveRelayTunnel()).toBeNull();
    });
  });
});
