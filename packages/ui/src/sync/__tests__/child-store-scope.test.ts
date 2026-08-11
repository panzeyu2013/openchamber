import { describe, expect, test } from "bun:test"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { ChildStoreManager } from "../child-store"
import { SessionMessageLoader } from "../session-message-loader"

describe("child store scope isolation", () => {
  test("equal directory paths in different scopes never share a child store", () => {
    const manager = new ChildStoreManager("ambient-runtime")
    const workspaceA = manager.ensureChild("/repo", { bootstrap: false, scopeKey: "workspace:ws-a" })
    const workspaceB = manager.ensureChild("/repo", { bootstrap: false, scopeKey: "workspace:ws-b" })
    const ambient = manager.ensureChild("/repo", { bootstrap: false, scopeKey: "ambient-runtime" })

    expect(workspaceA).not.toBe(workspaceB)
    expect(workspaceA).not.toBe(ambient)
    expect(workspaceB).not.toBe(ambient)

    // Same scope + same directory resolves to the SAME store (no duplicate
    // creation), so per-scope behavior is unchanged.
    expect(manager.ensureChild("/repo", { bootstrap: false, scopeKey: "workspace:ws-a" })).toBe(workspaceA)
    expect(manager.getChild("/repo", "workspace:ws-a")).toBe(workspaceA)
    expect(manager.getChild("/repo", "workspace:ws-b")).toBe(workspaceB)

    // entries() reports real directories, not composite keys.
    const directories = new Set(manager.entries().map(([directory]) => directory))
    expect(directories).toEqual(new Set(["/repo"]))

    manager.disposeAll()
  })

  test("the default scope is the manager scope (ambient runtime key in non-workspace mode)", () => {
    const manager = new ChildStoreManager("runtime-xyz")
    const store = manager.ensureChild("/repo", { bootstrap: false })
    expect(manager.getChild("/repo")).toBe(store)
    expect(manager.getChild("/repo", "runtime-xyz")).toBe(store)
    expect(manager.getChild("/repo", "runtime-other")).toBe(undefined)
    manager.disposeAll()
  })

  test("session message loader state is isolated per scope for equal directories and session IDs", async () => {
    const manager = new ChildStoreManager("ambient")
    const response = (messages: string[]) => ({
      data: messages.map((text, index) => ({
        info: { id: `msg-${index}`, sessionID: "session", role: "user", time: { created: index } },
        parts: [],
      })),
      response: { headers: { get: () => null } },
    })
    const createSdk = (texts: string[]): OpencodeClient => ({
      session: {
        messages: async () => response(texts),
      },
    } as unknown as OpencodeClient)

    const loaderA = new SessionMessageLoader(manager, { sdk: createSdk(["a"]), scopeKey: "workspace:ws-a" })
    const loaderB = new SessionMessageLoader(manager, { sdk: createSdk(["b"]), scopeKey: "workspace:ws-b" })

    const target = { directory: "/repo", sessionID: "session" }
    await loaderA.ensure(target)
    await loaderB.ensure(target)

    // Each loader materialized into ITS OWN child store despite the equal
    // directory + session ID.
    expect(manager.getChild("/repo", "workspace:ws-a")?.getState().message.session?.map((m) => m.id)).toEqual(["msg-0"])
    expect(manager.getChild("/repo", "workspace:ws-b")?.getState().message.session?.map((m) => m.id)).toEqual(["msg-0"])
    expect(manager.getChild("/repo", "workspace:ws-a")).not.toBe(manager.getChild("/repo", "workspace:ws-b"))

    expect(loaderA.getSnapshot(target).status).toBe("ready")
    expect(loaderB.getSnapshot(target).status).toBe("ready")
    expect(loaderA.getSnapshot(target)).not.toBe(loaderB.getSnapshot(target))

    loaderA.dispose()
    loaderB.dispose()
    manager.disposeAll()
  })
})
