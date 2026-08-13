import type { WorktreeMetadata } from "@/types/worktree"
import { getDeferredSafeStorage } from "@/stores/utils/safeStorage"
import { legacyScopeKeyForProjectKey } from "@/projects/identity"

const STORAGE_KEY = "oc.worktreeMap.v2"
const MAX_RUNTIME_TOPOLOGIES = 8

type PersistedTopology = {
  updatedAt: number
  entries: Array<[string, WorktreeMetadata[]]>
}

type PersistedTopologyEnvelope = {
  version: 2
  runtimes: Record<string, PersistedTopology>
}

const emptyEnvelope = (): PersistedTopologyEnvelope => ({ version: 2, runtimes: {} })

const parseEntries = (value: unknown): Array<[string, WorktreeMetadata[]]> => {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is [string, WorktreeMetadata[]] => (
    Array.isArray(entry)
    && typeof entry[0] === "string"
    && Array.isArray(entry[1])
  ))
}

const readEnvelope = (storage: Storage): PersistedTopologyEnvelope => {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return emptyEnvelope()
    const parsed = JSON.parse(raw) as Partial<PersistedTopologyEnvelope>
    if (parsed.version !== 2 || !parsed.runtimes || typeof parsed.runtimes !== "object") return emptyEnvelope()
    const runtimes: Record<string, PersistedTopology> = {}
    for (const [runtimeKey, topology] of Object.entries(parsed.runtimes)) {
      const entries = parseEntries(topology?.entries)
      if (!runtimeKey || entries.length === 0) continue
      runtimes[runtimeKey] = {
        updatedAt: typeof topology.updatedAt === "number" ? topology.updatedAt : 0,
        entries,
      }
    }
    return { version: 2, runtimes }
  } catch {
    return emptyEnvelope()
  }
}

const writeEnvelope = (storage: Storage, envelope: PersistedTopologyEnvelope): void => {
  const retained = Object.entries(envelope.runtimes)
    .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_RUNTIME_TOPOLOGIES)
  storage.setItem(STORAGE_KEY, JSON.stringify({ ...envelope, runtimes: Object.fromEntries(retained) }))
}

export function readPersistedWorktreeTopology(
  scopeKey: string,
  storage: Storage = getDeferredSafeStorage(),
): Map<string, WorktreeMetadata[]> {
  const envelope = readEnvelope(storage)
  const topology = envelope.runtimes[scopeKey]
  if (topology) return new Map(topology.entries)
  // P-MIG: a `project:` scope key must also find the topology persisted under
  // the legacy `workspace:` prefix by pre-rename builds.
  const legacyKey = legacyScopeKeyForProjectKey(scopeKey)
  if (legacyKey) {
    const legacyTopology = envelope.runtimes[legacyKey]
    if (legacyTopology) return new Map(legacyTopology.entries)
  }
  return new Map()
}

export function persistWorktreeTopology(
  scopeKey: string,
  topology: Map<string, WorktreeMetadata[]>,
  storage: Storage = getDeferredSafeStorage(),
): void {
  if (!scopeKey) return
  try {
    const envelope = readEnvelope(storage)
    envelope.runtimes[scopeKey] = {
      updatedAt: Date.now(),
      entries: [...topology.entries()],
    }
    writeEnvelope(storage, envelope)
  } catch {
    // Discovery remains authoritative in memory when persistence is unavailable.
  }
}
