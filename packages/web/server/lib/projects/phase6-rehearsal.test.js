import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCatalogStore } from './catalog-store.js';
import { createConnectionProfileStore } from './connection-profile-store.js';
import { createSessionBindingStore } from './session-binding-store.js';
import { createSessionIndex } from './session-index.js';
import { createConnectionBroker } from './connection-broker.js';
import { createRelayProjectAdapter } from './relay-adapter.js';
import { createLegacyProjectMigration } from './migration.js';
import { exportPublicKeyJwk, generateEcdhKeyPair } from '../relay/e2ee.js';

/**
 * Phase 6 pre-launch rehearsal drills (§20.5 of
 * docs/unified-project-architecture.md), code-testable subset.
 *
 * Covered here (gaps in the adjacent per-module suites):
 * - Upgrade/downgrade: newer/older unknown schemaVersion files are refused
 *   for writes by the current store and never overwritten on disk.
 * - Migration interruption: a mid-run connection failure aborts without
 *   committing state; a re-run resumes idempotently (no duplicates, no data
 *   loss).
 * - Catalog corruption recovery: corrupt primary + corrupt backup fails
 *   loudly with the explicit no-parseable-backup reason; a corrupt backup
 *   never blocks a healthy primary.
 * - Remote-all-offline: when EVERY connection fails after success, each
 *   keeps its last-success snapshot and its own freshness; one failure never
 *   clears another connection's data; recovery restores completeness.
 * - Electron tunnel-active exit: broker.dispose() closes the relay tunnel
 *   while a lease is still active (process shutdown path, not idle grace).
 *
 * Already covered by existing suites (not duplicated here): catalog
 * recovery-from-backup on a corrupt primary, dropped-entry recovery state,
 * migration pending-path retry and already-done short-circuit, broker idle
 * grace disposal, direct adapter.dispose(), and the session-index observer
 * lease release on dispose.
 */

const fsPromises = fs.promises;

let tempDir;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase6-rehearsal-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const catalogFilePath = () => path.join(tempDir, 'project-catalog.json');

const createStore = () => createCatalogStore({
  fs: fsPromises,
  path,
  filePath: catalogFilePath(),
});

const validCatalogDocument = (overrides = {}) => ({
  schemaVersion: 2,
  revision: 0,
  connections: [],
  projects: [],
  migration: { legacyProjectsImported: false, pendingConnectionIds: [] },
  ...overrides,
});

describe('upgrade/downgrade: unknown schemaVersion is refused for writes', () => {
  it.each([0, 99])('a schemaVersion %i file is refused for writes and never overwritten', async (schemaVersion) => {
    const filePath = catalogFilePath();
    const newerDoc = JSON.stringify(
      validCatalogDocument({ schemaVersion, projects: [{ id: 'future-ws', label: 'Future' }] }),
      null,
      2,
    );
    fs.writeFileSync(filePath, newerDoc);

    const store = createStore();
    await expect(store.load()).rejects.toThrow('catalog file is corrupt and no parseable backup exists');

    // Mutations must be refused: no snapshot can be read from an
    // unparseable catalog, so the write path never runs.
    await expect(store.createProject({
      connectionId: 'local',
      canonicalPath: '/new/project',
      path: '/new/project',
      label: 'New',
      color: null,
      orderKey: '',
    })).rejects.toThrow('catalog file is corrupt');

    // The on-disk file is byte-identical: the unknown-version document was
    // never replaced by the current schema and no backup was created.
    expect(fs.readFileSync(filePath, 'utf8')).toBe(newerDoc);
    expect(fs.existsSync(`${filePath}.bak`)).toBe(false);
    const diagnostics = await store.getDiagnostics();
    expect(diagnostics.loaded).toBe(false);
    expect(diagnostics.recoveryState).toEqual({ recovered: true, reason: 'catalog file corrupt; no parseable backup' });
  });

  it('recovers from a valid backup when the primary is a newer unknown schema', async () => {
    const store = createStore();
    const created = await store.createProject({
      connectionId: 'local',
      canonicalPath: '/known/project',
      path: '/known/project',
      label: 'Known',
      color: null,
      orderKey: '',
    });
    const stored = JSON.parse(fs.readFileSync(catalogFilePath(), 'utf8'));

    fs.writeFileSync(catalogFilePath(), JSON.stringify(validCatalogDocument({ schemaVersion: 99, projects: [] })));
    const backup = createStore();
    const document = await backup.load();
    expect(document.schemaVersion).toBe(2);
    expect(document.revision).toBe(stored.revision);
    expect((await backup.getSnapshot()).projects).toEqual([created.descriptor]);
    expect((await backup.getDiagnostics()).recoveryState).toEqual({ recovered: true, reason: 'catalog file corrupt; recovered from backup' });
  });
});

