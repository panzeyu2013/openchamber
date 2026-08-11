import { create } from 'zustand';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { resolveSessionScopeKey } from '@/sync/selection-store';
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
 * workspace scope for workspace sessions and the ambient runtime key
 * otherwise (byte-identical legacy behavior in non-workspace mode).
 */
export const getPinnedSessionKey = (scopeKey: string, directory: string, sessionId: string): string | null => {
  const normalizedDirectory = normalizePath(directory);
  if (!scopeKey || !normalizedDirectory || !sessionId) return null;
  return JSON.stringify([scopeKey, normalizedDirectory, sessionId]);
};

const parsePinnedSessionKey = (key: string): [string, string, string] | null => {
  try {
    const parsed = JSON.parse(key) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [scopeKey, directory, sessionId] = parsed;
    if (typeof scopeKey !== 'string' || typeof directory !== 'string' || typeof sessionId !== 'string') return null;
    const normalizedDirectory = normalizePath(directory);
    if (!scopeKey || !normalizedDirectory || normalizedDirectory !== directory || !sessionId) return null;
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
  if (ids.has(key)) return true;
  // Legacy dual read: pins written before the scope migration carry the
  // ambient runtime key in the first tuple slot.
  const legacyKey = directory
    ? getPinnedSessionKey(getRuntimeKey(), directory, sessionId)
    : null;
  return legacyKey !== null && legacyKey !== key && ids.has(legacyKey);
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
    return { ids: new Set(entries.map(([key]) => key)), touchedAt: Object.fromEntries(entries) };
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
    // Legacy runtime-keyed twin: toggling the scoped key off must not leave
    // the pre-migration entry behind (it would still read as pinned).
    const legacyKey = getPinnedSessionKey(getRuntimeKey(), target.directory, target.sessionId);
    const keys = legacyKey !== null && legacyKey !== key ? [key, legacyKey] : [key];
    if (ids.has(key)) {
      for (const candidate of keys) {
        ids.delete(candidate);
        delete touchedAt[candidate];
      }
    } else {
      ids.add(key);
      touchedAt[key] = Date.now();
      if (legacyKey !== null && legacyKey !== key) {
        ids.delete(legacyKey);
        delete touchedAt[legacyKey];
      }
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
    // When the identity carries the current runtime key (the legacy deletion
    // path), also drop the workspace-scoped twin so runtime-captured cleanup
    // reaches workspace-scoped pins. A non-current or workspace scope never
    // clears another owner's entry.
    const resolvedKey = scopeKey === getRuntimeKey()
      ? getPinnedSessionKey(resolveSessionScopeKey(sessionId, directory), directory, sessionId)
      : null;
    if (resolvedKey !== null && resolvedKey !== key && ids.has(resolvedKey)) {
      ids.delete(resolvedKey);
    }
    get().setIds(ids);
  },
}));
