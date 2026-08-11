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
 * - Performance budget (§17.5): live activity events are keyed through a
 *   per-connection `sessionsByUpstreamId` index, so one event touches only
 *   the affected session(s) — never a scan of the connection's collection.
 *   Background snapshot refreshes are capped at `refreshConcurrency`
 *   (default 4) concurrent connections with a worker queue, and stream
 *   reconnect backoff is exponential WITH deterministic ±20% jitter
 *   (seeded per connection) clamped to the 1s→60s bounds.
 *
 * Message bodies, file trees, terminals and permission state are NEVER held
 * here — the active workspace's full sync loads those on demand.
 */

import { workspaceSessionKey } from './workspace-identity.js';

const SNAPSHOT_LIMIT = 500;
const MAX_SNAPSHOT_PAGES = 20;
const STRUCTURAL_REFRESH_DEBOUNCE_MS = 250;
const HEALTHY_STREAM_MS = 30_000;
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const DEFAULT_REFRESH_CONCURRENCY = 4;

const normalizePath = (value) => {
  if (typeof value !== 'string' || value.length === 0) return '';
  const replaced = value.replace(/\\/g, '/');
  if (replaced === '/') return '/';
  return replaced.replace(/\/+$/, '');
};

const readString = (value) => (typeof value === 'string' && value.length > 0 ? value : null);

const SAFE_SESSION_INDEX_ERROR_MESSAGES = Object.freeze({
  catalog_connection_not_found: 'Connection is not available',
  session_index_fetch_failed: 'Session index fetch failed',
  session_index_invalid_payload: 'Session list returned an invalid payload',
  session_index_upstream_error: 'Session list is unavailable',
  session_index_stream_unavailable: 'Live session updates are unavailable',
});

const safeSessionIndexError = (error, fallbackCode = 'session_index_fetch_failed') => {
  const candidateCode = typeof error?.code === 'string' && /^[a-z0-9_.-]+$/.test(error.code)
    ? error.code
    : fallbackCode;
  return {
    code: candidateCode,
    // Upstream errors can contain URLs, query tokens or provider-specific
    // diagnostics. The index exposes stable status semantics, not raw errors.
    message: SAFE_SESSION_INDEX_ERROR_MESSAGES[candidateCode] ?? 'Session index is unavailable',
  };
};

/** FNV-1a string hash: a stable per-connection PRNG seed. */
const hashSeed = (value) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

/** Deterministic mulberry32 PRNG: the same seed always yields the same
 * sequence, so backoff schedules are reproducible in tests (§17.5). */
