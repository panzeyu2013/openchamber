import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCatalogStore } from './catalog-store.js';
import { createConnectionProfileStore } from './connection-profile-store.js';
import { createSessionBindingStore } from './session-binding-store.js';
import { createSessionIndex, parseSessionIndexEvent } from './session-index.js';

const fsPromises = fs.promises;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const jsonResponse = (payload, status = 200) => new Response(
  JSON.stringify(payload),
  { status, headers: { 'content-type': 'application/json' } },
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

const createIndex = (adapters) => {
  const connectionBroker = createFakeBroker({ profileStore, adapters });
  index = createSessionIndex({ catalogStore, profileStore, connectionBroker, bindingStore });
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
      stale: true,
      lastSuccessAt: expect.any(Number),
      error: { code: 'session_index_fetch_failed', message: 'boom' },
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
    expect(snapshot.freshnessByConnection.broken.stale).toBe(false);
    expect(snapshot.freshnessByConnection.broken.error.code).toBe('session_index_fetch_failed');
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
});

describe('live activity via the event stream', () => {
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
