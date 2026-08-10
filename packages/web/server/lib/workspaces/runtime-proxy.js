/**
 * Workspace runtime proxy.
 *
 * Serves `/api/workspaces/:workspaceId/runtime/*` on the CONTROL PLANE and
 * forwards to the workspace's connection adapter:
 *
 *   /api/workspaces/:workspaceId/runtime/api/session?limit=25&directory=/safe
 *     -> adapter.fetch(context, '/api/session?limit=25&directory=/safe', request)
 *
 * Security contract:
 * - The workspaceId is resolved server-side to a SAVED connection and its
 *   canonical path. Clients can never pass an arbitrary upstream URL.
 * - Only `/api/...` paths are forwarded (the SDK base URL is
 *   `/api/workspaces/:workspaceId/runtime/api`, so every SDK path lands under
 *   `/api`). Anything else is rejected with 404.
 * - Upstream credentials are injected by the adapter; upstream auth headers
 *   and internal URLs are never echoed back to the client.
 * - Query strings are preserved end to end (pagination, filtering, directory
 *   and cursor params must reach the upstream).
 * - The workspace runtime fetch is a streaming pass-through (JSON and SSE);
 *   the upstream stream is CANCELLED when the browser disconnects and the
 *   response write path honors backpressure, so a dropped SSE client stops
 *   consuming the upstream stream and the broker lease immediately.
 *   WebSocket upgrades are not wired in this phase and return an explicit
 *   `capability_unavailable` instead of pretending to work.
 */

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD']);

const RUNTIME_PREFIX_PATTERN = /^\/api\/workspaces\/([^/]+)\/runtime(\/.*)?$/;

const isForwardableApiPath = (pathname) => (
  pathname === '/api' || pathname.startsWith('/api/')
);

/** Splits the workspace-prefixed path into { workspaceId, restPath }. The
 * rest path keeps the query string (`/api/session?limit=25`). */
export const parseWorkspaceRuntimePath = (pathname) => {
  const match = RUNTIME_PREFIX_PATTERN.exec(pathname);
  if (!match) return null;
  const restPath = match[2] || '/';
  return { workspaceId: decodeURIComponent(match[1]), restPath };
};

