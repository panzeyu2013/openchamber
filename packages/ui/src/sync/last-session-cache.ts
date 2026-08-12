import { getDeferredSafeStorage } from "@/stores/utils/safeStorage"

// Persisted "last active session" per workspace scope key, so a cold app
// launch can reopen the session the user had open the last time this instance
// was connected. This is startup-continuity context ONLY — callers must
// confirm the session still exists against an authoritative snapshot before
// opening it (see the MobileApp restore effect). Writes always use the
// caller-provided scope key.
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
  return entry ? { sessionId: entry.sessionId, directory: entry.directory } : null
}

export function clearLastActiveSession(
  scopeKey: string,
  storage: Storage = getDeferredSafeStorage(),
): void {
  if (!scopeKey) return
  const envelope = readEnvelope(storage)
  if (!envelope.runtimes[scopeKey]) return
  delete envelope.runtimes[scopeKey]
  writeEnvelope(storage, envelope)
}
