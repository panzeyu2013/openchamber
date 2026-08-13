/**
 * Project runtime proxy.
 *
 * Serves `/api/projects/:projectId/runtime/*` on the CONTROL PLANE and
 * forwards to the project's connection adapter:
 *
 *   /api/projects/:projectId/runtime/api/session?limit=25&directory=/safe
 *     -> adapter.fetch(context, '/api/session?limit=25&directory=/safe', request)
 *   /api/projects/:projectId/runtime/api/terminal/ws
 *     -> adapter.openWebSocket(context, { path: '/api/terminal/ws', ... })
 *        -> URL-backed or adapter-owned upstream WebSocket piped back to the browser
 *
 * Security contract:
 * - The projectId is resolved server-side to a SAVED connection and its
 *   canonical path. Clients can never pass an arbitrary upstream URL.
 * - Only the documented project-capable `/api/...` path families are
 *   forwarded (the SDK base URL is `/api/projects/:projectId/runtime/api`,
 *   so every SDK path lands under `/api`). Control-plane namespaces such as
 *   `/api/projects`, `/api/connections`, `/api/client-auth`, `/api/system`
 *   and `/api/openchamber/*` are not part of this proxy.
 * - Upstream credentials are injected by the adapter; upstream auth headers
 *   and internal URLs are never echoed back to the client.
 * - Query strings are preserved end to end for HTTP (pagination, filtering,
 *   directory and cursor params must reach the upstream). WebSocket upgrades
 *   are allowlisted per path (`/api/event/ws`, `/api/global/event/ws`,
 *   `/api/terminal/ws`); the browser query string (which carries the
 *   control-plane URL auth token) is NOT forwarded upstream — the adapters
 *   inject server-side credentials instead.
 * - The project runtime fetch is a streaming pass-through (JSON and SSE);
 *   the upstream stream is CANCELLED when the browser disconnects and the
 *   response write path honors backpressure and a bounded response size, so a
 *   dropped SSE client stops consuming the upstream stream and the broker
 *   lease immediately.
 * - WebSocket upgrades: `handleProjectUpgrade` runs inside the CENTRAL
 *   upgrade dispatcher (server entrypoint), authenticates the upgrade like
 *   the terminal/event-stream sockets, gates on the connection capability,
 *   holds a broker lease for the lifetime of the socket pair and pipes the
 *   upstream socket back to the browser. Failures return an explicit HTTP
 *   error to the upgrade (501 capability_unavailable / 401 / 403 / 404 ...),
 *   never a silent swallow. The dispatcher marks handled upgrades on the
 *   request object; module upgrade listeners that also match
 *   project-prefixed paths skip marked requests so a project upgrade has
 *   exactly one handler.
 */

import { WebSocket, WebSocketServer } from 'ws';

/**
 * Server capability flag `projectCatalogV1` (plan §20): an operator switch
 * that gates catalog/session-index mutations and the project runtime
 * proxy WITHOUT touching catalog data files (a pure read gate). The flag is
 * enabled unless `OPENCHAMBER_PROJECT_CATALOG_DISABLED=1` is set.
 *
 * The pre-rename env name `OPENCHAMBER_WORKSPACE_CATALOG_DISABLED` is still
 * read as a fallback (deployment compatibility): the new name wins when both
 * are set.
 *
 * The canonical env resolver lives here because the WebSocket upgrade
 * handler is wired directly by the server entrypoint and must gate on the
 * same env var as the HTTP routes. index.js resolves the flag once at
 * runtime creation and passes the boolean into every route registrar.
 */
export const isProjectCatalogDisabled = (env = process?.env ?? {}) => (
  typeof env.OPENCHAMBER_PROJECT_CATALOG_DISABLED === 'string'
    ? env.OPENCHAMBER_PROJECT_CATALOG_DISABLED.trim() === '1'
    : typeof env.OPENCHAMBER_WORKSPACE_CATALOG_DISABLED === 'string'
      && env.OPENCHAMBER_WORKSPACE_CATALOG_DISABLED.trim() === '1'
);

