/**
 * Workspace runtime proxy.
 *
 * Serves `/api/workspaces/:workspaceId/runtime/*` on the CONTROL PLANE and
 * forwards to the workspace's connection adapter:
 *
 *   /api/workspaces/:workspaceId/runtime/api/session?limit=25&directory=/safe
 *     -> adapter.fetch(context, '/api/session?limit=25&directory=/safe', request)
 *   /api/workspaces/:workspaceId/runtime/api/terminal/ws
 *     -> adapter.openWebSocket(context, { path: '/api/terminal/ws', ... })
 *        -> upstream WebSocket piped back to the browser
 *
 * Security contract:
 * - The workspaceId is resolved server-side to a SAVED connection and its
 *   canonical path. Clients can never pass an arbitrary upstream URL.
 * - Only `/api/...` paths are forwarded (the SDK base URL is
 *   `/api/workspaces/:workspaceId/runtime/api`, so every SDK path lands under
 *   `/api`). Anything else is rejected with 404.
 * - Upstream credentials are injected by the adapter; upstream auth headers
 *   and internal URLs are never echoed back to the client.
 * - Query strings are preserved end to end for HTTP (pagination, filtering,
 *   directory and cursor params must reach the upstream). WebSocket upgrades
 *   are allowlisted per path (`/api/event/ws`, `/api/global/event/ws`,
 *   `/api/terminal/ws`); the browser query string (which carries the
 *   control-plane URL auth token) is NOT forwarded upstream — the adapters
 *   inject server-side credentials instead.
 * - The workspace runtime fetch is a streaming pass-through (JSON and SSE);
 *   the upstream stream is CANCELLED when the browser disconnects and the
 *   response write path honors backpressure, so a dropped SSE client stops
 *   consuming the upstream stream and the broker lease immediately.
 * - WebSocket upgrades: `handleWorkspaceUpgrade` runs inside the CENTRAL
 *   upgrade dispatcher (server entrypoint), authenticates the upgrade like
 *   the terminal/event-stream sockets, gates on the connection capability,
 *   holds a broker lease for the lifetime of the socket pair and pipes the
 *   upstream socket back to the browser. Failures return an explicit HTTP
 *   error to the upgrade (501 capability_unavailable / 401 / 403 / 404 ...),
 *   never a silent swallow. The dispatcher marks handled upgrades on the
 *   request object; module upgrade listeners that also match
 *   workspace-prefixed paths skip marked requests so a workspace upgrade has
 *   exactly one handler.
 */

import { WebSocket, WebSocketServer } from 'ws';

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD']);

const RUNTIME_PREFIX_PATTERN = /^\/api\/workspaces\/([^/]+)\/runtime(\/.*)?$/;

/** Workspace-prefixed WebSocket upgrade paths (aligned with
 * `realtime-proxy.js`'s `isAllowedWebSocketPath` plus the workspace prefix). */
export const isAllowedWorkspaceUpgradePath = (restPath) => (
  restPath === '/api/event/ws'
  || restPath === '/api/global/event/ws'
  || restPath === '/api/terminal/ws'
);

/** Marks an upgrade request as owned by the workspace upgrade dispatcher.
 * Module upgrade listeners that match workspace-prefixed paths (the terminal
 * runtime) skip marked requests so the workspace upgrade has exactly one
 * handler regardless of listener registration order. */
export const WORKSPACE_RUNTIME_UPGRADE_MARKER = Symbol('workspaceRuntimeUpgradeHandled');

const UPSTREAM_WS_CONNECT_TIMEOUT_MS = 30_000;

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

