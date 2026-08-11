/**
 * Persisted child-store metadata caches.
 *
 * VCS info, project metadata, icons, and a bounded session-list snapshot are
 * cached to localStorage per sync scope (workspace scope key, or the ambient
 * runtime key in non-workspace mode) and directory so they survive reloads.
 * Message/part data is always loaded from the server.
 */

import type { Session, VcsInfo } from "@opencode-ai/sdk/v2/client"
import type { ProjectMeta } from "./types"
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from "@/lib/runtime-switch"
import { workspaceIdFromScopeKey } from "@/workspaces/identity"
import { countSyncPersistenceSerialization, countSyncPersistenceStorageWrite } from "./performance-diagnostics"

/** Cap persisted session lists so localStorage stays bounded per directory. */
const PERSISTED_SESSION_LIMIT = 50
const SESSION_CACHE_FALLBACK_LIMITS = [PERSISTED_SESSION_LIMIT, 25, 10, 5, 1] as const
const SESSION_PERSIST_DEBOUNCE_MS = 50

type PendingSessionWrite = {
  /** Scope the write belongs to: workspace scope key, or the ambient runtime
   * key in non-workspace mode (byte-identical to the pre-migration key). */
  scopeKey: string
  /** True when the write is ambient-runtime-scoped and must not commit after
   * a runtime switch; workspace-scoped writes always commit to their own
   * collision-free storage key. */
  runtimeScoped: boolean
  key: string
  legacyKey: string
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

function legacyStoragePrefix(directory: string): string {
  const head = directory.slice(0, 12).replace(/[^a-zA-Z0-9]/g, "_")
  return `oc.dir.${head}.${hashCode(directory)}`
}

function storagePrefix(directory: string, scopeKey = getRuntimeKey()): string {
  return storagePrefixForScope(scopeKey, directory)
}

function storagePrefixForScope(scopeKey: string, directory: string): string {
  const head = directory.slice(0, 12).replace(/[^a-zA-Z0-9]/g, "_")
  return `oc.dir.v2.${head}.${hashCode(`${scopeKey}\0${directory}`)}`
}

// ---------------------------------------------------------------------------
// Typed cache helpers
// ---------------------------------------------------------------------------

type CacheKey = "vcs" | "projectMeta" | "icon" | "sessions"

function cacheKey(directory: string, key: CacheKey, scopeKey?: string): string {
  return `${storagePrefix(directory, scopeKey)}.${key}`
}

function legacyCacheKey(directory: string, key: CacheKey): string {
  return `${legacyStoragePrefix(directory)}.${key}`
}

function readCache<T>(directory: string, key: CacheKey, scopeKey?: string): T | undefined {
  try {
    const currentKey = cacheKey(directory, key, scopeKey)
    if (key === "sessions") {
      const pending = pendingSessionWrites.get(currentKey)
      if (pending) return pending.sessions as T
    }
    const raw = localStorage.getItem(currentKey)
      ?? localStorage.getItem(legacyCacheKey(directory, key))
    if (!raw) return undefined
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

function writeCache<T>(directory: string, key: CacheKey, value: T | undefined, scopeKey?: string): void {
  try {
    const currentKey = cacheKey(directory, key, scopeKey)
    if (value === undefined) {
      localStorage.removeItem(currentKey)
      localStorage.removeItem(legacyCacheKey(directory, key))
    } else {
      localStorage.setItem(currentKey, JSON.stringify(value))
      localStorage.removeItem(legacyCacheKey(directory, key))
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

function tryWriteCacheValue<T>(key: string, legacyKey: string, value: T): boolean {
  try {
    const serialized = JSON.stringify(value)
    countSyncPersistenceSerialization(serialized)
    countSyncPersistenceStorageWrite()
    localStorage.setItem(key, serialized)
    localStorage.removeItem(legacyKey)
    return true
  } catch {
    return false
  }
}

function writeSessionCache(key: string, legacyKey: string, sessions: Session[]): void {
  const recentSessions = selectRecentSessions(sessions, PERSISTED_SESSION_LIMIT)
  if (tryWriteCacheValue(key, legacyKey, recentSessions)) return

  // Replacing a stale value can fail when unrelated localStorage data has
  // grown. Remove that value and retain as much recent history as still fits.
  try {
    localStorage.removeItem(key)
    localStorage.removeItem(legacyKey)
  } catch {
    return
  }

  for (const limit of SESSION_CACHE_FALLBACK_LIMITS) {
    const candidate = selectRecentSessions(recentSessions, limit)
    if (tryWriteCacheValue(key, legacyKey, candidate)) return
  }

  // An empty v2 value is a tombstone: never resurrect stale legacy sessions.
  tryWriteCacheValue(key, legacyKey, [])
}

function flushPendingSessionWrites(): void {
  if (pendingSessionWriteTimer !== undefined) {
    clearTimeout(pendingSessionWriteTimer)
    pendingSessionWriteTimer = undefined
  }
  if (pendingSessionWrites.size === 0) return
  const writes = [...pendingSessionWrites.values()]
  pendingSessionWrites.clear()
  const currentRuntimeKey = getRuntimeKey() || "local"
  for (const pending of writes) {
    // Ambient-runtime-scoped writes must not commit after a runtime switch
    // (the old guard, unchanged). Workspace-scoped writes always commit: their
    // storage key is collision-free per workspace, so completing against the
    // captured scope is always safe.
    if (pending.runtimeScoped && pending.scopeKey !== currentRuntimeKey) continue
    writeSessionCache(pending.key, pending.legacyKey, pending.sessions)
  }
}

function scheduleSessionCacheWrite(directory: string, sessions: Session[], scopeKey = getRuntimeKey()): void {
  const runtimeScoped = workspaceIdFromScopeKey(scopeKey) === null
  const key = `${storagePrefixForScope(scopeKey, directory)}.sessions`
  for (const [pendingKey, pending] of pendingSessionWrites) {
    if (pending.runtimeScoped && pending.scopeKey !== scopeKey) pendingSessionWrites.delete(pendingKey)
  }
  pendingSessionWrites.set(key, { scopeKey, runtimeScoped, key, legacyKey: legacyCacheKey(directory, "sessions"), sessions })
  if (pendingSessionWriteTimer !== undefined) return
  pendingSessionWriteTimer = setTimeout(flushPendingSessionWrites, SESSION_PERSIST_DEBOUNCE_MS)
}

function cancelPendingSessionWrites(scopeKey: string): void {
  for (const [key, pending] of pendingSessionWrites) {
    if (pending.runtimeScoped && pending.scopeKey === scopeKey) pendingSessionWrites.delete(key)
  }
  if (pendingSessionWrites.size === 0 && pendingSessionWriteTimer !== undefined) {
    clearTimeout(pendingSessionWriteTimer)
    pendingSessionWriteTimer = undefined
  }
}

subscribeRuntimeEndpointWillChange(({ previousRuntimeKey }) => cancelPendingSessionWrites(previousRuntimeKey))

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

/** Read all cached metadata for a directory. `scopeKey` defaults to the
 * ambient runtime key, so non-workspace callers read the exact legacy keys. */
export function readDirCache(directory: string, scopeKey?: string): PersistedDirCache {
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
export function persistSessions(directory: string, sessions: Session[] | undefined, scopeKey?: string): void {
  const key = cacheKey(directory, "sessions", scopeKey)
  if (!sessions) {
    pendingSessionWrites.delete(key)
    writeCache(directory, "sessions", undefined, scopeKey)
    return
  }
  if (sessions.length === 0) {
    pendingSessionWrites.delete(key)
    writeSessionCache(key, legacyCacheKey(directory, "sessions"), sessions)
    return
  }
  scheduleSessionCacheWrite(directory, sessions, scopeKey)
}

/** Write vcs info to cache */
export function persistVcs(directory: string, vcs: VcsInfo | undefined, scopeKey?: string): void {
  writeCache(directory, "vcs", vcs, scopeKey)
}

/** Write project metadata to cache */
export function persistProjectMeta(directory: string, meta: ProjectMeta | undefined, scopeKey?: string): void {
  writeCache(directory, "projectMeta", meta, scopeKey)
}

/** Write icon to cache */
export function persistIcon(directory: string, icon: string | undefined, scopeKey?: string): void {
  writeCache(directory, "icon", icon, scopeKey)
}
