import { useCallback } from 'react';
import { create } from 'zustand';
import { getSafeStorage } from '@/stores/utils/safeStorage';

// Per-session turn timing behind the sidebar activity readout.
//
// The OpenCode status contract carries no timestamps — `SessionStatus` is a
// bare `busy | retry | idle` union — so how long the current turn has been
// running has to be measured on the client. This module owns that measurement
// and is driven from the same two write paths as `global-session-status`, the
// index rows actually render their live state from, so a row can never count a
// turn that index calls idle.
//
// Two maps with deliberately different lifetimes:
//
// - `startedAt` — sessions observed active right now. Persisted, so reloading
//   the page resumes the same count instead of restarting it at zero.
// - `settledMs` — how long the turn that just finished took. In memory only:
//   rows show it while the session is unread, and unread state itself does not
//   survive a reload, so persisting it would outlive its only consumer.
//
// A persisted start is a lookup table, never a claim of activity. Nothing in
// the protocol marks where a turn begins: the server calls `SessionStatus.set`
// with `busy` at every step of the agent loop and publishes an event each time,
// so a busy event means "still running", not "just started" — it cannot be read
// as a turn boundary, and reading it that way reset every counter on reload,
// because after a refresh one of those repeats almost always beats the first
// status snapshot.
//
// Turn *ends* are marked: `session.idle` and `session.error` events fire once,
// live, and retire the persisted record.
//
// That leaves the case with no observable answer at all: a turn that ended, and
// another that began, entirely while the tab was gone. Two bounds stand in for
// the evidence the client cannot have:
//
// - a liveness stamp beside the start, refreshed while the session is observed
//   active and stamped precisely as the page hides, compared against this page's
//   navigation start — how long the app was actually absent;
// - an adoption window after load, after which unclaimed records are discarded,
//   which backstops a runtime whose event stream is down and where snapshots are
//   therefore the only signal.
//
// Nothing else may drop a persisted start. Status snapshots legitimately arrive
// before they can see a session as busy — bootstrap fetches status and sessions
// in parallel, directory scopes resolve at different times — and treating one
// of those as "the turn ended" destroyed the start moments before the real busy
// snapshot arrived, which is exactly the reload-resets-to-zero bug. Absence of
// evidence is not evidence here; only the two bounds above expire a record.

type SessionActivityPhase = 'active' | 'settled';


type SessionActivityTimingState = {
  scopeKey: string;
  startedAt: ReadonlyMap<string, number>;
  settledMs: ReadonlyMap<string, number>;
  bindScope: (scopeKey: string) => void;
};

type SessionActivityScope = {
  startedAt: Map<string, number>;
  settledMs: Map<string, number>;
  liveSeen: Map<string, number>;
  restoredStarts: Map<string, PersistedStart> | null;
  lastPersistAt: number;
};

/** Persisted per session: when this turn began, and when it was last alive. */
type PersistedStart = { start: number; seen: number };

/** Finished turns worth remembering at once; each row only needs its own. */
const SETTLED_LIMIT = 200;
/** A turn running longer than this is treated as a stale record, not a turn. */
const MAX_TURN_AGE_MS = 24 * 60 * 60 * 1000;
/**
 * How long the app may have been gone and still have its counters resumed,
 * measured from the liveness stamp to this page's navigation start — not to
 * "now". Bootstrap latency belongs to this page, not to the absence, and this
 * client has seen 20-second startups; charging those to the gap would refuse
 * a legitimate resume on exactly the slowest machines.
 */
const MAX_AWAY_MS = 30_000;
/** Refresh the persisted stamp at most this often during a long turn. */
const LIVENESS_PERSIST_INTERVAL_MS = 15_000;
/**
 * How long after page load a persisted record may still be adopted. Past this
 * point the app has certainly seen live status, so a record nothing claimed
 * describes a turn that is over — and a turn starting later is a new one that
 * must count from zero.
 */
const RESTORE_ADOPTION_WINDOW_MS = 90_000;
const STORAGE_KEY = 'oc.session-activity.v1';

const EMPTY_ACTIVE: ReadonlySet<string> = new Set();
const EMPTY_RESTORED: ReadonlyMap<string, PersistedStart> = new Map();

const scopeStates = new Map<string, SessionActivityScope>();

