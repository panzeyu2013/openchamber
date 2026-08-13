import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import type { ProjectEntry } from "@/lib/api/types"
import type { WorktreeMetadata } from "@/types/worktree"
import { resolveProjectForSessionDirectory } from "@/lib/projectResolution"
import { useConfigStore } from "@/stores/useConfigStore"
import { useSessionUIStore } from "../session-ui-store"
import { clearSyncRefs, setSyncRefs } from "../sync-refs"
import { setActionRefs, createSession } from "../session-actions"

// Recorded call info
const setCurrentSessionCalls: Array<{ id: string | null; directoryHint: string | null | undefined }> = []
const registerSessionDirectoryCalls: Array<{ sessionID: string; directory: string }> = []
const markSessionAsOpenChamberCreatedCalls: string[] = []

// Configurable service.createSession — set per test. The service is injected
// through setActionRefs (never mock.module, which is process-global and leaks
// into other sync test files).
let nextCreateSessionResponse: Session = { id: "ses_default", time: { created: 1 } } as Session
let nextCreateSessionCalls: Array<{ params: unknown; directory: string | null | undefined }> = []

// Configurable current directory (used as fallback when no directoryOverride is set)
let currentDirectory: string | null = null

const mockService = {
  getDirectory: () => currentDirectory,
  setDirectory: mock(() => undefined),
  createSession: mock(async (params: unknown, directory?: string | null) => {
    nextCreateSessionCalls.push({ params, directory })
    return nextCreateSessionResponse
  }),
}

// Real store members captured once so per-test recorders can be restored.
const realSessionUIState = useSessionUIStore.getState()
const initialConfigState = useConfigStore.getState()

beforeEach(() => {
  setCurrentSessionCalls.length = 0
  registerSessionDirectoryCalls.length = 0
  markSessionAsOpenChamberCreatedCalls.length = 0
  nextCreateSessionCalls = []
  nextCreateSessionResponse = { id: "ses_default", time: { created: 1 } } as Session
  currentDirectory = null

  useConfigStore.setState({ isConnected: true, hasEverConnected: true })
  useSessionUIStore.setState({
    setCurrentSession: (id: string | null, directoryHint?: string | null) => {
      setCurrentSessionCalls.push({ id, directoryHint })
    },
    markSessionAsOpenChamberCreated: (sessionId: string) => {
      markSessionAsOpenChamberCreatedCalls.push(sessionId)
    },
  })
  setSyncRefs(
    {} as never,
    { children: new Map(), ensureChild: () => ({}), getChild: () => undefined } as never,
    "",
    (sessionID: string, directory: string) => {
      registerSessionDirectoryCalls.push({ sessionID, directory })
    },
    mockService as never,
    "test-runtime",
  )

  // Initialize action refs. The first two args (sdk, childStores) are not
  // exercised by `createSession` itself, only the directory getter is.
  setActionRefs(
    {} as never,
    { children: new Map(), ensureChild: () => ({}), getChild: () => undefined } as never,
    () => currentDirectory ?? "",
    undefined,
    mockService as never,
  )
})

afterAll(() => {
  useConfigStore.setState({
    isConnected: initialConfigState.isConnected,
    hasEverConnected: initialConfigState.hasEverConnected,
  })
  useSessionUIStore.setState({
    setCurrentSession: realSessionUIState.setCurrentSession,
    markSessionAsOpenChamberCreated: realSessionUIState.markSessionAsOpenChamberCreated,
  })
  clearSyncRefs()
})