describe('migration interruption: mid-run failure resumes idempotently', () => {
  it('an aborted first run leaves no committed state and a re-run imports everything without duplicates', async () => {
    const projectA = path.join(tempDir, 'alpha');
    const projectB = path.join(tempDir, 'beta');
    const projectC = path.join(tempDir, 'gamma');
    for (const dir of [projectA, projectB, projectC]) fs.mkdirSync(dir);

    let connectionFailing = true;
    const localAdapter = {
      canonicalizePath: vi.fn(async (_context, inputPath) => {
        if (connectionFailing && inputPath === projectB) {
          throw new Error('simulated connection failure mid-migration');
        }
        return inputPath;
      }),
    };
    const catalogStore = createStore();
    const migration = createLegacyProjectMigration({
      catalogStore,
      localAdapter,
      readSettings: async () => ({
        projects: [
          { path: projectA, label: 'Alpha' },
          { path: projectB, label: 'Beta' },
          { path: projectC, label: 'Gamma' },
        ],
      }),
    });

    // Run 1: the connection dies on the second project. The run aborts and
    // no migration state is committed; the first project stays imported.
    await expect(migration.run()).rejects.toThrow('simulated connection failure mid-migration');
    let snapshot = await catalogStore.getSnapshot();
    expect(snapshot.migration.legacyProjectsImported).toBe(false);
    expect(snapshot.migration.pendingConnectionIds).toEqual([]);
    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.projects[0].label).toBe('Alpha');
    const alphaIdAfterInterrupt = snapshot.projects[0].id;

    // Run 2: the connection is back. Everything imports; Alpha is skipped by
    // its location with the SAME stable id, so there are no duplicates and
    // no data loss.
    connectionFailing = false;
    const rerun = await migration.run();
    expect(rerun.status).toBe('done');
    expect(rerun.committed).toBe(true);
    expect(rerun.imported).toBe(2);
    expect(rerun.skipped).toBe(1);

    snapshot = await catalogStore.getSnapshot();
    expect(snapshot.projects).toHaveLength(3);
    const ids = snapshot.projects.map((project) => project.id);
    expect(new Set(ids).size).toBe(3);
    expect(await catalogStore.findProjectByLocation('local', projectA)).toMatchObject({
      id: alphaIdAfterInterrupt,
      label: 'Alpha',
    });
    expect(snapshot.migration).toEqual({ legacyProjectsImported: true, pendingConnectionIds: [] });

    // Run 3 short-circuits: the committed state is authoritative.
    expect((await migration.run()).status).toBe('already-done');
  });

  it('an interruption with a pending path keeps the pending state committed and retries it later', async () => {
    const reachable = path.join(tempDir, 'reachable');
    const pending = path.join(tempDir, 'pending');
    fs.mkdirSync(reachable);
    const catalogStore = createStore();
    const migration = createLegacyProjectMigration({
      catalogStore,
      localAdapter: {
        canonicalizePath: async (_context, inputPath) => {
          if (!fs.existsSync(inputPath)) {
            const error = new Error('path does not exist');
            error.code = 'catalog_path_not_found';
            throw error;
          }
          return inputPath;
        },
      },
      readSettings: async () => ({ projects: [{ path: reachable }, { path: pending }] }),
    });

    const first = await migration.run();
    expect(first.pendingPaths).toEqual([pending]);
    expect((await catalogStore.getSnapshot()).migration).toEqual({
      legacyProjectsImported: true,
      pendingConnectionIds: [pending],
    });

    // The connection drops again during the retry: the generic failure
    // aborts the run without touching the committed pending state.
    const failing = createLegacyProjectMigration({
      catalogStore,
      localAdapter: {
        canonicalizePath: async () => { throw new Error('connection dropped during retry'); },
      },
      readSettings: async () => ({ projects: [{ path: reachable }, { path: pending }] }),
    });
    await expect(failing.run()).rejects.toThrow('connection dropped during retry');
    expect((await catalogStore.getSnapshot()).migration).toEqual({
      legacyProjectsImported: true,
      pendingConnectionIds: [pending],
    });

    // The pending path becomes reachable; the next run imports it and clears
    // the list without re-importing the already-migrated project.
    fs.mkdirSync(pending);
    const resumed = await migration.run();
    expect(resumed.imported).toBe(1);
    expect(resumed.pendingPaths).toEqual([]);
    const snapshot = await catalogStore.getSnapshot();
    expect(snapshot.projects).toHaveLength(2);
    expect(snapshot.migration).toEqual({ legacyProjectsImported: true, pendingConnectionIds: [] });
  });
});

