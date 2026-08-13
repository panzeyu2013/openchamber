import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProjectsRuntime } from './index.js';

const fsPromises = fs.promises;

const createRuntime = async (dependencies = {}) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-index-test-'));
  const runtime = await createProjectsRuntime({
    fs,
    fsPromises,
    path,
    openchamberDataDir: tempDir,
    readSettings: async () => ({}),
    normalizeDirectoryPath: (value) => String(value || ''),
    projectCatalogV1: true,
    // Never resolve real DNS in connection CRUD validation tests.
    safeUpstreamValidator: { assertSafeUpstreamUrl: async () => {} },
    ...dependencies,
  });
  return { runtime, tempDir };
};

/** Minimal Electron-SSH-shaped adapter: the broker/session-index only need
 * connectionId + the stream surface; openEventStream rejects on abort so an
 * observer stop settles instead of leaking a pending promise. Pass
 * `{ signals }` to record every AbortSignal the observer handed the adapter. */
const createSshAdapter = (instanceId, overrides = {}) => ({
  kind: 'ssh',
  connectionId: `ssh:${instanceId}`,
  label: `SSH ${instanceId}`,
  sshInstanceId: instanceId,
  capabilities: { pathBrowse: true, terminal: true, files: true, git: true, eventStream: true },
  canonicalizePath: async () => '/',
  probe: async () => ({ ok: true, canonicalPath: null, capabilities: {} }),
  listChildren: async () => ({ directory: '/', children: [] }),
  fetch: async () => new Response('[]', { status: 200 }),
  openEventStream: async (_context, _restPath, signal) => {
    if (overrides.signals) overrides.signals.push(signal);
    return new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  },
  openWebSocket: async () => {
    throw new Error('not supported');
  },
  dispose: async () => {},
  ...overrides,
});

