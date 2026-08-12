import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registerWorkspaceCatalogRoutes } from './routes.js';
import { createCatalogStore } from './catalog-store.js';
import { createConnectionProfileStore } from './connection-profile-store.js';
import { createConnectionBroker } from './connection-broker.js';
import { createLocalWorkspaceAdapter } from './local-adapter.js';

const fsPromises = fs.promises;

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
      patch(routePath, handler) {
        routes.set(`PATCH ${routePath}`, handler);
      },
      delete(routePath, handler) {
        routes.set(`DELETE ${routePath}`, handler);
      },
    },
    getRoute(method, routePath) {
      return routes.get(`${method} ${routePath}`);
    },
  };
};

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

const createMockRequest = (overrides = {}) => ({
  body: {},
  params: {},
  query: {},
  headers: {},
  get(name) {
    return this.headers[name];
  },
  ...overrides,
});

let tempDir;
let workspaceDir;
let catalogStore;
let profileStore;
let broker;
let app;
let getRoute;
const credentialProvider = {
  resolveCredential: async () => ({ token: 'server-only-token' }),
};

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspaces-routes-test-'));
  workspaceDir = path.join(tempDir, 'workspace');
  fs.mkdirSync(workspaceDir);

  catalogStore = createCatalogStore({
    fs: fsPromises,
    path,
    filePath: path.join(tempDir, 'workspace-catalog.json'),
  });
  profileStore = createConnectionProfileStore({
    fs: fsPromises,
    filePath: path.join(tempDir, 'connection-profiles.json'),
  });
  broker = createConnectionBroker({ profileStore });
  broker.registerAdapter(createLocalWorkspaceAdapter({ fs: fsPromises, path }));

  const registry = createRouteRegistry();
  app = registry.app;
  getRoute = registry.getRoute;
  registerWorkspaceCatalogRoutes(app, {
    catalogStore,
    connectionBroker: broker,
    profileStore,
    credentialProvider,
  });
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const postWorkspace = async (req, res) => getRoute('POST', '/api/workspaces')(req, res);

const createWorkspaceViaApi = async (reqOverrides = {}) => {
  const response = createMockResponse();
  await postWorkspace(createMockRequest({
    body: { connectionId: 'local', path: workspaceDir },
    ...reqOverrides,
  }), response);
  return response;
};

describe('GET /api/workspaces', () => {
  it('returns the snapshot with public connection summaries only', async () => {
    await profileStore.upsertConnection({
      id: 'remote-1',
      label: 'Remote',
      accentColor: '#ABC',
      target: { kind: 'direct', baseUrl: 'https://secret.example.com', credentialRef: 'super-secret-token' },
    });
    await createWorkspaceViaApi();

    const response = createMockResponse();
    await getRoute('GET', '/api/workspaces')({}, response);

    expect(response.statusCode).toBe(200);
    expect(response.body.schemaVersion).toBe(1);
    expect(response.body.workspaces).toHaveLength(1);
    expect(response.body.migration).toEqual({ legacyProjectsImported: false, pendingConnectionIds: [] });
    expect(response.body.connections).toEqual([
      {
        id: 'local',
        label: 'This computer',
        capabilities: { pathBrowse: true, terminal: true, files: true, git: true, eventStream: true },
      },
      {
        id: 'remote-1',
        label: 'Remote',
        accentColor: '#abc',
        capabilities: { pathBrowse: true, terminal: true, files: true, git: true, eventStream: true },
      },
    ]);

    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain('super-secret-token');
    expect(serialized).not.toContain('credentialRef');
    expect(serialized).not.toContain('secret.example.com');
    expect(serialized).not.toContain('target');
  });
});

