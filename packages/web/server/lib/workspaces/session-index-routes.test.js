import { describe, expect, it } from 'vitest';

import { registerSessionIndexRoutes } from './session-index-routes.js';

const createRouteRegistry = () => {
  const routes = new Map();
  return {
    app: {
      get(routePath, handler) {
        routes.set(`GET ${routePath}`, handler);
      },
      post(routePath, handler) {
        routes.set(`POST ${routePath}`, handler);
      },
    },
    getRoute(method, routePath) {
      return routes.get(`${method} ${routePath}`);
    },
  };
};

const createMockRequest = (overrides = {}) => ({
  params: {},
  body: {},
  handlers: {},
  on(event, listener) {
    this.handlers[event] = listener;
    return this;
  },
  emit(event) {
    this.handlers[event]?.();
  },
  ...overrides,
});

const createMockResponse = () => {
  let statusCode = 200;
  let body = null;
  return {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
  };
};

const createEventStreamResponse = () => {
  const writes = [];
  const handlers = {};
  return {
    writes,
    head: null,
    writeHead(status, headers) {
      this.head = { status, headers };
      return this;
    },
    write(chunk) {
      writes.push(chunk);
      return true;
    },
    on(event, listener) {
      handlers[event] = listener;
      return this;
    },
    emit(event) {
      handlers[event]?.();
    },
  };
};