const resolveWorkspaceContext = async (workspaceId, { catalogStore, connectionBroker }) => {
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

export const registerWorkspaceRuntimeProxyRoutes = (app, dependencies) => {
  const {
    catalogStore,
    connectionBroker,
    credentialProvider = null,
    logger = null,
  } = dependencies;

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
        context = await resolveWorkspaceContext(parsed.workspaceId, { catalogStore, connectionBroker });
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

/**
 * Central workspace WebSocket upgrade handler (wired by the server entrypoint
 * into the `upgrade` event). Owns every `/api/workspaces/:id/runtime...`
 * upgrade and leaves every other path untouched for the existing module
 * listeners (terminal, event stream, dictation, realtime proxy, preview).
 *
 * Flow: parse workspaceId -> authenticate like the terminal/event-stream
 * sockets (session cookie / bearer / short-lived URL token, then origin) ->
 * resolve the connection -> capability gate by path -> broker lease ->
 * adapter.openWebSocket(context, { path, headers, query }) -> upstream
 * WebSocket piped back to the browser. Any failure rejects the upgrade with
 * an explicit HTTP error; the lease is released when the socket pair closes.
 *
 * Returns a promise resolving to `true` when this handler owns the upgrade,
 * `false` when the path is not a workspace-prefixed upgrade (or was already
 * marked as handled).
 */
export const handleWorkspaceUpgrade = (req, socket, head, dependencies) => {
  const pathname = getUpgradePathname(req?.url);
  const parsed = parseWorkspaceRuntimePath(pathname);
  if (!parsed) return Promise.resolve(false);
  if (req?.[WORKSPACE_RUNTIME_UPGRADE_MARKER]) return Promise.resolve(false);
  // Own the upgrade synchronously so later module listeners that also match
  // workspace-prefixed paths skip it even while the async work is in flight.
  req[WORKSPACE_RUNTIME_UPGRADE_MARKER] = true;
  return runWorkspaceUpgrade(parsed, req, socket, head, dependencies).then(() => true);
};

const runWorkspaceUpgrade = async (parsed, req, socket, head, dependencies) => {
  const {
    catalogStore,
    connectionBroker,
    credentialProvider = null,
    getUiAuthController = null,
    isRequestOriginAllowed = null,
    rejectWebSocketUpgrade,
    logger = null,
  } = dependencies;
  try {
    const uiAuthController = typeof getUiAuthController === 'function' ? getUiAuthController() : null;
    if (uiAuthController?.enabled) {
      const sessionToken = await uiAuthController.ensureSessionToken?.(req, null);
      if (!sessionToken) {
        rejectWebSocketUpgrade(socket, 401, 'UI authentication required');
        return;
      }
      const originAllowed = typeof isRequestOriginAllowed === 'function'
        ? await isRequestOriginAllowed(req).catch(() => false)
        : true;
      if (!originAllowed) {
        rejectWebSocketUpgrade(socket, 403, 'Invalid origin');
        return;
      }
    }
    const restPath = parsed.restPath;
    if (!isAllowedWorkspaceUpgradePath(restPath)) {
      rejectWebSocketUpgrade(socket, 404, 'Path is not a forwardable workspace socket');
      return;
    }
    const capability = restPath === '/api/terminal/ws' ? 'terminal' : 'eventStream';
    let context;
    try {
      context = await resolveWorkspaceContext(parsed.workspaceId, { catalogStore, connectionBroker });
    } catch (error) {
      rejectUpgradeError(socket, error, rejectWebSocketUpgrade);
      return;
    }
    if (context.adapter.capabilities?.[capability] !== true) {
      rejectWebSocketUpgrade(socket, 501, `${capability} streaming is not available for this connection`);
      return;
    }
    const release = connectionBroker.acquireLease(context.workspace.connectionId);
    let upstream = null;
    try {
      const request = {
        path: restPath,
        headers: collectUpgradeHeaders(req),
        query: parseUpgradeQuery(req),
        requestUrl: typeof req?.url === 'string' ? req.url : '',
      };
      const spec = await context.adapter.openWebSocket({
        workspace: context.workspace,
        canonicalPath: context.workspace.canonicalPath,
        profile: context.profile,
        credentialProvider,
      }, request);
      if (!spec || typeof spec.url !== 'string' || spec.url.length === 0) {
        rejectWebSocketUpgrade(socket, 502, 'Upstream WebSocket is unavailable');
        return;
      }
      upstream = await openUpstreamWebSocket(spec);
    } catch (error) {
      logger?.log?.('[workspaces:proxy] workspace upgrade upstream failed', `${restPath}: ${error?.message ?? error}`);
      rejectUpgradeError(socket, error, rejectWebSocketUpgrade);
      return;
    } finally {
      if (!upstream) release();
    }
    try {
      wsServer.handleUpgrade(req, socket, head, (clientSocket) => {
        wireUpstreamSocket(clientSocket, upstream, release);
      });
    } catch (error) {
      // The socket never became a websocket; the lease must not linger.
      release();
      throw error;
    }
  } catch (error) {
    logger?.log?.('[workspaces:proxy] workspace upgrade failed', error?.message ?? error);
    rejectWebSocketUpgrade(socket, 500, 'Upgrade failed');
  }
};

const rejectUpgradeError = (socket, error, rejectWebSocketUpgrade) => {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : 502;
  const message = typeof error?.message === 'string' && error.message.length > 0
    ? error.message
    : 'Workspace WebSocket upgrade failed';
  rejectWebSocketUpgrade(socket, status, message);
};

/** Creates the upstream ws client and resolves once the handshake is open.
 * Rejects with a typed error on failure or on the configured timeout. */
const openUpstreamWebSocket = (spec) => new Promise((resolve, reject) => {
  const timeoutMs = Number.isInteger(spec.timeoutMs) && spec.timeoutMs > 0
    ? spec.timeoutMs
    : UPSTREAM_WS_CONNECT_TIMEOUT_MS;
  let settled = false;
  const upstream = new WebSocket(spec.url, { headers: spec.headers ?? {}, handshakeTimeout: timeoutMs });
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    try { upstream.terminate(); } catch { /* already gone */ }
    const error = new Error('Upstream WebSocket handshake timed out');
    error.code = 'catalog_runtime_upstream_failed';
    error.status = 502;
    reject(error);
  }, timeoutMs + 1000);
  upstream.once('open', () => {
    clearTimeout(timer);
    if (settled) {
      try { upstream.terminate(); } catch { /* already gone */ }
      return;
    }
    settled = true;
    resolve(upstream);
  });
  upstream.once('error', (error) => {
    clearTimeout(timer);
    if (settled) return;
    settled = true;
    const wrapped = new Error(`Upstream WebSocket failed: ${error?.message ?? error}`);
    wrapped.code = 'catalog_runtime_upstream_failed';
    wrapped.status = 502;
    reject(wrapped);
  });
});