describe('POST /api/workspaces', () => {
  it('creates a workspace, canonicalizing the path via the adapter', async () => {
    const response = await createWorkspaceViaApi();

    expect(response.statusCode).toBe(201);
    expect(response.body.created).toBe(true);
    expect(response.body.revision).toBe(1);
    expect(response.body.workspace.connectionId).toBe('local');
    expect(response.body.workspace.canonicalPath).toBe(workspaceDir);
    expect(response.body.workspace.path).toBe(workspaceDir);
    expect(response.body.workspace.label).toBe(path.basename(workspaceDir));
  });

  it('returns 200 with the same id for a duplicate location', async () => {
    const first = await createWorkspaceViaApi();
    const second = await createWorkspaceViaApi();

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.body.created).toBe(false);
    expect(second.body.workspace.id).toBe(first.body.workspace.id);
    expect(second.body.revision).toBe(1);
  });

  it('canonicalizes relative and trailing-slash paths', async () => {
    const relative = path.relative(process.cwd(), workspaceDir);
    const response = createMockResponse();
    await postWorkspace(createMockRequest({
      body: { connectionId: 'local', path: `${relative}/` },
    }), response);

    expect(response.statusCode).toBe(201);
    expect(response.body.workspace.canonicalPath).toBe(workspaceDir);
  });

  it('rejects a missing connectionId', async () => {
    const response = createMockResponse();
    await postWorkspace(createMockRequest({ body: { path: workspaceDir } }), response);

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: 'connectionId is required', code: 'catalog_invalid_input' });
  });

  it('rejects a missing path', async () => {
    const response = createMockResponse();
    await postWorkspace(createMockRequest({ body: { connectionId: 'local', path: '' } }), response);

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: 'path is required', code: 'catalog_invalid_input' });
  });

  it('404s an unknown connection', async () => {
    const response = createMockResponse();
    await postWorkspace(createMockRequest({
      body: { connectionId: 'ghost', path: workspaceDir },
    }), response);

    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({ error: 'Unknown connection', code: 'catalog_connection_not_found' });
  });

  it('404s a path that does not exist on the connection', async () => {
    const response = createMockResponse();
    await postWorkspace(createMockRequest({
      body: { connectionId: 'local', path: path.join(tempDir, 'missing') },
    }), response);

    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({ error: 'path does not exist', code: 'catalog_path_not_found' });
  });
});

describe('PATCH /api/workspaces/:workspaceId', () => {
  it('patches label/color/orderKey with a current If-Match revision', async () => {
    const created = await createWorkspaceViaApi();
    const response = createMockResponse();
    await getRoute('PATCH', '/api/workspaces/:workspaceId')(createMockRequest({
      params: { workspaceId: created.body.workspace.id },
      headers: { 'if-match': '1' },
      body: { label: 'Renamed', color: '#ABC', orderKey: '5' },
    }), response);

    expect(response.statusCode).toBe(200);
    expect(response.body.workspace.label).toBe('Renamed');
    expect(response.body.workspace.color).toBe('#abc');
    expect(response.body.workspace.orderKey).toBe('5');
    expect(response.body.revision).toBe(2);
  });

  it('409s on a stale If-Match revision', async () => {
    const created = await createWorkspaceViaApi();
    const response = createMockResponse();
    await getRoute('PATCH', '/api/workspaces/:workspaceId')(createMockRequest({
      params: { workspaceId: created.body.workspace.id },
      headers: { 'if-match': '0' },
      body: { label: 'Renamed' },
    }), response);

    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({
      error: 'catalog revision conflict; re-fetch the snapshot and retry',
      code: 'catalog_revision_conflict',
    });
  });

  it('404s an unknown workspace', async () => {
    const response = createMockResponse();
    await getRoute('PATCH', '/api/workspaces/:workspaceId')(createMockRequest({
      params: { workspaceId: 'ghost-workspace' },
      body: { label: 'X' },
    }), response);

    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({ error: 'workspace not found', code: 'catalog_workspace_not_found' });
  });

  it('rejects an empty label with a validation error', async () => {
    const created = await createWorkspaceViaApi();
    const response = createMockResponse();
    await getRoute('PATCH', '/api/workspaces/:workspaceId')(createMockRequest({
      params: { workspaceId: created.body.workspace.id },
      body: { label: '' },
    }), response);

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: 'label cannot be empty', code: 'catalog_invalid_input' });
  });
});