export const resolveProjectCatalogV1 = (dependencyValue) => (
  typeof dependencyValue === 'boolean' ? dependencyValue : !isProjectCatalogDisabled()
);

/** Desensitized runtime proxy counters (plan §19): request/failure/cancel
 * counts and the active upstream-stream gauge. No URLs, paths, headers,
 * bodies or credentials are ever recorded. */
const proxyStats = {
  requests: 0,
  failures: 0,
  cancels: 0,
  activeStreams: 0,
  streamsServed: 0,
};

export const getRuntimeProxyStats = () => ({ ...proxyStats });

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD']);

/** Keep this aligned with the OpenCode SDK/runtime API families and the
 * project-owned Files/Git/Terminal APIs. A prefix entry matches only the
 * exact path or a child path, never a prefix collision such as
 * `/api/session-debug`. Control-plane management namespaces are deliberately
 * absent. */
const PROJECT_RUNTIME_API_PATH_PREFIXES = Object.freeze([
  '/api/agent',
  '/api/auth',
  '/api/command',
  '/api/event',
  '/api/experimental/project',
  '/api/experimental/resource',
  '/api/experimental/session',
  '/api/experimental/tool',
  '/api/experimental/worktree',
  '/api/file',
  '/api/find',
  '/api/formatter',
  '/api/fs',
  '/api/git',
  '/api/global/event',
  '/api/global/health',
  '/api/health',
  '/api/integration',
  '/api/lsp',
  '/api/mcp',
  '/api/model',
  '/api/opencode/health',
  '/api/path',
  '/api/permission',
  '/api/project',
  '/api/provider',
  '/api/pty',
  '/api/question',
  '/api/reference',
  '/api/session',
  '/api/session-activity',
  '/api/skill',
  '/api/sync',
  '/api/terminal',
  '/api/vcs',
  '/api/version',
]);

// These control-plane endpoints report machine state (the home directory)
// rather than reading inside the selected project. They must never cross a
// project runtime boundary, even though they share the `/api/fs` family —
// matched as PREFIXES so `/api/fs/home/`-style variants cannot slip through
// an exact-match check.
const NON_PROJECT_RUNTIME_API_PATHS = Object.freeze(['/api/fs/home']);

// OpenCode's config endpoints are not a project API contract. Keep them out
// of the proxy and return a typed 501 instead of accidentally mutating the
// ambient/global runtime selected by the renderer.
const EXPLICITLY_UNAVAILABLE_PROJECT_RUNTIME_PATH_PREFIXES = Object.freeze([
  '/api/config',
]);

const MAX_PROJECT_RUNTIME_REQUEST_BYTES = 50 * 1024 * 1024;
const MAX_PROJECT_RUNTIME_RESPONSE_BYTES = 100 * 1024 * 1024;

const RUNTIME_PREFIX_PATTERN = /^\/api\/projects\/([^/]+)\/runtime(\/.*)?$/;

/** Project-prefixed WebSocket upgrade paths (aligned with
 * `realtime-proxy.js`'s `isAllowedWebSocketPath` plus the project prefix). */
export const isAllowedProjectUpgradePath = (restPath) => (
  restPath === '/api/event/ws'
  || restPath === '/api/global/event/ws'
  || restPath === '/api/terminal/ws'
);

/** Marks an upgrade request as owned by the project upgrade dispatcher.
 * Module upgrade listeners that match project-prefixed paths (the terminal
 * runtime) skip marked requests so the project upgrade has exactly one
 * handler regardless of listener registration order. */
export const PROJECT_RUNTIME_UPGRADE_MARKER = Symbol('projectRuntimeUpgradeHandled');

const UPSTREAM_WS_CONNECT_TIMEOUT_MS = 30_000;

const getRestPathname = (restPath) => {
  if (typeof restPath !== 'string' || restPath.length === 0) return '';
  try {
    return new URL(restPath, 'http://project.local').pathname;
  } catch {
    return '';
  }
};

