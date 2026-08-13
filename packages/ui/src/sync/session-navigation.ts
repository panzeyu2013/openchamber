import { getSyncScopeKey } from './sync-refs'
import { projectIdFromScopeKey } from '@/projects/identity'

type SessionOpener = (sessionID: string, directory: string, projectId?: string | null) => void

let sessionOpener: SessionOpener | null = null

export const setSessionOpener = (opener: SessionOpener | null) => {
  sessionOpener = opener
}

export const openSessionFromToast = (sessionID: string, directory: string, projectId?: string | null) => {
  const resolvedProjectId = projectId ?? projectIdFromScopeKey(getSyncScopeKey())
  sessionOpener?.(sessionID, directory, resolvedProjectId)
}