describe('DELETE /api/workspaces/:workspaceId', () => {
  it('deletes a workspace and 404s the second delete', async () => {
    const created = await createWorkspaceViaApi();
    const first = createMockResponse();
    await getRoute('DELETE', '/api/workspaces/:workspaceId')(createMockRequest({
      params: { workspaceId: created.body.workspace.id },
    }), first);

    expect(first.statusCode).toBe(200);
    expect(first.body.revision).toBe(2);

    const snapshot = createMockResponse();
    await getRoute('GET', '/api/workspaces')({}, snapshot);
    expect(snapshot.body.workspaces).toHaveLength(0);

    const second = createMockResponse();
    await getRoute('DELETE', '/api/workspaces/:workspaceId')(createMockRequest({
      params: { workspaceId: created.body.workspace.id },
    }), second);

    expect(second.statusCode).toBe(404);
    expect(second.body).toEqual({ error: 'workspace not found', code: 'catalog_workspace_not_found' });
  });

  it('409s on a stale If-Match revision', async () => {
    const created = await createWorkspaceViaApi();
    const response = createMockResponse();
    await getRoute('DELETE', '/api/workspaces/:workspaceId')(createMockRequest({
      params: { workspaceId: created.body.workspace.id },
      headers: { 'if-match': '0' },
    }), response);

    expect(response.statusCode).toBe(409);
    expect(response.body.code).toBe('catalog_revision_conflict');
  });

  const registerWithBindingStore = (bindingStore) => {
    const registry = createRouteRegistry();
    registerWorkspaceCatalogRoutes(registry.app, {
      catalogStore,
      connectionBroker: broker,
      profileStore,
      credentialProvider,
      sessionBindingStore: bindingStore,
    });
    return registry.getRoute('DELETE', '/api/workspaces/:workspaceId');
  };

  it('cleans up session bindings for the deleted workspace', async () => {
    const created = await createWorkspaceViaApi();
    const removedFor = [];
    const deleteRoute = registerWithBindingStore({
      removeBindingsForWorkspace: async (workspaceId) => {
        removedFor.push(workspaceId);
        return { removed: 2, revision: 5 };
      },
    });
    const response = createMockResponse();
    await deleteRoute(createMockRequest({
      params: { workspaceId: created.body.workspace.id },
    }), response);

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ revision: 2, bindingsRemoved: 2 });
    expect(removedFor).toEqual([created.body.workspace.id]);
  });

  it('reports a partial failure when binding cleanup fails after the catalog delete', async () => {
    const created = await createWorkspaceViaApi();
    const deleteRoute = registerWithBindingStore({
      removeBindingsForWorkspace: async () => {
        throw new Error('disk full');
      },
    });
    const response = createMockResponse();
    await deleteRoute(createMockRequest({
      params: { workspaceId: created.body.workspace.id },
    }), response);

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      error: 'Workspace deleted but session bindings cleanup failed',
      code: 'binding_cleanup_failed',
    });
  });
});

describe('POST /api/workspaces/:workspaceId/probe', () => {
  it('probes a workspace through its connection adapter', async () => {
    const created = await createWorkspaceViaApi();
    const response = createMockResponse();
    await getRoute('POST', '/api/workspaces/:workspaceId/probe')(createMockRequest({
      params: { workspaceId: created.body.workspace.id },
    }), response);

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      canonicalPath: workspaceDir,
      capabilities: { pathBrowse: true, terminal: true, files: true, git: true, eventStream: true },
    });
  });

  it('404s an unknown workspace', async () => {
    const response = createMockResponse();
    await getRoute('POST', '/api/workspaces/:workspaceId/probe')(createMockRequest({
      params: { workspaceId: 'ghost-workspace' },
    }), response);

    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({ error: 'Workspace not found', code: 'catalog_workspace_not_found' });
  });

  it('404s a workspace on an unregistered connection', async () => {
    const created = await catalogStore.createWorkspace({
      connectionId: 'ghost',
      canonicalPath: workspaceDir,
      path: workspaceDir,
      label: 'Ghost',
    });
    const response = createMockResponse();
    await getRoute('POST', '/api/workspaces/:workspaceId/probe')(createMockRequest({
      params: { workspaceId: created.descriptor.id },
    }), response);

    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({ error: 'Unknown connection', code: 'catalog_connection_not_found' });
  });
});

