import { create } from 'zustand';
import type { OpencodeClient, Session } from '@opencode-ai/sdk/v2';
import { opencodeClient } from '@/lib/opencode/client';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { workspaceIdFromScopeKey } from '@/workspaces/identity';
import { listGlobalSessionPages, splitGlobalSessionsByArchived } from '@/stores/globalSessions';
import { getReviewTransferDirection, type ReviewTransferDirection } from '@/lib/reviewFlow';
import { getOriginalSessionID, getReviewSessionID } from '@/lib/sessionReviewMetadata';
import { normalizePath } from '@/lib/pathNormalization';
import { raiseSessionOrderingBaselines } from '@/sync/session-ordering';
import { mapWithConcurrency } from '@/lib/concurrency';

type GlobalSessionsStatus = 'idle' | 'loading' | 'ready' | 'error';

type LoadResult = {
  activeSessions: Session[];
  archivedSessions: Session[];
};

type GlobalSessionsData = {
  activeSessions: Session[];
  archivedSessions: Session[];
  sessionsByDirectory: Map<string, Session[]>;
  reviewTransferBySessionId: Map<string, ReviewTransferDirection>;
  mutationRevision: number;
  mutationRevisionBySessionId: Map<string, number>;
  hasLoaded: boolean;
  status: GlobalSessionsStatus;
};

type GlobalSessionsState = GlobalSessionsData & {
  /** The currently visible compatibility-scope partition. */
  scopeKey: string;
  /** Bind reads/writes to one workspace or legacy runtime partition. */
  bindScope: (scopeKey: string, sdk?: OpencodeClient) => void;
  loadSessions: (fallbackActive?: Session[]) => Promise<LoadResult>;
  refreshSessionsForDirectories: (directories: Iterable<string>, fallbackActive?: Session[]) => Promise<LoadResult>;
  applySnapshot: (activeSessions: Session[], archivedSessions: Session[], status?: GlobalSessionsStatus) => void;
  upsertSession: (session: Session) => void;
  upsertSessions: (sessions: Session[]) => void;
  removeSessions: (ids: Iterable<string>) => void;
  archiveSessions: (ids: Iterable<string>, archivedAt?: number) => void;
  /** Drop every session from the previous runtime instance and go back to the
      unloaded state, so a fresh load runs against the new endpoint. */
  resetForRuntimeSwitch: () => void;
};

const PAGE_SIZE = 500;
const DIRECTORY_SESSION_REFRESH_CONCURRENCY = 2;
let directorySessionRefreshActive = 0;
const directorySessionRefreshWaiters: Array<() => void> = [];

// `useGlobalSessionsStore` is a compatibility facade for surfaces that still
// consume full OpenCode Session objects. Its visible shape stays stable, but
// the backing data is now partitioned by workspace/runtime scope so a
// workspace-bound SyncProvider cannot overwrite another workspace's session
// list. The unified Session Index remains the cross-workspace authority; this
// cache is only the cold/full-session compatibility layer.
const scopeStates = new Map<string, GlobalSessionsData>();
const scopeSdks = new Map<string, OpencodeClient>();
const inflightLoads = new Map<string, Promise<LoadResult>>();
const loadGenerations = new Map<string, number>();

const createEmptyScopeState = (): GlobalSessionsData => ({
  activeSessions: [],
  archivedSessions: [],
  sessionsByDirectory: new Map(),
  reviewTransferBySessionId: new Map(),
  mutationRevision: 0,
  mutationRevisionBySessionId: new Map(),
  hasLoaded: false,
  status: 'idle',
});

const getLoadGeneration = (scopeKey: string): number => loadGenerations.get(scopeKey) ?? 0;

const resolveScopeSdk = (scopeKey: string): OpencodeClient | null => {
  const boundSdk = scopeSdks.get(scopeKey);
  if (boundSdk) return boundSdk;

  // A workspace scope is never allowed to borrow the process-wide SDK. A
  // missing binding is a lifecycle/unavailable state, not permission to
  // query whichever runtime happens to be active.
  if (workspaceIdFromScopeKey(scopeKey)) return null;
  return opencodeClient.getSdkClient();
};

