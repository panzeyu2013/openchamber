import { createControlPlaneFetch } from './control-plane-fetch';
import { CatalogClientError, type ProjectSessionEvent, type ProjectSessionSnapshot } from './types';

/**
 * Session Index client (renderer). All requests go to the LOCAL CONTROL PLANE
 * through a control-plane-pinned fetch (never the Active Runtime, never a
 * remote URL); the server resolves connections into adapters server-side.
 * The event stream is plain SSE (bearer-header auth), so it works unchanged
 * through the relay tunnel.
 */

const controlPlaneFetch = createControlPlaneFetch();

const isJsonOk = async (response: Response): Promise<unknown> => {
  if (!response.ok) {
    let code = 'session_index_http_error';
    let message = `Request failed with status ${response.status}`;
    try {
      const body = await response.json();
      if (body && typeof body === 'object') {
        if (typeof body.error === 'string') message = body.error;
        if (typeof body.code === 'string') code = body.code;
      }
    } catch {
      // non-JSON error body; keep the status-based message
    }
    throw new CatalogClientError(message, response.status, code);
  }
  return response.json();
};

const jsonRequest = async (path: string, init?: RequestInit): Promise<unknown> => {
  const response = await controlPlaneFetch(path, init);
  return isJsonOk(response);
};

export const fetchProjectSessionSnapshot = async (): Promise<ProjectSessionSnapshot> => {
  const body = await jsonRequest('/api/project-sessions/snapshot', { headers: { accept: 'application/json' } });
  const snapshot = body && typeof body === 'object' ? body as Partial<ProjectSessionSnapshot> : null;
  if (
    !snapshot
    || typeof snapshot.revision !== 'number'
    || !Array.isArray(snapshot.sessions)
    || !snapshot.freshnessByConnection
    || typeof snapshot.freshnessByConnection !== 'object'
  ) {
    throw new CatalogClientError('Session index response has an invalid shape', 500, 'session_index_invalid_response');
  }
  const freshnessByConnection = Object.fromEntries(
    Object.entries(snapshot.freshnessByConnection).map(([connectionId, value]) => {
      if (!value || typeof value !== 'object') {
        throw new CatalogClientError(`Session index freshness for ${connectionId} has an invalid shape`, 500, 'session_index_invalid_response');
      }
      const freshness = value as unknown as Record<string, unknown>;
      if (typeof freshness.complete !== 'boolean' || typeof freshness.stale !== 'boolean') {
        throw new CatalogClientError(`Session index freshness for ${connectionId} has an invalid shape`, 500, 'session_index_invalid_response');
      }
      const lastSuccessAt = freshness.lastSuccessAt === null || typeof freshness.lastSuccessAt === 'number'
        ? freshness.lastSuccessAt
        : null;
      const error = freshness.error === null || freshness.error === undefined
        ? null
        : (typeof freshness.error === 'object' ? freshness.error : null);
      return [connectionId, {
        complete: freshness.complete,
        partial: freshness.partial === true,
        offline: freshness.offline === true,
        stale: freshness.stale,
        lastSuccessAt,
        error,
      }];
    }),
  );
  if (
    snapshot.truncatedByConnection !== undefined
    && (typeof snapshot.truncatedByConnection !== 'object' || snapshot.truncatedByConnection === null)
  ) {
    throw new CatalogClientError('Session index response has an invalid shape', 500, 'session_index_invalid_response');
  }
  return { ...snapshot, freshnessByConnection } as ProjectSessionSnapshot;
};

