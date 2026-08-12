/**
 * Scope-scoped pagination metadata shared with the session message loader.
 *
 * The scope is the workspace scope key in workspace mode and the ambient
 * runtime key otherwise (byte-identical keys in non-workspace mode), so
 * equal session IDs and directories in different workspaces never share
 * pagination state.
 */


type Meta = {
  limit: number
  cursor?: string
  complete: boolean
  at: number
}

const MAX_PREFETCH_ENTRIES = 200
const compositeKey = (scopeKey: string, directory: string, sessionID: string) =>
  `${scopeKey}\n${directory}\n${sessionID}`

const cache = new Map<string, Meta>()

export function getSessionPrefetch(directory: string, sessionID: string, scopeKey: string): Meta | undefined {
  const id = compositeKey(scopeKey, directory, sessionID)
  const value = cache.get(id)
  if (value) {
    cache.delete(id)
    cache.set(id, value)
  }
  return value
}

export function setSessionPrefetch(input: {
  directory: string
  sessionID: string
  limit: number
  cursor?: string
  complete: boolean
  at?: number
  scopeKey?: string
}) {
  const id = compositeKey(input.scopeKey ?? "", input.directory, input.sessionID)
  cache.delete(id)
  cache.set(id, {
    limit: input.limit,
    cursor: input.cursor,
    complete: input.complete,
    at: input.at ?? Date.now(),
  })
  while (cache.size > MAX_PREFETCH_ENTRIES) {
    const oldest = cache.keys().next().value
    if (!oldest) break
    cache.delete(oldest)
  }
}

/** Invalidate cache for specific sessions (e.g. after eviction). */
export function clearSessionPrefetch(directory: string, sessionIDs: Iterable<string>, scopeKey: string) {
  for (const sessionID of sessionIDs) {
    if (!sessionID) continue
    const id = compositeKey(scopeKey, directory, sessionID)
    cache.delete(id)
  }
}

export function clearDirectorySessionPrefetch(directory: string, scopeKey: string) {
  const prefix = `${scopeKey}\n${directory}\n`
  for (const id of cache.keys()) {
    if (id.startsWith(prefix)) cache.delete(id)
  }
}

/** Clears every entry under a scope (runtime key or workspace scope key). */
export function clearRuntimeSessionPrefetch(scopeKey: string) {
  const prefix = `${scopeKey}\n`
  for (const id of cache.keys()) {
    if (id.startsWith(prefix)) cache.delete(id)
  }
}
