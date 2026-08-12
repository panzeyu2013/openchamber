import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { opencodeClient } from '@/lib/opencode/client';
import { isWorkspaceRuntimeActive } from '@/contexts/runtimeAPIRegistry';
import type { ProjectEntry } from '@/lib/api/types';
import type { DesktopSettings } from '@/lib/desktop';
import { updateDesktopSettings } from '@/lib/persistence';
import { getDeferredSafeStorage } from './utils/safeStorage';
import { useDirectoryStore } from './useDirectoryStore';
import { streamDebugEnabled } from '@/stores/utils/streamDebug';
import { PROJECT_COLORS } from '@/lib/projectMeta';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useWorkspaceCatalogStore } from '@/workspaces/catalog-store';
import type { WorkspaceCatalogSnapshot, WorkspaceDescriptor } from '@/workspaces/types';

/** Pick a color key that's least used among existing projects */
const pickAutoColor = (projects: ProjectEntry[]): string => {
  const colorKeys = PROJECT_COLORS.map((c) => c.key);
  const usageCounts = new Map<string, number>();
  for (const key of colorKeys) {
    usageCounts.set(key, 0);
  }
  for (const p of projects) {
    if (p.color && usageCounts.has(p.color)) {
      usageCounts.set(p.color, (usageCounts.get(p.color) ?? 0) + 1);
    }
  }
  // Find minimum usage, then pick randomly among those with min usage
  const minUsage = Math.min(...usageCounts.values());
  const candidates = colorKeys.filter((k) => usageCounts.get(k) === minUsage);
  return candidates[Math.floor(Math.random() * candidates.length)];
};

interface ProjectPathValidationResult {
  ok: boolean;
  normalizedPath?: string;
  reason?: string;
}

interface ProjectsStore {
  projects: ProjectEntry[];
  activeProjectId: string | null;
  manualProjectOrder: string[];

  addProject: (path: string, options?: { label?: string; id?: string }) => ProjectEntry | null;
  removeProject: (id: string) => void;
  setActiveProject: (id: string) => void;
  setActiveProjectIdOnly: (id: string) => void;
  renameProject: (id: string, label: string) => void;
  updateProjectMeta: (id: string, meta: {
    label?: string;
    icon?: string | null;
    color?: string | null;
    iconBackground?: string | null;
    defaultModel?: string | null;
  }) => void;
  uploadProjectIcon: (id: string, file: File) => Promise<{ ok: boolean; error?: string }>;
  removeProjectIcon: (id: string) => Promise<{ ok: boolean; error?: string }>;
  discoverProjectIcon: (id: string, options?: { force?: boolean }) => Promise<{ ok: boolean; skipped?: boolean; reason?: string; error?: string }>;
  reorderProjects: (fromIndex: number, toIndex: number) => void;
  validateProjectPath: (path: string) => ProjectPathValidationResult;
  synchronizeFromSettings: (settings: DesktopSettings) => void;
  getActiveProject: () => ProjectEntry | null;
}

const safeStorage = getDeferredSafeStorage();
const PROJECTS_STORAGE_KEY = 'projects';
const ACTIVE_PROJECT_STORAGE_KEY = 'activeProjectId';

let catalogOrderWriteChain: Promise<void> = Promise.resolve();
let synchronizeProjectsFromCatalog: () => void = () => {};

// The Catalog is pinned to the current OpenChamber control plane. Keep one
// unscoped legacy cache only as a compatibility fallback when that Catalog is
// unavailable; never create another cache partition for a selected upstream
// runtime.
const getProjectsStorageKey = (): string => PROJECTS_STORAGE_KEY;
const getActiveProjectStorageKey = (): string => ACTIVE_PROJECT_STORAGE_KEY;

const getReadyCatalogSnapshot = (): WorkspaceCatalogSnapshot | null => {
  const catalog = useWorkspaceCatalogStore.getState();
  return catalog.status === 'ready' && catalog.snapshot
    ? catalog.snapshot
    : null;
};

/**
 * Project metadata remains a compatibility surface, but it must not mutate
 * the ambient OpenCode directory while a composite workspace/session target
 * is mounted. The workspace-bound SyncProvider owns that directory instead.
 */
