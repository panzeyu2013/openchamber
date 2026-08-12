import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { selectSessionsForWorkspace, useWorkspaceSessionIndexStore } from './session-index-store';
import {
  CatalogClientError,
  type SourceFreshness,
  type WorkspaceSessionEvent,
  type WorkspaceSessionSnapshot,
  type WorkspaceSessionSummary,
} from './types';

let fetchSnapshotImpl: () => Promise<WorkspaceSessionSnapshot>;
const fetchSnapshotCalls: number[] = [];

mock.module('@/workspaces/session-index-client', () => ({
  fetchWorkspaceSessionSnapshot: async () => {
    fetchSnapshotCalls.push(1);
    return fetchSnapshotImpl();
  },
}));

const makeSession = (workspaceId: string, sessionId: string, overrides: Partial<WorkspaceSessionSummary> = {}): WorkspaceSessionSummary => ({
  key: `${workspaceId}\0${sessionId}`,
  workspaceId,
  connectionId: 'conn-1',
  upstreamSessionId: sessionId,
  directory: `/home/${workspaceId}`,
  title: `Session ${sessionId}`,
  updatedAt: 1000,
  archived: false,
  createdAt: 1000,
  ...overrides,
});

const makeFreshness = (overrides: Partial<SourceFreshness> = {}): SourceFreshness => ({
  complete: true,
  partial: false,
  offline: false,
  stale: false,
  lastSuccessAt: 1000,
  error: null,
  ...overrides,
});

const makeSnapshot = (
  revision: number,
  sessions: WorkspaceSessionSummary[],
  freshnessByConnection: Record<string, SourceFreshness> = {},
  truncatedByConnection?: Record<string, boolean>,
): WorkspaceSessionSnapshot => ({
  revision,
  sessions,
  freshnessByConnection,
  ...(truncatedByConnection ? { truncatedByConnection } : {}),
});

const makeEvent = (
  revision: number,
  type: WorkspaceSessionEvent['type'],
  payload: unknown,
  extra: Partial<WorkspaceSessionEvent> = {},
): WorkspaceSessionEvent => ({
  revision,
  connectionId: 'conn-1',
  workspaceId: 'ws-1',
  sessionId: 'ses-1',
  type,
  payload,
  ...extra,
});

/** Wraps the sessions array in a counting proxy: every property access is
 * recorded, so a reducer that scans the array (findIndex/map/filter/iterator)
 * is detectable. */