const normalizeScopeKey = (scopeKey: string): string => scopeKey.trim();

const createScopeState = (): SessionActivityScope => ({
  startedAt: new Map(),
  settledMs: new Map(),
  liveSeen: new Map(),
  restoredStarts: null,
  lastPersistAt: 0,
});

const readScopeState = (scopeKey: string): SessionActivityScope => {
  const existing = scopeStates.get(scopeKey);
  if (existing) return existing;
  const created = createScopeState();
  scopeStates.set(scopeKey, created);
  return created;
};

const currentScopeKey = (): string => useSessionActivityTimingStore.getState().scopeKey;

export const useSessionActivityTimingStore = create<SessionActivityTimingState>((set, get) => {
  const scopeKey = "";
  const scope = readScopeState(scopeKey);

  return {
    scopeKey,
    startedAt: scope.startedAt,
    settledMs: scope.settledMs,
    bindScope: (nextScopeKey) => {
      const normalizedScopeKey = normalizeScopeKey(nextScopeKey);
      const current = get();
      const currentScope = readScopeState(current.scopeKey);
      currentScope.startedAt = current.startedAt as Map<string, number>;
      currentScope.settledMs = current.settledMs as Map<string, number>;
      if (current.scopeKey === normalizedScopeKey) return;
      const nextScope = readScopeState(normalizedScopeKey);
      set({
        scopeKey: normalizedScopeKey,
        startedAt: nextScope.startedAt,
        settledMs: nextScope.settledMs,
      });
    },
  };
});

useSessionActivityTimingStore.subscribe((state, previous) => {
  if (state.scopeKey !== previous.scopeKey || state.startedAt !== previous.startedAt || state.settledMs !== previous.settledMs) {
    const scope = readScopeState(state.scopeKey);
    scope.startedAt = state.startedAt as Map<string, number>;
    scope.settledMs = state.settledMs as Map<string, number>;
  }
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Epoch ms of this page's navigation start; the reference for "how long gone". */
const readPageLoadAt = (): number => {
  if (typeof performance !== 'undefined' && Number.isFinite(performance.timeOrigin)) {
    return performance.timeOrigin;
  }
  return Date.now();
};

let pageLoadAt = readPageLoadAt();

const isResumable = (entry: PersistedStart, now: number): boolean => (
  entry.start <= now
  && now - entry.start <= MAX_TURN_AGE_MS
  && entry.seen <= now
  // Negative when this page wrote the stamp itself, which is trivially fresh.
  && pageLoadAt - entry.seen <= MAX_AWAY_MS
);

const parseEntry = (value: unknown): PersistedStart | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { start, seen } = value as { start?: unknown; seen?: unknown };
  if (typeof start !== 'number' || !Number.isFinite(start)) return null;
  if (typeof seen !== 'number' || !Number.isFinite(seen)) return null;
  return { start, seen };
};

const readPersistedPayload = (): Record<string, unknown> => {
  let raw: string | null = null;
  try {
    raw = getSafeStorage().getItem(STORAGE_KEY);
  } catch {
    return {};
  }
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    // Malformed payload is a failed read, not authoritative "no turns were
    // running": live status re-seeds every counter from now either way.
    return {};
  }
};

let persistedPayload: Record<string, unknown> | null = null;

const storageKeyFor = (scopeKey: string, sessionId: string): string => (
  JSON.stringify([scopeKey, sessionId])
);

const decodeStorageKey = (key: string): { scopeKey: string; sessionId: string } | null => {
  try {
    const parsed = JSON.parse(key) as unknown;
    if (
      Array.isArray(parsed)
      && parsed.length === 2
      && typeof parsed[0] === 'string'
      && typeof parsed[1] === 'string'
    ) {
      return { scopeKey: parsed[0], sessionId: parsed[1] };
    }
  } catch {
    // Legacy bare session IDs are handled by the caller.
  }
  return null;
};

