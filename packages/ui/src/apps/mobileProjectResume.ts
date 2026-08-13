import { getControlPlaneKey } from '@/lib/control-plane';
import { readLastActiveSession } from '@/sync/last-session-cache';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { isControlPlaneAvailable } from '@/projects/control-plane-fetch';
import { useProjectCatalogStore } from '@/projects/catalog-store';
import { resolveActiveProjectId, useProjectSessionIndexStore } from '@/projects/session-index-store';

/**
 * App-resume project restore (Capacitor mobile).
 *
 * Order matters: the Project Catalog and the Session Index are refreshed
 * FIRST (re-fetching the authoritative snapshot + revision), and only then is
 * the last active session matched against the index through
 * `resolveActiveProjectId`. A hit restores the session through the unified
 * selection path, so the project-bound sync (project scope) takes over
 * from the legacy ambient-runtime path.
 *
 * When the control plane is unavailable (bare OpenCode server without the
 * catalog API, or disconnected), the project refresh is SKIPPED and
 * `no-control-plane` is returned so the caller keeps the existing legacy
 * global-sessions restore path unchanged. A refresh failure never masquerades
 * as an empty success: the stores keep their prior snapshots and mark error.
 */
type ProjectResumeOutcome =
  | { restored: true; projectId: string; sessionId: string }
  | { restored: false; reason: 'no-control-plane' | 'no-last-session' | 'session-not-in-project-index' };

export const refreshProjectStateAfterResume = async (): Promise<ProjectResumeOutcome> => {
  if (!isControlPlaneAvailable()) {
    return { restored: false, reason: 'no-control-plane' };
  }
  const persisted = readLastActiveSession(getControlPlaneKey());
  if (!persisted) {
    return { restored: false, reason: 'no-last-session' };
  }

  await useProjectCatalogStore.getState().refresh();
  if (useProjectCatalogStore.getState().status === 'error') {
    return { restored: false, reason: 'no-control-plane' };
  }

  await useProjectSessionIndexStore.getState().refresh();
  if (useProjectSessionIndexStore.getState().status === 'error') {
    return { restored: false, reason: 'no-control-plane' };
  }

  const sessions = useProjectSessionIndexStore.getState().snapshot?.sessions;
  const projectId = resolveActiveProjectId(sessions, persisted.sessionId, persisted.directory ?? null);
  if (!projectId) {
    // The session exists but is not bound to a project — the legacy
    // ambient restore path stays in charge (nothing to restore here).
    return { restored: false, reason: 'session-not-in-project-index' };
  }

  const latest = useSessionUIStore.getState();
  if (!latest.currentSessionId) {
    latest.setCurrentSession(persisted.sessionId, persisted.directory ?? undefined, projectId);
  }
  return { restored: true, projectId, sessionId: persisted.sessionId };
};