export const createProjectSession = async (
  projectId: string,
  prompt?: string,
): Promise<{ sessionId: string; projectId: string }> => {
  const body = await jsonRequest(`/api/projects/${encodeURIComponent(projectId)}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(prompt !== undefined ? { prompt } : {}),
  });
  const result = body && typeof body === 'object' ? body as { sessionId?: unknown; projectId?: unknown } : null;
  if (
    !result
    || typeof result.sessionId !== 'string'
    || result.sessionId.length === 0
    || typeof result.projectId !== 'string'
    || result.projectId.length === 0
  ) {
    throw new CatalogClientError('Session creation response has an invalid shape', 500, 'session_index_invalid_response');
  }
  return { sessionId: result.sessionId, projectId: result.projectId };
};

export const bindProjectSession = async (
  projectId: string,
  sessionId: string,
  directory?: string,
): Promise<{ bound: boolean }> => {
  const body = await jsonRequest(
    `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/bind`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(directory !== undefined ? { directory } : {}),
    },
  );
  const result = body && typeof body === 'object' ? body as { bound?: unknown } : null;
  if (!result || typeof result.bound !== 'boolean') {
    throw new CatalogClientError('Bind session response has an invalid shape', 500, 'session_index_invalid_response');
  }
  return { bound: result.bound };
};

const HEALTHY_STREAM_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;
const DEFAULT_INITIAL_BACKOFF_MS = 1_000;

/** Deterministic mulberry32 PRNG: the same seed always yields the same
 * sequence, so reconnect schedules are reproducible in tests (§17.5). */
export const createSeededRandom = (seed: number): () => number => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** ±20% uniform backoff jitter clamped to [minDelay, maxDelay]. */
export const withBackoffJitter = (
  baseDelay: number,
  randomValue: number,
  minDelay: number,
  maxDelay: number,
): number => {
  const jittered = Math.round(baseDelay * (0.8 + 0.4 * Math.max(0, Math.min(1, randomValue))));
  return Math.min(maxDelay, Math.max(minDelay, jittered));
};

export interface ProjectSessionEventStreamOptions {
  initialBackoffMs?: number;
  /** Deterministic jitter seed; defaults to an entropy-derived per-stream
   * seed so independent streams never reconnect in lockstep (§17.5). */
  jitterSeed?: number;
}

const parseEventChunk = (chunk: string): ProjectSessionEvent | null => {
  const dataLine = chunk.split('\n').find((line) => line.startsWith('data:'));
  if (!dataLine) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(dataLine.slice(5).trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const event = parsed as Partial<ProjectSessionEvent>;
  if (typeof event.revision !== 'number' || typeof event.type !== 'string') return null;
  return event as ProjectSessionEvent;
};

/**
 * Opens the server-side SSE event stream and reconnects with exponential
 * backoff (1s base, 30s cap) mirroring the fleet summary transport pacing:
 * EOF and errors count as failures; only a stream that stayed up long enough
 * resets the backoff. Each reconnect delay gets deterministic ±20% jitter
 * (seeded per stream via `jitterSeed` or an entropy default, clamped to the
 * configured bounds — §17.5) so a fleet
 * of clients does not reconnect in lockstep. Returns a cleanup function that
 * aborts the connection and clears any pending reconnect timer.
 */
export const openProjectSessionEventStream = (
  onEvent: (event: ProjectSessionEvent) => void,
  signal: AbortSignal,
  options: ProjectSessionEventStreamOptions = {},
): () => void => {
  const abort = new AbortController();
  const onOuterAbort = () => abort.abort();
  signal.addEventListener('abort', onOuterAbort, { once: true });
  const initialBackoffMs = options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
  const jitterRandom = createSeededRandom(
    options.jitterSeed ?? ((Date.now() ^ Math.floor(Math.random() * 0xFFFFFFFF)) >>> 0),
  );
  let consecutiveFailures = 0;
  let waitTimer: ReturnType<typeof setTimeout> | null = null;

  const wait = (ms: number): Promise<void> => new Promise((resolve) => {
    const onWaitAbort = () => {
      clearTimeout(waitTimer ?? undefined);
      waitTimer = null;
      resolve();
    };
    waitTimer = setTimeout(() => {
      abort.signal.removeEventListener('abort', onWaitAbort);
      waitTimer = null;
      resolve();
    }, ms);
    abort.signal.addEventListener('abort', onWaitAbort, { once: true });
  });

  void (async () => {
    while (!abort.signal.aborted) {
      const acquiredAt = Date.now();
      try {
        const response = await controlPlaneFetch('/api/project-sessions/events', {
          headers: { accept: 'text/event-stream' },
          signal: abort.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error(`session event stream unavailable (${response.status})`);
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
            const event = parseEventChunk(chunk);
            if (event) onEvent(event);
          }
        }
        if (abort.signal.aborted) return;
      } catch {
        if (abort.signal.aborted) return;
      }
      consecutiveFailures = Date.now() - acquiredAt >= HEALTHY_STREAM_MS ? 0 : consecutiveFailures + 1;
      const baseDelay = Math.min(initialBackoffMs * (2 ** Math.max(0, consecutiveFailures - 1)), MAX_BACKOFF_MS);
      const delay = withBackoffJitter(baseDelay, jitterRandom(), initialBackoffMs, MAX_BACKOFF_MS);
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      await wait(hidden ? delay : Math.min(delay, 10_000));
    }
  })();

  return () => {
    signal.removeEventListener('abort', onOuterAbort);
    if (waitTimer !== null) clearTimeout(waitTimer);
    abort.abort();
  };
};
