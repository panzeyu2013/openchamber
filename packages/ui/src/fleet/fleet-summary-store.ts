import { create } from 'zustand';
import { fleetSessionKey, type FleetServerSummary, type FleetSessionSummary } from './types';

type FleetSummaryState = {
  servers: Map<string, FleetServerSummary>;
  replaceServerSummary: (serverId: string, sessions: FleetSessionSummary[], refreshedAt?: number) => void;
  markServerFailed: (serverId: string, errorMessage: string) => void;
  removeSession: (serverId: string, sessionId: string) => void;
  removeServer: (serverId: string) => void;
};

const summariesEqual = (left: Map<string, FleetSessionSummary>, right: Map<string, FleetSessionSummary>): boolean => {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    const next = right.get(key);
    if (!next || next.title !== value.title || next.directory !== value.directory || next.updatedAt !== value.updatedAt || next.archived !== value.archived) {
      return false;
    }
  }
  return true;
};

/**
 * Authoritative summary snapshots are replaced only on successful fetches.
 * A failed request keeps the prior list intact and marks it incomplete, which
 * prevents a transient network failure from rendering as an empty server.
 */
export const useFleetSummaryStore = create<FleetSummaryState>()((set) => ({
  servers: new Map(),
  replaceServerSummary: (serverId, sessions, refreshedAt = Date.now()) => set((state) => {
    const nextSessions = new Map(sessions.map((session) => [fleetSessionKey(serverId, session.sessionId), session]));
    const previous = state.servers.get(serverId);
    if (previous && previous.complete && !previous.errorMessage && summariesEqual(previous.sessions, nextSessions)) {
      const servers = new Map(state.servers);
      servers.set(serverId, { ...previous, refreshedAt });
      return { servers };
    }
    const servers = new Map(state.servers);
    servers.set(serverId, { serverId, sessions: nextSessions, complete: true, refreshedAt });
    return { servers };
  }),
  markServerFailed: (serverId, errorMessage) => set((state) => {
    const previous = state.servers.get(serverId);
    const next: FleetServerSummary = previous
      ? { ...previous, complete: false, errorMessage }
      : { serverId, sessions: new Map(), complete: false, errorMessage };
    if (previous === next) return state;
    const servers = new Map(state.servers);
    servers.set(serverId, next);
    return { servers };
  }),
  removeSession: (serverId, sessionId) => set((state) => {
    const previous = state.servers.get(serverId);
    const key = fleetSessionKey(serverId, sessionId);
    if (!previous?.sessions.has(key)) return state;
    const servers = new Map(state.servers);
    const sessions = new Map(previous.sessions);
    sessions.delete(key);
    servers.set(serverId, { ...previous, sessions });
    return { servers };
  }),
  removeServer: (serverId) => set((state) => {
    if (!state.servers.has(serverId)) return state;
    const servers = new Map(state.servers);
    servers.delete(serverId);
    return { servers };
  }),
}));