const bumpLoadGeneration = (scopeKey: string): number => {
  const next = getLoadGeneration(scopeKey) + 1;
  loadGenerations.set(scopeKey, next);
  return next;
};

const toGlobalSessionsData = (state: GlobalSessionsState): GlobalSessionsData => ({
  activeSessions: state.activeSessions,
  archivedSessions: state.archivedSessions,
  sessionsByDirectory: state.sessionsByDirectory,
  reviewTransferBySessionId: state.reviewTransferBySessionId,
  mutationRevision: state.mutationRevision,
  mutationRevisionBySessionId: state.mutationRevisionBySessionId,
  hasLoaded: state.hasLoaded,
  status: state.status,
});

const withDirectorySessionRefreshSlot = async <T>(task: () => Promise<T>): Promise<T> => {
  if (directorySessionRefreshActive >= DIRECTORY_SESSION_REFRESH_CONCURRENCY) {
    await new Promise<void>((resolve) => directorySessionRefreshWaiters.push(resolve));
  } else {
    directorySessionRefreshActive += 1;
  }
  try {
    return await task();
  } finally {
    const next = directorySessionRefreshWaiters.shift();
    if (next) next();
    else directorySessionRefreshActive = Math.max(0, directorySessionRefreshActive - 1);
  }
};

export const resolveGlobalSessionDirectory = (session: Session): string | null => {
  const record = session as Session & {
    directory?: string | null;
    project?: { worktree?: string | null } | null;
  };

  return normalizePath(record.directory ?? null)
    ?? normalizePath(record.project?.worktree ?? null);
};

export const mergeSessionDirectoryMetadata = (incoming: Session, existing?: Session | null): Session => {
  if (!existing) {
    return incoming;
  }

  const incomingRecord = incoming as Session & {
    directory?: string | null;
    project?: ({ worktree?: string | null } & Record<string, unknown>) | null;
  };
  const existingRecord = existing as Session & {
    directory?: string | null;
    project?: ({ worktree?: string | null } & Record<string, unknown>) | null;
  };

  const incomingDirectory = normalizePath(incomingRecord.directory ?? null);
  const incomingWorktree = normalizePath(incomingRecord.project?.worktree ?? null);
  const existingDirectory = normalizePath(existingRecord.directory ?? null);
  const existingWorktree = normalizePath(existingRecord.project?.worktree ?? null);

  let changed = false;
  const next: typeof incomingRecord = { ...incomingRecord };

  // Some live session updates omit stable raw directory metadata; keep the
  // cached value so project grouping does not temporarily lose the session.
  if (!incomingDirectory && existingDirectory) {
    next.directory = existingRecord.directory;
    changed = true;
  }

  if (!incomingWorktree && existingWorktree) {
    next.project = {
      ...(existingRecord.project ?? {}),
      ...(incomingRecord.project ?? {}),
      worktree: existingRecord.project?.worktree,
    };
    changed = true;
  } else if (!incomingRecord.project && existingRecord.project) {
    next.project = existingRecord.project;
    changed = true;
  }

  return changed ? next : incoming;
};

export const mergeLiveSessionWithGlobalSession = (
  liveSession: Session,
  globalSession: Session,
): Session => {
  const merged = mergeSessionDirectoryMetadata(liveSession, globalSession);
  if (merged.share !== globalSession.share) {
    return { ...merged, share: globalSession.share };
  }
  return merged;
};

const buildSessionsByDirectory = (sessions: Session[]): Map<string, Session[]> => {
  const next = new Map<string, Session[]>();
  for (const session of sessions) {
    const directory = resolveGlobalSessionDirectory(session);
    if (!directory) {
      continue;
    }
    const existing = next.get(directory);
    if (existing) {
      existing.push(session);
      continue;
    }
    next.set(directory, [session]);
  }
  return next;
};

