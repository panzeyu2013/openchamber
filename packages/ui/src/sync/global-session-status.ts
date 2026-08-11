import { create } from 'zustand';
import type { Event, SessionStatus } from '@opencode-ai/sdk/v2/client';
import { normalizeProjectPath } from '@/lib/projectResolution';
import {
  observeSessionActivityEvent,
  reconcileSessionActivitySnapshot,
  removeSessionOrdering,
} from './session-ordering';
import {
  observeSessionActivityTiming,
  reconcileSessionActivityTiming,
  removeSessionActivityTiming,
} from './session-activity-timing';
import { getRuntimeKey } from '@/lib/runtime-switch';

// Shared live busy/retry index for every directory. Global events update it
// incrementally and authoritative directory snapshots reconcile it, so each
// sidebar row can subscribe to one leaf instead of every child store.
//
// Only non-idle entries are kept; absence means idle. Entries carry their
// directory so a polled per-directory snapshot can authoritatively replace
// that directory's slice (the server omits idle sessions from snapshots).

type ActiveStatusType = 'busy' | 'retry';

type GlobalSessionStatusEntry = { status: SessionStatus; directory: string };

type GlobalSessionStatusState = {
  scopeKey: string;
  statusById: Map<string, GlobalSessionStatusEntry>;
  bindScope: (scopeKey: string) => void;
};

const scopeStatus = new Map<string, Map<string, GlobalSessionStatusEntry>>();

const normalizeScopeKey = (scopeKey?: string): string => {
  const normalized = scopeKey?.trim();
  return normalized || getRuntimeKey();
};

const readScopeStatus = (scopeKey: string): Map<string, GlobalSessionStatusEntry> => (
  scopeStatus.get(scopeKey) ?? new Map()
);

export const useGlobalSessionStatusStore = create<GlobalSessionStatusState>((set, get) => {
  const scopeKey = getRuntimeKey();
  const statusById = readScopeStatus(scopeKey);
  scopeStatus.set(scopeKey, statusById);

  return {
    scopeKey,
    statusById,
    bindScope: (nextScopeKey) => {
      const normalizedScopeKey = normalizeScopeKey(nextScopeKey);
      const current = get();
      scopeStatus.set(current.scopeKey, current.statusById);
      if (current.scopeKey === normalizedScopeKey) return;
      const nextStatusById = readScopeStatus(normalizedScopeKey);
      scopeStatus.set(normalizedScopeKey, nextStatusById);
      set({ scopeKey: normalizedScopeKey, statusById: nextStatusById });
    },
  };
});

// Keep imperative test/setup writes and direct reset calls in the active
// partition. Mutations for a captured foreign scope use updateScopeStatus
// below and never publish into the current visible partition.
useGlobalSessionStatusStore.subscribe((state, previous) => {
  if (state.scopeKey !== previous.scopeKey || state.statusById !== previous.statusById) {
    scopeStatus.set(state.scopeKey, state.statusById);
  }
});

const updateScopeStatus = (
  scopeKey: string,
  updater: (current: Map<string, GlobalSessionStatusEntry>) => Map<string, GlobalSessionStatusEntry>,
): void => {
  const normalizedScopeKey = normalizeScopeKey(scopeKey);
  const storeState = useGlobalSessionStatusStore.getState();
  const previous = storeState.scopeKey === normalizedScopeKey
    ? storeState.statusById
    : readScopeStatus(normalizedScopeKey);
  const next = updater(previous);
  if (next === previous) return;

  scopeStatus.set(normalizedScopeKey, next);
  if (storeState.scopeKey === normalizedScopeKey) {
    useGlobalSessionStatusStore.setState({ statusById: next });
  }
};

const isCurrentScope = (scopeKey: string): boolean => (
  useGlobalSessionStatusStore.getState().scopeKey === normalizeScopeKey(scopeKey)
);

const normalizeStatusType = (type: unknown): ActiveStatusType | 'idle' => {
  if (type === 'busy') return 'busy';
  if (type === 'retry') return 'retry';
  return 'idle';
};

const statusesEqual = (left: SessionStatus, right: SessionStatus): boolean => (
  left.type === right.type && JSON.stringify(left) === JSON.stringify(right)
);

// Both write paths normalize the directory key, so a polled snapshot can
// authoritatively replace entries written by events (and vice versa) even when
// the two sources format the same path differently (trailing slash, …).
const normalizeDirectory = (directory: string): string =>
  normalizeProjectPath(directory) ?? directory;

const setStatus = (
  sessionId: string,
  directory: string,
  status: SessionStatus | { type: 'idle' },
  scopeKey: string,
): void => {
  updateScopeStatus(scopeKey, (statusById) => {
    const current = statusById.get(sessionId);
    if (status.type === 'idle') {
      if (!current) return statusById;
      const next = new Map(statusById);
      next.delete(sessionId);
      return next;
    }
    if (current && current.directory === directory && statusesEqual(current.status, status)) return statusById;
    const next = new Map(statusById);
    next.set(sessionId, { status, directory });
    return next;
  });
};

