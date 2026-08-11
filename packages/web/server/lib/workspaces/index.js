/**
 * Workspaces runtime: owns the Catalog, Connection Profile store, Connection
 * Broker, local adapter and legacy migration for one control plane process.
 *
 * The runtime is created by the web server entrypoint AFTER the base UI auth
 * gate and BEFORE the generic OpenCode proxy registration; its routes are
 * registered by `registerRoutes(app)`.
 */

import { createCatalogStore } from './catalog-store.js';
import { createConnectionProfileStore } from './connection-profile-store.js';
import { createConnectionBroker } from './connection-broker.js';
import { createLocalWorkspaceAdapter } from './local-adapter.js';
import { createDirectWorkspaceAdapter } from './direct-adapter.js';
import { createRelayWorkspaceAdapter } from './relay-adapter.js';
import { createLegacyWorkspaceMigration } from './migration.js';
import { createSessionBindingStore } from './session-binding-store.js';
import { createSessionIndex } from './session-index.js';
import { registerWorkspaceCatalogRoutes } from './routes.js';
import {
  getRuntimeProxyStats,
  registerWorkspaceRuntimeProxyRoutes,
  resolveWorkspaceCatalogV1,
} from './runtime-proxy.js';
import { registerSessionIndexRoutes } from './session-index-routes.js';
import { registerWorkspaceDiagnosticsRoutes } from './diagnostics.js';