const wsServer = new WebSocketServer({ noServer: true });

/** Pipes the browser socket and the upstream socket in both directions and
 * releases the broker lease when either side closes. */
const wireUpstreamSocket = (clientSocket, upstream, release) => {
  clientSocket.on('error', () => {});
  clientSocket.on('message', (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary });
    }
  });
  upstream.on('message', (data, isBinary) => {
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.send(data, { binary: isBinary });
    }
  });
  upstream.on('close', (code, reason) => {
    if (clientSocket.readyState === WebSocket.OPEN || clientSocket.readyState === WebSocket.CONNECTING) {
      clientSocket.close(code || 1000, reason);
    }
    release();
  });
  upstream.on('error', () => {
    if (clientSocket.readyState === WebSocket.OPEN || clientSocket.readyState === WebSocket.CONNECTING) {
      clientSocket.close(1011, 'Workspace upstream error');
    }
    release();
  });
  clientSocket.on('close', () => {
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
      upstream.close();
    }
    release();
  });
};

const getUpgradePathname = (requestUrl) => {
  if (typeof requestUrl !== 'string' || requestUrl.length === 0) return '';
  try {
    return new URL(requestUrl, 'http://localhost').pathname;
  } catch {
    return '';
  }
};

const parseUpgradeQuery = (requestUrl) => {
  if (typeof requestUrl !== 'string' || requestUrl.length === 0) return {};
  try {
    const query = {};
    for (const [name, value] of new URL(requestUrl, 'http://localhost').searchParams) {
      query[name] = value;
    }
    return query;
  } catch {
    return {};
  }
};

const collectUpgradeHeaders = (req) => {
  const headers = {};
  if (!req?.headers || typeof req.headers !== 'object') return headers;
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || value === null) continue;
    // The control-plane Host must never be forwarded upstream (the ws client
    // derives its own Host from the upstream URL).
    if (name.toLowerCase() === 'host') continue;
    headers[name] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return headers;
};

const SANITIZED_RESPONSE_HEADERS = [
  'content-type',
  'cache-control',
  'x-next-cursor',
  'x-openchamber-quota-remaining',
];
