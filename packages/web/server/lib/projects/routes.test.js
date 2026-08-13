import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerProjectCatalogRoutes } from './routes.js';
import { createCatalogStore } from './catalog-store.js';
import { createConnectionProfileStore } from './connection-profile-store.js';
import { createConnectionBroker } from './connection-broker.js';
import { createLocalProjectAdapter } from './local-adapter.js';

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
let projectDir;
let catalogStore;
let profileStore;
let broker;
let app;
let getRoute;
const credentialProvider = {
  resolveCredential: async () => ({ token: 'server-only-token' }),
};

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-routes-test-'));
  projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir);

  catalogStore = createCatalogStore({
    fs: fsPromises,
    path,
    filePath: path.join(tempDir, 'project-catalog.json'),
  });
  profileStore = createConnectionProfileStore({
    fs: fsPromises,
    filePath: path.join(tempDir, 'connection-profiles.json'),
  });
  broker = createConnectionBroker({ profileStore });
  broker.registerAdapter(createLocalProjectAdapter({ fs: fsPromises, path }));

  const registry = createRouteRegistry();
  app = registry.app;
  getRoute = registry.getRoute;
  registerProjectCatalogRoutes(app, {
    catalogStore,
    connectionBroker: broker,
    profileStore,
    credentialProvider,
  });
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const postProject = async (req, res) => getRoute('POST', '/api/projects')(req, res);

const createProjectViaApi = async (reqOverrides = {}) => {
  const response = createMockResponse();
  await postProject(createMockRequest({
    body: { connectionId: 'local', path: projectDir },
    ...reqOverrides,
  }), response);
  return response;
};

