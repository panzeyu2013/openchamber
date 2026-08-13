import { afterEach, describe, expect, test } from "bun:test"
import {
  clearDirectorySessionPrefetch,
  clearRuntimeSessionPrefetch,
  getSessionPrefetch,
  setSessionPrefetch,
} from "./session-prefetch-cache"

const runtimes = ["prefetch-runtime-a", "prefetch-runtime-b"]

afterEach(() => {
  for (const runtimeKey of runtimes) clearRuntimeSessionPrefetch(runtimeKey)
})

describe("session prefetch cache", () => {
  test("isolates colliding directory and session IDs by runtime", () => {
    setSessionPrefetch({ directory: "/repo", sessionID: "session", limit: 10, complete: false, scopeKey: runtimes[0] })
    setSessionPrefetch({ directory: "/repo", sessionID: "session", limit: 20, complete: true, scopeKey: runtimes[1] })

    expect(getSessionPrefetch("/repo", "session", runtimes[0])?.limit).toBe(10)
    expect(getSessionPrefetch("/repo", "session", runtimes[1])?.limit).toBe(20)
  })

  test("isolates colliding directory and session IDs by project scope", () => {
    setSessionPrefetch({ directory: "/repo", sessionID: "session", limit: 10, complete: false, scopeKey: "project:ws-a" })
    setSessionPrefetch({ directory: "/repo", sessionID: "session", limit: 20, complete: true, scopeKey: "project:ws-b" })

    expect(getSessionPrefetch("/repo", "session", "project:ws-a")?.limit).toBe(10)
    expect(getSessionPrefetch("/repo", "session", "project:ws-b")?.limit).toBe(20)

    // Clearing one project scope never touches the other.
    clearDirectorySessionPrefetch("/repo", "project:ws-a")
    expect(getSessionPrefetch("/repo", "session", "project:ws-a")).toBe(undefined)
    expect(getSessionPrefetch("/repo", "session", "project:ws-b")?.limit).toBe(20)
  })

  test("prefetch reads are keyed by the explicit scope only (no ambient fallback)", () => {
    clearRuntimeSessionPrefetch("project:ws-a")
    clearRuntimeSessionPrefetch("project:ws-b")
    setSessionPrefetch({ directory: "/repo", sessionID: "session", limit: 30, complete: true, scopeKey: "project:ws-a" })
    expect(getSessionPrefetch("/repo", "session", "project:ws-a")?.limit).toBe(30)
    expect(getSessionPrefetch("/repo", "session", "project:ws-b")).toBe(undefined)
    clearRuntimeSessionPrefetch("project:ws-a")
    expect(getSessionPrefetch("/repo", "session", "project:ws-a")).toBe(undefined)
  })

  test("clears only the owning runtime and directory", () => {
    setSessionPrefetch({ directory: "/repo-a", sessionID: "session", limit: 10, complete: false, scopeKey: runtimes[0] })
    setSessionPrefetch({ directory: "/repo-b", sessionID: "session", limit: 20, complete: false, scopeKey: runtimes[0] })
    setSessionPrefetch({ directory: "/repo-a", sessionID: "session", limit: 30, complete: false, scopeKey: runtimes[1] })

    clearDirectorySessionPrefetch("/repo-a", runtimes[0])

    expect(getSessionPrefetch("/repo-a", "session", runtimes[0])).toBe(undefined)
    expect(getSessionPrefetch("/repo-b", "session", runtimes[0])?.limit).toBe(20)
    expect(getSessionPrefetch("/repo-a", "session", runtimes[1])?.limit).toBe(30)
  })

  test("bounds retained metadata globally", () => {
    for (let index = 0; index <= 200; index += 1) {
      setSessionPrefetch({
        directory: "/repo",
        sessionID: `session-${index}`,
        limit: index,
        complete: false,
        scopeKey: runtimes[0],
      })
    }

    expect(getSessionPrefetch("/repo", "session-0", runtimes[0])).toBe(undefined)
    expect(getSessionPrefetch("/repo", "session-200", runtimes[0])?.limit).toBe(200)
  })
})
