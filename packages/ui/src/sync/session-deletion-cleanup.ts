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
 * Every mounted sync scope is a workspace scope: the identity carries the
 * workspace scope key and the guard rejects an identity whose captured scope
 * does not match `workspaceScopeKey(workspaceId)`. Equal session IDs across
 * workspaces can therefore never clear each other's persisted state.
 */
export const cleanupPersistedSessionState = (identity: {
  /** Captured workspace scope key. Forwarded unchanged to the scope-keyed
   * stores. */
  runtimeKey: string;
  workspaceId?: string;
  directory: string;
  sessionId: string;
}): void => {
  if (!identity.directory || identity.directory === 'global' || !identity.sessionId) return;
  // The identity either names its workspace explicitly or already carries the
  // workspace scope key as its runtime key. Identities without a workspace
  // (unassigned sessions) resolve to the empty scope, so their cleanup can
  // never touch a workspace's persisted state.
  const scopeKey = identity.workspaceId
    ? workspaceScopeKey(identity.workspaceId)
    : workspaceIdFromScopeKey(identity.runtimeKey)
      ? identity.runtimeKey
      : '';
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
 * session index maps the (sessionId, directory) tuple to a workspace. An
 * identity without a workspace (unassigned session) carries the empty scope,
 * so its cleanup can never touch a workspace's persisted state.
 */
export const resolveSessionDeletionIdentity = (
  sessionId: string,
  directory: string | null | undefined,
  scopeKey: string,
): { runtimeKey: string; workspaceId?: string; directory: string; sessionId: string } => {
  const workspaceId = workspaceIdFromScopeKey(scopeKey);
  const targetDirectory = directory ?? 'global';
  return {
    runtimeKey: workspaceId ? scopeKey : '',
    ...(workspaceId ? { workspaceId } : {}),
    directory: targetDirectory,
    sessionId,
  };
};
