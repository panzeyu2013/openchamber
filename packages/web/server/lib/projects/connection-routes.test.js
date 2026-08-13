import { afterAll, describe, expect, it } from 'vitest';
import path from 'path';
import fsSync from 'fs';
import fsPromises from 'fs/promises';
import os from 'os';
import { registerProjectCatalogRoutes } from './routes.js';
import { createConnectionProfileStore } from './connection-profile-store.js';
import { createCatalogStore } from './catalog-store.js';
import { createConnectionBroker } from './connection-broker.js';
import { createLocalProjectAdapter } from './local-adapter.js';
import { createSafeUpstreamValidator } from './direct-adapter.js';

const temporaryDirectories = [];

const makeTempDir = () => {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ws-connection-routes-'));
  temporaryDirectories.push(dir);
  return dir;
};

// Deterministic SSRF gate for tests: `example.com` is allowed, everything
// else (loopback/private) is rejected — no live DNS in tests.
const testValidator = createSafeUpstreamValidator({
  lookup: (hostname, options, callback) => {
    if (hostname === 'example.com') {
      callback(null, [{ address: '93.184.216.34', family: 4 }]);
      return;
    }
    callback(new Error('ENOTFOUND'));
  },
});

const createApp = async (dependencies = {}) => {
  const routes = new Map();
  const app = {
    get(routePath, handler) { routes.set(`GET ${routePath}`, handler); },
    post(routePath, handler) { routes.set(`POST ${routePath}`, handler); },
    patch(routePath, handler) { routes.set(`PATCH ${routePath}`, handler); },
    delete(routePath, handler) { routes.set(`DELETE ${routePath}`, handler); },
    all() {},
    use() {},
  };
  const getHandler = (method, routePath) => routes.get(`${method} ${routePath}`);

  const dir = dependencies.dataDir ?? makeTempDir();
  const catalogStore = createCatalogStore({
    fs: fsPromises,
    path,
    filePath: path.join(dir, 'project-catalog.json'),
  });
  await catalogStore.load();
  const profileStore = createConnectionProfileStore({
    fs: fsPromises,
    filePath: path.join(dir, 'connection-profiles.json'),
  });
  await profileStore.load();
  const broker = createConnectionBroker({ profileStore });
  broker.registerAdapter(createLocalProjectAdapter({ fs: fsPromises, path, normalizeDirectoryPath: (p) => p }));

  const onConnectionsChanged = dependencies.onConnectionsChanged ?? (() => {});
  registerProjectCatalogRoutes(app, { catalogStore, connectionBroker: broker, profileStore, onConnectionsChanged, safeUpstreamValidator: testValidator });

  return { app, getHandler, catalogStore, profileStore, broker };
};

const createRequest = ({ method, path, params = {}, body = null, headers = {} }) => ({
  method,
  path,
  params,
  body,
  headers,
  get: (name) => headers[name] ?? undefined,
});

const createResponse = () => {
  let statusCode = 200;
  let body = null;
  return {
    status(code) { statusCode = code; return this; },
    json(payload) { body = payload; return this; },
    statusCode() { return statusCode; },
    get body() { return body; },
  };
};

const run = async (getHandler, method, route, req) => {
  const handler = getHandler(method, route);
  if (!handler) throw new Error(`no handler for ${method} ${route}`);
  const res = createResponse();
  await handler(req, res);
  return res;
};

