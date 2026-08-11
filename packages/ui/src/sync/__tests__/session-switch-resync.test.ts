import { describe, expect, test, beforeEach, mock, afterAll } from "bun:test"
import { create, type StoreApi } from "zustand"
import type { Event, PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2/client"
import { useTodosPersistStore } from "@/stores/useTodosPersistStore"

const listPendingQuestionsCalls: Array<{ directories: Array<string | null> }> = []
const listPendingPermissionsCalls: Array<{ directories: Array<string | null> }> = []
const todoPersistWrites: Array<{ directory: string; sessionID: string; todos: unknown }> = []
let pendingQuestionsResponse: QuestionRequest[] = []
let pendingPermissionsResponse: PermissionRequest[] = []
let pendingQuestionsShouldThrow = false
let pendingPermissionsShouldThrow = false

// The resync paths route through the SDK client passed to
// resyncBlockingRequestsForDirectory — an injected test double that never
// touches the module registry (mock.module is process-global and leaks into
// other sync test files).
const stubSdk = {
  question: {
    list: mock(async (params?: { directory?: string }) => {
      listPendingQuestionsCalls.push({ directories: [params?.directory ?? null] })
      if (pendingQuestionsShouldThrow) throw new Error("question.list failed: simulated")
      return { data: pendingQuestionsResponse }
    }),
  },
  permission: {
    list: mock(async (params?: { directory?: string }) => {
      listPendingPermissionsCalls.push({ directories: [params?.directory ?? null] })
      if (pendingPermissionsShouldThrow) throw new Error("permission.list failed: simulated")
      return { data: pendingPermissionsResponse }
    }),
  },
}

const realTodosPersistState = useTodosPersistStore.getState()

afterAll(() => {
  useTodosPersistStore.setState({ setSessionTodos: realTodosPersistState.setSessionTodos })
})

import { INITIAL_STATE, type State } from "../types"
import { ChildStoreManager, type DirectoryStore } from "../child-store"
import { getRuntimeKey } from "@/lib/runtime-switch"
const {
  createEventRoutingIndex,
  handleEvent,
  resyncBlockingRequestsForDirectory,
  setActiveSession,
} = await import("../sync-context")

function buildQuestion(overrides: Partial<QuestionRequest> = {}): QuestionRequest {
  return {
    id: "que_1",
    sessionID: "ses_a",
    questions: [{ question: "Continue?", header: "Q", options: [{ label: "Yes", description: "" }] }],
    ...overrides,
  } as QuestionRequest
}

function buildPermission(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id: "perm_1",
    sessionID: "ses_a",
    permission: "bash",
    patterns: [],
    metadata: {},
    always: [],
    ...overrides,
  } as PermissionRequest
}

function createDirectoryStore(initial: Partial<State>): StoreApi<DirectoryStore> {
  return create<DirectoryStore>()((set) => ({
    ...INITIAL_STATE,
    ...initial,
    session: initial.session ?? [{ id: "ses_a", title: "ses_a", time: { created: 1, updated: 1 }, version: "1" } as State["session"][number]],
    patch: (partial) => set(partial),
    replace: (next) => set(next),
  }))
}

