import { create } from 'zustand';
import { workspaceSessionKey } from './identity';
import { fetchWorkspaceCapabilities } from './catalog-client';
import { fetchWorkspaceSessionSnapshot } from './session-index-client';
import {
  CatalogClientError,
  type SourceFreshness,
  type WorkspaceCapabilities,
  type WorkspaceId,
  type WorkspaceSessionEvent,
  type WorkspaceSessionSnapshot,
  type WorkspaceSessionSummary,
} from './types';

/**
 * Session Index store (renderer).
 *
 * - Authority: the server snapshot. A failed refresh never replaces a prior
 *   snapshot and never renders as "no sessions" (failure is not empty).
 * - Incremental events carry the global revision. Events are applied in
 *   strict order; a revision gap means the client missed events, so the
 *   snapshot must be re-fetched (revisionGap flag, consumed by callers).
 * - Events clone only the slice they touch; unrelated sessions, freshness
 *   entries and the sessionKeys set keep their identity (clone-on-write).
 * - Performance budget (§17.5): `sessionIndex` (key -> array position) makes
 *   upsert membership/position O(1); a session event never scans the
 *   sessions array (`findIndex`/`filter`/`map` are gone from `applyEvent`).
 * - Capability flags (plan §20): `refreshCapabilities()` reads
 *   `workspaceCatalogV1` from the control plane on a SEPARATE channel. A
 *   failed read marks `capabilitiesError` and keeps the prior value; it
 *   never fails the session-index snapshot and never fabricates a disabled
 *   state (unknown = enabled).
 */

type SessionIndexStatus = 'idle' | 'loading' | 'ready' | 'error';
type CapabilitiesStatus = 'idle' | 'loading' | 'ready' | 'error';

interface SessionIndexState {
  snapshot: WorkspaceSessionSnapshot | null;
  status: SessionIndexStatus;
  lastError: string | null;
  lastAppliedRevision: number;
  sessionKeys: Set<string>;
  /** session.key -> position in `snapshot.sessions`. Maintained alongside
   * every array mutation so event reducers never scan the collection. */
  sessionIndex: Map<string, number>;
  revisionGap: boolean;
  capabilities: WorkspaceCapabilities | null;
  capabilitiesStatus: CapabilitiesStatus;
  capabilitiesError: string | null;
  refresh: () => Promise<void>;
  applyEvent: (event: WorkspaceSessionEvent) => void;
  consumeRevisionGap: () => boolean;
  refreshCapabilities: () => Promise<void>;
}

const DEFAULT_FRESHNESS: SourceFreshness = {
  complete: false,
  partial: false,
  offline: false,
  stale: false,
  lastSuccessAt: null,
  error: null,
};

const isSessionSummary = (value: unknown): value is WorkspaceSessionSummary => {
  if (!value || typeof value !== 'object') return false;
  const summary = value as Partial<WorkspaceSessionSummary>;
  return typeof summary.key === 'string'
    && typeof summary.workspaceId === 'string'
    && typeof summary.upstreamSessionId === 'string'
    && typeof summary.directory === 'string'
    && typeof summary.title === 'string'
    && typeof summary.updatedAt === 'number'
    && typeof summary.archived === 'boolean';
};

const parseFreshnessPatch = (value: unknown): Partial<SourceFreshness> | null => {
  if (!value || typeof value !== 'object') return null;
  const patch = value as Record<string, unknown>;
  const result: Partial<SourceFreshness> = {};
  if (typeof patch.complete === 'boolean') result.complete = patch.complete;
  if (typeof patch.partial === 'boolean') result.partial = patch.partial;
  if (typeof patch.offline === 'boolean') result.offline = patch.offline;
  if (typeof patch.stale === 'boolean') result.stale = patch.stale;
  if (typeof patch.lastSuccessAt === 'number') result.lastSuccessAt = patch.lastSuccessAt;
  if (patch.error === null || patch.error === undefined) result.error = null;
  else if (typeof patch.error === 'object') result.error = patch.error as SourceFreshness['error'];
  return result.complete === undefined
    && result.partial === undefined
    && result.offline === undefined
    && result.stale === undefined
    && result.lastSuccessAt === undefined
    && result.error === undefined
    ? null
    : result;
};