describe('GET /api/workspaces/:workspaceId/children', () => {
  it('lists children inside the workspace boundary', async () => {
    const subDir = path.join(workspaceDir, 'sub');
    fs.mkdirSync(subDir);
    fs.writeFileSync(path.join(workspaceDir, 'a-file'), '');
    const created = await createWorkspaceViaApi();

    const response = createMockResponse();
    await getRoute('GET', '/api/workspaces/:workspaceId/children')(createMockRequest({
      params: { workspaceId: created.body.workspace.id },
      query: { path: workspaceDir },
    }), response);

    expect(response.statusCode).toBe(200);
    expect(response.body.directory).toBe(workspaceDir);
    expect(response.body.children.map((child) => child.name)).toEqual(['sub', 'a-file']);
  });

  it('defaults to the workspace root when no path is given', async () => {
    const created = await createWorkspaceViaApi();
    const response = createMockResponse();
    await getRoute('GET', '/api/workspaces/:workspaceId/children')(createMockRequest({
      params: { workspaceId: created.body.workspace.id },
    }), response);

    expect(response.statusCode).toBe(200);
    expect(response.body.directory).toBe(workspaceDir);
  });

  it('403s a path outside the workspace boundary', async () => {
    const created = await createWorkspaceViaApi();
    for (const outside of [tempDir, path.join(tempDir, 'sibling')]) {
      const response = createMockResponse();
      await getRoute('GET', '/api/workspaces/:workspaceId/children')(createMockRequest({
        params: { workspaceId: created.body.workspace.id },
        query: { path: outside },
      }), response);

      expect(response.statusCode).toBe(403);
      expect(response.body).toEqual({ error: 'Path is outside the workspace', code: 'catalog_path_outside_workspace' });
    }
  });

  it('403s parent-traversal paths instead of listing them', async () => {
    const created = await createWorkspaceViaApi();
    for (const traversal of [
      path.join(workspaceDir, '..', 'secret'),
      `${workspaceDir}/../secret`,
      `${workspaceDir}%2F..%2Fsecret`,
    ]) {
      const response = createMockResponse();
      await getRoute('GET', '/api/workspaces/:workspaceId/children')(createMockRequest({
        params: { workspaceId: created.body.workspace.id },
        query: { path: traversal },
      }), response);

      expect(response.statusCode).toBe(403);
      expect(response.body).toEqual({ error: 'Path is outside the workspace', code: 'catalog_path_outside_workspace' });
    }
  });

  it('404s an unknown workspace', async () => {
    const response = createMockResponse();
    await getRoute('GET', '/api/workspaces/:workspaceId/children')(createMockRequest({
      params: { workspaceId: 'ghost-workspace' },
    }), response);

    expect(response.statusCode).toBe(404);
    expect(response.body.code).toBe('catalog_workspace_not_found');
  });
});

describe('direct workspace route context', () => {
  it('passes the saved profile, credential provider and workspace path to direct adapters', async () => {
    const calls = [];
    const adapter = {
      kind: 'direct',
      connectionId: 'direct-1',
      capabilities: { pathBrowse: true, terminal: true, files: true, git: true, eventStream: true },
      canonicalizePath: async (_context, inputPath) => inputPath.trim().replace(/\/+$/, ''),
      probe: async (context, inputPath) => {
        calls.push({ type: 'probe', context, inputPath });
        return {
          ok: true,
          canonicalPath: inputPath,
          capabilities: adapter.capabilities,
        };
      },
      listChildren: async (context, directory) => {
        calls.push({ type: 'children', context, directory });
        return { directory, children: [] };
      },
      fetch: async () => new Response('{}', { status: 200 }),
      openEventStream: async () => new Response(''),
      openWebSocket: async () => ({ url: 'wss://example.com/api/event/ws' }),
      dispose: async () => {},
    };
    await profileStore.upsertConnection({
      id: 'direct-1',
      label: 'Remote',
      target: { kind: 'direct', baseUrl: 'https://api.example.com' },
    });
    broker.registerAdapter(adapter);

    const created = createMockResponse();
    await postWorkspace(createMockRequest({
      body: { connectionId: 'direct-1', path: '/remote/project/' },
    }), created);
    expect(created.statusCode).toBe(201);
    expect(calls[0].context.profile.target.baseUrl).toBe('https://api.example.com');
    expect(calls[0].context.credentialProvider).toBe(credentialProvider);

    const children = createMockResponse();
    await getRoute('GET', '/api/workspaces/:workspaceId/children')(createMockRequest({
      params: { workspaceId: created.body.workspace.id },
      query: { path: '/remote/project' },
    }), children);
    expect(children.statusCode).toBe(200);
    expect(calls[1].context.profile.target.baseUrl).toBe('https://api.example.com');
    expect(calls[1].context.canonicalPath).toBe('/remote/project');
    expect(calls[1].context.credentialProvider).toBe(credentialProvider);
  });
});

