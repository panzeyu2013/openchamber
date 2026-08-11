import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import type { Event, Session } from "@opencode-ai/sdk/v2/client"
import { useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { getRuntimeApiBaseUrl, switchRuntimeEndpoint } from "@/lib/runtime-switch"

const upsertedSessions: Session[] = []
const removedSessionIds: string[] = []
let boundScopeKey = "runtime-a"

// Real store members captured once so per-test recorders can be restored.
const realGlobalState = useGlobalSessionsStore.getState()
const initialRuntimeApiBaseUrl = getRuntimeApiBaseUrl()

// No mock.module here — registrations are process-global and leak into other
// sync test files. The tests override the real store's state/actions via
// setState and drive runtime changes through the real runtime-switch module.
beforeEach(() => {
  upsertedSessions.length = 0
  removedSessionIds.length = 0
  boundScopeKey = "runtime-a"
  switchRuntimeEndpoint({ apiBaseUrl: "http://sync-events-a.test", runtimeKey: "runtime-a" })
  useGlobalSessionsStore.setState({
    scopeKey: boundScopeKey,
    activeSessions: [],
    archivedSessions: [],
    upsertSession: (session: Session) => {
      upsertedSessions.push(session)
    },
    upsertSessions: (sessions: Session[]) => {
      upsertedSessions.push(...sessions)
    },
    removeSessions: (ids: Iterable<string>) => {
      removedSessionIds.push(...ids)
    },
  })
})

afterAll(() => {
  useGlobalSessionsStore.setState({
    scopeKey: realGlobalState.scopeKey,
    activeSessions: realGlobalState.activeSessions,
    archivedSessions: realGlobalState.archivedSessions,
    upsertSession: realGlobalState.upsertSession,
    upsertSessions: realGlobalState.upsertSessions,
    removeSessions: realGlobalState.removeSessions,
  })
  switchRuntimeEndpoint({ apiBaseUrl: initialRuntimeApiBaseUrl })
})

import { applySessionEventToGlobalSessions } from "../session-event-router"

const buildSession = (title: string, time: Session["time"]): Session => ({
  id: "ses_1",
  title,
  time,
} as Session)

const buildEvent = (session: Session): Event => ({
  type: "session.updated",
  properties: {
    info: session,
  },
} as Event)

const buildDeleteEvent = (sessionId: string): Event => ({
  type: "session.deleted",
  properties: { sessionID: sessionId },
} as Event)

const buildLifecycleEvent = (type: "session.idle" | "session.error", sessionId: string): Event => ({
  type,
  properties: { sessionID: sessionId },
} as Event)

describe("applySessionEventToGlobalSessions", () => {
  beforeEach(() => {
    boundScopeKey = "runtime-a"
    useGlobalSessionsStore.setState({
      scopeKey: boundScopeKey,
      activeSessions: [],
      archivedSessions: [],
    })
    upsertedSessions.length = 0
    removedSessionIds.length = 0
  })

  test("skips stale global session.updated echoes after a newer rename", () => {
    useGlobalSessionsStore.setState({ activeSessions: [buildSession("New Title", { created: 1, updated: 20 })] })

    applySessionEventToGlobalSessions(buildEvent(buildSession("Old Title", { created: 1, updated: 10 })))

    expect(upsertedSessions).toEqual([])
  })

  test("commits only the latest recency update when a session becomes idle", () => {
    useGlobalSessionsStore.setState({ activeSessions: [buildSession("Initial", { created: 1, updated: 10 })] })

    applySessionEventToGlobalSessions(buildEvent(buildSession("Initial", { created: 1, updated: 20 })))
    applySessionEventToGlobalSessions(buildEvent(buildSession("Initial", { created: 1, updated: 30 })))

    expect(upsertedSessions).toEqual([])
    applySessionEventToGlobalSessions(buildLifecycleEvent("session.idle", "ses_1"))
    expect(upsertedSessions.map((session) => session.time.updated)).toEqual([30])
  })

  test("applies substantive session updates immediately", () => {
    useGlobalSessionsStore.setState({ activeSessions: [buildSession("Initial", { created: 1, updated: 10 })] })

    applySessionEventToGlobalSessions(buildEvent(buildSession("Renamed", { created: 1, updated: 20 })))

    expect(upsertedSessions.map((session) => session.title)).toEqual(["Renamed"])
  })

  test("cancels a pending global update when the session is deleted", () => {
    useGlobalSessionsStore.setState({ activeSessions: [buildSession("Initial", { created: 1, updated: 10 })] })

    applySessionEventToGlobalSessions(buildEvent(buildSession("Initial", { created: 1, updated: 20 })))
    applySessionEventToGlobalSessions(buildDeleteEvent("ses_1"))
    applySessionEventToGlobalSessions(buildLifecycleEvent("session.idle", "ses_1"))

    expect(upsertedSessions).toEqual([])
    expect(removedSessionIds).toEqual(["ses_1"])
  })

  test("discards pending global updates when the runtime changes", () => {
    useGlobalSessionsStore.setState({ activeSessions: [buildSession("Initial", { created: 1, updated: 10 })] })
    applySessionEventToGlobalSessions(buildEvent(buildSession("Initial", { created: 1, updated: 20 })))

    // The pending update is keyed by the scope it was captured under; the
    // lifecycle event after the switch resolves a different scope key, so the
    // stale pending update is never committed.
    switchRuntimeEndpoint({ apiBaseUrl: "http://sync-events-b.test", runtimeKey: "runtime-b" })
    applySessionEventToGlobalSessions(buildLifecycleEvent("session.idle", "ses_1"))

    expect(upsertedSessions).toEqual([])
  })

  test("ignores events captured for another workspace scope", () => {
    boundScopeKey = "workspace:current"
    useGlobalSessionsStore.setState({
      scopeKey: boundScopeKey,
      activeSessions: [buildSession("Initial", { created: 1, updated: 10 })],
    })

    applySessionEventToGlobalSessions(
      buildEvent(buildSession("Foreign", { created: 1, updated: 20 })),
      "workspace:foreign",
    )

    expect(upsertedSessions).toEqual([])
    expect(removedSessionIds).toEqual([])
  })
})
