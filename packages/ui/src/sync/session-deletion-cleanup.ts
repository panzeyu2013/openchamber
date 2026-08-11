import { getRuntimeKey } from '@/lib/runtime-switch';
import { workspaceScopeKey, workspaceIdFromScopeKey } from '@/workspaces/identity';
import { clearChatDraft, createChatDraftIdentity } from '@/lib/chatDraftPersistence';
import { createMessageQueueTarget, useMessageQueueStore } from '@/stores/messageQueueStore';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { useTodosPersistStore } from '@/stores/useTodosPersistStore';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { useSessionPinnedStore } from '@/stores/useSessionPinnedStore';

/**
 * Clears every persisted session-scoped UI bucket (queue, todos, folders,
 * inline drafts, pins, chat draft) for one deleted session identity.
 *
 * The identity carries the SCOPE the deletion belongs to: a workspace scope
 * key when `workspaceId` is present, the ambient runtime key otherwise. The
 * guard rejects an identity whose captured scope does not match the scope it
 * claims — for ambient identities that is the current runtime key (unchanged
 * behavior); for workspace identities the captured runtime key must equal
 * `workspaceScopeKey(workspaceId)`. Equal session IDs across workspaces or
 * runtimes can therefore never clear each other's persisted state.
 */
export const cleanupPersistedSessionState = (identity: {
  /** Captured scope key: workspace scope key in workspace mode, ambient
   * runtime key otherwise. Forwarded unchanged to the scope-keyed stores. */
  runtimeKey: string;
  workspaceId?: string;
  directory: string;
  sessionId: string;
}): void => {
  if (!identity.directory || identity.directory === 'global' || !identity.sessionId) return;
  const scopeKey = identity.workspaceId
    ? workspaceScopeKey(identity.workspaceId)
    : getRuntimeKey();
  if (identity.runtimeKey !== scopeKey) return;

  const queueTarget = createMessageQueueTarget(identity.sessionId, identity.directory, identity.runtimeKey);
  if (queueTarget) useMessageQueueStore.getState().clearQueue(queueTarget);
  useTodosPersistStore.getState().clearSessionTodos(identity.runtimeKey, identity.directory, identity.sessionId);
  useSessionFoldersStore.getState().removeSessionEverywhere(identity.runtimeKey, identity.sessionId);
  useInlineCommentDraftStore.getState().clearSessionDrafts(identity.runtimeKey, identity.directory, identity.sessionId);
  useSessionPinnedStore.getState().clearPinnedSession(identity.runtimeKey, identity.directory, identity.sessionId);
  const chatDraftIdentity = createChatDraftIdentity(identity.runtimeKey, identity.directory, identity.sessionId);
  if (chatDraftIdentity) clearChatDraft(chatDraftIdentity, true);
};

/**
 * Resolves the deletion identity for a session: the workspace scope when the
 * session index maps the (sessionId, directory) tuple to a workspace, the
 * ambient runtime key otherwise. Falls back to `fallbackRuntimeKey` (the
 * caller's captured ambient key) for non-workspace sessions so the legacy
 * stale-runtime guard stays intact.
 */
export const resolveSessionDeletionIdentity = (
  sessionId: string,
  directory: string | null | undefined,
  scopeKey: string,
  fallbackRuntimeKey: string,
): { runtimeKey: string; workspaceId?: string; directory: string; sessionId: string } => {
  const workspaceId = workspaceIdFromScopeKey(scopeKey);
  const targetDirectory = directory ?? 'global';
  return {
    runtimeKey: workspaceId ? scopeKey : fallbackRuntimeKey,
    ...(workspaceId ? { workspaceId } : {}),
    directory: targetDirectory,
    sessionId,
  };
};