export const createWorkspacesRuntime = async (dependencies) => {
  const {
    fs,
    fsPromises,
    path,
    openchamberDataDir,
    readSettings,
    normalizeDirectoryPath,
    // Local OpenCode upstream resolution, injected by the server entrypoint
    // (module-level runtimes); absent in headless/unit contexts.
    buildOpenCodeUrl = null,
    getOpenCodeAuthHeaders = null,
    // Server-side credential resolver for direct/relay connections
    // (credentialRef -> { token, headers }). Never exposed to renderers.
    credentialProvider = null,
    // Adapters injected by privileged hosts (e.g. the Electron main process
    // providing SSH tunnels through ssh-manager). Each adapter must expose
    // connectionId + the standard adapter interface. packages/web never
    // imports packages/electron; the main process supplies these objects.
    injectedAdapters = [],
    // Server capability flag `workspaceCatalogV1` (plan §20): an operator
    // switch that gates catalog/session-index mutations and the workspace
    // runtime proxy while keeping reads (snapshot, browse, probes,
    // capabilities, diagnostics) available. It is a READ GATE only: the
    // catalog data files are never deleted, downgraded or rewritten by it.
    // Defaults to enabled; set OPENCHAMBER_WORKSPACE_CATALOG_DISABLED=1 to
    // disable. Tests inject the boolean directly.
    workspaceCatalogV1: workspaceCatalogV1Option = null,
  } = dependencies;

  const workspaceCatalogV1 = resolveWorkspaceCatalogV1(workspaceCatalogV1Option);

  await fsPromises.mkdir(openchamberDataDir, { recursive: true });

  const catalogStore = createCatalogStore({
    fs: fsPromises,
    path,
    filePath: path.join(openchamberDataDir, 'workspace-catalog.json'),
  });
  await catalogStore.load().catch((error) => {
    // A corrupt catalog must surface loudly at startup (recovery state is
    // tracked for diagnostics); it must never masquerade as an empty catalog.
    console.error('[workspaces] catalog load failed:', error?.message ?? error);
  });

  const profileStore = createConnectionProfileStore({
    fs: fsPromises,
    filePath: path.join(openchamberDataDir, 'connection-profiles.json'),
  });
  await profileStore.load().catch((error) => {
    if (error?.code === 'connection_profiles_corrupt') {
      console.error('[workspaces] connection profiles corrupt; rebuilt local connection only:', error?.message ?? error);
    } else {
      console.error('[workspaces] connection profiles load failed:', error?.message ?? error);
    }
  });

  const localAdapter = createLocalWorkspaceAdapter({
    fs: fsPromises,
    path,
    normalizeDirectoryPath,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    fetchImpl: typeof fetch === 'function' ? fetch : null,
  });

  const connectionBroker = createConnectionBroker({ profileStore });
  connectionBroker.registerAdapter(localAdapter);
  for (const adapter of injectedAdapters) {
    if (!adapter || typeof adapter.connectionId !== 'string') {
      console.error('[workspaces] skipping invalid injected adapter');
      continue;
    }
    connectionBroker.registerAdapter(adapter);
    // Seed a private profile record for injected adapters (Electron SSH) so
    // the catalog can resolve them; the record carries only the opaque
    // sshInstanceId, never tunnel URLs or keys.
    const existing = await profileStore.getPrivateRecord(adapter.connectionId).catch(() => null);
    if (!existing) {
      await profileStore.upsertConnection({
        id: adapter.connectionId,
        label: adapter.label ?? adapter.connectionId,
        target: { kind: 'ssh', sshInstanceId: adapter.sshInstanceId ?? adapter.connectionId },
      }).catch((error) => {
        console.error(`[workspaces] failed to seed profile for ${adapter.connectionId}:`, error?.message ?? error);
      });
    }
  }

  /** Registers one adapter per saved profile kind owned by this runtime and
   * unregisters only those managed adapters whose profile was deleted or
   * changed. Injected adapters (notably Electron SSH) remain broker-owned and
   * are never swept by profile synchronization. */
  const syncProfileAdapters = async () => {
    const profiles = await profileStore.listPrivateRecords();
    const managed = new Map();
    for (const profile of profiles) {
      const kind = profile.target?.kind;
      if (kind !== 'direct' && kind !== 'relay') continue;
      // A relay adapter needs a server-side credential provider. Keeping the
      // profile visible while leaving the adapter unavailable makes the
      // capability state truthful in headless runtimes that do not own relay
      // credentials.
      if (kind === 'relay' && !credentialProvider) continue;
      managed.set(profile.id, kind);
      if (!connectionBroker.hasAdapter(profile.id)) {
        const adapter = kind === 'relay'
          ? createRelayWorkspaceAdapter({ connectionId: profile.id })
          : createDirectWorkspaceAdapter({
            connectionId: profile.id,
            fetchImpl: typeof fetch === 'function' ? fetch : null,
          });
        connectionBroker.registerAdapter(adapter);
        continue;
      }
      const existing = connectionBroker.getAdapter(profile.id);
      if (existing?.kind !== kind) {
        await connectionBroker.unregisterAdapter(profile.id);
        const adapter = kind === 'relay'
          ? createRelayWorkspaceAdapter({ connectionId: profile.id })
          : createDirectWorkspaceAdapter({
            connectionId: profile.id,
            fetchImpl: typeof fetch === 'function' ? fetch : null,
          });
        connectionBroker.registerAdapter(adapter);
      }
    }
    for (const connectionId of connectionBroker.listConnectionIds()) {
      const adapter = connectionBroker.getAdapter(connectionId);
      if ((adapter?.kind === 'direct' || adapter?.kind === 'relay') && !managed.has(connectionId)) {
        await connectionBroker.unregisterAdapter(connectionId);
      }
    }
  };
  await syncProfileAdapters().catch((error) => {
    console.error('[workspaces] profile adapter sync failed:', error?.message ?? error);
  });

  const migration = createLegacyWorkspaceMigration({
    catalogStore,
    localAdapter,
    readSettings,
  });

  const bindingStore = createSessionBindingStore({
    fs: fsPromises,
    filePath: path.join(openchamberDataDir, 'workspace-session-bindings.json'),
  });
  await bindingStore.load().catch((error) => {
    console.error('[workspaces] session bindings load failed:', error?.message ?? error);
  });

  const sessionIndex = createSessionIndex({
    catalogStore,
    profileStore,
    connectionBroker,
    bindingStore,
    credentialProvider,
  });

  const registerRoutes = (app) => {
    // Diagnostics/capabilities reads register FIRST: `GET
    // /api/workspaces/diagnostics` must beat the later
    // `GET /api/workspaces/:workspaceId` param route (Express matches in
    // registration order), and the flag must be readable in every state.
    registerWorkspaceDiagnosticsRoutes(app, { getDiagnostics });
    registerWorkspaceCatalogRoutes(app, {
      catalogStore,
      connectionBroker,
      profileStore,
      credentialProvider,
      onConnectionsChanged: syncProfileAdapters,
      workspaceCatalogV1,
    });
    if (workspaceCatalogV1 === false) {
      // Disabled mode (§20): the workspace runtime proxy and the session
      // index mutation routes are replaced by explicit capability gates
      // (501 `capability_unavailable`), matching the sendError convention of
      // routes.js. Reads — catalog snapshot, browse, probes, capabilities,
      // diagnostics and the session-index snapshot/SSE — stay available, and
      // the catalog data files are never touched. The gates are registered
      // before the session-index routes below so the later real handlers
      // (and the generic OpenCode proxy) never see these mutations.
      const sendCapabilityUnavailable = (_req, res) => {
        res.status(501).json({ error: 'The workspace catalog is disabled on this server', code: 'capability_unavailable' });
      };
      app.all('/api/workspaces/:workspaceId/runtime', sendCapabilityUnavailable);
      app.use('/api/workspaces/:workspaceId/runtime', sendCapabilityUnavailable);
      app.post('/api/workspaces/:workspaceId/sessions', sendCapabilityUnavailable);
      app.post('/api/workspaces/:workspaceId/sessions/:sessionId/bind', sendCapabilityUnavailable);
    } else {
      registerWorkspaceRuntimeProxyRoutes(app, {
        catalogStore,
        connectionBroker,
        credentialProvider,
      });
    }
    registerSessionIndexRoutes(app, {
      catalogStore,
      connectionBroker,
      sessionIndex,
      bindingStore,
      credentialProvider,
    });
  };

  /** Runs the legacy import without blocking server startup. */
  const migrate = async () => migration.run();

  /** Starts per-connection observers and an initial snapshot pass. */
  const startSessionIndex = async () => {
    const results = await sessionIndex.refreshAll().catch((error) => {
      console.error('[workspaces] session index initial refresh failed:', error?.message ?? error);
      return {};
    });
    const records = await profileStore.listPrivateRecords().catch(() => []);
    for (const record of records) {
      void sessionIndex.ensureObserved(record.id).catch((error) => {
        console.error(`[workspaces] observer start failed for ${record.id}:`, error?.message ?? error);
      });
    }
    return results;
  };

  const getDiagnostics = async () => ({
    catalog: await catalogStore.getDiagnostics(),
    profiles: await profileStore.getDiagnostics(),
    bindings: await bindingStore.getDiagnostics(),
    sessionIndex: await sessionIndex.getDiagnostics(),
    connections: Object.fromEntries(
      connectionBroker.listConnectionIds().map((connectionId) => [connectionId, connectionBroker.getLifecycleState(connectionId)]),
    ),
    proxy: getRuntimeProxyStats(),
    migration: await migration.getStatus(),
    capabilities: { workspaceCatalogV1 },
  });

  const dispose = async () => {
    await sessionIndex.dispose();
    await connectionBroker.dispose();
  };

  return {
    catalogStore,
    profileStore,
    localAdapter,
    connectionBroker,
    bindingStore,
    sessionIndex,
    migration,
    registerRoutes,
    migrate,
    startSessionIndex,
    getDiagnostics,
    dispose,
  };
};
