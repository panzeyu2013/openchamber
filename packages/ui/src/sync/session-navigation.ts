import { getSyncScopeKey } from './sync-refs'
import { workspaceIdFromScopeKey } from '@/workspaces/identity'

type SessionOpener = (sessionID: string, directory: string, workspaceId?: string | null) => void

let sessionOpener: SessionOpener | null = null

export const setSessionOpener = (opener: SessionOpener | null) => {
  sessionOpener = opener
}

export const openSessionFromToast = (sessionID: string, directory: string, workspaceId?: string | null) => {
  const resolvedWorkspaceId = workspaceId ?? workspaceIdFromScopeKey(getSyncScopeKey())
  sessionOpener?.(sessionID, directory, resolvedWorkspaceId)
}
