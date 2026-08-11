import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCatalogStore } from './catalog-store.js';
import { createConnectionProfileStore } from './connection-profile-store.js';
import { createSessionBindingStore } from './session-binding-store.js';
import {
  createSeededRandom,
  createSessionIndex,
  parseSessionIndexEvent,
  withBackoffJitter,
} from './session-index.js';
import { workspaceSessionKey } from './workspace-identity.js';

const fsPromises = fs.promises;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const jsonResponse = (payload, status = 200, extraHeaders = {}) => new Response(
  JSON.stringify(payload),
  { status, headers: { 'content-type': 'application/json', ...extraHeaders } },
);

const sseChunk = (payload) => `data: ${JSON.stringify(payload)}\n\n`;

/** An SSE response that yields the given events once, then closes; later
 * streams stay open (no reconnect churn) so tests stay deterministic. */
const streamSseResponse = (events) => new Response(new ReadableStream({
  start(controller) {
    const encoder = new TextEncoder();
    for (const event of events) controller.enqueue(encoder.encode(sseChunk(event)));
    controller.close();
  },
}), { status: 200, headers: { 'content-type': 'text/event-stream' } });

/** A response whose body never ends and never yields: a quiet observer. */
const openResponse = () => new Response(new ReadableStream({}), { status: 200 });

const createFakeAdapter = (options = {}) => {
  const calls = { fetch: [], openEventStream: [] };
  const adapter = {
    connectionId: options.connectionId ?? 'local',
    capabilities: { pathBrowse: true, terminal: true, files: true, git: true, eventStream: true },
    calls,
    async fetch(context, request, restPath) {
      calls.fetch.push({ context, request, restPath });
      if (options.fetch) return options.fetch(context, request, restPath);
      return jsonResponse(options.sessions ?? []);
    },
    async openEventStream(context, restPath, signal) {
      calls.openEventStream.push({ context, restPath, signal });
      if (options.events && calls.openEventStream.length === 1) {
        return streamSseResponse(options.events);
      }
      return openResponse();
    },
  };
  return adapter;
};

const createFakeBroker = ({ profileStore, adapters }) => {
  const calls = { resolveConnection: [], acquireLease: [], releases: 0 };
  return {
    calls,
    async resolveConnection(connectionId) {
      calls.resolveConnection.push(connectionId);
      const adapter = adapters[connectionId];
      if (!adapter) return null;
      const profile = await profileStore.getPrivateRecord(connectionId);
      return { profile, adapter };
    },
    acquireLease(connectionId) {
      calls.acquireLease.push(connectionId);
      return () => { calls.releases += 1; };
    },
  };
};

const createSessionPayload = (overrides) => ({
  id: 'ses-1',
  title: 'Session One',
  directory: '/projects/a',
  time: { updated: 100 },
  ...overrides,
});

let tempDir;
let catalogStore;
let profileStore;
let bindingStore;
let index;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-index-test-'));
  catalogStore = createCatalogStore({
    fs: fsPromises,
    path,
    filePath: path.join(tempDir, 'workspace-catalog.json'),
  });
  await catalogStore.load();
  profileStore = createConnectionProfileStore({
    fs: fsPromises,
    filePath: path.join(tempDir, 'connection-profiles.json'),
  });
  await profileStore.load();
  bindingStore = createSessionBindingStore({
    fs: fsPromises,
    filePath: path.join(tempDir, 'workspace-session-bindings.json'),
  });
  await bindingStore.load();
});

