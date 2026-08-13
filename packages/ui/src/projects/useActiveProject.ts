import * as React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useProjectCatalogStore } from '@/projects/catalog-store';
import { useProjectSessionIndexStore, resolveActiveProjectId } from './session-index-store';
import type { ConnectionCapabilities, ProjectCatalogSnapshot, ProjectId } from './types';

/**
 * Hook form of `resolveActiveProjectId` (see session-index-store.ts for
 * the matching contract). An explicit project target recorded on a draft or
 * by `setCurrentSession(..., projectId)` wins over tuple inference, which is
 * required when two connections expose the same upstream session ID and
 * directory. Returns null when the selection is not a project session — the
 * legacy ambient-runtime sync path then stays in charge.
 */
export const useActiveProjectId = (): ProjectId | null => {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
  const selectedProjectId = useSessionUIStore((state) => state.currentProjectId);
  const draftProjectId = useSessionUIStore((state) => state.newSessionDraft?.open ? state.newSessionDraft.projectId ?? null : null);
  const sessions = useProjectSessionIndexStore((state) => state.snapshot?.sessions);

  return React.useMemo(
    () => draftProjectId
      ?? selectedProjectId
      ?? resolveActiveProjectId(sessions, currentSessionId, currentSessionDirectory),
    [currentSessionDirectory, currentSessionId, draftProjectId, selectedProjectId, sessions],
  );
};

/**
 * Pure resolver for the connection capabilities of a project. Returns null
 * when there is no project, the catalog has no authoritative snapshot yet
 * (loading/unavailable — callers must NOT gate on null), or the project's
 * connection is missing from the snapshot.
 */
export const resolveActiveProjectCapabilities = (
  projectId: ProjectId | null,
  snapshot: ProjectCatalogSnapshot | null,
): ConnectionCapabilities | null => {
  if (!projectId || !snapshot) return null;
  const project = snapshot.projects.find((entry) => entry.id === projectId);
  if (!project) return null;
  return snapshot.connections.find((entry) => entry.id === project.connectionId)?.capabilities ?? null;
};

/**
 * Connection capabilities of the ACTIVE project's connection (from the
 * catalog), or null when there is no active project session or the catalog
 * has no authoritative snapshot yet. Capability gates key off this: while the
 * catalog is loading or unavailable, null means "do not gate" so existing
 * behavior (e.g. the terminal opening against the ambient runtime) is
 * preserved until the project connection is authoritative.
 *
 * Consumed by the terminal capability gate (mobile project drawer, mobile
 * header tabs, context panel terminal pane). TODO: gate the remaining
 * ConnectionCapabilities (files/git/eventStream) the same way once their
 * surface entry points are project-scoped.
 */
export const useActiveProjectCapabilities = (): ConnectionCapabilities | null => {
  const projectId = useActiveProjectId();
  const snapshot = useProjectCatalogStore((state) => state.snapshot);
  return React.useMemo(
    () => resolveActiveProjectCapabilities(projectId, snapshot),
    [snapshot, projectId],
  );
};