const hasActiveWorkspaceSession = (): boolean => {
  const sessionState = useSessionUIStore.getState();
  return Boolean(
    sessionState.currentWorkspaceId
    || (sessionState.newSessionDraft?.open && sessionState.newSessionDraft.workspaceId)
    || isWorkspaceRuntimeActive(),
  );
};

const resolveTildePath = (value: string, homeDir?: string | null): string => {
  const trimmed = value.trim();
  if (!trimmed.startsWith('~')) {
    return trimmed;
  }
  if (!homeDir) {
    return trimmed;
  }
  if (trimmed === '~') {
    return homeDir;
  }
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return `${homeDir}${trimmed.slice(1)}`;
  }
  return trimmed;
};

const HEX_COLOR_PATTERN = /^#(?:[\da-fA-F]{3}|[\da-fA-F]{6})$/;

const normalizeDefaultModel = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const separatorIndex = trimmed.indexOf('/');
  if (separatorIndex <= 0 || separatorIndex >= trimmed.length - 1) {
    return undefined;
  }
  return trimmed;
};

const normalizeIconBackground = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return HEX_COLOR_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
};

const normalizeProjectPath = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  const homeDirectory = safeStorage.getItem('homeDirectory') || useDirectoryStore.getState().homeDirectory || '';
  const expanded = resolveTildePath(trimmed, homeDirectory);

  const normalized = expanded.replace(/\\/g, '/');
  if (normalized === '/') {
    return '/';
  }
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
};

const compareCatalogOrder = (left: WorkspaceDescriptor, right: WorkspaceDescriptor, leftIndex: number, rightIndex: number): number => {
  const leftOrder = left.orderKey.trim();
  const rightOrder = right.orderKey.trim();
  if (leftOrder && rightOrder) {
    const orderDelta = leftOrder.localeCompare(rightOrder);
    if (orderDelta !== 0) return orderDelta;
  } else if (leftOrder || rightOrder) {
    return leftOrder ? -1 : 1;
  }
  return leftIndex - rightIndex;
};

const projectFromCatalogWorkspace = (workspace: WorkspaceDescriptor): ProjectEntry => {
  const normalizedPath = normalizeProjectPath(workspace.path);
  return {
    id: workspace.id,
    path: normalizedPath,
    label: workspace.label,
    color: workspace.color,
    addedAt: workspace.createdAt,
    lastOpenedAt: workspace.updatedAt,
  };
};

const catalogProjectsFromSnapshot = (snapshot: WorkspaceCatalogSnapshot): ProjectEntry[] => {
  const localWorkspaces = snapshot.workspaces
    .map((workspace, index) => ({ workspace, index }))
    .filter(({ workspace }) => workspace.connectionId === 'local')
    .sort((left, right) => compareCatalogOrder(left.workspace, right.workspace, left.index, right.index))
    .map(({ workspace }) => projectFromCatalogWorkspace(workspace));
  return localWorkspaces;
};

const deriveProjectLabel = (path: string): string => {
  const normalized = normalizeProjectPath(path);
  if (!normalized || normalized === '/') {
    return 'Root';
  }
  const segments = normalized.split('/').filter(Boolean);
  const raw = segments[segments.length - 1] || normalized;
  return raw.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
};

const sanitizeProjectIconImage = (value: unknown): ProjectEntry['iconImage'] | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  const mime = typeof candidate.mime === 'string' ? candidate.mime.trim() : '';
  const updatedAt = typeof candidate.updatedAt === 'number' && Number.isFinite(candidate.updatedAt)
    ? Math.max(0, Math.round(candidate.updatedAt))
    : 0;
  const source = candidate.source === 'custom' || candidate.source === 'auto'
    ? candidate.source
    : null;

  if (!mime || !updatedAt || !source) {
    return undefined;
  }

  return { mime, updatedAt, source };
};

const resolveUploadMime = (file: File): 'image/png' | 'image/jpeg' | 'image/svg+xml' | null => {
  const rawType = typeof file.type === 'string' ? file.type.trim().toLowerCase() : '';
  if (rawType === 'image/png' || rawType === 'image/jpeg' || rawType === 'image/svg+xml') {
    return rawType;
  }

  const lowerName = file.name.toLowerCase();
  if (lowerName.endsWith('.png')) return 'image/png';
  if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) return 'image/jpeg';
  if (lowerName.endsWith('.svg')) return 'image/svg+xml';

  return null;
};

