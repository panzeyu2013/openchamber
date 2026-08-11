import * as React from 'react';
import { setWorkspaceRuntimeActive } from '@/contexts/runtimeAPIRegistry';
import { useI18n } from '@/lib/i18n';
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

/**
 * Explicit workspace targets must not fall back to the ambient runtime while
 * the Catalog is loading or a connection has become unavailable. Keep this
 * gate small and shared by the main, mobile, and secondary Electron surfaces.
 */
export const WorkspaceRuntimeGate: React.FC = () => {
  const { t } = useI18n();
  const catalogStatus = useWorkspaceCatalogStore((state) => state.status);
  const message = catalogStatus === 'idle' || catalogStatus === 'loading'
    ? t('common.loading')
    : t('workspaces.sidebar.unavailable');

  return (
    <div className="flex h-full items-center justify-center bg-background px-4 text-center text-sm text-muted-foreground">
      {message}
    </div>
  );
};

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
    // Mark the workspace scope before child effects (including config-store
    // bootstrap) can fall back to an ambient settings endpoint. The registry
    // supplies the typed unavailable settings API until a handle is ready.
    setWorkspaceRuntimeActive(Boolean(workspaceId));
    return () => setWorkspaceRuntimeActive(false);
  }, [workspaceId]);

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
