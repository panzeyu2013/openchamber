import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { togglePermissionAutoAccept } from "../../components/chat/permissionAutoAccept"
import { usePermissionStore } from "@/stores/permissionStore"
import { useConfigStore } from "@/stores/useConfigStore"
import { useSessionUIStore, materializeOpenDraftSession } from "../session-ui-store"
import { setActionRefs } from "../session-actions"
import { clearSyncRefs, setSyncRefs } from "../sync-refs"
import { useSessionWorktreeStore } from "../session-worktree-store"

const createSessionCalls: Array<{ title?: string; directory: string | null; parentID: string | null; metadata?: unknown }> = []
const permissionAutoAcceptCalls: Array<[string, boolean]> = []
let createdSessionDirectory: string | undefined

const getMockCalls = (fn: unknown): unknown[][] => ((fn as { mock?: { calls: unknown[][] } }).mock?.calls ?? [])

// The service is injected through setActionRefs (never mock.module, which is
// process-global and leaks into other sync test files): materializeOpenDraftSession
// routes createSession through actionService().
const mockService = {
  getDirectory: () => null,
  setDirectory: mock(() => undefined),
  createSession: mock(async (params: unknown, directory: string | null | undefined) => {
    const { title, parentID, metadata } = (params ?? {}) as { title?: string; parentID?: string | null; metadata?: unknown }
    createSessionCalls.push({ title, directory: directory ?? null, parentID: parentID ?? null, metadata })
    return { id: "ses_issue_2039", directory: createdSessionDirectory ?? directory }
  }),
}

// Real store members captured once so per-test recorders can be restored.
const realSessionUIState = useSessionUIStore.getState()
const realPermissionStoreState = usePermissionStore.getState()
const realWorktreeStoreState = useSessionWorktreeStore.getState()
const initialConfigState = useConfigStore.getState()

beforeEach(() => {
  createSessionCalls.length = 0
  permissionAutoAcceptCalls.length = 0
  createdSessionDirectory = undefined

  useConfigStore.setState({ isConnected: true, hasEverConnected: true })
  useSessionUIStore.setState({
    currentSessionId: null,
    currentSessionDirectory: null,
    newSessionDraft: {
      open: false,
      directoryOverride: null,
      parentID: null,
    },
  })
  usePermissionStore.setState({
    setSessionAutoAccept: mock(async (sessionId: string, enabled: boolean) => {
      permissionAutoAcceptCalls.push([sessionId, enabled])
    }),
  })
  useSessionWorktreeStore.setState({ attachments: new Map() })
  setSyncRefs(
    {} as never,
    { children: new Map(), ensureChild: () => ({}), getChild: () => undefined } as never,
    "",
    undefined,
    mockService as never,
    "test-runtime",
  )
  setActionRefs(
    {} as never,
    { children: new Map(), ensureChild: () => ({}), getChild: () => undefined } as never,
    () => "",
    undefined,
    mockService as never,
  )
})

afterAll(() => {
  useConfigStore.setState({
    isConnected: initialConfigState.isConnected,
    hasEverConnected: initialConfigState.hasEverConnected,
  })
  usePermissionStore.setState({ setSessionAutoAccept: realPermissionStoreState.setSessionAutoAccept })
  useSessionUIStore.setState({ newSessionDraft: realSessionUIState.newSessionDraft })
  useSessionWorktreeStore.setState({ attachments: realWorktreeStoreState.attachments })
  clearSyncRefs()
})

