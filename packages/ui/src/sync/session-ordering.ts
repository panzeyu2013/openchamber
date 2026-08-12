import { create } from 'zustand';
import type { Session } from '@opencode-ai/sdk/v2';
import { isSessionPinned } from '@/stores/useSessionPinnedStore';
import { normalizePath } from '@/lib/pathNormalization';

type SessionActivityPhase = 'active' | 'settled';

type SessionOrderingState = {
  scopeKey: string;
  rankById: Map<string, number>;
  bindScope: (scopeKey: string) => void;
};

type SessionOrderingScope = {
  phaseById: Map<string, SessionActivityPhase>;
  baselineRankById: Map<string, { created?: number; updated?: number }>;
  rankById: Map<string, number>;
};

export const EMPTY_SESSION_ORDER_RANKS: ReadonlyMap<string, number> = new Map();

const scopeStates = new Map<string, SessionOrderingScope>();
let lastRank = 0;

const normalizeScopeKey = (scopeKey: string): string => scopeKey.trim();

const createScopeState = (): SessionOrderingScope => ({
  phaseById: new Map(),
  baselineRankById: new Map(),
  rankById: new Map(),
});

const readScopeState = (scopeKey: string): SessionOrderingScope => {
  const existing = scopeStates.get(scopeKey);
  if (existing) return existing;
  const created = createScopeState();
  scopeStates.set(scopeKey, created);
  return created;
};

export const useSessionOrderingStore = create<SessionOrderingState>((set, get) => {
  const scopeKey = "";
  const scope = readScopeState(scopeKey);

  return {
    scopeKey,
    rankById: scope.rankById,
    bindScope: (nextScopeKey) => {
      const normalizedScopeKey = normalizeScopeKey(nextScopeKey);
      const current = get();
      const currentScope = readScopeState(current.scopeKey);
      currentScope.rankById = current.rankById;
      if (current.scopeKey === normalizedScopeKey) return;
      const nextScope = readScopeState(normalizedScopeKey);
      set({ scopeKey: normalizedScopeKey, rankById: nextScope.rankById });
    },
  };
});

useSessionOrderingStore.subscribe((state, previous) => {
  if (state.scopeKey !== previous.scopeKey || state.rankById !== previous.rankById) {
    readScopeState(state.scopeKey).rankById = state.rankById;
  }
});

const nextRank = (): number => {
  lastRank = Math.max(lastRank + 1, Date.now());
  return lastRank;
};

const promoteSessions = (scopeKey: string, sessionIds: Iterable<string>, useSharedRank = false): void => {
  const ids = [...sessionIds];
  if (ids.length === 0) return;

  const scope = readScopeState(scopeKey);
  const rankById = new Map(scope.rankById);
  const sharedRank = useSharedRank ? nextRank() : null;
  for (const sessionId of ids) {
    rankById.set(sessionId, sharedRank ?? nextRank());
  }
  scope.rankById = rankById;
  if (useSessionOrderingStore.getState().scopeKey === scopeKey) {
    useSessionOrderingStore.setState({ rankById });
  }
};

export const observeSessionActivityEvent = (
  sessionId: string,
  phase: SessionActivityPhase,
  scopeKey?: string,
): void => {
  const targetScopeKey = normalizeScopeKey(scopeKey ?? useSessionOrderingStore.getState().scopeKey);
  const scope = readScopeState(targetScopeKey);
  const previous = scope.phaseById.get(sessionId);
  scope.phaseById.set(sessionId, phase);

  if (previous === phase) return;
  if (previous === undefined && phase === 'settled') return;
  promoteSessions(targetScopeKey, [sessionId]);
};

