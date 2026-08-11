import type { Event, Session } from "@opencode-ai/sdk/v2/client"
import { isGlobalSessionRecencyOnlyUpdate, useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from "@/lib/runtime-switch"
import { streamPerfCount, streamPerfMark } from "@/stores/utils/streamDebug"
import { stripSessionDiffSnapshots } from "./sanitize"
import { shouldSkipStaleSessionEvent } from "./session-event-freshness"

const pendingGlobalSessionUpdates = new Map<string, { scopeKey: string; session: Session }>()

const pendingKey = (scopeKey: string, sessionId: string): string => `${scopeKey}\0${sessionId}`

const clearPendingGlobalSessionUpdates = (): void => {
  pendingGlobalSessionUpdates.clear()
}

const flushPendingGlobalSessionUpdate = (scopeKey: string, sessionID: string): void => {
  const key = pendingKey(scopeKey, sessionID)
  const update = pendingGlobalSessionUpdates.get(key)
  pendingGlobalSessionUpdates.delete(key)
  if (!update) return
  if (update.scopeKey !== scopeKey) return
  const currentSession = getGlobalSessionSnapshot(scopeKey, update.session.id)
  if (
    !currentSession
    || shouldSkipStaleSessionEvent(currentSession, update.session)
    || !isGlobalSessionRecencyOnlyUpdate(currentSession, update.session)
  ) return
  streamPerfMark("global_sessions.event_update_flush")
  useGlobalSessionsStore.getState().upsertSession(update.session)
  streamPerfCount("ui.global_sessions.event_update_publication")
}

const scheduleGlobalSessionUpdate = (scopeKey: string, session: Session): void => {
  pendingGlobalSessionUpdates.set(pendingKey(scopeKey, session.id), { scopeKey, session })
  streamPerfCount("ui.global_sessions.event_update_deferred")
}

subscribeRuntimeEndpointWillChange(clearPendingGlobalSessionUpdates)

const getSessionInfoFromPayload = (event: Event): Session | null => {
  if (event.type !== "session.created" && event.type !== "session.updated" && event.type !== "session.deleted") {
    return null
  }

  const properties = (event as { properties?: unknown }).properties
  if (!properties || typeof properties !== "object") {
    return null
  }

  const info = (properties as { info?: unknown }).info
  if (!info || typeof info !== "object") {
    return null
  }

  const session = info as Partial<Session>
  if (typeof session.id !== "string" || !session.time) {
    return null
  }

  return stripSessionDiffSnapshots(session as Session)
}

const getGlobalSessionSnapshot = (scopeKey: string, sessionId: string): Session | null => {
  const global = useGlobalSessionsStore.getState()
  // Compatibility mocks and detached legacy surfaces may not expose the new
  // scope field. Real store instances always do, and an explicitly bound
  // event from another workspace must never mutate this facade.
  if (global.scopeKey && global.scopeKey !== scopeKey) return null
  return [...global.activeSessions, ...global.archivedSessions].find((session) => session.id === sessionId) ?? null
}

export const applySessionEventToGlobalSessions = (payload: Event, scopeKey = getRuntimeKey()): void => {
  const globalStore = useGlobalSessionsStore.getState()
  if (globalStore.scopeKey && globalStore.scopeKey !== scopeKey) return

  if (payload.type === "session.idle" || payload.type === "session.error") {
    const sessionID = (payload as { properties?: { sessionID?: unknown } }).properties?.sessionID
    if (typeof sessionID === "string") flushPendingGlobalSessionUpdate(scopeKey, sessionID)
    return
  }

  if (payload.type === "session.created") {
    const session = getSessionInfoFromPayload(payload)
    if (session) {
      const currentSession = getGlobalSessionSnapshot(scopeKey, session.id)
      if (!shouldSkipStaleSessionEvent(currentSession, session)) {
        useGlobalSessionsStore.getState().upsertSession(session)
      }
    }
    return
  }

  if (payload.type === "session.updated") {
    const session = getSessionInfoFromPayload(payload)
    if (session) {
      const currentSession = getGlobalSessionSnapshot(scopeKey, session.id)
      if (!shouldSkipStaleSessionEvent(currentSession, session)) {
        if (currentSession && isGlobalSessionRecencyOnlyUpdate(currentSession, session)) {
          scheduleGlobalSessionUpdate(scopeKey, session)
        } else {
          pendingGlobalSessionUpdates.delete(pendingKey(scopeKey, session.id))
          useGlobalSessionsStore.getState().upsertSession(session)
          streamPerfCount("ui.global_sessions.event_update_immediate")
        }
      }
    }
    return
  }

  if (payload.type === "session.deleted") {
    const sessionID = (payload as { properties?: { sessionID?: string } }).properties?.sessionID ?? getSessionInfoFromPayload(payload)?.id
    if (sessionID) {
      pendingGlobalSessionUpdates.delete(pendingKey(scopeKey, sessionID))
      useGlobalSessionsStore.getState().removeSessions([sessionID])
    }
  }
}
