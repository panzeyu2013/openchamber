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
import { createLegacyWorkspaceMigration } from './migration.js';
import { createSessionBindingStore } from './session-binding-store.js';
import { createSessionIndex } from './session-index.js';
import { registerWorkspaceCatalogRoutes } from './routes.js';
import { registerWorkspaceRuntimeProxyRoutes } from './runtime-proxy.js';
import { registerSessionIndexRoutes } from './session-index-routes.js';

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
  } = dependencies;

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

  /** Registers one direct adapter per saved direct profile and unregisters
   * adapters whose profile was deleted. Called at boot and after any
   * connection CRUD mutation. */
  const syncDirectAdapters = async () => {
    const profiles = await profileStore.listPrivateRecords();
    const directIds = new Set();
    for (const profile of profiles) {
      if (profile.target?.kind !== 'direct') continue;
      directIds.add(profile.id);
      if (!connectionBroker.hasAdapter(profile.id)) {
        const adapter = createDirectWorkspaceAdapter({
          connectionId: profile.id,
          fetchImpl: typeof fetch === 'function' ? fetch : null,
        });
        connectionBroker.registerAdapter(adapter);
      }
    }
    for (const connectionId of connectionBroker.listConnectionIds()) {
      if (connectionId !== 'local' && !directIds.has(connectionId)) {
        await connectionBroker.unregisterAdapter(connectionId);
      }
    }
  };
  await syncDirectAdapters().catch((error) => {
    console.error('[workspaces] direct adapter sync failed:', error?.message ?? error);
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
    registerWorkspaceCatalogRoutes(app, {
      catalogStore,
      connectionBroker,
      profileStore,
      credentialProvider,
      onConnectionsChanged: syncDirectAdapters,
    });
    registerWorkspaceRuntimeProxyRoutes(app, {
      catalogStore,
      connectionBroker,
      credentialProvider,
    });
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
    migration: await migration.getStatus(),
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