export const reconcileSessionActivitySnapshot = (
  activeSessionIds: Iterable<string>,
  knownSessionIds: Iterable<string>,
  scopeKey?: string,
): void => {
  const targetScopeKey = normalizeScopeKey(scopeKey ?? useSessionOrderingStore.getState().scopeKey);
  const scope = readScopeState(targetScopeKey);
  const active = new Set(activeSessionIds);
  const observed = new Set([...knownSessionIds, ...active]);
  const promoted: string[] = [];

  for (const sessionId of observed) {
    const phase: SessionActivityPhase = active.has(sessionId) ? 'active' : 'settled';
    const previous = scope.phaseById.get(sessionId);
    scope.phaseById.set(sessionId, phase);
    if (previous !== undefined && previous !== phase) promoted.push(sessionId);
  }

  // A snapshot cannot recover the order of missed transitions. Give the batch
  // one rank and let authoritative timestamps break ties deterministically.
  promoteSessions(targetScopeKey, promoted, true);
};

export const removeSessionOrdering = (sessionId: string, scopeKey?: string): void => {
  const targetScopeKey = normalizeScopeKey(scopeKey ?? useSessionOrderingStore.getState().scopeKey);
  const scope = readScopeState(targetScopeKey);
  scope.phaseById.delete(sessionId);
  scope.baselineRankById.delete(sessionId);
  if (!scope.rankById.has(sessionId)) return;
  const rankById = new Map(scope.rankById);
  rankById.delete(sessionId);
  scope.rankById = rankById;
  if (useSessionOrderingStore.getState().scopeKey === targetScopeKey) {
    useSessionOrderingStore.setState({ rankById });
  }
};

export const resetSessionOrdering = (scopeKey?: string): void => {
  const targetScopeKey = normalizeScopeKey(scopeKey ?? useSessionOrderingStore.getState().scopeKey);
  scopeStates.set(targetScopeKey, createScopeState());
  lastRank = 0;
  if (useSessionOrderingStore.getState().scopeKey === targetScopeKey) {
    useSessionOrderingStore.setState({ rankById: new Map() });
  }
};

const finiteTime = (value: unknown): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : 0
);

const updatedAt = (session: Session): number => (
  finiteTime(session.time?.updated) || finiteTime(session.time?.created)
);

const createdAt = (session: Session): number => finiteTime(session.time?.created);

const parentIdOf = (session: Session): string | null => (
  (session as Session & { parentID?: string | null }).parentID ?? null
);

const sessionDirectory = (session: Session): string | null => {
  const record = session as Session & {
    directory?: string | null;
    project?: { worktree?: string | null } | null;
  };
  return normalizePath(record.directory ?? null) ?? normalizePath(record.project?.worktree ?? null);
};

const baselineRank = (session: Session, pinned: boolean, scope: SessionOrderingScope): number => {
  const existing = scope.baselineRankById.get(session.id);
  const key = pinned ? 'created' : 'updated';
  const existingRank = existing?.[key];
  if (existingRank !== undefined) return existingRank;
  const rank = pinned ? createdAt(session) : updatedAt(session);
  scope.baselineRankById.set(session.id, { ...existing, [key]: rank });
  return rank;
};

/**
 * Raise cached baselines to the sessions' current authoritative timestamps.
 *
 * The frozen baseline keeps live metadata churn from reordering an open list,
 * but a client that slept through a session's whole active→settled cycle never
 * saw the transition that would have promoted its live rank — so its stale
 * baseline pins it in place forever. Call this when an authoritative session
 * SNAPSHOT arrives (global refresh); monotonic, so it can never demote.
 */