export const isForwardableProjectRuntimePath = (restPath) => {
  const pathname = getRestPathname(restPath);
  if (pathname === '/api') return true;
  if (NON_PROJECT_RUNTIME_API_PATHS.some((prefix) => (
    pathname === prefix || pathname.startsWith(`${prefix}/`)
  ))) return false;
  if (EXPLICITLY_UNAVAILABLE_PROJECT_RUNTIME_PATH_PREFIXES.some((prefix) => (
    pathname === prefix || pathname.startsWith(`${prefix}/`)
  ))) return false;
  return PROJECT_RUNTIME_API_PATH_PREFIXES.some((prefix) => (
    pathname === prefix || pathname.startsWith(`${prefix}/`)
  ));
};

export const isProjectRuntimeCapabilityUnavailablePath = (restPath) => {
  const pathname = getRestPathname(restPath);
  return EXPLICITLY_UNAVAILABLE_PROJECT_RUNTIME_PATH_PREFIXES.some((prefix) => (
    pathname === prefix || pathname.startsWith(`${prefix}/`)
  ));
};

/** Splits the project-prefixed path into { projectId, restPath }. The
 * rest path keeps the query string (`/api/session?limit=25`). Malformed
 * percent-encoding fails closed (null) — this runs synchronously on the
 * `upgrade` event before any auth check, and a decodeURIComponent throw
 * there would escape the listener and crash the control plane. */
