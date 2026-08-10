import { create, type StoreApi } from 'zustand';
import {
  createWorkspace as createWorkspaceRequest,
  deleteWorkspace as deleteWorkspaceRequest,
  fetchCatalogSnapshot,
  updateWorkspace as updateWorkspaceRequest,
} from './catalog-client';
import { CatalogClientError, type WorkspaceCatalogSnapshot, type WorkspaceCreateInput, type WorkspaceDescriptor, type WorkspaceUpdateInput } from './types';

/**
 * Workspace Catalog store (renderer).
 *
 * - Authority: server catalog. A failed authoritative load never replaces a
 *   prior snapshot and never renders as "no workspaces".
 * - Mutations are optimistic for label/color/orderKey and delete (the local
 *   descriptor already exists), with entity-scoped rollback on failure: only
 *   the affected workspace is reverted, never the whole snapshot, so
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
  snapshot: WorkspaceCatalogSnapshot | null;
  status: CatalogStatus;
  lastError: string | null;
  refresh: () => Promise<void>;
  createWorkspace: (input: WorkspaceCreateInput) => Promise<WorkspaceDescriptor>;
  updateWorkspace: (workspaceId: string, patch: WorkspaceUpdateInput) => Promise<WorkspaceDescriptor>;
  deleteWorkspace: (workspaceId: string) => Promise<void>;
  require: (workspaceId: string) => WorkspaceDescriptor;
}

// Monotonic generation for refresh: only the latest issued refresh may apply
// its response. A slower (older) response must not clobber newer state.
let refreshGeneration = 0;

const applySnapshot = (state: CatalogState, snapshot: WorkspaceCatalogSnapshot) => ({
  snapshot,
  status: 'ready' as const,
  lastError: null,
});

const replayCreate = async (
  get: () => CatalogState,
  set: StoreApi<CatalogState>['setState'],
  input: WorkspaceCreateInput,
): Promise<WorkspaceDescriptor> => {
  await get().refresh();
  const result = await createWorkspaceRequest(input);
  set((state) => {
    if (!state.snapshot) return state;
    const existing = state.snapshot.workspaces.some((workspace) => workspace.id === result.workspace.id);
    return {
      snapshot: {
        ...state.snapshot,
        revision: result.revision,
        workspaces: existing
          ? state.snapshot.workspaces.map((workspace) => workspace.id === result.workspace.id ? result.workspace : workspace)
          : [...state.snapshot.workspaces, result.workspace],
      },
      status: 'ready',
      lastError: null,
    };
  });
  return result.workspace;
};

const replayUpdate = async (
  get: () => CatalogState,
  set: StoreApi<CatalogState>['setState'],
  workspaceId: string,
  patch: WorkspaceUpdateInput,
): Promise<WorkspaceDescriptor> => {
  await get().refresh();
  const snapshot = get().snapshot;
  if (!snapshot) {
    throw new CatalogClientError('Workspace not found in catalog', 404, 'catalog_workspace_not_found');
  }
  const result = await updateWorkspaceRequest(workspaceId, patch, snapshot.revision);
  set((state) => state.snapshot
    ? {
        snapshot: {
          ...state.snapshot,
          revision: result.revision,
          workspaces: state.snapshot.workspaces.map((workspace) => workspace.id === workspaceId ? result.workspace : workspace),
        },
        status: 'ready',
        lastError: null,
      }
    : state);
  return result.workspace;
};

const replayDelete = async (
  get: () => CatalogState,
  set: StoreApi<CatalogState>['setState'],
  workspaceId: string,
): Promise<void> => {
  await get().refresh();
  const snapshot = get().snapshot;
  if (!snapshot) {
    throw new CatalogClientError('Workspace not found in catalog', 404, 'catalog_workspace_not_found');
  }
  const revision = await deleteWorkspaceRequest(workspaceId, snapshot.revision);
  set((state) => state.snapshot
    ? {
        snapshot: {
          ...state.snapshot,
          revision,
          workspaces: state.snapshot.workspaces.filter((workspace) => workspace.id !== workspaceId),
        },
        status: 'ready',
        lastError: null,
      }
    : state);
};

const isRevisionConflict = (error: unknown): boolean => (
  error instanceof CatalogClientError && error.code === 'catalog_revision_conflict'
);

export const useWorkspaceCatalogStore = create<CatalogState>()((set, get) => ({
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
        lastError: error instanceof CatalogClientError ? error.message : error instanceof Error ? error.message : 'Failed to load workspaces',
        snapshot: state.snapshot,
      }));
    }
  },

  createWorkspace: async (input) => {
    try {
      const result = await createWorkspaceRequest(input);
      set((state) => {
        if (!state.snapshot) return state;
        const existing = state.snapshot.workspaces.some((workspace) => workspace.id === result.workspace.id);
        return {
          snapshot: {
            ...state.snapshot,
            revision: result.revision,
            workspaces: existing
              ? state.snapshot.workspaces.map((workspace) => workspace.id === result.workspace.id ? result.workspace : workspace)
              : [...state.snapshot.workspaces, result.workspace],
          },
          status: 'ready',
          lastError: null,
        };
      });
      return result.workspace;
    } catch (error) {
      if (isRevisionConflict(error)) {
        return replayCreate(get, set, input);
      }
      throw error;
    }
  },

  updateWorkspace: async (workspaceId, patch) => {
    const previous = get().snapshot;
    const target = previous?.workspaces.find((workspace) => workspace.id === workspaceId);
    if (!previous || !target) {
      throw new CatalogClientError('Workspace not found in catalog', 404, 'catalog_workspace_not_found');
    }
    // Optimistic update; on failure revert ONLY the affected descriptor so
    // concurrent successes on other workspaces survive the rollback.
    const optimistic: WorkspaceDescriptor = {
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
            workspaces: state.snapshot.workspaces.map((workspace) => workspace.id === workspaceId ? optimistic : workspace),
          },
        }
      : state);
    try {
      const result = await updateWorkspaceRequest(workspaceId, patch, previous.revision);
      set((state) => state.snapshot
        ? {
            snapshot: {
              ...state.snapshot,
              revision: result.revision,
              workspaces: state.snapshot.workspaces.map((workspace) => workspace.id === workspaceId ? result.workspace : workspace),
            },
            lastError: null,
          }
        : state);
      return result.workspace;
    } catch (error) {
      if (isRevisionConflict(error)) {
        return replayUpdate(get, set, workspaceId, patch);
      }
      set((state) => state.snapshot
        ? {
            snapshot: {
              ...state.snapshot,
              workspaces: state.snapshot.workspaces.map((workspace) => workspace.id === workspaceId ? target : workspace),
            },
            status: 'ready',
            lastError: error instanceof Error ? error.message : 'Failed to update workspace',
          }
        : { snapshot: previous, status: 'ready', lastError: error instanceof Error ? error.message : 'Failed to update workspace' });
      throw error;
    }
  },

  deleteWorkspace: async (workspaceId) => {
    const previous = get().snapshot;
    if (!previous) {
      throw new CatalogClientError('Workspace not found in catalog', 404, 'catalog_workspace_not_found');
    }
    const targetIndex = previous.workspaces.findIndex((workspace) => workspace.id === workspaceId);
    const target = targetIndex >= 0 ? previous.workspaces[targetIndex] : null;
    if (!target) {
      throw new CatalogClientError('Workspace not found in catalog', 404, 'catalog_workspace_not_found');
    }
    // Optimistic removal; on failure re-insert ONLY the removed descriptor at
    // its previous position so concurrent changes elsewhere survive.
    set((state) => state.snapshot
      ? {
          snapshot: {
            ...state.snapshot,
            workspaces: state.snapshot.workspaces.filter((workspace) => workspace.id !== workspaceId),
          },
        }
      : state);
    try {
      const revision = await deleteWorkspaceRequest(workspaceId, previous.revision);
      set((state) => state.snapshot
        ? { snapshot: { ...state.snapshot, revision }, lastError: null }
        : state);
    } catch (error) {
      if (isRevisionConflict(error)) {
        return replayDelete(get, set, workspaceId);
      }
      set((state) => state.snapshot
        ? {
            snapshot: {
              ...state.snapshot,
              workspaces: state.snapshot.workspaces.some((workspace) => workspace.id === workspaceId)
                ? state.snapshot.workspaces
                : [
                    ...state.snapshot.workspaces.slice(0, targetIndex),
                    target,
                    ...state.snapshot.workspaces.slice(targetIndex),
                  ],
            },
            status: 'ready',
            lastError: error instanceof Error ? error.message : 'Failed to delete workspace',
          }
        : { snapshot: previous, status: 'ready', lastError: error instanceof Error ? error.message : 'Failed to delete workspace' });
      throw error;
    }
  },

  require: (workspaceId) => {
    const workspace = get().snapshot?.workspaces.find((entry) => entry.id === workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} is not in the catalog`);
    }
    return workspace;
  },
}));
