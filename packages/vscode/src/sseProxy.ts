import type { OpenCodeManager } from './opencode';
import { waitForApiUrl } from './opencode-ready';

type OpenSseProxyOptions = {
  manager: OpenCodeManager;
  path: string;
  headers?: Record<string, string>;
  signal: AbortSignal;
  onChunk: (chunk: string) => void;
  stallTimeoutMs?: number;
  /** Forward to the configured control plane (`openchamber.apiUrl`) instead
   * of the managed opencode binary: the target is `{controlPlaneOrigin}{path}`
   * verbatim (no `/event` normalization, no default-directory injection) with
   * the same auth headers the binary's event stream uses. The upstream stream
   * is relayed as-is and the host does NOT reconnect — the session-index
   * client owns reconnect with its own backoff, so the host fails fast instead
   * of stacking retry layers. */
  controlPlane?: boolean;
  /** Control-plane origin resolved by the caller (`readConfiguredControlPlaneOrigin`),
   * required when `controlPlane` is set. Missing origins throw before any
   * fetch so the callers can answer `capability_unavailable` explicitly. */
  controlPlaneOrigin?: string | null;
};

type OpenSseProxyResult = {
  headers: Record<string, string>;
  run: Promise<void>;
};

const SSE_RESPONSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
} as const;

// SSE reconnect configuration
const MAX_RECONNECTS = 3;
const BASE_RECONNECT_DELAY = 1000; // 1 second
const DEFAULT_UPSTREAM_STALL_TIMEOUT_MS = 20000;

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) {
    resolve();
    return;
  }

  const timeout = setTimeout(() => {
    signal.removeEventListener('abort', handleAbort);
    resolve();
  }, ms);
  const handleAbort = () => {
    clearTimeout(timeout);
    resolve();
  };
  signal.addEventListener('abort', handleAbort, { once: true });
});

const getAbortReason = (signal: AbortSignal) => signal.reason ?? new DOMException('Aborted', 'AbortError');

const normalizeSsePath = (path: string): { pathname: '/event' | '/global/event'; searchParams: URLSearchParams; directory: string | null } => {
  const parsed = new URL(path, 'https://openchamber.invalid');
  const pathname = parsed.pathname === '/global/event' ? '/global/event' : '/event';
  const directory = parsed.searchParams.get('directory');
  return {
    pathname,
    searchParams: new URLSearchParams(parsed.searchParams),
    directory: typeof directory === 'string' && directory.trim().length > 0 ? directory.trim() : null,
  };
};

const resolveDefaultDirectory = (manager: OpenCodeManager): string => {
  return manager.getWorkingDirectory() || 'global';
};

const createSseUrl = (baseUrl: string, pathname: '/event' | '/global/event', searchParams: URLSearchParams, directory: string): URL => {
  const base = `${baseUrl.replace(/\/+$/, '')}/`;
  const url = new URL(pathname.replace(/^\/+/, ''), base);
  for (const [key, value] of searchParams) {
    url.searchParams.append(key, value);
  }
  if (pathname === '/event' && !url.searchParams.has('directory')) {
    url.searchParams.set('directory', directory);
  }
  return url;
};

const createSseHeaders = (manager: OpenCodeManager, headers?: Record<string, string>): Record<string, string> => ({
  Accept: 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  ...(headers || {}),
  ...manager.getOpenCodeAuthHeaders(),
});

const createSseResponseHeaders = (response: Response): Record<string, string> => ({
  'content-type': response.headers.get('content-type') || SSE_RESPONSE_HEADERS['content-type'],
  'cache-control': response.headers.get('cache-control') || SSE_RESPONSE_HEADERS['cache-control'],
});

const fetchSseResponse = async (
  manager: OpenCodeManager,
  path: string,
  headers: Record<string, string> | undefined,
  signal: AbortSignal,
  controlPlane: boolean | undefined,
  controlPlaneOrigin: string | null | undefined,
): Promise<Response> => {
  let targetUrl: string;
  if (controlPlane) {
    const origin = typeof controlPlaneOrigin === 'string' && controlPlaneOrigin.trim().length > 0
      ? controlPlaneOrigin.trim()
      : null;
    if (!origin) {
      throw new Error('Control plane is not available in the VS Code runtime');
    }
    const parsed = new URL(path, 'https://openchamber.invalid');
    // Resolve relative to the origin base (no leading slash) so a
    // path-prefixed control-plane origin (`https://host/chamber`) keeps its
    // prefix — same joining rule as the generic `api:proxy` forward.
    targetUrl = new URL(`${parsed.pathname}${parsed.search}`.replace(/^\/+/, ''), `${origin.replace(/\/+$/, '')}/`).toString();
  } else {
    const baseUrl = await waitForApiUrl(manager);
    if (!baseUrl) {
      throw new Error('OpenCode API URL not available');
    }

    const { pathname, searchParams, directory } = normalizeSsePath(path);
    const resolvedDirectory = directory || resolveDefaultDirectory(manager);
    targetUrl = createSseUrl(baseUrl, pathname, searchParams, resolvedDirectory).toString();
  }

  const response = await fetch(targetUrl, {
    method: 'GET',
    headers: createSseHeaders(manager, headers),
    signal,
  });

  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const error = new Error(`OpenCode SSE request failed (${response.status})`);
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }

  if (!response.body) {
    throw new Error('OpenCode SSE response missing body');
  }

  return response;
};