const getSessionSignature = (session: Session): string => {
  return [
    session.id,
    session.title ?? '',
    session.time?.created ?? 0,
    session.time?.updated ?? 0,
    session.time?.archived ?? 0,
    session.share?.url ?? '',
    JSON.stringify((session as Session & { metadata?: unknown }).metadata ?? null),
    resolveGlobalSessionDirectory(session) ?? '',
  ].join(':');
};

export const getSessionStructuralSignature = (session: Session): string => {
  const record = session as Session & { parentID?: string | null; slug?: string | null };
  return [
    session.id,
    session.title ?? '',
    record.parentID ?? '',
    record.slug ?? '',
    session.time?.created ?? 0,
    session.time?.archived ?? 0,
    session.share?.url ?? '',
    JSON.stringify((session as Session & { metadata?: unknown }).metadata ?? null),
    resolveGlobalSessionDirectory(session) ?? '',
  ].join(':');
};

export const isGlobalSessionRecencyOnlyUpdate = (existing: Session, incoming: Session): boolean => {
  const merged = mergeSessionDirectoryMetadata(incoming, existing);
  return existing.time?.updated !== merged.time?.updated
    && getSessionStructuralSignature(existing) === getSessionStructuralSignature(merged);
};

const sameSessionList = (prev: Session[], next: Session[]): boolean => {
  if (prev === next) {
    return true;
  }
  if (prev.length !== next.length) {
    return false;
  }
  for (let index = 0; index < prev.length; index += 1) {
    if (getSessionSignature(prev[index]) !== getSessionSignature(next[index])) {
      return false;
    }
  }
  return true;
};

const getSessionUpdatedAt = (session: Session): number => {
  const updatedAt = session.time?.updated;
  if (typeof updatedAt === 'number' && Number.isFinite(updatedAt)) {
    return updatedAt;
  }
  const createdAt = session.time?.created;
  return typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : 0;
};

const sortSessionsByUpdated = (sessions: Session[]): Session[] => {
  return [...sessions].sort((left, right) => {
    const timeDelta = getSessionUpdatedAt(right) - getSessionUpdatedAt(left);
    if (timeDelta !== 0) return timeDelta;
    return right.id.localeCompare(left.id);
  });
};

const normalizeDirectorySet = (directories: Iterable<string>): Set<string> => {
  const next = new Set<string>();
  for (const directory of directories) {
    const normalized = normalizePath(directory);
    if (normalized) next.add(normalized);
  }
  return next;
};

const replaceSessionsForDirectories = (
  existing: Session[],
  incoming: Session[],
  directories: Set<string>,
): Session[] => {
  if (directories.size === 0) {
    return existing;
  }

  const existingById = new Map(existing.map((session) => [session.id, session]));
  const incomingById = new Map<string, Session>();

  for (const session of incoming) {
    if (!session?.id) continue;
    incomingById.set(session.id, mergeSessionDirectoryMetadata(session, existingById.get(session.id)));
  }

  const kept = existing.filter((session) => {
    if (incomingById.has(session.id)) return false;
    const directory = resolveGlobalSessionDirectory(session);
    return !directory || !directories.has(directory);
  });

  return sortSessionsByUpdated([...incomingById.values(), ...kept]);
};

type DirectoryPageResult = {
  directories: Set<string>;
  sessions: Session[];
  errors: unknown[];
};