const getRequestPathname = (req) => {
  try {
    const url = new URL(req.originalUrl, 'http://local');
    // Keep the search string: `pathname` alone would drop query params.
    return `${url.pathname}${url.search}`;
  } catch {
    return `${req.path ?? ''}${req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;
  }
};

const sendJsonError = (res, status, message, code) => {
  res.status(status).json({ error: message, ...(code ? { code } : {}) });
};

export const registerWorkspaceRuntimeProxyRoutes = (app, dependencies) => {
  const {
    catalogStore,
    connectionBroker,
    credentialProvider = null,
    logger = null,
  } = dependencies;

  const resolveWorkspaceContext = async (workspaceId) => {
    const workspace = await catalogStore.getWorkspace(workspaceId);
    if (!workspace) {
      const error = new Error('Workspace not found');
      error.status = 404;
      error.code = 'catalog_workspace_not_found';
      throw error;
    }
    const resolved = await connectionBroker.resolveConnection(workspace.connectionId);
    if (!resolved) {
      const error = new Error('Connection is not available');
      error.status = 404;
      error.code = 'catalog_connection_not_found';
      throw error;
    }
    return { workspace, profile: resolved.profile, adapter: resolved.adapter };
  };

  const handleForward = (req, res) => {
    const parsed = parseWorkspaceRuntimePath(getRequestPathname(req));
    if (!parsed) {
      return sendJsonError(res, 404, 'Unknown workspace runtime path', 'catalog_runtime_path_not_found');
    }
    if (!ALLOWED_METHODS.has(req.method)) {
      return sendJsonError(res, 405, 'Method not allowed', 'catalog_runtime_method_not_allowed');
    }
    if (!isForwardableApiPath(parsed.restPath)) {
      return sendJsonError(res, 404, 'Path is not forwardable', 'catalog_runtime_path_not_allowed');
    }
    // Return the promise so Express 5 awaits async handlers and tests can
    // await the request lifecycle deterministically.
    return (async () => {
      let context;
      try {
        context = await resolveWorkspaceContext(parsed.workspaceId);
      } catch (error) {
        return sendJsonError(res, error.status ?? 500, error.message, error.code);
      }
      if (context.adapter.capabilities?.eventStream !== true && isEventStreamRequest(req)) {
        return sendJsonError(res, 501, 'Event streaming is not available for this connection', 'capability_unavailable');
      }
      // A browser disconnect must cancel the upstream request/stream (and
      // thereby release the broker lease): without this, a dropped SSE client
      // keeps consuming the upstream stream indefinitely.
      const controller = new AbortController();
      const onClientDisconnect = () => controller.abort();
      req.on?.('close', onClientDisconnect);
      const release = connectionBroker.acquireLease(context.workspace.connectionId);
      try {
        // A shallow clone keeps the Express prototype (req.get etc.) while
        // adding the disconnect signal without mutating the original request.
        const forwardRequest = Object.assign(Object.create(Object.getPrototypeOf(req)), req, { signal: controller.signal });
        const upstream = await context.adapter.fetch({
          workspace: context.workspace,
          canonicalPath: context.workspace.canonicalPath,
          profile: context.profile,
          credentialProvider: context.credentialProvider,
        }, forwardRequest, parsed.restPath);
        if (!upstream || typeof upstream.status !== 'number') {
          return sendJsonError(res, 502, 'Upstream returned an invalid response', 'catalog_runtime_bad_upstream');
        }
        // Forward status, sanitized headers and the streaming body. Upstream
        // auth headers and internal URLs must never reach the client.
        for (const headerName of SANITIZED_RESPONSE_HEADERS) {
          const value = upstream.headers?.get(headerName);
          if (value) res.setHeader(headerName, value);
        }
        res.status(upstream.status);
        await pipeUpstreamBody(upstream.body, res, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) {
          // Client went away; nothing useful to write, just close.
          if (!res.headersSent) res.end();
          return;
        }
        logger?.log?.('[workspaces:proxy] forward failed', `${parsed.restPath}: ${error?.message ?? error}`);
        if (!res.headersSent) {
          sendJsonError(res, 502, 'Upstream request failed', 'catalog_runtime_upstream_failed');
        } else {
          res.end();
        }
      } finally {
        req.removeListener?.('close', onClientDisconnect);
        release();
      }
    })();
  };

  // Express 5 (path-to-regexp 8) dropped `*` wildcards; a mount-prefixed
  // middleware covers the base path AND every sub-path, and the handler
  // parses the full workspace-prefixed path from `originalUrl`.
  app.all('/api/workspaces/:workspaceId/runtime', handleForward);
  app.use('/api/workspaces/:workspaceId/runtime', handleForward);
};

const isEventStreamRequest = (req) => {
  const accept = req.get?.('accept') ?? req.headers?.accept ?? '';
  return typeof accept === 'string' && accept.includes('text/event-stream');
};

/** Streams a Response body (web ReadableStream or Node stream) into the
 * Express response. Honors backpressure (`res.write` returning false pauses
 * the source until `drain`) and cancels/destroys the upstream body when the
 * signal aborts or the client response closes. Resolves when the body is
 * fully drained, the signal aborts, or the client disconnects. */
const pipeUpstreamBody = async (body, res, signal = null) => {
  if (!body) {
    res.end();
    return;
  }
  const onClose = () => signal?.abort?.();
  if (signal && typeof res.on === 'function') {
    res.on('close', onClose);
  }
  try {
    if (typeof body.pipe === 'function') {
      await pipeNodeStream(body, res, signal);
      return;
    }
    await pipeWebStream(body, res, signal);
  } finally {
    if (typeof res.removeListener === 'function') {
      res.removeListener('close', onClose);
    }
  }
  res.end();
};

const pipeNodeStream = async (body, res, signal) => {
  return new Promise((resolve) => {
    const finished = () => resolve();
    body.on('end', finished);
    body.on('error', finished);
    if (signal) {
      signal.addEventListener('abort', () => {
        body.destroy?.();
        resolve();
      }, { once: true });
    }
    body.pipe(res);
  });
};

const pipeWebStream = async (body, res, signal) => {
  const reader = body.getReader();
  if (signal) {
    signal.addEventListener('abort', () => {
      reader.cancel().catch(() => {});
    }, { once: true });
  }
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) {
        await waitForDrain(res, signal);
      }
      if (signal?.aborted) break;
    }
  } catch {
    // Upstream error or cancelled read; the caller closes the response.
  } finally {
    reader.releaseLock?.();
  }
};

const waitForDrain = (res, signal) => new Promise((resolve) => {
  const onDrain = () => {
    cleanup();
    resolve();
  };
  const onAbort = () => {
    cleanup();
    resolve();
  };
  const cleanup = () => {
    if (typeof res.removeListener === 'function') {
      res.removeListener('drain', onDrain);
    }
    signal?.removeEventListener?.('abort', onAbort);
  };
  if (typeof res.on === 'function') res.on('drain', onDrain);
  signal?.addEventListener?.('abort', onAbort, { once: true });
});

const SANITIZED_RESPONSE_HEADERS = [
  'content-type',
  'cache-control',
  'x-next-cursor',
  'x-openchamber-quota-remaining',
];
