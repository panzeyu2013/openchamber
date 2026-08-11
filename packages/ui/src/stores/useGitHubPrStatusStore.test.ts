import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import type { GitHubPullRequestStatus, RuntimeAPIs } from "@/lib/api/types"
import { useSessionUIStore } from "@/sync/session-ui-store"
import { useWorkspaceSessionIndexStore } from "@/workspaces/session-index-store"
import type { WorkspaceSessionSnapshot } from "@/workspaces/types"

const realRuntimeSwitch = await import("@/lib/runtime-switch")
let runtimeKey = "runtime-a"
mock.module("@/lib/runtime-switch", () => ({
  ...realRuntimeSwitch,
  getRuntimeKey: () => runtimeKey,
}))

const { getGitHubPrStatusKey, useGitHubPrStatusStore } = await import("./useGitHubPrStatusStore")

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

const params = (github: RuntimeAPIs["github"], branch = "main") => ({
  directory: "/repo",
  branch,
  remoteName: "origin",
  canShow: true,
  github,
  githubAuthChecked: true,
  githubConnected: true,
})

describe("GitHub PR status cache ownership", () => {
  beforeEach(() => {
    runtimeKey = "runtime-a"
    useGitHubPrStatusStore.setState({ entries: {}, activeRequestCount: 0, totalRequestCount: 0 })
    useGitHubPrStatusStore.getState().resetForRuntimeSwitch()
  })

  test("keys colliding paths by runtime and requested remote", () => {
    const originA = getGitHubPrStatusKey("/repo", "main", "origin")
    const upstreamA = getGitHubPrStatusKey("/repo", "main", "upstream")
    runtimeKey = "runtime-b"
    const originB = getGitHubPrStatusKey("/repo", "main", "origin")

    expect(new Set([originA, upstreamA, originB]).size).toBe(3)
  })

  test("rejects a response after params change", async () => {
    const request = deferred<GitHubPullRequestStatus>()
    const github = { prStatus: () => request.promise } as unknown as RuntimeAPIs["github"]
    const key = getGitHubPrStatusKey("/repo", "main", "origin")
    useGitHubPrStatusStore.getState().ensureEntry(key)
    useGitHubPrStatusStore.getState().setParams(key, params(github))
    const loading = useGitHubPrStatusStore.getState().refresh(key, { force: true })

    useGitHubPrStatusStore.getState().setParams(key, params(github, "next"))
    request.resolve({ connected: true, pr: null })
    await loading

    expect(useGitHubPrStatusStore.getState().entries[key]?.status).toBe(null)
    expect(useGitHubPrStatusStore.getState().entries[key]?.isLoading).toBe(false)
  })

  test("rejects an old runtime response after reset", async () => {
    const request = deferred<GitHubPullRequestStatus>()
    const github = { prStatus: () => request.promise } as unknown as RuntimeAPIs["github"]
    const key = getGitHubPrStatusKey("/repo", "main", "origin")
    useGitHubPrStatusStore.getState().ensureEntry(key)
    useGitHubPrStatusStore.getState().setParams(key, params(github))
    const loading = useGitHubPrStatusStore.getState().refresh(key, { force: true })

    runtimeKey = "runtime-b"
    useGitHubPrStatusStore.getState().resetForRuntimeSwitch()
    request.resolve({ connected: true, pr: null })
    await loading

    expect(useGitHubPrStatusStore.getState().entries[key]?.status).toBe(null)
    expect(useGitHubPrStatusStore.getState().activeRequestCount).toBe(0)
  })

  test("throttles repeated non-forced refreshes after a failure", async () => {
    let requestCount = 0
    const github = {
      prStatus: async () => {
        requestCount += 1
        throw new Error("GitHub rate limited")
      },
    } as unknown as RuntimeAPIs["github"]
    const key = getGitHubPrStatusKey("/repo", "main", "origin")
    useGitHubPrStatusStore.getState().ensureEntry(key)
    useGitHubPrStatusStore.getState().setParams(key, params(github))

    await useGitHubPrStatusStore.getState().refresh(key)
    await useGitHubPrStatusStore.getState().refresh(key)

    expect(requestCount).toBe(1)
    expect(useGitHubPrStatusStore.getState().entries[key]?.error).toBe("GitHub rate limited")
  })

  test("does not throttle replacement params when a queued request becomes stale", async () => {
    const first = deferred<GitHubPullRequestStatus>()
    const second = deferred<GitHubPullRequestStatus>()
    let staleRequestCount = 0
    let replacementRequestCount = 0
    const firstGitHub = { prStatus: () => first.promise } as unknown as RuntimeAPIs["github"]
    const secondGitHub = { prStatus: () => second.promise } as unknown as RuntimeAPIs["github"]
    const staleGitHub = {
      prStatus: async () => {
        staleRequestCount += 1
        return { connected: true, pr: null }
      },
    } as unknown as RuntimeAPIs["github"]
    const replacementGitHub = {
      prStatus: async () => {
        replacementRequestCount += 1
        return { connected: true, pr: null }
      },
    } as unknown as RuntimeAPIs["github"]
    const firstKey = getGitHubPrStatusKey("/repo", "first", "origin")
    const secondKey = getGitHubPrStatusKey("/repo", "second", "origin")
    const queuedKey = getGitHubPrStatusKey("/repo", "queued", "origin")

    for (const [key, github, branch] of [
      [firstKey, firstGitHub, "first"],
      [secondKey, secondGitHub, "second"],
      [queuedKey, staleGitHub, "queued"],
    ] as const) {
      useGitHubPrStatusStore.getState().ensureEntry(key)
      useGitHubPrStatusStore.getState().setParams(key, params(github, branch))
    }

    const firstRefresh = useGitHubPrStatusStore.getState().refresh(firstKey, { force: true })
    const secondRefresh = useGitHubPrStatusStore.getState().refresh(secondKey, { force: true })
    const staleRefresh = useGitHubPrStatusStore.getState().refresh(queuedKey, { force: true })
    await Promise.resolve()
    useGitHubPrStatusStore.getState().setParams(queuedKey, params(replacementGitHub, "queued"))
    first.resolve({ connected: true, pr: null })
    second.resolve({ connected: true, pr: null })
    await Promise.all([firstRefresh, secondRefresh, staleRefresh])

    await useGitHubPrStatusStore.getState().refresh(queuedKey)

    expect(staleRequestCount).toBe(0)
    expect(replacementRequestCount).toBe(1)
  })

  test("rejects a server-cached response older than the held status", async () => {
    const newer: GitHubPullRequestStatus = {
      connected: true,
      fetchedAt: 2_000,
      pr: { number: 7, title: "t", url: "u", state: "open", draft: false, base: "main", head: "f" },
      checks: { state: "pending", total: 3, success: 2, failure: 0, pending: 1 },
    }
    const older: GitHubPullRequestStatus = {
      ...newer,
      fetchedAt: 1_000,
      checks: { state: "success", total: 3, success: 3, failure: 0, pending: 0 },
    }

    const responses = [newer, older]
    const github = { prStatus: async () => responses.shift()! } as unknown as RuntimeAPIs["github"]
    const key = getGitHubPrStatusKey("/repo", "main", "origin")
    useGitHubPrStatusStore.getState().ensureEntry(key)
    useGitHubPrStatusStore.getState().setParams(key, params(github))

    await useGitHubPrStatusStore.getState().refresh(key, { force: true })
    expect(useGitHubPrStatusStore.getState().entries[key]?.status?.checks?.pending).toBe(1)

    await useGitHubPrStatusStore.getState().refresh(key, { force: true })
    const held = useGitHubPrStatusStore.getState().entries[key]?.status
    expect(held?.fetchedAt).toBe(2_000)
    expect(held?.checks?.pending).toBe(1)
    expect(useGitHubPrStatusStore.getState().entries[key]?.isLoading).toBe(false)
  })
})