export const createSeededRandom = (seed) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** ±20% uniform backoff jitter clamped to the configured 1s→60s bounds. */
export const withBackoffJitter = (baseDelay, randomValue) => {
  const jittered = Math.round(baseDelay * (0.8 + 0.4 * Math.max(0, Math.min(1, randomValue))));
  return Math.min(MAX_BACKOFF_MS, Math.max(MIN_BACKOFF_MS, jittered));
};

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
    // §17.5: cap concurrent background snapshot refreshes (injectable for
    // tests; the default keeps 20-connection fleets well inside the budget).
    refreshConcurrency = DEFAULT_REFRESH_CONCURRENCY,
  } = dependencies;

  let globalRevision = 0;
  let disposed = false;
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
          partial: false,
          offline: false,
          stale: false,
          lastSuccessAt: null,
          error: null,
        },
        // Canonical per-connection session store: key -> summary.
        sessions: new Map(),
        // Activity index (§17.5): upstreamSessionId -> Set<key>. A status
        // event for one session resolves through this index instead of
        // scanning the whole sessions map. Rebuilt on every snapshot pass
        // (which is O(n) anyway) and never mutated per-event.
        sessionsByUpstreamId: new Map(),
        unassignedCount: 0,
        truncated: false,
        observer: null,
        observerStartInFlight: null,
        backoff: {
          consecutiveFailures: 0,
          timer: null,
          // Deterministic per-connection jitter stream: the same connection
          // always reconnects on the same schedule; different connections
          // desynchronize.
          jitterRandom: createSeededRandom(hashSeed(connectionId)),
        },
        refreshTimer: null,
        refreshInFlight: null,
        // Diagnostics counters (§19): successful snapshot passes and
        // coverage-gap passes (bounded page walk / cursor cycle).
        reloadCount: 0,
        gapCount: 0,
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

  const applySnapshot = async (connectionId, payload, { partial = false } = {}) => {
    const state = getConnectionState(connectionId);
    // One successful snapshot pass: the "reload" side of §19 diagnostics.
    // A bounded/cyclic page walk is a coverage GAP, never silent truncation.
    state.reloadCount += 1;
    if (partial) state.gapCount += 1;
    const hadSuccessfulSnapshot = state.freshness.lastSuccessAt !== null;
    const previousSessions = state.sessions;
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
        connectionId,
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
    // A bounded/paginated read is not authoritative for entries it did not
    // enumerate. Keep the previous entries in the server-side view as well as
    // in the renderer, so a partial refresh cannot make a session disappear
    // between an SSE event and the next full snapshot.
    const merged = partial
      ? new Map([...state.sessions, ...next])
      : next;
    const changed = merged.size !== previousSessions.size
      || [...merged.entries()].some(([key, session]) => {
        const previous = previousSessions.get(key);
        return !previous
          || previous.directory !== session.directory
          || previous.title !== session.title
          || previous.updatedAt !== session.updatedAt
          || previous.archived !== session.archived
          || previous.activity !== session.activity;
      });
    const previousFreshness = state.freshness;
    const previousTruncated = state.truncated;
    const removed = partial
      ? []
      : [...previousSessions.entries()]
        .filter(([key]) => !merged.has(key))
        .map(([, session]) => session);
    const upserted = hadSuccessfulSnapshot
      ? [...merged.entries()]
        .filter(([key, session]) => {
          const previous = previousSessions.get(key);
          return !previous
            || previous.directory !== session.directory
            || previous.title !== session.title
            || previous.updatedAt !== session.updatedAt
            || previous.archived !== session.archived
            || previous.activity !== session.activity;
        })
        .map(([, session]) => session)
      : [];
    state.sessions = merged;
    const sessionsByUpstreamId = new Map();
    for (const [key, session] of merged) {
      let keys = sessionsByUpstreamId.get(session.upstreamSessionId);
      if (!keys) {
        keys = new Set();
        sessionsByUpstreamId.set(session.upstreamSessionId, keys);
      }
      keys.add(key);
    }
    state.sessionsByUpstreamId = sessionsByUpstreamId;
    state.unassignedCount = partial ? Math.max(state.unassignedCount, unassigned) : unassigned;
    state.truncated = partial;
    state.freshness = {
      complete: !partial,
      partial,
      offline: false,
      stale: false,
      lastSuccessAt: Date.now(),
      error: null,
    };
    const freshnessChanged = previousFreshness.complete !== state.freshness.complete
      || previousFreshness.partial !== state.freshness.partial
      || previousFreshness.offline !== state.freshness.offline
      || previousFreshness.stale !== state.freshness.stale
      || previousFreshness.error !== null
      || previousTruncated !== partial;
    // The first snapshot is delivered through GET /snapshot, so it only
    // needs a freshness event. Once a client has a baseline, structural
    // refreshes must be incremental: a freshness-only event would leave the
    // renderer with stale sessions even though the revision advanced.
    if (hadSuccessfulSnapshot) {
      for (const session of removed) {
        bumpRevision();
        emitEvent({
          connectionId,
          workspaceId: session.workspaceId,
          sessionId: session.upstreamSessionId,
          type: 'session.removed',
          payload: null,
        });
      }
      for (const session of upserted) {
        bumpRevision();
        emitEvent({
          connectionId,
          workspaceId: session.workspaceId,
          sessionId: session.upstreamSessionId,
          type: 'session.upserted',
          payload: { ...session },
        });
      }
    }
    if (freshnessChanged || !hadSuccessfulSnapshot) {
      // If the snapshot only changed structurally, the per-session events
      // above already advanced the revision. Freshness gets its own revision
      // only when its state changed (or for the initial baseline event).
      bumpRevision();
      emitEvent({
        connectionId,
        workspaceId: null,
        sessionId: null,
        type: 'freshness.changed',
        payload: { complete: !partial, partial, offline: false, stale: false },
      });
    }
    return changed;
  };

  const markConnectionFailed = (connectionId, error) => {
    const state = getConnectionState(connectionId);
    const nextFreshness = {
      ...state.freshness,
      complete: false,
      offline: state.freshness.lastSuccessAt === null,
      stale: state.freshness.lastSuccessAt !== null,
      error: safeSessionIndexError(error),
    };
    const changed = JSON.stringify(state.freshness) !== JSON.stringify(nextFreshness);
    state.freshness = nextFreshness;
    if (!changed) return;
    bumpRevision();
    emitEvent({
      connectionId,
      workspaceId: null,
      sessionId: null,
      type: 'freshness.changed',
      payload: {
        complete: false,
        partial: state.freshness.partial,
        offline: state.freshness.offline,
        stale: state.freshness.stale,
        error: state.freshness.error,
      },
    });
  };

  const markConnectionStale = (connectionId) => {
    const state = getConnectionState(connectionId);
    if (state.freshness.stale) return;
    state.freshness = {
      ...state.freshness,
      offline: state.freshness.lastSuccessAt === null,
      stale: true,
      error: {
        code: 'session_index_stream_unavailable',
        message: 'Live session updates are unavailable',
      },
    };
    bumpRevision();
    emitEvent({
      connectionId,
      workspaceId: null,
      sessionId: null,
      type: 'freshness.changed',
      payload: {
        complete: state.freshness.complete,
        partial: state.freshness.partial,
        offline: state.freshness.offline,
        stale: true,
        error: state.freshness.error,
      },
    });
  };

  const markConnectionLive = (connectionId) => {
    const state = getConnectionState(connectionId);
    if (!state.freshness.stale && state.freshness.error === null) return;
    state.freshness = {
      ...state.freshness,
      stale: false,
      error: null,
    };
    bumpRevision();
    emitEvent({
      connectionId,
      workspaceId: null,
      sessionId: null,
      type: 'freshness.changed',
      payload: {
        complete: state.freshness.complete,
        partial: state.freshness.partial,
        offline: state.freshness.offline,
        stale: false,
        error: null,
      },
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
    const pages = [];
    const seenCursors = new Set();
    let cursor = null;
    let partial = false;
    for (let pageNumber = 0; pageNumber < MAX_SNAPSHOT_PAGES; pageNumber += 1) {
      const query = new URLSearchParams({ archived: 'false', limit: String(SNAPSHOT_LIMIT) });
      if (cursor) query.set('cursor', cursor);
      const response = await adapter.fetch(context, request, `/api/experimental/session?${query.toString()}`);
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
      pages.push(...payload);
      const nextCursor = response.headers?.get?.('x-next-cursor')?.trim() || null;
      if (!nextCursor) {
        cursor = null;
        break;
      }
      if (seenCursors.has(nextCursor)) {
        partial = true;
        cursor = null;
        break;
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
      if (pageNumber === MAX_SNAPSHOT_PAGES - 1) partial = true;
    }
    await applySnapshot(connectionId, pages, { partial });
  };

  const scheduleSnapshotRefresh = (connectionId) => {
    const state = getConnectionState(connectionId);
    if (state.refreshTimer) return;
    state.refreshTimer = setTimeout(() => {
      state.refreshTimer = null;
      void refreshConnection(connectionId, { background: true }).catch((error) => {
        log('background refresh failed', `${connectionId}: code=${safeSessionIndexError(error).code}`);
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
    const release = connectionBroker.acquireLease(connectionId);
    state.observer = {
      stop: () => {
        abort.abort();
        release?.();
      },
    };
    const wait = (ms) => new Promise((resolve) => {
      const timer = setTimeout(() => {
        state.backoff.timer = null;
        abort.signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        state.backoff.timer = null;
        resolve();
      };
      state.backoff.timer = timer;
      abort.signal.addEventListener('abort', onAbort, { once: true });
    });
    void (async () => {
      while (!abort.signal.aborted) {
        const acquiredAt = Date.now();
        try {
          const context = { profile, canonicalPath: null, credentialProvider };
          const response = await adapter.openEventStream(context, '/api/global/event', abort.signal);
          if (!response.ok || !response.body) {
            throw new Error(`event stream unavailable (${response.status})`);
          }
          markConnectionLive(connectionId);
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
        markConnectionStale(connectionId);
        const baseDelay = Math.min(1_000 * (2 ** Math.max(0, stateNow.backoff.consecutiveFailures - 1)), MAX_BACKOFF_MS);
        // Deterministic ±20% jitter clamped to the 1s→60s bounds (§17.5).
        // The per-connection seeded stream keeps schedules reproducible in
        // tests while desynchronizing connections in production.
        await wait(withBackoffJitter(baseDelay, stateNow.backoff.jitterRandom()));
      }
    })();
  };

  const handleIndexedEvent = (connectionId, event) => {
    const state = getConnectionState(connectionId);
    if (event.activity !== undefined) {
      // Live activity only touches the affected session: resolve the key
      // through the upstream-session index (O(affected)) instead of scanning
      // the connection's whole collection (§17.5).
      const keys = state.sessionsByUpstreamId.get(event.sessionId);
      if (!keys || keys.size === 0) return;
      for (const key of keys) {
        const session = state.sessions.get(key);
        if (!session) continue;
        const next = { ...session, activity: event.activity };
        state.sessions.set(key, next);
        bumpRevision();
        emitEvent({
          connectionId,
          workspaceId: session.workspaceId,
          sessionId: event.sessionId,
          type: 'session.upserted',
          payload: next,
        });
      }
      return;
    }
    if (event.structural) {
      scheduleSnapshotRefresh(connectionId);
    }
  };

  const refreshConnection = async (connectionId, options = {}) => {
    const state = getConnectionState(connectionId);
    if (state.refreshInFlight) return state.refreshInFlight;
    const task = (async () => {
      const resolved = await connectionBroker.resolveConnection(connectionId);
      if (!resolved) {
        markConnectionFailed(connectionId, { code: 'catalog_connection_not_found', message: 'Connection is not available' });
        return null;
      }
      const { profile, adapter } = resolved;
      const release = connectionBroker.acquireLease(connectionId);
      try {
        await fetchConnectionSnapshot(connectionId, profile, adapter);
      } catch (error) {
        markConnectionFailed(connectionId, error);
        if (!options.background) throw error;
      } finally {
        release();
      }
      return null;
    })();
    const tracked = task.finally(() => {
      if (state.refreshInFlight === tracked) state.refreshInFlight = null;
    });
    state.refreshInFlight = tracked;
    return tracked;
  };

  const ensureObserved = async (connectionId) => {
    const state = getConnectionState(connectionId);
    if (state.observer) return;
    if (state.observerStartInFlight) return state.observerStartInFlight;
    const task = (async () => {
      const resolved = await connectionBroker.resolveConnection(connectionId);
      if (disposed || !resolved || getConnectionState(connectionId).observer) return;
      startObserver(connectionId, resolved.profile, resolved.adapter);
    })();
    state.observerStartInFlight = task;
    try {
      await task;
    } finally {
      if (state.observerStartInFlight === task) state.observerStartInFlight = null;
    }
  };

  /** Refresh every connection with saved profiles; one failure never blocks
   * the others. Concurrent refreshes are capped at `refreshConcurrency`
   * (default 4, injectable for tests — §17.5); connections beyond the cap
   * queue and drain as slots free. Results reflect the connection's
   * freshness after the pass. */
  const refreshAll = async () => {
    const records = await profileStore.listPrivateRecords();
    const results = {};
    const limit = Math.max(1, refreshConcurrency);
    let cursor = 0;
    const runNext = async () => {
      while (cursor < records.length) {
        const record = records[cursor];
        cursor += 1;
        const state = getConnectionState(record.id);
        const wasComplete = state.freshness.complete;
        try {
          await refreshConnection(record.id, { background: true });
        } catch {
          // background mode swallows errors into freshness; nothing to do
        }
        results[record.id] = { ok: state.freshness.complete || wasComplete };
      }
    };
    const workers = Array.from(
      { length: Math.min(limit, records.length) },
      () => runNext(),
    );
    await Promise.all(workers);
    return results;
  };

  const getSnapshot = async () => {
    const records = await profileStore.listPrivateRecords();
    const sessions = [];
    const freshnessByConnection = {};
    const truncatedByConnection = {};
    for (const record of records) {
      const state = getConnectionState(record.id);
      freshnessByConnection[record.id] = { ...state.freshness };
      truncatedByConnection[record.id] = state.truncated;
      for (const session of state.sessions.values()) sessions.push({ ...session });
    }
    return {
      revision: globalRevision,
      sessions: sessions.sort((left, right) => right.updatedAt - left.updatedAt),
      freshnessByConnection,
      truncatedByConnection,
    };
  };

  const getDiagnostics = async () => {
    const records = await profileStore.listPrivateRecords();
    const connectionDiagnostics = Object.fromEntries(records.map((record) => {
      const state = getConnectionState(record.id);
      return [record.id, {
        sessionCount: state.sessions.size,
        unassignedCount: state.unassignedCount,
        truncated: state.truncated,
        freshness: { ...state.freshness },
        observed: Boolean(state.observer),
        // §19: consecutive failed stream attempts (the live backoff counter)
        // and snapshot reload/coverage-gap counters.
        backoff: state.backoff.consecutiveFailures,
        reloadCount: state.reloadCount,
        gapCount: state.gapCount,
      }];
    }));
    let reloadCount = 0;
    let gapCount = 0;
    for (const entry of Object.values(connectionDiagnostics)) {
      reloadCount += entry.reloadCount;
      gapCount += entry.gapCount;
    }
    return {
      // The global revision is both the snapshot revision and the last event
      // revision: every event emission bumps the counter and stamps it.
      revision: globalRevision,
      lastEventRevision: globalRevision,
      reloadCount,
      gapCount,
      connections: connectionDiagnostics,
    };
  };

  const dispose = async () => {
    disposed = true;
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
