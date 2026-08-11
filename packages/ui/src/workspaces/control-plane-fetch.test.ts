import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  CONTROL_PLANE_UNAVAILABLE_CODE,
  createControlPlaneFetch,
  getControlPlaneBaseUrl,
  getControlPlaneOrigin,
  isControlPlaneAvailable,
  setControlPlaneOrigin,
} from './control-plane-fetch';
import { setRuntimeBearerToken, setRuntimeExtraHeaders } from '@/lib/runtime-auth';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';

const runtimeWindow = globalThis as unknown as {
  window?: { location: { origin: string }; __OPENCHAMBER_LOCAL_ORIGIN__?: string } | undefined;
};

const captured: Array<{ url: string; init?: RequestInit }> = [];

const stubWindowOrigin = (origin: string, localOrigin?: string): void => {
  const eventTarget = new EventTarget();
  runtimeWindow.window = {
    location: { origin },
    dispatchEvent: (event: Event) => eventTarget.dispatchEvent(event),
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => eventTarget.addEventListener(type, listener),
    ...(localOrigin ? { __OPENCHAMBER_LOCAL_ORIGIN__: localOrigin } : {}),
  } as typeof runtimeWindow.window;
};

describe('control-plane-fetch pinning', () => {
  beforeEach(() => {
    captured.length = 0;
    stubWindowOrigin('https://cp.example');
    setRuntimeBearerToken(null);
    setRuntimeExtraHeaders(null);
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ url: String(input), init });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
  });

  afterEach(() => {
    runtimeWindow.window = undefined;
    setRuntimeBearerToken(null);
    setControlPlaneOrigin(null);
  });

  test('pins relative paths to the control-plane origin', async () => {
    const fetchPinned = createControlPlaneFetch();
    await fetchPinned('/api/workspaces');
    expect(captured[0].url).toBe('https://cp.example/api/workspaces');
  });

  test('does not follow the active remote runtime', async () => {
    // Active runtime is a REMOTE server; the catalog must stay local.
    switchRuntimeEndpoint({ apiBaseUrl: 'https://active-remote.example', clientToken: 'remote-token', runtimeKey: 'host:remote' });
    const fetchPinned = createControlPlaneFetch();
    await fetchPinned('/api/workspaces');
    expect(captured[0].url).toBe('https://cp.example/api/workspaces');
    // The remote bearer must NOT be attached to control-plane requests.
    const remoteHeaders = captured[0].init?.headers;
    const remoteValue = remoteHeaders instanceof Headers ? remoteHeaders.get('Authorization') : (remoteHeaders as Record<string, string> | undefined)?.Authorization;
    expect(remoteValue === undefined || remoteValue === null).toBe(true);
  });

  test('attaches the bearer when the active runtime IS the control plane', async () => {
    switchRuntimeEndpoint({ apiBaseUrl: 'https://cp.example', clientToken: 'cp-token', runtimeKey: 'local' });
    const fetchPinned = createControlPlaneFetch();
    await fetchPinned('/api/workspaces');
    expect(captured[0].url).toBe('https://cp.example/api/workspaces');
    const headers = captured[0].init?.headers as Record<string, string> | Headers | undefined;
    const value = headers instanceof Headers ? headers.get('Authorization') : headers?.Authorization;
    expect(value).toBe('Bearer cp-token');
  });

  test('rewrites window-origin absolute URLs to the control-plane base', async () => {
    const fetchPinned = createControlPlaneFetch();
    await fetchPinned(new Request('https://cp.example/api/workspaces/ws-1/runtime/api/session', { method: 'GET' }));
    expect(captured[0].url).toBe('https://cp.example/api/workspaces/ws-1/runtime/api/session');
  });

  test('prefers the injected local origin on desktop', async () => {
    stubWindowOrigin('openchamber-ui://localhost', 'http://127.0.0.1:3901');
    switchRuntimeEndpoint({ apiBaseUrl: 'http://127.0.0.1:3901', clientToken: 'local-token', runtimeKey: 'local' });
    const fetchPinned = createControlPlaneFetch();
    await fetchPinned('/api/workspaces');
    expect(captured[0].url).toBe('http://127.0.0.1:3901/api/workspaces');
  });

  test('keeps a deployment path prefix on the control plane', async () => {
    stubWindowOrigin('https://host.example');
    switchRuntimeEndpoint({ apiBaseUrl: 'https://host.example/chamber', clientToken: 'tok', runtimeKey: 'local' });
    const fetchPinned = createControlPlaneFetch();
    await fetchPinned('/api/workspaces');
    expect(captured[0].url).toBe('https://host.example/chamber/api/workspaces');
  });

  test('base resolution falls back to the window origin', () => {
    stubWindowOrigin('https://web.example');
    switchRuntimeEndpoint({ apiBaseUrl: 'https://active-remote.example', runtimeKey: 'host:remote' });
    expect(getControlPlaneBaseUrl()).toBe('https://web.example');
  });

  test('an explicitly injected origin wins over every other source', async () => {
    stubWindowOrigin('capacitor://localhost', 'http://127.0.0.1:3901');
    setControlPlaneOrigin('https://mobile-control-plane.example/');
    expect(getControlPlaneOrigin()).toBe('https://mobile-control-plane.example');
    expect(getControlPlaneBaseUrl()).toBe('https://mobile-control-plane.example');
    const fetchPinned = createControlPlaneFetch();
    await fetchPinned('/api/workspaces');
    expect(captured[0].url).toBe('https://mobile-control-plane.example/api/workspaces');
  });

  test('clearing the injected origin restores automatic resolution', () => {
    stubWindowOrigin('capacitor://localhost');
    setControlPlaneOrigin('http://192.168.1.5:3901');
    setControlPlaneOrigin(null);
    expect(getControlPlaneOrigin()).toBeNull();
    expect(getControlPlaneBaseUrl()).toBe('capacitor://localhost');
  });

  test('non-http window origins answer control_plane_unavailable without dispatching', async () => {
    stubWindowOrigin('capacitor://localhost');
    expect(isControlPlaneAvailable()).toBe(false);
    const fetchPinned = createControlPlaneFetch();
    const response = await fetchPinned('/api/workspaces');
    expect(captured.length).toBe(0);
    expect(response.status).toBe(501);
    const body = await response.json() as { error?: string; code?: string };
    expect(body.code).toBe(CONTROL_PLANE_UNAVAILABLE_CODE);
    expect(body.error).toContain('Control plane');
  });

  test('vscode-webview origins answer control_plane_unavailable without dispatching', async () => {
    stubWindowOrigin('vscode-webview://main');
    expect(isControlPlaneAvailable()).toBe(false);
    const fetchPinned = createControlPlaneFetch();
    const response = await fetchPinned('/api/workspaces');
    expect(captured.length).toBe(0);
    expect(response.status).toBe(501);
    const body = await response.json() as { code?: string };
    expect(body.code).toBe(CONTROL_PLANE_UNAVAILABLE_CODE);
  });

  test('an injected origin makes a non-http webview control plane available', () => {
    stubWindowOrigin('capacitor://localhost');
    expect(isControlPlaneAvailable()).toBe(false);
    setControlPlaneOrigin('http://192.168.1.5:3901');
    expect(isControlPlaneAvailable()).toBe(true);
    expect(getControlPlaneBaseUrl()).toBe('http://192.168.1.5:3901');
  });

  test('desktop injection keeps the control plane available on a virtual origin', () => {
    stubWindowOrigin('openchamber-ui://localhost', 'http://127.0.0.1:3901');
    expect(isControlPlaneAvailable()).toBe(true);
  });
});
