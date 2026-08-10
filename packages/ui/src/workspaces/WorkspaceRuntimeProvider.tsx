import * as React from 'react';
import { useWorkspaceCatalogStore } from './catalog-store';
import { createWorkspaceRuntimeRegistry, type WorkspaceRuntimeHandle } from './workspace-runtime-registry';
import { WorkspaceRuntimeContext } from './workspace-runtime-context';
import type { WorkspaceId } from './types';

/**
 * Workspace runtime provider: the handle bound to the CURRENT workspace.
 *
 * The provider is mounted above the full-sync surface for the selected
 * workspace. It resolves the workspace descriptor from the catalog and
 * acquires a registry handle; while mounted, the handle is retained (leased)
 * so the registry can never evict it. Switching workspaces swaps the context
 * value; the previous workspace's full sync owner unmounts separately —
 * nothing here resets global stores or switches endpoints.
 */

const registry = createWorkspaceRuntimeRegistry();

export const WorkspaceRuntimeProvider: React.FC<{
  workspaceId: WorkspaceId | null;
  children: React.ReactNode;
}> = ({ workspaceId, children }) => {
  const workspace = useWorkspaceCatalogStore(
    React.useCallback(
      (state) => (workspaceId ? state.snapshot?.workspaces.find((entry) => entry.id === workspaceId) ?? null : null),
      [workspaceId],
    ),
  );

  const handle = React.useMemo<WorkspaceRuntimeHandle | null>(() => {
    if (!workspace) return null;
    return registry.get(workspace);
  }, [workspace]);

  React.useEffect(() => {
    if (!handle) return;
    const release = handle.retain();
    return release;
  }, [handle]);

  const value = React.useMemo(
    () => ({ workspaceId: handle?.workspaceId ?? null, handle }),
    [handle],
  );

  return (
    <WorkspaceRuntimeContext.Provider value={value}>
      {children}
    </WorkspaceRuntimeContext.Provider>
  );
};
