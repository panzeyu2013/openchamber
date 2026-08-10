import { create } from 'zustand';
import { workspaceSessionKey } from './identity';
import { fetchWorkspaceSessionSnapshot } from './session-index-client';
import {
  CatalogClientError,
  type SourceFreshness,
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
 */

type SessionIndexStatus = 'idle' | 'loading' | 'ready' | 'error';

interface SessionIndexState {
  snapshot: WorkspaceSessionSnapshot | null;
  status: SessionIndexStatus;
  lastError: string | null;
  lastAppliedRevision: number;
  sessionKeys: Set<string>;
  revisionGap: boolean;
  refresh: () => Promise<void>;
  applyEvent: (event: WorkspaceSessionEvent) => void;
  consumeRevisionGap: () => boolean;
}

const DEFAULT_FRESHNESS: SourceFreshness = {
  complete: false,
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
  if (typeof patch.stale === 'boolean') result.stale = patch.stale;
  if (typeof patch.lastSuccessAt === 'number') result.lastSuccessAt = patch.lastSuccessAt;
  if (patch.error === null || patch.error === undefined) result.error = null;
  else if (typeof patch.error === 'object') result.error = patch.error as SourceFreshness['error'];
  return result.complete === undefined
    && result.stale === undefined
    && result.lastSuccessAt === undefined
    && result.error === undefined
    ? null
    : result;
};

const validEventRevision = (revision: unknown): revision is number => (
  typeof revision === 'number' && Number.isFinite(revision)
);

export const useWorkspaceSessionIndexStore = create<SessionIndexState>()((set, get) => ({
  snapshot: null,
  status: 'idle',
  lastError: null,
  lastAppliedRevision: 0,
  sessionKeys: new Set(),
  revisionGap: false,

  refresh: async () => {
    set({ status: 'loading' });
    try {
      const snapshot = await fetchWorkspaceSessionSnapshot();
      set({
        snapshot,
        status: 'ready',
        lastError: null,
        lastAppliedRevision: snapshot.revision,
        sessionKeys: new Set(snapshot.sessions.map((session) => session.key)),
        revisionGap: false,
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
      const index = state.snapshot.sessions.findIndex((session) => session.key === summary.key);
      const sessions = index >= 0
        ? state.snapshot.sessions.map((session) => (session.key === summary.key ? summary : session))
        : [...state.snapshot.sessions, summary];
      const sessionKeys = index >= 0 ? state.sessionKeys : new Set(state.sessionKeys).add(summary.key);
      return {
        snapshot: { ...state.snapshot, sessions },
        sessionKeys,
        lastAppliedRevision: event.revision,
      };
    }

    if (event.type === 'session.removed') {
      if (typeof event.workspaceId !== 'string' || event.workspaceId.length === 0
        || typeof event.sessionId !== 'string' || event.sessionId.length === 0) return state;
      const key = workspaceSessionKey(event.workspaceId, event.sessionId);
      if (!state.sessionKeys.has(key)) return state;
      return {
        snapshot: {
          ...state.snapshot,
          sessions: state.snapshot.sessions.filter((session) => session.key !== key),
        },
        sessionKeys: (() => {
          const next = new Set(state.sessionKeys);
          next.delete(key);
          return next;
        })(),
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
}));

export const selectSessionsForWorkspace = (
  snapshot: WorkspaceSessionSnapshot | null,
  workspaceId: WorkspaceId,
): WorkspaceSessionSummary[] => (
  snapshot ? snapshot.sessions.filter((session) => session.workspaceId === workspaceId) : []
);