afterEach(async () => {
  await index?.dispose();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const createWorkspace = async (canonicalPath, label) => {
  const outcome = await catalogStore.createWorkspace({
    connectionId: 'local',
    canonicalPath,
    path: canonicalPath,
    label,
    color: null,
    orderKey: '',
  });
  return outcome.descriptor;
};

const createIndex = (adapters, options = {}) => {
  const connectionBroker = createFakeBroker({ profileStore, adapters });
  index = createSessionIndex({ catalogStore, profileStore, connectionBroker, bindingStore, ...options });
  return { index, connectionBroker };
};

describe('snapshot mapping', () => {
  it('maps sessions to workspaces by exact canonical path and buckets the rest as unassigned', async () => {
    const workspaceA = await createWorkspace('/projects/a', 'A');
    const workspaceB = await createWorkspace('/projects/b', 'B');
    const adapter = createFakeAdapter({
      sessions: [
        createSessionPayload({ id: 'ses-1', title: 'One', directory: '/projects/a', time: { updated: 300 } }),
        createSessionPayload({ id: 'ses-2', title: 'Two', directory: '/projects/b', time: { updated: 200 } }),
        createSessionPayload({ id: 'ses-3', title: 'Three', directory: '/projects/other', time: { updated: 100 } }),
        createSessionPayload({ id: 'ses-4', title: 'Four', directory: '/projects/a/', time: { updated: 50 } }),
      ],
    });
    const { index } = createIndex({ local: adapter });

    await index.refreshConnection('local');

    const snapshot = await index.getSnapshot();
    expect(snapshot.revision).toBe(1);
    expect(snapshot.sessions).toHaveLength(3);
    const byId = Object.fromEntries(snapshot.sessions.map((session) => [session.upstreamSessionId, session]));
    expect(byId['ses-1']).toMatchObject({
      workspaceId: workspaceA.id,
      directory: '/projects/a',
      title: 'One',
      updatedAt: 300,
      archived: false,
      activity: 'idle',
    });
    expect(byId['ses-2'].workspaceId).toBe(workspaceB.id);
    expect(byId['ses-4'].workspaceId).toBe(workspaceA.id);

    const diagnostics = await index.getDiagnostics();
    expect(diagnostics.connections.local).toMatchObject({
      sessionCount: 3,
      unassignedCount: 1,
      truncated: false,
      observed: false,
    });
    expect(adapter.calls.fetch[0].restPath).toBe('/api/experimental/session?archived=false&limit=500');
  });
});

describe('binding precedence', () => {
  it('an explicit binding wins over an exact-path match', async () => {
    const workspaceA = await createWorkspace('/projects/a', 'A');
    const workspaceB = await createWorkspace('/projects/b', 'B');
    await bindingStore.bindSession({
      connectionId: 'local',
      upstreamSessionId: 'ses-1',
      workspaceId: workspaceB.id,
      source: 'explicit',
    });
    const adapter = createFakeAdapter({
      sessions: [
        createSessionPayload({ id: 'ses-1', directory: '/projects/a' }),
      ],
    });
    const { index } = createIndex({ local: adapter });

    await index.refreshConnection('local');

    const snapshot = await index.getSnapshot();
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0].workspaceId).toBe(workspaceB.id);
    expect((await index.getDiagnostics()).connections.local.unassignedCount).toBe(0);
    expect(workspaceA.id).not.toBe(workspaceB.id);
  });
});

