import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { getDeferredSafeStorage, getSafeStorage } from './utils/safeStorage';
import { isVSCodeRuntime } from '@/lib/desktop';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { resolveSessionScopeKey } from '@/sync/selection-store';

// --- Types ---

export interface SessionFolder {
  id: string;
  name: string;
  sessionIds: string[];
  createdAt: number;
  /** If set, this folder is a sub-folder of the parent folder with this id */
  parentId?: string | null;
}

export type SessionFoldersMap = Record<string, SessionFolder[]>;

interface SessionFoldersState {
  foldersMap: SessionFoldersMap;
  collapsedFolderIds: Set<string>;
}

interface SessionFoldersActions {
  getFoldersForScope: (scopeKey: string) => SessionFolder[];
  createFolder: (scopeKey: string, name: string, parentId?: string | null) => SessionFolder;
  renameFolder: (scopeKey: string, folderId: string, name: string) => void;
  deleteFolder: (scopeKey: string, folderId: string) => void;
  addSessionToFolder: (scopeKey: string, folderId: string, sessionId: string) => void;
  addSessionsToFolder: (scopeKey: string, folderId: string, sessionIds: string[]) => void;
  removeSessionFromFolder: (scopeKey: string, sessionId: string) => void;
  removeSessionEverywhere: (scopeKey: string, sessionId: string) => void;
  removeSessionsFromFolders: (scopeKey: string, sessionIds: string[]) => void;
  toggleFolderCollapse: (folderId: string) => void;
  getSessionFolderId: (scopeKey: string, sessionId: string) => string | null;
  /** Switches the active persisted bucket to the given scope key (workspace
   * scope for workspace sessions, ambient runtime key otherwise). */
  activateScope: (scopeKey: string) => void;
  /** Legacy runtime-switch entrypoint; delegates to activateScope. */
  resetForRuntimeSwitch: (runtimeKey: string) => void;
}

type SessionFoldersStore = SessionFoldersState & SessionFoldersActions;

// --- Storage ---

const FOLDERS_STORAGE_KEY = 'oc.sessions.folders';
const COLLAPSED_STORAGE_KEY = 'oc.sessions.folderCollapse';
const STORAGE_INDEX_KEY = 'oc.sessions.folders.v2.index';
const SESSION_FOLDERS_API_PATH = '/api/session-folders';
const DISK_WRITE_DEBOUNCE_MS = 250;

const safeStorage = getDeferredSafeStorage();
const immediateSafeStorage = getSafeStorage();
let diskWriteTimer: ReturnType<typeof setTimeout> | null = null;
let diskHydrated = false;
let diskHydrationInFlight = false;
let persistFoldersTimer: ReturnType<typeof setTimeout> | undefined;
let persistCollapsedTimer: ReturnType<typeof setTimeout> | undefined;
let pendingFoldersMap: SessionFoldersMap | null = null;
let pendingCollapsedIds: Set<string> | null = null;
let pendingBrowserScopeKey: string | null = null;
let activeFolderScopeKey = getRuntimeKey();
let folderRuntimeGeneration = 0;
let folderMutationRevision = 0;
const lastDiskUpdatedAtByScope = new Map<string, number>();

/** Active persisted bucket for the folders store: the workspace scope when a
 * workspace session is current, the ambient runtime key otherwise. */
export const getActiveFolderScopeKey = (): string => activeFolderScopeKey;

type FolderStorageIndex = {
  version: 2;
  legacyClaimed: boolean;
  runtimes: Array<{ runtimeKey: string; updatedAt: number }>;
};

const runtimeStorageKey = (base: string, scopeKey: string) => `${base}.v2:${encodeURIComponent(scopeKey)}`;
const readStorageIndex = (): FolderStorageIndex => {
  try {
    const parsed = JSON.parse(safeStorage.getItem(STORAGE_INDEX_KEY) ?? '') as Partial<FolderStorageIndex>;
    return parsed.version === 2 && Array.isArray(parsed.runtimes)
      ? { version: 2, legacyClaimed: Boolean(parsed.legacyClaimed), runtimes: parsed.runtimes }
      : { version: 2, legacyClaimed: false, runtimes: [] };
  } catch {
    return { version: 2, legacyClaimed: false, runtimes: [] };
  }
};

