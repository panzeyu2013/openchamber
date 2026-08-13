/**
 * Projects runtime: owns the Catalog, Connection Profile store, Connection
 * Broker, local adapter and legacy migration for one control plane process.
 *
 * The runtime is created by the web server entrypoint AFTER the base UI auth
 * gate and BEFORE the generic OpenCode proxy registration; its routes are
 * registered by `registerRoutes(app)`.
 */

import { createCatalogStore } from './catalog-store.js';
import { createConnectionProfileStore } from './connection-profile-store.js';
import { createConnectionBroker } from './connection-broker.js';
import { createLocalProjectAdapter } from './local-adapter.js';
import { createDirectProjectAdapter } from './direct-adapter.js';
import { createRelayProjectAdapter } from './relay-adapter.js';
import { createLegacyProjectMigration } from './migration.js';
import { createSessionBindingStore } from './session-binding-store.js';
import { createSessionIndex } from './session-index.js';
import { registerProjectCatalogRoutes } from './routes.js';
import {
  getRuntimeProxyStats,
  registerProjectRuntimeProxyRoutes,
  resolveProjectCatalogV1,
} from './runtime-proxy.js';
import { registerSessionIndexRoutes } from './session-index-routes.js';
import { registerProjectDiagnosticsRoutes } from './diagnostics.js';