describe('failure handling', () => {
  it('keeps the prior snapshot and marks the connection stale when a refresh fails', async () => {
    await createWorkspace('/projects/a', 'A');
    const adapter = createFakeAdapter({
      sessions: [
        createSessionPayload({ id: 'ses-1', directory: '/projects/a' }),
        createSessionPayload({ id: 'ses-2', directory: '/projects/a', time: { updated: 50 } }),
      ],
    });
    const { index } = createIndex({ local: adapter });

    await index.refreshConnection('local');
    expect((await index.getSnapshot()).sessions).toHaveLength(2);

    adapter.fetch = async () => { throw new Error('boom'); };
    await expect(index.refreshConnection('local')).rejects.toThrow('boom');

    const snapshot = await index.getSnapshot();
    expect(snapshot.sessions).toHaveLength(2);
    expect(snapshot.freshnessByConnection.local).toEqual({
      complete: false,
      partial: false,
      offline: false,
      stale: true,
      lastSuccessAt: expect.any(Number),
      error: { code: 'session_index_fetch_failed', message: 'Session index fetch failed' },
    });
  });

  it('stores and logs safe freshness errors without upstream URLs or credentials', async () => {
    await createWorkspace('/projects/a', 'A');
    const logs = [];
    const secretUrl = 'https://remote.example.test/api?clientToken=super-secret';
    const adapter = createFakeAdapter({
      events: [{ type: 'session.updated', properties: { sessionID: 'ses-1' } }],
      sessions: [createSessionPayload({ id: 'ses-1', directory: '/projects/a' })],
    });
    let fetchCalls = 0;
    adapter.fetch = async () => {
      fetchCalls += 1;
      if (fetchCalls > 1) {
        const error = new Error(`request failed at ${secretUrl}`);
        error.code = 'direct_unreachable';
        throw error;
      }
      return jsonResponse([createSessionPayload({ id: 'ses-1', directory: '/projects/a' })]);
    };
    const { index } = createIndex({ local: adapter }, { logger: { log: (_message, detail) => logs.push(detail) } });

    await index.refreshConnection('local');
    await index.ensureObserved('local');
    await sleep(400);

    const snapshot = await index.getSnapshot();
    expect(JSON.stringify(snapshot)).not.toContain(secretUrl);
    expect(JSON.stringify(snapshot)).not.toContain('super-secret');
    expect(logs.join(' ')).not.toContain(secretUrl);
    expect(logs.join(' ')).not.toContain('super-secret');
    expect(snapshot.freshnessByConnection.local.error).toEqual({
      code: 'direct_unreachable',
      message: 'Session index is unavailable',
    });
  });

  it('one connection failing never blocks or clears another connection', async () => {
    await createWorkspace('/projects/a', 'A');
    await profileStore.upsertConnection({
      id: 'broken',
      label: 'Broken',
      target: { kind: 'direct', baseUrl: 'https://example.com' },
    });
    const localAdapter = createFakeAdapter({
      sessions: [
        createSessionPayload({ id: 'ses-1', directory: '/projects/a' }),
      ],
    });
    const brokenAdapter = createFakeAdapter({ fetch: async () => { throw new Error('down'); } });
    const { index } = createIndex({ local: localAdapter, broken: brokenAdapter });

    const results = await index.refreshAll();

    expect(Object.keys(results).sort()).toEqual(['broken', 'local']);
    const snapshot = await index.getSnapshot();
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.freshnessByConnection.local.complete).toBe(true);
    expect(snapshot.freshnessByConnection.broken.complete).toBe(false);
    expect(snapshot.freshnessByConnection.broken.partial).toBe(false);
    expect(snapshot.freshnessByConnection.broken.offline).toBe(true);
    expect(snapshot.freshnessByConnection.broken.stale).toBe(false);
    expect(snapshot.freshnessByConnection.broken.error.code).toBe('session_index_fetch_failed');
  });
});

