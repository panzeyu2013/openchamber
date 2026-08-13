import * as React from 'react';
import { setProjectRuntimeActive } from '@/contexts/runtimeAPIRegistry';
import { useI18n } from '@/lib/i18n';
import { useProjectCatalogStore } from './catalog-store';
import { createProjectRuntimeRegistry, type ProjectRuntimeHandle } from './project-runtime-registry';
import { ProjectRuntimeContext } from './project-runtime-context';
import type { ProjectId } from './types';

/**
 * Project runtime provider: the handle bound to the CURRENT project.
 *
 * The provider is mounted above the full-sync surface for the selected
 * project. It resolves the project descriptor from the catalog and
 * acquires a registry handle; while mounted, the handle is retained (leased)
 * so the registry can never evict it. Switching projects swaps the context
 * value; the previous project's full sync owner unmounts separately —
 * nothing here resets global stores or switches endpoints.
 */

const registry = createProjectRuntimeRegistry();

/**
 * Explicit project targets must not fall back to the ambient runtime while
 * the Catalog is loading or a connection has become unavailable. Keep this
 * gate small and shared by the main, mobile, and secondary Electron surfaces.
 */
export const ProjectRuntimeGate: React.FC = () => {
  const { t } = useI18n();
  const catalogStatus = useProjectCatalogStore((state) => state.status);
  const message = catalogStatus === 'idle' || catalogStatus === 'loading'
    ? t('common.loading')
    : t('projects.sidebar.unavailable');

  return (
    <div className="flex h-full items-center justify-center bg-background px-4 text-center text-sm text-muted-foreground">
      {message}
    </div>
  );
};

export const ProjectRuntimeProvider: React.FC<{
  projectId: ProjectId | null;
  children: React.ReactNode;
}> = ({ projectId, children }) => {
  const project = useProjectCatalogStore(
    React.useCallback(
      (state) => (projectId ? state.snapshot?.projects.find((entry) => entry.id === projectId) ?? null : null),
      [projectId],
    ),
  );

  const handle = React.useMemo<ProjectRuntimeHandle | null>(() => {
    if (!project) return null;
    return registry.get(project);
  }, [project]);

  React.useEffect(() => {
    // Mark the project scope before child effects (including config-store
    // bootstrap) can fall back to an ambient settings endpoint. The registry
    // supplies the typed unavailable settings API until a handle is ready.
    setProjectRuntimeActive(Boolean(projectId));
    return () => setProjectRuntimeActive(false);
  }, [projectId]);

  React.useEffect(() => {
    if (!handle) return;
    const release = handle.retain();
    return release;
  }, [handle]);

  const value = React.useMemo(
    () => ({ projectId: handle?.projectId ?? null, handle }),
    [handle],
  );

  return (
    <ProjectRuntimeContext.Provider value={value}>
      {children}
    </ProjectRuntimeContext.Provider>
  );
};
