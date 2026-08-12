import { describe, expect, it } from 'vitest';
import { Readable } from 'stream';
import {
  WORKSPACE_RUNTIME_UPGRADE_MARKER,
  handleWorkspaceUpgrade,
  isForwardableWorkspaceRuntimePath,
  isWorkspaceRuntimeCapabilityUnavailablePath,
  isAllowedWorkspaceUpgradePath,
  parseWorkspaceRuntimePath,
  registerWorkspaceRuntimeProxyRoutes,
  stripWorkspaceUrlAuthToken,
} from './runtime-proxy.js';

const createCatalogStoreStub = (workspaces) => ({
  getWorkspace: async (workspaceId) => workspaces.find((workspace) => workspace.id === workspaceId) ?? null,
});

const createAdapterStub = (fetchImpl, capabilities = { eventStream: true }, overrides = {}) => ({
  connectionId: 'local',
  capabilities: { pathBrowse: true, terminal: true, files: true, git: true, eventStream: true, ...capabilities },
  fetch: fetchImpl,
  openWebSocket: async () => {
    const error = new Error('upstream unavailable');
    error.code = 'catalog_runtime_upstream_failed';
    error.status = 502;
    throw error;
  },
  ...overrides,
});

const createBrokerStub = (adapter) => ({
  getAdapter: () => adapter,
  acquireLease: () => () => {},
  resolveConnection: async () => (adapter ? { profile: null, adapter } : null),
});

const routeApp = (dependencies) => {
  const routes = [];
  const app = {
    all(path, handler) {
      routes.push({ method: '*', path, handler });
    },
    use(path, handler) {
      routes.push({ method: 'use', path, handler });
    },
  };
  registerWorkspaceRuntimeProxyRoutes(app, dependencies);
  return routes;
};

const findHandler = (app, method, path) => {
  const route = app.find((entry) => entry.method === method && entry.path === path);
  if (!route) return null;
  return route.handler;
};

const createRequest = ({ path, method = 'GET', headers = {}, body = null, on = null }) => ({
  originalUrl: path,
  method,
  path,
  headers,
  get: (name) => headers[name] ?? undefined,
  body,
  ...(on ? { on, removeListener: () => {} } : {}),
});

const createResponse = () => {
  let statusCode = 200;
  const chunks = [];
  const headers = new Map();
  const listeners = new Map();
  return {
    status(code) {
      statusCode = code;
      return this;
    },
    setHeader(name, value) {
      headers.set(name, value);
    },
    json(payload) {
      chunks.push(Buffer.from(JSON.stringify(payload)));
      return this;
    },
    write(chunk) {
      chunks.push(Buffer.from(chunk));
      return true;
    },
    end(value) {
      if (value !== undefined) chunks.push(Buffer.from(value));
      return this;
    },
    on(name, listener) {
      const set = listeners.get(name) ?? new Set();
      set.add(listener);
      listeners.set(name, set);
    },
    removeListener(name, listener) {
      listeners.get(name)?.delete(listener);
    },
    emit(name, ...args) {
      for (const listener of listeners.get(name) ?? []) listener(...args);
    },
    statusCode() { return statusCode; },
    get body() { return Buffer.concat(chunks).toString('utf8'); },
    get headers() { return headers; },
    get headersSent() { return chunks.length > 0; },
  };
};

describe('parseWorkspaceRuntimePath', () => {
  it('parses the workspace id and rest path', () => {
    expect(parseWorkspaceRuntimePath('/api/workspaces/abc-123/runtime/api/session?x=1')).toEqual({
      workspaceId: 'abc-123',
      restPath: '/api/session?x=1',
    });
  });

  it('returns null for paths outside the runtime prefix', () => {
    expect(parseWorkspaceRuntimePath('/api/workspaces')).toBeNull();
    expect(parseWorkspaceRuntimePath('/api/workspaces/abc-123')).toBeNull();
    expect(parseWorkspaceRuntimePath('/api/fs/list')).toBeNull();
  });

  it('decodes percent-encoded workspace ids', () => {
    expect(parseWorkspaceRuntimePath('/api/workspaces/a%20b/runtime/api/x')).toEqual({
      workspaceId: 'a b',
      restPath: '/api/x',
    });
  });
});