const validEventRevision = (revision: unknown): revision is number => (
  typeof revision === 'number' && Number.isFinite(revision)
);

/** Builds the key-set and key->position index for a sessions array. */
const indexSessions = (sessions: WorkspaceSessionSummary[]) => {
  const sessionKeys = new Set<string>();
  const sessionIndex = new Map<string, number>();
  for (let i = 0; i < sessions.length; i += 1) {
    sessionKeys.add(sessions[i].key);
    sessionIndex.set(sessions[i].key, i);
  }
  return { sessionKeys, sessionIndex };
};

export const useWorkspaceSessionIndexStore = create<SessionIndexState>()((set, get) => ({
  snapshot: null,
  status: 'idle',
  lastError: null,
  lastAppliedRevision: 0,
  sessionKeys: new Set(),
  sessionIndex: new Map(),
  revisionGap: false,
  capabilities: null,
  capabilitiesStatus: 'idle',
  capabilitiesError: null,

  refresh: async () => {
    set({ status: 'loading' });
    try {
      const snapshot = await fetchWorkspaceSessionSnapshot();
      set((state) => {
        const base = {
          status: 'ready' as const,
          lastError: null,
          lastAppliedRevision: snapshot.revision,
          revisionGap: false,
        };
        if (!state.snapshot) {
          const { sessionKeys, sessionIndex } = indexSessions(snapshot.sessions);
          return {
            ...base,
            snapshot,
            sessionKeys,
            sessionIndex,
          };
        }
        // A TRUNCATED snapshot is NOT an authoritative full state for the
        // affected connections: sessions beyond the server's enumeration
        // limit still exist upstream, so they must not be dropped as if
        // deleted. Preserve prior sessions of truncated connections that the
        // new snapshot cannot enumerate; untruncated connections stay fully
        // authoritative.
        const truncatedConnections = new Set(
          Object.entries(snapshot.truncatedByConnection ?? {})
            .filter(([, truncated]) => truncated === true)
            .map(([connectionId]) => connectionId),
        );
        if (truncatedConnections.size === 0) {
          const { sessionKeys, sessionIndex } = indexSessions(snapshot.sessions);
          return {
            ...base,
            snapshot,
            sessionKeys,
            sessionIndex,
          };
        }
        const newKeys = new Set(snapshot.sessions.map((session) => session.key));
        const preserved = state.snapshot.sessions.filter((session) => (
          truncatedConnections.has(session.connectionId) && !newKeys.has(session.key)
        ));
        const mergedSessions = [...snapshot.sessions, ...preserved];
        const { sessionKeys, sessionIndex } = indexSessions(mergedSessions);
        return {
          ...base,
          snapshot: { ...snapshot, sessions: mergedSessions },
          sessionKeys,
          sessionIndex,
        };
      });
    } catch (error) {
      // Failure is NOT empty success: keep the prior snapshot, mark error.
      set((state) => ({
        status: 'error',
        lastError: error instanceof CatalogClientError ? error.message : error instanceof Error ? error.message : 'Failed to load session index',
        snapshot: state.snapshot,
      }));
    }
  },

  applyEvent: (event) => set((state) => {
    if (!event || !validEventRevision(event.revision)) return state;
    if (event.revision <= state.lastAppliedRevision) return state;
    if (event.revision > state.lastAppliedRevision + 1) return { revisionGap: true };
    if (!state.snapshot) return { revisionGap: true };

    if (event.type === 'session.upserted') {
      const summary = event.payload;
      if (!isSessionSummary(summary)) return state;
      // Keyed lookup: an event for one entity never scans the collection.
      const position = state.sessionIndex.get(summary.key);
      if (position === undefined) {
        return {
          snapshot: { ...state.snapshot, sessions: [...state.snapshot.sessions, summary] },
          sessionKeys: new Set(state.sessionKeys).add(summary.key),
          sessionIndex: new Map(state.sessionIndex).set(summary.key, state.snapshot.sessions.length),
          lastAppliedRevision: event.revision,
        };
      }
      const sessions = state.snapshot.sessions.slice();
      sessions[position] = summary;
      return {
        snapshot: { ...state.snapshot, sessions },
        lastAppliedRevision: event.revision,
      };
    }

    if (event.type === 'session.removed') {
      if (typeof event.workspaceId !== 'string' || event.workspaceId.length === 0
        || typeof event.sessionId !== 'string' || event.sessionId.length === 0) return state;
      const key = workspaceSessionKey(event.workspaceId, event.sessionId);
      const position = state.sessionIndex.get(key);
      if (position === undefined) return state;
      const sessions = state.snapshot.sessions.slice();
      sessions.splice(position, 1);
      const sessionIndex = new Map(state.sessionIndex);
      sessionIndex.delete(key);
      for (const [entryKey, entryPosition] of sessionIndex) {
        if (entryPosition > position) sessionIndex.set(entryKey, entryPosition - 1);
      }
      const sessionKeys = new Set(state.sessionKeys);
      sessionKeys.delete(key);
      return {
        snapshot: { ...state.snapshot, sessions },
        sessionIndex,
        sessionKeys,
        lastAppliedRevision: event.revision,
      };
    }

    if (event.type === 'freshness.changed') {
      if (typeof event.connectionId !== 'string' || event.connectionId.length === 0) return state;
      const patch = parseFreshnessPatch(event.payload);
      if (!patch) return state;
      return {
        snapshot: {
          ...state.snapshot,
          freshnessByConnection: {
            ...state.snapshot.freshnessByConnection,
            [event.connectionId]: {
              ...(state.snapshot.freshnessByConnection[event.connectionId] ?? DEFAULT_FRESHNESS),
              ...patch,
            },
          },
        },
        lastAppliedRevision: event.revision,
      };
    }

    return state;
  }),

  consumeRevisionGap: () => {
    const hadGap = get().revisionGap;
    set({ revisionGap: false });
    return hadGap;
  },

  refreshCapabilities: async () => {
    set({ capabilitiesStatus: 'loading' });
    try {
      const capabilities = await fetchWorkspaceCapabilities();
      set({ capabilities, capabilitiesStatus: 'ready', capabilitiesError: null });
    } catch (error) {
      // Failure is NOT a disabled state: keep the prior value, mark error.
      // Only an authoritative `{ workspaceCatalogV1: false }` disables the
      // unified sidebar; a transient/unknown read keeps current behavior.
      set((state) => ({
        capabilitiesStatus: 'error',
        capabilitiesError: error instanceof CatalogClientError ? error.message : error instanceof Error ? error.message : 'Failed to load workspace capabilities',
        capabilities: state.capabilities,
      }));
    }
  },
}));

