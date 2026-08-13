/**
 * Persisted child-store metadata caches.
 *
 * VCS info, project metadata, icons, and a bounded session-list snapshot are
 * cached to localStorage per project scope key and directory so they survive
 * reloads. Message/part data is always loaded from the server.
 */

import type { Session, VcsInfo } from "@opencode-ai/sdk/v2/client"
import type { ProjectMeta } from "./types"
import { legacyScopeKeyForProjectKey } from "@/projects/identity"
import { countSyncPersistenceSerialization, countSyncPersistenceStorageWrite } from "./performance-diagnostics"

/** Cap persisted session lists so localStorage stays bounded per directory. */
const PERSISTED_SESSION_LIMIT = 50
const SESSION_CACHE_FALLBACK_LIMITS = [PERSISTED_SESSION_LIMIT, 25, 10, 5, 1] as const
const SESSION_PERSIST_DEBOUNCE_MS = 50

type PendingSessionWrite = {
  /** Project scope key the write belongs to. Writes always commit: the
   * storage key is collision-free per project. */
  scopeKey: string
  key: string
  sessions: Session[]
}

const pendingSessionWrites = new Map<string, PendingSessionWrite>()
let pendingSessionWriteTimer: ReturnType<typeof setTimeout> | undefined

// ---------------------------------------------------------------------------
// Storage key generation
// ---------------------------------------------------------------------------

function hashCode(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + chr
    hash |= 0
  }
  return Math.abs(hash).toString(36)
}

function storagePrefixForScope(scopeKey: string, directory: string): string {
  const head = directory.slice(0, 12).replace(/[^a-zA-Z0-9]/g, "_")
  return `oc.dir.v2.${head}.${hashCode(`${scopeKey}\0${directory}`)}`
}

/** Legacy `workspace:`-prefixed storage prefix written by pre-rename builds.
 * Read paths fall back to it (P-MIG) so caches survive the scope-key rename;
 * writes always use the current `project:` prefix. */
function legacyStoragePrefixForScope(scopeKey: string, directory: string): string | null {
  const legacyScopeKey = legacyScopeKeyForProjectKey(scopeKey)
  if (!legacyScopeKey) return null
  return `oc.dir.v2.${directory.slice(0, 12).replace(/[^a-zA-Z0-9]/g, "_")}.${hashCode(`${legacyScopeKey}\0${directory}`)}`
}

// ---------------------------------------------------------------------------
// Typed cache helpers
// ---------------------------------------------------------------------------

type CacheKey = "vcs" | "projectMeta" | "icon" | "sessions"

function cacheKey(directory: string, key: CacheKey, scopeKey: string): string {
  return `${storagePrefixForScope(scopeKey, directory)}.${key}`
}

function readCache<T>(directory: string, key: CacheKey, scopeKey: string): T | undefined {
  try {
    const currentKey = cacheKey(directory, key, scopeKey)
    if (key === "sessions") {
      const pending = pendingSessionWrites.get(currentKey)
      if (pending) return pending.sessions as T
    }
    const raw = localStorage.getItem(currentKey)
    if (raw) return JSON.parse(raw) as T
    // P-MIG: pre-rename builds persisted under a `workspace:`-derived prefix;
    // fall back to that key so caches survive the scope-key rename.
    const legacyKey = legacyStoragePrefixForScope(scopeKey, directory)
    if (legacyKey) {
      const legacyRaw = localStorage.getItem(`${legacyKey}.${key}`)
      if (legacyRaw) return JSON.parse(legacyRaw) as T
    }
    return undefined
  } catch {
    return undefined
  }
}

function writeCache<T>(directory: string, key: CacheKey, value: T | undefined, scopeKey: string): void {
  try {
    const currentKey = cacheKey(directory, key, scopeKey)
    if (value === undefined) {
      localStorage.removeItem(currentKey)
      // P-MIG: a cleared cache must not resurrect from the legacy key.
      const legacyKey = legacyStoragePrefixForScope(scopeKey, directory)
      if (legacyKey) localStorage.removeItem(`${legacyKey}.${key}`)
    } else {
      localStorage.setItem(currentKey, JSON.stringify(value))
    }
  } catch {
    // localStorage quota exceeded — ignore
  }
}

function sessionRecencyTimestamp(session: Session): number {
  const updated = session.time?.updated
  if (typeof updated === "number" && Number.isFinite(updated)) return updated
  const created = session.time?.created
  return typeof created === "number" && Number.isFinite(created) ? created : 0
}

