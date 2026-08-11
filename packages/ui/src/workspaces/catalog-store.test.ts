import { beforeEach, describe, expect, test } from 'bun:test';
import { useWorkspaceCatalogStore } from './catalog-store';
import {
  CatalogClientError,
  type CatalogMutationResult,
  type WorkspaceCatalogSnapshot,
  type WorkspaceCreateInput,
  type WorkspaceDescriptor,
  type WorkspaceUpdateInput,
} from './types';

let fetchSnapshotImpl: () => Promise<WorkspaceCatalogSnapshot>;
let createImpl: (input: WorkspaceCreateInput) => Promise<CatalogMutationResult>;
let updateImpl: (
  workspaceId: string,
  patch: WorkspaceUpdateInput,
  ifMatchRevision: number,
) => Promise<{ workspace: WorkspaceDescriptor; revision: number }>;
let deleteImpl: (workspaceId: string, ifMatchRevision: number) => Promise<number>;
const fetchSnapshotCalls: number[] = [];
const createCalls: Array<WorkspaceCreateInput> = [];

// The store talks to the real catalog client, which fetches through the
// control-plane-pinned fetch calling the global fetch at request time; stub
// that with a minimal control-plane server whose per-route handlers are the
// per-test impls below (so the test bodies keep their current observable
// contract: response shapes, deferred resolutions, thrown errors, call
// counts).
const jsonResponse = (body: unknown, status = 200): Response => (
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
);

const errorResponse = (error: unknown): Response => {
  if (error instanceof CatalogClientError) {
    return jsonResponse({ error: error.message, code: error.code }, error.status);
  }
  return jsonResponse({ error: error instanceof Error ? error.message : 'Request failed' }, 500);
};

const stubControlPlaneFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const raw = input instanceof Request ? input.url : String(input);
  const path = raw.startsWith('http') ? new URL(raw).pathname : raw;
  const method = (init?.method ?? 'GET').toUpperCase();
  try {
    if (path === '/api/workspaces') {
      if (method === 'GET') return jsonResponse(await fetchSnapshotImpl());
      if (method === 'POST') return jsonResponse(await createImpl(JSON.parse(String(init?.body))));
    }
    const mutation = path.match(/^\/api\/workspaces\/([^/]+)$/);
    if (mutation) {
      const workspaceId = decodeURIComponent(mutation[1]);
      const ifMatchRevision = Number(new Headers(init?.headers).get('if-match'));
      if (method === 'PATCH') {
        return jsonResponse(await updateImpl(workspaceId, JSON.parse(String(init?.body)), ifMatchRevision));
      }
      if (method === 'DELETE') return jsonResponse({ revision: await deleteImpl(workspaceId, ifMatchRevision) });
    }
  } catch (error) {
    return errorResponse(error);
  }
  return jsonResponse({ error: 'Not found', code: 'catalog_http_error' }, 404);
};

globalThis.fetch = stubControlPlaneFetch;

const makeDescriptor = (id: string, overrides: Partial<WorkspaceDescriptor> = {}): WorkspaceDescriptor => ({
  id,
  connectionId: 'conn-1',
  path: `/home/${id}`,
  canonicalPath: `/home/${id}`,
  label: `Workspace ${id}`,
  orderKey: `order-${id}`,
  createdAt: 1000,
  updatedAt: 1000,
  ...overrides,
});

const makeSnapshot = (revision: number, workspaces: WorkspaceDescriptor[]): WorkspaceCatalogSnapshot => ({
  schemaVersion: 1,
  revision,
  connections: [],
  workspaces,
  migration: { legacyProjectsImported: true, pendingConnectionIds: [] },
});

