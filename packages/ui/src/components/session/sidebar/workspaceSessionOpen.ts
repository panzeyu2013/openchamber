import type { WorkspaceSessionSummary } from '@/workspaces/types';

/**
 * Open a workspace session through the unified selection path.
 *
 * The same action serves local and remote workspaces: `setCurrentSession`
 * resolves the workspace scope internally (session index → workspace scope
 * key), so this click NEVER calls `switchRuntimeEndpoint()` and never clears
 * other workspaces' state. The sync remounts on the workspace-bound runtime
 * handle keyed by workspaceId.
 */
export const openWorkspaceSession = (
  session: Pick<WorkspaceSessionSummary, 'upstreamSessionId'> & { directory?: string | null },
  setCurrentSession: (sessionId: string, directory: string | null) => void,
): void => {
  setCurrentSession(session.upstreamSessionId, session.directory || null);
};
