import { getDeferredSafeStorage } from "@/stores/utils/safeStorage"
import { legacyScopeKeyForProjectKey } from "@/projects/identity"

// Persisted "last active session" per project scope key, so a cold app
// launch can reopen the session the user had open the last time this instance
// was connected. This is startup-continuity context ONLY — callers must
// confirm the session still exists against an authoritative snapshot before
// opening it (see the MobileApp restore effect). Writes always use the
// caller-provided scope key. Entries written before the workspace→project
// rename live under `workspace:` scope keys; reads fall back to that legacy
// key (P-MIG) so a cold launch never loses the last session.
const STORAGE_KEY = "oc.lastSession.v1"
const MAX_RUNTIME_ENTRIES = 8

export type PersistedLastSession = {
  sessionId: string
  directory: string | null
}

type PersistedEntry = PersistedLastSession & { updatedAt: number }

type PersistedEnvelope = {
  version: 1
  runtimes: Record<string, PersistedEntry>
}

const emptyEnvelope = (): PersistedEnvelope => ({ version: 1, runtimes: {} })

const readEnvelope = (storage: Storage): PersistedEnvelope => {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return emptyEnvelope()
    const parsed = JSON.parse(raw) as Partial<PersistedEnvelope>
    if (parsed.version !== 1 || !parsed.runtimes || typeof parsed.runtimes !== "object") return emptyEnvelope()
    const runtimes: Record<string, PersistedEntry> = {}
    for (const [runtimeKey, entry] of Object.entries(parsed.runtimes)) {
      if (!runtimeKey || !entry || typeof entry.sessionId !== "string" || entry.sessionId.length === 0) continue
      runtimes[runtimeKey] = {
        sessionId: entry.sessionId,
        directory: typeof entry.directory === "string" && entry.directory.length > 0 ? entry.directory : null,
        updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : 0,
      }
    }
    return { version: 1, runtimes }
  } catch {
    // Malformed persisted data is a read failure, not empty success — but for
    // a pure convenience cache the correct recovery is the same: start fresh.
    return emptyEnvelope()
  }
}

const writeEnvelope = (storage: Storage, envelope: PersistedEnvelope): void => {
  const retained = Object.entries(envelope.runtimes)
    .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_RUNTIME_ENTRIES)
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ ...envelope, runtimes: Object.fromEntries(retained) }))
  } catch {
    // Best-effort cache — a full/blocked storage must never break session switching.
  }
}

export function persistLastActiveSession(
  scopeKey: string,
  entry: PersistedLastSession,
  storage: Storage = getDeferredSafeStorage(),
): void {
  if (!scopeKey || !entry.sessionId) return
  const envelope = readEnvelope(storage)
  // Monotonic vs the stored entries: same-millisecond writes must not tie,
  // or retention trimming would evict an arbitrary scope.
  const maxExisting = Object.values(envelope.runtimes).reduce((max, existing) => Math.max(max, existing.updatedAt), 0)
  envelope.runtimes[scopeKey] = { ...entry, updatedAt: Math.max(Date.now(), maxExisting + 1) }
  writeEnvelope(storage, envelope)
}

export function readLastActiveSession(
  scopeKey: string,
  storage: Storage = getDeferredSafeStorage(),
): PersistedLastSession | null {
  if (!scopeKey) return null
  const envelope = readEnvelope(storage)
  const entry = envelope.runtimes[scopeKey]
  if (entry) return { sessionId: entry.sessionId, directory: entry.directory } as PersistedLastSession
  // P-MIG: a `project:` scope key must also find the entry written under the
  // legacy `workspace:` prefix by pre-rename builds.
  const legacyKey = legacyScopeKeyForProjectKey(scopeKey)
  if (legacyKey) {
    const legacyEntry = envelope.runtimes[legacyKey]
    if (legacyEntry) return { sessionId: legacyEntry.sessionId, directory: legacyEntry.directory } as PersistedLastSession
  }
  return null
}

export function clearLastActiveSession(
  scopeKey: string,
  storage: Storage = getDeferredSafeStorage(),
): void {
  if (!scopeKey) return
  const envelope = readEnvelope(storage)
  let changed = false
  if (envelope.runtimes[scopeKey]) {
    delete envelope.runtimes[scopeKey]
    changed = true
  }
  // P-MIG: clearing must also remove the legacy `workspace:`-prefixed entry so
  // a stale pre-rename pointer cannot resurrect the session on the next cold
  // launch.
  const legacyKey = legacyScopeKeyForProjectKey(scopeKey)
  if (legacyKey && envelope.runtimes[legacyKey]) {
    delete envelope.runtimes[legacyKey]
    changed = true
  }
  if (changed) writeEnvelope(storage, envelope)
}
