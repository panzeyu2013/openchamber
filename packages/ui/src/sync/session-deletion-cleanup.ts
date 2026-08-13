import { projectScopeKey, projectIdFromScopeKey } from '@/projects/identity';
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
 * Every mounted sync scope is a project scope: the identity carries the
 * project scope key and the guard rejects an identity whose captured scope
 * does not match `projectScopeKey(projectId)`. Equal session IDs across
 * projects can therefore never clear each other's persisted state.
 */
export const cleanupPersistedSessionState = (identity: {
  /** Captured project scope key. Forwarded unchanged to the scope-keyed
   * stores. */
  runtimeKey: string;
  projectId?: string;
  directory: string;
  sessionId: string;
}): void => {
  if (!identity.directory || identity.directory === 'global' || !identity.sessionId) return;
  // The identity either names its project explicitly or already carries the
  // project scope key as its runtime key. Identities without a project
  // (unassigned sessions) resolve to the empty scope, so their cleanup can
  // never touch a project's persisted state.
  const scopeKey = identity.projectId
    ? projectScopeKey(identity.projectId)
    : projectIdFromScopeKey(identity.runtimeKey)
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
 * Resolves the deletion identity for a session: the project scope when the
 * session index maps the (sessionId, directory) tuple to a project. An
 * identity without a project (unassigned session) carries the empty scope,
 * so its cleanup can never touch a project's persisted state.
 */
export const resolveSessionDeletionIdentity = (
  sessionId: string,
  directory: string | null | undefined,
  scopeKey: string,
): { runtimeKey: string; projectId?: string; directory: string; sessionId: string } => {
  const projectId = projectIdFromScopeKey(scopeKey);
  const targetDirectory = directory ?? 'global';
  return {
    runtimeKey: projectId ? scopeKey : '',
    ...(projectId ? { projectId } : {}),
    directory: targetDirectory,
    sessionId,
  };
};
