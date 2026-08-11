import * as React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useWorkspaceCatalogStore } from '@/workspaces/catalog-store';
import { useWorkspaceSessionIndexStore, resolveActiveWorkspaceId } from './session-index-store';
import type { ConnectionCapabilities, WorkspaceCatalogSnapshot, WorkspaceId } from './types';

/**
 * Hook form of `resolveActiveWorkspaceId` (see session-index-store.ts for
 * the matching contract). An explicit workspace target recorded on a draft or
 * by `setCurrentSession(..., workspaceId)` wins over tuple inference, which is
 * required when two connections expose the same upstream session ID and
 * directory. Returns null when the selection is not a workspace session — the
 * legacy ambient-runtime sync path then stays in charge.
 */
export const useActiveWorkspaceId = (): WorkspaceId | null => {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
  const selectedWorkspaceId = useSessionUIStore((state) => state.currentWorkspaceId);
  const draftWorkspaceId = useSessionUIStore((state) => state.newSessionDraft?.open ? state.newSessionDraft.workspaceId ?? null : null);
  const sessions = useWorkspaceSessionIndexStore((state) => state.snapshot?.sessions);

  return React.useMemo(
    () => draftWorkspaceId
      ?? selectedWorkspaceId
      ?? resolveActiveWorkspaceId(sessions, currentSessionId, currentSessionDirectory),
    [currentSessionDirectory, currentSessionId, draftWorkspaceId, selectedWorkspaceId, sessions],
  );
};

/**
 * Pure resolver for the connection capabilities of a workspace. Returns null
 * when there is no workspace, the catalog has no authoritative snapshot yet
 * (loading/unavailable — callers must NOT gate on null), or the workspace's
 * connection is missing from the snapshot.
 */
export const resolveActiveWorkspaceCapabilities = (
  workspaceId: WorkspaceId | null,
  snapshot: WorkspaceCatalogSnapshot | null,
): ConnectionCapabilities | null => {
  if (!workspaceId || !snapshot) return null;
  const workspace = snapshot.workspaces.find((entry) => entry.id === workspaceId);
  if (!workspace) return null;
  return snapshot.connections.find((entry) => entry.id === workspace.connectionId)?.capabilities ?? null;
};

/**
 * Connection capabilities of the ACTIVE workspace's connection (from the
 * catalog), or null when there is no active workspace session or the catalog
 * has no authoritative snapshot yet. Capability gates key off this: while the
 * catalog is loading or unavailable, null means "do not gate" so existing
 * behavior (e.g. the terminal opening against the ambient runtime) is
 * preserved until the workspace connection is authoritative.
 *
 * Consumed by the terminal capability gate (mobile workspace drawer, mobile
 * header tabs, context panel terminal pane). TODO: gate the remaining
 * ConnectionCapabilities (files/git/eventStream) the same way once their
 * surface entry points are workspace-scoped.
 */
export const useActiveWorkspaceCapabilities = (): ConnectionCapabilities | null => {
  const workspaceId = useActiveWorkspaceId();
  const snapshot = useWorkspaceCatalogStore((state) => state.snapshot);
  return React.useMemo(
    () => resolveActiveWorkspaceCapabilities(workspaceId, snapshot),
    [snapshot, workspaceId],
  );
};