const createApp = () => {
  const registry = createRouteRegistry();
  const calls = {
    fetch: [],
    bindSession: [],
    createBinding: [],
    refreshConnection: [],
    resolveConnection: [],
    acquireLease: [],
    subscribe: [],
    releases: 0,
  };

  const workspace = {
    id: 'ws-1',
    connectionId: 'local',
    canonicalPath: '/projects/proj',
    path: '/projects/proj',
    label: 'Proj',
    color: null,
    orderKey: '',
    createdAt: 1,
    updatedAt: 1,
  };

  const catalogStore = {
    getWorkspace: async (workspaceId) => (workspaceId === workspace.id ? { ...workspace } : null),
  };

  const adapter = {
    capabilities: { pathBrowse: true, terminal: true, files: true, git: true, eventStream: true },
    async fetch(context, request, restPath) {
      calls.fetch.push({ context, request, restPath });
      return new Response(JSON.stringify({ id: 'ses-new' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  };

  const sessionIndex = {
    getSnapshot: async () => ({ revision: 3, sessions: [], freshnessByConnection: {} }),
    subscribeEvents: (listener) => {
      calls.subscribe.push(listener);
      return () => { calls.unsubscribe = (calls.unsubscribe ?? 0) + 1; };
    },
    refreshConnection: async (connectionId, options) => {
      calls.refreshConnection.push({ connectionId, options });
    },
  };

  const bindingStore = {
    createBindingForNewSession: async (input) => {
      calls.createBinding.push(input);
      return { binding: { ...input }, created: true, changed: true, revision: 1 };
    },
    bindSession: async (input) => {
      calls.bindSession.push(input);
      return {
        binding: { ...input },
        created: false,
        moved: true,
        changed: true,
        revision: 2,
      };
    },
  };

  const connectionBroker = {
    resolveConnection: async (connectionId) => {
      calls.resolveConnection.push(connectionId);
      return { profile: { id: connectionId }, adapter };
    },
    acquireLease: (connectionId) => {
      calls.acquireLease.push(connectionId);
      return () => { calls.releases += 1; };
    },
  };

  registerSessionIndexRoutes(registry.app, {
    catalogStore,
    connectionBroker,
    sessionIndex,
    bindingStore,
    credentialProvider: null,
  });

  return { registry, calls, adapter, sessionIndex, bindingStore, catalogStore, workspace };
};

describe('GET /api/workspace-sessions/snapshot', () => {
  it('returns the session index snapshot', async () => {
    const { registry } = createApp();
    const res = createMockResponse();

    await registry.getRoute('GET', '/api/workspace-sessions/snapshot')(createMockRequest(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ revision: 3, sessions: [], freshnessByConnection: {} });
  });
});

describe('POST /api/workspaces/:workspaceId/sessions', () => {
  it('creates a session through the connection adapter and records a created-in-workspace binding', async () => {
    const { registry, calls, workspace } = createApp();
    const res = createMockResponse();

    await registry.getRoute('POST', '/api/workspaces/:workspaceId/sessions')(createMockRequest({
      params: { workspaceId: workspace.id },
      body: { prompt: 'hello' },
    }), res);

    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ sessionId: 'ses-new', workspaceId: workspace.id });

    expect(calls.resolveConnection).toEqual(['local']);
    expect(calls.acquireLease).toEqual(['local']);
    expect(calls.releases).toBe(1);
    expect(calls.fetch).toHaveLength(1);
    expect(calls.fetch[0].restPath).toBe('/api/session');
    expect(calls.fetch[0].request.method).toBe('POST');
    expect(calls.fetch[0].context.canonicalPath).toBe('/projects/proj');
    expect(calls.fetch[0].request.headers.get('x-opencode-directory')).toBe('/projects/proj');
    expect(JSON.parse(calls.fetch[0].request.body)).toEqual({ prompt: 'hello' });

    expect(calls.createBinding).toEqual([{
      connectionId: 'local',
      upstreamSessionId: 'ses-new',
      workspaceId: workspace.id,
      observedDirectory: '/projects/proj',
    }]);
    expect(calls.refreshConnection).toEqual([{ connectionId: 'local', options: { background: true } }]);
  });

  it('404s an unknown workspace', async () => {
    const { registry } = createApp();
    const res = createMockResponse();

    await registry.getRoute('POST', '/api/workspaces/:workspaceId/sessions')(createMockRequest({
      params: { workspaceId: 'ghost-workspace' },
      body: { prompt: 'hi' },
    }), res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Workspace not found', code: 'catalog_workspace_not_found' });
  });

  it('502s when the upstream session creation fails', async () => {
    const { registry, calls, adapter, workspace } = createApp();
    adapter.fetch = async () => new Response('upstream exploded', { status: 502 });
    const res = createMockResponse();

    await registry.getRoute('POST', '/api/workspaces/:workspaceId/sessions')(createMockRequest({
      params: { workspaceId: workspace.id },
      body: { prompt: 'hi' },
    }), res);

    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({
      error: 'Session creation failed (502)',
      code: 'session_index_create_failed',
    });
    expect(calls.createBinding).toHaveLength(0);
  });
});

describe('POST /api/workspaces/:workspaceId/sessions/:sessionId/bind', () => {
  it('binds explicitly with allowMove and a directory override', async () => {
    const { registry, calls, workspace } = createApp();
    const res = createMockResponse();

    await registry.getRoute('POST', '/api/workspaces/:workspaceId/sessions/:sessionId/bind')(createMockRequest({
      params: { workspaceId: workspace.id, sessionId: 'ses-1' },
      body: { directory: '/custom/path' },
    }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ bound: true, workspaceId: workspace.id, upstreamSessionId: 'ses-1' });
    expect(calls.bindSession).toEqual([{
      connectionId: 'local',
      upstreamSessionId: 'ses-1',
      workspaceId: workspace.id,
      observedDirectory: '/custom/path',
      source: 'explicit',
      allowMove: true,
    }]);
    expect(calls.refreshConnection).toEqual([{ connectionId: 'local', options: { background: true } }]);
  });

  it('defaults the observed directory to the workspace canonical path', async () => {
    const { registry, calls, workspace } = createApp();
    const res = createMockResponse();

    await registry.getRoute('POST', '/api/workspaces/:workspaceId/sessions/:sessionId/bind')(createMockRequest({
      params: { workspaceId: workspace.id, sessionId: 'ses-1' },
      body: {},
    }), res);

    expect(res.statusCode).toBe(200);
    expect(calls.bindSession[0].observedDirectory).toBe('/projects/proj');
  });

  it('404s an unknown workspace', async () => {
    const { registry } = createApp();
    const res = createMockResponse();

    await registry.getRoute('POST', '/api/workspaces/:workspaceId/sessions/:sessionId/bind')(createMockRequest({
      params: { workspaceId: 'ghost-workspace', sessionId: 'ses-1' },
      body: {},
    }), res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Workspace not found', code: 'catalog_workspace_not_found' });
  });

  it('propagates a binding conflict with its status and code', async () => {
    const { registry, bindingStore, workspace } = createApp();
    bindingStore.bindSession = async () => {
      const error = new Error('session binding already points at a different workspace; retry with an explicit move');
      error.code = 'binding_conflict';
      error.status = 409;
      throw error;
    };
    const res = createMockResponse();

    await registry.getRoute('POST', '/api/workspaces/:workspaceId/sessions/:sessionId/bind')(createMockRequest({
      params: { workspaceId: workspace.id, sessionId: 'ses-1' },
      body: {},
    }), res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      error: 'session binding already points at a different workspace; retry with an explicit move',
      code: 'binding_conflict',
    });
  });
});

describe('GET /api/workspace-sessions/events', () => {
  it('streams SSE events to the client and unsubscribes on close', async () => {
    const { registry, calls } = createApp();
    const req = createMockRequest();
    const res = createEventStreamResponse();

    await registry.getRoute('GET', '/api/workspace-sessions/events')(req, res);

    expect(res.head.status).toBe(200);
    expect(res.head.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(res.writes[0]).toBe('retry: 3000\n\n');
    expect(calls.subscribe).toHaveLength(1);

    const event = { type: 'session.upserted', revision: 3, sessionId: 'ses-1', payload: { activity: 'busy' } };
    calls.subscribe[0](event);
    expect(res.writes[1]).toBe(`data: ${JSON.stringify(event)}\n\n`);

    req.emit('close');
    expect(calls.unsubscribe).toBe(1);
  });
});