describe('projects runtime: injected adapter registration', () => {
  let tempDir;
  let runtime;

  beforeEach(async () => {
    const created = await createRuntime();
    runtime = created.runtime;
    tempDir = created.tempDir;
  });

  afterEach(async () => {
    await runtime.dispose();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('registers the broker adapter, seeds the profile and starts observing', async () => {
    const adapter = createSshAdapter('inst-1');
    const ok = await runtime.registerInjectedAdapter(adapter);

    expect(ok).toBe(true);
    expect(runtime.connectionBroker.hasAdapter('ssh:inst-1')).toBe(true);
    expect(runtime.connectionBroker.getAdapter('ssh:inst-1')).toBe(adapter);
    const profile = await runtime.profileStore.getPrivateRecord('ssh:inst-1');
    expect(profile).not.toBeNull();
    expect(profile.label).toBe('SSH inst-1');
    expect(profile.target).toEqual({ kind: 'ssh', sshInstanceId: 'inst-1' });
    expect(runtime.sessionIndex._getStateForTest('ssh:inst-1')?.observer).toBeTruthy();
  });

  it('seeding is idempotent: re-registering keeps the existing profile', async () => {
    await runtime.registerInjectedAdapter(createSshAdapter('inst-dup'));
    await runtime.registerInjectedAdapter(createSshAdapter('inst-dup', { label: 'Renamed' }));
    const profiles = await runtime.profileStore.listPrivateRecords();
    const sshProfiles = profiles.filter((record) => record.target?.kind === 'ssh');
    expect(sshProfiles).toHaveLength(1);
    expect(sshProfiles[0].label).toBe('SSH inst-dup');
  });

  it('unregisters the adapter, stops observation and preserves the profile', async () => {
    const signals = [];
    await runtime.registerInjectedAdapter(createSshAdapter('inst-2', { signals }));
    expect(runtime.sessionIndex._getStateForTest('ssh:inst-2')?.observer).toBeTruthy();
    expect(runtime.connectionBroker.getLifecycleState('ssh:inst-2').leaseCount).toBe(1);

    const removed = await runtime.unregisterInjectedAdapter('ssh:inst-2');

    expect(removed).toBe(true);
    expect(runtime.connectionBroker.hasAdapter('ssh:inst-2')).toBe(false);
    expect(runtime.sessionIndex._getStateForTest('ssh:inst-2')).toBeNull();
    // The observer's event stream was aborted and its lease released, so a
    // disposed adapter is never retried (holding its lease) after the stop.
    expect(signals[0].aborted).toBe(true);
    expect(runtime.connectionBroker.getLifecycleState('ssh:inst-2').leaseCount).toBe(0);
    const profile = await runtime.profileStore.getPrivateRecord('ssh:inst-2');
    expect(profile).not.toBeNull();
    expect(profile.target.kind).toBe('ssh');
    expect(profile.target.sshInstanceId).toBe('inst-2');
  });

  it('re-registering after an unregister resumes observation', async () => {
    const firstSignals = [];
    const secondSignals = [];
    await runtime.registerInjectedAdapter(createSshAdapter('inst-3', { signals: firstSignals }));
    await runtime.unregisterInjectedAdapter('ssh:inst-3');

    const replacement = createSshAdapter('inst-3', { signals: secondSignals });
    await runtime.registerInjectedAdapter(replacement);

    expect(runtime.connectionBroker.getAdapter('ssh:inst-3')).toBe(replacement);
    expect(runtime.sessionIndex._getStateForTest('ssh:inst-3')?.observer).toBeTruthy();
    // The old observer's stream was stopped; the replacement holds a fresh
    // stream and lease instead of reusing the disposed adapter.
    expect(firstSignals[0].aborted).toBe(true);
    expect(secondSignals).toHaveLength(1);
    expect(secondSignals[0].aborted).toBe(false);
    expect(runtime.connectionBroker.getLifecycleState('ssh:inst-3').leaseCount).toBe(1);
    const profile = await runtime.profileStore.getPrivateRecord('ssh:inst-3');
    expect(profile).not.toBeNull();
  });

  it('unregistering an unknown connection is a no-op', async () => {
    const removed = await runtime.unregisterInjectedAdapter('ssh:ghost');
    expect(removed).toBe(false);
    expect(runtime.connectionBroker.hasAdapter('ssh:ghost')).toBe(false);
  });

  it('rejects invalid adapters without touching the broker', async () => {
    await expect(runtime.registerInjectedAdapter(null)).resolves.toBe(false);
    await expect(runtime.registerInjectedAdapter({ kind: 'ssh' })).resolves.toBe(false);
    expect(runtime.connectionBroker.listConnectionIds()).toEqual(['local']);
  });

  it('injected adapters passed at creation are registered and seeded', async () => {
    const adapter = createSshAdapter('inst-boot');
    await runtime.dispose();
    fs.rmSync(tempDir, { recursive: true, force: true });

    const created = await createRuntime({ injectedAdapters: [adapter] });
    runtime = created.runtime;
    tempDir = created.tempDir;

    expect(runtime.connectionBroker.getAdapter('ssh:inst-boot')).toBe(adapter);
    const profile = await runtime.profileStore.getPrivateRecord('ssh:inst-boot');
    expect(profile).not.toBeNull();
    expect(profile.target.sshInstanceId).toBe('inst-boot');
  });
});

describe('projects runtime: connection deletion stops observers (onConnectionsChanged)', () => {
  let tempDir;
  let runtime;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const createRouteRegistry = () => {
    const routes = new Map();
    return {
      app: {
        get(routePath, handler) { routes.set(`GET ${routePath}`, handler); },
        post(routePath, handler) { routes.set(`POST ${routePath}`, handler); },
        patch(routePath, handler) { routes.set(`PATCH ${routePath}`, handler); },
        delete(routePath, handler) { routes.set(`DELETE ${routePath}`, handler); },
        all(routePath, handler) { routes.set(`ALL ${routePath}`, handler); },
        use(routePath, handler) { routes.set(`USE ${routePath}`, handler); },
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

  /** A managed-shaped adapter (kind direct) whose stream hangs until abort,
   * so the observer holds a lease and stops cleanly. Records every stream
   * AbortSignal and dispose call so tests can assert the stop semantics. */
  const createHangingDirectAdapter = (connectionId, recorder) => ({
    kind: 'direct',
    connectionId,
    label: connectionId,
    sshInstanceId: `inst:${connectionId}`,
    capabilities: { pathBrowse: true, terminal: true, files: true, git: true, eventStream: true },
    fetch: async () => new Response('[]', { status: 200 }),
    openEventStream: async (_context, _restPath, signal) => {
      recorder.signals.push(signal);
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
    openWebSocket: async () => {
      throw new Error('not supported');
    },
    dispose: async () => {
      recorder.disposeCalls += 1;
    },
  });

  const deleteConnection = async (connectionId) => {
    const registry = createRouteRegistry();
    runtime.registerRoutes(registry.app);
    const response = createMockResponse();
    await registry.getRoute('DELETE', '/api/connections/:connectionId')({
      params: { connectionId },
      get: () => undefined,
    }, response);
    return response;
  };

  beforeEach(async () => {
    const created = await createRuntime();
    runtime = created.runtime;
    tempDir = created.tempDir;
  });

  afterEach(async () => {
    await runtime.dispose();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('DELETE /api/connections/:id stops the connection observer, clears the index and releases the lease', async () => {
    const recorder = { signals: [], disposeCalls: 0 };
    await runtime.registerInjectedAdapter(createHangingDirectAdapter('conn-a', recorder));
    expect(runtime.sessionIndex._getStateForTest('conn-a')?.observer).toBeTruthy();
    expect(runtime.connectionBroker.getLifecycleState('conn-a').leaseCount).toBe(1);

    const response = await deleteConnection('conn-a');

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ deleted: true });
    expect(await runtime.profileStore.getPrivateRecord('conn-a')).toBeNull();
    // The profile-delete sweep unregistered the adapter and onConnectionsChanged
    // stopped its observer: stream aborted, index state dropped, lease released
    // — a disposed adapter is never retried (holding its lease) after the stop.
    expect(runtime.connectionBroker.hasAdapter('conn-a')).toBe(false);
    expect(recorder.disposeCalls).toBe(1);
    expect(recorder.signals[0].aborted).toBe(true);
    expect(runtime.sessionIndex._getStateForTest('conn-a')).toBeNull();
    expect(runtime.connectionBroker.getLifecycleState('conn-a').leaseCount).toBe(0);
    // Nothing may restart the observer for the deleted connection.
    await sleep(60);
    expect(runtime.sessionIndex._getStateForTest('conn-a')).toBeNull();
    expect(recorder.signals).toHaveLength(1);
  });

  it('refuses DELETE while projects reference the connection and keeps the observer running', async () => {
    const recorder = { signals: [], disposeCalls: 0 };
    await runtime.registerInjectedAdapter(createHangingDirectAdapter('conn-b', recorder));
    await runtime.catalogStore.createProject({
      connectionId: 'conn-b',
      canonicalPath: '/projects/remote',
      path: '/projects/remote',
      label: 'Remote',
      color: null,
      orderKey: '',
    });

    const response = await deleteConnection('conn-b');

    expect(response.statusCode).toBe(409);
    expect(response.body.code).toBe('catalog_connection_in_use');
    // The in-use guard leaves the profile, adapter, observer and lease intact.
    expect(await runtime.profileStore.getPrivateRecord('conn-b')).not.toBeNull();
    expect(runtime.connectionBroker.hasAdapter('conn-b')).toBe(true);
    expect(runtime.sessionIndex._getStateForTest('conn-b')?.observer).toBeTruthy();
    expect(recorder.signals[0].aborted).toBe(false);
    expect(recorder.disposeCalls).toBe(0);
    expect(runtime.connectionBroker.getLifecycleState('conn-b').leaseCount).toBe(1);
  });

  it('DELETE of an injected ssh connection sweeps its adapter and stops the observer', async () => {
    // Regression: the profile-delete sweep previously ignored ssh adapters, so
    // an Electron SSH connection deleted through the API left its adapter
    // registered and its observer retrying a phantom connection forever.
    const recorder = { signals: [], disposeCalls: 0 };
    await runtime.registerInjectedAdapter(createHangingDirectAdapter('ssh:inst-swept', recorder));
    expect(runtime.sessionIndex._getStateForTest('ssh:inst-swept')?.observer).toBeTruthy();

    const response = await deleteConnection('ssh:inst-swept');

    expect(response.statusCode).toBe(200);
    expect(await runtime.profileStore.getPrivateRecord('ssh:inst-swept')).toBeNull();
    expect(runtime.connectionBroker.hasAdapter('ssh:inst-swept')).toBe(false);
    expect(recorder.disposeCalls).toBe(1);
    expect(recorder.signals[0].aborted).toBe(true);
    expect(runtime.sessionIndex._getStateForTest('ssh:inst-swept')).toBeNull();
    await sleep(60);
    expect(recorder.signals).toHaveLength(1);
  });

  it('PATCH changing the direct baseUrl replaces the adapter and restarts the observer', async () => {
    const registry = createRouteRegistry();
    runtime.registerRoutes(registry.app);

    const createResponse = createMockResponse();
    await registry.getRoute('POST', '/api/connections')({
      body: { label: 'Old target', baseUrl: 'http://old.example' },
      get: () => undefined,
    }, createResponse);
    expect(createResponse.statusCode).toBe(200);
    const connectionId = createResponse.body.connection.id;
    const before = runtime.connectionBroker.getAdapter(connectionId);
    expect(before?.kind).toBe('direct');
    expect(before?.targetUrl).toBe('http://old.example');

    const patchResponse = createMockResponse();
    await registry.getRoute('PATCH', '/api/connections/:connectionId')({
      params: { connectionId },
      body: { label: 'New target', baseUrl: 'http://new.example' },
      get: () => undefined,
    }, patchResponse);
    expect(patchResponse.statusCode).toBe(200);

    const after = runtime.connectionBroker.getAdapter(connectionId);
    expect(after).not.toBe(before);
    expect(after?.kind).toBe('direct');
    expect(after?.targetUrl).toBe('http://new.example');
    // The replaced adapter has its own observer state (the stream against the
    // unreachable URL simply backs off and reconnects in the background).
    expect(runtime.sessionIndex._getStateForTest(connectionId)?.observer).toBeTruthy();
  });
});