describe("issue 2039 draft auto-accept", () => {
  test("toggles draft state before a session exists", () => {
    const setDraftPermissionAutoAcceptEnabled = mock(() => undefined)
    const setSessionAutoAccept = mock(async () => undefined)
    const onOpenSessionFirst = mock(() => undefined)
    const onToggleFailed = mock(() => undefined)

    togglePermissionAutoAccept({
      permissionScopeSessionId: null,
      newSessionDraftOpen: true,
      draftPermissionAutoAcceptEnabled: false,
      permissionAutoAcceptEnabled: false,
      setDraftPermissionAutoAcceptEnabled,
      setSessionAutoAccept,
      onOpenSessionFirst,
      onToggleFailed,
    })

    expect(getMockCalls(setDraftPermissionAutoAcceptEnabled).length).toBe(1)
    expect(getMockCalls(setDraftPermissionAutoAcceptEnabled)[0]).toEqual([true])
    expect(getMockCalls(setSessionAutoAccept).length).toBe(0)
    expect(getMockCalls(onOpenSessionFirst).length).toBe(0)
    expect(getMockCalls(onToggleFailed).length).toBe(0)
  })

  test("guards the toggle when no draft is open", () => {
    const setDraftPermissionAutoAcceptEnabled = mock(() => undefined)
    const setSessionAutoAccept = mock(async () => undefined)
    const onOpenSessionFirst = mock(() => undefined)
    const onToggleFailed = mock(() => undefined)

    togglePermissionAutoAccept({
      permissionScopeSessionId: null,
      newSessionDraftOpen: false,
      draftPermissionAutoAcceptEnabled: false,
      permissionAutoAcceptEnabled: false,
      setDraftPermissionAutoAcceptEnabled,
      setSessionAutoAccept,
      onOpenSessionFirst,
      onToggleFailed,
    })

    expect(getMockCalls(setDraftPermissionAutoAcceptEnabled).length).toBe(0)
    expect(getMockCalls(setSessionAutoAccept).length).toBe(0)
    expect(getMockCalls(onOpenSessionFirst).length).toBe(1)
    expect(getMockCalls(onToggleFailed).length).toBe(0)
  })

  beforeEach(() => {
    createSessionCalls.length = 0
    permissionAutoAcceptCalls.length = 0
    createdSessionDirectory = undefined

    useSessionUIStore.setState({
      currentSessionId: null,
      currentSessionDirectory: null,
      newSessionDraft: {
        open: false,
        directoryOverride: null,
        parentID: null,
      },
    })
  })

  test("stores auto-accept in the draft and applies it when the session materializes", async () => {
    useSessionUIStore.getState().openNewSessionDraft()

    expect(useSessionUIStore.getState().newSessionDraft.permissionAutoAcceptEnabled).toBe(false)

    useSessionUIStore.getState().setDraftPermissionAutoAcceptEnabled(true)

    expect(useSessionUIStore.getState().newSessionDraft.permissionAutoAcceptEnabled).toBe(true)

    const result = await materializeOpenDraftSession({
      providerID: "provider",
      modelID: "model",
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(result?.sessionId).toBe("ses_issue_2039")
    expect(createSessionCalls).toHaveLength(1)
    expect(permissionAutoAcceptCalls).toEqual([["ses_issue_2039", true]])
    expect(useSessionUIStore.getState().currentSessionId).toBe("ses_issue_2039")
  })

  test("does not apply draft auto-accept after the draft is closed", async () => {
    useSessionUIStore.getState().openNewSessionDraft()
    useSessionUIStore.getState().setDraftPermissionAutoAcceptEnabled(true)
    useSessionUIStore.getState().closeNewSessionDraft()

    expect(useSessionUIStore.getState().newSessionDraft.open).toBe(false)
    expect(useSessionUIStore.getState().newSessionDraft.permissionAutoAcceptEnabled === undefined).toBe(true)

    const result = await materializeOpenDraftSession({
      providerID: "provider",
      modelID: "model",
    })

    expect(result).toBeNull()
    expect(createSessionCalls).toHaveLength(0)
    expect(permissionAutoAcceptCalls).toHaveLength(0)
  })

  test("uses the server-authoritative directory after worktree session creation", async () => {
    createdSessionDirectory = "/canonical/worktree"
    useSessionUIStore.getState().openNewSessionDraft({
      directoryOverride: "/requested/worktree",
    })

    const result = await materializeOpenDraftSession({
      providerID: "provider",
      modelID: "model",
    })

    expect(createSessionCalls[0]?.directory).toBe("/requested/worktree")
    expect(result?.directory).toBe("/canonical/worktree")
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe("/canonical/worktree")
  })

  test("routes the session by the canonical directory, not the requested worktree path", async () => {
    createdSessionDirectory = "/canonical/worktree"
    useSessionUIStore.getState().openNewSessionDraft({
      directoryOverride: "/requested/worktree",
    })

    const created = await materializeOpenDraftSession({
      providerID: "provider",
      modelID: "model",
    })
    const sessionId = created?.sessionId ?? ""

    // The worktree attachment still holds the path this client asked for. The
    // directory every send, queue key, and confirmation lookup is routed by
    // must be the canonical one the server returned.
    useSessionUIStore.getState().setWorktreeMetadata(sessionId, {
      path: "/requested/worktree",
      projectDirectory: "/repo",
      branch: "feature",
      label: "feature",
    })

    expect(useSessionUIStore.getState().getDirectoryForSession(sessionId)).toBe("/canonical/worktree")
  })
})