const touchRuntimeStorage = (scopeKey: string, updatedAt = Date.now(), targetStorage: Storage = safeStorage): void => {
  const index = readStorageIndex();
  const runtimes = [
    { runtimeKey: scopeKey, updatedAt },
    ...index.runtimes.filter((entry) => entry.runtimeKey !== scopeKey),
  ];
  targetStorage.setItem(STORAGE_INDEX_KEY, JSON.stringify({ version: 2, legacyClaimed: index.legacyClaimed, runtimes }));
};

const claimLegacyStorage = (scopeKey: string): void => {
  const index = readStorageIndex();
  if (index.legacyClaimed) return;
  const legacyFolders = safeStorage.getItem(FOLDERS_STORAGE_KEY);
  const legacyCollapsed = safeStorage.getItem(COLLAPSED_STORAGE_KEY);
  if (legacyFolders) safeStorage.setItem(runtimeStorageKey(FOLDERS_STORAGE_KEY, scopeKey), legacyFolders);
  if (legacyCollapsed) safeStorage.setItem(runtimeStorageKey(COLLAPSED_STORAGE_KEY, scopeKey), legacyCollapsed);
  const next = { ...index, legacyClaimed: true };
  safeStorage.setItem(STORAGE_INDEX_KEY, JSON.stringify(next));
  if (safeStorage.getItem(STORAGE_INDEX_KEY) === JSON.stringify(next)) {
    safeStorage.removeItem(FOLDERS_STORAGE_KEY);
    safeStorage.removeItem(COLLAPSED_STORAGE_KEY);
  }
  touchRuntimeStorage(scopeKey, 0);
};

const isVSCodeWebview = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }

  if (isVSCodeRuntime()) {
    return true;
  }

  return (window as { __VSCODE_CONFIG__?: unknown }).__VSCODE_CONFIG__ !== undefined;
};

const schedulePersistToDisk = (foldersMap: SessionFoldersMap, collapsedFolderIds: Set<string>): void => {
  if (typeof window === 'undefined') {
    return;
  }

  if (isVSCodeWebview()) {
    return;
  }

  if (diskWriteTimer) {
    clearTimeout(diskWriteTimer);
  }

  const foldersSnapshot = JSON.parse(JSON.stringify(foldersMap)) as SessionFoldersMap;
  const collapsedSnapshot = Array.from(collapsedFolderIds);
  const scopeKey = activeFolderScopeKey;
  const generation = folderRuntimeGeneration;

  diskWriteTimer = setTimeout(() => {
    diskWriteTimer = null;
    if (scopeKey !== activeFolderScopeKey || generation !== folderRuntimeGeneration) return;
    const updatedAt = Math.max(Date.now(), (lastDiskUpdatedAtByScope.get(scopeKey) ?? 0) + 1);
    lastDiskUpdatedAtByScope.set(scopeKey, updatedAt);
    const payload = {
      version: 1,
      foldersMap: foldersSnapshot,
      collapsedFolderIds: collapsedSnapshot,
      updatedAt,
    };
    void runtimeFetch(SESSION_FOLDERS_API_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => { /* best-effort */ });
  }, DISK_WRITE_DEBOUNCE_MS);
};

const readPersistedFolders = (scopeKey = activeFolderScopeKey): SessionFoldersMap => {
  try {
    claimLegacyStorage(scopeKey);
    const parsed = readFoldersBucket(runtimeStorageKey(FOLDERS_STORAGE_KEY, scopeKey))
      ?? readFoldersBucket(runtimeStorageKey(FOLDERS_STORAGE_KEY, getRuntimeKey()));
    return parsed ?? {};
  } catch {
    return {};
  }
};

/** Parses one persisted folder bucket; returns null when absent. Malformed
 * data is a read failure, not authoritative empty success. */
