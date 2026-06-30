import { create } from 'zustand';
import { getDeferredSafeStorage } from './utils/safeStorage';

const SESSION_PINNED_STORAGE_KEY = 'oc.sessions.pinned';

type PersistedMap = Record<string, string[]>;

const readPinned = (storage: Storage): Map<string, Set<string>> => {
  try {
    const raw = storage.getItem(SESSION_PINNED_STORAGE_KEY);
    if (!raw) return new Map([['local', new Set()]]);
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      const localSet = new Set(parsed.filter((item): item is string => typeof item === 'string'));
      return new Map([['local', localSet]]);
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const map = new Map<string, Set<string>>();
      for (const [serverId, ids] of Object.entries(parsed as PersistedMap)) {
        if (Array.isArray(ids)) {
          map.set(serverId, new Set(ids.filter((item): item is string => typeof item === 'string')));
        }
      }
      return map;
    }
    return new Map([['local', new Set()]]);
  } catch {
    return new Map([['local', new Set()]]);
  }
};

const serializeMap = (map: Map<string, Set<string>>): PersistedMap => {
  const obj: PersistedMap = {};
  for (const [serverId, ids] of map) {
    obj[serverId] = [...ids];
  }
  return obj;
};

const persistPinned = (storage: Storage, map: Map<string, Set<string>>): void => {
  try {
    storage.setItem(SESSION_PINNED_STORAGE_KEY, JSON.stringify(serializeMap(map)));
  } catch {
    // ignore
  }
};

const flattenAll = (map: Map<string, Set<string>>): Set<string> => {
  const result = new Set<string>();
  for (const ids of map.values()) {
    for (const id of ids) {
      result.add(id);
    }
  }
  return result;
};

type SessionPinnedStore = {
  idsByServer: Map<string, Set<string>>;
  ids: Set<string>;
  setIds: (next: Set<string> | ((prev: Set<string>) => Set<string>), serverId?: string) => void;
  toggle: (sessionId: string, serverId?: string | null) => void;
  isPinned: (sessionId: string) => boolean;
  getAllPinned: () => Array<{ sessionId: string; serverId: string }>;
  removeAllForServer: (serverId: string) => void;
};

const safeStorage = getDeferredSafeStorage();

export const useSessionPinnedStore = create<SessionPinnedStore>((set, get) => {
  const initial = readPinned(safeStorage);

  return {
    idsByServer: initial,
    ids: flattenAll(initial),

    setIds: (next, serverId) => {
      const resolvedServerId = serverId || 'local';
      const current = get().idsByServer;
      const serverSet = new Set(current.get(resolvedServerId) ?? []);
      const resolved = typeof next === 'function' ? next(new Set(serverSet)) : next;
      if (resolved === serverSet) return;
      const nextMap = new Map(current);
      nextMap.set(resolvedServerId, resolved);
      set({ idsByServer: nextMap, ids: flattenAll(nextMap) });
      persistPinned(safeStorage, nextMap);
    },

    toggle: (sessionId, serverId) => {
      const resolvedServerId = serverId || 'local';
      const current = get().idsByServer;
      const serverSet = new Set(current.get(resolvedServerId) ?? []);
      if (serverSet.has(sessionId)) {
        serverSet.delete(sessionId);
      } else {
        serverSet.add(sessionId);
      }
      const nextMap = new Map(current);
      nextMap.set(resolvedServerId, serverSet);
      set({ idsByServer: nextMap, ids: flattenAll(nextMap) });
      persistPinned(safeStorage, nextMap);
    },

    isPinned: (sessionId) => {
      for (const ids of get().idsByServer.values()) {
        if (ids.has(sessionId)) return true;
      }
      return false;
    },

    getAllPinned: () => {
      const result: Array<{ sessionId: string; serverId: string }> = [];
      for (const [serverId, ids] of get().idsByServer) {
        for (const sessionId of ids) {
          result.push({ sessionId, serverId });
        }
      }
      return result;
    },

    removeAllForServer: (serverId) => {
      const current = get().idsByServer;
      if (!current.has(serverId)) return;
      const nextMap = new Map(current);
      nextMap.delete(serverId);
      set({ idsByServer: nextMap, ids: flattenAll(nextMap) });
      persistPinned(safeStorage, nextMap);
    },
  };
});
