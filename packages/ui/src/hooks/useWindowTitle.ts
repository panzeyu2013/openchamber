import React from 'react';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { isDesktopLocalOriginActive, isDesktopShell } from '@/lib/desktop';
import { desktopHostsGet, getDesktopHostApiUrl, locationMatchesHost, redactSensitiveUrl } from '@/lib/desktopHosts';
import { setDesktopWindowTitle } from '@/lib/desktopNative';
import { getControlPlaneBaseUrl } from '@/lib/control-plane';
import { useActiveProjectId } from '@/projects/useActiveProject';
import { useProjectCatalogStore } from '@/projects/catalog-store';
import type { ProjectCatalogSnapshot } from '@/projects/types';

const APP_TITLE = 'OpenChamber';

const formatProjectLabel = (label: string): string => {
  return label.replace(/[-_]/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
};

const getProjectNameFromPath = (path: string): string => {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const segments = normalized.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? '';
};

const buildWindowTitle = (projectLabel: string | null, instanceLabel: string | null): string => {
  const parts = [projectLabel, instanceLabel, APP_TITLE].filter((part): part is string => typeof part === 'string' && part.trim().length > 0);
  return parts.join(' | ');
};

type ProjectTitleContext = {
  projectLabel: string | null;
  instanceLabel: string | null;
};

/**
 * Resolve title identity from the authoritative project catalog. A
 * connection label is safe UI metadata; URL matching is intentionally left to
 * the legacy no-project fallback in the hook below.
 */
export const resolveProjectTitleContext = (
  projectId: string | null,
  snapshot: ProjectCatalogSnapshot | null,
): ProjectTitleContext | null => {
  if (!projectId || !snapshot) return null;
  const project = snapshot.projects.find((entry) => entry.id === projectId);
  if (!project) return null;
  const connection = snapshot.connections.find((entry) => entry.id === project.connectionId);
  const projectLabel = project.label.trim() || getProjectNameFromPath(project.path);
  const connectionLabel = connection?.label?.trim() || '';
  return {
    projectLabel: projectLabel ? formatProjectLabel(projectLabel) : null,
    instanceLabel: project.connectionId === 'local'
      ? null
      : redactSensitiveUrl(connectionLabel || 'Project'),
  };
};

export const useWindowTitle = () => {
  const activeProjectId = useActiveProjectId();
  const catalogSnapshot = useProjectCatalogStore((state) => state.snapshot);
  const projectTitleContext = React.useMemo(
    () => resolveProjectTitleContext(activeProjectId, catalogSnapshot),
    [activeProjectId, catalogSnapshot],
  );
  const activeProject = useProjectsStore((state) => {
    if (!state.activeProjectId) {
      return null;
    }
    return state.projects.find((project) => project.id === state.activeProjectId) ?? null;
  });

  const projectLabel = React.useMemo(() => {
    if (projectTitleContext?.projectLabel) {
      return projectTitleContext.projectLabel;
    }
    if (!activeProject) {
      return null;
    }

    const label = activeProject.label?.trim();
    if (label) {
      return formatProjectLabel(label);
    }

    const pathName = getProjectNameFromPath(activeProject.path);
    if (pathName) {
      return formatProjectLabel(pathName);
    }

    return null;
  }, [activeProject, projectTitleContext]);

  const [instanceLabel, setInstanceLabel] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (typeof window === 'undefined' || !isDesktopShell()) {
      setInstanceLabel(null);
      return;
    }

    if (activeProjectId) {
      // A project title is scoped by the Catalog, not by the ambient
      // Desktop Host Switcher endpoint. Keep a temporary generic label while
      // the catalog is loading rather than leaking the previous host name.
      setInstanceLabel(projectTitleContext?.instanceLabel ?? 'Project');
      return;
    }

    let cancelled = false;

    const refreshInstanceLabel = async () => {
      try {
        if (isDesktopLocalOriginActive()) {
          if (!cancelled) {
            setInstanceLabel(null);
          }
          return;
        }

        const localOrigin = window.__OPENCHAMBER_LOCAL_ORIGIN__ || window.location.origin;
        const runtimeApiBaseUrl = getControlPlaneBaseUrl();

        if (runtimeApiBaseUrl && locationMatchesHost(runtimeApiBaseUrl, localOrigin)) {
          if (!cancelled) {
            setInstanceLabel(null);
          }
          return;
        }

        const cfg = await desktopHostsGet();
        const match = cfg.hosts.find((host) => runtimeApiBaseUrl ? locationMatchesHost(runtimeApiBaseUrl, getDesktopHostApiUrl(host)) : false);
        const nextLabel = match?.label?.trim() ? redactSensitiveUrl(match.label.trim()) : 'Instance';
        if (!cancelled) {
          setInstanceLabel(nextLabel);
        }
      } catch {
        if (!cancelled) {
          setInstanceLabel('Instance');
        }
      }
    };

    void refreshInstanceLabel();

    const handleFocus = () => {
      void refreshInstanceLabel();
    };

    window.addEventListener('focus', handleFocus);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', handleFocus);
    };
  }, [activeProjectId, projectTitleContext]);

  const title = React.useMemo(() => buildWindowTitle(projectLabel, instanceLabel), [projectLabel, instanceLabel]);

  React.useEffect(() => {
    if (typeof document !== 'undefined') {
      document.title = title;
    }

    if (!isDesktopShell()) {
      return;
    }

    const applyTitle = async () => {
      try {
        const isMac = typeof navigator !== 'undefined' && /Macintosh|Mac OS X/.test(navigator.userAgent || '');
        if (isMac) {
          return;
        }

        await setDesktopWindowTitle(title);
      } catch {
        return;
      }
    };

    void applyTitle();
  }, [title]);
};