const readFoldersBucket = (storageKey: string): SessionFoldersMap | null => {
  const raw = safeStorage.getItem(storageKey);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const result: SessionFoldersMap = {};
  for (const [scopeKey, value] of Object.entries(parsed)) {
    if (!Array.isArray(value)) {
      continue;
    }
    const folders: SessionFolder[] = [];
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') continue;
      const candidate = entry as Record<string, unknown>;
      const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
      const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
      const createdAt = typeof candidate.createdAt === 'number' ? candidate.createdAt : 0;
      if (!id || !name) continue;
      const sessionIds = Array.isArray(candidate.sessionIds)
        ? (candidate.sessionIds as unknown[]).filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        : [];
      const parentId = typeof candidate.parentId === 'string' ? candidate.parentId : null;
      folders.push({ id, name, sessionIds, createdAt, parentId });
    }
    if (folders.length > 0) {
      result[scopeKey] = folders;
    }
  }
  return result;
};

const readPersistedCollapsed = (scopeKey = activeFolderScopeKey): Set<string> => {
  try {
    claimLegacyStorage(scopeKey);
    const raw = safeStorage.getItem(runtimeStorageKey(COLLAPSED_STORAGE_KEY, scopeKey))
      ?? safeStorage.getItem(runtimeStorageKey(COLLAPSED_STORAGE_KEY, getRuntimeKey()));
    if (!raw) {
      return new Set();
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    return new Set(parsed.filter((v): v is string => typeof v === 'string'));
  } catch {
    return new Set();
  }
};

const persistFolders = (foldersMap: SessionFoldersMap): void => {
  pendingFoldersMap = foldersMap;
  pendingBrowserScopeKey = activeFolderScopeKey;
  clearTimeout(persistFoldersTimer);
  persistFoldersTimer = setTimeout(() => {
    try {
      const scopeKey = pendingBrowserScopeKey ?? activeFolderScopeKey;
      safeStorage.setItem(runtimeStorageKey(FOLDERS_STORAGE_KEY, scopeKey), JSON.stringify(foldersMap));
      touchRuntimeStorage(scopeKey);
      pendingFoldersMap = null;
    } catch {
      // ignored
    }
  }, 300);
};

const persistCollapsed = (collapsedFolderIds: Set<string>): void => {
  pendingCollapsedIds = collapsedFolderIds;
  pendingBrowserScopeKey = activeFolderScopeKey;
  clearTimeout(persistCollapsedTimer);
  persistCollapsedTimer = setTimeout(() => {
    try {
      const scopeKey = pendingBrowserScopeKey ?? activeFolderScopeKey;
      safeStorage.setItem(runtimeStorageKey(COLLAPSED_STORAGE_KEY, scopeKey), JSON.stringify(Array.from(collapsedFolderIds)));
      touchRuntimeStorage(scopeKey);
      pendingCollapsedIds = null;
    } catch {
      // ignored
    }
  }, 300);
};

const flushPendingBrowserPersistence = (): void => {
  if (persistFoldersTimer) clearTimeout(persistFoldersTimer);
  if (persistCollapsedTimer) clearTimeout(persistCollapsedTimer);
  persistFoldersTimer = undefined;
  persistCollapsedTimer = undefined;

  const scopeKey = pendingBrowserScopeKey ?? activeFolderScopeKey;
  let wrote = false;
  if (pendingFoldersMap !== null) {
    const key = runtimeStorageKey(FOLDERS_STORAGE_KEY, scopeKey);
    const value = JSON.stringify(pendingFoldersMap);
    safeStorage.setItem(key, value);
    immediateSafeStorage.setItem(key, value);
    pendingFoldersMap = null;
    wrote = true;
  }
  if (pendingCollapsedIds !== null) {
    const key = runtimeStorageKey(COLLAPSED_STORAGE_KEY, scopeKey);
    const value = JSON.stringify(Array.from(pendingCollapsedIds));
    safeStorage.setItem(key, value);
    immediateSafeStorage.setItem(key, value);
    pendingCollapsedIds = null;
    wrote = true;
  }
  if (wrote) {
    const updatedAt = Date.now();
    touchRuntimeStorage(scopeKey, updatedAt);
    touchRuntimeStorage(scopeKey, updatedAt, immediateSafeStorage);
  }
  pendingBrowserScopeKey = null;
};

if (typeof window !== 'undefined') {
  const flushPending = () => {
    try { flushPendingBrowserPersistence(); } catch { /* ignored */ }
  };
  window.addEventListener('pagehide', flushPending, { capture: true });
  window.addEventListener('beforeunload', flushPending, { capture: true });
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushPending();
    });
    document.addEventListener('freeze', flushPending);
  }
}

