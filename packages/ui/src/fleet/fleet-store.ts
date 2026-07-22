import { create } from 'zustand';
import { getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { useFleetLiveStore } from './fleet-live-store';
import type { FleetServer, FleetServerStatus } from './types';

type FleetState = {
  servers: Map<string, FleetServer>;
  activeServerId: string;
  upsertServer: (server: FleetServer) => void;
  removeServer: (serverId: string) => void;
  updateServerStatus: (serverId: string, status: FleetServerStatus, errorMessage?: string) => void;
  activateServer: (serverId: string) => boolean;
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
  activateServer: (serverId) => {
    const server = get().servers.get(serverId);
    if (!server) return false;
    if (getRuntimeKey() !== server.descriptor.runtimeKey) {
      switchRuntimeEndpoint(server.descriptor);
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