describe('GET /api/projects', () => {
  it('returns the snapshot with public connection summaries only', async () => {
    await profileStore.upsertConnection({
      id: 'remote-1',
      label: 'Remote',
      accentColor: '#ABC',
      target: { kind: 'direct', baseUrl: 'https://secret.example.com', credentialRef: 'super-secret-token' },
    });
    await createProjectViaApi();

    const response = createMockResponse();
    await getRoute('GET', '/api/projects')({}, response);

    expect(response.statusCode).toBe(200);
    expect(response.body.schemaVersion).toBe(2);
    expect(response.body.projects).toHaveLength(1);
    expect(response.body.migration).toEqual({ legacyProjectsImported: false, pendingConnectionIds: [] });
    expect(response.body.connections).toEqual([
      {
        id: 'local',
        label: 'This computer',
        kind: 'local',
        capabilities: { pathBrowse: true, terminal: true, files: true, git: true, eventStream: true },
      },
      {
        id: 'remote-1',
        label: 'Remote',
        accentColor: '#abc',
        kind: 'direct',
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

describe('POST /api/projects', () => {
  it('creates a project, canonicalizing the path via the adapter', async () => {
    const response = await createProjectViaApi();

    expect(response.statusCode).toBe(201);
    expect(response.body.created).toBe(true);
    expect(response.body.revision).toBe(1);
    expect(response.body.project.connectionId).toBe('local');
    expect(response.body.project.canonicalPath).toBe(projectDir);
    expect(response.body.project.path).toBe(projectDir);
    expect(response.body.project.label).toBe(path.basename(projectDir));
  });

  it('returns 200 with the same id for a duplicate location', async () => {
    const first = await createProjectViaApi();
    const second = await createProjectViaApi();

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.body.created).toBe(false);
    expect(second.body.project.id).toBe(first.body.project.id);
    expect(second.body.revision).toBe(1);
  });

  it('canonicalizes relative and trailing-slash paths', async () => {
    const relative = path.relative(process.cwd(), projectDir);
    const response = createMockResponse();
    await postProject(createMockRequest({
      body: { connectionId: 'local', path: `${relative}/` },
    }), response);

    expect(response.statusCode).toBe(201);
    expect(response.body.project.canonicalPath).toBe(projectDir);
  });

  it('rejects a missing connectionId', async () => {
    const response = createMockResponse();
    await postProject(createMockRequest({ body: { path: projectDir } }), response);

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: 'connectionId is required', code: 'catalog_invalid_input' });
  });

  it('rejects a missing path', async () => {
    const response = createMockResponse();
    await postProject(createMockRequest({ body: { connectionId: 'local', path: '' } }), response);

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: 'path is required', code: 'catalog_invalid_input' });
  });

  it('404s an unknown connection', async () => {
    const response = createMockResponse();
    await postProject(createMockRequest({
      body: { connectionId: 'ghost', path: projectDir },
    }), response);

    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({ error: 'Unknown connection', code: 'catalog_connection_not_found' });
  });

  it('404s a path that does not exist on the connection', async () => {
    const response = createMockResponse();
    await postProject(createMockRequest({
      body: { connectionId: 'local', path: path.join(tempDir, 'missing') },
    }), response);

    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({ error: 'path does not exist', code: 'catalog_path_not_found' });
  });
});

describe('PATCH /api/projects/:projectId', () => {
  it('patches label/color/orderKey with a current If-Match revision', async () => {
    const created = await createProjectViaApi();
    const response = createMockResponse();
    await getRoute('PATCH', '/api/projects/:projectId')(createMockRequest({
      params: { projectId: created.body.project.id },
      headers: { 'if-match': '1' },
      body: { label: 'Renamed', color: '#ABC', orderKey: '5' },
    }), response);

    expect(response.statusCode).toBe(200);
    expect(response.body.project.label).toBe('Renamed');
    expect(response.body.project.color).toBe('#abc');
    expect(response.body.project.orderKey).toBe('5');
    expect(response.body.revision).toBe(2);
  });

  it('409s on a stale If-Match revision', async () => {
    const created = await createProjectViaApi();
    const response = createMockResponse();
    await getRoute('PATCH', '/api/projects/:projectId')(createMockRequest({
      params: { projectId: created.body.project.id },
      headers: { 'if-match': '0' },
      body: { label: 'Renamed' },
    }), response);

    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({
      error: 'catalog revision conflict; re-fetch the snapshot and retry',
      code: 'catalog_revision_conflict',
    });
  });

  it('404s an unknown project', async () => {
    const response = createMockResponse();
    await getRoute('PATCH', '/api/projects/:projectId')(createMockRequest({
      params: { projectId: 'ghost-project' },
      body: { label: 'X' },
    }), response);

    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({ error: 'project not found', code: 'catalog_project_not_found' });
  });

  it('rejects an empty label with a validation error', async () => {
    const created = await createProjectViaApi();
    const response = createMockResponse();
    await getRoute('PATCH', '/api/projects/:projectId')(createMockRequest({
      params: { projectId: created.body.project.id },
      body: { label: '' },
    }), response);

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: 'label cannot be empty', code: 'catalog_invalid_input' });
  });
});

describe('DELETE /api/projects/:projectId', () => {
  it('deletes a project and 404s the second delete', async () => {
    const created = await createProjectViaApi();
    const first = createMockResponse();
    await getRoute('DELETE', '/api/projects/:projectId')(createMockRequest({
      params: { projectId: created.body.project.id },
    }), first);

    expect(first.statusCode).toBe(200);
    expect(first.body.revision).toBe(2);

    const snapshot = createMockResponse();
    await getRoute('GET', '/api/projects')({}, snapshot);
    expect(snapshot.body.projects).toHaveLength(0);

    const second = createMockResponse();
    await getRoute('DELETE', '/api/projects/:projectId')(createMockRequest({
      params: { projectId: created.body.project.id },
    }), second);

    expect(second.statusCode).toBe(404);
    expect(second.body).toEqual({ error: 'project not found', code: 'catalog_project_not_found' });
  });

  it('409s on a stale If-Match revision', async () => {
    const created = await createProjectViaApi();
    const response = createMockResponse();
    await getRoute('DELETE', '/api/projects/:projectId')(createMockRequest({
      params: { projectId: created.body.project.id },
      headers: { 'if-match': '0' },
    }), response);

    expect(response.statusCode).toBe(409);
    expect(response.body.code).toBe('catalog_revision_conflict');
  });

  const registerWithBindingStore = (bindingStore) => {
    const registry = createRouteRegistry();
    registerProjectCatalogRoutes(registry.app, {
      catalogStore,
      connectionBroker: broker,
      profileStore,
      credentialProvider,
      sessionBindingStore: bindingStore,
    });
    return registry.getRoute('DELETE', '/api/projects/:projectId');
  };

  it('cleans up session bindings for the deleted project', async () => {
    const created = await createProjectViaApi();
    const removedFor = [];
    const deleteRoute = registerWithBindingStore({
      removeBindingsForProject: async (projectId) => {
        removedFor.push(projectId);
        return { removed: 2, revision: 5 };
      },
    });
    const response = createMockResponse();
    await deleteRoute(createMockRequest({
      params: { projectId: created.body.project.id },
    }), response);

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ revision: 2, bindingsRemoved: 2 });
    expect(removedFor).toEqual([created.body.project.id]);
  });

  it('reports a partial failure when binding cleanup fails after the catalog delete', async () => {
    const created = await createProjectViaApi();
    const deleteRoute = registerWithBindingStore({
      removeBindingsForProject: async () => {
        throw new Error('disk full');
      },
    });
    const response = createMockResponse();
    await deleteRoute(createMockRequest({
      params: { projectId: created.body.project.id },
    }), response);

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      error: 'Project deleted but session bindings cleanup failed',
      code: 'binding_cleanup_failed',
    });
  });
});

