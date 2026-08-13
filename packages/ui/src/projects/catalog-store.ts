import { create, type StoreApi } from 'zustand';
import {
  createProject as createProjectRequest,
  deleteProject as deleteProjectRequest,
  fetchCatalogSnapshot,
  updateProject as updateProjectRequest,
} from './catalog-client';
import { CatalogClientError, type ProjectCatalogSnapshot, type ProjectCreateInput, type ProjectDescriptor, type ProjectUpdateInput } from './types';

/**
 * Project Catalog store (renderer).
 *
 * - Authority: server catalog. A failed authoritative load never replaces a
 *   prior snapshot and never renders as "no projects".
 * - Mutations are optimistic for label/color/orderKey and delete (the local
 *   descriptor already exists), with entity-scoped rollback on failure: only
 *   the affected project is reverted, never the whole snapshot, so
 *   concurrent successes in other entries survive the failure.
 * - A 409 revision conflict re-fetches the snapshot and replays the mutation
 *   once (create idempotence: the server returns the existing descriptor for
 *   the same location, so replay cannot duplicate; update/delete replay
 *   against the fresh revision).
 * - refresh() is generation-guarded: a stale response from an earlier refresh
 *   can never overwrite a newer snapshot applied by a later refresh.
 */

type CatalogStatus = 'idle' | 'loading' | 'ready' | 'error';

interface CatalogState {
  snapshot: ProjectCatalogSnapshot | null;
  status: CatalogStatus;
  lastError: string | null;
  refresh: () => Promise<void>;
  createProject: (input: ProjectCreateInput) => Promise<ProjectDescriptor>;
  updateProject: (projectId: string, patch: ProjectUpdateInput) => Promise<ProjectDescriptor>;
  deleteProject: (projectId: string) => Promise<void>;
  require: (projectId: string) => ProjectDescriptor;
}

// Monotonic generation for refresh: only the latest issued refresh may apply
// its response. A slower (older) response must not clobber newer state.
let refreshGeneration = 0;

const applySnapshot = (state: CatalogState, snapshot: ProjectCatalogSnapshot) => ({
  snapshot,
  status: 'ready' as const,
  lastError: null,
});

const replayCreate = async (
  get: () => CatalogState,
  set: StoreApi<CatalogState>['setState'],
  input: ProjectCreateInput,
): Promise<ProjectDescriptor> => {
  await get().refresh();
  const result = await createProjectRequest(input);
  set((state) => {
    if (!state.snapshot) return state;
    const existing = state.snapshot.projects.some((project) => project.id === result.project.id);
    return {
      snapshot: {
        ...state.snapshot,
        revision: result.revision,
        projects: existing
          ? state.snapshot.projects.map((project) => project.id === result.project.id ? result.project : project)
          : [...state.snapshot.projects, result.project],
      },
      status: 'ready',
      lastError: null,
    };
  });
  return result.project;
};

const replayUpdate = async (
  get: () => CatalogState,
  set: StoreApi<CatalogState>['setState'],
  projectId: string,
  patch: ProjectUpdateInput,
): Promise<ProjectDescriptor> => {
  await get().refresh();
  const snapshot = get().snapshot;
  if (!snapshot) {
    throw new CatalogClientError('Project not found in catalog', 404, 'catalog_project_not_found');
  }
  const result = await updateProjectRequest(projectId, patch, snapshot.revision);
  set((state) => state.snapshot
    ? {
        snapshot: {
          ...state.snapshot,
          revision: result.revision,
          projects: state.snapshot.projects.map((project) => project.id === projectId ? result.project : project),
        },
        status: 'ready',
        lastError: null,
      }
    : state);
  return result.project;
};

const replayDelete = async (
  get: () => CatalogState,
  set: StoreApi<CatalogState>['setState'],
  projectId: string,
): Promise<void> => {
  await get().refresh();
  const snapshot = get().snapshot;
  if (!snapshot) {
    throw new CatalogClientError('Project not found in catalog', 404, 'catalog_project_not_found');
  }
  const revision = await deleteProjectRequest(projectId, snapshot.revision);
  set((state) => state.snapshot
    ? {
        snapshot: {
          ...state.snapshot,
          revision,
          projects: state.snapshot.projects.filter((project) => project.id !== projectId),
        },
        status: 'ready',
        lastError: null,
      }
    : state);
};

const isRevisionConflict = (error: unknown): boolean => (
  error instanceof CatalogClientError && error.code === 'catalog_revision_conflict'
);

