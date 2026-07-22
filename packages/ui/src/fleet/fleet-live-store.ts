import { create } from 'zustand';
import { fleetSessionKey, type FleetLiveSessionState, type FleetSessionActivity } from './types';

type FleetLiveState = {
  sessions: Map<string, FleetLiveSessionState>;
  applySessionState: (input: Omit<FleetLiveSessionState, 'updatedAt' | 'stale'> & { updatedAt?: number }) => void;
  markServerStale: (serverId: string) => void;
  removeSession: (serverId: string, sessionId: string) => void;
  removeServer: (serverId: string) => void;
  clearServer: (serverId: string) => void;
};

const sameState = (left: FleetLiveSessionState, right: FleetLiveSessionState): boolean =>
  left.activity === right.activity
  && left.hasPendingPermission === right.hasPendingPermission
  && left.hasPendingQuestion === right.hasPendingQuestion
  && left.stale === right.stale
  && left.updatedAt === right.updatedAt;

/**
 * Side-channel state for non-active runtimes. It is never a source of message,
 * permission payload, or session-list truth; opening a session always resets
 * through the active runtime and retrieves authoritative state there.
 */
export const useFleetLiveStore = create<FleetLiveState>()((set) => ({
  sessions: new Map(),
  applySessionState: (input) => set((state) => {
    const key = fleetSessionKey(input.serverId, input.sessionId);
    const previous = state.sessions.get(key);
    const next: FleetLiveSessionState = {
      ...input,
      updatedAt: input.updatedAt ?? Date.now(),
      stale: false,
    };
    // Late events cannot overwrite a newer observation for the same server.
    if (previous && previous.updatedAt > next.updatedAt) return state;
    if (previous && sameState(previous, next)) return state;
    const sessions = new Map(state.sessions);
    sessions.set(key, next);
    return { sessions };
  }),
  markServerStale: (serverId) => set((state) => {
    let changed = false;
    const sessions = new Map(state.sessions);
    for (const [key, value] of sessions) {
      if (value.serverId !== serverId || value.stale) continue;
      sessions.set(key, { ...value, stale: true });
      changed = true;
    }
    return changed ? { sessions } : state;
  }),
  removeSession: (serverId, sessionId) => set((state) => {
    const key = fleetSessionKey(serverId, sessionId);
    if (!state.sessions.has(key)) return state;
    const sessions = new Map(state.sessions);
    sessions.delete(key);
    return { sessions };
  }),
  removeServer: (serverId) => set((state) => {
    const sessions = new Map(state.sessions);
    for (const [key, value] of sessions) {
      if (value.serverId === serverId) sessions.delete(key);
    }
    return sessions.size === state.sessions.size ? state : { sessions };
  }),
  clearServer: (serverId) => set((state) => {
    const sessions = new Map(state.sessions);
    for (const [key, value] of sessions) {
      if (value.serverId === serverId) sessions.delete(key);
    }
    return sessions.size === state.sessions.size ? state : { sessions };
  }),
}));

export const fleetActivityFromSessionStatus = (value: unknown): FleetSessionActivity => {
  if (value === 'busy' || value === 'retry' || value === 'error') return value;
  return 'idle';
};