describe('catalog corruption recovery', () => {
  it('fails loudly with the explicit no-parseable-backup reason when primary AND backup are corrupt', async () => {
    const filePath = catalogFilePath();
    fs.writeFileSync(filePath, 'primary is not json');
    fs.writeFileSync(`${filePath}.bak`, 'backup is not json either');

    const store = createStore();
    await expect(store.load()).rejects.toThrow('catalog file is corrupt and no parseable backup exists');
    const diagnostics = await store.getDiagnostics();
    expect(diagnostics.loaded).toBe(false);
    expect(diagnostics.recoveryState).toEqual({ recovered: true, reason: 'catalog file corrupt; no parseable backup' });
  });

  it('a corrupt backup never blocks a healthy primary', async () => {
    const store = createStore();
    const created = await store.createProject({
      connectionId: 'local',
      canonicalPath: '/healthy/project',
      path: '/healthy/project',
      label: 'Healthy',
      color: null,
      orderKey: '',
    });
    fs.writeFileSync(`${catalogFilePath()}.bak`, '{garbage backup');

    const reloaded = createStore();
    const document = await reloaded.load();
    expect(document.projects).toHaveLength(1);
    expect(document.projects[0].id).toBe(created.descriptor.id);
    expect((await reloaded.getDiagnostics()).recoveryState).toBeNull();
    expect((await reloaded.getSnapshot()).projects[0].label).toBe('Healthy');
  });
});

describe('remote-all-offline: last-success data and per-connection freshness survive total failure', () => {
  let catalogStore;
  let profileStore;
  let bindingStore;
  let index;

  beforeEach(async () => {
    catalogStore = createStore();
    await catalogStore.load();
    profileStore = createConnectionProfileStore({
      fs: fsPromises,
      filePath: path.join(tempDir, 'connection-profiles.json'),
    });
    await profileStore.load();
    await profileStore.upsertConnection({
      id: 'remote-1',
      label: 'Remote One',
      target: { kind: 'direct', baseUrl: 'https://remote.example.test' },
    });
    bindingStore = createSessionBindingStore({
      fs: fsPromises,
    path,

      filePath: path.join(tempDir, 'project-session-bindings.json'),
    });
    await bindingStore.load();
  });

  afterEach(async () => {
    await index?.dispose();
  });

  const createProject = async (connectionId, canonicalPath, label) => {
    const outcome = await catalogStore.createProject({
      connectionId,
      canonicalPath,
      path: canonicalPath,
      label,
      color: null,
      orderKey: '',
    });
    return outcome.descriptor;
  };

  const sessionPayload = (id, directory, updated) => ({
    id,
    title: `Session ${id}`,
    directory,
    time: { updated },
  });

  const jsonResponse = (payload) => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

  const createFailingAdapter = (sessions) => {
    let failing = false;
    const adapter = {
      connectionId: 'local',
      capabilities: { eventStream: true, pathBrowse: true, terminal: true, files: true, git: true },
      fetch: async () => {
        if (failing) throw new Error('remote unreachable');
        return jsonResponse(sessions);
      },
      openEventStream: async () => new Response(new ReadableStream({}), { status: 200 }),
      setFailing: (value) => { failing = value; },
    };
    return adapter;
  };

  const createBroker = (adapters) => ({
    async resolveConnection(connectionId) {
      const adapter = adapters[connectionId];
      if (!adapter) return null;
      const profile = await profileStore.getPrivateRecord(connectionId);
      return profile ? { profile, adapter } : null;
    },
    acquireLease() {
      return () => {};
    },
  });

  it('total failure keeps every connection’s last-success snapshot and its own freshness, then recovers', async () => {
    await createProject('local', '/local/project', 'Local');
    await createProject('remote-1', '/remote/project', 'Remote');

    const localSessions = [
      sessionPayload('local-1', '/local/project', 100),
      sessionPayload('local-2', '/local/project', 50),
    ];
    const remoteSessions = [sessionPayload('remote-1', '/remote/project', 200)];
    const localAdapter = createFailingAdapter(localSessions);
    const remoteAdapter = createFailingAdapter(remoteSessions);
    remoteAdapter.connectionId = 'remote-1';
    localAdapter.connectionId = 'local';

    index = createSessionIndex({
      catalogStore,
      profileStore,
      connectionBroker: createBroker({ local: localAdapter, 'remote-1': remoteAdapter }),
      bindingStore,
    });

    // All connections healthy: every session is indexed and complete.
    await index.refreshAll();
    let snapshot = await index.getSnapshot();
    expect(snapshot.sessions).toHaveLength(3);
    expect(snapshot.freshnessByConnection.local.complete).toBe(true);
    expect(snapshot.freshnessByConnection['remote-1'].complete).toBe(true);
    const localLastSuccess = snapshot.freshnessByConnection.local.lastSuccessAt;
    const remoteLastSuccess = snapshot.freshnessByConnection['remote-1'].lastSuccessAt;
    expect(localLastSuccess).toEqual(expect.any(Number));
    expect(remoteLastSuccess).toEqual(expect.any(Number));

    // ALL connections go offline. Last-success data must survive for every
    // connection and each freshness entry must stay per-connection.
    localAdapter.setFailing(true);
    remoteAdapter.setFailing(true);
    const results = await index.refreshAll();

    // `ok: true` = the connection still has complete (or previously complete)
    // data — the total failure must never turn retained data into a loss.
    expect(results.local).toEqual({ ok: true });
    expect(results['remote-1']).toEqual({ ok: true });
    snapshot = await index.getSnapshot();
    expect(snapshot.sessions).toHaveLength(3);
    const byId = Object.fromEntries(snapshot.sessions.map((session) => [session.upstreamSessionId, session]));
    expect(Object.keys(byId).sort()).toEqual(['local-1', 'local-2', 'remote-1']);

    const localFreshness = snapshot.freshnessByConnection.local;
    const remoteFreshness = snapshot.freshnessByConnection['remote-1'];
    expect(localFreshness.stale).toBe(true);
    expect(localFreshness.offline).toBe(false);
    expect(localFreshness.lastSuccessAt).toBe(localLastSuccess);
    expect(localFreshness.error.code).toBe('session_index_fetch_failed');
    expect(remoteFreshness.stale).toBe(true);
    expect(remoteFreshness.offline).toBe(false);
    expect(remoteFreshness.lastSuccessAt).toBe(remoteLastSuccess);
    expect(remoteFreshness.error.code).toBe('session_index_fetch_failed');

    // One connection recovers alone; the other stays stale and keeps its data.
    localAdapter.setFailing(false);
    await index.refreshAll();
    snapshot = await index.getSnapshot();
    expect(snapshot.freshnessByConnection.local.complete).toBe(true);
    expect(snapshot.freshnessByConnection.local.stale).toBe(false);
    expect(snapshot.freshnessByConnection['remote-1'].stale).toBe(true);
    expect(snapshot.sessions).toHaveLength(3);
    expect(snapshot.freshnessByConnection['remote-1'].lastSuccessAt).toBe(remoteLastSuccess);

    // The last connection recovers: completeness returns, data is intact.
    remoteAdapter.setFailing(false);
    await index.refreshAll();
    snapshot = await index.getSnapshot();
    expect(snapshot.freshnessByConnection['remote-1']).toMatchObject({ complete: true, stale: false });
    expect(snapshot.sessions).toHaveLength(3);
  });
});