describe('GET /api/connections', () => {
  it('returns connection summaries only, never private records', async () => {
    await profileStore.upsertConnection({
      id: 'remote-1',
      label: 'Remote',
      target: { kind: 'direct', baseUrl: 'https://secret.example.com', credentialRef: 'super-secret-token' },
    });

    const response = createMockResponse();
    await getRoute('GET', '/api/connections')({}, response);

    expect(response.statusCode).toBe(200);
    expect(response.body.connections).toEqual([
      {
        id: 'local',
        label: 'This computer',
        capabilities: { pathBrowse: true, terminal: true, files: true, git: true, eventStream: true },
      },
      {
        id: 'remote-1',
        label: 'Remote',
        capabilities: { pathBrowse: true, terminal: true, files: true, git: true, eventStream: true },
      },
    ]);
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain('super-secret-token');
    expect(serialized).not.toContain('credentialRef');
    expect(serialized).not.toContain('secret.example.com');
  });
});

describe('POST /api/connections/:connectionId/probe', () => {
  it('probes a connection with a null path', async () => {
    const response = createMockResponse();
    await getRoute('POST', '/api/connections/:connectionId/probe')(createMockRequest({
      params: { connectionId: 'local' },
    }), response);

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      ok: false,
      canonicalPath: null,
      error: { code: 'catalog_invalid_path', message: 'path is required' },
    });
  });

  it('404s an unknown connection', async () => {
    const response = createMockResponse();
    await getRoute('POST', '/api/connections/:connectionId/probe')(createMockRequest({
      params: { connectionId: 'ghost' },
    }), response);

    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({ error: 'Unknown connection', code: 'catalog_connection_not_found' });
  });
});