export const selectSessionsForWorkspace = (
  snapshot: WorkspaceSessionSnapshot | null,
  workspaceId: WorkspaceId,
): WorkspaceSessionSummary[] => (
  snapshot ? snapshot.sessions.filter((session) => session.workspaceId === workspaceId) : []
);

/**
 * Resolves the ACTIVE workspace from the current session selection.
 *
 * The session index is authoritative for workspace-bound sessions: only
 * sessions mapped to a workspace appear there (unassigned sessions live in a
 * separate diagnostics bucket and never surface under a workspace). When the
 * currently selected session is found in the index, its workspace is the
 * active one; anything else (legacy global session list, drafts, deep links)
 * yields null and the legacy ambient-runtime sync path stays in charge.
 *
 * Matching uses (upstreamSessionId, directory) — the same tuple the server
 * binding store uses — so a session id collision across connections is
 * disambiguated by directory.
 */
export const resolveActiveWorkspaceId = (
  sessions: WorkspaceSessionSummary[] | undefined,
  currentSessionId: string | null,
  currentSessionDirectory: string | null,
): WorkspaceId | null => {
  if (!currentSessionId || !sessions) return null;
  const matches = sessions.filter((session) => session.upstreamSessionId === currentSessionId);
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0].workspaceId;
  const byDirectory = matches.find((session) => (
    currentSessionDirectory ? session.directory === currentSessionDirectory : true
  ));
  return (byDirectory ?? matches[0]).workspaceId;
};
