import { create } from 'zustand';
import { fleetSessionKey, type FleetLiveSessionState, type FleetSessionActivity } from './types';

type FleetLiveState = {
  sessions: Map<string, FleetLiveSessionState>;
  serverRevisions: Map<string, number>;
  applySessionState: (input: Omit<FleetLiveSessionState, 'updatedAt' | 'activityUpdatedAt' | 'pendingUpdatedAt' | 'stale'> & {
    updatedAt?: number;
    activityUpdatedAt?: number;
    pendingUpdatedAt?: number;
  }) => void;
  replaceServerSnapshot: (
    serverId: string,
    inputs: Array<Omit<FleetLiveSessionState, 'serverId' | 'updatedAt' | 'activityUpdatedAt' | 'pendingUpdatedAt' | 'stale'> & { updatedAt?: number }>,
    snapshotStartedAt: number,
  ) => void;
  markServerStale: (serverId: string) => void;
  reconcileServerSessions: (serverId: string, sessionIds: ReadonlySet<string>) => void;
  removeSession: (serverId: string, sessionId: string) => void;
  removeServer: (serverId: string) => void;
};

const sameState = (left: FleetLiveSessionState, right: FleetLiveSessionState): boolean =>
  left.activity === right.activity
  && left.hasPendingPermission === right.hasPendingPermission
  && left.hasPendingQuestion === right.hasPendingQuestion
  && left.stale === right.stale
  && left.updatedAt === right.updatedAt
  && left.activityUpdatedAt === right.activityUpdatedAt
  && left.pendingUpdatedAt === right.pendingUpdatedAt;

const incrementServerRevision = (revisions: Map<string, number>, serverId: string): Map<string, number> => {
  const next = new Map(revisions);
  next.set(serverId, (next.get(serverId) ?? 0) + 1);
  return next;
};

/**
 * Side-channel state for non-active runtimes. It is never a source of message,
 * permission payload, or session-list truth; opening a session always resets
 * through the active runtime and retrieves authoritative state there.
 */
export const useFleetLiveStore = create<FleetLiveState>()((set) => ({
  sessions: new Map(),
  serverRevisions: new Map(),
  applySessionState: (input) => set((state) => {
    const key = fleetSessionKey(input.serverId, input.sessionId);
    const previous = state.sessions.get(key);
    const observedAt = input.updatedAt ?? Date.now();
    const next: FleetLiveSessionState = {
      ...input,
      updatedAt: observedAt,
      activityUpdatedAt: input.activityUpdatedAt ?? observedAt,
      pendingUpdatedAt: input.pendingUpdatedAt ?? observedAt,
      stale: false,
    };
    // Late events cannot overwrite a newer observation for the same server.
    if (previous && previous.updatedAt > next.updatedAt) return state;
    if (previous && sameState(previous, next)) return state;
    const sessions = new Map(state.sessions);
    sessions.set(key, next);
    return { sessions, serverRevisions: incrementServerRevision(state.serverRevisions, input.serverId) };
  }),
  replaceServerSnapshot: (serverId, inputs, snapshotStartedAt) => set((state) => {
    const incomingIds = new Set(inputs.map((input) => input.sessionId));
    let sessions: Map<string, FleetLiveSessionState> | null = null;
    const mutable = () => sessions ??= new Map(state.sessions);

    // Omitted entries are authoritative only if they were not observed after
    // this request began. This preserves a session introduced by a concurrent
    // SSE event while still pruning genuinely deleted old state.
    for (const [key, value] of state.sessions) {
      if (
        value.serverId === serverId
        && !incomingIds.has(value.sessionId)
        && value.updatedAt < snapshotStartedAt
      ) mutable().delete(key);
    }
    for (const input of inputs) {
      const key = fleetSessionKey(serverId, input.sessionId);
      const previous = (sessions ?? state.sessions).get(key);
      const activityUpdatedAt = previous?.activityUpdatedAt && previous.activityUpdatedAt >= snapshotStartedAt
        ? previous.activityUpdatedAt
        : snapshotStartedAt;
      const pendingUpdatedAt = previous?.pendingUpdatedAt && previous.pendingUpdatedAt >= snapshotStartedAt
        ? previous.pendingUpdatedAt
        : snapshotStartedAt;
      const next: FleetLiveSessionState = {
        ...input,
        serverId,
        activity: previous && previous.activityUpdatedAt >= snapshotStartedAt ? previous.activity : input.activity,
        hasPendingPermission: previous && previous.pendingUpdatedAt >= snapshotStartedAt
          ? previous.hasPendingPermission
          : input.hasPendingPermission,
        hasPendingQuestion: previous && previous.pendingUpdatedAt >= snapshotStartedAt
          ? previous.hasPendingQuestion
          : input.hasPendingQuestion,
        updatedAt: Math.max(input.updatedAt ?? snapshotStartedAt, activityUpdatedAt, pendingUpdatedAt),
        activityUpdatedAt,
        pendingUpdatedAt,
        stale: false,
      };
      if (previous && sameState(previous, next)) continue;
      mutable().set(key, next);
    }
    return sessions ? { sessions, serverRevisions: incrementServerRevision(state.serverRevisions, serverId) } : state;
  }),
  markServerStale: (serverId) => set((state) => {
    let changed = false;
    const sessions = new Map(state.sessions);
    for (const [key, value] of sessions) {
      if (value.serverId !== serverId || value.stale) continue;
      sessions.set(key, { ...value, stale: true });
      changed = true;
    }
    return changed ? { sessions, serverRevisions: incrementServerRevision(state.serverRevisions, serverId) } : state;
  }),
  reconcileServerSessions: (serverId, sessionIds) => set((state) => {
    const sessions = new Map(state.sessions);
    for (const [key, value] of sessions) {
      if (value.serverId === serverId && !sessionIds.has(value.sessionId)) sessions.delete(key);
    }
    return sessions.size === state.sessions.size
      ? state
      : { sessions, serverRevisions: incrementServerRevision(state.serverRevisions, serverId) };
  }),
  removeSession: (serverId, sessionId) => set((state) => {
    const key = fleetSessionKey(serverId, sessionId);
    if (!state.sessions.has(key)) return state;
    const sessions = new Map(state.sessions);
    sessions.delete(key);
    return { sessions, serverRevisions: incrementServerRevision(state.serverRevisions, serverId) };
  }),
  removeServer: (serverId) => set((state) => {
    const sessions = new Map(state.sessions);
    for (const [key, value] of sessions) {
      if (value.serverId === serverId) sessions.delete(key);
    }
    return sessions.size === state.sessions.size
      ? state
      : { sessions, serverRevisions: incrementServerRevision(state.serverRevisions, serverId) };
  }),
}));

export const fleetActivityFromSessionStatus = (value: unknown): FleetSessionActivity => {
  if (value === 'busy' || value === 'retry' || value === 'error') return value;
  return 'idle';
};