describe("resyncBlockingRequestsForDirectory", () => {
  beforeEach(() => {
    listPendingQuestionsCalls.length = 0
    listPendingPermissionsCalls.length = 0
    pendingQuestionsResponse = []
    pendingPermissionsResponse = []
    pendingQuestionsShouldThrow = false
    pendingPermissionsShouldThrow = false
    todoPersistWrites.length = 0
    useTodosPersistStore.setState({
      setSessionTodos: (directory: string, sessionID: string, todos: unknown) => {
        todoPersistWrites.push({ directory, sessionID, todos })
      },
    })
    setActiveSession("", "")
  })

  test("calls listPendingQuestions and listPendingPermissions exactly once for the directory", async () => {
    const store = createDirectoryStore({})
    pendingQuestionsResponse = [buildQuestion()]
    pendingPermissionsResponse = [buildPermission()]

    await resyncBlockingRequestsForDirectory("/repo", store, undefined, stubSdk as never)

    const scopedQuestionCalls = listPendingQuestionsCalls.filter((call) => call.directories.includes("/repo"))
    const scopedPermissionCalls = listPendingPermissionsCalls.filter((call) => call.directories.includes("/repo"))
    expect(scopedQuestionCalls).toHaveLength(1)
    expect(scopedQuestionCalls[0]).toEqual({ directories: ["/repo"] })
    expect(scopedPermissionCalls).toHaveLength(1)
    expect(scopedPermissionCalls[0]).toEqual({ directories: ["/repo"] })
  })

  test("merges newly fetched questions/permissions into the directory store", async () => {
    const store = createDirectoryStore({})
    pendingQuestionsResponse = [buildQuestion()]
    pendingPermissionsResponse = [buildPermission()]

    await resyncBlockingRequestsForDirectory("/repo", store, undefined, stubSdk as never)

    expect(store.getState().question["ses_a"]).toHaveLength(1)
    expect(store.getState().question["ses_a"]?.[0]?.id).toBe("que_1")
    expect(store.getState().permission["ses_a"]).toHaveLength(1)
    expect(store.getState().permission["ses_a"]?.[0]?.id).toBe("perm_1")
  })

  test("preserves an in-flight SSE-delivered question whose signature changed during the fetch", async () => {
    const store = createDirectoryStore({
      question: { ses_a: [{ ...buildQuestion(), id: "que_initial" }] },
    })
    pendingQuestionsResponse = []

    const promise = resyncBlockingRequestsForDirectory("/repo", store, undefined, stubSdk as never)
    store.setState({
      question: { ses_a: [{ ...buildQuestion(), id: "que_sse_arrived" }] },
    })
    await promise

    expect(store.getState().question["ses_a"]).toHaveLength(1)
    expect(store.getState().question["ses_a"]?.[0]?.id).toBe("que_sse_arrived")
  })

  test("clears stale entries when API returns no pending requests and signature unchanged", async () => {
    const store = createDirectoryStore({
      question: { ses_a: [{ ...buildQuestion(), id: "que_stale" }] },
    })
    pendingQuestionsResponse = []
    pendingPermissionsResponse = []

    await resyncBlockingRequestsForDirectory("/repo", store, undefined, stubSdk as never)

    expect(store.getState().question["ses_a"]).toEqual(undefined)
  })

  test("ignores questions for sessions the directory does not know about", async () => {
    const store = createDirectoryStore({})
    pendingQuestionsResponse = [{ ...buildQuestion(), sessionID: "ses_unknown" }]

    await resyncBlockingRequestsForDirectory("/repo", store, undefined, stubSdk as never)

    expect(store.getState().question["ses_unknown"]).toEqual(undefined)
  })

  test("returns early without fetching when no candidate sessions are known", async () => {
    const store = createDirectoryStore({ session: [] })
    await resyncBlockingRequestsForDirectory("/repo", store, undefined, stubSdk as never)
    expect(listPendingQuestionsCalls).toHaveLength(0)
    expect(listPendingPermissionsCalls).toHaveLength(0)
  })

  // Regression: prior to the fix, listPendingQuestions silently returned [] on
  // fetch failure, indistinguishable from a successful empty server response.
  // The resync then walked the candidate set and deleted any question that
  // wasn't in the (empty) result — wiping legitimate in-flight prompts on a
  // transient network blip. The client method now throws on failure and the
  // outer try/catch preserves existing state.
  test("preserves existing questions when listPendingQuestions throws (transient fetch failure)", async () => {
    const store = createDirectoryStore({
      question: { ses_a: [{ ...buildQuestion(), id: "que_in_flight" }] },
    })
    pendingQuestionsShouldThrow = true

    await resyncBlockingRequestsForDirectory("/repo", store, undefined, stubSdk as never)

    expect(store.getState().question["ses_a"]).toHaveLength(1)
    expect(store.getState().question["ses_a"]?.[0]?.id).toBe("que_in_flight")
  })

  test("preserves existing permissions when listPendingPermissions throws (transient fetch failure)", async () => {
    const store = createDirectoryStore({
      permission: { ses_a: [{ ...buildPermission(), id: "perm_in_flight" }] },
    })
    pendingPermissionsShouldThrow = true

    await resyncBlockingRequestsForDirectory("/repo", store, undefined, stubSdk as never)

    expect(store.getState().permission["ses_a"]).toHaveLength(1)
    expect(store.getState().permission["ses_a"]?.[0]?.id).toBe("perm_in_flight")
  })

  test("permission fetch failure does not block question resync (and vice versa)", async () => {
    const store = createDirectoryStore({})
    pendingQuestionsResponse = [buildQuestion()]
    pendingPermissionsShouldThrow = true

    await resyncBlockingRequestsForDirectory("/repo", store, undefined, stubSdk as never)

    // Question block ran successfully despite permission block failing.
    expect(store.getState().question["ses_a"]).toHaveLength(1)
    expect(store.getState().question["ses_a"]?.[0]?.id).toBe("que_1")
    // The permission list was attempted (unscoped + directory) before failing.
    expect(listPendingPermissionsCalls.some((call) => call.directories.includes("/repo"))).toBe(true)
  })

  test("routes a directory-less todo snapshot to its active session during a multi-store routing-index gap", () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild("/target", { bootstrap: false })
    childStores.ensureChild("/other", { bootstrap: false })
    const todos = [
      { content: "Finish plan", status: "completed", priority: "high" },
      { content: "Implement changes", status: "in_progress", priority: "high" },
    ]
    const event = {
      type: "todo.updated",
      properties: { sessionID: "ses_a", todos },
    } as Event
    const routingIndex = createEventRoutingIndex()

    expect(childStores.children.size).toBe(2)
    expect(routingIndex.sessionDirectoryById.size).toBe(0)
    for (const candidate of childStores.children.values()) {
      const state = candidate.getState()
      expect(state.session).toEqual([])
      expect(state.message.ses_a).toBe(undefined)
      expect(state.session_status.ses_a).toBe(undefined)
    }

    let storeWrites = 0
    const unsubscribe = store.subscribe(() => {
      storeWrites += 1
    })
    setActiveSession("/target", "ses_a")
    handleEvent("global", event, childStores, routingIndex, getRuntimeKey())

    expect(store.getState().todo.ses_a).toEqual(todos)
    expect(todoPersistWrites).toEqual([{ directory: "/target", sessionID: "ses_a", todos }])
    expect(storeWrites).toBe(1)

    const stateAfterFirstSnapshot = store.getState()
    const duplicateTodos = todos.map((todo) => ({ ...todo }))
    const duplicateEvent = {
      type: "todo.updated",
      properties: { sessionID: "ses_a", todos: duplicateTodos },
    } as Event
    expect(duplicateTodos).not.toBe(todos)
    expect(duplicateTodos).toEqual(todos)

    handleEvent("global", duplicateEvent, childStores, routingIndex, getRuntimeKey())

    expect(store.getState()).toBe(stateAfterFirstSnapshot)
    expect(todoPersistWrites).toEqual([{ directory: "/target", sessionID: "ses_a", todos }])
    expect(storeWrites).toBe(1)
    unsubscribe()
    childStores.disposeAll()
  })
})
