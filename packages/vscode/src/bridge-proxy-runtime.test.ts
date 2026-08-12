import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { BridgeContext } from './bridge';
import { handleProxyBridgeMessage, type ProxyRuntimeDeps } from './bridge-proxy-runtime';

type TestProxyDeps = ProxyRuntimeDeps;

const deps: TestProxyDeps = {
  tryHandleLocalFsProxy: async () => null,
  buildUnavailableApiResponse: () => ({ status: 503, headers: {}, bodyText: '' }),
  sanitizeForwardHeaders: (input: Record<string, string> | undefined) => input ?? {},
  collectHeaders: (headers: Headers) => {
    const result: Record<string, string> = {};
    headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  },
  base64EncodeUtf8: (text: string) => Buffer.from(text, 'utf8').toString('base64'),
  resolveControlPlaneOrigin: () => null,
};

const depsWithOrigin = (origin: string | null): TestProxyDeps => ({
  ...deps,
  resolveControlPlaneOrigin: () => origin,
});

const ctx = {
  manager: {
    getStatus: () => 'connected',
    getApiUrl: () => 'http://127.0.0.1:3902',
    getOpenCodeAuthHeaders: () => ({}),
    onStatusChange: (cb: (status: string) => void) => {
      cb('connected');
      return { dispose: () => {} };
    },
  },
} as unknown as BridgeContext;

const ctxWithAuth = {
  manager: {
    getStatus: () => 'connected',
    getApiUrl: () => 'http://127.0.0.1:3902',
    getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test-token' }),
    onStatusChange: (cb: (status: string) => void) => {
      cb('connected');
      return { dispose: () => {} };
    },
  },
} as unknown as BridgeContext;

