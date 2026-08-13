/**
 * Selection Store — per-session model, agent, and variant selections.
 * Extracted from session-ui-store for subscription isolation.
 *
 * Keys are session-scoped: a session that belongs to a project is keyed by
 * `${projectScopeKey(projectId)}\n${sessionId}`, while unassigned
 * (non-project) sessions fall back to the unscoped bucket (`''`). Persisted
 * version 1 data (bare session IDs) is kept
 * readable through in-memory legacy maps until a scoped write replaces it.
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"
import { createDeferredSafeJSONStorage } from "@/stores/utils/safeStorage"
import { LEGACY_WORKSPACE_SCOPE_PREFIX, PROJECT_SCOPE_PREFIX, projectIdFromScopeKey, projectScopeKey } from "@/projects/identity"
import { resolveActiveProjectId, useProjectSessionIndexStore } from "@/projects/session-index-store"
import { getActiveSyncScopeKey } from "./active-scope"

/**
 * Resolves the scope key for a session: the project scope when the session
 * index maps (sessionId, directory) to a project. A caller that already has
 * the authoritative project target may pass `projectId` to avoid ambiguity
 * when two connections expose the same upstream session ID and directory.
 * The currently mounted project scope is the tie-breaker: with no directory
 * the index matches the first entry (arbitrary under ID collisions), and a
 * freshly created session is not indexed yet — in both cases the mounted
 * scope is the only authoritative signal. Sessions the index does not map
 * (unassigned) have no sync scope and key their state under the empty string.
 */
export const resolveSessionScopeKey = (
  sessionId: string | null | undefined,
  directory?: string | null,
  projectId?: string | null,
): string => {
  const explicitProjectId = typeof projectId === 'string' ? projectId.trim() : ''
  if (explicitProjectId) return projectScopeKey(explicitProjectId)
  const mountedScopeKey = getActiveSyncScopeKey()
  const mountedProjectId = projectIdFromScopeKey(mountedScopeKey)
  const snapshot = useProjectSessionIndexStore.getState().snapshot
  const sessions = snapshot?.sessions
  const inferredProjectId = resolveActiveProjectId(sessions, sessionId ?? null, directory ?? null)
  if (inferredProjectId && inferredProjectId !== mountedProjectId && directory) {
    // The index disambiguated by directory and points away from the mounted
    // project: trust it.
    return projectScopeKey(inferredProjectId)
  }
  if (mountedProjectId) return mountedScopeKey
  if (inferredProjectId) return projectScopeKey(inferredProjectId)
  return ''
}

type ModelSelection = { providerId: string; modelId: string }
type LastUsedProvider = { providerID: string; modelID: string }
type AgentModelSelectionEntries = [string, [string, ModelSelection][]][]
type PersistedSelectionState = {
  sessionModelSelections?: [string, ModelSelection][]
  sessionAgentSelections?: [string, string][]
  sessionAgentModelSelections?: AgentModelSelectionEntries
  lastUsedProvider?: LastUsedProvider | null
}

export type SelectionState = {
  sessionModelSelections: Map<string, ModelSelection>
  sessionAgentSelections: Map<string, string>
  sessionAgentModelSelections: Map<string, Map<string, ModelSelection>>
  lastUsedProvider: LastUsedProvider | null

  saveSessionModelSelection: (sessionId: string, providerId: string, modelId: string) => void
  getSessionModelSelection: (sessionId: string) => { providerId: string; modelId: string } | null
  saveSessionAgentSelection: (sessionId: string, agentName: string) => void
  getSessionAgentSelection: (sessionId: string) => string | null
  saveAgentModelForSession: (sessionId: string, agentName: string, providerId: string, modelId: string) => void
  getAgentModelForSession: (sessionId: string, agentName: string) => { providerId: string; modelId: string } | null
  saveAgentModelVariantForSession: (sessionId: string, agentName: string, providerId: string, modelId: string, variant: string | undefined) => void
  getAgentModelVariantForSession: (sessionId: string, agentName: string, providerId: string, modelId: string) => string | undefined
}

const isPersistedSelectionState = (state: unknown): state is PersistedSelectionState => (
  typeof state === "object" && state !== null
)

/** Scope-qualified session key; identical to the old bare session ID in shape
 * only when a scope separator is present. Scoped keys contain '\n', bare
 * (legacy) session IDs never do. */
