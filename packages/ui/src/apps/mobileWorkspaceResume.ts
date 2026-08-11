import { getRuntimeKey } from '@/lib/runtime-switch';
import { readLastActiveSession } from '@/sync/last-session-cache';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { isControlPlaneAvailable } from '@/workspaces/control-plane-fetch';
import { useWorkspaceCatalogStore } from '@/workspaces/catalog-store';
import { resolveActiveWorkspaceId, useWorkspaceSessionIndexStore } from '@/workspaces/session-index-store';

/**
 * App-resume workspace restore (Capacitor mobile).
 *
 * Order matters: the Workspace Catalog and the Session Index are refreshed
 * FIRST (re-fetching the authoritative snapshot + revision), and only then is
 * the last active session matched against the index through
 * `resolveActiveWorkspaceId`. A hit restores the session through the unified
 * selection path, so the workspace-bound sync (workspace scope) takes over
 * from the legacy ambient-runtime path.
 *
 * When the control plane is unavailable (bare OpenCode server without the
 * catalog API, or disconnected), the workspace refresh is SKIPPED and
 * `no-control-plane` is returned so the caller keeps the existing legacy
 * global-sessions restore path unchanged. A refresh failure never masquerades
 * as an empty success: the stores keep their prior snapshots and mark error.
 */
type WorkspaceResumeOutcome =
  | { restored: true; workspaceId: string; sessionId: string }
  | { restored: false; reason: 'no-control-plane' | 'no-last-session' | 'session-not-in-workspace-index' };

export const refreshWorkspaceStateAfterResume = async (): Promise<WorkspaceResumeOutcome> => {
  if (!isControlPlaneAvailable()) {
    return { restored: false, reason: 'no-control-plane' };
  }
  const persisted = readLastActiveSession(getRuntimeKey());
  if (!persisted) {
    return { restored: false, reason: 'no-last-session' };
  }

  await useWorkspaceCatalogStore.getState().refresh();
  if (useWorkspaceCatalogStore.getState().status === 'error') {
    return { restored: false, reason: 'no-control-plane' };
  }

  await useWorkspaceSessionIndexStore.getState().refresh();
  if (useWorkspaceSessionIndexStore.getState().status === 'error') {
    return { restored: false, reason: 'no-control-plane' };
  }

  const sessions = useWorkspaceSessionIndexStore.getState().snapshot?.sessions;
  const workspaceId = resolveActiveWorkspaceId(sessions, persisted.sessionId, persisted.directory ?? null);
  if (!workspaceId) {
    // The session exists but is not bound to a workspace — the legacy
    // ambient restore path stays in charge (nothing to restore here).
    return { restored: false, reason: 'session-not-in-workspace-index' };
  }

  const latest = useSessionUIStore.getState();
  if (!latest.currentSessionId) {
    latest.setCurrentSession(persisted.sessionId, persisted.directory ?? undefined, workspaceId);
  }
  return { restored: true, workspaceId, sessionId: persisted.sessionId };
};