describe('POST /api/projects/:projectId/probe', () => {
  it('probes a project through its connection adapter', async () => {
    const created = await createProjectViaApi();
    const response = createMockResponse();
    await getRoute('POST', '/api/projects/:projectId/probe')(createMockRequest({
      params: { projectId: created.body.project.id },
    }), response);

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      canonicalPath: projectDir,
      capabilities: { pathBrowse: true, terminal: true, files: true, git: true, eventStream: true },
    });
  });

  it('404s an unknown project', async () => {
    const response = createMockResponse();
    await getRoute('POST', '/api/projects/:projectId/probe')(createMockRequest({
      params: { projectId: 'ghost-project' },
    }), response);

    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({ error: 'Project not found', code: 'catalog_project_not_found' });
  });

  it('404s a project on an unregistered connection', async () => {
    const created = await catalogStore.createProject({
      connectionId: 'ghost',
      canonicalPath: projectDir,
      path: projectDir,
      label: 'Ghost',
    });
    const response = createMockResponse();
    await getRoute('POST', '/api/projects/:projectId/probe')(createMockRequest({
      params: { projectId: created.descriptor.id },
    }), response);

    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({ error: 'Unknown connection', code: 'catalog_connection_not_found' });
  });
});

describe('GET /api/projects/:projectId/children', () => {
  it('lists children inside the project boundary', async () => {
    const subDir = path.join(projectDir, 'sub');
    fs.mkdirSync(subDir);
    fs.writeFileSync(path.join(projectDir, 'a-file'), '');
    const created = await createProjectViaApi();

    const response = createMockResponse();
    await getRoute('GET', '/api/projects/:projectId/children')(createMockRequest({
      params: { projectId: created.body.project.id },
      query: { path: projectDir },
    }), response);

    expect(response.statusCode).toBe(200);
    expect(response.body.directory).toBe(projectDir);
    expect(response.body.children.map((child) => child.name)).toEqual(['sub', 'a-file']);
  });

  it('defaults to the project root when no path is given', async () => {
    const created = await createProjectViaApi();
    const response = createMockResponse();
    await getRoute('GET', '/api/projects/:projectId/children')(createMockRequest({
      params: { projectId: created.body.project.id },
    }), response);

    expect(response.statusCode).toBe(200);
    expect(response.body.directory).toBe(projectDir);
  });

  it('403s a path outside the project boundary', async () => {
    const created = await createProjectViaApi();
    for (const outside of [tempDir, path.join(tempDir, 'sibling')]) {
      const response = createMockResponse();
      await getRoute('GET', '/api/projects/:projectId/children')(createMockRequest({
        params: { projectId: created.body.project.id },
        query: { path: outside },
      }), response);

      expect(response.statusCode).toBe(403);
      expect(response.body).toEqual({ error: 'Path is outside the project', code: 'catalog_path_outside_project' });
    }
  });

  it('403s parent-traversal paths instead of listing them', async () => {
    const created = await createProjectViaApi();
    for (const traversal of [
      path.join(projectDir, '..', 'secret'),
      `${projectDir}/../secret`,
      `${projectDir}%2F..%2Fsecret`,
    ]) {
      const response = createMockResponse();
      await getRoute('GET', '/api/projects/:projectId/children')(createMockRequest({
        params: { projectId: created.body.project.id },
        query: { path: traversal },
      }), response);

      expect(response.statusCode).toBe(403);
      expect(response.body).toEqual({ error: 'Path is outside the project', code: 'catalog_path_outside_project' });
    }
  });

  it('404s an unknown project', async () => {
    const response = createMockResponse();
    await getRoute('GET', '/api/projects/:projectId/children')(createMockRequest({
      params: { projectId: 'ghost-project' },
    }), response);

    expect(response.statusCode).toBe(404);
    expect(response.body.code).toBe('catalog_project_not_found');
  });
});