describe('stripWorkspaceUrlAuthToken', () => {
  it('removes only the control-plane URL token and preserves other query parameters', () => {
    expect(stripWorkspaceUrlAuthToken('/api/session?oc_url_token=control-plane-secret&limit=25'))
      .toBe('/api/session?limit=25');
    expect(stripWorkspaceUrlAuthToken('/api/session?limit=25')).toBe('/api/session?limit=25');
  });
});

describe('workspace runtime path allowlist', () => {
  it('allows workspace-capable SDK and RuntimeAPI paths only', () => {
    for (const allowed of [
      '/api/session',
      '/api/session/s-1/prompt_async',
      '/api/global/event?directory=%2Fsafe',
      '/api/fs/read?path=src%2Fmain.ts',
      '/api/git/status?directory=%2Fsafe',
      '/api/terminal/create',
      '/api/permission/request',
      '/api/question/request',
      '/api/opencode/health',
    ]) {
      expect(isForwardableWorkspaceRuntimePath(allowed)).toBe(true);
    }
  });

  it('rejects control-plane namespaces and prefix collisions', () => {
    for (const rejected of [
      '/api/workspaces',
      '/api/connections/conn-1/children',
      '/api/client-auth/clients',
      '/api/system/info',
      '/api/openchamber/agent-tool',
      '/api/fs/home',
      '/api/session-debug',
      '/api/healthcheck',
      '/api/config/settings',
    ]) {
      expect(isForwardableWorkspaceRuntimePath(rejected)).toBe(false);
    }
    expect(isWorkspaceRuntimeCapabilityUnavailablePath('/api/config/settings')).toBe(true);
    expect(isWorkspaceRuntimeCapabilityUnavailablePath('/api/configuration')).toBe(false);
  });
});

