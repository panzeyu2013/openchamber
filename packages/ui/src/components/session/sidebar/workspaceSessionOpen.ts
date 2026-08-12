import type { WorkspaceSessionSummary } from '@/workspaces/types';

/**
 * Open a workspace session through the unified selection path.
 *
 * The same action serves local and remote workspaces: the composite
 * `(workspaceId, upstreamSessionId)` target is passed to `setCurrentSession`,
 * so this click NEVER calls `setControlPlane()` and never clears other
 * workspaces' state. The sync remounts on the workspace-bound runtime handle
 * keyed by workspaceId.
 */
export const openWorkspaceSession = (
  session: Pick<WorkspaceSessionSummary, 'workspaceId' | 'upstreamSessionId'> & { directory?: string | null },
  setCurrentSession: (sessionId: string, directory: string | null, workspaceId: string) => void,
): void => {
  setCurrentSession(session.upstreamSessionId, session.directory || null, session.workspaceId);
};