export const createProjectsRuntime = async (dependencies) => {
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
    // Server capability flag `projectCatalogV1` (plan §20): an operator
    // switch that gates catalog/session-index mutations and the project
    // runtime proxy while keeping reads (snapshot, browse, probes,
    // capabilities, diagnostics) available. It is a READ GATE only: the
    // catalog data files are never deleted, downgraded or rewritten by it.
    // Defaults to enabled; set OPENCHAMBER_PROJECT_CATALOG_DISABLED=1 to
    // disable. Tests inject the boolean directly.
    projectCatalogV1: projectCatalogV1Option = null,
    // SSRF verdict resolver for connection CRUD input validation. Defaults to
    // the real DNS-resolving validator; tests inject a stub.
    safeUpstreamValidator = null,
  } = dependencies;

  const projectCatalogV1 = resolveProjectCatalogV1(projectCatalogV1Option);

  await fsPromises.mkdir(openchamberDataDir, { recursive: true });

  const catalogStore = createCatalogStore({
    fs: fsPromises,
    path,
    filePath: path.join(openchamberDataDir, 'project-catalog.json'),
  });
  await catalogStore.load().catch((error) => {
    // A corrupt catalog must surface loudly at startup (recovery state is
    // tracked for diagnostics); it must never masquerade as an empty catalog.
    console.error('[projects] catalog load failed:', error?.message ?? error);
  });

  const profileStore = createConnectionProfileStore({
    fs: fsPromises,
    filePath: path.join(openchamberDataDir, 'connection-profiles.json'),
  });
  await profileStore.load().catch((error) => {
    if (error?.code === 'connection_profiles_corrupt') {
      console.error('[projects] connection profiles corrupt; rebuilt local connection only:', error?.message ?? error);
    } else {
      console.error('[projects] connection profiles load failed:', error?.message ?? error);
    }
  });

  const localAdapter = createLocalProjectAdapter({
    fs: fsPromises,
    path,
    normalizeDirectoryPath,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    fetchImpl: typeof fetch === 'function' ? fetch : null,
  });

  const connectionBroker = createConnectionBroker({ profileStore });

  /** Seeds a private profile record for an injected adapter (Electron SSH) so
   * the catalog can resolve it. The record carries only the opaque
   * sshInstanceId, never tunnel URLs or keys. Idempotent: an existing profile
   * is left untouched (labels are updated through the connection API, never
   * by re-injection). */
  const seedInjectedAdapterProfile = async (adapter) => {
    const existing = await profileStore.getPrivateRecord(adapter.connectionId).catch(() => null);
    if (existing) return false;
    await profileStore.upsertConnection({
      id: adapter.connectionId,
      label: adapter.label ?? adapter.connectionId,
      target: { kind: 'ssh', sshInstanceId: adapter.sshInstanceId ?? adapter.connectionId },
    });
    return true;
  };

  connectionBroker.registerAdapter(localAdapter);
  for (const adapter of injectedAdapters) {
    if (!adapter || typeof adapter.connectionId !== 'string') {
      console.error('[projects] skipping invalid injected adapter');
      continue;
    }
    connectionBroker.registerAdapter(adapter);
    await seedInjectedAdapterProfile(adapter).catch((error) => {
      console.error(`[projects] failed to seed profile for ${adapter.connectionId}:`, error?.message ?? error);
    });
  }

  /** Registers one adapter per saved profile kind owned by this runtime and
   * unregisters only those managed adapters whose profile was deleted or
   * changed. Injected adapters (notably Electron SSH) remain broker-owned and
   * are never swept by profile synchronization. Returns the connection ids
   * that were unregistered (deleted profiles) and re-registered (kind
   * changes) so callers can reconcile the session index observers. */
  const syncProfileAdapters = async () => {
    const profiles = await profileStore.listPrivateRecords();
    const managed = new Map();
    const removed = [];
    const replaced = [];
    const added = [];
    for (const profile of profiles) {
      const kind = profile.target?.kind;
      if (kind === 'local') continue;
      // Every non-local profile is "managed" for sweep purposes (direct,
      // relay and seeded ssh alike): the sweep below must never unregister an
      // adapter whose profile still exists. Only direct/relay adapters are
      // constructed here; injected adapters (Electron SSH) are broker-owned
      // and registered through `registerInjectedAdapter`.
      managed.set(profile.id, kind);
      if (kind !== 'direct' && kind !== 'relay') continue;
      // A relay adapter needs a server-side credential provider. Keeping the
      // profile visible while leaving the adapter unavailable makes the
      // capability state truthful in headless runtimes that do not own relay
      // credentials.
      if (kind === 'relay' && !credentialProvider) continue;
      if (!connectionBroker.hasAdapter(profile.id)) {
        const adapter = kind === 'relay'
          ? createRelayProjectAdapter({ connectionId: profile.id })
          : createDirectProjectAdapter({
            connectionId: profile.id,
            fetchImpl: typeof fetch === 'function' ? fetch : null,
            targetUrl: profile.target?.baseUrl ?? null,
          });
        connectionBroker.registerAdapter(adapter);
        added.push(profile.id);
        continue;
      }
      const existing = connectionBroker.getAdapter(profile.id);
      // A changed direct target URL must replace the adapter (and thereby
      // restart the observer's event stream): the stream is bound to the URL
      // captured when it opened, so leaving it running would keep receiving
      // events from the old server. Adapters created without a targetUrl
      // (injected) never match the swap condition.
      const targetChanged = kind === 'direct'
        && typeof existing?.targetUrl === 'string'
        && existing.targetUrl !== profile.target?.baseUrl;
      if (existing?.kind !== kind || targetChanged) {
        await connectionBroker.unregisterAdapter(profile.id);
        const adapter = kind === 'relay'
          ? createRelayProjectAdapter({ connectionId: profile.id })
          : createDirectProjectAdapter({
            connectionId: profile.id,
            fetchImpl: typeof fetch === 'function' ? fetch : null,
            targetUrl: profile.target?.baseUrl ?? null,
          });
        connectionBroker.registerAdapter(adapter);
        replaced.push(profile.id);
      }
    }
    for (const connectionId of connectionBroker.listConnectionIds()) {
      const adapter = connectionBroker.getAdapter(connectionId);
      if (adapter?.kind !== 'local' && !managed.has(connectionId)) {
        // The profile is gone (deleted via the API) but the adapter is still
        // registered — including injected adapters whose seed profile was
        // removed. Unregister it so the observer cannot retry a phantom
        // connection forever.
        await connectionBroker.unregisterAdapter(connectionId);
        removed.push(connectionId);
      }
    }
    return { removed, replaced, added };
  };

  await syncProfileAdapters().catch((error) => {
    console.error('[projects] profile adapter sync failed:', error?.message ?? error);
  });

  const migration = createLegacyProjectMigration({
    catalogStore,
    localAdapter,
    readSettings,
  });

  const bindingStore = createSessionBindingStore({
    fs: fsPromises,
    path,

    filePath: path.join(openchamberDataDir, 'project-session-bindings.json'),
  });
  await bindingStore.load().catch((error) => {
    console.error('[projects] session bindings load failed:', error?.message ?? error);
  });

  const sessionIndex = createSessionIndex({
    catalogStore,
    profileStore,
    connectionBroker,
    bindingStore,
    credentialProvider,
  });

  /** Reconciles adapters AND session-index observers after a connection
   * profile change: deleted connections stop observing (otherwise the
   * observer retries a disposed adapter forever), kind changes and brand-new
   * connections (re)start their event streams. */
  const onConnectionsChanged = async () => {
    const { removed, replaced, added } = await syncProfileAdapters();
    for (const connectionId of removed) {
      sessionIndex.stopObservingConnection(connectionId);
    }
    for (const connectionId of [...replaced, ...added]) {
      sessionIndex.stopObservingConnection(connectionId);
      void sessionIndex.ensureObserved(connectionId).catch((error) => {
        console.error(`[projects] observer start failed for ${connectionId}:`, error?.message ?? error);
      });
    }
  };

  /** Registers a privileged adapter at runtime (the Electron main process
   * attaching a freshly created SSH instance). Registers the adapter with the
   * broker, seeds its private profile when none exists, and (re)starts the
   * session-index observer — including for connections that were previously
   * unregistered, so a re-created instance comes back with live sessions.
   * The observer start is AWAITED so an unregister racing a still-in-flight
   * observer start cannot leave an observer running against a removed
   * adapter. Returns false (no-op) for invalid adapters. */
  const registerInjectedAdapter = async (adapter) => {
    if (!adapter || typeof adapter.connectionId !== 'string') {
      console.error('[projects] skipping invalid injected adapter');
      return false;
    }
    connectionBroker.registerAdapter(adapter);
    await seedInjectedAdapterProfile(adapter).catch((error) => {
      console.error(`[projects] failed to seed profile for ${adapter.connectionId}:`, error?.message ?? error);
    });
    // Stop-then-ensure is idempotent: a brand-new connection starts observing,
    // a re-registered one is rebound to the current adapter, and a duplicate
    // registration only restarts the same connection's stream.
    sessionIndex.stopObservingConnection(adapter.connectionId);
    await sessionIndex.ensureObserved(adapter.connectionId).catch((error) => {
      console.error(`[projects] observer start failed for ${adapter.connectionId}:`, error?.message ?? error);
    });
    return true;
  };

  /** Detaches a privileged adapter at runtime (the Electron main process
   * removing an SSH instance). Unregisters the adapter from the broker and
   * stops its session-index observer so it never retries a missing adapter.
   * The saved profile is deliberately KEPT: catalog projects stay
   * resolvable and the connection stays visible as offline; deleting the
   * profile (and its 409 in-use guard) is the user-facing connection delete
   * path, never an instance-removal side effect. */
  const unregisterInjectedAdapter = async (connectionId) => {
    const removed = await connectionBroker.unregisterAdapter(connectionId);
    sessionIndex.stopObservingConnection(connectionId);
    return removed;
  };

  const registerRoutes = (app) => {
    // Diagnostics/capabilities reads register FIRST: `GET
    // /api/projects/diagnostics` must beat the later
    // `GET /api/projects/:projectId` param route (Express matches in
    // registration order), and the flag must be readable in every state.
    registerProjectDiagnosticsRoutes(app, { getDiagnostics });
    registerProjectCatalogRoutes(app, {
      catalogStore,
      connectionBroker,
      profileStore,
      credentialProvider,
      onConnectionsChanged,
      projectCatalogV1,
      sessionBindingStore: bindingStore,
      safeUpstreamValidator,
    });
    if (projectCatalogV1 === false) {
      // Disabled mode (§20): the project runtime proxy and the session
      // index mutation routes are replaced by explicit capability gates
      // (501 `capability_unavailable`), matching the sendError convention of
      // routes.js. Reads — catalog snapshot, browse, probes, capabilities,
      // diagnostics and the session-index snapshot/SSE — stay available, and
      // the catalog data files are never touched. The gates are registered
      // before the session-index routes below so the later real handlers
      // (and the generic OpenCode proxy) never see these mutations.
      const sendCapabilityUnavailable = (_req, res) => {
        res.status(501).json({ error: 'The project catalog is disabled on this server', code: 'capability_unavailable' });
      };
      app.all('/api/projects/:projectId/runtime', sendCapabilityUnavailable);
      app.use('/api/projects/:projectId/runtime', sendCapabilityUnavailable);
      app.post('/api/projects/:projectId/sessions', sendCapabilityUnavailable);
      app.post('/api/projects/:projectId/sessions/:sessionId/bind', sendCapabilityUnavailable);
    } else {
      registerProjectRuntimeProxyRoutes(app, {
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
      console.error('[projects] session index initial refresh failed:', error?.message ?? error);
      return {};
    });
    const records = await profileStore.listPrivateRecords().catch(() => []);
    for (const record of records) {
      void sessionIndex.ensureObserved(record.id).catch((error) => {
        console.error(`[projects] observer start failed for ${record.id}:`, error?.message ?? error);
      });
      // Boot-time best-effort probe of saved direct/relay connections: a
      // successful probe records `lastProbeOkAt` so a server that ever
      // connected stays visibly "connected before" until the next probe.
      // Never blocks startup and never throws; the disabled state is a read
      // gate that must not touch the profile file.
      if (projectCatalogV1 === false) continue;
      const kind = record.target?.kind;
      if (kind !== 'direct' && kind !== 'relay') continue;
      if (kind === 'relay' && !credentialProvider) continue;
      void (async () => {
        try {
          const adapter = connectionBroker.getAdapter(record.id);
          if (!adapter || typeof adapter.probe !== 'function') return;
          const probe = await adapter.probe({ profile: record, credentialProvider }, null);
          if (probe?.ok) {
            await profileStore.recordProbeSuccess(record.id, Date.now());
          }
        } catch (error) {
          console.error(`[projects] boot probe failed for ${record.id}:`, error?.message ?? error);
        }
      })();
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
    capabilities: { projectCatalogV1 },
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
    registerInjectedAdapter,
    unregisterInjectedAdapter,
    getDiagnostics,
    dispose,
  };
};