export const raiseSessionOrderingBaselines = (sessions: Iterable<Session>, scopeKey?: string): void => {
  const targetScopeKey = normalizeScopeKey(scopeKey ?? useSessionOrderingStore.getState().scopeKey);
  const scope = readScopeState(targetScopeKey);
  const currentRanks = scope.rankById;
  let nextRanks: Map<string, number> | null = null;
  let baselinesChanged = false;

  for (const session of sessions) {
    const fresh = updatedAt(session);
    const liveRank = currentRanks.get(session.id);
    if (liveRank !== undefined) {
      // A live rank frozen BEFORE this newer authoritative stamp is stale —
      // the session was active again while this client wasn't watching (its
      // transition events never arrived, e.g. another device + sleep). Ranks
      // share the epoch-ms scale with `updated`, so raising is well-ordered.
      if (fresh > liveRank) {
        nextRanks = nextRanks ?? new Map(currentRanks);
        nextRanks.set(session.id, fresh);
      }
      continue;
    }
    const existing = scope.baselineRankById.get(session.id);
    if (existing?.updated !== undefined && existing.updated >= fresh) continue;
    scope.baselineRankById.set(session.id, { ...existing, updated: fresh });
    baselinesChanged = true;
  }

  if (nextRanks) {
    scope.rankById = nextRanks;
    if (useSessionOrderingStore.getState().scopeKey === targetScopeKey) {
      useSessionOrderingStore.setState({ rankById: nextRanks });
    }
  } else if (baselinesChanged) {
    // Baselines live outside the store; nudge subscribers so open lists re-sort.
    if (useSessionOrderingStore.getState().scopeKey === targetScopeKey) {
      useSessionOrderingStore.setState((state) => ({ rankById: new Map(state.rankById) }));
    }
  }
};

export const getSessionLifecycleOrderValue = (
  session: Session,
  rankById: ReadonlyMap<string, number>,
  pinned = false,
  scopeKey?: string,
): number => rankById.get(session.id) ?? baselineRank(
  session,
  pinned,
  readScopeState(normalizeScopeKey(scopeKey ?? useSessionOrderingStore.getState().scopeKey)),
);

export const compareSessionsByLifecycleOrder = (
  left: Session,
  right: Session,
  pinnedSessionIds: Set<string>,
  rankById: ReadonlyMap<string, number>,
  scopeKey?: string,
): number => {
  const targetScopeKey = normalizeScopeKey(scopeKey ?? useSessionOrderingStore.getState().scopeKey);
  const scope = readScopeState(targetScopeKey);
  const leftPinned = isSessionPinned(pinnedSessionIds, sessionDirectory(left), left.id);
  const rightPinned = isSessionPinned(pinnedSessionIds, sessionDirectory(right), right.id);
  if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;

  const leftFallback = baselineRank(left, leftPinned, scope);
  const rightFallback = baselineRank(right, rightPinned, scope);
  if (parentIdOf(left) === parentIdOf(right)) {
    const rankDelta = getSessionLifecycleOrderValue(right, rankById, rightPinned, targetScopeKey)
      - getSessionLifecycleOrderValue(left, rankById, leftPinned, targetScopeKey);
    if (rankDelta !== 0) return rankDelta;
  }

  const baselineDelta = rightFallback - leftFallback;
  if (baselineDelta !== 0) return baselineDelta;
  const createdDelta = baselineRank(right, true, scope) - baselineRank(left, true, scope);
  if (createdDelta !== 0) return createdDelta;
  return left.id.localeCompare(right.id);
};

export const orderSessionsByLifecycleScopes = (
  sessions: Session[],
  pinnedSessionIds: Set<string>,
  rankById: ReadonlyMap<string, number>,
): Session[] => {
  const sessionIds = new Set(sessions.map((session) => session.id));
  const roots: Session[] = [];
  const childrenByParent = new Map<string, Session[]>();

  for (const session of sessions) {
    const parentId = parentIdOf(session);
    if (!parentId || !sessionIds.has(parentId)) {
      roots.push(session);
      continue;
    }

    const siblings = childrenByParent.get(parentId);
    if (siblings) {
      siblings.push(session);
    } else {
      childrenByParent.set(parentId, [session]);
    }
  }

  const compare = (left: Session, right: Session) => (
    compareSessionsByLifecycleOrder(left, right, pinnedSessionIds, rankById)
  );
  roots.sort(compare);
  for (const siblings of childrenByParent.values()) {
    siblings.sort(compare);
  }

  const ordered: Session[] = [];
  const visited = new Set<string>();
  const append = (session: Session): void => {
    if (visited.has(session.id)) return;
    visited.add(session.id);
    ordered.push(session);
    for (const child of childrenByParent.get(session.id) ?? []) {
      append(child);
    }
  };
  for (const root of roots) {
    append(root);
  }
  for (const session of sessions) {
    append(session);
  }
  return ordered;
};
