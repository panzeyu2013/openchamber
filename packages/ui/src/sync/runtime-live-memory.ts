import type { SessionStatus } from "@opencode-ai/sdk/v2/client"

export const LIVE_STATUS_TTL_MS = 15_000

type RuntimeLiveStatus = {
  scopeKey: string
  directory: string
  sessionId: string
  status: SessionStatus
  expiresAt: number
}

const liveStatusByScope = new Map<string, RuntimeLiveStatus>()

const keyFor = (scopeKey: string, directory: string) => `${scopeKey}\n${directory}`

export function rememberRuntimeLiveStatus(params: {
  scopeKey: string
  directory: string | null | undefined
  sessionId: string | null | undefined
  status: SessionStatus | null | undefined
}) {
  if (!params.scopeKey || !params.directory || !params.sessionId || !params.status) return
  if (params.status.type === "idle") return

  // Evict expired entries on write so keys that are never read again don't
  // accumulate (reads are lazy and only prune their own key).
  const now = Date.now()
  for (const [key, entry] of liveStatusByScope) {
    if (entry.expiresAt <= now) liveStatusByScope.delete(key)
  }

  liveStatusByScope.set(keyFor(params.scopeKey, params.directory), {
    scopeKey: params.scopeKey,
    directory: params.directory,
    sessionId: params.sessionId,
    status: params.status,
    expiresAt: Date.now() + LIVE_STATUS_TTL_MS,
  })
}

export function getRuntimeLiveStatusSeed(scopeKey: string, directory: string): RuntimeLiveStatus | null {
  const entry = liveStatusByScope.get(keyFor(scopeKey, directory))
  if (!entry) return null
  if (entry.expiresAt <= Date.now()) {
    liveStatusByScope.delete(keyFor(scopeKey, directory))
    return null
  }
  return entry
}