afterAll(() => {
  for (const dir of temporaryDirectories) {
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
});

describe('connection profile CRUD', () => {
  it('creates a direct connection and never returns private fields', async () => {
    const { getHandler } = await createApp();
    const res = await run(getHandler, 'POST', '/api/connections', createRequest({
      method: 'POST',
      path: '/api/connections',
      body: { label: 'Build Server', baseUrl: 'https://example.com', clientToken: 'super-secret' },
    }));

    expect(res.statusCode()).toBe(200);
    expect(res.body.connection.label).toBe('Build Server');
    expect(res.body.connection.capabilities.pathBrowse).toBe(true);
    expect(JSON.stringify(res.body.connection)).not.toContain('super-secret');
    expect(JSON.stringify(res.body.connection)).not.toContain('clientToken');
    expect(JSON.stringify(res.body.connection)).not.toContain('baseUrl');
  });

  it('rejects unsafe (loopback) direct targets', async () => {
    const { getHandler } = await createApp();
    const res = await run(getHandler, 'POST', '/api/connections', createRequest({
      method: 'POST',
      path: '/api/connections',
      body: { label: 'Evil', baseUrl: 'http://127.0.0.1:3000' },
    }));

    expect(res.statusCode()).toBe(400);
    expect(res.body.code).toBe('catalog_invalid_input');
  });

  it('rejects invalid input', async () => {
    const { getHandler } = await createApp();
    const noLabel = await run(getHandler, 'POST', '/api/connections', createRequest({
      method: 'POST', path: '/api/connections', body: { baseUrl: 'https://example.com' },
    }));
    expect(noLabel.statusCode()).toBe(400);

    const noUrl = await run(getHandler, 'POST', '/api/connections', createRequest({
      method: 'POST', path: '/api/connections', body: { label: 'X' },
    }));
    expect(noUrl.statusCode()).toBe(400);

    const badProtocol = await run(getHandler, 'POST', '/api/connections', createRequest({
      method: 'POST', path: '/api/connections', body: { label: 'X', baseUrl: 'ftp://example.com' },
    }));
    expect(badProtocol.statusCode()).toBe(400);
  });

  it('patches an existing direct connection', async () => {
    const { getHandler } = await createApp();
    const created = await run(getHandler, 'POST', '/api/connections', createRequest({
      method: 'POST', path: '/api/connections',
      body: { label: 'Build Server', baseUrl: 'https://example.com', clientToken: 'tok-1' },
    }));
    const connectionId = created.body.connection.id;

    const updated = await run(getHandler, 'PATCH', '/api/connections/:connectionId', createRequest({
      method: 'PATCH', path: '/api/connections/:connectionId',
      params: { connectionId },
      body: { label: 'Renamed', baseUrl: 'https://example.com' },
    }));

    expect(updated.statusCode()).toBe(200);
    expect(updated.body.connection.label).toBe('Renamed');
    expect(JSON.stringify(updated.body.connection)).not.toContain('tok-1');
  });

  it('refuses to delete the local connection', async () => {
    const { getHandler } = await createApp();
    const res = await run(getHandler, 'DELETE', '/api/connections/:connectionId', createRequest({
      method: 'DELETE', path: '/api/connections/:connectionId', params: { connectionId: 'local' },
    }));

    expect(res.statusCode()).toBe(400);
    expect(res.body.code).toBe('catalog_connection_not_deletable');
  });

  it('refuses to delete a connection still referenced by projects', async () => {
    const { getHandler, catalogStore } = await createApp();
    const created = await run(getHandler, 'POST', '/api/connections', createRequest({
      method: 'POST', path: '/api/connections',
      body: { label: 'Build Server', baseUrl: 'https://example.com' },
    }));
    const connectionId = created.body.connection.id;
    await catalogStore.createProject({
      connectionId,
      canonicalPath: '/remote/proj',
      path: '/remote/proj',
      label: 'Remote Project',
      color: null,
      orderKey: '',
    });

    const res = await run(getHandler, 'DELETE', '/api/connections/:connectionId', createRequest({
      method: 'DELETE', path: '/api/connections/:connectionId', params: { connectionId },
    }));

    expect(res.statusCode()).toBe(409);
    expect(res.body.code).toBe('catalog_connection_in_use');
  });

  it('deletes an unused connection and notifies the adapter sync', async () => {
    let syncCalls = 0;
    const { getHandler } = await createApp({ onConnectionsChanged: () => { syncCalls += 1; } });
    const created = await run(getHandler, 'POST', '/api/connections', createRequest({
      method: 'POST', path: '/api/connections',
      body: { label: 'Temp', baseUrl: 'https://example.com' },
    }));
    expect(syncCalls).toBe(1);

    const res = await run(getHandler, 'DELETE', '/api/connections/:connectionId', createRequest({
      method: 'DELETE', path: '/api/connections/:connectionId',
      params: { connectionId: created.body.connection.id },
    }));

    expect(res.statusCode()).toBe(200);
    expect(syncCalls).toBe(2);
  });

  it('404s unknown connections', async () => {
    const { getHandler } = await createApp();
    const res = await run(getHandler, 'DELETE', '/api/connections/:connectionId', createRequest({
      method: 'DELETE', path: '/api/connections/:connectionId', params: { connectionId: 'ghost' },
    }));
    expect(res.statusCode()).toBe(404);
  });
});
