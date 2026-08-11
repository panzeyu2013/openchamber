import React from 'react';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { isDesktopLocalOriginActive, isDesktopShell } from '@/lib/desktop';
import { desktopHostsGet, getDesktopHostApiUrl, locationMatchesHost, redactSensitiveUrl } from '@/lib/desktopHosts';
import { setDesktopWindowTitle } from '@/lib/desktopNative';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';
import { useActiveWorkspaceId } from '@/workspaces/useActiveWorkspace';
import { useWorkspaceCatalogStore } from '@/workspaces/catalog-store';
import type { WorkspaceCatalogSnapshot } from '@/workspaces/types';

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

type WorkspaceTitleContext = {
  projectLabel: string | null;
  instanceLabel: string | null;
};

/**
 * Resolve title identity from the authoritative workspace catalog. A
 * connection label is safe UI metadata; URL matching is intentionally left to
 * the legacy no-workspace fallback in the hook below.
 */
export const resolveWorkspaceTitleContext = (
  workspaceId: string | null,
  snapshot: WorkspaceCatalogSnapshot | null,
): WorkspaceTitleContext | null => {
  if (!workspaceId || !snapshot) return null;
  const workspace = snapshot.workspaces.find((entry) => entry.id === workspaceId);
  if (!workspace) return null;
  const connection = snapshot.connections.find((entry) => entry.id === workspace.connectionId);
  const workspaceLabel = workspace.label.trim() || getProjectNameFromPath(workspace.path);
  const connectionLabel = connection?.label?.trim() || '';
  return {
    projectLabel: workspaceLabel ? formatProjectLabel(workspaceLabel) : null,
    instanceLabel: workspace.connectionId === 'local'
      ? null
      : redactSensitiveUrl(connectionLabel || 'Workspace'),
  };
};

export const useWindowTitle = () => {
  const activeWorkspaceId = useActiveWorkspaceId();
  const catalogSnapshot = useWorkspaceCatalogStore((state) => state.snapshot);
  const workspaceTitleContext = React.useMemo(
    () => resolveWorkspaceTitleContext(activeWorkspaceId, catalogSnapshot),
    [activeWorkspaceId, catalogSnapshot],
  );
  const activeProject = useProjectsStore((state) => {
    if (!state.activeProjectId) {
      return null;
    }
    return state.projects.find((project) => project.id === state.activeProjectId) ?? null;
  });

  const projectLabel = React.useMemo(() => {
    if (workspaceTitleContext?.projectLabel) {
      return workspaceTitleContext.projectLabel;
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
  }, [activeProject, workspaceTitleContext]);

  const [instanceLabel, setInstanceLabel] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (typeof window === 'undefined' || !isDesktopShell()) {
      setInstanceLabel(null);
      return;
    }

    if (activeWorkspaceId) {
      // A workspace title is scoped by the Catalog, not by the ambient
      // Desktop Host Switcher endpoint. Keep a temporary generic label while
      // the catalog is loading rather than leaking the previous host name.
      setInstanceLabel(workspaceTitleContext?.instanceLabel ?? 'Workspace');
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
        const runtimeApiBaseUrl = getRuntimeApiBaseUrl();

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
  }, [activeWorkspaceId, workspaceTitleContext]);

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