describe('workspace catalog store', () => {
  beforeEach(() => {
    fetchSnapshotCalls.length = 0;
    createCalls.length = 0;
    useWorkspaceCatalogStore.setState({ snapshot: null, status: 'idle', lastError: null });
    globalThis.fetch = stubControlPlaneFetch;
    fetchSnapshotImpl = async () => makeSnapshot(1, []);
    createImpl = async (input) => ({
      workspace: makeDescriptor('ws-created', { path: input.path, canonicalPath: input.path, label: input.label ?? 'Created workspace' }),
      revision: 2,
      created: true,
    });
    updateImpl = async () => ({ workspace: makeDescriptor('ws-1'), revision: 2 });
    deleteImpl = async () => 2;
  });

  test('refresh success sets status ready and stores the snapshot', async () => {
    fetchSnapshotImpl = async () => makeSnapshot(1, [makeDescriptor('ws-1')]);
    await useWorkspaceCatalogStore.getState().refresh();
    const state = useWorkspaceCatalogStore.getState();
    expect(state.status).toBe('ready');
    expect(state.lastError).toBeNull();
    expect(state.snapshot).toEqual(makeSnapshot(1, [makeDescriptor('ws-1')]));
  });

  test('refresh failure keeps the previous snapshot and marks error', async () => {
    fetchSnapshotImpl = async () => makeSnapshot(1, [makeDescriptor('ws-1')]);
    await useWorkspaceCatalogStore.getState().refresh();
    const previous = useWorkspaceCatalogStore.getState().snapshot;

    fetchSnapshotImpl = async () => {
      throw new CatalogClientError('Catalog down', 503, 'catalog_http_error');
    };
    await useWorkspaceCatalogStore.getState().refresh();

    const state = useWorkspaceCatalogStore.getState();
    expect(state.status).toBe('error');
    expect(state.lastError).toBe('Catalog down');
    expect(state.snapshot).toBe(previous);
    expect(state.snapshot).not.toBeNull();
    expect(state.snapshot).toEqual(makeSnapshot(1, [makeDescriptor('ws-1')]));
  });

  test('createWorkspace inserts the descriptor and updates the revision', async () => {
    await useWorkspaceCatalogStore.getState().refresh();
    const created = await useWorkspaceCatalogStore.getState().createWorkspace({ connectionId: 'conn-1', path: '/home/new' });
    expect(created).toEqual(makeDescriptor('ws-created', { path: '/home/new', canonicalPath: '/home/new', label: 'Created workspace' }));
    const state = useWorkspaceCatalogStore.getState();
    expect(state.snapshot?.revision).toBe(2);
    expect(state.snapshot?.workspaces).toEqual([created]);
  });

  test('createWorkspace replays after a 409 revision conflict', async () => {
    fetchSnapshotImpl = async () => {
      fetchSnapshotCalls.push(1);
      return makeSnapshot(1, []);
    };
    await useWorkspaceCatalogStore.getState().refresh();
    expect(fetchSnapshotCalls).toHaveLength(1);

    let conflicted = true;
    createImpl = async (input) => {
      createCalls.push(input);
      if (conflicted) {
        conflicted = false;
        throw new CatalogClientError('Catalog revision conflict', 409, 'catalog_revision_conflict');
      }
      return {
        workspace: makeDescriptor('ws-created', { path: input.path, canonicalPath: input.path }),
        revision: 3,
        created: false,
      };
    };

    const result = await useWorkspaceCatalogStore.getState().createWorkspace({ connectionId: 'conn-1', path: '/home/replay' });
    expect(result).toEqual(makeDescriptor('ws-created', { path: '/home/replay', canonicalPath: '/home/replay' }));
    expect(createCalls).toHaveLength(2);
    expect(fetchSnapshotCalls).toHaveLength(2);

    const state = useWorkspaceCatalogStore.getState();
    expect(state.snapshot?.revision).toBe(3);
    expect(state.snapshot?.workspaces).toEqual([result]);
    expect(state.status).toBe('ready');
  });

  test('updateWorkspace applies the optimistic label before the request resolves', async () => {
    fetchSnapshotImpl = async () => makeSnapshot(1, [makeDescriptor('ws-1')]);
    await useWorkspaceCatalogStore.getState().refresh();

    let resolveUpdate: (value: { workspace: WorkspaceDescriptor; revision: number }) => void = () => {};
    updateImpl = () => new Promise((resolve) => { resolveUpdate = resolve; });

    const pending = useWorkspaceCatalogStore.getState().updateWorkspace('ws-1', { label: 'Optimistic' });
    expect(useWorkspaceCatalogStore.getState().snapshot?.workspaces[0]?.label).toBe('Optimistic');

    resolveUpdate({ workspace: makeDescriptor('ws-1', { label: 'Server label', updatedAt: 2000 }), revision: 4 });
    const result = await pending;
    expect(result).toEqual(makeDescriptor('ws-1', { label: 'Server label', updatedAt: 2000 }));

    const state = useWorkspaceCatalogStore.getState();
    expect(state.snapshot?.revision).toBe(4);
    expect(state.snapshot?.workspaces[0]).toEqual(makeDescriptor('ws-1', { label: 'Server label', updatedAt: 2000 }));
  });

  test('updateWorkspace reverts only the affected descriptor on failure', async () => {
    const workspace = makeDescriptor('ws-1');
    fetchSnapshotImpl = async () => makeSnapshot(1, [workspace]);
    await useWorkspaceCatalogStore.getState().refresh();

    updateImpl = async () => {
      throw new Error('update exploded');
    };
    await expect(useWorkspaceCatalogStore.getState().updateWorkspace('ws-1', { label: 'Nope' })).rejects.toThrow('update exploded');

    const state = useWorkspaceCatalogStore.getState();
    expect(state.snapshot).toEqual(makeSnapshot(1, [workspace]));
    expect(state.status).toBe('ready');
    expect(state.lastError).toBe('update exploded');
  });

  test('updateWorkspace failure does not wipe concurrent changes to other workspaces', async () => {
    fetchSnapshotImpl = async () => makeSnapshot(1, [makeDescriptor('ws-1'), makeDescriptor('ws-2')]);
    await useWorkspaceCatalogStore.getState().refresh();

    // A concurrent successful update lands while the failing update is in flight.
    let resolveUpdate: (value: { workspace: WorkspaceDescriptor; revision: number }) => void = () => {};
    updateImpl = (workspaceId) => {
      if (workspaceId === 'ws-1') {
        return new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error('update exploded')), 5);
        });
      }
      return new Promise((resolve) => { resolveUpdate = resolve; });
    };
    const pending = useWorkspaceCatalogStore.getState().updateWorkspace('ws-2', { label: 'Concurrent' });
    resolveUpdate({ workspace: makeDescriptor('ws-2', { label: 'Concurrent', updatedAt: 2000 }), revision: 4 });
    await pending;
    expect(useWorkspaceCatalogStore.getState().snapshot?.workspaces[1]?.label).toBe('Concurrent');

    await expect(useWorkspaceCatalogStore.getState().updateWorkspace('ws-1', { label: 'Nope' })).rejects.toThrow('update exploded');

    const state = useWorkspaceCatalogStore.getState();
    const byId = new Map(state.snapshot?.workspaces.map((entry) => [entry.id, entry]));
    expect(byId.get('ws-1')?.label).toBe('Workspace ws-1');
    // The concurrent success survives the rollback.
    expect(byId.get('ws-2')?.label).toBe('Concurrent');
    expect(state.snapshot?.revision).toBe(4);
  });

  test('updateWorkspace replays after a 409 revision conflict', async () => {
    fetchSnapshotImpl = async () => makeSnapshot(1, [makeDescriptor('ws-1')]);
    await useWorkspaceCatalogStore.getState().refresh();

    let updateCalls = 0;
    updateImpl = async (workspaceId, _patch, ifMatchRevision) => {
      updateCalls += 1;
      if (updateCalls === 1) {
        throw new CatalogClientError('Catalog revision conflict', 409, 'catalog_revision_conflict');
      }
      expect(ifMatchRevision).toBe(7);
      return { workspace: makeDescriptor('ws-1', { label: 'Replayed', updatedAt: 3000 }), revision: 8 };
    };
    fetchSnapshotImpl = async () => makeSnapshot(7, [makeDescriptor('ws-1')]);

    const result = await useWorkspaceCatalogStore.getState().updateWorkspace('ws-1', { label: 'Replayed' });
    expect(updateCalls).toBe(2);
    expect(result.label).toBe('Replayed');
    const state = useWorkspaceCatalogStore.getState();
    expect(state.snapshot?.revision).toBe(8);
    expect(state.snapshot?.workspaces[0]?.label).toBe('Replayed');
  });

  test('deleteWorkspace removes the workspace optimistically and updates the revision', async () => {
    fetchSnapshotImpl = async () => makeSnapshot(1, [makeDescriptor('ws-1'), makeDescriptor('ws-2')]);
    await useWorkspaceCatalogStore.getState().refresh();

    let resolveDelete: (value: number) => void = () => {};
    deleteImpl = () => new Promise((resolve) => { resolveDelete = resolve; });

    const pending = useWorkspaceCatalogStore.getState().deleteWorkspace('ws-1');
    expect(useWorkspaceCatalogStore.getState().snapshot?.workspaces.map((entry) => entry.id)).toEqual(['ws-2']);

    resolveDelete(5);
    await pending;

    const state = useWorkspaceCatalogStore.getState();
    expect(state.snapshot?.revision).toBe(5);
    expect(state.snapshot?.workspaces.map((entry) => entry.id)).toEqual(['ws-2']);
  });

  test('deleteWorkspace re-inserts the removed descriptor on failure', async () => {
    fetchSnapshotImpl = async () => makeSnapshot(1, [makeDescriptor('ws-1'), makeDescriptor('ws-2')]);
    await useWorkspaceCatalogStore.getState().refresh();

    deleteImpl = async () => {
      throw new Error('delete exploded');
    };
    await expect(useWorkspaceCatalogStore.getState().deleteWorkspace('ws-1')).rejects.toThrow('delete exploded');

    const state = useWorkspaceCatalogStore.getState();
    expect(state.snapshot?.workspaces.map((entry) => entry.id)).toEqual(['ws-1', 'ws-2']);
    expect(state.status).toBe('ready');
    expect(state.lastError).toBe('delete exploded');
  });

  test('deleteWorkspace replays after a 409 revision conflict', async () => {
    fetchSnapshotImpl = async () => makeSnapshot(1, [makeDescriptor('ws-1')]);
    await useWorkspaceCatalogStore.getState().refresh();

    let deleteCalls = 0;
    deleteImpl = async (_workspaceId, ifMatchRevision) => {
      deleteCalls += 1;
      if (deleteCalls === 1) {
        throw new CatalogClientError('Catalog revision conflict', 409, 'catalog_revision_conflict');
      }
      expect(ifMatchRevision).toBe(9);
      return 10;
    };
    fetchSnapshotImpl = async () => makeSnapshot(9, [makeDescriptor('ws-1')]);

    await useWorkspaceCatalogStore.getState().deleteWorkspace('ws-1');
    expect(deleteCalls).toBe(2);
    const state = useWorkspaceCatalogStore.getState();
    expect(state.snapshot?.revision).toBe(10);
    expect(state.snapshot?.workspaces).toEqual([]);
  });

  test('a stale refresh response cannot clobber a newer snapshot', async () => {
    const newer = makeSnapshot(5, [makeDescriptor('ws-1', { label: 'Newer' })]);
    fetchSnapshotImpl = async () => newer;
    await useWorkspaceCatalogStore.getState().refresh();

    // First refresh starts but resolves SLOWLY with an older revision.
    let resolveSlow: (value: WorkspaceCatalogSnapshot) => void = () => {};
    const slowSnapshot = makeSnapshot(2, [makeDescriptor('ws-1', { label: 'Stale' })]);
    fetchSnapshotImpl = () => new Promise((resolve) => { resolveSlow = resolve; });
    const slowRefresh = useWorkspaceCatalogStore.getState().refresh();

    // A second, faster refresh applies the authoritative newer snapshot.
    fetchSnapshotImpl = async () => newer;
    await useWorkspaceCatalogStore.getState().refresh();
    expect(useWorkspaceCatalogStore.getState().snapshot?.revision).toBe(5);

    // The stale response arrives late and must be dropped.
    resolveSlow(slowSnapshot);
    await slowRefresh;
    expect(useWorkspaceCatalogStore.getState().snapshot?.revision).toBe(5);
    expect(useWorkspaceCatalogStore.getState().snapshot?.workspaces[0]?.label).toBe('Newer');
  });

  test('require returns the descriptor for a known workspace and throws otherwise', async () => {
    fetchSnapshotImpl = async () => makeSnapshot(1, [makeDescriptor('ws-1')]);
    await useWorkspaceCatalogStore.getState().refresh();

    expect(useWorkspaceCatalogStore.getState().require('ws-1')).toEqual(makeDescriptor('ws-1'));
    expect(() => useWorkspaceCatalogStore.getState().require('ws-unknown')).toThrow('Workspace ws-unknown is not in the catalog');

    useWorkspaceCatalogStore.setState({ snapshot: null, status: 'idle', lastError: null });
    expect(() => useWorkspaceCatalogStore.getState().require('ws-1')).toThrow();
  });
});
