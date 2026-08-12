import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { persistSessions, readDirCache } from "./persist-cache"
import { getSyncPerformanceDiagnostics, setSyncPerformanceDiagnosticsEnabled } from "./performance-diagnostics"

class TestStorage implements Storage {
  readonly values = new Map<string, string>()
  maxValueLength = Number.POSITIVE_INFINITY
  writes = 0

  get length(): number {
    return this.values.size
  }

  clear(): void {
    this.values.clear()
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    if (value.length > this.maxValueLength) throw new DOMException("Quota exceeded", "QuotaExceededError")
    this.writes += 1
    this.values.set(key, value)
  }
}

const originalLocalStorage = globalThis.localStorage
const directory = "/repo"
let storage: TestStorage
const waitForPersistence = () => new Promise((resolve) => setTimeout(resolve, 70))

const session = (
  index: number,
  updated: number,
  title = `Session ${index}`,
  sessionDirectory = directory,
): Session => ({
  id: `ses_${String(index).padStart(3, "0")}`,
  projectID: "project",
  directory: sessionDirectory,
  title,
  version: "1",
  time: { created: updated - 1, updated },
} as Session)

const scopeA = "workspace:ws-a"
const scopeB = "workspace:ws-b"

beforeEach(() => {
  storage = new TestStorage()
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage })
})

afterEach(() => {
  setSyncPerformanceDiagnosticsEnabled(false)
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: originalLocalStorage })
})

describe("persisted directory sessions", () => {
  test("keeps the 50 most recently updated sessions across restart reads", async () => {
    const sessions = Array.from({ length: 60 }, (_, updated) => session(59 - updated, updated))

    persistSessions(directory, sessions, scopeA)
    await waitForPersistence()

    const cached = readDirCache(directory, scopeA).sessions ?? []
    const cachedIds = new Set(cached.map((item) => item.id))
    const expectedIds = new Set(Array.from({ length: 50 }, (_, index) => session(index, index).id))
    expect(cached).toHaveLength(50)
    expect(cachedIds).toEqual(expectedIds)
  })

  test("persists authoritative empty as a tombstone under the scope key", async () => {
    persistSessions(directory, [session(1, 1)], scopeA)
    await waitForPersistence()
    expect(readDirCache(directory, scopeA).sessions).toEqual([session(1, 1)])

    persistSessions(directory, [], scopeA)

    expect(readDirCache(directory, scopeA).sessions).toEqual([])
  })

  test("replaces stale data with a smaller recent snapshot when quota is tight", async () => {
    persistSessions(directory, [session(1, 1, "old")], scopeA)
    await waitForPersistence()
    storage.maxValueLength = 700
    const sessions = Array.from({ length: 50 }, (_, index) => session(index + 10, index + 10, "x".repeat(80)))

    persistSessions(directory, sessions, scopeA)
    await waitForPersistence()

    const cached = readDirCache(directory, scopeA).sessions ?? []
    expect(cached.length).toBeGreaterThan(0)
    expect(cached.length).toBeLessThan(50)
    expect(cached.some((item) => item.title === "old")).toBe(false)
    expect(cached.map((item) => item.id)).toEqual(sessions.slice(-cached.length).map((item) => item.id))
  })

  test("isolates snapshots by workspace scope and directory", async () => {
    const otherDirectory = "/other-repo"
    persistSessions(directory, [session(1, 1, "scope A")], scopeA)
    persistSessions(otherDirectory, [session(2, 2, "other directory", otherDirectory)], scopeA)
    persistSessions(directory, [session(3, 3, "scope B")], scopeB)
    await waitForPersistence()

    expect(readDirCache(directory, scopeB).sessions?.map((item) => item.title)).toEqual(["scope B"])
    expect(readDirCache(directory, scopeA).sessions?.map((item) => item.title)).toEqual(["scope A"])
    expect(readDirCache(otherDirectory, scopeB).sessions).toBe(undefined)
    expect(readDirCache(otherDirectory, scopeA).sessions?.map((item) => item.title)).toEqual(["other directory"])
  })

  test("coalesces burst updates per scope and directory while serving the latest pending value", async () => {
    const writesBefore = storage.writes
    setSyncPerformanceDiagnosticsEnabled(true)

    for (let index = 0; index < 100; index += 1) {
      persistSessions(directory, [session(index, index)], scopeA)
    }

    expect(readDirCache(directory, scopeA).sessions?.[0]?.id).toBe(session(99, 99).id)
    expect(storage.writes).toBe(writesBefore)
    await waitForPersistence()
    expect(storage.writes - writesBefore).toBe(1)
    expect(readDirCache(directory, scopeA).sessions?.[0]?.id).toBe(session(99, 99).id)
    expect(getSyncPerformanceDiagnostics()?.persistenceSerializations).toBe(1)
    expect(getSyncPerformanceDiagnostics()?.persistenceStorageWrites).toBe(1)
  })

  test("writes authoritative empty immediately and prevents an older pending snapshot from returning", async () => {
    persistSessions(directory, [session(1, 1)], scopeA)
    persistSessions(directory, [], scopeA)

    expect(readDirCache(directory, scopeA).sessions).toEqual([])
    await waitForPersistence()
    expect(readDirCache(directory, scopeA).sessions).toEqual([])
  })

  test("a pending snapshot for another workspace scope never replaces the committed one", async () => {
    persistSessions(directory, [session(1, 1, "scope A")], scopeA)
    persistSessions(directory, [session(2, 2, "scope B")], scopeB)

    await waitForPersistence()
    expect(readDirCache(directory, scopeA).sessions?.map((item) => item.title)).toEqual(["scope A"])
    expect(readDirCache(directory, scopeB).sessions?.map((item) => item.title)).toEqual(["scope B"])
  })
})