const makeCountingArrayProxy = (sessions: WorkspaceSessionSummary[], counters: Record<string, number>): WorkspaceSessionSummary[] => (
  new Proxy(sessions, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' || prop === Symbol.iterator) {
        const key = typeof prop === 'symbol' ? 'Symbol.iterator' : prop;
        counters[key] = (counters[key] ?? 0) + 1;
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as WorkspaceSessionSummary[]
);

describe('workspace session index store', () => {
  beforeEach(() => {
    fetchSnapshotCalls.length = 0;
    useWorkspaceSessionIndexStore.setState({
      snapshot: null,
      status: 'idle',
      lastError: null,
      lastAppliedRevision: 0,
      sessionKeys: new Set(),
      sessionIndex: new Map(),
      revisionGap: false,
    });
    fetchSnapshotImpl = async () => makeSnapshot(0, []);
  });

  test('refresh success replaces the snapshot and advances lastAppliedRevision', async () => {
    const snapshot = makeSnapshot(7, [makeSession('ws-1', 'ses-1')], { 'conn-1': makeFreshness() });
    fetchSnapshotImpl = async () => snapshot;

    await useWorkspaceSessionIndexStore.getState().refresh();

    const state = useWorkspaceSessionIndexStore.getState();
    expect(state.status).toBe('ready');
    expect(state.lastError).toBeNull();
    expect(state.snapshot).toBe(snapshot);
    expect(state.lastAppliedRevision).toBe(7);
    expect([...state.sessionKeys]).toEqual(['ws-1\0ses-1']);
    expect(state.revisionGap).toBe(false);
  });

  test('refresh failure keeps the previous snapshot and marks error', async () => {
    const snapshot = makeSnapshot(4, [makeSession('ws-1', 'ses-1')], { 'conn-1': makeFreshness() });
    fetchSnapshotImpl = async () => snapshot;
    await useWorkspaceSessionIndexStore.getState().refresh();
    const previous = useWorkspaceSessionIndexStore.getState().snapshot;

    fetchSnapshotImpl = async () => {
      throw new CatalogClientError('Index down', 503, 'session_index_http_error');
    };
    await useWorkspaceSessionIndexStore.getState().refresh();

    const state = useWorkspaceSessionIndexStore.getState();
    expect(state.status).toBe('error');
    expect(state.lastError).toBe('Index down');
    expect(state.snapshot).toBe(previous);
    expect(state.lastAppliedRevision).toBe(4);
    expect(state.snapshot).toEqual(snapshot);
  });

  test('a truncated refresh keeps sessions of truncated connections that the server cannot enumerate', async () => {
    const prior = makeSession('ws-1', 'ses-old', { connectionId: 'conn-1' });
    const priorOther = makeSession('ws-2', 'ses-old-2', { connectionId: 'conn-2' });
    fetchSnapshotImpl = async () => makeSnapshot(4, [prior, priorOther], { 'conn-1': makeFreshness(), 'conn-2': makeFreshness() });
    await useWorkspaceSessionIndexStore.getState().refresh();

    // The next snapshot is truncated for conn-1: ses-old is beyond the
    // limit (not in the new list) but still exists upstream — it must NOT
    // be dropped as if deleted. conn-2 is untruncated and authoritative.
    const newer = makeSession('ws-1', 'ses-new', { connectionId: 'conn-1', updatedAt: 2000 });
    fetchSnapshotImpl = async () => makeSnapshot(9, [newer], { 'conn-1': makeFreshness() }, { 'conn-1': true, 'conn-2': false });
    await useWorkspaceSessionIndexStore.getState().refresh();

    const state = useWorkspaceSessionIndexStore.getState();
    const keys = new Set(state.snapshot?.sessions.map((session) => session.key));
    expect(keys.has('ws-1\0ses-new')).toBe(true);
    // Preserved: truncated connection's unenumerated session.
    expect(keys.has('ws-1\0ses-old')).toBe(true);
    // Dropped: untruncated connection's removed session is authoritative.
    expect(keys.has('ws-2\0ses-old-2')).toBe(false);
    expect(state.lastAppliedRevision).toBe(9);
    expect(state.status).toBe('ready');
  });

  test('an untruncated refresh replaces the snapshot authoritatively', async () => {
    const prior = makeSession('ws-1', 'ses-old');
    fetchSnapshotImpl = async () => makeSnapshot(4, [prior], { 'conn-1': makeFreshness() });
    await useWorkspaceSessionIndexStore.getState().refresh();

    const newer = makeSession('ws-1', 'ses-new', { updatedAt: 2000 });
    fetchSnapshotImpl = async () => makeSnapshot(9, [newer], { 'conn-1': makeFreshness() }, { 'conn-1': false });
    await useWorkspaceSessionIndexStore.getState().refresh();

    const state = useWorkspaceSessionIndexStore.getState();
    expect(state.snapshot?.sessions.map((session) => session.key)).toEqual(['ws-1\0ses-new']);
  });

  test('applyEvent upsert inserts a new session and leaves other sessions untouched', async () => {
    const existing = makeSession('ws-1', 'ses-1');
    const snapshot = makeSnapshot(5, [existing], { 'conn-1': makeFreshness() });
    fetchSnapshotImpl = async () => snapshot;
    await useWorkspaceSessionIndexStore.getState().refresh();
    const before = useWorkspaceSessionIndexStore.getState().snapshot;

    const incoming = makeSession('ws-1', 'ses-2', { updatedAt: 2000 });
    useWorkspaceSessionIndexStore.getState().applyEvent(makeEvent(6, 'session.upserted', incoming));

    const state = useWorkspaceSessionIndexStore.getState();
    expect(state.lastAppliedRevision).toBe(6);
    expect(state.snapshot?.sessions).toEqual([existing, incoming]);
    expect(state.snapshot?.sessions[0]).toBe(existing);
    expect(state.snapshot?.freshnessByConnection).toBe(before?.freshnessByConnection);
    expect(state.sessionKeys.has('ws-1\0ses-2')).toBe(true);
  });

  test('applyEvent upsert replaces only the touched session (clone-on-write)', async () => {
    const first = makeSession('ws-1', 'ses-1');
    const second = makeSession('ws-1', 'ses-2');
    const snapshot = makeSnapshot(5, [first, second], { 'conn-1': makeFreshness() });
    fetchSnapshotImpl = async () => snapshot;
    await useWorkspaceSessionIndexStore.getState().refresh();

    const updated = makeSession('ws-1', 'ses-2', { title: 'Renamed', updatedAt: 3000 });
    useWorkspaceSessionIndexStore.getState().applyEvent(makeEvent(6, 'session.upserted', updated));

    const state = useWorkspaceSessionIndexStore.getState();
    expect(state.snapshot?.sessions[1]).toBe(updated);
    expect(state.snapshot?.sessions[0]).toBe(first);
    expect(state.snapshot?.sessions).toHaveLength(2);
    expect(state.sessionKeys.size).toBe(2);
  });

  test('applyEvent drops stale events with revision at or below lastAppliedRevision', async () => {
    fetchSnapshotImpl = async () => makeSnapshot(5, [makeSession('ws-1', 'ses-1')], { 'conn-1': makeFreshness() });
    await useWorkspaceSessionIndexStore.getState().refresh();
    const before = useWorkspaceSessionIndexStore.getState().snapshot;

    useWorkspaceSessionIndexStore.getState().applyEvent(makeEvent(5, 'session.upserted', makeSession('ws-1', 'ses-9')));
    useWorkspaceSessionIndexStore.getState().applyEvent(makeEvent(3, 'session.upserted', makeSession('ws-1', 'ses-9')));

    const state = useWorkspaceSessionIndexStore.getState();
    expect(state.snapshot).toBe(before);
    expect(state.lastAppliedRevision).toBe(5);
    expect(state.revisionGap).toBe(false);
  });

  test('applyEvent detects a revision gap, does not apply, and consumeRevisionGap clears it', async () => {
    fetchSnapshotImpl = async () => makeSnapshot(5, [makeSession('ws-1', 'ses-1')], { 'conn-1': makeFreshness() });
    await useWorkspaceSessionIndexStore.getState().refresh();
    const before = useWorkspaceSessionIndexStore.getState().snapshot;

    useWorkspaceSessionIndexStore.getState().applyEvent(makeEvent(8, 'session.upserted', makeSession('ws-1', 'ses-9')));

    const state = useWorkspaceSessionIndexStore.getState();
    expect(state.revisionGap).toBe(true);
    expect(state.status).toBe('ready');
    expect(state.snapshot).toBe(before);
    expect(state.lastAppliedRevision).toBe(5);
    expect(state.snapshot?.sessions.map((session) => session.key)).toEqual(['ws-1\0ses-1']);

    expect(useWorkspaceSessionIndexStore.getState().consumeRevisionGap()).toBe(true);
    expect(useWorkspaceSessionIndexStore.getState().consumeRevisionGap()).toBe(false);
  });

  test('applyEvent with no snapshot yet requires a resync instead of scaffolding', async () => {
    useWorkspaceSessionIndexStore.getState().applyEvent(makeEvent(1, 'session.upserted', makeSession('ws-1', 'ses-1')));
    const state = useWorkspaceSessionIndexStore.getState();
    expect(state.revisionGap).toBe(true);
    expect(state.snapshot).toBeNull();
    expect(state.lastAppliedRevision).toBe(0);
  });

  test('applyEvent freshness.changed updates only the touched connection', async () => {
    const conn1 = makeFreshness({ lastSuccessAt: 1000 });
    const conn2 = makeFreshness({ complete: false, stale: true, lastSuccessAt: 500, error: { code: 'x', message: 'y' } });
    fetchSnapshotImpl = async () => makeSnapshot(5, [makeSession('ws-1', 'ses-1')], { 'conn-1': conn1, 'conn-2': conn2 });
    await useWorkspaceSessionIndexStore.getState().refresh();
    const before = useWorkspaceSessionIndexStore.getState().snapshot;

    useWorkspaceSessionIndexStore.getState().applyEvent(
      makeEvent(6, 'freshness.changed', { complete: false, partial: true, stale: true }, { connectionId: 'conn-1' }),
    );

    const state = useWorkspaceSessionIndexStore.getState();
    expect(state.lastAppliedRevision).toBe(6);
    expect(state.snapshot?.freshnessByConnection['conn-1']).toEqual(
      makeFreshness({ complete: false, partial: true, stale: true, lastSuccessAt: 1000 }),
    );
    expect(state.snapshot?.freshnessByConnection['conn-2']).toBe(conn2);
    expect(state.snapshot?.sessions).toBe(before?.sessions);
  });

  test('applyEvent freshness.changed with no prior entry builds a default entry', async () => {
    fetchSnapshotImpl = async () => makeSnapshot(5, []);
    await useWorkspaceSessionIndexStore.getState().refresh();

    useWorkspaceSessionIndexStore.getState().applyEvent(
      makeEvent(6, 'freshness.changed', { complete: true }, { connectionId: 'conn-9' }),
    );

    const state = useWorkspaceSessionIndexStore.getState();
    expect(state.snapshot?.freshnessByConnection['conn-9']).toEqual(makeFreshness({ complete: true, lastSuccessAt: null }));
  });

  test('applyEvent session.removed removes exactly one session', async () => {
    const first = makeSession('ws-1', 'ses-1');
    const second = makeSession('ws-1', 'ses-2');
    const third = makeSession('ws-2', 'ses-3');
    fetchSnapshotImpl = async () => makeSnapshot(5, [first, second, third], { 'conn-1': makeFreshness() });
    await useWorkspaceSessionIndexStore.getState().refresh();
    const before = useWorkspaceSessionIndexStore.getState().snapshot;

    useWorkspaceSessionIndexStore.getState().applyEvent(
      makeEvent(6, 'session.removed', {}, { workspaceId: 'ws-1', sessionId: 'ses-2' }),
    );

    const state = useWorkspaceSessionIndexStore.getState();
    expect(state.lastAppliedRevision).toBe(6);
    expect(state.snapshot?.sessions).toEqual([first, third]);
    expect(state.snapshot?.sessions[0]).toBe(first);
    expect(state.sessionKeys.has('ws-1\0ses-2')).toBe(false);
    expect(state.sessionKeys.has('ws-1\0ses-1')).toBe(true);
    expect(state.snapshot?.freshnessByConnection).toBe(before?.freshnessByConnection);
  });

  describe('refresh/event reconciliation (ported from the retired global sessions store)', () => {
    test('a snapshot fetched before applied events never rolls them back', async () => {
      fetchSnapshotImpl = async () => makeSnapshot(10, [makeSession('ws-1', 'ses-old')], { 'conn-1': makeFreshness() });
      await useWorkspaceSessionIndexStore.getState().refresh();

      // An event lands while the NEXT snapshot fetch is in flight: the new
      // session is created (revision 11) and an old one deleted (revision 12).
      useWorkspaceSessionIndexStore.getState().applyEvent(makeEvent(11, 'session.upserted', makeSession('ws-1', 'ses-new', { updatedAt: 2000 }), { sessionId: 'ses-new' }));
      useWorkspaceSessionIndexStore.getState().applyEvent(makeEvent(12, 'session.removed', null, { workspaceId: 'ws-1', sessionId: 'ses-old' }));

      // The in-flight snapshot was captured at revision 10 (before the
      // events): committing it must not resurrect ses-old or drop ses-new.
      fetchSnapshotImpl = async () => makeSnapshot(10, [makeSession('ws-1', 'ses-old')], { 'conn-1': makeFreshness() });
      await useWorkspaceSessionIndexStore.getState().refresh();

      const state = useWorkspaceSessionIndexStore.getState();
      expect(state.status).toBe('ready');
      expect(state.lastAppliedRevision).toBe(12);
      const keys = new Set(state.snapshot?.sessions.map((session) => session.key));
      expect(keys.has('ws-1\0ses-new')).toBe(true);
      expect(keys.has('ws-1\0ses-old')).toBe(false);
    });

    test('a snapshot newer than applied events commits normally', async () => {
      fetchSnapshotImpl = async () => makeSnapshot(10, [makeSession('ws-1', 'ses-a')], { 'conn-1': makeFreshness() });
      await useWorkspaceSessionIndexStore.getState().refresh();

      useWorkspaceSessionIndexStore.getState().applyEvent(makeEvent(11, 'session.upserted', makeSession('ws-1', 'ses-b', { updatedAt: 2000 }), { sessionId: 'ses-b' }));

      fetchSnapshotImpl = async () => makeSnapshot(12, [makeSession('ws-1', 'ses-b', { updatedAt: 3000 })], { 'conn-1': makeFreshness() });
      await useWorkspaceSessionIndexStore.getState().refresh();

      const state = useWorkspaceSessionIndexStore.getState();
      expect(state.lastAppliedRevision).toBe(12);
      expect(state.snapshot?.sessions.map((session) => session.key)).toEqual(['ws-1\0ses-b']);
    });

    test('a failed refresh keeps commit-time state (failure is not empty)', async () => {
      fetchSnapshotImpl = async () => makeSnapshot(10, [makeSession('ws-1', 'ses-a')], { 'conn-1': makeFreshness() });
      await useWorkspaceSessionIndexStore.getState().refresh();

      useWorkspaceSessionIndexStore.getState().applyEvent(makeEvent(11, 'session.upserted', makeSession('ws-1', 'ses-b', { updatedAt: 2000 }), { sessionId: 'ses-b' }));

      fetchSnapshotImpl = async () => {
        throw new CatalogClientError('Index down', 503, 'session_index_http_error');
      };
      await useWorkspaceSessionIndexStore.getState().refresh();

      const state = useWorkspaceSessionIndexStore.getState();
      expect(state.status).toBe('error');
      expect(state.lastAppliedRevision).toBe(11);
      const keys = new Set(state.snapshot?.sessions.map((session) => session.key));
      expect(keys.has('ws-1\0ses-b')).toBe(true);
    });
  });

  test('selectSessionsForWorkspace filters by workspaceId and tolerates a null snapshot', () => {
    const snapshot = makeSnapshot(5, [
      makeSession('ws-1', 'ses-1'),
      makeSession('ws-2', 'ses-2'),
      makeSession('ws-1', 'ses-3'),
    ]);
    expect(selectSessionsForWorkspace(snapshot, 'ws-1').map((session) => session.upstreamSessionId)).toEqual(['ses-1', 'ses-3']);
    expect(selectSessionsForWorkspace(snapshot, 'ws-2').map((session) => session.upstreamSessionId)).toEqual(['ses-2']);
    expect(selectSessionsForWorkspace(null, 'ws-1')).toEqual([]);
  });

  describe('reducer work is proportional to the affected entity (performance budget §17.5)', () => {
    const seedLargeSnapshot = (counters: Record<string, number>, count = 5000) => {
      const sessions = Array.from({ length: count }, (_, i) => makeSession('ws-1', `ses-${i}`));
      const proxied = makeCountingArrayProxy(sessions, counters);
      fetchSnapshotImpl = async () => makeSnapshot(5, proxied, { 'conn-1': makeFreshness() });
      return sessions;
    };

    test('upsert of one existing session never scans or rebuilds other entries', async () => {
      const counters: Record<string, number> = {};
      const original = seedLargeSnapshot(counters);
      await useWorkspaceSessionIndexStore.getState().refresh();
      // Discard accesses performed while indexing the snapshot; the event
      // reducer below must not scan anything.
      Object.keys(counters).forEach((key) => { delete counters[key]; });
      const before = useWorkspaceSessionIndexStore.getState().snapshot;

      const updated = makeSession('ws-1', 'ses-2500', { title: 'Renamed', updatedAt: 9999 });
      useWorkspaceSessionIndexStore.getState().applyEvent(makeEvent(6, 'session.upserted', updated));

      const state = useWorkspaceSessionIndexStore.getState();
      expect(state.lastAppliedRevision).toBe(6);
      expect(state.snapshot?.sessions).toHaveLength(original.length);
      // Position preserved via the keyed index; no findIndex scan.
      expect(state.sessionIndex.get('ws-1\0ses-2500')).toBe(2500);
      // The touched entity is replaced; every other entry keeps its identity
      // and position (workspace A's event must not rebuild other entries).
      expect(state.snapshot?.sessions[2500]).toBe(updated);
      expect(state.snapshot?.sessions[2499]).toBe(original[2499]);
      expect(state.snapshot?.sessions[2501]).toBe(original[2501]);
      expect(state.snapshot?.sessions[0]).toBe(original[0]);
      expect(state.snapshot?.sessions[original.length - 1]).toBe(original[original.length - 1]);
      // Array scans are gone from the reducer: one slice for the rebuild.
      expect(counters.slice).toBe(1);
      expect(counters.findIndex).toBe(undefined);
      expect(counters.map).toBe(undefined);
      expect(counters.filter).toBe(undefined);
      expect(counters['Symbol.iterator']).toBe(undefined);
      // Clone-on-write: unrelated slices keep their identity.
      expect(state.snapshot?.freshnessByConnection).toBe(before?.freshnessByConnection);
      expect(state.snapshot?.sessions).not.toBe(before?.sessions);
    });

    test('upsert insert appends through the index without scanning', async () => {
      const counters: Record<string, number> = {};
      const original = seedLargeSnapshot(counters);
      await useWorkspaceSessionIndexStore.getState().refresh();
      Object.keys(counters).forEach((key) => { delete counters[key]; });

      const incoming = makeSession('ws-2', 'ses-new', { updatedAt: 9999 });
      useWorkspaceSessionIndexStore.getState().applyEvent(makeEvent(6, 'session.upserted', incoming));

      const state = useWorkspaceSessionIndexStore.getState();
      expect(state.snapshot?.sessions).toHaveLength(original.length + 1);
      expect(state.snapshot?.sessions[original.length]).toBe(incoming);
      expect(state.sessionIndex.get('ws-2\0ses-new')).toBe(original.length);
      expect(state.sessionKeys.has('ws-2\0ses-new')).toBe(true);
      expect(counters.findIndex).toBe(undefined);
      expect(counters.map).toBe(undefined);
      expect(counters.filter).toBe(undefined);
    });

    test('removal is membership-checked through the index and never filters the array', async () => {
      const counters: Record<string, number> = {};
      const original = seedLargeSnapshot(counters);
      await useWorkspaceSessionIndexStore.getState().refresh();
      Object.keys(counters).forEach((key) => { delete counters[key]; });

      useWorkspaceSessionIndexStore.getState().applyEvent(
        makeEvent(6, 'session.removed', {}, { workspaceId: 'ws-1', sessionId: 'ses-2500' }),
      );

      const state = useWorkspaceSessionIndexStore.getState();
      expect(state.lastAppliedRevision).toBe(6);
      expect(state.snapshot?.sessions).toHaveLength(original.length - 1);
      // Index positions after the removed entity are shifted down.
      expect(state.sessionIndex.get('ws-1\0ses-2501')).toBe(2500);
      expect(state.sessionIndex.has('ws-1\0ses-2500')).toBe(false);
      expect(state.sessionKeys.has('ws-1\0ses-2500')).toBe(false);
      // Only the removed entry disappears; the rest keep identity and order.
      expect(state.snapshot?.sessions[2499]).toBe(original[2499]);
      expect(state.snapshot?.sessions[2500]).toBe(original[2501]);
      expect(state.snapshot?.sessions[0]).toBe(original[0]);
      expect(counters.filter).toBe(undefined);
      expect(counters.findIndex).toBe(undefined);
      expect(counters.map).toBe(undefined);
    });
  });
});