const makeSnapshot = (workspaceId: string): WorkspaceSessionSnapshot => {
  const upstreamSessionId = `ses-${workspaceId}`
  return {
    revision: 1,
    sessions: [{
      key: `${workspaceId}\u0000${upstreamSessionId}`,
      workspaceId,
      connectionId: "conn",
      upstreamSessionId,
      directory: "/repo",
      title: "title",
      updatedAt: 1,
      archived: false,
    }],
    freshnessByConnection: {},
  }
}

const setWorkspaceSession = (workspaceId: string) => {
  useWorkspaceSessionIndexStore.setState({ snapshot: makeSnapshot(workspaceId) })
  useSessionUIStore.setState({ currentSessionId: `ses-${workspaceId}`, currentSessionDirectory: "/repo" })
}

const clearWorkspaceSession = () => {
  useWorkspaceSessionIndexStore.setState({ snapshot: null })
  useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null })
}

describe("GitHub PR status workspace scope", () => {
  beforeEach(() => {
    runtimeKey = "runtime-a"
    useGitHubPrStatusStore.setState({ entries: {}, activeRequestCount: 0, totalRequestCount: 0 })
    useGitHubPrStatusStore.getState().resetForRuntimeSwitch()
    clearWorkspaceSession()
  })

  afterEach(clearWorkspaceSession)

  test("builds distinct keys per workspace for the same directory and branch", () => {
    setWorkspaceSession("ws-a")
    const keyA = getGitHubPrStatusKey("/repo", "main", "origin")
    setWorkspaceSession("ws-b")
    const keyB = getGitHubPrStatusKey("/repo", "main", "origin")
    expect(keyA).not.toBe(keyB)
    expect(JSON.parse(keyA)[0]).toBe("workspace:ws-a")
    expect(JSON.parse(keyB)[0]).toBe("workspace:ws-b")
  })

  test("keys stay byte-identical to runtime keys outside workspace mode", () => {
    const key = getGitHubPrStatusKey("/repo", "main", "origin")
    expect(key).toBe(JSON.stringify(["runtime-a", "/repo", "main", "origin"]))
  })

  test("does not serve one workspace cache to another", async () => {
    const request = deferred<GitHubPullRequestStatus>()
    const github = { prStatus: () => request.promise } as unknown as RuntimeAPIs["github"]

    setWorkspaceSession("ws-a")
    const keyA = getGitHubPrStatusKey("/repo", "main", "origin")
    useGitHubPrStatusStore.getState().ensureEntry(keyA)
    useGitHubPrStatusStore.getState().setParams(keyA, params(github))
    const loading = useGitHubPrStatusStore.getState().refresh(keyA, { force: true })
    request.resolve({ connected: true, pr: { number: 7, title: "t", url: "u", state: "open", draft: false, base: "main", head: "f" } })
    await loading

    setWorkspaceSession("ws-b")
    const keyB = getGitHubPrStatusKey("/repo", "main", "origin")
    expect(useGitHubPrStatusStore.getState().entries[keyB] ?? undefined).toBe(undefined)
    expect(useGitHubPrStatusStore.getState().entries[keyA]?.status?.pr?.number).toBe(7)
  })

  test("scope reset leaves unrelated workspace status intact", () => {
    const github = { prStatus: async () => ({ connected: true, pr: null }) } as unknown as RuntimeAPIs["github"]
    setWorkspaceSession("ws-a")
    const keyA = getGitHubPrStatusKey("/repo", "main", "origin")
    useGitHubPrStatusStore.getState().ensureEntry(keyA)
    useGitHubPrStatusStore.getState().setParams(keyA, params(github))
    useGitHubPrStatusStore.getState().updateStatus(keyA, () => ({
      connected: true,
      pr: { number: 11, title: "kept", url: "u", state: "open", draft: false, base: "main", head: "f" },
    }))

    setWorkspaceSession("ws-b")
    const keyB = getGitHubPrStatusKey("/repo", "main", "origin")
    useGitHubPrStatusStore.getState().ensureEntry(keyB)
    useGitHubPrStatusStore.getState().setParams(keyB, params(github))
    useGitHubPrStatusStore.getState().resetForRuntimeSwitch("workspace:ws-b")

    expect(useGitHubPrStatusStore.getState().entries[keyA]?.status?.pr?.number).toBe(11)
    expect(useGitHubPrStatusStore.getState().entries[keyB]?.params).toBe(null)
  })
})
