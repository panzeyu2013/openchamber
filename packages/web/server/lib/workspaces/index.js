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
import { createLegacyWorkspaceMigration } from './migration.js';
import { registerWorkspaceCatalogRoutes } from './routes.js';
import { registerWorkspaceRuntimeProxyRoutes } from './runtime-proxy.js';

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

  const migration = createLegacyWorkspaceMigration({
    catalogStore,
    localAdapter,
    readSettings,
  });

  const registerRoutes = (app) => {
    registerWorkspaceCatalogRoutes(app, {
      catalogStore,
      connectionBroker,
      profileStore,
    });
    registerWorkspaceRuntimeProxyRoutes(app, {
      catalogStore,
      connectionBroker,
    });
  };

  /** Runs the legacy import without blocking server startup. */
  const migrate = async () => migration.run();

  const getDiagnostics = async () => ({
    catalog: await catalogStore.getDiagnostics(),
    profiles: await profileStore.getDiagnostics(),
    connections: Object.fromEntries(
      connectionBroker.listConnectionIds().map((connectionId) => [connectionId, connectionBroker.getLifecycleState(connectionId)]),
    ),
    migration: await migration.getStatus(),
  });

  const dispose = async () => {
    await connectionBroker.dispose();
  };

  return {
    catalogStore,
    profileStore,
    localAdapter,
    connectionBroker,
    migration,
    registerRoutes,
    migrate,
    getDiagnostics,
    dispose,
  };
};