describe('snapshot pagination and partial coverage', () => {
  it('walks x-next-cursor pages and only marks the source complete after the final page', async () => {
    const workspace = await createWorkspace('/projects/a', 'A');
    const pages = [
      [createSessionPayload({ id: 'ses-1', directory: workspace.canonicalPath })],
      [createSessionPayload({ id: 'ses-2', directory: workspace.canonicalPath, time: { updated: 200 } })],
    ];
    const adapter = createFakeAdapter({
      fetch: async (_context, _request, restPath) => {
        const cursor = new URL(`http://session-index.test${restPath}`).searchParams.get('cursor');
        const page = cursor ? pages[1] : pages[0];
        return jsonResponse(page, 200, cursor ? {} : { 'x-next-cursor': 'page-2' });
      },
    });
    const { index } = createIndex({ local: adapter });

    await index.refreshConnection('local');

    const snapshot = await index.getSnapshot();
    expect(snapshot.sessions.map((session) => session.upstreamSessionId).sort()).toEqual(['ses-1', 'ses-2']);
    expect(snapshot.freshnessByConnection.local).toMatchObject({ complete: true, partial: false, stale: false });
    expect(snapshot.truncatedByConnection.local).toBe(false);
    expect(adapter.calls.fetch.map((call) => call.restPath)).toEqual([
      '/api/experimental/session?archived=false&limit=500',
      '/api/experimental/session?archived=false&limit=500&cursor=page-2',
    ]);
  });

  it('keeps enumerated data and marks a bounded cursor walk partial', async () => {
    const workspace = await createWorkspace('/projects/a', 'A');
    const adapter = createFakeAdapter({
      fetch: async (_context, _request, restPath) => {
        const cursor = new URL(`http://session-index.test${restPath}`).searchParams.get('cursor');
        const pageNumber = cursor ? Number(cursor) : 0;
        return jsonResponse(
          [createSessionPayload({ id: `ses-${pageNumber}`, directory: workspace.canonicalPath, time: { updated: pageNumber } })],
          200,
          { 'x-next-cursor': String(pageNumber + 1) },
        );
      },
    });
    const { index } = createIndex({ local: adapter });

    await index.refreshConnection('local');

    const snapshot = await index.getSnapshot();
    expect(adapter.calls.fetch).toHaveLength(20);
    expect(snapshot.sessions).toHaveLength(20);
    expect(snapshot.freshnessByConnection.local).toMatchObject({ complete: false, partial: true, stale: false });
    expect(snapshot.truncatedByConnection.local).toBe(true);
  });
});

describe('revision coordination', () => {
  it('starts at 0, bumps on change, and stays put for an identical no-op refresh', async () => {
    await createWorkspace('/projects/a', 'A');
    const payload = [
      createSessionPayload({ id: 'ses-1', directory: '/projects/a', time: { updated: 100 } }),
      createSessionPayload({ id: 'ses-2', directory: '/projects/a', time: { updated: 50 } }),
    ];
    const adapter = createFakeAdapter({ sessions: payload });
    const { index } = createIndex({ local: adapter });

    expect((await index.getSnapshot()).revision).toBe(0);

    await index.refreshConnection('local');
    expect((await index.getSnapshot()).revision).toBe(1);

    await index.refreshConnection('local');
    expect((await index.getSnapshot()).revision).toBe(1);

    payload.push(createSessionPayload({ id: 'ses-3', directory: '/projects/a', time: { updated: 10 } }));
    await index.refreshConnection('local');
    expect((await index.getSnapshot()).revision).toBe(2);
  });

  it('emits incremental upserts and removals when a structural refresh changes the snapshot', async () => {
    await createWorkspace('/projects/a', 'A');
    let fetchCalls = 0;
    const adapter = createFakeAdapter({
      sessions: [
        createSessionPayload({ id: 'ses-old', directory: '/projects/a', title: 'Old' }),
        createSessionPayload({ id: 'ses-keep', directory: '/projects/a', title: 'Keep' }),
      ],
    });
    adapter.fetch = async () => {
      fetchCalls += 1;
      return jsonResponse(fetchCalls === 1
        ? [
          createSessionPayload({ id: 'ses-old', directory: '/projects/a', title: 'Old' }),
          createSessionPayload({ id: 'ses-keep', directory: '/projects/a', title: 'Keep' }),
        ]
        : [
          createSessionPayload({ id: 'ses-keep', directory: '/projects/a', title: 'Renamed', time: { updated: 20 } }),
          createSessionPayload({ id: 'ses-new', directory: '/projects/a', title: 'New' }),
        ]);
    };
    const { index } = createIndex({ local: adapter });
    await index.refreshConnection('local');
    const events = [];
    index.subscribeEvents((event) => events.push(event));

    await index.refreshConnection('local');

    expect(events.map((event) => event.type)).toEqual([
      'session.removed',
      'session.upserted',
      'session.upserted',
    ]);
    expect(events.map((event) => event.revision)).toEqual([2, 3, 4]);
    expect(events[0]).toMatchObject({ workspaceId: expect.any(String), sessionId: 'ses-old' });
    expect(events[1]).toMatchObject({ sessionId: 'ses-keep', payload: { title: 'Renamed', updatedAt: 20 } });
    expect(events[2]).toMatchObject({ sessionId: 'ses-new', payload: { title: 'New' } });
    expect((await index.getSnapshot()).revision).toBe(4);
  });
});