export const parseProjectRuntimePath = (pathname) => {
  const match = RUNTIME_PREFIX_PATTERN.exec(pathname);
  if (!match) return null;
  const restPath = match[2] || '/';
  let projectId;
  try {
    projectId = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  if (!projectId) return null;
  return { projectId, restPath };
};

/** The URL token authenticates the control-plane browser request. It is never
 * an upstream runtime credential and must not cross an adapter boundary. */
export const stripProjectUrlAuthToken = (restPath) => {
  if (typeof restPath !== 'string' || !restPath.includes('?')) return restPath;
  try {
    const url = new URL(restPath, 'http://project.local');
    url.searchParams.delete('oc_url_token');
    return `${url.pathname}${url.search}`;
  } catch {
    return restPath;
  }
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

const resolveProjectContext = async (projectId, { catalogStore, connectionBroker, credentialProvider = null }) => {
  const project = await catalogStore.getProject(projectId);
  if (!project) {
    const error = new Error('Project not found');
    error.status = 404;
    error.code = 'catalog_project_not_found';
    throw error;
  }
  const resolved = await connectionBroker.resolveConnection(project.connectionId);
  if (!resolved) {
    const error = new Error('Connection is not available');
    error.status = 404;
    error.code = 'catalog_connection_not_found';
    throw error;
  }
  return { project, profile: resolved.profile, adapter: resolved.adapter, credentialProvider };
};

export const registerProjectRuntimeProxyRoutes = (app, dependencies) => {
  const {
    catalogStore,
    connectionBroker,
    credentialProvider = null,
    logger = null,
    maxRequestBytes = MAX_PROJECT_RUNTIME_REQUEST_BYTES,
    maxResponseBytes = MAX_PROJECT_RUNTIME_RESPONSE_BYTES,
  } = dependencies;

  const handleForward = (req, res) => {
    proxyStats.requests += 1;
    const sendJsonErrorCounted = (resValue, status, message, code) => {
      proxyStats.failures += 1;
      return sendJsonError(resValue, status, message, code);
    };
    const parsed = parseProjectRuntimePath(getRequestPathname(req));
    if (!parsed) {
      return sendJsonErrorCounted(res, 404, 'Unknown project runtime path', 'catalog_runtime_path_not_found');
    }
    if (!ALLOWED_METHODS.has(req.method)) {
      return sendJsonErrorCounted(res, 405, 'Method not allowed', 'catalog_runtime_method_not_allowed');
    }
    if (isProjectRuntimeCapabilityUnavailablePath(parsed.restPath)) {
      return sendJsonErrorCounted(res, 501, 'This project capability is not available', 'capability_unavailable');
    }
    if (!isForwardableProjectRuntimePath(parsed.restPath)) {
      return sendJsonErrorCounted(res, 404, 'Path is not forwardable', 'catalog_runtime_path_not_allowed');
    }
    const requestBodyBytes = getRequestBodyBytes(req);
    if (isContentLengthOverLimit(req, maxRequestBytes) || requestBodyBytes > maxRequestBytes) {
      return sendJsonErrorCounted(res, 413, 'Project runtime request body is too large', 'catalog_runtime_body_too_large');
    }
    const forwardedRestPath = stripProjectUrlAuthToken(parsed.restPath);
    // Return the promise so Express 5 awaits async handlers and tests can
    // await the request lifecycle deterministically.
    return (async () => {
      let context;
      try {
        context = await resolveProjectContext(parsed.projectId, {
          catalogStore,
          connectionBroker,
          credentialProvider,
        });
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
      const release = connectionBroker.acquireLease(context.project.connectionId);
      try {
        // A shallow clone keeps the Express prototype (req.get etc.) while
        // adding the disconnect signal without mutating the original request.
        const forwardRequest = Object.assign(Object.create(Object.getPrototypeOf(req)), req, { signal: controller.signal });
        const upstream = await context.adapter.fetch({
          project: context.project,
          canonicalPath: context.project.canonicalPath,
          profile: context.profile,
          credentialProvider: context.credentialProvider,
        }, forwardRequest, forwardedRestPath);
        if (!upstream || typeof upstream.status !== 'number') {
          return sendJsonErrorCounted(res, 502, 'Upstream returned an invalid response', 'catalog_runtime_bad_upstream');
        }
        if (isResponseContentLengthOverLimit(upstream, maxResponseBytes)) {
          cancelUpstreamBody(upstream.body);
          throw streamLimitError();
        }
        // Forward status, sanitized headers and the streaming body. Upstream
        // auth headers and internal URLs must never reach the client.
        for (const headerName of SANITIZED_RESPONSE_HEADERS) {
          const value = upstream.headers?.get(headerName);
          if (value) res.setHeader(headerName, value);
        }
        res.status(upstream.status);
        proxyStats.activeStreams += 1;
        proxyStats.streamsServed += 1;
        await pipeUpstreamBody(upstream.body, res, controller.signal, maxResponseBytes);
      } catch (error) {
        if (controller.signal.aborted) {
          // Client went away; nothing useful to write, just close.
          if (!res.headersSent) res.end();
          return;
        }
        logger?.log?.('[projects:proxy] forward failed', `project=${parsed.projectId} code=${error?.code ?? 'unknown'}`);
        if (!res.headersSent) {
          const typedStatus = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
            ? error.status
            : 502;
          const typedCode = typeof error?.code === 'string' && error.code.length > 0
            ? error.code
            : 'catalog_runtime_upstream_failed';
          const typedMessage = typedStatus < 500 && typeof error?.message === 'string' && error.message.length > 0
            ? error.message
            : 'Upstream request failed';
          sendJsonErrorCounted(res, typedStatus, typedMessage, typedCode);
        } else {
          res.end();
        }
      } finally {
        req.removeListener?.('close', onClientDisconnect);
        release();
        proxyStats.activeStreams = Math.max(0, proxyStats.activeStreams - 1);
        if (controller.signal.aborted) proxyStats.cancels += 1;
      }
    })();
  };

  // Express 5 (path-to-regexp 8) dropped `*` wildcards; a mount-prefixed
  // middleware covers the base path AND every sub-path, and the handler
  // parses the full project-prefixed path from `originalUrl`.
  app.all('/api/projects/:projectId/runtime', handleForward);
  app.use('/api/projects/:projectId/runtime', handleForward);
};

const isEventStreamRequest = (req) => {
  const accept = req.get?.('accept') ?? req.headers?.accept ?? '';
  return typeof accept === 'string' && accept.includes('text/event-stream');
};

const readHeader = (headers, name) => {
  if (!headers) return '';
  const value = typeof headers.get === 'function' ? headers.get(name) : headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
};

const isContentLengthOverLimit = (request, limit) => {
  const contentLength = Number(readHeader(request?.headers, 'content-length'));
  return Number.isFinite(contentLength) && contentLength > limit;
};

const getRequestBodyBytes = (request) => {
  const body = request?.body;
  if (body === undefined || body === null) return 0;
  if (typeof body === 'string') return Buffer.byteLength(body);
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return body.byteLength;
  if (typeof body === 'object' && typeof body.pipe !== 'function' && typeof body.getReader !== 'function') {
    try {
      return Buffer.byteLength(JSON.stringify(body));
    } catch {
      return 0;
    }
  }
  return 0;
};

const isResponseContentLengthOverLimit = (response, limit) => {
  const contentLength = Number(response?.headers?.get?.('content-length'));
  return Number.isFinite(contentLength) && contentLength > limit;
};

const streamLimitError = () => {
  const error = new Error('Project runtime response body is too large');
  error.code = 'catalog_runtime_stream_too_large';
  error.status = 413;
  return error;
};

const cancelUpstreamBody = (body) => {
  if (!body) return;
  if (typeof body.destroy === 'function') {
    body.destroy();
    return;
  }
  try {
    Promise.resolve(body.cancel?.()).catch(() => {});
  } catch {
    // The upstream body is already being discarded.
  }
};

/** Streams a Response body (web ReadableStream or Node stream) into the
 * Express response. Honors backpressure (`res.write` returning false pauses
 * the source until `drain`) and cancels/destroys the upstream body when the
 * signal aborts or the client response closes. Resolves when the body is
 * fully drained, the signal aborts, or the client disconnects. */
const pipeUpstreamBody = async (body, res, signal = null, maxBytes = MAX_PROJECT_RUNTIME_RESPONSE_BYTES) => {
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
      await pipeNodeStream(body, res, signal, maxBytes);
      return;
    }
    await pipeWebStream(body, res, signal, maxBytes);
  } finally {
    if (typeof res.removeListener === 'function') {
      res.removeListener('close', onClose);
    }
  }
  res.end();
};

const pipeNodeStream = async (body, res, signal, maxBytes) => {
  let totalBytes = 0;
  try {
    for await (const chunk of body) {
      if (signal?.aborted) break;
      const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk?.byteLength ?? 0;
      totalBytes += bytes;
      if (totalBytes > maxBytes) {
        body.destroy?.();
        throw streamLimitError();
      }
      if (!res.write(chunk)) await waitForDrain(res, signal);
    }
  } catch (error) {
    if (error?.code === 'catalog_runtime_stream_too_large') throw error;
    if (!signal?.aborted) return;
  }
};

const pipeWebStream = async (body, res, signal, maxBytes) => {
  const reader = body.getReader();
  if (signal) {
    signal.addEventListener('abort', () => {
      reader.cancel().catch(() => {});
    }, { once: true });
  }
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value?.byteLength ?? 0;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw streamLimitError();
      }
      if (!res.write(value)) {
        await waitForDrain(res, signal);
      }
      if (signal?.aborted) break;
    }
  } catch (error) {
    // Upstream error or cancelled read; the caller closes the response.
    if (error?.code === 'catalog_runtime_stream_too_large') throw error;
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
 * Central project WebSocket upgrade handler (wired by the server entrypoint
 * into the `upgrade` event). Owns every `/api/projects/:id/runtime...`
 * upgrade and leaves every other path untouched for the existing module
 * listeners (terminal, event stream, dictation, realtime proxy, preview).
 *
 * Flow: parse projectId -> authenticate like the terminal/event-stream
 * sockets (session cookie / bearer / short-lived URL token, then origin) ->
 * resolve the connection -> capability gate by path -> broker lease ->
 * adapter.openWebSocket(context, { path, headers, query }) -> URL-backed or
 * adapter-owned upstream WebSocket piped back to the browser. Any failure rejects the upgrade with
 * an explicit HTTP error; the lease is released when the socket pair closes.
 *
 * Returns a promise resolving to `true` when this handler owns the upgrade,
 * `false` when the path is not a project-prefixed upgrade (or was already
 * marked as handled).
 */
export const handleProjectUpgrade = (req, socket, head, dependencies) => {
  const pathname = getUpgradePathname(req?.url);
  const parsed = parseProjectRuntimePath(pathname);
  if (!parsed) return Promise.resolve(false);
  if (req?.[PROJECT_RUNTIME_UPGRADE_MARKER]) return Promise.resolve(false);
  // Own the upgrade synchronously so later module listeners that also match
  // project-prefixed paths skip it even while the async work is in flight.
  req[PROJECT_RUNTIME_UPGRADE_MARKER] = true;
  return runProjectUpgrade(parsed, req, socket, head, dependencies).then(() => true);
};

const runProjectUpgrade = async (parsed, req, socket, head, dependencies) => {
  const {
    catalogStore,
    connectionBroker,
    credentialProvider = null,
    getUiAuthController = null,
    isRequestOriginAllowed = null,
    rejectWebSocketUpgrade,
    logger = null,
    projectCatalogV1 = null,
  } = dependencies;
  try {
    // The flag-disabled state (§20) rejects every project runtime upgrade
    // with an explicit capability error — never a silent swallow and never
    // a tunnel to the upstream runtime.
    if (resolveProjectCatalogV1(projectCatalogV1) === false) {
      rejectWebSocketUpgrade(socket, 501, 'The project catalog is disabled on this server');
      return;
    }
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
    if (!isAllowedProjectUpgradePath(restPath)) {
      rejectWebSocketUpgrade(socket, 404, 'Path is not a forwardable project socket');
      return;
    }
    const capability = restPath === '/api/terminal/ws' ? 'terminal' : 'eventStream';
    let context;
    try {
      context = await resolveProjectContext(parsed.projectId, {
        catalogStore,
        connectionBroker,
        credentialProvider,
      });
    } catch (error) {
      rejectUpgradeError(socket, error, rejectWebSocketUpgrade);
      return;
    }
    if (context.adapter.capabilities?.[capability] !== true) {
      rejectWebSocketUpgrade(socket, 501, `${capability} streaming is not available for this connection`);
      return;
    }
    const release = connectionBroker.acquireLease(context.project.connectionId);
    let upstream = null;
    try {
      const request = {
        path: restPath,
        headers: collectUpgradeHeaders(req),
        query: parseUpgradeQuery(req),
        requestUrl: typeof req?.url === 'string' ? req.url : '',
      };
      const spec = await context.adapter.openWebSocket({
        project: context.project,
        canonicalPath: context.project.canonicalPath,
        profile: context.profile,
        credentialProvider,
      }, request);
      if (!spec || (typeof spec.url !== 'string' && !spec.socket)) {
        rejectWebSocketUpgrade(socket, 502, 'Upstream WebSocket is unavailable');
        return;
      }
      upstream = await openUpstreamWebSocket(spec);
    } catch (error) {
      logger?.log?.('[projects:proxy] project upgrade upstream failed', `project=${parsed.projectId} code=${error?.code ?? 'unknown'}`);
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
    logger?.log?.('[projects:proxy] project upgrade failed', `project=${parsed.projectId} code=${error?.code ?? 'unknown'}`);
    rejectWebSocketUpgrade(socket, 500, 'Upgrade failed');
  }
};

const rejectUpgradeError = (socket, error, rejectWebSocketUpgrade) => {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : 502;
  // Mirror the HTTP forward path: 4xx errors carry a safe typed message,
  // 5xx responses never echo upstream details (which can include host:port).
  const message = status < 500 && typeof error?.message === 'string' && error.message.length > 0
    ? error.message
    : 'Project WebSocket upgrade failed';
  rejectWebSocketUpgrade(socket, status, message);
};

/** Creates the upstream ws client and resolves once the handshake is open.
 * Rejects with a typed error on failure or on the configured timeout. */
const openUpstreamWebSocket = (spec) => {
  if (spec?.socket) return waitForProvidedWebSocket(spec.socket, spec.timeoutMs);
  return new Promise((resolve, reject) => {
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
    // Never wrap the raw ws error: its message can carry upstream host:port
    // details that must not reach the client or logs.
    const wrapped = new Error('Upstream WebSocket failed');
    wrapped.code = 'catalog_runtime_upstream_failed';
    wrapped.status = 502;
    reject(wrapped);
  });
  });
};