describe('direct project route context', () => {
  it('passes the saved profile, credential provider and project path to direct adapters', async () => {
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
    await postProject(createMockRequest({
      body: { connectionId: 'direct-1', path: '/remote/project/' },
    }), created);
    expect(created.statusCode).toBe(201);
    expect(calls[0].context.profile.target.baseUrl).toBe('https://api.example.com');
    expect(calls[0].context.credentialProvider).toBe(credentialProvider);

    const children = createMockResponse();
    await getRoute('GET', '/api/projects/:projectId/children')(createMockRequest({
      params: { projectId: created.body.project.id },
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
        kind: 'local',
        capabilities: { pathBrowse: true, terminal: true, files: true, git: true, eventStream: true },
      },
      {
        id: 'remote-1',
        label: 'Remote',
        kind: 'direct',
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

describe('connection probe tracking (lastProbeOkAt)', () => {
  const fullCapabilities = { pathBrowse: true, terminal: true, files: true, git: true, eventStream: true };

  const createDirectAdapter = (connectionId, { ok = true } = {}) => ({
    kind: 'direct',
    connectionId,
    capabilities: fullCapabilities,
    canonicalizePath: async (_context, inputPath) => inputPath.trim().replace(/\/+$/, ''),
    probe: async () => (ok
      ? { ok: true, canonicalPath: null, capabilities: fullCapabilities }
      : { ok: false, canonicalPath: null, error: { code: 'direct_unreachable', message: 'Upstream server is unreachable' } }),
    listChildren: async () => ({ directory: '/', children: [] }),
    fetch: async () => new Response('{}', { status: 200 }),
    openEventStream: async () => new Response(''),
    openWebSocket: async () => ({ url: 'wss://example.com/api/event/ws' }),
    dispose: async () => {},
  });

  /** Mirrors production `syncProfileAdapters`: registers a direct adapter for
   * every direct profile, using the server-generated connection id. */
  const registerProfileAdapter = async () => {
    const records = await profileStore.listPrivateRecords();
    const direct = records.find((record) => record.target?.kind === 'direct');
    if (direct && !broker.hasAdapter(direct.id)) {
      broker.registerAdapter(createDirectAdapter(direct.id));
    }
  };

  const registerWithValidator = (overrides = {}) => {
    const registry = createRouteRegistry();
    registerProjectCatalogRoutes(registry.app, {
      catalogStore,
      connectionBroker: broker,
      profileStore,
      credentialProvider,
      // Never resolve real DNS in tests.
      safeUpstreamValidator: { assertSafeUpstreamUrl: async () => {} },
      ...overrides,
    });
    return registry;
  };

  it('POST /api/connections probes the new connection in the background and records lastProbeOkAt', async () => {
    const registry = registerWithValidator({ onConnectionsChanged: registerProfileAdapter });

    const response = createMockResponse();
    await registry.getRoute('POST', '/api/connections')(createMockRequest({
      body: { label: 'Remote', baseUrl: 'https://api.example.com' },
    }), response);

    expect(response.statusCode).toBe(200);
    const connectionId = response.body.connection.id;
    expect(connectionId).toBeTruthy();
    await vi.waitFor(async () => {
      const record = await profileStore.getPrivateRecord(connectionId);
      expect(record.lastProbeOkAt).toBeGreaterThan(0);
    });
    // The public summary never carries the private URL.
    expect(JSON.stringify(response.body)).not.toContain('api.example.com');
  });

  it('POST /api/connections succeeds even when the background probe fails (no lastProbeOkAt)', async () => {
    const registry = registerWithValidator({
      onConnectionsChanged: async () => {
        const records = await profileStore.listPrivateRecords();
        const direct = records.find((record) => record.target?.kind === 'direct');
        if (direct && !broker.hasAdapter(direct.id)) {
          broker.registerAdapter(createDirectAdapter(direct.id, { ok: false }));
        }
      },
    });

    const response = createMockResponse();
    await registry.getRoute('POST', '/api/connections')(createMockRequest({
      body: { label: 'Remote', baseUrl: 'https://api.example.com' },
    }), response);

    expect(response.statusCode).toBe(200);
    const connectionId = response.body.connection.id;
    expect(connectionId).toBeTruthy();
    const record = await profileStore.getPrivateRecord(connectionId);
    expect(record).not.toHaveProperty('lastProbeOkAt');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await profileStore.getPrivateRecord(connectionId)).not.toHaveProperty('lastProbeOkAt');
  });

  it('PATCH /api/connections supports label-only edits, keeping the private target', async () => {
    await profileStore.upsertConnection({
      id: 'direct-1',
      label: 'Before',
      target: { kind: 'direct', baseUrl: 'https://secret.example.com', clientToken: 'secret-token' },
    });
    broker.registerAdapter(createDirectAdapter('direct-1'));
    const registry = registerWithValidator();

    const response = createMockResponse();
    await registry.getRoute('PATCH', '/api/connections/:connectionId')(createMockRequest({
      params: { connectionId: 'direct-1' },
      body: { label: 'Renamed' },
    }), response);

    expect(response.statusCode).toBe(200);
    expect(response.body.connection.label).toBe('Renamed');
    const record = await profileStore.getPrivateRecord('direct-1');
    expect(record.label).toBe('Renamed');
    expect(record.target.baseUrl).toBe('https://secret.example.com');
    expect(record.target.clientToken).toBe('secret-token');
    await vi.waitFor(async () => {
      expect((await profileStore.getPrivateRecord('direct-1')).lastProbeOkAt).toBeGreaterThan(0);
    });
  });

  it('the probe route records lastProbeOkAt when a live probe succeeds', async () => {
    await profileStore.upsertConnection({
      id: 'direct-1',
      label: 'Direct',
      target: { kind: 'direct', baseUrl: 'https://api.example.com' },
    });
    broker.registerAdapter(createDirectAdapter('direct-1'));
    const registry = registerWithValidator();

    const response = createMockResponse();
    await registry.getRoute('POST', '/api/connections/:connectionId/probe')(createMockRequest({
      params: { connectionId: 'direct-1' },
    }), response);

    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    await vi.waitFor(async () => {
      expect((await profileStore.getPrivateRecord('direct-1')).lastProbeOkAt).toBeGreaterThan(0);
    });
  });

  it('the probe route never writes the profile file while the catalog is disabled', async () => {
    await profileStore.upsertConnection({
      id: 'direct-1',
      label: 'Direct',
      target: { kind: 'direct', baseUrl: 'https://api.example.com' },
    });
    broker.registerAdapter(createDirectAdapter('direct-1'));
    const registry = registerWithValidator({ projectCatalogV1: false });
    const profilesPath = path.join(tempDir, 'connection-profiles.json');
    const beforeBytes = fs.readFileSync(profilesPath, 'utf8');

    const response = createMockResponse();
    await registry.getRoute('POST', '/api/connections/:connectionId/probe')(createMockRequest({
      params: { connectionId: 'direct-1' },
    }), response);

    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fs.readFileSync(profilesPath, 'utf8')).toBe(beforeBytes);
    expect(await profileStore.getPrivateRecord('direct-1')).not.toHaveProperty('lastProbeOkAt');
  });
});

describe('projectCatalogV1 disabled state (plan §20)', () => {
  const registerDisabledRoutes = () => {
    const registry = createRouteRegistry();
    registerProjectCatalogRoutes(registry.app, {
      catalogStore,
      connectionBroker: broker,
      profileStore,
      credentialProvider,
      projectCatalogV1: false,
    });
    return registry;
  };

  it('reports the capability as enabled by default and disabled when the flag is off', async () => {
    const enabledResponse = createMockResponse();
    await getRoute('GET', '/api/projects/capabilities')(createMockRequest(), enabledResponse);
    expect(enabledResponse.statusCode).toBe(200);
    expect(enabledResponse.body).toEqual({ projectCatalogV1: true });

    const disabledRegistry = registerDisabledRoutes();
    const disabledResponse = createMockResponse();
    await disabledRegistry.getRoute('GET', '/api/projects/capabilities')(createMockRequest(), disabledResponse);
    expect(disabledResponse.statusCode).toBe(200);
    expect(disabledResponse.body).toEqual({ projectCatalogV1: false });
  });

  it('rejects every catalog/connection mutation with 501 capability_unavailable', async () => {
    const created = await catalogStore.createProject({
      connectionId: 'local',
      canonicalPath: projectDir,
      path: projectDir,
      label: 'WS',
    });
    await profileStore.upsertConnection({
      id: 'direct-1',
      label: 'Direct',
      target: { kind: 'direct', baseUrl: 'https://api.example.com' },
    });

    const registry = registerDisabledRoutes();
    const cases = [
      ['POST', '/api/projects', { body: { connectionId: 'local', path: '/new' } }],
      ['PATCH', '/api/projects/:projectId', { params: { projectId: created.descriptor.id }, body: { label: 'Renamed' } }],
      ['DELETE', '/api/projects/:projectId', { params: { projectId: created.descriptor.id } }],
      ['POST', '/api/connections', { body: { label: 'Remote', baseUrl: 'https://remote.example.com' } }],
      ['PATCH', '/api/connections/:connectionId', { params: { connectionId: 'direct-1' }, body: { label: 'Renamed' } }],
      ['DELETE', '/api/connections/:connectionId', { params: { connectionId: 'direct-1' } }],
    ];
    for (const [method, routePath, overrides] of cases) {
      const response = createMockResponse();
      await registry.getRoute(method, routePath)(createMockRequest(overrides), response);
      expect(response.statusCode).toBe(501);
      expect(response.body).toEqual({
        error: 'The project catalog is disabled on this server',
        code: 'capability_unavailable',
      });
    }
  });

  it('never rewrites the catalog file and never mutates stored data while disabled', async () => {
    const created = await catalogStore.createProject({
      connectionId: 'local',
      canonicalPath: projectDir,
      path: projectDir,
      label: 'WS',
    });
    await catalogStore.createProject({
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
    const filePath = path.join(tempDir, 'project-catalog.json');
    const beforeBytes = fs.readFileSync(filePath, 'utf8');

    const registry = registerDisabledRoutes();
    for (const [method, routePath, overrides] of [
      ['POST', '/api/projects', { body: { connectionId: 'local', path: '/new' } }],
      ['PATCH', '/api/projects/:projectId', { params: { projectId: created.descriptor.id }, body: { label: 'Renamed' } }],
      ['DELETE', '/api/projects/:projectId', { params: { projectId: created.descriptor.id } }],
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
    expect(snapshot.projects.map((entry) => entry.label)).toEqual(['WS', 'Other']);
    expect(snapshot.revision).toBe(2);
  });

  it('keeps reads available while disabled: snapshot, single project and browse', async () => {
    await catalogStore.createProject({
      connectionId: 'local',
      canonicalPath: projectDir,
      path: projectDir,
      label: 'WS',
    });
    const registry = registerDisabledRoutes();

    const snapshotResponse = createMockResponse();
    await registry.getRoute('GET', '/api/projects')(createMockRequest(), snapshotResponse);
    expect(snapshotResponse.statusCode).toBe(200);
    expect(snapshotResponse.body.projects).toHaveLength(1);

    const singleResponse = createMockResponse();
    await registry.getRoute('GET', '/api/projects/:projectId')(createMockRequest({
      params: { projectId: snapshotResponse.body.projects[0].id },
    }), singleResponse);
    expect(singleResponse.statusCode).toBe(200);
    expect(singleResponse.body.project.label).toBe('WS');
  });
});
