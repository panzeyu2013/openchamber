/**
 * Server-side Session Index.
 *
 * Maintains a LIGHTWEIGHT cross-connection index of workspace sessions:
 * - At most ONE upstream event stream per connection (never one per
 *   workspace); structural session events trigger debounced snapshot
 *   refreshes of that connection.
 * - Sessions are mapped to workspaces through the binding store; when no
 *   binding exists, an exact canonical-path match against the connection's
 *   workspaces is the only automatic fallback. Unmatched sessions go to the
 *   unassigned diagnostics bucket — they are never silently attached to an
 *   arbitrary workspace.
 * - Per-connection freshness: a failed fetch keeps the previous snapshot and
 *   marks `stale`/`error`; one failing connection never blocks or clears
 *   other connections.
 * - A single global revision; clients with a revision gap must re-fetch the
 *   snapshot. Incremental events never regress newer state.
 *
 * Message bodies, file trees, terminals and permission state are NEVER held
 * here — the active workspace's full sync loads those on demand.
 */

import { workspaceSessionKey } from './workspace-identity.js';

const SNAPSHOT_LIMIT = 500;
const STRUCTURAL_REFRESH_DEBOUNCE_MS = 250;
const HEALTHY_STREAM_MS = 30_000;
const MAX_BACKOFF_MS = 60_000;

const normalizePath = (value) => {
  if (typeof value !== 'string' || value.length === 0) return '';
  const replaced = value.replace(/\\/g, '/');
  if (replaced === '/') return '/';
  return replaced.replace(/\/+$/, '');
};

const readString = (value) => (typeof value === 'string' && value.length > 0 ? value : null);

/** Projects one raw OpenCode event into a narrow session index event. Never
 * retains message/part payload content. */
export const parseSessionIndexEvent = (value) => {
  const payload = value && typeof value === 'object' && 'payload' in value
    ? value.payload
    : value;
  if (!payload || typeof payload !== 'object') return null;
  const event = payload;
  if (typeof event.type !== 'string' || !event.properties || typeof event.properties !== 'object') return null;
  const properties = event.properties;
  const info = properties.info && typeof properties.info === 'object' ? properties.info : null;
  const sessionId = readString(properties.sessionID) ?? readString(properties.sessionId) ?? readString(info?.id);
  if (!sessionId) return null;
  if (event.type === 'session.status') {
    const statusType = properties.status?.type;
    return {
      sessionId,
      activity: statusType === 'busy' || statusType === 'retry' ? statusType : 'idle',
    };
  }
  if (event.type === 'session.created' || event.type === 'session.updated' || event.type === 'session.deleted') {
    return {
      sessionId,
      structural: event.type === 'session.created' ? 'created' : (event.type === 'session.deleted' ? 'deleted' : 'updated'),
    };
  }
  return null;
};