const selectionKeyFor = (scopeKey: string, sessionId: string): string => `${scopeKey}\n${sessionId}`

/** P-MIG: rewrites a persisted scoped selection key written with the legacy
 * `workspace:` scope prefix to the current `project:` prefix so pre-rename
 * persisted selections stay readable. Bare session IDs pass through. */
const normalizePersistedSelectionKey = (key: string): string => {
  const separator = key.indexOf('\n')
  if (separator <= 0) return key
  const scopeKey = key.slice(0, separator)
  if (!scopeKey.startsWith(LEGACY_WORKSPACE_SCOPE_PREFIX)) return key
  const projectId = scopeKey.slice(LEGACY_WORKSPACE_SCOPE_PREFIX.length)
  if (!projectId) return key
  return `${PROJECT_SCOPE_PREFIX}${projectId}${key.slice(separator)}`
}

const sessionSelectionKey = (sessionId: string): string =>
  selectionKeyFor(resolveSessionScopeKey(sessionId), sessionId)

// Legacy in-memory storage for persisted version 1 data (bare session IDs,
// read from storage until a scoped write replaces them).
const legacySessionModelSelections = new Map<string, ModelSelection>()
const legacySessionAgentSelections = new Map<string, string>()
const legacySessionAgentModelSelections = new Map<string, Map<string, ModelSelection>>()

// In-memory variant storage (not persisted)
const agentModelVariantSelections = new Map<string, Map<string, Map<string, string>>>()

// Maximum number of sessions to persist to local storage to prevent unbounded growth
const MAX_PERSISTED_SESSIONS = 150