describe("issue #1637 — server omits directory, falls back to directoryOverride", () => {
  test("when server response omits directory and directoryOverride is set, setCurrentSession receives the directoryOverride (not null)", async () => {
    nextCreateSessionResponse = { id: "ses_1637_a", time: { created: 1 } } as Session

    const result = await createSession("test title", "/projects/alpha", null)

    expect(result?.id).toBe("ses_1637_a")
    expect(nextCreateSessionCalls).toHaveLength(1)
    expect(nextCreateSessionCalls[0].directory).toBe("/projects/alpha")
    expect(setCurrentSessionCalls).toHaveLength(1)
    expect(setCurrentSessionCalls[0]).toEqual({
      id: "ses_1637_a",
      directoryHint: "/projects/alpha",
    })
    // registerSessionDirectory is also called with the effective directory
    expect(registerSessionDirectoryCalls).toEqual([{ sessionID: "ses_1637_a", directory: "/projects/alpha" }])
  })
})

describe("issue #1637 — server returns directory, server value wins", () => {
  test("when server response includes directory and directoryOverride is set, setCurrentSession receives the server directory", async () => {
    nextCreateSessionResponse = {
      id: "ses_1637_b",
      time: { created: 1 },
      directory: "/projects/gamma",
    } as Session

    const result = await createSession("test title", "/projects/alpha", null)

    expect(result?.id).toBe("ses_1637_b")
    expect(setCurrentSessionCalls).toHaveLength(1)
    // Server's directory should take precedence over the override
    expect(setCurrentSessionCalls[0]).toEqual({
      id: "ses_1637_b",
      directoryHint: "/projects/gamma",
    })
    expect(registerSessionDirectoryCalls).toEqual([{ sessionID: "ses_1637_b", directory: "/projects/gamma" }])
  })
})

describe("issue #1637 — no directoryOverride, no server directory", () => {
  test("when no directoryOverride and server omits directory, setCurrentSession receives null", async () => {
    currentDirectory = null
    nextCreateSessionResponse = { id: "ses_1637_c", time: { created: 1 } } as Session

    const result = await createSession("test title", null, null)

    expect(result?.id).toBe("ses_1637_c")
    // Without any directory source, the call to opencodeClient.createSession
    // is made with undefined (dir() returned undefined).
    // dir() returns undefined when no current directory is set and no override is provided
    expect(nextCreateSessionCalls[0].directory == null).toBe(true)
    expect(setCurrentSessionCalls).toHaveLength(1)
    // Existing behavior preserved when no directory info is available anywhere
    expect(setCurrentSessionCalls[0]).toEqual({
      id: "ses_1637_c",
      directoryHint: null,
    })
    // registerSessionDirectory is not called when sessionDirectory is null
    expect(registerSessionDirectoryCalls).toHaveLength(0)
  })
})

describe("issue #1637 — no directoryOverride, server returns directory", () => {
  test("when no directoryOverride but server returns directory, setCurrentSession receives the server directory", async () => {
    currentDirectory = null
    nextCreateSessionResponse = {
      id: "ses_1637_d",
      time: { created: 1 },
      directory: "/projects/server-side",
    } as Session

    const result = await createSession("test title", null, null)

    expect(result?.id).toBe("ses_1637_d")
    expect(setCurrentSessionCalls).toHaveLength(1)
    expect(setCurrentSessionCalls[0]).toEqual({
      id: "ses_1637_d",
      directoryHint: "/projects/server-side",
    })
    expect(registerSessionDirectoryCalls).toEqual([
      { sessionID: "ses_1637_d", directory: "/projects/server-side" },
    ])
  })
})

describe("issue #2270 — nested Git projects: child directory wins when override is provided", () => {
  test("when creating a session with a directoryOverride pointing to a child project, the child project directory is used even when the server omits directory", async () => {
    // Simulate the situation where multiple child projects are registered
    // under a parent Git repo. The user is on a child project and clicks "+".
    // The server response omits the `directory` field.
    const childProjectDir = "/work/parent-git-repo/child-project-a"
    nextCreateSessionResponse = { id: "ses_2270_child", time: { created: 1 } } as Session

    const result = await createSession(undefined, childProjectDir, null)

    expect(result?.id).toBe("ses_2270_child")
    // The SDK should be called with the child project directory
    expect(nextCreateSessionCalls).toHaveLength(1)
    expect(nextCreateSessionCalls[0].directory).toBe(childProjectDir)
    // setCurrentSession receives the child project directory, not null
    expect(setCurrentSessionCalls).toHaveLength(1)
    expect(setCurrentSessionCalls[0]).toEqual({
      id: "ses_2270_child",
      directoryHint: childProjectDir,
    })
    // And it is NOT a different child project
    expect(setCurrentSessionCalls[0].directoryHint).not.toBe("/work/parent-git-repo/child-project-b")
    // The session is registered in the routing index under the correct directory
    expect(registerSessionDirectoryCalls).toEqual([
      { sessionID: "ses_2270_child", directory: childProjectDir },
    ])
  })
})