describe('live activity via the event stream', () => {
  it('coalesces concurrent observation requests into one upstream stream', async () => {
    const adapter = createFakeAdapter();
    const { index } = createIndex({ local: adapter });

    await Promise.all([
      index.ensureObserved('local'),
      index.ensureObserved('local'),
    ]);

    expect(adapter.calls.openEventStream).toHaveLength(1);
    await index.dispose();
  });

  it('holds one connection lease for the observer lifetime and releases it on dispose', async () => {
    const adapter = createFakeAdapter();
    const { index, connectionBroker } = createIndex({ local: adapter });

    await index.ensureObserved('local');
    expect(connectionBroker.calls.acquireLease).toEqual(['local']);
    expect(connectionBroker.calls.releases).toBe(0);

    await index.dispose();
    expect(connectionBroker.calls.releases).toBe(1);
  });

  it('updates session activity and emits session.upserted when the observer sees a session.status event', async () => {
    const workspaceA = await createWorkspace('/projects/a', 'A');
    const adapter = createFakeAdapter({
      sessions: [
        createSessionPayload({ id: 'ses-1', directory: '/projects/a' }),
        createSessionPayload({ id: 'ses-2', directory: '/projects/a' }),
      ],
      events: [{ type: 'session.status', properties: { sessionID: 'ses-1', status: { type: 'busy' } } }],
    });
    const { index } = createIndex({ local: adapter });
    const events = [];
    index.subscribeEvents((event) => events.push(event));

    await index.refreshConnection('local');
    await index.ensureObserved('local');
    await sleep(100);

    const snapshot = await index.getSnapshot();
    const byId = Object.fromEntries(snapshot.sessions.map((session) => [session.upstreamSessionId, session]));
    expect(byId['ses-1'].activity).toBe('busy');
    expect(byId['ses-2'].activity).toBe('idle');

    const upserts = events.filter((event) => event.type === 'session.upserted');
    expect(upserts).toHaveLength(1);
    expect(upserts[0].revision).toBeGreaterThanOrEqual(1);
    expect(upserts[0]).toMatchObject({
      sessionId: 'ses-1',
      workspaceId: workspaceA.id,
      payload: { activity: 'busy' },
    });
    expect(upserts[0].payload.activity).toBe('busy');
  });

  it('structural events trigger a debounced snapshot refresh that removes the session', async () => {
    await createWorkspace('/projects/a', 'A');
    let fetchCalls = 0;
    const adapter = createFakeAdapter({
      events: [{ type: 'session.deleted', properties: { sessionID: 'ses-1' } }],
    });
    adapter.fetch = async () => {
      fetchCalls += 1;
      return jsonResponse(fetchCalls === 1
        ? [
          createSessionPayload({ id: 'ses-1', directory: '/projects/a' }),
          createSessionPayload({ id: 'ses-2', directory: '/projects/a' }),
        ]
        : [createSessionPayload({ id: 'ses-2', directory: '/projects/a' })]);
    };
    const { index } = createIndex({ local: adapter });

    await index.refreshConnection('local');
    expect((await index.getSnapshot()).sessions).toHaveLength(2);

    await index.ensureObserved('local');
    await sleep(700);

    expect(fetchCalls).toBe(2);
    const snapshot = await index.getSnapshot();
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0].upstreamSessionId).toBe('ses-2');
  });

  it('emits a revisioned stale freshness event when the upstream stream closes', async () => {
    await createWorkspace('/projects/a', 'A');
    const adapter = createFakeAdapter({
      sessions: [createSessionPayload({ id: 'ses-1', directory: '/projects/a' })],
    });
    const originalOpenEventStream = adapter.openEventStream;
    let streamCalls = 0;
    adapter.openEventStream = async (...args) => {
      streamCalls += 1;
      if (streamCalls === 1) return streamSseResponse([]);
      return originalOpenEventStream(...args);
    };
    const { index } = createIndex({ local: adapter });
    const events = [];
    index.subscribeEvents((event) => events.push(event));

    await index.refreshConnection('local');
    await index.ensureObserved('local');
    await sleep(40);

    const snapshot = await index.getSnapshot();
    expect(snapshot.freshnessByConnection.local).toMatchObject({ complete: true, partial: false, stale: true });
    expect(events.some((event) => event.type === 'freshness.changed' && event.payload.stale === true)).toBe(true);
  });
});