describe('workspace runtime proxy', () => {
  it('returns an explicit capability-unavailable response for config CRUD', async () => {
    const adapter = createAdapterStub(async () => {
      throw new Error('config must not cross the workspace boundary');
    });
    const app = routeApp({
      catalogStore: createCatalogStoreStub([{
        id: 'ws-1',
        connectionId: 'local',
        canonicalPath: '/workspace/a',
      }]),
      connectionBroker: createBrokerStub(adapter),
    });
    const handler = findHandler(app, '*', '/api/workspaces/:workspaceId/runtime');
    const response = createResponse();
    await handler(createRequest({
      path: '/api/workspaces/ws-1/runtime/api/config/settings',
      method: 'PATCH',
      body: { theme: 'dark' },
    }), response);

    expect(response.statusCode()).toBe(501);
    expect(JSON.parse(response.body)).toEqual({
      error: 'This workspace capability is not available',
      code: 'capability_unavailable',
    });
  });

  it('forwards an /api path to the workspace adapter with the rest path', async () => {
    let forwarded;
    const adapter = createAdapterStub(async (context, _request, restPath) => {
      forwarded = { context, restPath };
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const app = routeApp({
      catalogStore: createCatalogStoreStub([{
        id: 'ws-1',
        connectionId: 'local',
        canonicalPath: '/workspace/a',
        path: '/workspace/a',
        label: 'A',
        orderKey: '',
        createdAt: 1,
        updatedAt: 1,
      }]),
      connectionBroker: createBrokerStub(adapter),
    });

    const handler = findHandler(app, '*', '/api/workspaces/:workspaceId/runtime');
    expect(handler).toBeTruthy();
    const response = createResponse();
    await handler(createRequest({ path: '/api/workspaces/ws-1/runtime/api/session' }), response);

    expect(forwarded.context.canonicalPath).toBe('/workspace/a');
    expect(forwarded.restPath).toBe('/api/session');
    expect(response.statusCode()).toBe(200);
    expect(response.body).toBe(JSON.stringify({ ok: true }));
  });

  it('preserves the query string when forwarding', async () => {
    let forwardedRestPath;
    const adapter = createAdapterStub(async (_context, _request, restPath) => {
      forwardedRestPath = restPath;
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const app = routeApp({
      catalogStore: createCatalogStoreStub([{
        id: 'ws-1', connectionId: 'local', canonicalPath: '/safe', path: '/safe', label: 'A', orderKey: '', createdAt: 1, updatedAt: 1,
      }]),
      connectionBroker: createBrokerStub(adapter),
    });
    const handler = findHandler(app, '*', '/api/workspaces/:workspaceId/runtime');
    const response = createResponse();
    await handler(createRequest({
      path: '/api/workspaces/ws-1/runtime/api/session?oc_url_token=control-plane-secret&limit=25&directory=%2Fsafe&cursor=abc',
    }), response);

    expect(forwardedRestPath).toBe('/api/session?limit=25&directory=%2Fsafe&cursor=abc');
    expect(response.statusCode()).toBe(200);
  });

  it('cancels the upstream stream when the browser disconnects', async () => {
    const closeListeners = new Set();
    let cancelled = false;
    const neverEnding = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: keepalive\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const adapter = createAdapterStub(async () => new Response(neverEnding, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));
    const app = routeApp({
      catalogStore: createCatalogStoreStub([{
        id: 'ws-1', connectionId: 'local', canonicalPath: '/a', path: '/a', label: 'A', orderKey: '', createdAt: 1, updatedAt: 1,
      }]),
      connectionBroker: createBrokerStub(adapter),
    });
    const handler = findHandler(app, '*', '/api/workspaces/:workspaceId/runtime');
    const response = createResponse();
    const request = createRequest({
      path: '/api/workspaces/ws-1/runtime/api/global/event',
      headers: { accept: 'text/event-stream' },
      on: (name, listener) => {
        if (name === 'close') closeListeners.add(listener);
      },
    });
    const pending = handler(request, response);
    // Let the upstream response arrive and the stream start.
    await new Promise((resolve) => setTimeout(resolve, 10));
    for (const listener of closeListeners) listener();
    await pending;

    expect(cancelled).toBe(true);
    expect(response.statusCode()).toBe(200);
  });

  it('pauses on write backpressure and resumes on drain', async () => {
    let writeCount = 0;
    const chunksWritten = [];
    const body = Readable.from(['first', ' second', ' third']);
    const adapter = createAdapterStub(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } }));
    const app = routeApp({
      catalogStore: createCatalogStoreStub([{
        id: 'ws-1', connectionId: 'local', canonicalPath: '/a', path: '/a', label: 'A', orderKey: '', createdAt: 1, updatedAt: 1,
      }]),
      connectionBroker: createBrokerStub(adapter),
    });
    const handler = findHandler(app, '*', '/api/workspaces/:workspaceId/runtime');
    const response = createResponse();
    response.write = (chunk) => {
      writeCount += 1;
      chunksWritten.push(Buffer.from(chunk).toString('utf8'));
      if (writeCount === 1) return false;
      return true;
    };
    const pending = handler(createRequest({ path: '/api/workspaces/ws-1/runtime/api/session' }), response);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(writeCount).toBe(1);
    // Release the backpressure; the pipe must continue.
    response.emit('drain');
    await pending;
    expect(chunksWritten.join('')).toBe('first second third');
    expect(response.statusCode()).toBe(200);
  });

  it('rejects paths outside /api (no arbitrary proxying)', async () => {
    let calls = 0;
    const adapter = createAdapterStub(async () => {
      calls += 1;
      return new Response('x', { status: 200 });
    });
    const app = routeApp({
      catalogStore: createCatalogStoreStub([{
        id: 'ws-1', connectionId: 'local', canonicalPath: '/a', path: '/a', label: 'A', orderKey: '', createdAt: 1, updatedAt: 1,
      }]),
      connectionBroker: createBrokerStub(adapter),
    });
    const handler = findHandler(app, '*', '/api/workspaces/:workspaceId/runtime');
    const response = createResponse();
    await handler(createRequest({ path: '/api/workspaces/ws-1/runtime/health' }), response);

    expect(calls).toBe(0);
    expect(response.statusCode()).toBe(404);
    expect(JSON.parse(response.body).code).toBe('catalog_runtime_path_not_allowed');
  });

  it('404s an unknown workspace before touching the adapter', async () => {
    let calls = 0;
    const adapter = createAdapterStub(async () => {
      calls += 1;
      return new Response('x', { status: 200 });
    });
    const app = routeApp({
      catalogStore: createCatalogStoreStub([]),
      connectionBroker: createBrokerStub(adapter),
    });
    const handler = findHandler(app, '*', '/api/workspaces/:workspaceId/runtime');
    const response = createResponse();
    await handler(createRequest({ path: '/api/workspaces/ghost/runtime/api/session' }), response);

    expect(calls).toBe(0);
    expect(response.statusCode()).toBe(404);
    expect(JSON.parse(response.body).code).toBe('catalog_workspace_not_found');
  });

  it('404s when the connection has no adapter', async () => {
    const app = routeApp({
      catalogStore: createCatalogStoreStub([{
        id: 'ws-1', connectionId: 'missing', canonicalPath: '/a', path: '/a', label: 'A', orderKey: '', createdAt: 1, updatedAt: 1,
      }]),
      connectionBroker: createBrokerStub(null),
    });
    const handler = findHandler(app, '*', '/api/workspaces/:workspaceId/runtime');
    const response = createResponse();
    await handler(createRequest({ path: '/api/workspaces/ws-1/runtime/api/session' }), response);

    expect(response.statusCode()).toBe(404);
    expect(JSON.parse(response.body).code).toBe('catalog_connection_not_found');
  });

  it('rejects disallowed methods', async () => {
    let calls = 0;
    const adapter = createAdapterStub(async () => {
      calls += 1;
      return new Response('x', { status: 200 });
    });
    const app = routeApp({
      catalogStore: createCatalogStoreStub([{
        id: 'ws-1', connectionId: 'local', canonicalPath: '/a', path: '/a', label: 'A', orderKey: '', createdAt: 1, updatedAt: 1,
      }]),
      connectionBroker: createBrokerStub(adapter),
    });
    const handler = findHandler(app, '*', '/api/workspaces/:workspaceId/runtime');
    const response = createResponse();
    await handler(createRequest({ path: '/api/workspaces/ws-1/runtime/api/session', method: 'TRACE' }), response);

    expect(calls).toBe(0);
    expect(response.statusCode()).toBe(405);
  });

  it('rejects oversized request bodies before resolving a workspace', async () => {
    let calls = 0;
    const adapter = createAdapterStub(async () => {
      calls += 1;
      return new Response('ok', { status: 200 });
    });
    const app = routeApp({
      catalogStore: createCatalogStoreStub([{ id: 'ws-1', connectionId: 'local', canonicalPath: '/a' }]),
      connectionBroker: createBrokerStub(adapter),
      maxRequestBytes: 4,
    });
    const handler = findHandler(app, '*', '/api/workspaces/:workspaceId/runtime');
    const response = createResponse();
    await handler(createRequest({ path: '/api/workspaces/ws-1/runtime/api/session', method: 'POST', body: '12345' }), response);

    expect(calls).toBe(0);
    expect(response.statusCode()).toBe(413);
    expect(JSON.parse(response.body).code).toBe('catalog_runtime_body_too_large');
  });

  it('rejects oversized upstream responses before streaming them', async () => {
    const adapter = createAdapterStub(async () => new Response('12345', {
      status: 200,
      headers: { 'content-length': '5' },
    }));
    const app = routeApp({
      catalogStore: createCatalogStoreStub([{ id: 'ws-1', connectionId: 'local', canonicalPath: '/a' }]),
      connectionBroker: createBrokerStub(adapter),
      maxResponseBytes: 4,
    });
    const handler = findHandler(app, '*', '/api/workspaces/:workspaceId/runtime');
    const response = createResponse();
    await handler(createRequest({ path: '/api/workspaces/ws-1/runtime/api/session' }), response);

    expect(response.statusCode()).toBe(413);
    expect(JSON.parse(response.body).code).toBe('catalog_runtime_stream_too_large');
  });

  it('streams the upstream body and sanitized headers only', async () => {
    const upstreamBody = Readable.from(['hello', ' world']);
    const adapter = createAdapterStub(async () => new Response(upstreamBody, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'x-next-cursor': 'abc',
        'authorization': 'Bearer secret',
        'x-upstream-internal': 'leak',
      },
    }));
    const app = routeApp({
      catalogStore: createCatalogStoreStub([{
        id: 'ws-1', connectionId: 'local', canonicalPath: '/a', path: '/a', label: 'A', orderKey: '', createdAt: 1, updatedAt: 1,
      }]),
      connectionBroker: createBrokerStub(adapter),
    });
    const handler = findHandler(app, '*', '/api/workspaces/:workspaceId/runtime');
    const response = createResponse();
    await handler(createRequest({ path: '/api/workspaces/ws-1/runtime/api/global/event', headers: { accept: 'text/event-stream' } }), response);

    expect(response.statusCode()).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('x-next-cursor')).toBe('abc');
    expect(response.headers.has('authorization')).toBe(false);
    expect(response.headers.has('x-upstream-internal')).toBe(false);
  });

  it('returns capability_unavailable for SSE when the connection cannot stream events', async () => {
    const adapter = createAdapterStub(async () => new Response('x', { status: 200 }), { eventStream: false });
    const app = routeApp({
      catalogStore: createCatalogStoreStub([{
        id: 'ws-1', connectionId: 'local', canonicalPath: '/a', path: '/a', label: 'A', orderKey: '', createdAt: 1, updatedAt: 1,
      }]),
      connectionBroker: createBrokerStub(adapter),
    });
    const handler = findHandler(app, '*', '/api/workspaces/:workspaceId/runtime');
    const response = createResponse();
    await handler(createRequest({ path: '/api/workspaces/ws-1/runtime/api/global/event', headers: { accept: 'text/event-stream' } }), response);

    expect(response.statusCode()).toBe(501);
    expect(JSON.parse(response.body).code).toBe('capability_unavailable');
  });

  it('reports a failed upstream forward as 502 without crashing', async () => {
    const adapter = createAdapterStub(async () => {
      throw new Error('upstream exploded');
    });
    const app = routeApp({
      catalogStore: createCatalogStoreStub([{
        id: 'ws-1', connectionId: 'local', canonicalPath: '/a', path: '/a', label: 'A', orderKey: '', createdAt: 1, updatedAt: 1,
      }]),
      connectionBroker: createBrokerStub(adapter),
    });
    const handler = findHandler(app, '*', '/api/workspaces/:workspaceId/runtime');
    const response = createResponse();
    await handler(createRequest({ path: '/api/workspaces/ws-1/runtime/api/session' }), response);

    expect(response.statusCode()).toBe(502);
    expect(JSON.parse(response.body).code).toBe('catalog_runtime_upstream_failed');
  });

  it('preserves safe typed adapter errors instead of disguising boundary failures as 502', async () => {
    const adapter = createAdapterStub(async () => {
      const error = new Error('directory is outside the workspace');
      error.code = 'catalog_path_outside_workspace';
      error.status = 403;
      throw error;
    });
    const app = routeApp({
      catalogStore: createCatalogStoreStub([{
        id: 'ws-1', connectionId: 'local', canonicalPath: '/a', path: '/a', label: 'A', orderKey: '', createdAt: 1, updatedAt: 1,
      }]),
      connectionBroker: createBrokerStub(adapter),
    });
    const handler = findHandler(app, '*', '/api/workspaces/:workspaceId/runtime');
    const response = createResponse();
    await handler(createRequest({ path: '/api/workspaces/ws-1/runtime/api/fs/list?path=%2Fetc' }), response);

    expect(response.statusCode()).toBe(403);
    expect(JSON.parse(response.body)).toEqual({
      error: 'directory is outside the workspace',
      code: 'catalog_path_outside_workspace',
    });
  });
});