describe('VS Code API proxy aborts', () => {
  test('aborts non-SSE api:proxy fetches by bridge request id', async () => {
    const originalFetch = globalThis.fetch;
    let capturedSignal: AbortSignal | undefined;

    try {
      globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        capturedSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          capturedSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
      }) as typeof fetch;

      const pending = handleProxyBridgeMessage(
        { id: 'req_1', type: 'api:proxy', payload: { method: 'POST', path: '/session/abc/prompt_async', bodyBase64: Buffer.from('{}').toString('base64') } },
        ctx,
        deps,
      );

      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(capturedSignal?.aborted, false);

      await handleProxyBridgeMessage({ id: 'abort_req_1', type: 'api:proxy:abort', payload: { requestID: 'req_1' } }, ctx, deps);
      assert.equal(capturedSignal?.aborted, true);

      const response = await pending;
      assert.equal(response?.success, true);
      assert.equal((response?.data as { status?: number }).status, 502);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('VS Code API proxy control plane', () => {
  test('controlPlane requests answer capability_unavailable without touching the binary', async () => {
    const originalFetch = globalThis.fetch;
    let binaryFetchCount = 0;
    try {
      globalThis.fetch = (async () => {
        binaryFetchCount += 1;
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;

      const response = await handleProxyBridgeMessage(
        { id: 'cp_1', type: 'api:proxy', payload: { method: 'GET', path: '/api/workspaces', controlPlane: true } },
        ctx,
        deps,
      );
      assert.equal(response?.success, true);
      assert.equal((response?.data as { status?: number }).status, 501);
      const body = JSON.parse((response?.data as { bodyText: string }).bodyText) as { code?: string; workspaceId?: string };
      assert.equal(body.code, 'capability_unavailable');
      assert.equal(binaryFetchCount, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('controlPlane requests echo a workspaceId for forward-compat', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

      const response = await handleProxyBridgeMessage(
        {
          id: 'cp_2',
          type: 'api:proxy',
          payload: { method: 'GET', path: '/api/workspaces/ws-1', controlPlane: true, workspaceId: 'ws-1' },
        },
        ctx,
        deps,
      );
      const body = JSON.parse((response?.data as { bodyText: string }).bodyText) as { workspaceId?: string };
      assert.equal(body.workspaceId, 'ws-1');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('payload without controlPlane keeps the existing proxy behavior', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

      const response = await handleProxyBridgeMessage(
        { id: 'plain_1', type: 'api:proxy', payload: { method: 'GET', path: '/session' } },
        ctx,
        deps,
      );
      assert.equal((response?.data as { status?: number }).status, 200);
      assert.equal((response?.data as { bodyText?: string }).bodyText, '{"ok":true}');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('controlPlane requests forward to the configured origin with method/path/query and auth headers', async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; init: RequestInit }> = [];
    try {
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        calls.push({ url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url, init: init || {} });
        return new Response('{"sessions":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;

      const response = await handleProxyBridgeMessage(
        {
          id: 'cp_fwd_1',
          type: 'api:proxy',
          payload: { method: 'GET', path: '/api/workspace-sessions/snapshot?fresh=1', controlPlane: true },
        },
        ctxWithAuth,
        depsWithOrigin('http://control.test:3000'),
      );

      assert.equal(response?.success, true);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.url, 'http://control.test:3000/api/workspace-sessions/snapshot?fresh=1');
      assert.equal(calls[0]?.init.method, 'GET');
      const headers = new Headers(calls[0]?.init.headers);
      assert.equal(headers.get('authorization'), 'Bearer test-token');
      assert.equal((response?.data as { status?: number }).status, 200);
      assert.equal((response?.data as { bodyText?: string }).bodyText, '{"sessions":[]}');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('controlPlane forward preserves the origin path prefix and forwards POST bodies', async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; init: RequestInit }> = [];
    try {
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        calls.push({ url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url, init: init || {} });
        return new Response('{"sessionId":"s-1","workspaceId":"ws-1"}', { status: 201, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;

      const response = await handleProxyBridgeMessage(
        {
          id: 'cp_fwd_2',
          type: 'api:proxy',
          payload: {
            method: 'POST',
            path: '/api/workspaces/ws-1/sessions',
            controlPlane: true,
            bodyBase64: Buffer.from('{"prompt":"hello"}').toString('base64'),
          },
        },
        ctx,
        depsWithOrigin('http://host:8080/chamber/'),
      );

      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.url, 'http://host:8080/chamber/api/workspaces/ws-1/sessions');
      assert.equal(calls[0]?.init.method, 'POST');
      assert.equal(Buffer.from(calls[0]?.init.body as Uint8Array).toString('utf8'), '{"prompt":"hello"}');
      assert.equal((response?.data as { status?: number }).status, 201);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('controlPlane forward propagates upstream 404 and 500 statuses and bodies', async () => {
    const originalFetch = globalThis.fetch;
    try {
      let status = 404;
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ error: 'nope' }), { status, headers: { 'content-type': 'application/json' } })) as typeof fetch;

      let response = await handleProxyBridgeMessage(
        { id: 'cp_404', type: 'api:proxy', payload: { method: 'GET', path: '/api/workspaces/ws-missing', controlPlane: true } },
        ctx,
        depsWithOrigin('http://control.test'),
      );
      assert.equal((response?.data as { status?: number }).status, 404);
      assert.equal((response?.data as { bodyText?: string }).bodyText, JSON.stringify({ error: 'nope' }));

      status = 500;
      response = await handleProxyBridgeMessage(
        { id: 'cp_500', type: 'api:proxy', payload: { method: 'GET', path: '/api/connections/conn-1/probe', controlPlane: true } },
        ctx,
        depsWithOrigin('http://control.test'),
      );
      assert.equal((response?.data as { status?: number }).status, 500);
      assert.equal((response?.data as { bodyText?: string }).bodyText, JSON.stringify({ error: 'nope' }));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('controlPlane forward never leaks upstream auth headers to the webview', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        new Response('{"ok":true}', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            authorization: 'Basic leaked-secret',
            'set-cookie': 'session=abc123',
            'www-authenticate': 'Basic realm="control"',
            'x-custom': 'keep-me',
          },
        })) as typeof fetch;

      const response = await handleProxyBridgeMessage(
        { id: 'cp_leak', type: 'api:proxy', payload: { method: 'GET', path: '/api/workspaces', controlPlane: true } },
        ctx,
        depsWithOrigin('http://control.test'),
      );

      const headers = (response?.data as { headers: Record<string, string> }).headers;
      assert.equal('authorization' in headers, false);
      assert.equal('set-cookie' in headers, false);
      assert.equal('www-authenticate' in headers, false);
      assert.equal(headers['x-custom'], 'keep-me');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('controlPlane SSE-accept requests are rejected instead of buffering an open stream', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    try {
      globalThis.fetch = (async () => {
        fetchCount += 1;
        return new Response('data: {"x":1}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }) as typeof fetch;

      const response = await handleProxyBridgeMessage(
        {
          id: 'cp_sse',
          type: 'api:proxy',
          payload: { method: 'GET', path: '/api/workspace-sessions/events', controlPlane: true, headers: { accept: 'text/event-stream' } },
        },
        ctx,
        depsWithOrigin('http://control.test'),
      );

      assert.equal((response?.data as { status?: number }).status, 400);
      assert.equal(fetchCount, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('controlPlane WebSocket upgrades stay capability_unavailable and are never forwarded', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    try {
      globalThis.fetch = (async () => {
        fetchCount += 1;
        return new Response('{}', { status: 200 });
      }) as typeof fetch;

      const response = await handleProxyBridgeMessage(
        {
          id: 'cp_ws',
          type: 'api:proxy',
          payload: { method: 'GET', path: '/api/workspaces/ws-1/terminal', controlPlane: true, headers: { upgrade: 'websocket', connection: 'Upgrade' } },
        },
        ctx,
        depsWithOrigin('http://control.test'),
      );

      assert.equal(response?.success, true);
      assert.equal((response?.data as { status?: number }).status, 501);
      const body = JSON.parse((response?.data as { bodyText: string }).bodyText) as { code?: string };
      assert.equal(body.code, 'capability_unavailable');
      assert.equal(fetchCount, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('controlPlane forwarding is aborted by api:proxy:abort', async () => {
    const originalFetch = globalThis.fetch;
    let capturedSignal: AbortSignal | undefined;
    try {
      globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        capturedSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          capturedSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
      }) as typeof fetch;

      const pending = handleProxyBridgeMessage(
        { id: 'cp_abort_1', type: 'api:proxy', payload: { method: 'GET', path: '/api/workspaces', controlPlane: true } },
        ctx,
        depsWithOrigin('http://control.test'),
      );

      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(capturedSignal?.aborted, false);

      await handleProxyBridgeMessage({ id: 'abort_cp_1', type: 'api:proxy:abort', payload: { requestID: 'cp_abort_1' } }, ctx, deps);
      assert.equal(capturedSignal?.aborted, true);

      const response = await pending;
      assert.equal(response?.success, true);
      assert.equal((response?.data as { status?: number }).status, 504);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('VS Code API proxy read coalescing', () => {  test('shares one upstream fetch across concurrent identical GET reads', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    let release: () => void = () => {};

    try {
      globalThis.fetch = (async () => {
        fetchCount += 1;
        await new Promise<void>((resolve) => { release = resolve; });
        return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;

      const first = handleProxyBridgeMessage(
        { id: 'r1', type: 'api:proxy', payload: { method: 'GET', path: '/config?directory=/x' } },
        ctx,
        deps,
      );
      const second = handleProxyBridgeMessage(
        { id: 'r2', type: 'api:proxy', payload: { method: 'GET', path: '/config?directory=/x' } },
        ctx,
        deps,
      );

      await new Promise((resolve) => setTimeout(resolve, 0));
      release();

      const [a, b] = await Promise.all([first, second]);
      assert.equal(fetchCount, 1);
      assert.equal((a?.data as { bodyText?: string }).bodyText, '{"ok":true}');
      assert.equal((b?.data as { bodyText?: string }).bodyText, '{"ok":true}');
      assert.notStrictEqual((a?.data as { headers: unknown }).headers, (b?.data as { headers: unknown }).headers);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('does not coalesce POST writes or non-allowlisted reads', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;

    try {
      globalThis.fetch = (async () =>
        new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

      await Promise.all([
        handleProxyBridgeMessage({ id: 'w1', type: 'api:proxy', payload: { method: 'GET', path: '/session?directory=/x' } }, ctx, deps),
        handleProxyBridgeMessage({ id: 'w2', type: 'api:proxy', payload: { method: 'GET', path: '/session?directory=/x' } }, ctx, deps),
      ]);
      assert.equal(fetchCount, 0); // sanity: counter only bumps in the slow mock above

      globalThis.fetch = (async () => {
        fetchCount += 1;
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;

      await Promise.all([
        handleProxyBridgeMessage({ id: 's1', type: 'api:proxy', payload: { method: 'GET', path: '/session?directory=/x' } }, ctx, deps),
        handleProxyBridgeMessage({ id: 's2', type: 'api:proxy', payload: { method: 'GET', path: '/session?directory=/x' } }, ctx, deps),
      ]);
      assert.equal(fetchCount, 2); // /session is not in the read allowlist
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