/** Waits for a socket-like adapter result (the Relay tunnel socket) to become
 * open. The adapter owns the socket; this helper only waits before the browser
 * upgrade is accepted so a failed upstream never leaves a half-open client. */
const waitForProvidedWebSocket = (socket, timeoutValue) => new Promise((resolve, reject) => {
  const timeoutMs = Number.isInteger(timeoutValue) && timeoutValue > 0
    ? timeoutValue
    : UPSTREAM_WS_CONNECT_TIMEOUT_MS;
  if (socket.readyState === WebSocket.OPEN || socket.readyState === 1) {
    resolve(socket);
    return;
  }
  if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED || socket.readyState === 3) {
    reject(upstreamSocketError('Upstream WebSocket closed before opening'));
    return;
  }
  let settled = false;
  const previousOpen = socket.onopen;
  const previousError = socket.onerror;
  const previousClose = socket.onclose;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    socket.onopen = previousOpen;
    socket.onerror = previousError;
    socket.onclose = previousClose;
    socket.close?.(1000, 'upstream WebSocket handshake timed out');
    reject(upstreamSocketError('Upstream WebSocket handshake timed out'));
  }, timeoutMs + 1000);
  const cleanup = () => {
    clearTimeout(timer);
    socket.onopen = previousOpen;
    socket.onerror = previousError;
    socket.onclose = previousClose;
  };
  socket.onopen = (...args) => {
    previousOpen?.(...args);
    if (settled) return;
    settled = true;
    cleanup();
    resolve(socket);
  };
  socket.onerror = (...args) => {
    previousError?.(...args);
    if (settled) return;
    settled = true;
    cleanup();
    reject(upstreamSocketError('Upstream WebSocket failed'));
  };
  socket.onclose = (...args) => {
    previousClose?.(...args);
    if (settled) return;
    settled = true;
    cleanup();
    reject(upstreamSocketError('Upstream WebSocket closed before opening'));
  };
});