export const useSelectionStore = create<SelectionState>()(
  persist(
    (set, get) => ({
      sessionModelSelections: new Map(),
      sessionAgentSelections: new Map(),
      sessionAgentModelSelections: new Map(),
      lastUsedProvider: null,

      saveSessionModelSelection: (sessionId, providerId, modelId) =>
        set((s) => {
          const key = sessionSelectionKey(sessionId)
          legacySessionModelSelections.delete(sessionId)
          const map = new Map(s.sessionModelSelections)
          map.delete(key) // Delete first to ensure it moves to the end of insertion order (MRU)
          map.set(key, { providerId, modelId })
          return { sessionModelSelections: map, lastUsedProvider: { providerID: providerId, modelID: modelId } }
        }),

      getSessionModelSelection: (sessionId) => {
        const key = sessionSelectionKey(sessionId)
        return get().sessionModelSelections.get(key) ?? legacySessionModelSelections.get(sessionId) ?? null
      },

      saveSessionAgentSelection: (sessionId, agentName) =>
        set((s) => {
          const key = sessionSelectionKey(sessionId)
          if (s.sessionAgentSelections.get(key) === agentName) return s
          legacySessionAgentSelections.delete(sessionId)
          const map = new Map(s.sessionAgentSelections)
          map.delete(key) // Delete first to ensure it moves to the end of insertion order (MRU)
          map.set(key, agentName)
          return { sessionAgentSelections: map }
        }),

      getSessionAgentSelection: (sessionId) => {
        const key = sessionSelectionKey(sessionId)
        return get().sessionAgentSelections.get(key) ?? legacySessionAgentSelections.get(sessionId) ?? null
      },

      saveAgentModelForSession: (sessionId, agentName, providerId, modelId) =>
        set((s) => {
          const key = sessionSelectionKey(sessionId)
          const existing = s.sessionAgentModelSelections.get(key)?.get(agentName)
          if (existing?.providerId === providerId && existing?.modelId === modelId) return s
          legacySessionAgentModelSelections.delete(sessionId)
          const outer = new Map(s.sessionAgentModelSelections)
          const inner = new Map(outer.get(key) ?? new Map())

          outer.delete(key) // Delete first to ensure it moves to the end of insertion order (MRU)
          inner.set(agentName, { providerId, modelId })
          outer.set(key, inner)

          return { sessionAgentModelSelections: outer }
        }),

      getAgentModelForSession: (sessionId, agentName) => {
        const key = sessionSelectionKey(sessionId)
        return get().sessionAgentModelSelections.get(key)?.get(agentName)
          ?? legacySessionAgentModelSelections.get(sessionId)?.get(agentName)
          ?? null
      },

      saveAgentModelVariantForSession: (sessionId, agentName, providerId, modelId, variant) => {
        const key = sessionSelectionKey(sessionId)
        const sessionKey = `${key}\n${sessionId}`
        const variantKey = `${providerId}/${modelId}`
        let agentMap = agentModelVariantSelections.get(sessionKey)
        if (!agentMap && variant) {
          agentMap = new Map()
          agentModelVariantSelections.set(sessionKey, agentMap)
        }
        if (!agentMap) return
        let modelMap = agentMap.get(agentName)
        if (!modelMap && variant) {
          modelMap = new Map()
          agentMap.set(agentName, modelMap)
        }
        if (!modelMap) return

        if (!variant) {
          modelMap.delete(variantKey)
          if (modelMap.size === 0) {
            agentMap.delete(agentName)
          }
          if (agentMap.size === 0) {
            agentModelVariantSelections.delete(sessionKey)
          }
          return
        }

        modelMap.set(variantKey, variant)
      },

      getAgentModelVariantForSession: (sessionId, agentName, providerId, modelId) => {
        const key = sessionSelectionKey(sessionId)
        const sessionKey = `${key}\n${sessionId}`
        const variantKey = `${providerId}/${modelId}`
        return agentModelVariantSelections.get(sessionKey)?.get(agentName)?.get(variantKey)
          ?? agentModelVariantSelections.get(sessionId)?.get(agentName)?.get(variantKey)
      },
    }),
    {
      name: "selection-store",
      version: 3,
      storage: createDeferredSafeJSONStorage(),
      partialize: (state) => {
        // Convert Maps to arrays and slice to keep only the most recent MAX_PERSISTED_SESSIONS
        const models = Array.from(state.sessionModelSelections.entries()).slice(-MAX_PERSISTED_SESSIONS)
        const agents = Array.from(state.sessionAgentSelections.entries()).slice(-MAX_PERSISTED_SESSIONS)
        const agentModels = Array.from(state.sessionAgentModelSelections.entries())
          .slice(-MAX_PERSISTED_SESSIONS)
          .map(([sessionId, agentMap]) => [sessionId, Array.from(agentMap.entries())])

        return {
          sessionModelSelections: models,
          sessionAgentSelections: agents,
          sessionAgentModelSelections: agentModels,
          lastUsedProvider: state.lastUsedProvider,
        }
      },
      merge: (persistedState: unknown, currentState) => {
        const persisted = isPersistedSelectionState(persistedState) ? persistedState : undefined
        const agentModelSelections = new Map<string, Map<string, ModelSelection>>()
        if (Array.isArray(persisted?.sessionAgentModelSelections)) {
          persisted.sessionAgentModelSelections.forEach(([sessionId, agentArray]) => {
            const agentMap = new Map(agentArray)
            const normalized = normalizePersistedSelectionKey(sessionId)
            if (normalized.includes("\n")) agentModelSelections.set(normalized, agentMap)
            else legacySessionAgentModelSelections.set(normalized, agentMap)
          })
        }
        const modelSelections = new Map<string, ModelSelection>()
        for (const [sessionId, value] of persisted?.sessionModelSelections ?? []) {
          const normalized = normalizePersistedSelectionKey(sessionId)
          if (normalized.includes("\n")) modelSelections.set(normalized, value)
          else legacySessionModelSelections.set(normalized, value)
        }
        const agentSelections = new Map<string, string>()
        for (const [sessionId, agentName] of persisted?.sessionAgentSelections ?? []) {
          const normalized = normalizePersistedSelectionKey(sessionId)
          if (normalized.includes("\n")) agentSelections.set(normalized, agentName)
          else legacySessionAgentSelections.set(normalized, agentName)
        }

        return {
          ...currentState,
          lastUsedProvider: persisted?.lastUsedProvider ?? currentState.lastUsedProvider,
          sessionModelSelections: modelSelections,
          sessionAgentSelections: agentSelections,
          sessionAgentModelSelections: agentModelSelections,
        }
      },
      migrate: (persistedState: unknown) => {
        // Version 1 (bare session ID keys), version 2 (scoped keys) and
        // version 3 (project-scoped keys) are all handled by merge; the
        // version bumps only document the key changes (v3 also normalizes
        // `workspace:`-prefixed scoped keys to `project:` in merge).
        return persistedState
      }
    }
  )
)