describe('parseSessionIndexEvent', () => {
  it('maps session.status to sessionId/activity', () => {
    expect(parseSessionIndexEvent({
      payload: { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } },
    })).toEqual({ sessionId: 's1', activity: 'busy' });
    expect(parseSessionIndexEvent({
      payload: { type: 'session.status', properties: { sessionID: 's1', status: { type: 'retry' } } },
    })).toEqual({ sessionId: 's1', activity: 'retry' });
    expect(parseSessionIndexEvent({
      payload: { type: 'session.status', properties: { sessionID: 's1', status: { type: 'waiting' } } },
    })).toEqual({ sessionId: 's1', activity: 'idle' });
  });

  it('accepts a bare event without the payload wrapper', () => {
    expect(parseSessionIndexEvent({ type: 'session.status', properties: { sessionId: 's2', status: { type: 'busy' } } }))
      .toEqual({ sessionId: 's2', activity: 'busy' });
  });

  it('falls back to info.id when sessionID is absent', () => {
    expect(parseSessionIndexEvent({
      payload: { type: 'session.status', properties: { info: { id: 's3' }, status: { type: 'busy' } } },
    })).toEqual({ sessionId: 's3', activity: 'busy' });
  });

  it('maps session.created/updated/deleted to structural events', () => {
    expect(parseSessionIndexEvent({ payload: { type: 'session.created', properties: { sessionID: 's1' } } }))
      .toEqual({ sessionId: 's1', structural: 'created' });
    expect(parseSessionIndexEvent({ payload: { type: 'session.updated', properties: { sessionID: 's1' } } }))
      .toEqual({ sessionId: 's1', structural: 'updated' });
    expect(parseSessionIndexEvent({ payload: { type: 'session.deleted', properties: { sessionID: 's1' } } }))
      .toEqual({ sessionId: 's1', structural: 'deleted' });
  });

  it('returns null for non-session events and malformed input', () => {
    expect(parseSessionIndexEvent({ payload: { type: 'message.part.delta', properties: { sessionID: 's1' } } })).toBeNull();
    expect(parseSessionIndexEvent(null)).toBeNull();
    expect(parseSessionIndexEvent(undefined)).toBeNull();
    expect(parseSessionIndexEvent({})).toBeNull();
    expect(parseSessionIndexEvent({ payload: {} })).toBeNull();
    expect(parseSessionIndexEvent({ payload: { type: 'session.status' } })).toBeNull();
    expect(parseSessionIndexEvent({ payload: { type: 'session.status', properties: { status: { type: 'busy' } } } })).toBeNull();
  });
});

