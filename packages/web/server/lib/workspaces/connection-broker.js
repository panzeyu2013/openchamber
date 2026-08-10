/**
 * Connection Broker.
 *
 * Resolves a connectionId to its adapter and manages connection lifecycle:
 * - Catalog presence never implies an open tunnel/stream.
 * - Adapters are registered by connectionId (the `local` adapter is always
 *   registered; Direct/Relay/SSH adapters are registered by later phases and
 *   by the Electron main-process injection).
 * - Leases: a Session Index or an active WorkspaceRuntimeHandle acquires a
 *   lease; the last release enters a bounded idle grace period before
 *   `dispose()` is called on the adapter's connection state.
 * - One connection failing never affects other connections.
 *
 * Phase 1: registry + leases + probe routing. Phase 2 adds the
 * workspace-prefixed HTTP/SSE/WS forwarding through `adapter.fetch`,
 * `adapter.openEventStream`, `adapter.openWebSocket`.
 */

export const createConnectionBroker = (dependencies = {}) => {
  const {
    profileStore,
    idleGraceMs = 15_000,
    logger = null,
  } = dependencies;

  /** @type {Map<string, object>} adapter by connectionId */
  const adapters = new Map();

  /** @type {Map<string, { leaseCount: number, idleTimer: ReturnType<typeof setTimeout> | null, lastReleasedAt: number }>} */
  const lifecycle = new Map();

  const log = (message, detail) => {
    logger?.log?.(`[workspaces:broker] ${message}`, detail ?? '');
  };

  const registerAdapter = (adapter) => {
    if (!adapter || typeof adapter.connectionId !== 'string') {
      throw new Error('adapter must expose a connectionId');
    }
    adapters.set(adapter.connectionId, adapter);
    if (!lifecycle.has(adapter.connectionId)) {
      lifecycle.set(adapter.connectionId, { leaseCount: 0, idleTimer: null, lastReleasedAt: 0 });
    }
  };

  const listConnectionIds = () => [...adapters.keys()];

  const hasAdapter = (connectionId) => adapters.has(connectionId);

  const getAdapter = (connectionId) => adapters.get(connectionId) ?? null;

  /** Removes a connection adapter (profile deleted). Pending idle timers are
   * cleared; a lease count above zero forces disposal of the adapter state. */
  const unregisterAdapter = async (connectionId) => {
    const adapter = adapters.get(connectionId);
    if (!adapter) return false;
    const entry = lifecycle.get(connectionId);
    clearIdleTimer(connectionId);
    if (entry && entry.leaseCount > 0 && adapter?.dispose) {
      await adapter.dispose().catch((error) => log('dispose failed', `${connectionId}: ${error?.message ?? error}`));
    }
    adapters.delete(connectionId);
    lifecycle.delete(connectionId);
    return true;
  };

  const clearIdleTimer = (connectionId) => {
    const entry = lifecycle.get(connectionId);
    if (entry?.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  };

  /** Acquires a lease; the first lease starts connection work (Phase 2 wires
   * the adapter's connect() here). Returns a release function. */
  const acquireLease = (connectionId) => {
    if (!adapters.has(connectionId)) return null;
    const entry = lifecycle.get(connectionId);
    clearIdleTimer(connectionId);
    entry.leaseCount += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.leaseCount = Math.max(0, entry.leaseCount - 1);
      entry.lastReleasedAt = Date.now();
      if (entry.leaseCount === 0) {
        entry.idleTimer = setTimeout(() => {
          entry.idleTimer = null;
          if (lifecycle.get(connectionId)?.leaseCount === 0) {
            const adapter = adapters.get(connectionId);
            if (adapter?.dispose) {
              log('connection idle: disposing', connectionId);
              void adapter.dispose().catch((error) => log('dispose failed', `${connectionId}: ${error?.message ?? error}`));
            }
          }
        }, idleGraceMs);
      }
    };
  };

  const getLifecycleState = (connectionId) => {
    const entry = lifecycle.get(connectionId);
    if (!entry) return { state: 'idle', leaseCount: 0 };
    return {
      state: entry.leaseCount > 0 ? 'ready' : (entry.idleTimer ? 'backoff' : 'idle'),
      leaseCount: entry.leaseCount,
      lastReleasedAt: entry.lastReleasedAt,
    };
  };

  const resolveConnection = async (connectionId) => {
    const adapter = adapters.get(connectionId) ?? null;
    let profile = null;
    if (profileStore) {
      profile = await profileStore.getPrivateRecord(connectionId);
    }
    if (!adapter || !profile) return null;
    return { profile, adapter };
  };

  const dispose = async () => {
    for (const [connectionId, entry] of lifecycle) {
      const hasPendingIdleDisposal = entry.idleTimer !== null && entry.leaseCount === 0;
      clearIdleTimer(connectionId);
      // Dispose immediately even when the lease already hit zero and only the
      // idle timer remained: that timer was the scheduled disposal itself.
      if (entry.leaseCount > 0 || hasPendingIdleDisposal) {
        const adapter = adapters.get(connectionId);
        if (adapter?.dispose) {
          await adapter.dispose().catch((error) => log('dispose failed', `${connectionId}: ${error?.message ?? error}`));
        }
      }
    }
    lifecycle.clear();
  };

  return {
    registerAdapter,
    unregisterAdapter,
    listConnectionIds,
    hasAdapter,
    getAdapter,
    acquireLease,
    getLifecycleState,
    resolveConnection,
    dispose,
  };
};