const readFileAsDataUrl = async (file: File): Promise<string> => {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(new Error('Failed to read icon file'));
    };
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      if (!result) {
        reject(new Error('Failed to read icon file'));
        return;
      }
      resolve(result);
    };
    reader.readAsDataURL(file);
  });
};

const sanitizeProjects = (value: unknown): ProjectEntry[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const result: ProjectEntry[] = [];
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Record<string, unknown>;

    const rawPath = typeof candidate.path === 'string' ? candidate.path.trim() : '';
    if (!rawPath) continue;

    const normalizedPath = normalizeProjectPath(rawPath);
    if (!normalizedPath) continue;

    // The id arrives from the Catalog projection (workspace id) or the
    // legacy settings surface; it is never re-derived from the path.
    const id = typeof candidate.id === 'string' && candidate.id.trim().length > 0
      ? candidate.id.trim()
      : '';
    if (!id) continue;

    if (seenIds.has(id) || seenPaths.has(normalizedPath)) continue;
    seenIds.add(id);
    seenPaths.add(normalizedPath);

    const project: ProjectEntry = {
      id,
      path: normalizedPath,
    };

    if (typeof candidate.label === 'string' && candidate.label.trim().length > 0) {
      project.label = candidate.label.trim();
    }
    if (typeof candidate.icon === 'string' && candidate.icon.trim().length > 0) {
      project.icon = candidate.icon.trim();
    }
    if (candidate.iconImage === null) {
      project.iconImage = null;
    } else {
      const iconImage = sanitizeProjectIconImage(candidate.iconImage);
      if (iconImage) {
        project.iconImage = iconImage;
      }
    }
    if (typeof candidate.color === 'string' && candidate.color.trim().length > 0) {
      project.color = candidate.color.trim();
    }
    const defaultModel = normalizeDefaultModel(candidate.defaultModel);
    if (defaultModel) {
      project.defaultModel = defaultModel;
    }
    if (candidate.iconBackground === null) {
      project.iconBackground = null;
    } else {
      const iconBackground = normalizeIconBackground(candidate.iconBackground);
      if (iconBackground) {
        project.iconBackground = iconBackground;
      }
    }
    if (typeof candidate.addedAt === 'number' && Number.isFinite(candidate.addedAt) && candidate.addedAt >= 0) {
      project.addedAt = candidate.addedAt;
    }
    if (typeof candidate.lastOpenedAt === 'number' && Number.isFinite(candidate.lastOpenedAt) && candidate.lastOpenedAt >= 0) {
      project.lastOpenedAt = candidate.lastOpenedAt;
    }
    if (typeof candidate.sidebarCollapsed === 'boolean') {
      project.sidebarCollapsed = candidate.sidebarCollapsed;
    }
    result.push(project);
  }

  return result;
};

const readPersistedProjects = (): ProjectEntry[] => {
  try {
    const raw = safeStorage.getItem(getProjectsStorageKey());
    if (!raw) {
      return [];
    }
    return sanitizeProjects(JSON.parse(raw));
  } catch {
    return [];
  }
};

