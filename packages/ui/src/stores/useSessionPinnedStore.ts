import { create } from 'zustand';
import { resolveSessionScopeKey } from '@/sync/selection-store';
import { projectIdFromScopeKey, projectScopeKey } from '@/projects/identity';
import { normalizePath } from '@/lib/pathNormalization';
import { getDeferredSafeStorage } from './utils/safeStorage';

const STORAGE_KEY = 'oc.sessions.pinned.v2';
const LEGACY_STORAGE_KEY = 'oc.sessions.pinned';

export type SessionPinnedTarget = { directory: string; sessionId: string };

type PersistedPins = { version: 2; sessions: Record<string, number> };

type PinnedSessionState = {
  ids: Set<string>;
  touchedAt: Record<string, number>;
};

type SessionPinnedStore = PinnedSessionState & {
  setIds: (next: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  toggle: (target: SessionPinnedTarget) => void;
  clearPinnedSession: (scopeKey: string, directory: string, sessionId: string) => void;
};

const storage = getDeferredSafeStorage();

/**
 * Composite pin key: [scopeKey, directory, sessionId]. The scope key is the
 * project scope for project sessions and the ambient runtime key
 * otherwise (byte-identical legacy behavior in non-project mode).
 */
export const getPinnedSessionKey = (scopeKey: string, directory: string, sessionId: string): string | null => {
  const normalizedDirectory = normalizePath(directory);
  // The empty scope is the legitimate unscoped bucket for sessions the
  // session index does not map to a project.
  if (typeof scopeKey !== 'string' || !normalizedDirectory || !sessionId) return null;
  return JSON.stringify([scopeKey, normalizedDirectory, sessionId]);
};

const parsePinnedSessionKey = (key: string): [string, string, string] | null => {
  try {
    const parsed = JSON.parse(key) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [scopeKey, directory, sessionId] = parsed;
    if (typeof scopeKey !== 'string' || typeof directory !== 'string' || typeof sessionId !== 'string') return null;
    const normalizedDirectory = normalizePath(directory);
    if (!normalizedDirectory || normalizedDirectory !== directory || !sessionId) return null;
    return [scopeKey, normalizedDirectory, sessionId];
  } catch {
    return null;
  }
};

/** Resolves the scope key for a pinned session with a legacy runtime-key
 * fallback so pre-migration pins stay visible. */
const pinnedKeyForSession = (directory: string | null | undefined, sessionId: string): string | null => {
  if (!directory || !sessionId) return null;
  const scopeKey = resolveSessionScopeKey(sessionId, directory);
  return getPinnedSessionKey(scopeKey, directory, sessionId);
};

export const isSessionPinned = (ids: Set<string>, directory: string | null | undefined, sessionId: string): boolean => {
  const key = pinnedKeyForSession(directory, sessionId);
  if (!key) return false;
  return ids.has(key);
};

const readPinned = (): PinnedSessionState => {
  storage.removeItem(LEGACY_STORAGE_KEY);
  const raw = storage.getItem(STORAGE_KEY);
  if (raw === null) return { ids: new Set(), touchedAt: {} };
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedPins>;
    if (parsed.version !== 2 || !parsed.sessions || typeof parsed.sessions !== 'object') return { ids: new Set(), touchedAt: {} };
    const entries = Object.entries(parsed.sessions)
      .filter(([key, touchedAt]) => parsePinnedSessionKey(key) && typeof touchedAt === 'number' && Number.isFinite(touchedAt))
      .sort((left, right) => right[1] - left[1]);
    // P-MIG: pins keyed with the pre-rename `workspace:` scope prefix are
    // normalized to the current `project:` key so pre-upgrade pins stay
    // visible, then rewritten once so the legacy records do not linger.
    const migrated = entries.map(([key, touchedAt]) => {
      const parts = parsePinnedSessionKey(key);
      if (!parts) return [key, touchedAt] as const;
      const [scopeKey, directory, sessionId] = parts;
      const projectId = projectIdFromScopeKey(scopeKey);
      if (!projectId) return [key, touchedAt] as const;
      const promoted = getPinnedSessionKey(projectScopeKey(projectId), directory, sessionId);
      return [(promoted ?? key), touchedAt] as const;
    });
    if (migrated.some(([key], index) => key !== entries[index]?.[0])) {
      const sessions = Object.fromEntries(migrated);
      storage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, sessions }));
    }
    return { ids: new Set(migrated.map(([key]) => key)), touchedAt: Object.fromEntries(migrated) };
  } catch {
    storage.removeItem(STORAGE_KEY);
    return { ids: new Set(), touchedAt: {} };
  }
};

const boundPinnedState = (ids: Set<string>, touchedAt: Record<string, number>): PinnedSessionState => {
  const entries = [...ids]
    .filter((key) => parsePinnedSessionKey(key) !== null)
    .map((key) => [key, touchedAt[key] ?? Date.now()] as const)
    .sort((left, right) => right[1] - left[1]);
  return {
    ids: new Set(entries.map(([key]) => key)),
    touchedAt: Object.fromEntries(entries),
  };
};

const persistPinned = ({ ids, touchedAt }: PinnedSessionState): void => {
  const sessions = Object.fromEntries([...ids].map((key) => [key, touchedAt[key] ?? Date.now()]));
  storage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, sessions }));
};

const initial = readPinned();

export const useSessionPinnedStore = create<SessionPinnedStore>((set, get) => ({
  ids: initial.ids,
  touchedAt: initial.touchedAt,
  setIds: (next) => {
    const current = get().ids;
    const resolved = typeof next === 'function' ? next(current) : next;
    if (resolved === current) return;
    const pinnedState = boundPinnedState(resolved, get().touchedAt);
    set(pinnedState);
    persistPinned(pinnedState);
  },
  toggle: (target) => {
    const key = pinnedKeyForSession(target.directory, target.sessionId);
    if (!key) return;
    const ids = new Set(get().ids);
    const touchedAt = { ...get().touchedAt };
    if (ids.has(key)) {
      ids.delete(key);
      delete touchedAt[key];
    } else {
      ids.add(key);
      touchedAt[key] = Date.now();
    }
    const pinnedState = boundPinnedState(ids, touchedAt);
    set(pinnedState);
    persistPinned(pinnedState);
  },
  clearPinnedSession: (scopeKey, directory, sessionId) => {
    const key = getPinnedSessionKey(scopeKey, directory, sessionId);
    if (!key || !get().ids.has(key)) return;
    const ids = new Set(get().ids);
    ids.delete(key);
    get().setIds(ids);
  },
}));
