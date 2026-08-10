import { validateCreateWorkspaceInput, validateUpdateWorkspaceInput, toConnectionSummary } from './catalog-schema.js';

/**
 * Workspace Catalog API routes.
 *
 * Registered after the base UI auth gate and before the generic OpenCode
 * /api/* proxy (see packages/web/server/index.js). The generic proxy must
 * never capture these paths.
 *
 * Error contract: input problems -> 4xx with a JSON { error, code? } body;
 * catalog persistence conflicts -> 409 `catalog_revision_conflict` (client
 * re-fetches the snapshot and replays the user action); server failures ->
 * 500 with a sanitized message. Never echoes request bodies or private
 * connection data.
 */

const sendError = (res, status, message, code) => {
  res.status(status).json({ error: message, ...(code ? { code } : {}) });
};

const sendConflict = (res, error) => sendError(res, 409, error.message, 'catalog_revision_conflict');

export const registerWorkspaceCatalogRoutes = (app, dependencies) => {
  const {
    catalogStore,
    connectionBroker,
    profileStore,
  } = dependencies;

  const resolveAdapter = (connectionId) => {
    const adapter = connectionBroker.getAdapter(connectionId);
    return adapter ?? null;
  };

  app.get('/api/workspaces', async (_req, res) => {
    try {
      const snapshot = await catalogStore.getSnapshot();
      const connections = [];
      if (profileStore) {
        const records = await profileStore.listPrivateRecords();
        for (const record of records) {
          const adapter = resolveAdapter(record.id);
          const capabilities = adapter?.capabilities ?? localAdapterCapabilities(record.id);
          const summary = toConnectionSummary(record, capabilities);
          if (summary) connections.push(summary);
        }
      }
      res.json({ ...snapshot, connections });
    } catch (error) {
      sendError(res, 500, error instanceof Error ? error.message : 'Failed to read workspace catalog');
    }
  });

  app.post('/api/workspaces', async (req, res) => {
    let input;
    try {
      input = validateCreateWorkspaceInput(req.body);
    } catch (error) {
      return sendError(res, error.status ?? 400, error.message, error.code);
    }
    const adapter = resolveAdapter(input.connectionId);
    if (!adapter) {
      return sendError(res, 404, 'Unknown connection', 'catalog_connection_not_found');
    }
    let canonicalPath;
    try {
      canonicalPath = await adapter.canonicalizePath({}, input.path);
    } catch (error) {
      return sendError(res, error.status ?? 400, error.message, error.code);
    }
    try {
      const outcome = await catalogStore.createWorkspace({
        connectionId: input.connectionId,
        canonicalPath,
        path: canonicalPath,
        label: input.label ?? basenameOf(canonicalPath),
        color: input.color,
        orderKey: input.orderKey,
      });
      res.status(outcome.created ? 201 : 200).json({
        workspace: outcome.descriptor,
        revision: outcome.revision,
        created: outcome.created,
      });
    } catch (error) {
      if (error?.code === 'catalog_revision_conflict') return sendConflict(res, error);
      sendError(res, 500, error instanceof Error ? error.message : 'Failed to create workspace');
    }
  });

  app.patch('/api/workspaces/:workspaceId', async (req, res) => {
    const workspaceId = req.params.workspaceId;
    let patch;
    try {
      patch = validateUpdateWorkspaceInput(req.body);
    } catch (error) {
      return sendError(res, error.status ?? 400, error.message, error.code);
    }
    const ifMatch = readIfMatch(req);
    try {
      const outcome = await catalogStore.updateWorkspace(workspaceId, patch, ifMatch);
      res.json({ workspace: outcome.descriptor, revision: outcome.revision });
    } catch (error) {
      if (error?.code === 'catalog_revision_conflict') return sendConflict(res, error);
      if (error?.status === 404) return sendError(res, 404, error.message, error.code);
      sendError(res, 500, error instanceof Error ? error.message : 'Failed to update workspace');
    }
  });

  app.delete('/api/workspaces/:workspaceId', async (req, res) => {
    const workspaceId = req.params.workspaceId;
    const ifMatch = readIfMatch(req);
    try {
      const outcome = await catalogStore.deleteWorkspace(workspaceId, ifMatch);
      res.json({ revision: outcome.revision });
    } catch (error) {
      if (error?.code === 'catalog_revision_conflict') return sendConflict(res, error);
      if (error?.status === 404) return sendError(res, 404, error.message, error.code);
      sendError(res, 500, error instanceof Error ? error.message : 'Failed to delete workspace');
    }
  });

  app.get('/api/workspaces/:workspaceId', async (req, res) => {
    const workspace = await findWorkspace(catalogStore, req.params.workspaceId, res);
    if (!workspace) return;
    res.json({ workspace });
  });

  app.post('/api/workspaces/:workspaceId/probe', async (req, res) => {
    const workspace = await findWorkspace(catalogStore, req.params.workspaceId, res);
    if (!workspace) return;
    const adapter = resolveAdapter(workspace.connectionId);
    if (!adapter) {
      return sendError(res, 404, 'Unknown connection', 'catalog_connection_not_found');
    }
    try {
      const probe = await adapter.probe({}, workspace.canonicalPath);
      res.json(probe);
    } catch (error) {
      sendError(res, 500, error instanceof Error ? error.message : 'Probe failed');
    }
  });

  app.get('/api/workspaces/:workspaceId/children', async (req, res) => {
    const workspace = await findWorkspace(catalogStore, req.params.workspaceId, res);
    if (!workspace) return;
    const adapter = resolveAdapter(workspace.connectionId);
    if (!adapter) {
      return sendError(res, 404, 'Unknown connection', 'catalog_connection_not_found');
    }
    if (adapter.capabilities?.pathBrowse !== true) {
      return sendError(res, 501, 'Path browsing is not available for this connection', 'capability_unavailable');
    }
    const directory = typeof req.query.path === 'string' && req.query.path.length > 0
      ? req.query.path
      : workspace.canonicalPath;
    if (!isWithinPath(directory, workspace.canonicalPath)) {
      return sendError(res, 403, 'Path is outside the workspace', 'catalog_path_outside_workspace');
    }
    try {
      const result = await adapter.listChildren({}, directory);
      res.json(result);
    } catch (error) {
      sendError(res, error.status ?? 400, error.message, error.code);
    }
  });

  app.get('/api/connections', async (_req, res) => {
    try {
      if (!profileStore) return res.json({ connections: [] });
      const records = await profileStore.listPrivateRecords();
      const connections = records.map((record) => {
        const adapter = resolveAdapter(record.id);
        return toConnectionSummary(record, adapter?.capabilities ?? localAdapterCapabilities(record.id));
      }).filter(Boolean);
      res.json({ connections });
    } catch (error) {
      sendError(res, 500, error instanceof Error ? error.message : 'Failed to read connections');
    }
  });

  app.post('/api/connections/:connectionId/probe', async (req, res) => {
    const adapter = resolveAdapter(req.params.connectionId);
    if (!adapter) {
      return sendError(res, 404, 'Unknown connection', 'catalog_connection_not_found');
    }
    try {
      const probe = await adapter.probe({}, null);
      res.json(probe);
    } catch (error) {
      sendError(res, 500, error instanceof Error ? error.message : 'Probe failed');
    }
  });

  // Connection-scoped directory browsing used by the unified Add Workspace
  // dialog BEFORE a workspace exists. Children are validated against the
  // adapter's canonicalize/list semantics; responses contain no secrets.
  app.get('/api/connections/:connectionId/children', async (req, res) => {
    const adapter = resolveAdapter(req.params.connectionId);
    if (!adapter) {
      return sendError(res, 404, 'Unknown connection', 'catalog_connection_not_found');
    }
    if (adapter.capabilities?.pathBrowse !== true) {
      return sendError(res, 501, 'Path browsing is not available for this connection', 'capability_unavailable');
    }
    const directory = typeof req.query.path === 'string' && req.query.path.length > 0
      ? req.query.path
      : (typeof req.query.path === 'string' ? req.query.path : '/');
    try {
      const result = await adapter.listChildren({}, directory);
      res.json(result);
    } catch (error) {
      sendError(res, error.status ?? 400, error.message, error.code);
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

const readIfMatch = (req) => {
  const header = req.get('if-match');
  if (typeof header === 'string' && header.trim().length > 0) {
    const parsed = Number(header.trim());
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
};

const isWithinPath = (candidate, root) => {
  const rootWithSeparator = root.endsWith('/') ? root : `${root}/`;
  return candidate === root || candidate.startsWith(rootWithSeparator);
};

const basenameOf = (canonicalPath) => {
  const parts = canonicalPath.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : canonicalPath;
};

/** Phase 1: only the local adapter is registered, so any profile whose
 * adapter is missing reports conservative capabilities. */
const localAdapterCapabilities = (connectionId) => (
  connectionId === 'local'
    ? { pathBrowse: true, terminal: true, files: true, git: true, eventStream: true }
    : { pathBrowse: false, terminal: false, files: false, git: false, eventStream: false }
);
