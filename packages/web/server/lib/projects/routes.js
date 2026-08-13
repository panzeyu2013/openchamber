import { validateCreateProjectInput, validateUpdateProjectInput, toConnectionSummary } from './catalog-schema.js';
import { createSafeUpstreamValidator } from './direct-adapter.js';
import { isPathWithinProject } from './path-boundary.js';

/**
 * Project Catalog API routes.
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

export const registerProjectCatalogRoutes = (app, dependencies) => {
  const {
    catalogStore,
    connectionBroker,
    profileStore,
    credentialProvider = null,
    onConnectionsChanged = null,
    // Server capability flag `projectCatalogV1` (plan §20): when false,
    // every catalog/connection MUTATION returns 501 `capability_unavailable`
    // before touching any store. Reads (snapshot, single project, browse,
    // probes, capabilities) stay available; the catalog data files are never
    // rewritten by the disabled state. index.js resolves the flag from the
    // operator env switch; tests inject the boolean directly.
    projectCatalogV1 = true,
    // Inject for tests; defaults to the real DNS-resolving validator.
    safeUpstreamValidator = createSafeUpstreamValidator({}),
    // Injected by index.js; when absent (tests without a binding store) the
    // DELETE route only removes the catalog reference.
    sessionBindingStore = null,
  } = dependencies;

  const { assertSafeUpstreamUrl } = safeUpstreamValidator;

  const sendCapabilityUnavailable = (res) => sendError(res, 501, 'The project catalog is disabled on this server', 'capability_unavailable');
  const catalogMutationsDisabled = projectCatalogV1 === false;

  const resolveAdapter = (connectionId) => {
    const adapter = connectionBroker.getAdapter(connectionId);
    return adapter ?? null;
  };

  const validateDirectTargetInput = async (input, existingProfile) => {
    const label = typeof input?.label === 'string' ? input.label.trim() : '';
    if (!label) throw connectionInputError('label is required');
    const baseUrl = typeof input?.baseUrl === 'string' && input.baseUrl.trim().length > 0
      ? input.baseUrl.trim()
      // Label-only edits keep the saved target URL (the URL is private and
      // never exposed to clients, so it cannot be required in a PATCH body).
      : (existingProfile?.target?.baseUrl ?? '');
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

  app.get('/api/projects', async (_req, res) => {
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
      sendError(res, 500, error instanceof Error ? error.message : 'Failed to read project catalog');
    }
  });

  // Lightweight capabilities read: stays available in EVERY state so clients
  // can detect `projectCatalogV1: false` and switch the unified sidebar to
  // its read-only degradation state instead of attempting mutations.
  app.get('/api/projects/capabilities', async (_req, res) => {
    res.json({ projectCatalogV1 });
  });

  app.post('/api/projects', async (req, res) => {
    if (catalogMutationsDisabled) return sendCapabilityUnavailable(res);
    let input;
    try {
      input = validateCreateProjectInput(req.body);
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
      const profile = profileStore ? await profileStore.getPrivateRecord(input.connectionId) : null;
      const probe = await adapter.probe({ profile, credentialProvider }, canonicalPath);
      if (!probe?.ok) {
        const probeError = probe?.error ?? { code: 'catalog_probe_failed', message: 'Project path probe failed' };
        return sendError(res, probeErrorStatus(probeError.code), probeError.message, probeError.code);
      }
      canonicalPath = typeof probe.canonicalPath === 'string' ? probe.canonicalPath : canonicalPath;
    } catch (error) {
      return sendError(res, error.status ?? 400, error.message, error.code);
    }
    try {
      const outcome = await catalogStore.createProject({
        connectionId: input.connectionId,
        canonicalPath,
        path: canonicalPath,
        label: input.label ?? basenameOf(canonicalPath),
        color: input.color,
        orderKey: input.orderKey,
      });
      res.status(outcome.created ? 201 : 200).json({
        project: outcome.descriptor,
        revision: outcome.revision,
        created: outcome.created,
      });
    } catch (error) {
      if (error?.code === 'catalog_revision_conflict') return sendConflict(res, error);
      sendError(res, 500, error instanceof Error ? error.message : 'Failed to create project');
    }
  });

  app.patch('/api/projects/:projectId', async (req, res) => {
    if (catalogMutationsDisabled) return sendCapabilityUnavailable(res);
    const projectId = req.params.projectId;
    let patch;
    try {
      patch = validateUpdateProjectInput(req.body);
    } catch (error) {
      return sendError(res, error.status ?? 400, error.message, error.code);
    }
    const ifMatch = readIfMatch(req);
    try {
      const outcome = await catalogStore.updateProject(projectId, patch, ifMatch);
      res.json({ project: outcome.descriptor, revision: outcome.revision });
    } catch (error) {
      if (error?.code === 'catalog_revision_conflict') return sendConflict(res, error);
      if (error?.status === 404) return sendError(res, 404, error.message, error.code);
      sendError(res, 500, error instanceof Error ? error.message : 'Failed to update project');
    }
  });

  app.delete('/api/projects/:projectId', async (req, res) => {
    if (catalogMutationsDisabled) return sendCapabilityUnavailable(res);
    const projectId = req.params.projectId;
    const ifMatch = readIfMatch(req);
    try {
      const outcome = await catalogStore.deleteProject(projectId, ifMatch);
      let bindingsRemoved = 0;
      if (sessionBindingStore) {
        try {
          bindingsRemoved = (await sessionBindingStore.removeBindingsForProject(projectId)).removed;
        } catch (error) {
          // The catalog reference is already gone; leaving stale bindings
          // would keep resolving sessions to a deleted project. The caller
          // must see the partial failure so it can retry the cleanup.
          return sendError(res, 500, 'Project deleted but session bindings cleanup failed', 'binding_cleanup_failed');
        }
      }
      res.json({ revision: outcome.revision, bindingsRemoved });
    } catch (error) {
      if (error?.code === 'catalog_revision_conflict') return sendConflict(res, error);
      if (error?.status === 404) return sendError(res, 404, error.message, error.code);
      sendError(res, 500, error instanceof Error ? error.message : 'Failed to delete project');
    }
  });

  app.get('/api/projects/:projectId', async (req, res) => {
    const project = await findProject(catalogStore, req.params.projectId, res);
    if (!project) return;
    res.json({ project });
  });

  app.post('/api/projects/:projectId/probe', async (req, res) => {
    const project = await findProject(catalogStore, req.params.projectId, res);
    if (!project) return;
    const adapter = resolveAdapter(project.connectionId);
    if (!adapter) {
      return sendError(res, 404, 'Unknown connection', 'catalog_connection_not_found');
    }
    try {
      const profile = profileStore ? await profileStore.getPrivateRecord(project.connectionId) : null;
      const probe = await adapter.probe({ profile, credentialProvider }, project.canonicalPath);
      res.json(probe);
    } catch (error) {
      sendError(res, 500, error instanceof Error ? error.message : 'Probe failed');
    }
  });

  app.get('/api/projects/:projectId/children', async (req, res) => {
    const project = await findProject(catalogStore, req.params.projectId, res);
    if (!project) return;
    const adapter = resolveAdapter(project.connectionId);
    if (!adapter) {
      return sendError(res, 404, 'Unknown connection', 'catalog_connection_not_found');
    }
    if (adapter.capabilities?.pathBrowse !== true) {
      return sendError(res, 501, 'Path browsing is not available for this connection', 'capability_unavailable');
    }
    const directory = typeof req.query.path === 'string' && req.query.path.length > 0
      ? req.query.path
      : project.canonicalPath;
    // Lexical boundary first (blocks `..` traversal for every adapter); the
    // adapter additionally enforces the boundary under its own path semantics
    // (the local adapter resolves symlinks) via the canonicalPath context.
    if (!isPathWithinProject(project.canonicalPath, directory)) {
      return sendError(res, 403, 'Path is outside the project', 'catalog_path_outside_project');
    }
    try {
      const profile = profileStore ? await profileStore.getPrivateRecord(project.connectionId) : null;
      const result = await adapter.listChildren({ profile, canonicalPath: project.canonicalPath, credentialProvider }, directory);
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
      const probe = await adapter.probe({ profile, credentialProvider }, null);
      // A live successful probe records the last-connect time (best-effort;
      // the probe response is never delayed or failed by the write). While
      // the catalog is disabled the profile file must stay untouched (read
      // gate), so the write-back is skipped in that state.
      if (probe?.ok && !catalogMutationsDisabled && profileStore) {
        void profileStore.recordProbeSuccess(req.params.connectionId, Date.now())
          .catch((error) => {
            console.error(`[projects] failed to record probe success for ${req.params.connectionId}:`, error?.message ?? error);
          });
      }
      res.json(probe);
    } catch (error) {
      sendError(res, 500, error instanceof Error ? error.message : 'Probe failed');
    }
  });

  // Connection-scoped directory browsing used by the unified Add Project
  // dialog BEFORE a project exists. Children are validated against the
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
      const result = await adapter.listChildren({
        profile: await profileStore.getPrivateRecord(req.params.connectionId),
        credentialProvider,
      }, directory);
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

  /** Best-effort background probe of a registered connection. Registration
   * succeeds regardless of reachability; only a successful probe records
   * `lastProbeOkAt` on the profile. Never throws to the caller — failures
   * are logged so an unhandled rejection can never crash the request or
   * process. The adapter is resolved AFTER `onConnectionsChanged` ran, so
   * profile-synced adapters (direct/relay) are registered by the time the
   * probe executes. */
  const runConnectionProbe = async (connectionId) => {
    try {
      const adapter = connectionBroker.getAdapter(connectionId);
      if (!adapter || typeof adapter.probe !== 'function') return;
      const profile = profileStore ? await profileStore.getPrivateRecord(connectionId) : null;
      const probe = await adapter.probe({ profile, credentialProvider }, null);
      if (probe?.ok && profileStore && typeof profileStore.recordProbeSuccess === 'function') {
        await profileStore.recordProbeSuccess(connectionId, Date.now());
      }
    } catch (error) {
      console.error(`[projects] background probe failed for ${connectionId}:`, error?.message ?? error);
    }
  };

  /** Upserts + adapter-syncs a connection and sends the public summary.
   * Returns the private record (null when the response was already sent with
   * an error), so handlers can fire post-response work. */
  const mutateConnection = async (res, action) => {
    let record;
    try {
      record = await action();
    } catch (error) {
      if (error?.status) return sendError(res, error.status, error.message, error.code);
      sendError(res, 500, error instanceof Error ? error.message : 'Failed to update connections');
      return null;
    }
    if (onConnectionsChanged) {
      try {
        await onConnectionsChanged();
      } catch (error) {
        sendError(res, 500, error instanceof Error ? error.message : 'Failed to update connections');
        return null;
      }
    }
    try {
      res.status(200).json({ connection: await profileToSummary(record) });
    } catch (error) {
      sendError(res, 500, error instanceof Error ? error.message : 'Failed to update connections');
      return null;
    }
    return record;
  };

  app.post('/api/connections', async (req, res) => {
    if (catalogMutationsDisabled) return sendCapabilityUnavailable(res);
    if (!profileStore) return sendError(res, 500, 'Connection store is unavailable', 'catalog_connection_store_unavailable');
    let target;
    try {
      target = await validateDirectTargetInput(req.body, null);
    } catch (error) {
      return sendError(res, error.status ?? 400, error.message, error.code);
    }
    const record = await mutateConnection(res, () => profileStore.upsertConnection({
      id: '',
      label: typeof req.body?.label === 'string' ? req.body.label.trim() : '',
      target,
    }));
    if (record) {
      // Registration is global and immediate; reachability is confirmed in
      // the background and surfaced through `lastProbeOkAt`.
      void runConnectionProbe(record.id);
    }
  });

  app.patch('/api/connections/:connectionId', async (req, res) => {
    if (catalogMutationsDisabled) return sendCapabilityUnavailable(res);
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
    const targetChanged = target.baseUrl !== existing.target?.baseUrl;
    const record = await mutateConnection(res, () => profileStore.upsertConnection({
      ...existing,
      label: req.body.label.trim(),
      target,
      // A changed target URL has never been probed; keep the stale
      // "connected before" timestamp out of the record instead of letting it
      // vouch for a URL the server has never contacted.
      ...(targetChanged ? { lastProbeOkAt: undefined } : {}),
    }));
    if (record) {
      // A changed target invalidates the previous probe result; re-probe in
      // the background so `lastProbeOkAt` reflects the current URL.
      void runConnectionProbe(record.id);
    }
  });

  app.delete('/api/connections/:connectionId', async (req, res) => {
    if (catalogMutationsDisabled) return sendCapabilityUnavailable(res);
    if (!profileStore) return sendError(res, 500, 'Connection store is unavailable', 'catalog_connection_store_unavailable');
    const connectionId = req.params.connectionId;
    if (connectionId === 'local') {
      return sendError(res, 400, 'The local connection cannot be deleted', 'catalog_connection_not_deletable');
    }
    const existing = await profileStore.getPrivateRecord(connectionId);
    if (!existing) return sendError(res, 404, 'Unknown connection', 'catalog_connection_not_found');
    const snapshot = await catalogStore.getSnapshot();
    const referencing = snapshot.projects.filter((project) => project.connectionId === connectionId);
    if (referencing.length > 0) {
      return sendError(res, 409, `Connection is used by ${referencing.length} project(s)`, 'catalog_connection_in_use');
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

const probeErrorStatus = (code) => {
  if (code === 'catalog_path_not_found') return 404;
  if (code === 'catalog_path_outside_project') return 403;
  if (code === 'catalog_invalid_path' || code === 'direct_unsafe_target') return 400;
  if (code === 'capability_unavailable') return 501;
  return 502;
};