const readRestoredStarts = (scopeKey: string): Map<string, PersistedStart> => {
  const restored = new Map<string, PersistedStart>();
  persistedPayload ??= readPersistedPayload();

  const now = Date.now();
  for (const [key, value] of Object.entries(persistedPayload)) {
    const decoded = decodeStorageKey(key);
    const sessionId = decoded?.scopeKey === scopeKey
      ? decoded.sessionId
      : null;
    if (!sessionId) continue;
    const entry = parseEntry(value);
    // Rejects stale turns, quiet stamps, and clock-skewed futures rather than
    // rendering a counter that reads days long or negative.
    if (entry && isResumable(entry, now)) restored.set(sessionId, entry);
  }
  return restored;
};

const getRestoredStarts = (scopeKey: string): Map<string, PersistedStart> => {
  const scope = readScopeState(scopeKey);
  scope.restoredStarts ??= readRestoredStarts(scopeKey);
  return scope.restoredStarts;
};

/**
 * Restored records still eligible to be adopted. Past the adoption window they
 * are dropped for good, so a turn that starts later counts from zero instead of
 * inheriting the start of whatever ran before the reload.
 */
const getAdoptableStarts = (scopeKey: string, now: number): ReadonlyMap<string, PersistedStart> => {
  const restoredStarts = getRestoredStarts(scopeKey);
  if (now - pageLoadAt > RESTORE_ADOPTION_WINDOW_MS) {
    restoredStarts.clear();
    return EMPTY_RESTORED;
  }
  return restoredStarts;
};

// Live starts merged over restored-but-unconfirmed ones, so a reload landing
// before the first authoritative snapshot does not drop the starts that
// snapshot is about to confirm. Restored entries whose stamp has gone quiet are
// dropped here, which is the only way they leave storage.
const persistStarts = (scopeKey: string, startedAt: ReadonlyMap<string, number>, now: number): void => {
  const payload = { ...(persistedPayload ??= readPersistedPayload()) };
  const restoredStarts = getRestoredStarts(scopeKey);
  for (const key of Object.keys(payload)) {
    const decoded = decodeStorageKey(key);
    if (decoded?.scopeKey === scopeKey) {
      delete payload[key];
    }
  }
  for (const [sessionId, entry] of restoredStarts) {
    if (isResumable(entry, now)) payload[storageKeyFor(scopeKey, sessionId)] = entry;
  }
  for (const [sessionId, start] of startedAt) {
    const scope = readScopeState(scopeKey);
    payload[storageKeyFor(scopeKey, sessionId)] = { start, seen: scope.liveSeen.get(sessionId) ?? now };
  }

  readScopeState(scopeKey).lastPersistAt = now;
  persistedPayload = payload;
  try {
    const storage = getSafeStorage();
    if (Object.keys(payload).length === 0) {
      storage.removeItem(STORAGE_KEY);
      return;
    }
    storage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Storage is unavailable or full; counters simply restart after a reload.
  }
};

// The most accurate liveness stamp available: the page is going away and every
// running turn was still running as of now. Writes are immediate (not deferred)
// so this cannot lose the race against a deferred flush on the same event.
const stampLiveness = (): void => {
  const now = Date.now();
  for (const [scopeKey, scope] of scopeStates) {
    if (scope.startedAt.size === 0) continue;
    for (const sessionId of scope.startedAt.keys()) scope.liveSeen.set(sessionId, now);
    persistStarts(scopeKey, scope.startedAt, now);
  }
};

let lifecycleHooked = false;

const ensureLivenessStampOnHide = (): void => {
  if (lifecycleHooked || typeof window === 'undefined') return;
  lifecycleHooked = true;
  try {
    // `pagehide` covers unload and bfcache entry; `visibilitychange`/`freeze`
    // cover backgrounding and are the reliable ones in WKWebView. No
    // `beforeunload` — it would cost bfcache for a stamp the others already
    // wrote.
    window.addEventListener('pagehide', stampLiveness, { capture: true });
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') stampLiveness();
      });
      document.addEventListener('freeze', stampLiveness);
    }
  } catch {
    // Restricted environments can reject listeners; the periodic stamp refresh
    // still bounds how quiet a running turn's record can get.
  }
};

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

const trimSettled = (settled: Map<string, number>): void => {
  while (settled.size > SETTLED_LIMIT) {
    const oldest = settled.keys().next();
    if (oldest.done) return;
    settled.delete(oldest.value);
  }
};