const resolveStallTimeoutMs = (value: number | undefined): number => (
  Number.isFinite(value) && typeof value === 'number' ? value : DEFAULT_UPSTREAM_STALL_TIMEOUT_MS
);

const pipeSseResponse = async (
  response: Response,
  signal: AbortSignal,
  onChunk: (chunk: string) => void,
  stallTimeoutMs?: number,
): Promise<void> => {
  if (!response.body) {
    throw new Error('OpenCode SSE response missing body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let stalled = false;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;

  const clearStallTimer = () => {
    if (!stallTimer) {
      return;
    }
    clearTimeout(stallTimer);
    stallTimer = null;
  };

  const resetStallTimer = () => {
    clearStallTimer();
    const timeoutMs = resolveStallTimeoutMs(stallTimeoutMs);
    if (timeoutMs <= 0) {
      return;
    }
    stallTimer = setTimeout(() => {
      stalled = true;
      void reader.cancel().catch(() => {});
    }, timeoutMs);
  };

  try {
    resetStallTimer();
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value && value.length > 0) {
        resetStallTimer();
        const chunk = decoder.decode(value, { stream: true });
        if (chunk.length > 0) {
          onChunk(chunk);
        }
      }
    }

    const remaining = decoder.decode();
    if (!signal.aborted && remaining.length > 0) {
      onChunk(remaining);
    }
  } catch (error) {
    if (!stalled) {
      throw error;
    }
  } finally {
    clearStallTimer();
    try {
      await reader.cancel();
    } catch {
      // ignore cancel failures during stream shutdown
    }
    try {
      reader.releaseLock();
    } catch {
      // ignore release failures after reader shutdown
    }
  }
};

export const openSseProxy = async ({
  manager,
  path,
  headers,
  signal,
  onChunk,
  stallTimeoutMs,
  controlPlane,
  controlPlaneOrigin,
}: OpenSseProxyOptions): Promise<OpenSseProxyResult> => {
  // Reconnect logic with exponential backoff
  let reconnectAttempts = 0;

  const connect = async (): Promise<Response> => {
    try {
      const { pathname } = normalizeSsePath(path);
      const displayPath = controlPlane ? path : pathname;
      console.log(`[SSE] Connecting to ${displayPath} (attempt ${reconnectAttempts + 1}/${MAX_RECONNECTS + 1})`);

      const result = await fetchSseResponse(manager, path, headers, signal, controlPlane, controlPlaneOrigin);
      reconnectAttempts = 0;
      return result;
    } catch (error) {
      if ((error as Error)?.name === 'AbortError' || signal.aborted) {
        throw error;
      }

      // Control-plane streams fail fast: the session-index client owns
      // reconnect with its own backoff, so the host must not stack retries on
      // top (or delay the explicit capability_unavailable answer).
      if (controlPlane || (!signal.aborted && reconnectAttempts >= MAX_RECONNECTS)) {
        console.error(`[SSE] Connection failed after ${reconnectAttempts} attempts`, error);
        throw error;
      }

      // Implement reconnect logic
      reconnectAttempts++;
      const delay = BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts - 1); // Exponential backoff

      console.warn(
        `[SSE] Connection failed (attempt ${reconnectAttempts}/${MAX_RECONNECTS}), ` +
        `retrying in ${delay}ms...`,
        error
      );

      await sleep(delay, signal);
      if (signal.aborted) {
        throw getAbortReason(signal);
      }
      return connect(); // Recursive retry
    }
  };

  const response = await connect();

  const run = (async () => {
    let activeResponse = response;
    try {
      await pipeSseResponse(activeResponse, signal, onChunk, stallTimeoutMs);
    } catch (error: unknown) {
      const cause = (error as { cause?: { code?: string } } | null)?.cause;

      // Attempt reconnect on socket errors
      if (!signal.aborted && !controlPlane) {
        if (cause?.code === 'UND_ERR_SOCKET' || cause?.code === 'ECONNRESET') {
          console.warn('[SSE] Socket error detected, attempting reconnect...');

          if (reconnectAttempts < MAX_RECONNECTS) {
            reconnectAttempts++;
            const delay = BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts - 1);
            await sleep(delay, signal);
            if (signal.aborted) {
              return;
            }

            // Attempt to reconnect
            try {
              activeResponse = await connect();
              await pipeSseResponse(activeResponse, signal, onChunk, stallTimeoutMs);
              return; // Successfully reconnected
            } catch (reconnectError) {
              console.error('[SSE] Reconnect failed', reconnectError);
            }
          }
        }

        // Re-throw if we couldn't recover
        throw error;
      }
    }
  })();

  return {
    headers: createSseResponseHeaders(response),
    run,
  };
};