const readPersistedManualOrder = (): string[] => {
  try {
    const raw = safeStorage.getItem(getProjectsStorageKey() + ':manualOrder');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
};

const readPersistedActiveProjectId = (): string | null => {
  try {
    const raw = safeStorage.getItem(getActiveProjectStorageKey());
    if (typeof raw === 'string' && raw.trim().length > 0) {
      return raw.trim();
    }
  } catch {
    return null;
  }
  return null;
};

const cacheProjects = (projects: ProjectEntry[], activeProjectId: string | null) => {
  try {
    safeStorage.setItem(getProjectsStorageKey(), JSON.stringify(projects));
  } catch {
    // ignored
  }

  try {
    const activeProjectStorageKey = getActiveProjectStorageKey();
    if (activeProjectId) {
      safeStorage.setItem(activeProjectStorageKey, activeProjectId);
    } else {
      safeStorage.removeItem(activeProjectStorageKey);
    }
  } catch {
    // ignored
  }
};

const persistProjects = (projects: ProjectEntry[], activeProjectId: string | null, manualOrder?: string[]) => {
  cacheProjects(projects, activeProjectId);
  if (manualOrder) {
    persistManualProjectOrder(manualOrder);
  }
  void updateDesktopSettings({ projects, activeProjectId: activeProjectId ?? undefined });
};

const queueCatalogOrderPersistence = (projects: ProjectEntry[]): void => {
  const orderedIds = projects.map((project) => project.id);
  catalogOrderWriteChain = catalogOrderWriteChain
    .then(async () => {
      for (const [index, workspaceId] of orderedIds.entries()) {
        const catalog = useWorkspaceCatalogStore.getState();
        if (!catalog.snapshot?.workspaces.some((workspace) => workspace.id === workspaceId)) continue;
        await catalog.updateWorkspace(workspaceId, {
          orderKey: String(index).padStart(12, '0'),
        });
      }
    })
    .catch(() => undefined);
};

const persistManualProjectOrder = (manualOrder: string[]) => {
  try {
    safeStorage.setItem(getProjectsStorageKey() + ':manualOrder', JSON.stringify(manualOrder));
  } catch {
    // ignored
  }
};

const initialProjects = readPersistedProjects();

export const useProjectsStore = create<ProjectsStore>()(
  devtools((set, get) => ({
    projects: initialProjects,
    activeProjectId: (() => {
      const persisted = readPersistedActiveProjectId();
      return initialProjects.some((project) => project.id === persisted)
        ? persisted
        : initialProjects[0]?.id ?? null;
    })(),
    manualProjectOrder: readPersistedManualOrder(),

    validateProjectPath: (path: string): ProjectPathValidationResult => {
      if (typeof path !== 'string' || path.trim().length === 0) {
        return { ok: false, reason: 'Provide a directory path.' };
      }

      const normalized = normalizeProjectPath(path);
      if (!normalized) {
        return { ok: false, reason: 'Directory path cannot be empty.' };
      }

      return { ok: true, normalizedPath: normalized };
    },

    addProject: (path: string, options?: { label?: string; id?: string }) => {
      const { validateProjectPath } = get();
      const validation = validateProjectPath(path);
      if (!validation.ok || !validation.normalizedPath) {
        return null;
      }

      const normalizedPath = validation.normalizedPath;

      const catalogSnapshot = getReadyCatalogSnapshot();
      if (catalogSnapshot) {
        const existingWorkspace = catalogSnapshot.workspaces.find((workspace) => (
          workspace.connectionId === 'local' && normalizeProjectPath(workspace.path) === normalizedPath
        ));
        if (existingWorkspace) {
          synchronizeProjectsFromCatalog();
          const existingProject = get().projects.find((project) => project.id === existingWorkspace.id)
            ?? projectFromCatalogWorkspace(existingWorkspace);
          get().setActiveProject(existingProject.id);
          return existingProject;
        }

        const now = Date.now();
        const provisional: ProjectEntry = {
          id: options?.id ?? normalizedPath,
          path: normalizedPath,
          label: options?.label?.trim() || deriveProjectLabel(normalizedPath),
          color: pickAutoColor(get().projects),
          addedAt: now,
          lastOpenedAt: now,
        };
        const nextProjects = [...get().projects, provisional];
        set({ projects: nextProjects });
        get().setActiveProject(provisional.id);

        void useWorkspaceCatalogStore.getState().createWorkspace({
          connectionId: 'local',
          path: normalizedPath,
          label: provisional.label,
          color: provisional.color ?? undefined,
        }).then(() => {
          synchronizeProjectsFromCatalog();
        }).catch(() => {
          set((state) => {
            const next = state.projects.filter((project) => project.id !== provisional.id);
            const activeProjectId = state.activeProjectId === provisional.id
              ? next[0]?.id ?? null
              : state.activeProjectId;
            return { projects: next, activeProjectId };
          });
        });
        return provisional;
      }

      const existing = get().projects.find((project) => project.path === normalizedPath);
      if (existing) {
        get().setActiveProject(existing.id);
        return existing;
      }

      const now = Date.now();
      const label = options?.label?.trim() || deriveProjectLabel(normalizedPath);
      // Catalog unavailable fallback: a path-derived id is a local
      // compatibility id until the Catalog projection replaces the entry
      // with the workspace id.
      const id = options?.id ?? normalizedPath;
      const entry: ProjectEntry = {
        id,
        path: normalizedPath,
        label,
        color: pickAutoColor(get().projects),
        addedAt: now,
        lastOpenedAt: now,
      };

      const nextProjects = [...get().projects, entry];
      set({ projects: nextProjects });

      if (streamDebugEnabled()) {
        console.info('[ProjectsStore] Added project', entry);
      }

      get().setActiveProject(entry.id);
      void get().discoverProjectIcon(entry.id);
      return entry;
    },

    removeProject: (id: string) => {
      const current = get();
      const project = current.projects.find((p) => p.id === id);
      const nextProjects = current.projects.filter((project) => project.id !== id);
      let nextActiveId = current.activeProjectId;

      if (current.activeProjectId === id) {
        nextActiveId = nextProjects[0]?.id ?? null;
      }

      const nextManualOrder = get().manualProjectOrder.filter((oid) => oid !== id);
      set({ projects: nextProjects, activeProjectId: nextActiveId, manualProjectOrder: nextManualOrder });
      const catalogSnapshot = getReadyCatalogSnapshot();
      const catalogWorkspace = catalogSnapshot?.workspaces.find((workspace) => workspace.id === id);
      if (catalogWorkspace) {
        void useWorkspaceCatalogStore.getState().deleteWorkspace(id).catch(() => undefined);
      } else {
        persistProjects(nextProjects, nextActiveId, nextManualOrder);
      }

      // Clean up worktree entries for the removed project
      if (project) {
        const normalizedPath = project.path.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
        useSessionUIStore.setState((s) => {
          const next = new Map(s.availableWorktreesByProject);
          next.delete(normalizedPath);
          return { availableWorktreesByProject: next };
        });
      }

      if (!hasActiveWorkspaceSession() && nextActiveId) {
        const nextActive = nextProjects.find((project) => project.id === nextActiveId);
        if (nextActive) {
          opencodeClient.setDirectory(nextActive.path);
          useDirectoryStore.getState().setDirectory(nextActive.path, { showOverlay: false });
        }
      } else if (!hasActiveWorkspaceSession()) {
        void useDirectoryStore.getState().goHome();
      }
    },

    setActiveProject: (id: string) => {
      const { projects, activeProjectId } = get();
      if (activeProjectId === id) {
        return;
      }
      const target = projects.find((project) => project.id === id);
      if (!target) {
        return;
      }

      const now = Date.now();
      const nextProjects = projects.map((project) =>
        project.id === id ? { ...project, lastOpenedAt: now } : project
      );

      set({ projects: nextProjects, activeProjectId: id });
      if (!getReadyCatalogSnapshot()?.workspaces.some((workspace) => workspace.id === id)) {
        persistProjects(nextProjects, id, get().manualProjectOrder);
      }

      if (!hasActiveWorkspaceSession()) {
        opencodeClient.setDirectory(target.path);
        useDirectoryStore.getState().setDirectory(target.path, { showOverlay: false });
      }
    },

    setActiveProjectIdOnly: (id: string) => {
      const { projects, activeProjectId } = get();
      if (activeProjectId === id) {
        return;
      }
      const target = projects.find((project) => project.id === id);
      if (!target) {
        return;
      }

      const now = Date.now();
      const nextProjects = projects.map((project) =>
        project.id === id ? { ...project, lastOpenedAt: now } : project
      );

      set({ projects: nextProjects, activeProjectId: id });
      if (!getReadyCatalogSnapshot()?.workspaces.some((workspace) => workspace.id === id)) {
        persistProjects(nextProjects, id, get().manualProjectOrder);
      }
    },

    renameProject: (id: string, label: string) => {
      const trimmed = label.trim();
      if (!trimmed) {
        return;
      }

      const { projects, activeProjectId } = get();
      const nextProjects = projects.map((project) =>
        project.id === id ? { ...project, label: trimmed } : project
      );
      set({ projects: nextProjects });
      if (getReadyCatalogSnapshot()?.workspaces.some((workspace) => workspace.id === id)) {
        void useWorkspaceCatalogStore.getState().updateWorkspace(id, { label: trimmed }).catch(() => undefined);
      } else {
        persistProjects(nextProjects, activeProjectId, get().manualProjectOrder);
      }
    },

    updateProjectMeta: (id: string, meta: {
      label?: string;
      icon?: string | null;
      color?: string | null;
      iconBackground?: string | null;
      defaultModel?: string | null;
    }) => {
      const { projects, activeProjectId } = get();
      const nextProjects = projects.map((project) => {
        if (project.id !== id) return project;
        const updated = { ...project };
        if (meta.label !== undefined) {
          const trimmed = meta.label.trim();
          if (trimmed) updated.label = trimmed;
        }
        if (meta.icon !== undefined) updated.icon = meta.icon;
        if (meta.color !== undefined) updated.color = meta.color;
        if (meta.iconBackground !== undefined) {
          updated.iconBackground = normalizeIconBackground(meta.iconBackground);
        }
        if (meta.defaultModel !== undefined) {
          const normalized = normalizeDefaultModel(meta.defaultModel);
          if (normalized) {
            updated.defaultModel = normalized;
          } else {
            delete updated.defaultModel;
          }
        }
        return updated;
      });
      set({ projects: nextProjects });
      const catalogWorkspace = getReadyCatalogSnapshot()?.workspaces.find((workspace) => workspace.id === id);
      if (catalogWorkspace) {
        const patch: { label?: string; color?: string | null } = {};
        if (meta.label !== undefined) {
          const trimmed = meta.label.trim();
          if (trimmed) patch.label = trimmed;
        }
        if (meta.color !== undefined) patch.color = meta.color;
        if (Object.keys(patch).length > 0) {
          void useWorkspaceCatalogStore.getState().updateWorkspace(id, patch).catch(() => undefined);
        }
        persistProjects(nextProjects, activeProjectId, get().manualProjectOrder);
      } else {
        persistProjects(nextProjects, activeProjectId, get().manualProjectOrder);
      }
    },

    uploadProjectIcon: async (id: string, file: File) => {
      const mime = resolveUploadMime(file);
      if (!mime) {
        return { ok: false, error: 'Only PNG, JPEG, and SVG are supported' };
      }
      if (!Number.isFinite(file.size) || file.size <= 0) {
        return { ok: false, error: 'Icon file is empty' };
      }
      if (file.size > 5 * 1024 * 1024) {
        return { ok: false, error: 'Icon exceeds size limit (5 MB)' };
      }

      try {
        const dataUrl = await readFileAsDataUrl(file);
        const normalizedDataUrl = dataUrl.replace(/^data:[^;]+;/i, `data:${mime};`);

        const response = await runtimeFetch(`/api/projects/${encodeURIComponent(id)}/icon`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ dataUrl: normalizedDataUrl }),
        });

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          return { ok: false, error: payload?.error || 'Failed to upload project icon' };
        }

        const payload = (await response.json().catch(() => null)) as { settings?: DesktopSettings } | null;
        if (payload?.settings) {
          get().synchronizeFromSettings(payload.settings);
        }
        return { ok: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: message || 'Failed to upload project icon' };
      }
    },

    removeProjectIcon: async (id: string) => {
      try {
        const response = await runtimeFetch(`/api/projects/${encodeURIComponent(id)}/icon`, {
          method: 'DELETE',
          headers: {
            Accept: 'application/json',
          },
        });

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          return { ok: false, error: payload?.error || 'Failed to remove project icon' };
        }

        const payload = (await response.json().catch(() => null)) as { settings?: DesktopSettings } | null;
        if (payload?.settings) {
          get().synchronizeFromSettings(payload.settings);
        }
        return { ok: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: message || 'Failed to remove project icon' };
      }
    },

    discoverProjectIcon: async (id: string, options?: { force?: boolean }) => {
      try {
        const response = await runtimeFetch(`/api/projects/${encodeURIComponent(id)}/icon/discover`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ force: options?.force === true }),
        });

        const payload = (await response.json().catch(() => null)) as {
          error?: string;
          skipped?: boolean;
          reason?: string;
          settings?: DesktopSettings;
        } | null;

        if (!response.ok) {
          return { ok: false, error: payload?.error || 'Failed to discover project icon' };
        }

        if (payload?.settings) {
          get().synchronizeFromSettings(payload.settings);
        }

        return {
          ok: true,
          skipped: payload?.skipped === true,
          reason: typeof payload?.reason === 'string' ? payload.reason : undefined,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: message || 'Failed to discover project icon' };
      }
    },

    reorderProjects: (fromIndex: number, toIndex: number) => {
      const { projects, activeProjectId } = get();
      if (
        fromIndex < 0 ||
        fromIndex >= projects.length ||
        toIndex < 0 ||
        toIndex >= projects.length ||
        fromIndex === toIndex
      ) {
        return;
      }

      const nextProjects = [...projects];
      const [moved] = nextProjects.splice(fromIndex, 1);
      nextProjects.splice(toIndex, 0, moved);

      const newOrder = nextProjects.map((p) => p.id);
      set({ projects: nextProjects, manualProjectOrder: newOrder });
      const catalogSnapshot = getReadyCatalogSnapshot();
      if (catalogSnapshot && nextProjects.every((project) => catalogSnapshot.workspaces.some((workspace) => workspace.id === project.id))) {
        queueCatalogOrderPersistence(nextProjects);
      } else {
        persistProjects(nextProjects, activeProjectId, newOrder);
      }
    },

    synchronizeFromSettings: (settings: DesktopSettings) => {
      const incomingProjects = sanitizeProjects(settings.projects ?? []);
      if (getReadyCatalogSnapshot()) {
        synchronizeProjectsFromCatalog();
        return;
      }
      const incomingActive = typeof settings.activeProjectId === 'string' && settings.activeProjectId.trim()
        ? settings.activeProjectId.trim()
        : null;

      const current = get();

      const projectsChanged = JSON.stringify(current.projects) !== JSON.stringify(incomingProjects);
      const activeChanged = current.activeProjectId !== incomingActive;

      if (!projectsChanged && !activeChanged) {
        return;
      }

      const incomingIds = new Set(incomingProjects.map((p) => p.id));
      const cleanedOrder = get().manualProjectOrder.filter((id) => incomingIds.has(id));
      set({ projects: incomingProjects, activeProjectId: incomingActive, manualProjectOrder: cleanedOrder });
      cacheProjects(incomingProjects, incomingActive);
      persistManualProjectOrder(cleanedOrder);

      if (incomingActive && !hasActiveWorkspaceSession()) {
        const activeProject = incomingProjects.find((project) => project.id === incomingActive);
        if (activeProject) {
          opencodeClient.setDirectory(activeProject.path);
          useDirectoryStore.getState().setDirectory(activeProject.path, { showOverlay: false });
        }
      }
    },

    getActiveProject: () => {
      const { projects, activeProjectId } = get();
      if (!activeProjectId) {
        return null;
      }
      return projects.find((project) => project.id === activeProjectId) ?? null;
    },

  }), { name: 'projects-store' })
);