describe("issue #2270 — registered child project wins over a leaked ancestor worktree", () => {
  test("resolves a nested child repository directly instead of through a sibling project's ancestor worktree", () => {
    const projects = [
      { id: "project-a", path: "/project/project-a" },
      { id: "project-b", path: "/project/project-b" },
      { id: "project-c", path: "/project/project-c" },
    ] as ProjectEntry[]
    const leakedParentWorktree = {
      path: "/project",
      projectDirectory: "/project",
    } as WorktreeMetadata
    const availableWorktreesByProject = new Map<string, WorktreeMetadata[]>([
      ["/project/project-a", [leakedParentWorktree]],
    ])

    const resolved = resolveProjectForSessionDirectory(
      projects,
      availableWorktreesByProject,
      "/project/project-b/src",
    )

    expect(resolved?.id).toBe("project-b")
  })

  test("still resolves an external worktree through its owning project", () => {
    const projects = [
      { id: "project-a", path: "/project/project-a" },
      { id: "project-b", path: "/project/project-b" },
    ] as ProjectEntry[]
    const externalWorktree = {
      path: "/worktrees/project-b-feature",
      projectDirectory: "/project/project-b",
    } as WorktreeMetadata
    const availableWorktreesByProject = new Map<string, WorktreeMetadata[]>([
      ["/project/project-b", [externalWorktree]],
    ])

    const resolved = resolveProjectForSessionDirectory(
      projects,
      availableWorktreesByProject,
      "/worktrees/project-b-feature/src",
    )

    expect(resolved?.id).toBe("project-b")
  })
})

describe("issue #2270 — registerSessionDirectory called with effective directory", () => {
  test("registerSessionDirectory is called with the effective directory (not null or a stale value) when directoryOverride is set", async () => {
    // Server response omits directory; effectiveDirectory is the directoryOverride
    const effectiveDir = "/projects/alpha/subdir"
    nextCreateSessionResponse = { id: "ses_2270_reg", time: { created: 1 } } as Session

    await createSession("title", effectiveDir, null)

    expect(registerSessionDirectoryCalls).toHaveLength(1)
    expect(registerSessionDirectoryCalls[0]).toEqual({
      sessionID: "ses_2270_reg",
      directory: effectiveDir,
    })
    // Sanity: not null and not a stale value
    expect(registerSessionDirectoryCalls[0].directory).not.toBeNull()
    expect(registerSessionDirectoryCalls[0].directory).not.toBe("")
    // setCurrentSession and registerSessionDirectory must agree
    expect(setCurrentSessionCalls[0].directoryHint).toBe(effectiveDir)
  })

  test("registerSessionDirectory is called with the server's directory when the server returns one (server takes precedence over override)", async () => {
    const overrideDir = "/projects/alpha"
    const serverDir = "/projects/echoed-by-server"
    nextCreateSessionResponse = {
      id: "ses_2270_server",
      time: { created: 1 },
      directory: serverDir,
    } as Session

    await createSession("title", overrideDir, null)

    expect(registerSessionDirectoryCalls).toHaveLength(1)
    expect(registerSessionDirectoryCalls[0]).toEqual({
      sessionID: "ses_2270_server",
      directory: serverDir,
    })
    // Not the override (the server has authoritative info)
    expect(registerSessionDirectoryCalls[0].directory).not.toBe(overrideDir)
  })
})
