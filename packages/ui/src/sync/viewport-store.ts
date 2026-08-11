/**
 * Viewport Store — per-session scroll anchors, streaming state, memory.
 * Extracted from session-ui-store for subscription isolation.
 *
 * Memory is keyed by session scope (`${scopeKey}\n${sessionId}`), where the
 * scope key is the workspace scope for workspace sessions and the ambient
 * runtime key otherwise — byte-identical to the pre-migration key format in
 * non-workspace mode. Bare session IDs (pre-scope legacy) remain readable as
 * a fallback; writes only ever use the scoped key.
 */

import { create } from "zustand"
import { resolveSessionScopeKey } from "./selection-store"

export type SessionMemoryState = {
  viewportAnchor: number
  /** Last known scrollbar pixel state — saved on every scroll event. */
  scrollPosition?: {
    scrollTop: number
    scrollHeight: number
    clientHeight: number
  }
  isStreaming: boolean
  streamStartTime?: number
  lastAccessedAt: number
  backgroundMessageCount: number
  loadedTurnCount?: number
  hasMoreAbove?: boolean
  hasMoreTurnsAbove?: boolean
  historyLoading?: boolean
  historyComplete?: boolean
  historyLimit?: number
  totalAvailableMessages?: number
  streamingCooldownUntil?: number
  isZombie?: boolean
  lastUserMessageAt?: number
}

export type ViewportState = {
  sessionMemoryState: Map<string, SessionMemoryState>
  isSyncing: boolean

  updateViewportAnchor: (sessionId: string, anchor: number, scrollPosition?: SessionMemoryState['scrollPosition']) => void
}

export const viewportSessionKey = (sessionId: string, scopeKey?: string): string =>
  `${scopeKey ?? resolveSessionScopeKey(sessionId)}\n${sessionId}`

export const getViewportSessionMemory = (sessionId: string): SessionMemoryState | undefined => {
  const state = useViewportStore.getState()
  return state.sessionMemoryState.get(viewportSessionKey(sessionId)) ?? state.sessionMemoryState.get(sessionId)
}

export const useViewportStore = create<ViewportState>()((set) => ({
  sessionMemoryState: new Map(),
  isSyncing: false,

  updateViewportAnchor: (sessionId, anchor, scrollPosition) =>
    set((s) => {
      const map = new Map(s.sessionMemoryState)
      const key = viewportSessionKey(sessionId)
      const existing = map.get(key) ?? map.get(sessionId) ?? {
        viewportAnchor: 0,
        isStreaming: false,
        lastAccessedAt: Date.now(),
        backgroundMessageCount: 0,
      }
      map.set(key, {
        ...existing,
        viewportAnchor: anchor,
        ...(scrollPosition ? { scrollPosition } : {}),
        lastAccessedAt: Date.now(),
      })
      return { sessionMemoryState: map }
    }),
}))