const fetchDirectoryPages = async (
  sdk: OpencodeClient,
  directories: Set<string>,
): Promise<DirectoryPageResult> => {
  const currentDirectory = normalizePath(
    typeof (sdk as OpencodeClient & { getDirectory?: () => string }).getDirectory === 'function'
      ? (sdk as OpencodeClient & { getDirectory?: () => string }).getDirectory?.() ?? null
      : null,
  );
  const orderedDirectories = [...directories].sort((left, right) => {
    if (left === currentDirectory) return -1;
    if (right === currentDirectory) return 1;
    return left.localeCompare(right);
  });
  const results = await mapWithConcurrency(orderedDirectories, DIRECTORY_SESSION_REFRESH_CONCURRENCY, async (directory) => {
    try {
      return {
        status: 'fulfilled' as const,
        value: {
          directory,
          // One inclusive request per directory: the server has no filter that
          // returns only active sessions including restored (`time.archived`
          // falsy-but-present) rows, so fetch everything and split client-side.
          sessions: await withDirectorySessionRefreshSlot(() => (
            listGlobalSessionPages(sdk, { directory, archived: true, narrowToArchived: false, pageSize: PAGE_SIZE })
          )),
        },
      };
    } catch (reason) {
      return { status: 'rejected' as const, reason };
    }
  });

  const fulfilledDirectories = new Set<string>();
  const sessions: Session[] = [];
  const errors: unknown[] = [];

  for (const result of results) {
    if (result.status === 'fulfilled') {
      fulfilledDirectories.add(result.value.directory);
      sessions.push(...result.value.sessions);
    } else {
      errors.push(result.reason);
    }
  }

  return { directories: fulfilledDirectories, sessions, errors };
};

const upsertSessionIntoList = (sessions: Session[], session: Session): Session[] => {
  const index = sessions.findIndex((candidate) => candidate.id === session.id);
  if (index === -1) {
    return [session, ...sessions];
  }
  const mergedSession = mergeSessionDirectoryMetadata(session, sessions[index]);
  if (getSessionSignature(sessions[index]) === getSessionSignature(mergedSession)) {
    return sessions;
  }
  const next = [...sessions];
  next[index] = mergedSession;
  return next;
};

const removeSessionFromList = (sessions: Session[], sessionId: string): Session[] => {
  const index = sessions.findIndex((session) => session.id === sessionId);
  if (index === -1) {
    return sessions;
  }
  return [...sessions.slice(0, index), ...sessions.slice(index + 1)];
};

const mergeSessionLists = (existing: Session[], incoming?: Session[]): Session[] => {
  if (!incoming || incoming.length === 0) {
    return existing;
  }

  if (existing.length === 0) {
    return incoming;
  }

  const byId = new Map(existing.map((session) => [session.id, session]));
  incoming.forEach((session) => {
    byId.set(session.id, mergeSessionDirectoryMetadata(session, byId.get(session.id)));
  });

  const ordered: Session[] = [];
  const seen = new Set<string>();

  existing.forEach((session) => {
    const next = byId.get(session.id);
    if (!next) {
      return;
    }
    ordered.push(next);
    seen.add(session.id);
  });

  incoming.forEach((session) => {
    if (seen.has(session.id)) {
      return;
    }
    const next = byId.get(session.id);
    if (next) {
      ordered.push(next);
      seen.add(session.id);
    }
  });

  return ordered;
};

const applySnapshot = (
  state: GlobalSessionsData,
  activeSessions: Session[],
  archivedSessions: Session[],
  status: GlobalSessionsStatus,
): Partial<GlobalSessionsData> | GlobalSessionsData => {
  const nextActiveSessions = sameSessionList(state.activeSessions, activeSessions)
    ? state.activeSessions
    : activeSessions;
  const nextArchivedSessions = sameSessionList(state.archivedSessions, archivedSessions)
    ? state.archivedSessions
    : archivedSessions;
  const nextSessionsByDirectory = nextActiveSessions === state.activeSessions
    ? state.sessionsByDirectory
    : buildSessionsByDirectory(nextActiveSessions);
  const nextReviewTransferMap = nextActiveSessions === state.activeSessions
    ? state.reviewTransferBySessionId
    : buildReviewTransferMap(nextActiveSessions);

  if (
    nextActiveSessions === state.activeSessions
    && nextArchivedSessions === state.archivedSessions
    && nextSessionsByDirectory === state.sessionsByDirectory
    && nextReviewTransferMap === state.reviewTransferBySessionId
    && state.hasLoaded
    && state.status === status
  ) {
    return state;
  }

  return {
    activeSessions: nextActiveSessions,
    archivedSessions: nextArchivedSessions,
    sessionsByDirectory: nextSessionsByDirectory,
    reviewTransferBySessionId: nextReviewTransferMap,
    hasLoaded: true,
    status,
  };
};

