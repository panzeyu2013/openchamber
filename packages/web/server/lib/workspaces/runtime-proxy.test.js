import { describe, expect, it } from 'vitest';
import { Readable } from 'stream';
import { parseWorkspaceRuntimePath, registerWorkspaceRuntimeProxyRoutes } from './runtime-proxy.js';

const createCatalogStoreStub = (workspaces) => ({
  getWorkspace: async (workspaceId) => workspaces.find((workspace) => workspace.id === workspaceId) ?? null,
});

const createAdapterStub = (fetchImpl, capabilities = { eventStream: true }) => ({
  connectionId: 'local',
  capabilities: { pathBrowse: true, terminal: true, files: true, git: true, eventStream: true, ...capabilities },
  fetch: fetchImpl,
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

const createRequest = ({ path, method = 'GET', headers = {}, body = null }) => ({
  originalUrl: path,
  method,
  path,
  headers,
  get: (name) => headers[name] ?? undefined,
  body,
});

const createResponse = () => {
  let statusCode = 200;
  const chunks = [];
  const headers = new Map();
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

describe('workspace runtime proxy', () => {
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
});