const upstreamSocketError = (message) => {
  const error = new Error(message);
  error.code = 'catalog_runtime_upstream_failed';
  error.status = 502;
  return error;
};

const wsServer = new WebSocketServer({ noServer: true });

/** Pipes the browser socket and the upstream socket in both directions and
 * releases the broker lease when either side closes. */
const wireUpstreamSocket = (clientSocket, upstream, release) => {
  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    release();
  };
  const on = (target, event, handler) => {
    if (typeof target.on === 'function') {
      target.on(event, handler);
      return;
    }
    const property = `on${event}`;
    const previous = target[property];
    target[property] = (...args) => {
      previous?.(...args);
      handler(...args);
    };
  };
  clientSocket.on('error', () => {});
  clientSocket.on('message', (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary });
    }
  });
  on(upstream, 'message', (eventOrData, isBinary) => {
    const data = eventOrData?.data !== undefined && typeof eventOrData !== 'string' && !Buffer.isBuffer(eventOrData)
      ? eventOrData.data
      : eventOrData;
    const binary = typeof isBinary === 'boolean'
      ? isBinary
      : typeof data !== 'string';
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.send(data, { binary });
    }
  });
  on(upstream, 'close', (eventOrCode, reasonValue) => {
    const code = typeof eventOrCode === 'object' ? eventOrCode?.code : eventOrCode;
    const reason = typeof eventOrCode === 'object' ? eventOrCode?.reason : reasonValue;
    if (clientSocket.readyState === WebSocket.OPEN || clientSocket.readyState === WebSocket.CONNECTING) {
      clientSocket.close(code || 1000, reason);
    }
    releaseOnce();
  });
  on(upstream, 'error', () => {
    if (clientSocket.readyState === WebSocket.OPEN || clientSocket.readyState === WebSocket.CONNECTING) {
      clientSocket.close(1011, 'Project upstream error');
    }
    releaseOnce();
  });
  clientSocket.on('close', () => {
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING || upstream.readyState === 1 || upstream.readyState === 0) {
      upstream.close?.();
    }
    releaseOnce();
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