/**
 * What ends a turn in this pass. An event names its session outright; a snapshot
 * only answers whether it covers a given one — deliberately the cheaper
 * question, since the settle loop walks running turns rather than session lists.
 * An `event` idle is a live, one-shot "this turn is over"; a snapshot omitting a
 * session is not, because it may simply not see it yet.
 */
type SettleInput =
  | { source: 'event'; sessionId: string }
  | { source: 'snapshot'; isCovered: (sessionId: string) => boolean };

const applyTransitions = (
  activeSessionIds: ReadonlySet<string>,
  settle: SettleInput | null,
  scopeKey?: string,
): void => {
  const targetScopeKey = normalizeScopeKey(scopeKey ?? currentScopeKey());
  const scope = readScopeState(targetScopeKey);
  const now = Date.now();
  const restored = getAdoptableStarts(targetScopeKey, now);
  const state = {
    startedAt: scope.startedAt,
    settledMs: scope.settledMs,
  };

  const next: { started: Map<string, number> | null; settled: Map<string, number> | null } = {
    started: null,
    settled: null,
  };
  let sawActive = false;
  let restoredChanged = false;

  const draftStarted = (): Map<string, number> => (next.started ??= new Map(state.startedAt));
  const draftSettled = (): Map<string, number> => (next.settled ??= new Map(state.settledMs));

  for (const sessionId of activeSessionIds) {
    sawActive = true;
    scope.liveSeen.set(sessionId, now);
    if ((next.started ?? state.startedAt).has(sessionId)) continue;
    // Busy carries no turn boundary from either source: the server re-publishes
    // `session.status: busy` on every step of the agent loop, so a busy event
    // means "still running", not "just started". Both paths therefore prefer a
    // persisted start when one survives; only the bounds below expire it.
    draftStarted().set(sessionId, restored.get(sessionId)?.start ?? now);
    if ((next.settled ?? state.settledMs).has(sessionId)) draftSettled().delete(sessionId);
  }

  const settleTurn = (sessionId: string, start: number): void => {
    draftStarted().delete(sessionId);
    scope.liveSeen.delete(sessionId);
    draftSettled().set(sessionId, Math.max(0, now - start));
  };

  if (settle === null) {
    // Nothing ends this pass.
  } else if (settle.source === 'event') {
    // An idle/error event is a live, unambiguous end of turn, so it also retires
    // the persisted record. A snapshot's silence is not: it may simply not see
    // the session yet.
    if (getRestoredStarts(targetScopeKey).delete(settle.sessionId)) restoredChanged = true;
    const start = state.startedAt.get(settle.sessionId);
    // Only a turn watched from its start yields a duration.
    if (start !== undefined) settleTurn(settle.sessionId, start);
  } else {
    // Walk the running turns, not everything the snapshot covers. Only a live
    // start can settle, and there are a handful of those against a directory's
    // hundreds of sessions — asking "does this snapshot cover that one?" keeps
    // the pass proportional to the work instead of to the session list, and
    // allocates nothing per poll.
    for (const [sessionId, start] of state.startedAt) {
      if (activeSessionIds.has(sessionId)) continue;
      if (!settle.isCovered(sessionId)) continue;
      settleTurn(sessionId, start);
    }
  }

  if (next.settled) trimSettled(next.settled);

  if (next.started || next.settled) {
    scope.startedAt = next.started ?? state.startedAt;
    scope.settledMs = next.settled ?? state.settledMs;
    if (currentScopeKey() === targetScopeKey) {
      useSessionActivityTimingStore.setState({
        startedAt: scope.startedAt,
        settledMs: scope.settledMs,
      });
    }
  }

  if (next.started) {
    if (next.started.size > 0) ensureLivenessStampOnHide();
    persistStarts(targetScopeKey, next.started, now);
    return;
  }
  if (restoredChanged) {
    persistStarts(targetScopeKey, state.startedAt, now);
    return;
  }
  // Nothing structural changed, but a long-running turn still needs its stamp
  // refreshed so a reload can tell it apart from one that ended unobserved.
  if (sawActive && state.startedAt.size > 0 && now - scope.lastPersistAt >= LIVENESS_PERSIST_INTERVAL_MS) {
    persistStarts(targetScopeKey, state.startedAt, now);
  }
};

/**
 * Event-driven path: one session changed phase, live. Busy repeats throughout a
 * turn and carries no boundary; idle/error fire once and end it, which is why
 * only settling here retires the persisted record.
 */
