/**
 * Session Index API routes.
 *
 * - `GET /api/project-sessions/snapshot` — cross-connection lightweight
 *   session index with per-connection freshness and a global revision.
 * - `GET /api/project-sessions/events` — SSE stream of incremental events
 *   carrying the global revision; a client seeing a revision gap must
 *   re-fetch the snapshot. (WS transport variant to be wired with the
 *   central upgrade dispatcher.)
 * - `POST /api/projects/:projectId/sessions` — creates a session in the
 *   project's runtime and records a `created-in-project` binding.
 * - `POST /api/projects/:projectId/sessions/:sessionId/bind` — explicit
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

  app.get('/api/project-sessions/snapshot', async (_req, res) => {
    try {
      const snapshot = await sessionIndex.getSnapshot();
      res.json(snapshot);
    } catch (error) {
      sendError(res, 500, error instanceof Error ? error.message : 'Failed to read session index');
    }
  });

  app.get('/api/project-sessions/events', async (req, res) => {
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

  app.post('/api/projects/:projectId/sessions', async (req, res) => {
    const project = await findProject(catalogStore, req.params.projectId, res);
    if (!project) return;
    const resolved = await connectionBroker.resolveConnection(project.connectionId);
    if (!resolved) {
      return sendError(res, 404, 'Connection is not available', 'catalog_connection_not_found');
    }
    const { profile, adapter } = resolved;
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (body.prompt !== undefined && typeof body.prompt !== 'string') {
      return sendError(res, 400, 'prompt must be a string', 'catalog_invalid_input');
    }
    const release = connectionBroker.acquireLease(project.connectionId);
    try {
      const context = {
        profile,
        canonicalPath: project.canonicalPath,
        credentialProvider,
      };
      const request = {
        method: 'POST',
        headers: new Headers({
          accept: 'application/json',
          'content-type': 'application/json',
          'x-opencode-directory': project.canonicalPath,
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
        connectionId: project.connectionId,
        upstreamSessionId: sessionId,
        projectId: project.id,
        observedDirectory: project.canonicalPath,
      });
      void sessionIndex.refreshConnection(project.connectionId, { background: true }).catch(() => {});
      res.status(201).json({ sessionId, projectId: project.id });
    } catch (error) {
      sendError(res, 502, error instanceof Error ? error.message : 'Session creation failed', 'session_index_create_failed');
    } finally {
      release();
    }
  });

  app.post('/api/projects/:projectId/sessions/:sessionId/bind', async (req, res) => {
    const project = await findProject(catalogStore, req.params.projectId, res);
    if (!project) return;
    const upstreamSessionId = req.params.sessionId;
    if (typeof upstreamSessionId !== 'string' || upstreamSessionId.length === 0) {
      return sendError(res, 400, 'sessionId is required', 'catalog_invalid_input');
    }
    const observedDirectory = typeof req.body?.directory === 'string'
      ? req.body.directory
      : project.canonicalPath;
    try {
      await bindingStore.bindSession({
        connectionId: project.connectionId,
        upstreamSessionId,
        projectId: project.id,
        observedDirectory,
        source: 'explicit',
        allowMove: true,
      });
      void sessionIndex.refreshConnection(project.connectionId, { background: true }).catch(() => {});
      res.json({ bound: true, projectId: project.id, upstreamSessionId });
    } catch (error) {
      if (error?.status) return sendError(res, error.status, error.message, error.code);
      sendError(res, 500, error instanceof Error ? error.message : 'Failed to bind session');
    }
  });
};

const findProject = async (catalogStore, projectId, res) => {
  try {
    const project = await catalogStore.getProject(projectId);
    if (!project) {
      sendError(res, 404, 'Project not found', 'catalog_project_not_found');
      return null;
    }
    return project;
  } catch (error) {
    sendError(res, 500, error instanceof Error ? error.message : 'Failed to read project');
    return null;
  }
};
