import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionWorktreeStore } from '@/sync/session-worktree-store';
import { getAttachedSessionDirectory } from '@/sync/session-worktree-contract';
import { useSessions } from '@/sync/sync-context';
import { useProjectRuntime } from '@/projects/project-runtime-context';
import { useActiveProjectId } from '@/projects/useActiveProject';
import type { Session } from '@opencode-ai/sdk/v2';

export const useChatSearchDirectory = (): string | undefined => {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const sessions = useSessions();
  const worktreeAttachment = useSessionWorktreeStore((state) =>
    currentSessionId ? state.getAttachment(currentSessionId) : undefined
  );
  const worktreeMap = useSessionUIStore((state) => state.worktreeMetadata);
  const newSessionDraft = useSessionUIStore((state) => state.newSessionDraft);

  const legacyActiveProjectId = useProjectsStore((state) => state.activeProjectId);
  const projects = useProjectsStore((state) => state.projects);

  const fallbackDirectory = useDirectoryStore((state) => state.currentDirectory);
  const { handle } = useProjectRuntime();
  const activeProjectId = useActiveProjectId();

  if (currentSessionId) {
    const attachmentDirectory = getAttachedSessionDirectory(worktreeAttachment);
    if (attachmentDirectory) {
      return attachmentDirectory;
    }
    const worktreeMetadata = worktreeMap.get(currentSessionId);
    if (worktreeMetadata?.path) {
      return worktreeMetadata.path;
    }

    type SessionWithDirectory = Session & { directory?: string };
    const currentSession = sessions.find((session) => session.id === currentSessionId) as SessionWithDirectory | undefined;
    if (currentSession?.directory) {
      return currentSession.directory;
    }
  }

  if (newSessionDraft?.open && (newSessionDraft.bootstrapPendingDirectory || newSessionDraft.directoryOverride)) {
    return (newSessionDraft.bootstrapPendingDirectory || newSessionDraft.directoryOverride) ?? undefined;
  }

  if (activeProjectId) {
    return handle?.directory ?? undefined;
  }

  if (legacyActiveProjectId) {
    const activeProject = projects.find((project) => project.id === legacyActiveProjectId);
    if (activeProject?.path) {
      return activeProject.path;
    }
  }

  return fallbackDirectory ?? undefined;
};