const persistState = (foldersMap: SessionFoldersMap, collapsedFolderIds: Set<string>): void => {
  folderMutationRevision += 1;
  persistFolders(foldersMap);
  persistCollapsed(collapsedFolderIds);
  schedulePersistToDisk(foldersMap, collapsedFolderIds);
};

const createFolderId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `folder_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
};

const syncCollapsedAfterFolderCleanup = (
  prevFolders: SessionFolder[],
  nextFolders: SessionFolder[],
  collapsedFolderIds: Set<string>,
): Set<string> | null => {
  const nextFolderIds = new Set(nextFolders.map((folder) => folder.id));
  let nextCollapsed: Set<string> | null = null;

  for (const folder of prevFolders) {
    if (!nextFolderIds.has(folder.id) && collapsedFolderIds.has(folder.id)) {
      if (!nextCollapsed) {
        nextCollapsed = new Set(collapsedFolderIds);
      }
      nextCollapsed.delete(folder.id);
    }
  }

  return nextCollapsed;
};

// --- Store ---

export const useSessionFoldersStore = create<SessionFoldersStore>()(
  devtools(
    (set, get) => ({
      foldersMap: readPersistedFolders(),
      collapsedFolderIds: readPersistedCollapsed(),

      activateScope: (scopeKey: string): void => {
        if (!scopeKey || scopeKey === activeFolderScopeKey) return;
        try { flushPendingBrowserPersistence(); } catch { /* deferred storage retains failed writes */ }
        activeFolderScopeKey = scopeKey;
        folderRuntimeGeneration += 1;
        folderMutationRevision = 0;
        diskHydrated = false;
        diskHydrationInFlight = false;
        if (diskWriteTimer) clearTimeout(diskWriteTimer);
        diskWriteTimer = null;
        set({
          foldersMap: readPersistedFolders(scopeKey),
          collapsedFolderIds: readPersistedCollapsed(scopeKey),
        });
        queueMicrotask(() => void hydrateSessionFoldersFromDisk());
      },

      resetForRuntimeSwitch: (runtimeKey: string): void => {
        get().activateScope(runtimeKey);
      },

      getFoldersForScope: (scopeKey: string): SessionFolder[] => {
        if (!scopeKey) return [];
        return get().foldersMap[scopeKey] ?? [];
      },

      createFolder: (scopeKey: string, name: string, parentId?: string | null): SessionFolder => {
        const trimmed = name.trim() || 'New folder';
        const folder: SessionFolder = {
          id: createFolderId(),
          name: trimmed,
          sessionIds: [],
          createdAt: Date.now(),
          parentId: parentId ?? null,
        };
        const current = get().foldersMap;
        const scopeFolders = current[scopeKey] ?? [];
        const nextMap: SessionFoldersMap = {
          ...current,
          [scopeKey]: [...scopeFolders, folder],
        };
        set({ foldersMap: nextMap });
        persistState(nextMap, get().collapsedFolderIds);
        return folder;
      },

      renameFolder: (scopeKey: string, folderId: string, name: string): void => {
        const trimmed = name.trim();
        if (!trimmed || !scopeKey) return;
        const current = get().foldersMap;
        const scopeFolders = current[scopeKey];
        if (!scopeFolders) return;
        const nextFolders = scopeFolders.map((folder) =>
          folder.id === folderId ? { ...folder, name: trimmed } : folder,
        );
        const nextMap: SessionFoldersMap = { ...current, [scopeKey]: nextFolders };
        set({ foldersMap: nextMap });
        persistState(nextMap, get().collapsedFolderIds);
      },

      deleteFolder: (scopeKey: string, folderId: string): void => {
        if (!scopeKey) return;
        const current = get().foldersMap;
        const scopeFolders = current[scopeKey];
        if (!scopeFolders) return;
        // Also delete all sub-folders of this folder
        const idsToDelete = new Set<string>([folderId]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const f of scopeFolders) {
            if (f.parentId && idsToDelete.has(f.parentId) && !idsToDelete.has(f.id)) {
              idsToDelete.add(f.id);
              changed = true;
            }
          }
        }
        const nextFolders = scopeFolders.filter((folder) => !idsToDelete.has(folder.id));
        const nextMap: SessionFoldersMap = { ...current, [scopeKey]: nextFolders };
        const collapsed = get().collapsedFolderIds;
        const nextCollapsed = syncCollapsedAfterFolderCleanup(scopeFolders, nextFolders, collapsed);
        set(nextCollapsed
          ? { foldersMap: nextMap, collapsedFolderIds: nextCollapsed }
          : { foldersMap: nextMap });
        persistState(nextMap, nextCollapsed ?? collapsed);
      },

      addSessionToFolder: (scopeKey: string, folderId: string, sessionId: string): void => {
        if (!scopeKey || !folderId || !sessionId) return;
        const current = get().foldersMap;
        const scopeFolders = current[scopeKey];
        if (!scopeFolders) return;

        const targetFolder = scopeFolders.find((folder) => folder.id === folderId);
        if (!targetFolder) return;

        const sessionFolderCount = scopeFolders.reduce(
          (count, folder) => count + (folder.sessionIds.includes(sessionId) ? 1 : 0),
          0,
        );
        if (targetFolder.sessionIds.includes(sessionId) && sessionFolderCount === 1) {
          return;
        }

        // Remove session from any existing folder first, then add to target
        const nextFolders = scopeFolders.map((folder) => {
          const withoutSession = folder.sessionIds.filter((id) => id !== sessionId);
          if (folder.id === folderId) {
            return { ...folder, sessionIds: [...withoutSession, sessionId] };
          }
          if (withoutSession.length !== folder.sessionIds.length) {
            return { ...folder, sessionIds: withoutSession };
          }
          return folder;
        });

        const nextMap: SessionFoldersMap = { ...current, [scopeKey]: nextFolders };
        const nextCollapsed = syncCollapsedAfterFolderCleanup(scopeFolders, nextFolders, get().collapsedFolderIds);

        set(nextCollapsed
          ? { foldersMap: nextMap, collapsedFolderIds: nextCollapsed }
          : { foldersMap: nextMap });
        persistState(nextMap, nextCollapsed ?? get().collapsedFolderIds);
      },

      addSessionsToFolder: (scopeKey: string, folderId: string, sessionIds: string[]): void => {
        if (!scopeKey || !folderId || sessionIds.length === 0) return;
        const current = get().foldersMap;
        const scopeFolders = current[scopeKey];
        if (!scopeFolders) return;

        const idSet = new Set(sessionIds.filter((id) => typeof id === 'string' && id.length > 0));
        if (idSet.size === 0) return;

        const targetFolder = scopeFolders.find((folder) => folder.id === folderId);
        if (!targetFolder) return;

        let changed = false;
        for (const folder of scopeFolders) {
          for (const id of idSet) {
            if (!folder.sessionIds.includes(id)) continue;
            if (folder.id !== folderId || !targetFolder.sessionIds.includes(id)) {
              changed = true;
              break;
            }
          }
          if (changed) break;
        }
        if (!changed) {
          for (const id of idSet) {
            if (!targetFolder.sessionIds.includes(id)) {
              changed = true;
              break;
            }
          }
        }
        if (!changed) return;

        const nextFolders = scopeFolders.map((folder) => {
          const withoutSessions = folder.sessionIds.filter((id) => !idSet.has(id));
          if (folder.id === folderId) {
            return { ...folder, sessionIds: [...withoutSessions, ...idSet] };
          }
          if (withoutSessions.length !== folder.sessionIds.length) {
            return { ...folder, sessionIds: withoutSessions };
          }
          return folder;
        });

        const nextMap: SessionFoldersMap = { ...current, [scopeKey]: nextFolders };
        const nextCollapsed = syncCollapsedAfterFolderCleanup(scopeFolders, nextFolders, get().collapsedFolderIds);

        set(nextCollapsed
          ? { foldersMap: nextMap, collapsedFolderIds: nextCollapsed }
          : { foldersMap: nextMap });
        persistState(nextMap, nextCollapsed ?? get().collapsedFolderIds);
      },

      removeSessionsFromFolders: (scopeKey: string, sessionIds: string[]): void => {
        if (!scopeKey || sessionIds.length === 0) return;
        const current = get().foldersMap;
        const scopeFolders = current[scopeKey];
        if (!scopeFolders) return;

        const idSet = new Set(sessionIds.filter((id) => typeof id === 'string' && id.length > 0));
        if (idSet.size === 0) return;

        let changed = false;
        const nextFolders = scopeFolders.map((folder) => {
          const filtered = folder.sessionIds.filter((id) => !idSet.has(id));
          if (filtered.length !== folder.sessionIds.length) {
            changed = true;
            return { ...folder, sessionIds: filtered };
          }
          return folder;
        });

        if (!changed) return;
        const nextMap: SessionFoldersMap = { ...current, [scopeKey]: nextFolders };
        const nextCollapsed = syncCollapsedAfterFolderCleanup(scopeFolders, nextFolders, get().collapsedFolderIds);

        set(nextCollapsed
          ? { foldersMap: nextMap, collapsedFolderIds: nextCollapsed }
          : { foldersMap: nextMap });
        persistState(nextMap, nextCollapsed ?? get().collapsedFolderIds);
      },

      removeSessionFromFolder: (scopeKey: string, sessionId: string): void => {
        if (!scopeKey || !sessionId) return;
        const current = get().foldersMap;
        const scopeFolders = current[scopeKey];
        if (!scopeFolders) return;

        let changed = false;
        const nextFolders = scopeFolders.map((folder) => {
          const filtered = folder.sessionIds.filter((id) => id !== sessionId);
          if (filtered.length !== folder.sessionIds.length) {
            changed = true;
            return { ...folder, sessionIds: filtered };
          }
          return folder;
        });

        if (!changed) return;
        const nextMap: SessionFoldersMap = { ...current, [scopeKey]: nextFolders };
        const nextCollapsed = syncCollapsedAfterFolderCleanup(scopeFolders, nextFolders, get().collapsedFolderIds);

        set(nextCollapsed
          ? { foldersMap: nextMap, collapsedFolderIds: nextCollapsed }
          : { foldersMap: nextMap });
        persistState(nextMap, nextCollapsed ?? get().collapsedFolderIds);
      },

      removeSessionEverywhere: (scopeKey: string, sessionId: string): void => {
        if (!sessionId) return;
        // The identity must belong to the ACTIVE scope: either it carries the
        // active scope key directly (legacy runtime-keyed cleanup), or the
        // session resolves to the active workspace scope. Removal never
        // touches another workspace's folder bucket.
        const resolvedScope = resolveSessionScopeKey(sessionId);
        const belongsToActiveScope = scopeKey === activeFolderScopeKey
          || resolvedScope === activeFolderScopeKey;
        if (!belongsToActiveScope) return;
        const current = get().foldersMap;
        let nextMap: SessionFoldersMap | null = null;

        for (const [scopeKey, scopeFolders] of Object.entries(current)) {
          let scopeChanged = false;
          const nextFolders = scopeFolders.map((folder) => {
            const sessionIds = folder.sessionIds.filter((id) => id !== sessionId);
            if (sessionIds.length === folder.sessionIds.length) return folder;
            scopeChanged = true;
            return { ...folder, sessionIds };
          });
          if (!scopeChanged) continue;
          nextMap ??= { ...current };
          nextMap[scopeKey] = nextFolders;
        }

        if (!nextMap) return;
        set({ foldersMap: nextMap });
        persistState(nextMap, get().collapsedFolderIds);
      },

      toggleFolderCollapse: (folderId: string): void => {
        const collapsed = get().collapsedFolderIds;
        const next = new Set(collapsed);
        if (next.has(folderId)) {
          next.delete(folderId);
        } else {
          next.add(folderId);
        }
        set({ collapsedFolderIds: next });
        persistState(get().foldersMap, next);
      },

      getSessionFolderId: (scopeKey: string, sessionId: string): string | null => {
        if (!scopeKey || !sessionId) return null;
        const scopeFolders = get().foldersMap[scopeKey];
        if (!scopeFolders) return null;
        for (const folder of scopeFolders) {
          if (folder.sessionIds.includes(sessionId)) {
            return folder.id;
          }
        }
        return null;
      },
    }),
    { name: 'session-folders-store' },
  ),
);

const hydrateSessionFoldersFromDisk = async (): Promise<void> => {
  if (diskHydrated || diskHydrationInFlight || typeof window === 'undefined') {
    return;
  }

  if (isVSCodeWebview()) {
    diskHydrated = true;
    return;
  }

  diskHydrationInFlight = true;
  const scopeKey = activeFolderScopeKey;
  const generation = folderRuntimeGeneration;
  const baselineMutationRevision = folderMutationRevision;
  let completed = false;

  try {
    const response = await runtimeFetch(SESSION_FOLDERS_API_PATH).catch(() => null);
    if (!response || !response.ok) {
      return;
    }

    const parsed = await response.json().catch(() => null) as {
      exists?: boolean;
      foldersMap?: SessionFoldersMap;
      collapsedFolderIds?: string[];
      updatedAt?: number;
    } | null;

    if (!parsed) {
      return;
    }

    if (parsed.exists === false) {
      completed = true;
      return;
    }

    const diskFolders = parsed.foldersMap && typeof parsed.foldersMap === 'object'
      ? parsed.foldersMap
      : {};
    const diskCollapsed = Array.isArray(parsed.collapsedFolderIds)
      ? new Set(parsed.collapsedFolderIds.filter((value): value is string => typeof value === 'string'))
      : new Set<string>();

    if (generation !== folderRuntimeGeneration || scopeKey !== activeFolderScopeKey) return;
    const browserUpdatedAt = readStorageIndex().runtimes.find((entry) => entry.runtimeKey === scopeKey)?.updatedAt ?? 0;
    const diskUpdatedAt = typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : 0;
    if (diskUpdatedAt > 0) {
      lastDiskUpdatedAtByScope.set(scopeKey, Math.max(lastDiskUpdatedAtByScope.get(scopeKey) ?? 0, diskUpdatedAt));
    }
    const hasDiskAuthority = parsed.exists === true || diskUpdatedAt > 0;
    if (hasDiskAuthority && folderMutationRevision === baselineMutationRevision && diskUpdatedAt >= browserUpdatedAt) {
      useSessionFoldersStore.setState({ foldersMap: diskFolders, collapsedFolderIds: diskCollapsed });
      persistFolders(diskFolders);
      persistCollapsed(diskCollapsed);
    }
    completed = true;
  } catch {
    // ignored
  } finally {
    if (generation === folderRuntimeGeneration && scopeKey === activeFolderScopeKey) {
      diskHydrationInFlight = false;
      if (completed) diskHydrated = true;
    }
  }
};

const bootstrapSessionFoldersDiskHydration = (): void => {
  if (typeof window === 'undefined') {
    return;
  }

  void hydrateSessionFoldersFromDisk();
};

bootstrapSessionFoldersDiskHydration();
