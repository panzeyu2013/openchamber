/**
 * Workspace runtime proxy.
 *
 * Serves `/api/workspaces/:workspaceId/runtime/*` on the CONTROL PLANE and
 * forwards to the workspace's connection adapter:
 *
 *   /api/workspaces/:workspaceId/runtime/api/session
 *     -> adapter.fetch(context, '/api/session', request)
 *
 * Security contract:
 * - The workspaceId is resolved server-side to a SAVED connection and its
 *   canonical path. Clients can never pass an arbitrary upstream URL.
 * - Only `/api/...` paths are forwarded (the SDK base URL is
 *   `/api/workspaces/:workspaceId/runtime/api`, so every SDK path lands under
 *   `/api`). Anything else is rejected with 404.
 * - Upstream credentials are injected by the adapter; upstream auth headers
 *   and internal URLs are never echoed back to the client.
 * - The workspace runtime fetch is a streaming pass-through (JSON and SSE);
 *   WebSocket upgrades are not wired in this phase and return an explicit
 *   `capability_unavailable` instead of pretending to work.
 */

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD']);

const RUNTIME_PREFIX_PATTERN = /^\/api\/workspaces\/([^/]+)\/runtime(\/.*)?$/;

const isForwardableApiPath = (pathname) => (
  pathname === '/api' || pathname.startsWith('/api/')
);

/** Splits the workspace-prefixed path into { workspaceId, restPath }. */
export const parseWorkspaceRuntimePath = (pathname) => {
  const match = RUNTIME_PREFIX_PATTERN.exec(pathname);
  if (!match) return null;
  const restPath = match[2] || '/';
  return { workspaceId: decodeURIComponent(match[1]), restPath };
};

const getRequestPathname = (req) => {
  try {
    return new URL(req.originalUrl, 'http://local').pathname;
  } catch {
    return req.path ?? '';
  }
};

const sendJsonError = (res, status, message, code) => {
  res.status(status).json({ error: message, ...(code ? { code } : {}) });
};

export const registerWorkspaceRuntimeProxyRoutes = (app, dependencies) => {
  const {
    catalogStore,
    connectionBroker,
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
    const adapter = connectionBroker.getAdapter(workspace.connectionId);
    if (!adapter) {
      const error = new Error('Connection is not available');
      error.status = 404;
      error.code = 'catalog_connection_not_found';
      throw error;
    }
    return { workspace, adapter };
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
      const release = connectionBroker.acquireLease(context.workspace.connectionId);
      try {
        const upstream = await context.adapter.fetch({
          workspace: context.workspace,
          canonicalPath: context.workspace.canonicalPath,
        }, req, parsed.restPath);
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
        await pipeUpstreamBody(upstream.body, res);
      } catch (error) {
        logger?.log?.('[workspaces:proxy] forward failed', `${parsed.restPath}: ${error?.message ?? error}`);
        if (!res.headersSent) {
          sendJsonError(res, 502, 'Upstream request failed', 'catalog_runtime_upstream_failed');
        } else {
          res.end();
        }
      } finally {
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
 * Express response; resolves when the body is fully drained. */
const pipeUpstreamBody = async (body, res) => {
  if (!body) {
    res.end();
    return;
  }
  if (typeof body.pipe === 'function') {
    await new Promise((resolve) => {
      body.on('end', resolve);
      body.on('error', resolve);
      body.pipe(res);
    });
    return;
  }
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
};

const SANITIZED_RESPONSE_HEADERS = [
  'content-type',
  'cache-control',
  'x-next-cursor',
  'x-openchamber-quota-remaining',
];