// Event-driven path: called by the sync dispatcher for status-bearing events
// whose directory has no child store. Mirrors the child reducer's semantics
// (`session.idle` / `session.error` both resolve to idle).
export const applyGlobalSessionStatusEvent = (
  directory: string,
  payload: Event,
  scopeKey?: string,
): void => {
  const targetScopeKey = scopeKey ?? useGlobalSessionStatusStore.getState().scopeKey;
  const currentScope = isCurrentScope(targetScopeKey);
  switch (payload.type) {
    case 'session.status': {
      const props = payload.properties as { sessionID?: string; status?: { type?: string } } | undefined;
      if (typeof props?.sessionID !== 'string' || !props.sessionID) return;
      const type = normalizeStatusType(props.status?.type);
      setStatus(
        props.sessionID,
        normalizeDirectory(directory),
        type === 'idle' ? { type: 'idle' } : { ...(props.status ?? {}), type } as SessionStatus,
        targetScopeKey,
      );
      if (currentScope) {
        observeSessionActivityEvent(props.sessionID, type === 'idle' ? 'settled' : 'active', targetScopeKey);
        // `retry` is still a running turn, so the elapsed counter keeps going.
          observeSessionActivityTiming(props.sessionID, type === 'idle' ? 'settled' : 'active', targetScopeKey);
      }
      return;
    }
    case 'session.idle':
    case 'session.error': {
      const props = payload.properties as { sessionID?: string } | undefined;
      if (typeof props?.sessionID === 'string' && props.sessionID) {
        setStatus(props.sessionID, normalizeDirectory(directory), { type: 'idle' }, targetScopeKey);
        if (currentScope) {
          observeSessionActivityEvent(props.sessionID, 'settled', targetScopeKey);
          observeSessionActivityTiming(props.sessionID, 'settled', targetScopeKey);
        }
      }
      return;
    }
    case 'session.deleted': {
      const props = payload.properties as { sessionID?: string; info?: { id?: string } } | undefined;
      const sessionId = props?.sessionID ?? props?.info?.id;
      if (sessionId) {
        if (currentScope) {
          removeSessionOrdering(sessionId, targetScopeKey);
          removeSessionActivityTiming(sessionId, targetScopeKey);
        }
      }
      return;
    }
    default:
      return;
  }
};

// Polled path: an authoritative `/session/status?directory=X` snapshot. Entries
// missing from the snapshot are idle now — cleared both by directory key and by
// the caller's session-id list (the server may report a canonicalized directory
// that differs from the key an event wrote, e.g. via symlinks). Seeds the
// initial state (events only deliver changes) and reconciles missed events.
export const applyGlobalSessionStatusSnapshot = (
  rawDirectory: string,
  raw: Record<string, { type?: string }>,
  knownSessionIds?: Iterable<string>,
  scopeKey?: string,
): void => {
  const targetScopeKey = scopeKey ?? useGlobalSessionStatusStore.getState().scopeKey;
  const currentScope = isCurrentScope(targetScopeKey);
  const directory = normalizeDirectory(rawDirectory);
  const known = new Set(knownSessionIds ?? []);
  // Built once as a set and shared by both consumers below; only non-idle
  // sessions land here, so it stays small however long the directory's list is.
  const activeSessionIds = new Set<string>();
  for (const [sessionId, status] of Object.entries(raw)) {
    if (normalizeStatusType(status?.type) !== 'idle') activeSessionIds.add(sessionId);
  }
  if (currentScope) {
    reconcileSessionActivitySnapshot(activeSessionIds, known, targetScopeKey);
  }
  // Timing asks the coverage question instead of being handed a list: a snapshot
  // authoritatively covers the caller's session list plus every id it reports
  // itself, and only the handful of sessions actually being timed need an
  // answer. Reuses the sets already built above, so this allocates nothing.
  if (currentScope) {
    reconcileSessionActivityTiming(
      activeSessionIds,
      (sessionId) => known.has(sessionId) || sessionId in raw,
      targetScopeKey,
    );
  }
  updateScopeStatus(targetScopeKey, (statusById) => {
    let changed = false;
    const next = new Map(statusById);

    for (const [sessionId, entry] of statusById) {
      if ((entry.directory === directory || known.has(sessionId)) && !(sessionId in raw)) {
        next.delete(sessionId);
        changed = true;
      }
    }

    for (const [sessionId, status] of Object.entries(raw)) {
      const type = normalizeStatusType(status?.type);
      const current = next.get(sessionId);
      if (type === 'idle') {
        if (current && (current.directory === directory || known.has(sessionId))) {
          next.delete(sessionId);
          changed = true;
        }
        continue;
      }
      const normalizedStatus = { ...status, type } as SessionStatus;
      if (!current || current.directory !== directory || !statusesEqual(current.status, normalizedStatus)) {
        next.set(sessionId, { status: normalizedStatus, directory });
        changed = true;
      }
    }

    return changed ? next : statusById;
  });
};