export const useProjectCatalogStore = create<CatalogState>()((set, get) => ({
  snapshot: null,
  status: 'idle',
  lastError: null,

  refresh: async () => {
    const generation = ++refreshGeneration;
    try {
      const snapshot = await fetchCatalogSnapshot();
      if (generation !== refreshGeneration) return;
      set((state) => applySnapshot(state, snapshot));
    } catch (error) {
      if (generation !== refreshGeneration) return;
      // Failure is NOT empty success: keep the prior snapshot, mark error.
      set((state) => ({
        status: 'error',
        lastError: error instanceof CatalogClientError ? error.message : error instanceof Error ? error.message : 'Failed to load projects',
        snapshot: state.snapshot,
      }));
    }
  },

  createProject: async (input) => {
    try {
      const result = await createProjectRequest(input);
      set((state) => {
        if (!state.snapshot) return state;
        const existing = state.snapshot.projects.some((project) => project.id === result.project.id);
        return {
          snapshot: {
            ...state.snapshot,
            revision: result.revision,
            projects: existing
              ? state.snapshot.projects.map((project) => project.id === result.project.id ? result.project : project)
              : [...state.snapshot.projects, result.project],
          },
          status: 'ready',
          lastError: null,
        };
      });
      return result.project;
    } catch (error) {
      if (isRevisionConflict(error)) {
        return replayCreate(get, set, input);
      }
      throw error;
    }
  },

  updateProject: async (projectId, patch) => {
    const previous = get().snapshot;
    const target = previous?.projects.find((project) => project.id === projectId);
    if (!previous || !target) {
      throw new CatalogClientError('Project not found in catalog', 404, 'catalog_project_not_found');
    }
    // Optimistic update; on failure revert ONLY the affected descriptor so
    // concurrent successes on other projects survive the rollback.
    const optimistic: ProjectDescriptor = {
      ...target,
      ...(patch.label !== undefined ? { label: patch.label } : {}),
      ...(patch.color !== undefined ? { color: patch.color || undefined } : {}),
      ...(patch.orderKey !== undefined ? { orderKey: patch.orderKey } : {}),
      updatedAt: Date.now(),
    };
    set((state) => state.snapshot
      ? {
          snapshot: {
            ...state.snapshot,
            projects: state.snapshot.projects.map((project) => project.id === projectId ? optimistic : project),
          },
        }
      : state);
    try {
      const result = await updateProjectRequest(projectId, patch, previous.revision);
      set((state) => state.snapshot
        ? {
            snapshot: {
              ...state.snapshot,
              revision: result.revision,
              projects: state.snapshot.projects.map((project) => project.id === projectId ? result.project : project),
            },
            lastError: null,
          }
        : state);
      return result.project;
    } catch (error) {
      if (isRevisionConflict(error)) {
        return replayUpdate(get, set, projectId, patch);
      }
      set((state) => state.snapshot
        ? {
            snapshot: {
              ...state.snapshot,
              projects: state.snapshot.projects.map((project) => project.id === projectId ? target : project),
            },
            status: 'ready',
            lastError: error instanceof Error ? error.message : 'Failed to update project',
          }
        : { snapshot: previous, status: 'ready', lastError: error instanceof Error ? error.message : 'Failed to update project' });
      throw error;
    }
  },

  deleteProject: async (projectId) => {
    const previous = get().snapshot;
    if (!previous) {
      throw new CatalogClientError('Project not found in catalog', 404, 'catalog_project_not_found');
    }
    const targetIndex = previous.projects.findIndex((project) => project.id === projectId);
    const target = targetIndex >= 0 ? previous.projects[targetIndex] : null;
    if (!target) {
      throw new CatalogClientError('Project not found in catalog', 404, 'catalog_project_not_found');
    }
    // Optimistic removal; on failure re-insert ONLY the removed descriptor at
    // its previous position so concurrent changes elsewhere survive.
    set((state) => state.snapshot
      ? {
          snapshot: {
            ...state.snapshot,
            projects: state.snapshot.projects.filter((project) => project.id !== projectId),
          },
        }
      : state);
    try {
      const revision = await deleteProjectRequest(projectId, previous.revision);
      set((state) => state.snapshot
        ? { snapshot: { ...state.snapshot, revision }, lastError: null }
        : state);
    } catch (error) {
      if (isRevisionConflict(error)) {
        return replayDelete(get, set, projectId);
      }
      set((state) => state.snapshot
        ? {
            snapshot: {
              ...state.snapshot,
              projects: state.snapshot.projects.some((project) => project.id === projectId)
                ? state.snapshot.projects
                : [
                    ...state.snapshot.projects.slice(0, targetIndex),
                    target,
                    ...state.snapshot.projects.slice(targetIndex),
                  ],
            },
            status: 'ready',
            lastError: error instanceof Error ? error.message : 'Failed to delete project',
          }
        : { snapshot: previous, status: 'ready', lastError: error instanceof Error ? error.message : 'Failed to delete project' });
      throw error;
    }
  },

  require: (projectId) => {
    const project = get().snapshot?.projects.find((entry) => entry.id === projectId);
    if (!project) {
      throw new Error(`Project ${projectId} is not in the catalog`);
    }
    return project;
  },
}));