describe('indexed activity events (performance budget §17.5)', () => {
  it('one status event touches a constant number of sessions regardless of collection size', async () => {
    const workspaceA = await createWorkspace('/projects/a', 'A');
    const N = 10_000;
    const sessions = [];
    for (let i = 0; i < N; i += 1) {
      sessions.push(createSessionPayload({ id: `ses-${i}`, directory: '/projects/a', title: `Session ${i}`, time: { updated: i } }));
    }
    let streamController = null;
    const adapter = createFakeAdapter({ sessions });
    adapter.openEventStream = async () => new Response(new ReadableStream({
      start(controller) { streamController = controller; },
    }), { status: 200 });
    const { index } = createIndex({ local: adapter });
    const events = [];
    index.subscribeEvents((event) => events.push(event));

    await index.refreshConnection('local');
    const state = index._getStateForTest('local');
    expect(state.sessions.size).toBe(N);

    // Instrument the canonical map (never iterated by the indexed path) and
    // the upstream-session index (looked up instead of scanning). The map
    // itself cannot be wrapped in a Proxy (Map.prototype methods require the
    // Map internal slot), so iteration is counted by shadowing the own
    // Symbol.iterator with a counting generator.
    let sessionIterations = 0;
    state.sessions[Symbol.iterator] = function* iterator() {
      sessionIterations += 1;
      yield* Map.prototype[Symbol.iterator].call(this);
    };
    let indexLookups = 0;
    const rawIndex = state.sessionsByUpstreamId;
    state.sessionsByUpstreamId = new Proxy(rawIndex, {
      get(target, prop) {
        if (prop === 'get') {
          return (sessionId) => {
            indexLookups += 1;
            return target.get(sessionId);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await index.ensureObserved('local');
    await sleep(20);
    expect(streamController).not.toBeNull();
    const revisionBefore = (await index.getSnapshot()).revision;

    streamController.enqueue(new TextEncoder().encode(sseChunk({
      type: 'session.status',
      properties: { sessionID: 'ses-0', status: { type: 'busy' } },
    })));

    const deadline = Date.now() + 2000;
    while (events.filter((event) => event.type === 'session.upserted').length === 0) {
      if (Date.now() > deadline) throw new Error('timed out waiting for the activity event');
      await sleep(5);
    }

    const snapshot = await index.getSnapshot();
    expect(snapshot.sessions).toHaveLength(N);
    const byId = Object.fromEntries(snapshot.sessions.map((session) => [session.upstreamSessionId, session]));
    expect(byId['ses-0'].activity).toBe('busy');
    expect(byId['ses-1'].activity).toBe('idle');
    expect(byId['ses-5000'].activity).toBe('idle');
    expect(byId['ses-9999'].activity).toBe('idle');

    const upserts = events.filter((event) => event.type === 'session.upserted');
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      sessionId: 'ses-0',
      workspaceId: workspaceA.id,
      payload: { activity: 'busy' },
    });
    // Exactly one entity was touched: one index lookup, one map get/set, one
    // revision bump — the sessions collection was never scanned.
    expect((await index.getSnapshot()).revision).toBe(revisionBefore + 1);
    expect(indexLookups).toBe(1);
    expect(sessionIterations).toBe(0);
    expect(rawIndex.get('ses-0')).toEqual(new Set([workspaceSessionKey(workspaceA.id, 'ses-0')]));
  });
});

describe('bounded refresh concurrency (performance budget §17.5)', () => {
  const registerConnection = async (id) => {
    await profileStore.upsertConnection({
      id,
      label: id,
      target: { kind: 'direct', baseUrl: `https://${id}.example.test` },
    });
  };

  const createSlowAdapters = (ids, delayMs, options = {}) => {
    // Shared gauge: concurrency is measured ACROSS adapters, not per
    // adapter (each connection's fetch runs exactly once per pass).
    const gauge = { active: 0, maxActive: 0 };
    const adapters = {};
    for (const id of ids) {
      const adapter = createFakeAdapter();
      let fetchCount = 0;
      adapter.fetch = async () => {
        fetchCount += 1;
        gauge.active += 1;
        gauge.maxActive = Math.max(gauge.maxActive, gauge.active);
        try {
          if (options.fail === id) throw new Error(`down (${id})`);
          await sleep(delayMs);
          return jsonResponse([]);
        } finally {
          gauge.active -= 1;
        }
      };
      adapter.calls.fetchCount = () => fetchCount;
      adapters[id] = adapter;
    }
    return { adapters, gauge };
  };

  it('caps concurrent refreshes at the default 4 and drains the queue', async () => {
    const ids = ['local'];
    for (let i = 0; i < 7; i += 1) ids.push(`conn-${i}`);
    for (const id of ids) await registerConnection(id);
    const { adapters, gauge } = createSlowAdapters(ids, 30);
    const { index } = createIndex(adapters);

    const results = await index.refreshAll();

    expect(gauge.maxActive).toBe(4);
    expect(Object.keys(results).sort()).toEqual(Object.keys(adapters).sort());
    for (const id of Object.keys(adapters)) {
      expect(adapters[id].calls.fetchCount()).toBe(1);
      expect((await index.getSnapshot()).freshnessByConnection[id].complete).toBe(true);
      expect(results[id]).toEqual({ ok: true });
    }
  });

  it('the concurrency cap is injectable', async () => {
    const ids = ['local'];
    for (let i = 0; i < 4; i += 1) ids.push(`conn-${i}`);
    for (const id of ids) await registerConnection(id);
    const { adapters, gauge } = createSlowAdapters(ids, 20);
    const { index } = createIndex(adapters, { refreshConcurrency: 2 });

    await index.refreshAll();

    expect(gauge.maxActive).toBe(2);
    const snapshot = await index.getSnapshot();
    for (const id of Object.keys(adapters)) expect(snapshot.freshnessByConnection[id].complete).toBe(true);
  });

  it('a failing refresh under the cap never blocks other connections from completing', async () => {
    const ids = ['local'];
    for (let i = 0; i < 5; i += 1) ids.push(`conn-${i}`);
    for (const id of ids) await registerConnection(id);
    const { adapters, gauge } = createSlowAdapters(ids, 20, { fail: 'conn-2' });
    const { index } = createIndex(adapters);

    const results = await index.refreshAll();

    expect(gauge.maxActive).toBeLessThanOrEqual(4);
    const snapshot = await index.getSnapshot();
    for (const id of Object.keys(adapters)) {
      if (id === 'conn-2') {
        expect(results[id]).toEqual({ ok: false });
        expect(snapshot.freshnessByConnection[id]).toMatchObject({
          complete: false,
          offline: true,
          stale: false,
        });
        expect(snapshot.freshnessByConnection[id].error.code).toBe('session_index_fetch_failed');
      } else {
        expect(results[id]).toEqual({ ok: true });
        expect(snapshot.freshnessByConnection[id].complete).toBe(true);
        expect(snapshot.freshnessByConnection[id].stale).toBe(false);
      }
    }
  });
});

describe('backoff jitter (performance budget §17.5)', () => {
  it('keeps every jittered delay inside the 1s→60s bounds', () => {
    expect(withBackoffJitter(1000, 0)).toBe(1000);
    expect(withBackoffJitter(1000, 1)).toBe(1200);
    expect(withBackoffJitter(5000, 0)).toBe(4000);
    expect(withBackoffJitter(5000, 0.5)).toBe(5000);
    expect(withBackoffJitter(5000, 1)).toBe(6000);
    expect(withBackoffJitter(60000, 1)).toBe(60000);
    for (const base of [1000, 2500, 10000, 60000]) {
      for (const randomValue of [0, 0.1, 0.33, 0.5, 0.9, 1]) {
        const delay = withBackoffJitter(base, randomValue);
        expect(delay).toBeGreaterThanOrEqual(1000);
        expect(delay).toBeLessThanOrEqual(60000);
      }
    }
  });

  it('is deterministic per seed and differs across seeds and attempts', () => {
    const first = createSeededRandom(7);
    const second = createSeededRandom(7);
    for (let i = 0; i < 5; i += 1) expect(first()).toBe(second());

    const randA = createSeededRandom(1);
    const scheduleA = Array.from({ length: 20 }, () => withBackoffJitter(4000, randA()));
    const randB = createSeededRandom(2);
    const scheduleB = Array.from({ length: 20 }, () => withBackoffJitter(4000, randB()));
    expect(new Set(scheduleA).size).toBeGreaterThan(1);
    expect(scheduleA.some((delay, i) => delay !== scheduleB[i])).toBe(true);
    for (const delay of [...scheduleA, ...scheduleB]) {
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(60000);
    }
  });
});
