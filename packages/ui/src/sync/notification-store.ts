// ---------------------------------------------------------------------------
// Notification store — session turn-complete and error tracking
//
// Tracks session turn-complete and error notifications with viewed/unviewed
// state. Replaces the old sessionAttentionStates polling system.
// ---------------------------------------------------------------------------

import { create } from "zustand"
import { projectSessionKey } from "@/projects/identity"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type NotificationBase = {
  /** Explicit project identity for unified-project sessions. */
  projectId?: string
  directory?: string
  session?: string
  time: number
  viewed: boolean
}

type TurnCompleteNotification = NotificationBase & {
  type: "turn-complete"
}

type ErrorNotification = NotificationBase & {
  type: "error"
  error?: { message?: string; code?: string }
}

export type Notification = TurnCompleteNotification | ErrorNotification

type NotificationIndex = {
  session: {
    unseenCount: Record<string, number>
    unseenHasError: Record<string, boolean>
  }
  project: {
    unseenCount: Record<string, number>
    unseenHasError: Record<string, boolean>
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_NOTIFICATIONS = 500
const NOTIFICATION_TTL_MS = 1000 * 60 * 60 * 24 * 30 // 30 days

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pruneNotifications(list: Notification[]): Notification[] {
  const cutoff = Date.now() - NOTIFICATION_TTL_MS
  const pruned = list.filter((n) => n.time >= cutoff)
  if (pruned.length <= MAX_NOTIFICATIONS) return pruned
  return pruned.slice(pruned.length - MAX_NOTIFICATIONS)
}

function buildIndex(list: Notification[]): NotificationIndex {
  const index: NotificationIndex = {
    session: { unseenCount: {}, unseenHasError: {} },
    project: { unseenCount: {}, unseenHasError: {} },
  }

  for (const n of list) {
    if (n.viewed) continue

    if (n.session) {
      const key = getNotificationSessionKey(n.session, n.projectId)
      index.session.unseenCount[key] = (index.session.unseenCount[key] ?? 0) + 1
      if (n.type === "error") index.session.unseenHasError[key] = true
    }
    if (n.directory) {
      index.project.unseenCount[n.directory] = (index.project.unseenCount[n.directory] ?? 0) + 1
      if (n.type === "error") index.project.unseenHasError[n.directory] = true
    }
  }

  return index
}

/**
 * Returns the collision-safe notification key for a session. Bare session
 * IDs remain readable for legacy ambient-runtime notifications; project
 * notifications always use the same composite identity as Session Index.
 */
export const getNotificationSessionKey = (sessionId: string, projectId?: string | null): string => {
  const normalizedProjectId = typeof projectId === "string" ? projectId.trim() : ""
  return normalizedProjectId ? projectSessionKey(normalizedProjectId, sessionId) : sessionId
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface NotificationStore {
  list: Notification[]
  index: NotificationIndex

  // Mutations
  append: (notification: Notification) => void
  markSessionViewed: (sessionId: string, projectId?: string | null) => void
  markProjectViewed: (directory: string) => void

  // Selectors
  sessionUnseenCount: (sessionId: string, projectId?: string | null) => number
  sessionHasError: (sessionId: string, projectId?: string | null) => boolean
  projectUnseenCount: (directory: string) => number
  projectHasError: (directory: string) => boolean
}

export const useNotificationStore = create<NotificationStore>((set, get) => ({
  list: [],
  index: {
    session: { unseenCount: {}, unseenHasError: {} },
    project: { unseenCount: {}, unseenHasError: {} },
  },

  append: (notification) => {
    const current = get().list
    const next = pruneNotifications([...current, notification])
    set({ list: next, index: buildIndex(next) })
  },

  markSessionViewed: (sessionId, projectId) => {
    const current = get()
    const key = getNotificationSessionKey(sessionId, projectId)
    const count = current.index.session.unseenCount[key] ?? 0
    if (count === 0) return

    const next = current.list.map((n) =>
      n.session === sessionId
        && getNotificationSessionKey(n.session, n.projectId) === key
        && !n.viewed
        ? { ...n, viewed: true }
        : n,
    )
    set({ list: next, index: buildIndex(next) })
  },

  markProjectViewed: (directory) => {
    const current = get()
    const count = current.index.project.unseenCount[directory] ?? 0
    if (count === 0) return

    const next = current.list.map((n) =>
      n.directory === directory && !n.viewed ? { ...n, viewed: true } : n,
    )
    set({ list: next, index: buildIndex(next) })
  },

  sessionUnseenCount: (sessionId, projectId) => get().index.session.unseenCount[getNotificationSessionKey(sessionId, projectId)] ?? 0,
  sessionHasError: (sessionId, projectId) => get().index.session.unseenHasError[getNotificationSessionKey(sessionId, projectId)] ?? false,
  projectUnseenCount: (directory) => get().index.project.unseenCount[directory] ?? 0,
  projectHasError: (directory) => get().index.project.unseenHasError[directory] ?? false,
}))

// ---------------------------------------------------------------------------
// Imperative API for non-React code (event handler in sync-context)
// ---------------------------------------------------------------------------

export function appendNotification(notification: Notification) {
  useNotificationStore.getState().append(notification)
}

export function markSessionViewed(sessionId: string, projectId?: string | null) {
  useNotificationStore.getState().markSessionViewed(sessionId, projectId)
}

// ---------------------------------------------------------------------------
// React hooks for fine-grained subscriptions
// ---------------------------------------------------------------------------

export function useSessionUnseenCount(sessionId: string, projectId?: string | null): number {
  const key = getNotificationSessionKey(sessionId, projectId)
  return useNotificationStore((s) => s.index.session.unseenCount[key] ?? 0)
}