function selectRecentSessions(sessions: Session[], limit: number): Session[] {
  if (sessions.length <= limit) return sessions
  const recentIds = new Set(
    [...sessions]
      .sort((left, right) => sessionRecencyTimestamp(right) - sessionRecencyTimestamp(left) || right.id.localeCompare(left.id))
      .slice(0, limit)
      .map((session) => session.id),
  )
  return sessions.filter((session) => recentIds.has(session.id))
}

function tryWriteCacheValue<T>(key: string, value: T): boolean {
  try {
    const serialized = JSON.stringify(value)
    countSyncPersistenceSerialization(serialized)
    countSyncPersistenceStorageWrite()
    localStorage.setItem(key, serialized)
    return true
  } catch {
    return false
  }
}

function writeSessionCache(key: string, sessions: Session[]): void {
  const recentSessions = selectRecentSessions(sessions, PERSISTED_SESSION_LIMIT)
  if (tryWriteCacheValue(key, recentSessions)) return

  // Replacing a stale value can fail when unrelated localStorage data has
  // grown. Remove that value and retain as much recent history as still fits.
  try {
    localStorage.removeItem(key)
  } catch {
    return
  }

  for (const limit of SESSION_CACHE_FALLBACK_LIMITS) {
    const candidate = selectRecentSessions(recentSessions, limit)
    if (tryWriteCacheValue(key, candidate)) return
  }

  // An empty v2 value is a tombstone: never resurrect stale sessions.
  tryWriteCacheValue(key, [])
}

function flushPendingSessionWrites(): void {
  if (pendingSessionWriteTimer !== undefined) {
    clearTimeout(pendingSessionWriteTimer)
    pendingSessionWriteTimer = undefined
  }
  if (pendingSessionWrites.size === 0) return
  const writes = [...pendingSessionWrites.values()]
  pendingSessionWrites.clear()
  // Every write is project-scoped with a collision-free storage key, so it
  // always commits against its captured scope.
  for (const pending of writes) {
    writeSessionCache(pending.key, pending.sessions)
  }
}

function scheduleSessionCacheWrite(directory: string, sessions: Session[], scopeKey: string): void {
  const key = `${storagePrefixForScope(scopeKey, directory)}.sessions`
  pendingSessionWrites.set(key, { scopeKey, key, sessions })
  if (pendingSessionWriteTimer !== undefined) return
  pendingSessionWriteTimer = setTimeout(flushPendingSessionWrites, SESSION_PERSIST_DEBOUNCE_MS)
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushPendingSessionWrites, { capture: true })
  window.addEventListener("beforeunload", flushPendingSessionWrites, { capture: true })
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushPendingSessionWrites()
    })
    document.addEventListener("freeze", flushPendingSessionWrites)
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type PersistedDirCache = {
  vcs: VcsInfo | undefined
  projectMeta: ProjectMeta | undefined
  icon: string | undefined
  sessions: Session[] | undefined
}

/** Read all cached metadata for a directory, keyed by project scope. */
export function readDirCache(directory: string, scopeKey: string): PersistedDirCache {
  return {
    vcs: readCache<VcsInfo>(directory, "vcs", scopeKey),
    projectMeta: readCache<ProjectMeta>(directory, "projectMeta", scopeKey),
    icon: readCache<string>(directory, "icon", scopeKey),
    sessions: readCache<Session[]>(directory, "sessions", scopeKey),
  }
}

/**
 * Write a capped slice of the directory session list to cache so the sidebar
 * can paint chats instantly on cold start. Refreshed by bootstrap loadSessions.
 */
export function persistSessions(directory: string, sessions: Session[] | undefined, scopeKey: string): void {
  const key = cacheKey(directory, "sessions", scopeKey)
  if (!sessions) {
    pendingSessionWrites.delete(key)
    writeCache(directory, "sessions", undefined, scopeKey)
    return
  }
  if (sessions.length === 0) {
    pendingSessionWrites.delete(key)
    writeSessionCache(key, sessions)
    return
  }
  scheduleSessionCacheWrite(directory, sessions, scopeKey)
}

/** Write vcs info to cache */
export function persistVcs(directory: string, vcs: VcsInfo | undefined, scopeKey: string): void {
  writeCache(directory, "vcs", vcs, scopeKey)
}

/** Write project metadata to cache */
export function persistProjectMeta(directory: string, meta: ProjectMeta | undefined, scopeKey: string): void {
  writeCache(directory, "projectMeta", meta, scopeKey)
}

/** Write icon to cache */
export function persistIcon(directory: string, icon: string | undefined, scopeKey: string): void {
  writeCache(directory, "icon", icon, scopeKey)
}
