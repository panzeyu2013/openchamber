import { validateCreateWorkspaceInput, validateUpdateWorkspaceInput, toConnectionSummary } from './catalog-schema.js';
import { createSafeUpstreamValidator } from './direct-adapter.js';
import { isPathWithinRoot } from './path-boundary.js';

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
    credentialProvider = null,
    onConnectionsChanged = null,
    // Inject for tests; defaults to the real DNS-resolving validator.
    safeUpstreamValidator = createSafeUpstreamValidator({}),
  } = dependencies;

  const { assertSafeUpstreamUrl } = safeUpstreamValidator;

  const resolveAdapter = (connectionId) => {
    const adapter = connectionBroker.getAdapter(connectionId);
    return adapter ?? null;
  };

  const validateDirectTargetInput = async (input, existingProfile) => {
    const label = typeof input?.label === 'string' ? input.label.trim() : '';
    if (!label) throw connectionInputError('label is required');
    const baseUrl = typeof input?.baseUrl === 'string' ? input.baseUrl.trim() : '';
    if (!baseUrl) throw connectionInputError('baseUrl is required');
    let normalizedUrl;
    try {
      normalizedUrl = new URL(baseUrl);
      if (normalizedUrl.protocol !== 'http:' && normalizedUrl.protocol !== 'https:') throw new Error('unsupported protocol');
    } catch {
      throw connectionInputError('baseUrl must be a valid http(s) URL');
    }
    try {
      await assertSafeUpstreamUrl(baseUrl);
    } catch (error) {
      throw connectionInputError(error.message);
    }
    const clientToken = typeof input?.clientToken === 'string' && input.clientToken.length > 0
      ? input.clientToken
      : (existingProfile?.target?.clientToken ?? '');
    const allowRedirectHosts = Array.isArray(input?.allowRedirectHosts)
      ? input.allowRedirectHosts.filter((host) => typeof host === 'string' && host.trim().length > 0).map((host) => host.trim())
      : (existingProfile?.target?.allowRedirectHosts ?? []);
    return {
      kind: 'direct',
      baseUrl: normalizedUrl.origin + normalizedUrl.pathname.replace(/\/+$/, ''),
      ...(clientToken ? { clientToken } : {}),
      ...(allowRedirectHosts.length > 0 ? { allowRedirectHosts } : {}),
    };
  };

  app.get('/api/workspaces', async (_req, res) => {
    try {
      const snapshot = await catalogStore.getSnapshot();
      const connections = [];
      if (profileStore) {
        const records = await profileStore.listPrivateRecords();
        for (const record of records) {
          const adapter = resolveAdapter(record.id);
          const capabilities = adapter?.capabilities ?? localAdapterCapabilities(record);
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
      const profile = profileStore ? await profileStore.getPrivateRecord(workspace.connectionId) : null;
      const probe = await adapter.probe({ profile }, workspace.canonicalPath);
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
    // Lexical boundary first (blocks `..` traversal for every adapter); the
    // adapter additionally enforces the boundary under its own path semantics
    // (the local adapter resolves symlinks) via the canonicalPath context.
    if (!isPathWithinRoot(workspace.canonicalPath, directory)) {
      return sendError(res, 403, 'Path is outside the workspace', 'catalog_path_outside_workspace');
    }
    try {
      const result = await adapter.listChildren({ canonicalPath: workspace.canonicalPath }, directory);
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
        return toConnectionSummary(record, adapter?.capabilities ?? localAdapterCapabilities(record));
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
      const profile = profileStore ? await profileStore.getPrivateRecord(req.params.connectionId) : null;
      const probe = await adapter.probe({ profile }, null);
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
      const result = await adapter.listChildren({ profile: await profileStore.getPrivateRecord(req.params.connectionId) }, directory);
      res.json(result);
    } catch (error) {
      sendError(res, error.status ?? 400, error.message, error.code);
    }
  });

  // ---- Connection profile CRUD (Phase 3: direct connections) ----
  // Private connection details (baseUrl, clientToken, redirect allowlist)
  // are stored ONLY in the server-side profile store; public responses go
  // through toConnectionSummary and never contain them.

  const profileToSummary = async (record) => {
    const adapter = resolveAdapter(record.id);
    return toConnectionSummary(record, adapter?.capabilities ?? localAdapterCapabilities(record));
  };

  const withConnectionsChanged = async (res, action) => {
    try {
      const record = await action();
      if (onConnectionsChanged) await onConnectionsChanged();
      res.status(200).json({ connection: await profileToSummary(record) });
    } catch (error) {
      if (error?.status) return sendError(res, error.status, error.message, error.code);
      sendError(res, 500, error instanceof Error ? error.message : 'Failed to update connections');
    }
  };

  app.post('/api/connections', async (req, res) => {
    if (!profileStore) return sendError(res, 500, 'Connection store is unavailable', 'catalog_connection_store_unavailable');
    let target;
    try {
      target = await validateDirectTargetInput(req.body, null);
    } catch (error) {
      return sendError(res, error.status ?? 400, error.message, error.code);
    }
    return withConnectionsChanged(res, async () => {
      const record = await profileStore.upsertConnection({
        id: '',
        label: typeof req.body?.label === 'string' ? req.body.label.trim() : '',
        target,
      });
      return record;
    });
  });

  app.patch('/api/connections/:connectionId', async (req, res) => {
    if (!profileStore) return sendError(res, 500, 'Connection store is unavailable', 'catalog_connection_store_unavailable');
    const existing = await profileStore.getPrivateRecord(req.params.connectionId);
    if (!existing) return sendError(res, 404, 'Unknown connection', 'catalog_connection_not_found');
    if (existing.target?.kind !== 'direct') {
      return sendError(res, 400, 'Only direct connections can be edited', 'catalog_connection_not_editable');
    }
    let target;
    try {
      target = await validateDirectTargetInput(req.body, existing);
    } catch (error) {
      return sendError(res, error.status ?? 400, error.message, error.code);
    }
    return withConnectionsChanged(res, async () => {
      const record = await profileStore.upsertConnection({
        ...existing,
        label: typeof req.body?.label === 'string' ? req.body.label.trim() : existing.label,
        target,
      });
      return record;
    });
  });

  app.delete('/api/connections/:connectionId', async (req, res) => {
    if (!profileStore) return sendError(res, 500, 'Connection store is unavailable', 'catalog_connection_store_unavailable');
    const connectionId = req.params.connectionId;
    if (connectionId === 'local') {
      return sendError(res, 400, 'The local connection cannot be deleted', 'catalog_connection_not_deletable');
    }
    const existing = await profileStore.getPrivateRecord(connectionId);
    if (!existing) return sendError(res, 404, 'Unknown connection', 'catalog_connection_not_found');
    const snapshot = await catalogStore.getSnapshot();
    const referencing = snapshot.workspaces.filter((workspace) => workspace.connectionId === connectionId);
    if (referencing.length > 0) {
      return sendError(res, 409, `Connection is used by ${referencing.length} workspace(s)`, 'catalog_connection_in_use');
    }
    try {
      await profileStore.deleteConnection(connectionId);
      if (onConnectionsChanged) await onConnectionsChanged();
      res.json({ deleted: true });
    } catch (error) {
      if (error?.status) return sendError(res, error.status, error.message, error.code);
      sendError(res, 500, error instanceof Error ? error.message : 'Failed to delete connection');
    }
  });
};

const connectionInputError = (message) => {
  const error = new Error(message);
  error.status = 400;
  error.code = 'catalog_invalid_input';
  return error;
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

const basenameOf = (canonicalPath) => {
  const parts = canonicalPath.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : canonicalPath;
};

/** Capabilities fallback when no adapter is registered yet (boot race or a
 * kind whose adapter is injected later, e.g. Electron SSH). Local and direct
 * connections are full-capability by construction; other kinds stay
 * conservative until their adapter registers. */
const localAdapterCapabilities = (record) => {
  const kind = record?.target?.kind;
  if (kind === 'local' || kind === 'direct') {
    return { pathBrowse: true, terminal: true, files: true, git: true, eventStream: true };
  }
  return { pathBrowse: false, terminal: false, files: false, git: false, eventStream: false };
};
