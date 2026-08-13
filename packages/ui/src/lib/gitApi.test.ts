import { describe, expect, test } from "bun:test"
import type { GitAPI, GitStatus } from "./api/types"
import {
  getGitStatus,
  generateCommitMessage,
  generatePullRequestDescription,
  resolveGitPrimaryRoot,
  resolveGitTopLevel,
  stageGitFile,
  stageGitFiles,
  unstageGitFile,
  unstageGitFiles,
} from "./gitApi"

const status: GitStatus = {
  current: "main",
  tracking: null,
  ahead: 0,
  behind: 0,
  files: [],
  isClean: true,
}

const withRuntimeGit = async (git: GitAPI, callback: () => Promise<void>) => {
  const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __OPENCHAMBER_RUNTIME_APIS__: { git },
    },
  })

  try {
    await callback()
  } finally {
    if (previousWindowDescriptor) {
      Object.defineProperty(globalThis, "window", previousWindowDescriptor)
    } else {
      delete (globalThis as { window?: Window }).window
    }
  }
}

describe("getGitStatus", () => {
  test("forwards light-mode options to runtime git APIs", async () => {
    let received: { directory: string; options?: { mode?: "light" } } | null = null
    const runtimeGit = {
      getGitStatus: async (directory: string, options?: { mode?: "light" }) => {
        received = { directory, options }
        return status
      },
    } as Partial<GitAPI> as GitAPI

    await withRuntimeGit(runtimeGit, async () => {
      await getGitStatus("/repo", { mode: "light" })
    })

    expect(received).toEqual({ directory: "/repo", options: { mode: "light" } })
  })
})

describe("project-bound git root resolution", () => {
  test("forwards primary-root resolution to the bound runtime API", async () => {
    let received: string | null = null
    const runtimeGit = {
      resolveGitPrimaryRoot: async (directory: string) => {
        received = directory
        return { root: "/project/root" }
      },
    } as Partial<GitAPI> as GitAPI

    await withRuntimeGit(runtimeGit, async () => {
      const result = await resolveGitPrimaryRoot("/project/root/feature")
      expect(result).toBe("/project/root")
    })

    expect(received).toBe("/project/root/feature")
  })

  test("forwards worktree toplevel resolution to the bound runtime API", async () => {
    let received: string | null = null
    const runtimeGit = {
      resolveGitTopLevel: async (directory: string) => {
        received = directory
        return { root: "/project/root/feature" }
      },
    } as Partial<GitAPI> as GitAPI

    await withRuntimeGit(runtimeGit, async () => {
      const result = await resolveGitTopLevel("/project/root/feature/src")
      expect(result).toBe("/project/root/feature")
    })

    expect(received).toBe("/project/root/feature/src")
  })
})

describe("project-bound git generation", () => {
  test("routes commit generation through the registered runtime adapter", async () => {
    let received: { directory: string; files: string[]; options?: { providerId?: string } } | null = null
    const runtimeGit = {
      generateCommitMessage: async (directory: string, files: string[], options?: { providerId?: string }) => {
        received = { directory, files, options }
        return { message: { subject: "project commit", highlights: [] } }
      },
    } as Partial<GitAPI> as GitAPI

    await withRuntimeGit(runtimeGit, async () => {
      const result = await generateCommitMessage("/remote/project", ["src/app.ts"], { providerId: "provider" })
      expect(result.message.subject).toBe("project commit")
    })

    expect(received).toEqual({
      directory: "/remote/project",
      files: ["src/app.ts"],
      options: { providerId: "provider" },
    })
  })

  test("routes pull-request generation through the registered runtime adapter", async () => {
    let received: { directory: string; payload: { base: string; head: string; context?: string } } | null = null
    const runtimeGit = {
      generatePullRequestDescription: async (
        directory: string,
        payload: { base: string; head: string; context?: string },
      ) => {
        received = { directory, payload }
        return { title: "project PR", body: "Generated remotely" }
      },
    } as Partial<GitAPI> as GitAPI

    await withRuntimeGit(runtimeGit, async () => {
      const result = await generatePullRequestDescription("/remote/project", {
        base: "main",
        head: "feature",
        context: "release",
      })
      expect(result.title).toBe("project PR")
    })

    expect(received).toEqual({
      directory: "/remote/project",
      payload: { base: "main", head: "feature", context: "release" },
    })
  })
})

describe("git index mutations", () => {
  test("forwards bulk stage requests to runtime git APIs", async () => {
    let received: { directory: string; paths: string[] } | null = null
    const runtimeGit = {
      stageGitFiles: async (directory: string, paths: string[]) => {
        received = { directory, paths }
      },
    } as Partial<GitAPI> as GitAPI

    await withRuntimeGit(runtimeGit, async () => {
      await stageGitFiles("/repo", ["a.ts", "b.ts"])
    })

    expect(received).toEqual({ directory: "/repo", paths: ["a.ts", "b.ts"] })
  })

  test("forwards bulk unstage requests to runtime git APIs", async () => {
    let received: { directory: string; paths: string[] } | null = null
    const runtimeGit = {
      unstageGitFiles: async (directory: string, paths: string[]) => {
        received = { directory, paths }
      },
    } as Partial<GitAPI> as GitAPI

    await withRuntimeGit(runtimeGit, async () => {
      await unstageGitFiles("/repo", ["a.ts", "b.ts"])
    })

    expect(received).toEqual({ directory: "/repo", paths: ["a.ts", "b.ts"] })
  })

  test("keeps single-file stage wrapper routed to runtime single-file API", async () => {
    let received: { directory: string; path: string } | null = null
    const runtimeGit = {
      stageGitFile: async (directory: string, path: string) => {
        received = { directory, path }
      },
    } as Partial<GitAPI> as GitAPI

    await withRuntimeGit(runtimeGit, async () => {
      await stageGitFile("/repo", "a.ts")
    })

    expect(received).toEqual({ directory: "/repo", path: "a.ts" })
  })

  test("keeps single-file unstage wrapper routed to runtime single-file API", async () => {
    let received: { directory: string; path: string } | null = null
    const runtimeGit = {
      unstageGitFile: async (directory: string, path: string) => {
        received = { directory, path }
      },
    } as Partial<GitAPI> as GitAPI

    await withRuntimeGit(runtimeGit, async () => {
      await unstageGitFile("/repo", "a.ts")
    })

    expect(received).toEqual({ directory: "/repo", path: "a.ts" })
  })
})