describe('workspace WebSocket upgrade dispatcher', () => {
  const workspace = {
    id: 'ws-1', connectionId: 'local', canonicalPath: '/a', path: '/a', label: 'A', orderKey: '', createdAt: 1, updatedAt: 1,
  };

  const createUpgradeRequest = (url) => ({ url, headers: {}, originalUrl: url });

  const runUpgrade = (url, deps) => handleWorkspaceUpgrade(createUpgradeRequest(url), {}, null, deps);

  const createUpgradeDeps = (overrides = {}) => {
    const rejections = [];
    const deps = {
      catalogStore: createCatalogStoreStub([workspace]),
      connectionBroker: createBrokerStub(createAdapterStub(async () => new Response('x', { status: 200 }))),
      getUiAuthController: () => null,
      isRequestOriginAllowed: async () => true,
      rejectWebSocketUpgrade: (socket, status, message) => { rejections.push({ status, message }); },
      ...overrides,
    };
    return { deps, rejections };
  };

  it('allowlists only the workspace-prefixed event and terminal sockets', () => {
    for (const allowed of [
      '/api/event/ws',
      '/api/global/event/ws',
      '/api/terminal/ws',
    ]) {
      expect(isAllowedWorkspaceUpgradePath(allowed)).toBe(true);
    }
    for (const rejected of [
      '/api/session',
      '/api/event',
      '/api/fs/list',
      '/api/terminal/create',
      '/api/preview/proxy/abc',
      '/api/notifications/stream',
    ]) {
      expect(isAllowedWorkspaceUpgradePath(rejected)).toBe(false);
    }
  });

  it('leaves non-workspace upgrades to the existing module listeners', async () => {
    const { deps, rejections } = createUpgradeDeps();
    expect(await runUpgrade('/api/terminal/ws', deps)).toBe(false);
    expect(await runUpgrade('/api/event/ws', deps)).toBe(false);
    expect(rejections).toHaveLength(0);
  });

  it('owns a workspace-prefixed upgrade once and never twice', async () => {
    const { deps } = createUpgradeDeps();
    const req = createUpgradeRequest('/api/workspaces/ws-1/runtime/api/event/ws');
    const first = handleWorkspaceUpgrade(req, {}, null, deps);
    expect(req[WORKSPACE_RUNTIME_UPGRADE_MARKER]).toBe(true);
    expect(await handleWorkspaceUpgrade(req, {}, null, deps)).toBe(false);
    expect(await first).toBe(true);
  });

  it('rejects unauthenticated workspace upgrades with 401', async () => {
    const { deps, rejections } = createUpgradeDeps({
      getUiAuthController: () => ({ enabled: true, ensureSessionToken: async () => null }),
    });
    expect(await runUpgrade('/api/workspaces/ws-1/runtime/api/event/ws', deps)).toBe(true);
    expect(rejections).toEqual([{ status: 401, message: expect.stringContaining('authentication') }]);
  });

  it('rejects workspace upgrades from disallowed origins with 403', async () => {
    const { deps, rejections } = createUpgradeDeps({
      getUiAuthController: () => ({ enabled: true, ensureSessionToken: async () => 'session' }),
      isRequestOriginAllowed: async () => false,
    });
    expect(await runUpgrade('/api/workspaces/ws-1/runtime/api/event/ws', deps)).toBe(true);
    expect(rejections).toEqual([{ status: 403, message: expect.stringContaining('origin') }]);
  });

  it('rejects workspace upgrades for connections without the capability', async () => {
    const adapter = createAdapterStub(async () => new Response('x', { status: 200 }), { terminal: false });
    const { deps, rejections } = createUpgradeDeps({ connectionBroker: createBrokerStub(adapter) });
    expect(await runUpgrade('/api/workspaces/ws-1/runtime/api/terminal/ws', deps)).toBe(true);
    expect(rejections).toEqual([{ status: 501, message: expect.stringContaining('terminal') }]);
  });

  it('rejects unknown workspaces and non-socket paths with 404', async () => {
    const { deps: missingDeps, rejections: missingRejections } = createUpgradeDeps({ catalogStore: createCatalogStoreStub([]) });
    expect(await runUpgrade('/api/workspaces/ghost/runtime/api/event/ws', missingDeps)).toBe(true);
    expect(missingRejections).toEqual([{ status: 404, message: expect.stringContaining('Workspace') }]);

    const { deps: pathDeps, rejections: pathRejections } = createUpgradeDeps();
    expect(await runUpgrade('/api/workspaces/ws-1/runtime/api/fs/list', pathDeps)).toBe(true);
    expect(pathRejections).toEqual([{ status: 404, message: expect.stringContaining('socket') }]);
  });

  it('surfaces adapter errors as explicit upgrade rejections', async () => {
    const adapter = createAdapterStub(async () => new Response('x', { status: 200 }), {}, {
      openWebSocket: async () => {
        const error = new Error('tunnel is not connected');
        error.code = 'capability_unavailable';
        error.status = 503;
        throw error;
      },
    });
    const { deps, rejections } = createUpgradeDeps({ connectionBroker: createBrokerStub(adapter) });
    expect(await runUpgrade('/api/workspaces/ws-1/runtime/api/event/ws', deps)).toBe(true);
    expect(rejections).toEqual([{ status: 503, message: 'Workspace WebSocket upgrade failed' }]);
  });

  it('passes the server-side credential provider to adapter-owned upgrades', async () => {
    const credentialProvider = { resolveCredential: async () => ({ token: 'private' }) };
    let receivedProvider = null;
    const adapter = createAdapterStub(async () => new Response('x', { status: 200 }), {}, {
      openWebSocket: async (context) => {
        receivedProvider = context.credentialProvider;
        const error = new Error('provider check');
        error.code = 'capability_unavailable';
        error.status = 503;
        throw error;
      },
    });
    const { deps, rejections } = createUpgradeDeps({
      connectionBroker: createBrokerStub(adapter),
      credentialProvider,
    });

    expect(await runUpgrade('/api/workspaces/ws-1/runtime/api/event/ws', deps)).toBe(true);
    expect(receivedProvider).toBe(credentialProvider);
    expect(rejections).toEqual([{ status: 503, message: 'Workspace WebSocket upgrade failed' }]);
  });
});