synchronizeProjectsFromCatalog = () => {
  const snapshot = getReadyCatalogSnapshot();
  if (!snapshot) return;

  const nextProjects = catalogProjectsFromSnapshot(snapshot);
  const current = useProjectsStore.getState();
  const currentActiveProject = current.projects.find((project) => project.id === current.activeProjectId) ?? null;
  const currentDirectory = normalizeProjectPath(useDirectoryStore.getState().currentDirectory);
  const activeProject = (currentActiveProject
    ? nextProjects.find((project) => project.path === normalizeProjectPath(currentActiveProject.path))
    : null)
    ?? nextProjects.find((project) => project.path === currentDirectory)
    ?? (current.activeProjectId ? nextProjects.find((project) => project.id === current.activeProjectId) : null)
    ?? nextProjects[0]
    ?? null;
  const nextActiveProjectId = activeProject?.id ?? null;
  const nextManualOrder = nextProjects.map((project) => project.id);

  if (
    JSON.stringify(current.projects) === JSON.stringify(nextProjects)
    && current.activeProjectId === nextActiveProjectId
    && JSON.stringify(current.manualProjectOrder) === JSON.stringify(nextManualOrder)
  ) {
    return;
  }
  useProjectsStore.setState({
    projects: nextProjects,
    activeProjectId: nextActiveProjectId,
    manualProjectOrder: nextManualOrder,
  });
};

// Catalog refreshes are authoritative only when they succeed. A failed
// control-plane refresh leaves the legacy projection untouched, preserving
// the old projects view for recovery and compatibility.
useWorkspaceCatalogStore.subscribe((state) => {
  if (state.status === 'ready' && state.snapshot) {
    synchronizeProjectsFromCatalog();
  }
});

if (typeof window !== 'undefined') {
  window.addEventListener('openchamber:settings-synced', (event: Event) => {
    const detail = (event as CustomEvent<DesktopSettings>).detail;
    if (detail && typeof detail === 'object') {
      useProjectsStore.getState().synchronizeFromSettings(detail);
    }
  });
}
