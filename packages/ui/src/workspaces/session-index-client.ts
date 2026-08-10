import { createControlPlaneFetch } from './control-plane-fetch';
import { CatalogClientError, type WorkspaceSessionEvent, type WorkspaceSessionSnapshot } from './types';

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

export const fetchWorkspaceSessionSnapshot = async (): Promise<WorkspaceSessionSnapshot> => {
  const body = await jsonRequest('/api/workspace-sessions/snapshot', { headers: { accept: 'application/json' } });
  const snapshot = body && typeof body === 'object' ? body as Partial<WorkspaceSessionSnapshot> : null;
  if (
    !snapshot
    || typeof snapshot.revision !== 'number'
    || !Array.isArray(snapshot.sessions)
    || !snapshot.freshnessByConnection
    || typeof snapshot.freshnessByConnection !== 'object'
  ) {
    throw new CatalogClientError('Session index response has an invalid shape', 500, 'session_index_invalid_response');
  }
  if (
    snapshot.truncatedByConnection !== undefined
    && (typeof snapshot.truncatedByConnection !== 'object' || snapshot.truncatedByConnection === null)
  ) {
    throw new CatalogClientError('Session index response has an invalid shape', 500, 'session_index_invalid_response');
  }
  return snapshot as WorkspaceSessionSnapshot;
};

export const createWorkspaceSession = async (
  workspaceId: string,
  prompt?: string,
): Promise<{ sessionId: string; workspaceId: string }> => {
  const body = await jsonRequest(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(prompt !== undefined ? { prompt } : {}),
  });
  const result = body && typeof body === 'object' ? body as { sessionId?: unknown; workspaceId?: unknown } : null;
  if (
    !result
    || typeof result.sessionId !== 'string'
    || result.sessionId.length === 0
    || typeof result.workspaceId !== 'string'
    || result.workspaceId.length === 0
  ) {
    throw new CatalogClientError('Session creation response has an invalid shape', 500, 'session_index_invalid_response');
  }
  return { sessionId: result.sessionId, workspaceId: result.workspaceId };
};

export const bindWorkspaceSession = async (
  workspaceId: string,
  sessionId: string,
  directory?: string,
): Promise<{ bound: boolean }> => {
  const body = await jsonRequest(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/bind`,
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

export interface WorkspaceSessionEventStreamOptions {
  initialBackoffMs?: number;
}

const parseEventChunk = (chunk: string): WorkspaceSessionEvent | null => {
  const dataLine = chunk.split('\n').find((line) => line.startsWith('data:'));
  if (!dataLine) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(dataLine.slice(5).trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const event = parsed as Partial<WorkspaceSessionEvent>;
  if (typeof event.revision !== 'number' || typeof event.type !== 'string') return null;
  return event as WorkspaceSessionEvent;
};

/**
 * Opens the server-side SSE event stream and reconnects with exponential
 * backoff (1s base, 30s cap) mirroring the fleet summary transport pacing:
 * EOF and errors count as failures; only a stream that stayed up long enough
 * resets the backoff. Returns a cleanup function that aborts the connection
 * and clears any pending reconnect timer.
 */
export const openWorkspaceSessionEventStream = (
  onEvent: (event: WorkspaceSessionEvent) => void,
  signal: AbortSignal,
  options: WorkspaceSessionEventStreamOptions = {},
): () => void => {
  const abort = new AbortController();
  const onOuterAbort = () => abort.abort();
  signal.addEventListener('abort', onOuterAbort, { once: true });
  const initialBackoffMs = options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
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
        const response = await controlPlaneFetch('/api/workspace-sessions/events', {
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
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      await wait(hidden ? baseDelay : Math.min(baseDelay, 10_000));
    }
  })();

  return () => {
    signal.removeEventListener('abort', onOuterAbort);
    if (waitTimer !== null) clearTimeout(waitTimer);
    abort.abort();
  };
};