describe('workspaceCatalogV1 disabled state (plan §20)', () => {
  const registerDisabledRoutes = () => {
    const registry = createRouteRegistry();
    registerWorkspaceCatalogRoutes(registry.app, {
      catalogStore,
      connectionBroker: broker,
      profileStore,
      credentialProvider,
      workspaceCatalogV1: false,
    });
    return registry;
  };

  it('reports the capability as enabled by default and disabled when the flag is off', async () => {
    const enabledResponse = createMockResponse();
    await getRoute('GET', '/api/workspaces/capabilities')(createMockRequest(), enabledResponse);
    expect(enabledResponse.statusCode).toBe(200);
    expect(enabledResponse.body).toEqual({ workspaceCatalogV1: true });

    const disabledRegistry = registerDisabledRoutes();
    const disabledResponse = createMockResponse();
    await disabledRegistry.getRoute('GET', '/api/workspaces/capabilities')(createMockRequest(), disabledResponse);
    expect(disabledResponse.statusCode).toBe(200);
    expect(disabledResponse.body).toEqual({ workspaceCatalogV1: false });
  });

  it('rejects every catalog/connection mutation with 501 capability_unavailable', async () => {
    const created = await catalogStore.createWorkspace({
      connectionId: 'local',
      canonicalPath: workspaceDir,
      path: workspaceDir,
      label: 'WS',
    });
    await profileStore.upsertConnection({
      id: 'direct-1',
      label: 'Direct',
      target: { kind: 'direct', baseUrl: 'https://api.example.com' },
    });

    const registry = registerDisabledRoutes();
    const cases = [
      ['POST', '/api/workspaces', { body: { connectionId: 'local', path: '/new' } }],
      ['PATCH', '/api/workspaces/:workspaceId', { params: { workspaceId: created.descriptor.id }, body: { label: 'Renamed' } }],
      ['DELETE', '/api/workspaces/:workspaceId', { params: { workspaceId: created.descriptor.id } }],
      ['POST', '/api/connections', { body: { label: 'Remote', baseUrl: 'https://remote.example.com' } }],
      ['PATCH', '/api/connections/:connectionId', { params: { connectionId: 'direct-1' }, body: { label: 'Renamed' } }],
      ['DELETE', '/api/connections/:connectionId', { params: { connectionId: 'direct-1' } }],
    ];
    for (const [method, routePath, overrides] of cases) {
      const response = createMockResponse();
      await registry.getRoute(method, routePath)(createMockRequest(overrides), response);
      expect(response.statusCode).toBe(501);
      expect(response.body).toEqual({
        error: 'The workspace catalog is disabled on this server',
        code: 'capability_unavailable',
      });
    }
  });

  it('never rewrites the catalog file and never mutates stored data while disabled', async () => {
    const created = await catalogStore.createWorkspace({
      connectionId: 'local',
      canonicalPath: workspaceDir,
      path: workspaceDir,
      label: 'WS',
    });
    await catalogStore.createWorkspace({
      connectionId: 'local',
      canonicalPath: '/other',
      path: '/other',
      label: 'Other',
    });
    await profileStore.upsertConnection({
      id: 'direct-1',
      label: 'Direct',
      target: { kind: 'direct', baseUrl: 'https://api.example.com' },
    });
    const filePath = path.join(tempDir, 'workspace-catalog.json');
    const beforeBytes = fs.readFileSync(filePath, 'utf8');

    const registry = registerDisabledRoutes();
    for (const [method, routePath, overrides] of [
      ['POST', '/api/workspaces', { body: { connectionId: 'local', path: '/new' } }],
      ['PATCH', '/api/workspaces/:workspaceId', { params: { workspaceId: created.descriptor.id }, body: { label: 'Renamed' } }],
      ['DELETE', '/api/workspaces/:workspaceId', { params: { workspaceId: created.descriptor.id } }],
      ['POST', '/api/connections', { body: { label: 'Remote', baseUrl: 'https://remote.example.com' } }],
      ['PATCH', '/api/connections/:connectionId', { params: { connectionId: 'direct-1' }, body: { label: 'Renamed' } }],
      ['DELETE', '/api/connections/:connectionId', { params: { connectionId: 'direct-1' } }],
    ]) {
      const response = createMockResponse();
      await registry.getRoute(method, routePath)(createMockRequest(overrides), response);
      expect(response.statusCode).toBe(501);
    }

    expect(fs.readFileSync(filePath, 'utf8')).toBe(beforeBytes);
    const snapshot = await catalogStore.getSnapshot();
    expect(snapshot.workspaces.map((entry) => entry.label)).toEqual(['WS', 'Other']);
    expect(snapshot.revision).toBe(2);
  });

  it('keeps reads available while disabled: snapshot, single workspace and browse', async () => {
    await catalogStore.createWorkspace({
      connectionId: 'local',
      canonicalPath: workspaceDir,
      path: workspaceDir,
      label: 'WS',
    });
    const registry = registerDisabledRoutes();

    const snapshotResponse = createMockResponse();
    await registry.getRoute('GET', '/api/workspaces')(createMockRequest(), snapshotResponse);
    expect(snapshotResponse.statusCode).toBe(200);
    expect(snapshotResponse.body.workspaces).toHaveLength(1);

    const singleResponse = createMockResponse();
    await registry.getRoute('GET', '/api/workspaces/:workspaceId')(createMockRequest({
      params: { workspaceId: snapshotResponse.body.workspaces[0].id },
    }), singleResponse);
    expect(singleResponse.statusCode).toBe(200);
    expect(singleResponse.body.workspace.label).toBe('WS');
  });
});
