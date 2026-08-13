import type { ProjectSessionSummary } from '@/projects/types';

/**
 * Open a project session through the unified selection path.
 *
 * The same action serves local and remote projects: the composite
 * `(projectId, upstreamSessionId)` target is passed to `setCurrentSession`,
 * so this click NEVER calls `setControlPlane()` and never clears other
 * projects' state. The sync remounts on the project-bound runtime handle
 * keyed by projectId.
 */
export const openProjectSession = (
  session: Pick<ProjectSessionSummary, 'projectId' | 'upstreamSessionId'> & { directory?: string | null },
  setCurrentSession: (sessionId: string, directory: string | null, projectId: string) => void,
): void => {
  setCurrentSession(session.upstreamSessionId, session.directory || null, session.projectId);
};