describe('electron tunnel-active exit: broker dispose closes an active relay tunnel', () => {
  it('process shutdown disposes the relay adapter while a lease is still held', async () => {
    const encryption = await generateEcdhKeyPair();
    const serverId = 'phase6-relay-server';
    const tunnels = [];
    const adapter = createRelayProjectAdapter({
      connectionId: 'relay-1',
      createTunnelClient: (options) => {
        const tunnel = {
          options,
          closed: false,
          fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
          openEventStream: async () => new Response('data: ok\n\n', { status: 200 }),
          openWebSocket: () => ({ socket: {} }),
          close: () => { tunnel.closed = true; },
        };
        tunnels.push(tunnel);
        return tunnel;
      },
    });
    const broker = createConnectionBroker({ idleGraceMs: 60_000 });
    broker.registerAdapter(adapter);
    const context = {
      canonicalPath: '/remote/project',
      profile: { target: { kind: 'relay', relayId: serverId, credentialRef: 'credential-1' } },
      credentialProvider: {
        resolveCredential: async () => ({
          relay: {
            relayUrl: 'wss://relay.example.test',
            serverId,
            hostEncPubJwk: await exportPublicKeyJwk(encryption.publicKey),
          },
          token: 'private-token',
        }),
      },
    };

    // A lease is held and the tunnel is open: this is the shutdown-with-active
    // tunnel scenario. The idle grace has not elapsed.
    const release = broker.acquireLease('relay-1');
    const probe = await adapter.probe(context);
    expect(probe.ok).toBe(true);
    expect(tunnels).toHaveLength(1);
    expect(tunnels[0].closed).toBe(false);
    expect(broker.getLifecycleState('relay-1').leaseCount).toBe(1);

    // Shutdown: broker.dispose() must dispose the adapter immediately
    // (active lease), which closes the shared tunnel and its sockets.
    await broker.dispose();
    expect(tunnels[0].closed).toBe(true);
    expect(broker.getLifecycleState('relay-1')).toEqual({ state: 'idle', leaseCount: 0 });
    expect(release).toBeDefined();
  });
});
