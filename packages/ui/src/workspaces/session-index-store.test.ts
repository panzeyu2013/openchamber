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
  upstreamSessionId: sessionId,
  directory: `/home/${workspaceId}`,
  title: `Session ${sessionId}`,
  updatedAt: 1000,
  archived: false,
  ...overrides,
});

const makeFreshness = (overrides: Partial<SourceFreshness> = {}): SourceFreshness => ({
  complete: true,
  stale: false,
  lastSuccessAt: 1000,
  error: null,
  ...overrides,
});

const makeSnapshot = (
  revision: number,
  sessions: WorkspaceSessionSummary[],
  freshnessByConnection: Record<string, SourceFreshness> = {},
): WorkspaceSessionSnapshot => ({ revision, sessions, freshnessByConnection });

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

describe('workspace session index store', () => {
  beforeEach(() => {
    fetchSnapshotCalls.length = 0;
    useWorkspaceSessionIndexStore.setState({
      snapshot: null,
      status: 'idle',
      lastError: null,
      lastAppliedRevision: 0,
      sessionKeys: new Set(),
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
      makeEvent(6, 'freshness.changed', { complete: false, stale: true }, { connectionId: 'conn-1' }),
    );

    const state = useWorkspaceSessionIndexStore.getState();
    expect(state.lastAppliedRevision).toBe(6);
    expect(state.snapshot?.freshnessByConnection['conn-1']).toEqual(
      makeFreshness({ complete: false, stale: true, lastSuccessAt: 1000 }),
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
});
