/**
 * Session Index API routes.
 *
 * - `GET /api/workspace-sessions/snapshot` — cross-connection lightweight
 *   session index with per-connection freshness and a global revision.
 * - `GET /api/workspace-sessions/events` — SSE stream of incremental events
 *   carrying the global revision; a client seeing a revision gap must
 *   re-fetch the snapshot. (WS transport variant to be wired with the
 *   central upgrade dispatcher.)
 * - `POST /api/workspaces/:workspaceId/sessions` — creates a session in the
 *   workspace's runtime and records a `created-in-workspace` binding.
 * - `POST /api/workspaces/:workspaceId/sessions/:sessionId/bind` — explicit
 *   binding repair/move.
 *
 * All routes sit behind the base UI auth gate; responses never include
 * credentials or message bodies.
 */

const sendError = (res, status, message, code) => {
  res.status(status).json({ error: message, ...(code ? { code } : {}) });
};

export const registerSessionIndexRoutes = (app, dependencies) => {
  const {
    catalogStore,
    connectionBroker,
    sessionIndex,
    bindingStore,
    credentialProvider = null,
  } = dependencies;

  app.get('/api/workspace-sessions/snapshot', async (_req, res) => {
    try {
      const snapshot = await sessionIndex.getSnapshot();
      res.json(snapshot);
    } catch (error) {
      sendError(res, 500, error instanceof Error ? error.message : 'Failed to read session index');
    }
  });

  app.get('/api/workspace-sessions/events', async (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`retry: 3000\n\n`);
    const unsubscribe = sessionIndex.subscribeEvents((event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => {
      res.write(': ping\n\n');
    }, 25_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.post('/api/workspaces/:workspaceId/sessions', async (req, res) => {
    const workspace = await findWorkspace(catalogStore, req.params.workspaceId, res);
    if (!workspace) return;
    const resolved = await connectionBroker.resolveConnection(workspace.connectionId);
    if (!resolved) {
      return sendError(res, 404, 'Connection is not available', 'catalog_connection_not_found');
    }
    const { profile, adapter } = resolved;
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (body.prompt !== undefined && typeof body.prompt !== 'string') {
      return sendError(res, 400, 'prompt must be a string', 'catalog_invalid_input');
    }
    const release = connectionBroker.acquireLease(workspace.connectionId);
    try {
      const context = {
        profile,
        canonicalPath: workspace.canonicalPath,
        credentialProvider,
      };
      const request = {
        method: 'POST',
        headers: new Headers({
          accept: 'application/json',
          'content-type': 'application/json',
          'x-opencode-directory': workspace.canonicalPath,
          'x-openchamber-directory-encoding': 'none',
        }),
        body: JSON.stringify({
          ...(typeof body.prompt === 'string' && body.prompt.length > 0 ? { prompt: body.prompt } : {}),
        }),
      };
      const response = await adapter.fetch(context, request, '/api/session');
      if (!response.ok) {
        return sendError(res, 502, `Session creation failed (${response.status})`, 'session_index_create_failed');
      }
      const payload = await response.json();
      const sessionId = payload?.id ?? null;
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        return sendError(res, 502, 'Session creation returned an invalid payload', 'session_index_invalid_payload');
      }
      await bindingStore.createBindingForNewSession({
        connectionId: workspace.connectionId,
        upstreamSessionId: sessionId,
        workspaceId: workspace.id,
        observedDirectory: workspace.canonicalPath,
      });
      void sessionIndex.refreshConnection(workspace.connectionId, { background: true }).catch(() => {});
      res.status(201).json({ sessionId, workspaceId: workspace.id });
    } catch (error) {
      sendError(res, 502, error instanceof Error ? error.message : 'Session creation failed', 'session_index_create_failed');
    } finally {
      release();
    }
  });

  app.post('/api/workspaces/:workspaceId/sessions/:sessionId/bind', async (req, res) => {
    const workspace = await findWorkspace(catalogStore, req.params.workspaceId, res);
    if (!workspace) return;
    const upstreamSessionId = req.params.sessionId;
    if (typeof upstreamSessionId !== 'string' || upstreamSessionId.length === 0) {
      return sendError(res, 400, 'sessionId is required', 'catalog_invalid_input');
    }
    const observedDirectory = typeof req.body?.directory === 'string'
      ? req.body.directory
      : workspace.canonicalPath;
    try {
      await bindingStore.bindSession({
        connectionId: workspace.connectionId,
        upstreamSessionId,
        workspaceId: workspace.id,
        observedDirectory,
        source: 'explicit',
        allowMove: true,
      });
      void sessionIndex.refreshConnection(workspace.connectionId, { background: true }).catch(() => {});
      res.json({ bound: true, workspaceId: workspace.id, upstreamSessionId });
    } catch (error) {
      if (error?.status) return sendError(res, error.status, error.message, error.code);
      sendError(res, 500, error instanceof Error ? error.message : 'Failed to bind session');
    }
  });
};

const findWorkspace = async (catalogStore, workspaceId, res) => {
  try {
    const workspace = await catalogStore.getWorkspace(workspaceId);
    if (!workspace) {
      sendError(res, 404, 'Workspace not found', 'catalog_workspace_not_found');
      return null;
    }
    return workspace;
  } catch (error) {
    sendError(res, 500, error instanceof Error ? error.message : 'Failed to read workspace');
    return null;
  }
};