export const observeSessionActivityTiming = (
  sessionId: string,
  phase: SessionActivityPhase,
  scopeKey?: string,
): void => {
  if (phase === 'active') {
    applyTransitions(new Set([sessionId]), null, scopeKey);
    return;
  }
  applyTransitions(EMPTY_ACTIVE, { source: 'event', sessionId }, scopeKey);
};

/**
 * Authoritative path: a `/session/status` snapshot for one directory. Sessions
 * the snapshot covers but does not report active stop their live counters —
 * that is what recovers a turn whose end event this client missed — but their
 * persisted records survive, because a snapshot that cannot yet see a session
 * looks identical to one whose turn is over.
 */
export const reconcileSessionActivityTiming = (
  activeSessionIds: ReadonlySet<string>,
  isCoveredBySnapshot: (sessionId: string) => boolean,
  scopeKey?: string,
): void => {
  applyTransitions(activeSessionIds, { source: 'snapshot', isCovered: isCoveredBySnapshot }, scopeKey);
};

export const removeSessionActivityTiming = (sessionId: string, scopeKey?: string): void => {
  const targetScopeKey = normalizeScopeKey(scopeKey ?? currentScopeKey());
  const scope = readScopeState(targetScopeKey);
  const restoredChanged = getRestoredStarts(targetScopeKey).delete(sessionId);
  const state = {
    startedAt: scope.startedAt,
    settledMs: scope.settledMs,
  };
  const hadStart = state.startedAt.has(sessionId);
  const hadSettled = state.settledMs.has(sessionId);
  scope.liveSeen.delete(sessionId);

  if (!hadStart && !hadSettled) {
    if (restoredChanged) persistStarts(targetScopeKey, state.startedAt, Date.now());
    return;
  }

  let startedAt = state.startedAt;
  if (hadStart) {
    const draft = new Map(state.startedAt);
    draft.delete(sessionId);
    startedAt = draft;
  }
  let settledMs = state.settledMs;
  if (hadSettled) {
    const draft = new Map(state.settledMs);
    draft.delete(sessionId);
    settledMs = draft;
  }

  scope.startedAt = startedAt as Map<string, number>;
  scope.settledMs = settledMs as Map<string, number>;
  if (currentScopeKey() === targetScopeKey) {
    useSessionActivityTimingStore.setState({ startedAt: scope.startedAt, settledMs: scope.settledMs });
  }
  if (hadStart || restoredChanged) persistStarts(targetScopeKey, scope.startedAt, Date.now());
};

/**
 * Drops in-memory state and the cached restored-start snapshot — i.e. treats
 * what follows as a fresh page load. Called on a runtime switch, where the
 * previous instance's turns are no longer ours, and by tests. `pageLoadAt`
 * overrides the navigation-start reference so tests can place a load in the
 * past (slow bootstrap, expired window).
 */
export const resetSessionActivityTiming = (options: { pageLoadAt?: number } = {}): void => {
  const targetScopeKey = currentScopeKey();
  scopeStates.set(targetScopeKey, createScopeState());
  persistedPayload = null;
  pageLoadAt = options.pageLoadAt ?? Date.now();
  useSessionActivityTimingStore.setState({ startedAt: new Map(), settledMs: new Map() });
};

// ---------------------------------------------------------------------------
// Leaf subscriptions
// ---------------------------------------------------------------------------

export const useSessionActivityStartedAt = (sessionId: string): number | undefined => (
  useSessionActivityTimingStore(useCallback((state) => state.startedAt.get(sessionId), [sessionId]))
);

export const useSessionSettledDurationMs = (sessionId: string): number | undefined => (
  useSessionActivityTimingStore(useCallback((state) => state.settledMs.get(sessionId), [sessionId]))
);

/**
 * Whether a duration exists to render, without subscribing the caller to the
 * value itself — a row uses this to decide between the counter and its normal
 * metadata, and must not re-render every tick to do so.
 */
export const useHasSessionActivityDuration = (sessionId: string, running: boolean): boolean => (
  useSessionActivityTimingStore(useCallback((state) => (
    running ? state.startedAt.has(sessionId) : state.settledMs.has(sessionId)
  ), [running, sessionId]))
);