export const createSessionIndex = (dependencies) => {
  const {
    catalogStore,
    profileStore,
    connectionBroker,
    bindingStore,
    credentialProvider = null,
    logger = null,
  } = dependencies;

  let globalRevision = 0;
  /** @type {Map<string, object>} connectionId -> connection state */
  const connections = new Map();
  const eventListeners = new Set();

  const log = (message, detail) => {
    logger?.log?.(`[workspaces:session-index] ${message}`, detail ?? '');
  };

  const bumpRevision = () => {
    globalRevision += 1;
    return globalRevision;
  };

  const emitEvent = (event) => {
    event.revision = globalRevision;
    for (const listener of eventListeners) listener({ ...event });
  };

  const subscribeEvents = (listener) => {
    eventListeners.add(listener);
    return () => eventListeners.delete(listener);
  };

  const getConnectionState = (connectionId) => {
    let state = connections.get(connectionId);
    if (!state) {
      state = {
        freshness: {
          complete: false,
          stale: false,
          lastSuccessAt: null,
          error: null,
        },
        sessions: new Map(),
        unassignedCount: 0,
        truncated: false,
        observer: null,
        backoff: { consecutiveFailures: 0, timer: null },
        refreshTimer: null,
        refreshInFlight: null,
      };
      connections.set(connectionId, state);
    }
    return state;
  };

  const listWorkspacesForConnection = async (connectionId) => {
    const workspaces = await catalogStore.listWorkspacesForConnection(connectionId);
    return workspaces;
  };

  /** Exact-path fallback ONLY when no binding exists for the session. */
  const resolveWorkspaceForSession = async (connectionId, session) => {
    const binding = await bindingStore.getBinding(connectionId, session.id);
    if (binding) return binding.workspaceId;
    const workspaces = await listWorkspacesForConnection(connectionId);
    const directory = normalizePath(session.directory ?? '');
    if (!directory) return null;
    const match = workspaces.find((workspace) => normalizePath(workspace.canonicalPath) === directory);
    return match?.id ?? null;
  };

  const applySnapshot = async (connectionId, payload) => {
    const state = getConnectionState(connectionId);
    const next = new Map();
    let unassigned = 0;
    const sessions = Array.isArray(payload) ? payload : [];
    for (const session of sessions) {
      if (!session || typeof session !== 'object' || typeof session.id !== 'string') continue;
      const workspaceId = await resolveWorkspaceForSession(connectionId, session);
      if (!workspaceId) {
        unassigned += 1;
        continue;
      }
      const key = workspaceSessionKey(workspaceId, session.id);
      const previous = state.sessions.get(key);
      next.set(key, {
        key,
        workspaceId,
        upstreamSessionId: session.id,
        directory: normalizePath(session.directory ?? ''),
        title: typeof session.title === 'string' && session.title.length > 0 ? session.title : session.id,
        updatedAt: Number(session.time?.updated) || 0,
        archived: Boolean(session.time?.archived),
        // Activity is event-derived; preserve the live value across refreshes.
        activity: previous?.activity ?? 'idle',
      });
    }
    const changed = next.size !== state.sessions.size
      || [...next.entries()].some(([key, session]) => {
        const previous = state.sessions.get(key);
        return !previous
          || previous.directory !== session.directory
          || previous.title !== session.title
          || previous.updatedAt !== session.updatedAt
          || previous.archived !== session.archived;
      });
    state.sessions = next;
    state.unassignedCount = unassigned;
    state.truncated = sessions.length >= SNAPSHOT_LIMIT;
    state.freshness = {
      complete: true,
      stale: false,
      lastSuccessAt: Date.now(),
      error: null,
    };
    if (changed) {
      bumpRevision();
      emitEvent({
        connectionId,
        workspaceId: null,
        sessionId: null,
        type: 'freshness.changed',
        payload: { complete: true },
      });
    }
    return changed;
  };

  const markConnectionFailed = (connectionId, error) => {
    const state = getConnectionState(connectionId);
    state.freshness = {
      ...state.freshness,
      complete: false,
      stale: state.freshness.lastSuccessAt !== null,
      error: {
        code: error?.code ?? 'session_index_fetch_failed',
        message: error?.message ?? 'Session index fetch failed',
      },
    };
    bumpRevision();
    emitEvent({
      connectionId,
      workspaceId: null,
      sessionId: null,
      type: 'freshness.changed',
      payload: { complete: false, stale: state.freshness.stale },
    });
  };

  const fetchConnectionSnapshot = async (connectionId, profile, adapter) => {
    const context = {
      profile,
      canonicalPath: null,
      credentialProvider,
    };
    const request = {
      method: 'GET',
      headers: new Headers({ accept: 'application/json' }),
    };
    const response = await adapter.fetch(context, request, `/api/experimental/session?archived=false&limit=${SNAPSHOT_LIMIT}`);
    if (!response.ok) {
      const error = new Error(`Session list failed (${response.status})`);
      error.code = 'session_index_upstream_error';
      throw error;
    }
    const payload = await response.json();
    if (!Array.isArray(payload)) {
      const error = new Error('Session list returned an invalid payload');
      error.code = 'session_index_invalid_payload';
      throw error;
    }
    await applySnapshot(connectionId, payload);
  };

  const scheduleSnapshotRefresh = (connectionId) => {
    const state = getConnectionState(connectionId);
    if (state.refreshTimer) return;
    state.refreshTimer = setTimeout(() => {
      state.refreshTimer = null;
      void refreshConnection(connectionId, { background: true }).catch((error) => {
        log('background refresh failed', `${connectionId}: ${error?.message ?? error}`);
      });
    }, STRUCTURAL_REFRESH_DEBOUNCE_MS);
  };

  const clearObserver = (connectionId) => {
    const state = getConnectionState(connectionId);
    if (state.observer) {
      state.observer.stop();
      state.observer = null;
    }
    if (state.backoff.timer) {
      clearTimeout(state.backoff.timer);
      state.backoff.timer = null;
    }
  };

  /** One global event stream per connection with exponential backoff; EOF and
   * errors count as failures, a healthy stream resets the counter. */
  const startObserver = (connectionId, profile, adapter) => {
    clearObserver(connectionId);
    const state = getConnectionState(connectionId);
    const abort = new AbortController();
    state.observer = {
      stop: () => abort.abort(),
    };
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    void (async () => {
      while (!abort.signal.aborted) {
        const acquiredAt = Date.now();
        try {
          const context = { profile, canonicalPath: null, credentialProvider };
          const response = await adapter.openEventStream(context, '/api/global/event', abort.signal);
          if (!response.ok || !response.body) {
            throw new Error(`event stream unavailable (${response.status})`);
          }
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let boundary;
            while ((boundary = buffer.indexOf('\n\n')) >= 0) {
              const chunk = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const dataLine = chunk.split('\n').find((line) => line.startsWith('data:'));
              if (!dataLine) continue;
              let parsed;
              try {
                parsed = JSON.parse(dataLine.slice(5).trim());
              } catch {
                continue;
              }
              const event = parseSessionIndexEvent(parsed);
              if (!event) continue;
              handleIndexedEvent(connectionId, event);
            }
          }
          if (abort.signal.aborted) return;
        } catch {
          if (abort.signal.aborted) return;
        }
        const stateNow = getConnectionState(connectionId);
        stateNow.backoff.consecutiveFailures = Date.now() - acquiredAt >= HEALTHY_STREAM_MS
          ? 0
          : stateNow.backoff.consecutiveFailures + 1;
        stateNow.freshness = {
          ...stateNow.freshness,
          stale: stateNow.freshness.lastSuccessAt !== null,
        };
        const baseDelay = Math.min(1_000 * (2 ** Math.max(0, stateNow.backoff.consecutiveFailures - 1)), MAX_BACKOFF_MS);
        await wait(baseDelay);
      }
    })();
  };

  const handleIndexedEvent = (connectionId, event) => {
    const state = getConnectionState(connectionId);
    if (event.activity !== undefined) {
      // Live activity only touches the affected session.
      let changed = false;
      for (const [key, session] of state.sessions) {
        if (session.upstreamSessionId !== event.sessionId) continue;
        const next = { ...session, activity: event.activity };
        state.sessions.set(key, next);
        changed = true;
        bumpRevision();
        emitEvent({
          connectionId,
          workspaceId: session.workspaceId,
          sessionId: event.sessionId,
          type: 'session.upserted',
          payload: next,
        });
      }
      if (!changed) return;
      return;
    }
    if (event.structural) {
      scheduleSnapshotRefresh(connectionId);
    }
  };

  const refreshConnection = async (connectionId, options = {}) => {
    const state = getConnectionState(connectionId);
    if (state.refreshInFlight) return state.refreshInFlight;
    const resolved = await connectionBroker.resolveConnection(connectionId);
    if (!resolved) {
      markConnectionFailed(connectionId, { code: 'catalog_connection_not_found', message: 'Connection is not available' });
      return null;
    }
    const { profile, adapter } = resolved;
    const release = connectionBroker.acquireLease(connectionId);
    state.refreshInFlight = (async () => {
      try {
        await fetchConnectionSnapshot(connectionId, profile, adapter);
      } catch (error) {
        markConnectionFailed(connectionId, error);
        if (!options.background) throw error;
      } finally {
        release();
        state.refreshInFlight = null;
      }
    })();
    return state.refreshInFlight;
  };

  const ensureObserved = async (connectionId) => {
    const state = getConnectionState(connectionId);
    if (state.observer) return;
    const resolved = await connectionBroker.resolveConnection(connectionId);
    if (!resolved) return;
    startObserver(connectionId, resolved.profile, resolved.adapter);
  };

  /** Refresh every connection with saved profiles; one failure never blocks
   * the others. Results reflect the connection's freshness after the pass. */
  const refreshAll = async () => {
    const records = await profileStore.listPrivateRecords();
    const results = {};
    await Promise.all(records.map(async (record) => {
      const state = getConnectionState(record.id);
      const wasComplete = state.freshness.complete;
      try {
        await refreshConnection(record.id, { background: true });
      } catch {
        // background mode swallows errors into freshness; nothing to do
      }
      results[record.id] = { ok: state.freshness.complete || wasComplete };
    }));
    return results;
  };

  const getSnapshot = async () => {
    const records = await profileStore.listPrivateRecords();
    const sessions = [];
    const freshnessByConnection = {};
    for (const record of records) {
      const state = getConnectionState(record.id);
      freshnessByConnection[record.id] = { ...state.freshness };
      for (const session of state.sessions.values()) sessions.push({ ...session });
    }
    return {
      revision: globalRevision,
      sessions: sessions.sort((left, right) => right.updatedAt - left.updatedAt),
      freshnessByConnection,
    };
  };

  const getDiagnostics = async () => {
    const records = await profileStore.listPrivateRecords();
    return {
      revision: globalRevision,
      connections: Object.fromEntries(records.map((record) => {
        const state = getConnectionState(record.id);
        return [record.id, {
          sessionCount: state.sessions.size,
          unassignedCount: state.unassignedCount,
          truncated: state.truncated,
          freshness: { ...state.freshness },
          observed: Boolean(state.observer),
        }];
      })),
    };
  };

  const dispose = async () => {
    for (const connectionId of connections.keys()) {
      clearObserver(connectionId);
      const state = getConnectionState(connectionId);
      if (state.refreshTimer) clearTimeout(state.refreshTimer);
    }
    connections.clear();
    eventListeners.clear();
  };

  return {
    refreshAll,
    refreshConnection,
    ensureObserved,
    getSnapshot,
    subscribeEvents,
    getDiagnostics,
    dispose,
    _getStateForTest: (connectionId) => connections.get(connectionId) ?? null,
  };
};
