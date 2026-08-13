import { afterEach, describe, expect, test } from "bun:test"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { opencodeClient } from "@/lib/opencode/client"
import type { ChildStoreManager } from "./child-store"
import {
  clearSyncRefs,
  getSyncOpencodeService,
  getSyncScopeKey,
  getSyncSdk,
  setSyncRefs,
} from "./sync-refs"

const sdkA = {} as OpencodeClient
const sdkB = {} as OpencodeClient
const childStoresA = { children: new Map() } as unknown as ChildStoreManager
const childStoresB = { children: new Map() } as unknown as ChildStoreManager
const serviceA = {} as never
const serviceB = {} as never

afterEach(() => {
  clearSyncRefs()
})

describe("project-bound sync refs", () => {
  test("binds the service, SDK, and scope together", () => {
    setSyncRefs(sdkA, childStoresA, "/repo", undefined, serviceA, "project:ws-a")

    expect(getSyncSdk()).toBe(sdkA)
    expect(getSyncOpencodeService()).toBe(serviceA)
    expect(getSyncScopeKey()).toBe("project:ws-a")
  })

  test("an old provider cleanup cannot clear refs owned by a newer project", () => {
    setSyncRefs(sdkA, childStoresA, "/repo", undefined, serviceA, "project:ws-a")
    setSyncRefs(sdkB, childStoresB, "/repo", undefined, serviceB, "project:ws-b")

    clearSyncRefs(sdkA, childStoresA)

    expect(getSyncSdk()).toBe(sdkB)
    expect(getSyncOpencodeService()).toBe(serviceB)
    expect(getSyncScopeKey()).toBe("project:ws-b")

    clearSyncRefs(sdkB, childStoresB)
    expect(getSyncSdk()).toBeNull()
    expect(getSyncOpencodeService()).toBe(opencodeClient)
  })
})