const overlayMutationsSince = (
  state: GlobalSessionsData,
  activeSessions: Session[],
  archivedSessions: Session[],
  baselineRevision: number,
): LoadResult => {
  const affectedIds = new Set<string>();
  for (const [sessionId, revision] of state.mutationRevisionBySessionId) {
    if (revision > baselineRevision) affectedIds.add(sessionId);
  }
  if (affectedIds.size === 0) return { activeSessions, archivedSessions };

  const currentActive = new Map(state.activeSessions.map((session) => [session.id, session]));
  const currentArchived = new Map(state.archivedSessions.map((session) => [session.id, session]));
  let nextActive = activeSessions.filter((session) => !affectedIds.has(session.id));
  let nextArchived = archivedSessions.filter((session) => !affectedIds.has(session.id));
  for (const sessionId of affectedIds) {
    const active = currentActive.get(sessionId);
    const archived = currentArchived.get(sessionId);
    if (active) nextActive = upsertSessionIntoList(nextActive, active);
    else if (archived) nextArchived = upsertSessionIntoList(nextArchived, archived);
  }
  return { activeSessions: nextActive, archivedSessions: nextArchived };
};

const mutationRevisionPatch = (state: GlobalSessionsData, ids: Iterable<string>) => {
  const mutationRevision = state.mutationRevision + 1;
  const mutationRevisionBySessionId = new Map(state.mutationRevisionBySessionId);
  for (const id of ids) mutationRevisionBySessionId.set(id, mutationRevision);
  return { mutationRevision, mutationRevisionBySessionId };
};

const applySessionUpserts = (state: GlobalSessionsData, sessions: Session[]): Partial<GlobalSessionsData> => {
  const revisionPatch = mutationRevisionPatch(state, sessions.map((session) => session.id));
  let nextActiveSessions = state.activeSessions;
  let nextArchivedSessions = state.archivedSessions;

  for (const session of sessions) {
    const existingSession = nextActiveSessions.find((candidate) => candidate.id === session.id)
      ?? nextArchivedSessions.find((candidate) => candidate.id === session.id)
      ?? null;
    const sessionWithMetadata = mergeSessionDirectoryMetadata(session, existingSession);
    const isArchived = Boolean(sessionWithMetadata.time?.archived);
    nextActiveSessions = isArchived
      ? removeSessionFromList(nextActiveSessions, session.id)
      : upsertSessionIntoList(nextActiveSessions, sessionWithMetadata);
    nextArchivedSessions = isArchived
      ? upsertSessionIntoList(nextArchivedSessions, sessionWithMetadata)
      : removeSessionFromList(nextArchivedSessions, session.id);
  }

  if (
    nextActiveSessions === state.activeSessions
    && nextArchivedSessions === state.archivedSessions
  ) {
    return revisionPatch;
  }

  return {
    activeSessions: nextActiveSessions,
    archivedSessions: nextArchivedSessions,
    sessionsByDirectory: nextActiveSessions === state.activeSessions
      ? state.sessionsByDirectory
      : buildSessionsByDirectory(nextActiveSessions),
    reviewTransferBySessionId: nextActiveSessions === state.activeSessions
      ? state.reviewTransferBySessionId
      : buildReviewTransferMap(nextActiveSessions),
    ...revisionPatch,
  };
};

const buildReviewTransferMap = (sessions: Session[]): Map<string, ReviewTransferDirection> => {
  const next = new Map<string, ReviewTransferDirection>()
  const activeIds = new Set(sessions.map((s) => s.id))
  for (const session of sessions) {
    const direction = getReviewTransferDirection(session)
    if (!direction) continue
    const targetSessionId = direction === 'review-to-original'
      ? getOriginalSessionID(session)
      : getReviewSessionID(session)
    if (!targetSessionId || !activeIds.has(targetSessionId)) continue
    next.set(session.id, direction)
  }
  return next
}

