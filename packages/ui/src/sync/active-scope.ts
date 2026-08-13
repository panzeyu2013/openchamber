/**
 * Active sync scope key holder.
 *
 * Split out of `sync-refs.ts` so scope consumers (selection-store) can read
 * the mounted scope WITHOUT pulling the full sync-refs module graph
 * (opencode client, child stores) into their import chains. Written by
 * `setSyncRefs`/`clearSyncRefs` in sync-refs.ts; read here by scope-key
 * resolvers.
 */

let activeScopeKey: string | null = null

export function getActiveSyncScopeKey(): string {
  return activeScopeKey ?? ""
}

export function setActiveSyncScopeKey(value: string | null): void {
  activeScopeKey = value ?? null
}
