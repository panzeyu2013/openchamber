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
 *   descriptor already exists), with rollback to the captured snapshot on
 *   failure. Create is never optimistic: the server canonicalizes the path
 *   and the client cannot predict the canonicalPath or id.
 * - A 409 revision conflict re-fetches the snapshot and replays the mutation
 *   once (create idempotence: the server returns the existing descriptor for
 *   the same location, so replay cannot duplicate).
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

export const useWorkspaceCatalogStore = create<CatalogState>()((set, get) => ({
  snapshot: null,
  status: 'idle',
  lastError: null,

  refresh: async () => {
    try {
      const snapshot = await fetchCatalogSnapshot();
      set((state) => applySnapshot(state, snapshot));
    } catch (error) {
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
      if (error instanceof CatalogClientError && error.code === 'catalog_revision_conflict') {
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
    // Optimistic update; roll back to the captured snapshot on failure.
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
      set({ snapshot: previous, status: 'ready', lastError: error instanceof Error ? error.message : 'Failed to update workspace' });
      throw error;
    }
  },

  deleteWorkspace: async (workspaceId) => {
    const previous = get().snapshot;
    if (!previous) {
      throw new CatalogClientError('Workspace not found in catalog', 404, 'catalog_workspace_not_found');
    }
    // Optimistic removal; roll back on failure.
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
      set({ snapshot: previous, status: 'ready', lastError: error instanceof Error ? error.message : 'Failed to delete workspace' });
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