export const useGlobalSessionsStore = create<GlobalSessionsState>((set, get) => {
  const readScopeData = (scopeKey: string): GlobalSessionsData => {
    const current = get();
    if (current.scopeKey === scopeKey) {
      return toGlobalSessionsData(current);
    }
    return scopeStates.get(scopeKey) ?? createEmptyScopeState();
  };

  const getScopeResult = (scopeKey: string): LoadResult => {
    const state = readScopeData(scopeKey);
    return { activeSessions: state.activeSessions, archivedSessions: state.archivedSessions };
  };

  const commitScopeData = (
    scopeKey: string,
    updater: (state: GlobalSessionsData) => Partial<GlobalSessionsData> | GlobalSessionsData,
  ): GlobalSessionsData => {
    const previous = readScopeData(scopeKey);
    const patch = updater(previous);
    const next = patch === previous ? previous : { ...previous, ...patch };
    scopeStates.set(scopeKey, next);
    if (get().scopeKey === scopeKey) {
      set({ ...next, scopeKey });
    }
    return next;
  };

  return ({
    ...createEmptyScopeState(),
    scopeKey: getRuntimeKey(),

    bindScope: (scopeKey, sdk) => {
      const normalizedScopeKey = scopeKey.trim() || getRuntimeKey();
      const current = get();
      scopeStates.set(current.scopeKey, toGlobalSessionsData(current));

      const previousSdk = scopeSdks.get(normalizedScopeKey);
      if (sdk && previousSdk !== sdk) {
        // A new workspace handle/transport owns the same logical scope. Any
        // old list request must not publish after that handoff.
        bumpLoadGeneration(normalizedScopeKey);
        inflightLoads.delete(normalizedScopeKey);
        scopeSdks.set(normalizedScopeKey, sdk);
      }

      if (current.scopeKey === normalizedScopeKey) {
        return;
      }

      const next = scopeStates.get(normalizedScopeKey) ?? createEmptyScopeState();
      set({ ...next, scopeKey: normalizedScopeKey });
    },

  applySnapshot: (activeSessions, archivedSessions, status = 'ready') => {
    // An authoritative snapshot may carry newer `updated` stamps for sessions
    // whose active→settled cycle this client slept through — raise their
    // ordering baselines so recent lists re-sort (see session-ordering).
    raiseSessionOrderingBaselines(activeSessions, get().scopeKey);
    set((state) => applySnapshot(state, activeSessions, archivedSessions, status));
  },

  resetForRuntimeSwitch: () => {
    const scopeKey = get().scopeKey;
    bumpLoadGeneration(scopeKey);
    inflightLoads.delete(scopeKey);
    scopeStates.delete(scopeKey);
    scopeSdks.delete(scopeKey);
    set({ ...createEmptyScopeState(), scopeKey });
  },

  loadSessions: async (fallbackActive) => {
    const scopeKey = get().scopeKey;
    const existing = inflightLoads.get(scopeKey);
    if (existing) {
      return existing;
    }

    set((state) => (
      state.scopeKey === scopeKey && state.status !== 'loading'
        ? { status: 'loading' }
        : state
    ));

    const generation = getLoadGeneration(scopeKey);
    const baselineRevision = readScopeData(scopeKey).mutationRevision;
    const sdk = resolveScopeSdk(scopeKey);
    if (!sdk) {
      console.warn('[GlobalSessions] Workspace SDK is unavailable; preserving the previous session snapshot.');
      commitScopeData(scopeKey, (state) => applySnapshot(state, state.activeSessions, state.archivedSessions, 'error'));
      return getScopeResult(scopeKey);
    }
    const loadPromise = (async () => {
      try {
        // One inclusive fetch, split client-side. The server's
        // `time_archived IS NULL` active filter would exclude restored
        // sessions (`time.archived` falsy-but-present), so an
        // `archived: false` request cannot produce a truthful active list.
        const allSessions = await listGlobalSessionPages(sdk, {
          archived: true,
          narrowToArchived: false,
          pageSize: PAGE_SIZE,
        });

        if (generation !== getLoadGeneration(scopeKey)) {
          return getScopeResult(scopeKey);
        }
        const { active, archived } = splitGlobalSessionsByArchived(allSessions);
        commitScopeData(scopeKey, (state) => {
          const reconciled = overlayMutationsSince(state, active, archived, baselineRevision);
          raiseSessionOrderingBaselines(reconciled.activeSessions, scopeKey);
          return applySnapshot(state, reconciled.activeSessions, reconciled.archivedSessions, 'ready');
        });
        return getScopeResult(scopeKey);
      } catch (error) {
        if (generation !== getLoadGeneration(scopeKey)) {
          return getScopeResult(scopeKey);
        }
        console.warn('[GlobalSessions] Failed to load sessions, using fallback snapshot:', error);
        commitScopeData(scopeKey, (state) => {
          const reconciled = overlayMutationsSince(
            state,
            mergeSessionLists(state.activeSessions, fallbackActive),
            state.archivedSessions,
            baselineRevision,
          );
          return applySnapshot(state, reconciled.activeSessions, reconciled.archivedSessions, 'error');
        });
        return getScopeResult(scopeKey);
      }
    })();

    inflightLoads.set(scopeKey, loadPromise);
    const clearInflightLoad = () => {
      if (inflightLoads.get(scopeKey) === loadPromise) {
        inflightLoads.delete(scopeKey);
      }
    };
    void loadPromise.then(clearInflightLoad, clearInflightLoad);
    return loadPromise;
  },

  refreshSessionsForDirectories: async (directories, fallbackActive) => {
    const scopeKey = get().scopeKey;
    const directorySet = normalizeDirectorySet(directories);
    if (directorySet.size === 0) {
      return getScopeResult(scopeKey);
    }

    const generation = getLoadGeneration(scopeKey);
    const baselineRevision = readScopeData(scopeKey).mutationRevision;
    const sdk = resolveScopeSdk(scopeKey);
    if (!sdk) {
      console.warn('[GlobalSessions] Workspace SDK is unavailable; preserving the previous session snapshot.');
      commitScopeData(scopeKey, (state) => applySnapshot(state, state.activeSessions, state.archivedSessions, 'error'));
      return getScopeResult(scopeKey);
    }
    const fetched = await fetchDirectoryPages(sdk, directorySet);

    if (generation !== getLoadGeneration(scopeKey)) {
      return getScopeResult(scopeKey);
    }

    if (fetched.errors.length > 0) {
      console.warn('[GlobalSessions] Failed to refresh sessions for some directories:', fetched.errors[0]);
    }

    const { active, archived } = splitGlobalSessionsByArchived(fetched.sessions);

    commitScopeData(scopeKey, (state) => {
      let nextActiveSessions = replaceSessionsForDirectories(state.activeSessions, active, fetched.directories);
      nextActiveSessions = mergeSessionLists(nextActiveSessions, fallbackActive);
      if (sameSessionList(state.activeSessions, nextActiveSessions)) {
        nextActiveSessions = state.activeSessions;
      }

      let nextArchivedSessions = replaceSessionsForDirectories(state.archivedSessions, archived, fetched.directories);
      if (sameSessionList(state.archivedSessions, nextArchivedSessions)) {
        nextArchivedSessions = state.archivedSessions;
      }

      const reconciled = overlayMutationsSince(state, nextActiveSessions, nextArchivedSessions, baselineRevision);
      nextActiveSessions = reconciled.activeSessions;
      nextArchivedSessions = reconciled.archivedSessions;

      const nextSessionsByDirectory = nextActiveSessions === state.activeSessions
        ? state.sessionsByDirectory
        : buildSessionsByDirectory(nextActiveSessions);

      if (
        nextActiveSessions === state.activeSessions
        && nextArchivedSessions === state.archivedSessions
        && nextSessionsByDirectory === state.sessionsByDirectory
      ) {
        return state;
      }

      return {
        activeSessions: nextActiveSessions,
        archivedSessions: nextArchivedSessions,
        sessionsByDirectory: nextSessionsByDirectory,
        reviewTransferBySessionId: nextActiveSessions === state.activeSessions
          ? state.reviewTransferBySessionId
          : buildReviewTransferMap(nextActiveSessions),
      };
    });

    return getScopeResult(scopeKey);
  },

  upsertSession: (session) => {
    set((state) => applySessionUpserts(state, [session]));
  },

  upsertSessions: (sessions) => {
    if (sessions.length === 0) return;
    set((state) => applySessionUpserts(state, sessions));
  },

  removeSessions: (ids) => {
    const idSet = ids instanceof Set ? ids : new Set(ids);
    if (idSet.size === 0) {
      return;
    }

    set((state) => {
      const revisionPatch = mutationRevisionPatch(state, idSet);
      const nextActiveSessions = state.activeSessions.filter((session) => !idSet.has(session.id));
      const nextArchivedSessions = state.archivedSessions.filter((session) => !idSet.has(session.id));

      if (
        nextActiveSessions.length === state.activeSessions.length
        && nextArchivedSessions.length === state.archivedSessions.length
      ) {
        return revisionPatch;
      }

      return {
        activeSessions: nextActiveSessions,
        archivedSessions: nextArchivedSessions,
        sessionsByDirectory: buildSessionsByDirectory(nextActiveSessions),
        reviewTransferBySessionId: buildReviewTransferMap(nextActiveSessions),
        ...revisionPatch,
      };
    });
  },

  archiveSessions: (ids, archivedAt = Date.now()) => {
    const idSet = ids instanceof Set ? ids : new Set(ids);
    if (idSet.size === 0) {
      return;
    }

    set((state) => {
      const revisionPatch = mutationRevisionPatch(state, idSet);
      const movedSessions: Session[] = [];
      const nextActiveSessions = state.activeSessions.filter((session) => {
        if (!idSet.has(session.id)) {
          return true;
        }

        movedSessions.push({
          ...session,
          time: {
            ...session.time,
            archived: archivedAt,
          },
        });
        return false;
      });

      if (movedSessions.length === 0) {
        return revisionPatch;
      }

      const remainingArchivedSessions = state.archivedSessions.filter((session) => !idSet.has(session.id));

      return {
        activeSessions: nextActiveSessions,
        archivedSessions: [...movedSessions, ...remainingArchivedSessions],
        sessionsByDirectory: buildSessionsByDirectory(nextActiveSessions),
        reviewTransferBySessionId: buildReviewTransferMap(nextActiveSessions),
        ...revisionPatch,
      };
    });
  },
  });
});

// Keep the non-reactive partitions synchronized with direct `setState` calls
// as well as store actions. A few compatibility consumers still seed this
// facade imperatively in tests and platform bridges.
useGlobalSessionsStore.subscribe((state) => {
  scopeStates.set(state.scopeKey, toGlobalSessionsData(state));
});

export const ensureGlobalSessionsLoaded = async (fallbackActive?: Session[]): Promise<LoadResult> => {
  const state = useGlobalSessionsStore.getState();
  if (state.hasLoaded && state.status !== 'error') {
    return {
      activeSessions: state.activeSessions,
      archivedSessions: state.archivedSessions,
    };
  }
  return state.loadSessions(fallbackActive);
};

export const refreshGlobalSessions = async (fallbackActive?: Session[]): Promise<LoadResult> => {
  return useGlobalSessionsStore.getState().loadSessions(fallbackActive);
};

export const refreshGlobalSessionsForDirectories = async (
  directories: Iterable<string>,
  fallbackActive?: Session[],
): Promise<LoadResult> => {
  return useGlobalSessionsStore.getState().refreshSessionsForDirectories(directories, fallbackActive);
};
