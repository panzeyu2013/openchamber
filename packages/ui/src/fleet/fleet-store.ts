import { create } from 'zustand';
import { getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { useFleetLiveStore } from './fleet-live-store';
import { probeFleetServer } from './fleet-probe';
import type { FleetServer, FleetServerStatus } from './types';

type FleetState = {
  servers: Map<string, FleetServer>;
  activeServerId: string;
  upsertServer: (server: FleetServer) => void;
  replaceServers: (servers: FleetServer[]) => void;
  removeServer: (serverId: string) => void;
  updateServerStatus: (serverId: string, status: FleetServerStatus, errorMessage?: string) => void;
  probeAndActivateServer: (serverId: string) => Promise<boolean>;
  syncActiveServer: () => void;
};

const sameServer = (left: FleetServer, right: FleetServer): boolean =>
  left === right || (
    left.id === right.id
    && left.label === right.label
    && left.kind === right.kind
    && left.status === right.status
    && left.errorMessage === right.errorMessage
    && left.lastSuccessAt === right.lastSuccessAt
    && left.descriptor.apiBaseUrl === right.descriptor.apiBaseUrl
    && left.descriptor.runtimeKey === right.descriptor.runtimeKey
    && left.descriptor.clientToken === right.descriptor.clientToken
    && left.descriptor.requestHeaders === right.descriptor.requestHeaders
    && left.descriptor.relay === right.descriptor.relay
  );

/**
 * Fleet is intentionally separate from the Active Runtime sync stores. It
 * owns only server descriptors/lifecycle state; selecting a server delegates
 * all detailed state reset and reconnection to runtime-switch.
 */
export const useFleetStore = create<FleetState>()((set, get) => ({
  servers: new Map(),
  activeServerId: 'local',
  upsertServer: (server) => set((state) => {
    const current = state.servers.get(server.id);
    if (current && sameServer(current, server)) return state;
    const servers = new Map(state.servers);
    servers.set(server.id, server);
    return { servers };
  }),
  replaceServers: (servers) => set((state) => {
    const next = new Map(servers.map((server) => [server.id, server]));
    if (state.servers.size === next.size && [...state.servers.entries()].every(([id, server]) => {
      const nextServer = next.get(id);
      return nextServer ? sameServer(nextServer, server) : false;
    })) {
      return state;
    }
    return { servers: next, activeServerId: next.has(state.activeServerId) ? state.activeServerId : 'local' };
  }),
  removeServer: (serverId) => set((state) => {
    if (serverId === 'local' || !state.servers.has(serverId)) return state;
    const servers = new Map(state.servers);
    servers.delete(serverId);
    return { servers, activeServerId: state.activeServerId === serverId ? 'local' : state.activeServerId };
  }),
  updateServerStatus: (serverId, status, errorMessage) => set((state) => {
    const current = state.servers.get(serverId);
    if (!current) return state;
    if (current.status === status && current.errorMessage === errorMessage) return state;
    const servers = new Map(state.servers);
    servers.set(serverId, {
      ...current,
      status,
      errorMessage,
      ...(status === 'connected' ? { lastSuccessAt: Date.now() } : {}),
    });
    return { servers };
  }),
  /**
   * Activates a Fleet server as the single Active Runtime, with the same
   * validation the Host Switcher applies before a switch: an unverified
   * server is probed (direct HTTP or the E2EE relay) and the runtime is only
   * switched on a usable result. A failed probe leaves the current runtime
   * and the target server's transient Fleet state fully intact — no switch,
   * no snapshot clearing — and marks the server failed so the sidebar shows
   * why. Rows the observation loop already verified (status 'connected') take
   * the fast path, matching the Host Switcher's cached-ok behavior.
   */
  probeAndActivateServer: async (serverId) => {
    const server = get().servers.get(serverId);
    if (!server) return false;
    if (get().activeServerId === serverId) return true;
    if (server.status === 'connecting') return false;

    if (server.status !== 'connected') {
      get().updateServerStatus(serverId, 'connecting');
      const probe = await probeFleetServer(server).catch(() => null);
      const current = get().servers.get(serverId);
      if (!current) return false;
      if (!probe) {
        get().updateServerStatus(serverId, 'error', 'Unable to verify the server');
        return false;
      }
      if (probe.status === 'unreachable' || probe.status === 'wrong-service' || probe.status === 'incompatible') {
        get().updateServerStatus(serverId, 'error', probe.status === 'unreachable'
          ? 'Host is unreachable'
          : (probe.status === 'wrong-service' ? 'Endpoint is not an OpenChamber server' : 'Server version is incompatible'));
        return false;
      }
      // Reachable and authenticated (or auth-gated, which the session auth
      // gate resolves after the switch) — mark connected and proceed.
      get().updateServerStatus(serverId, 'connected');
    }

    const verified = get().servers.get(serverId);
    if (!verified) return false;
    if (getRuntimeKey() !== verified.descriptor.runtimeKey) {
      switchRuntimeEndpoint(verified.descriptor);
    }
    // The active runtime immediately becomes the only full synchronization
    // authority. Its former Fleet hint must not survive as a competing status.
    useFleetLiveStore.getState().clearServer(serverId);
    set((state) => state.activeServerId === serverId ? state : { activeServerId: serverId });
    return true;
  },
  syncActiveServer: () => set((state) => {
    const runtimeKey = getRuntimeKey();
    const active = [...state.servers.values()].find((server) => server.descriptor.runtimeKey === runtimeKey)?.id ?? 'local';
    return active === state.activeServerId ? state : { activeServerId: active };
  }),
}));
