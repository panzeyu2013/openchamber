import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { useProjectCatalogStore } from './catalog-store';
import {
  CatalogClientError,
  type CatalogMutationResult,
  type ProjectCatalogSnapshot,
  type ProjectCreateInput,
  type ProjectDescriptor,
  type ProjectUpdateInput,
} from './types';

let fetchSnapshotImpl: () => Promise<ProjectCatalogSnapshot>;
let createImpl: (input: ProjectCreateInput) => Promise<CatalogMutationResult>;
let updateImpl: (
  projectId: string,
  patch: ProjectUpdateInput,
  ifMatchRevision: number,
) => Promise<{ project: ProjectDescriptor; revision: number }>;
let deleteImpl: (projectId: string, ifMatchRevision: number) => Promise<number>;
const fetchSnapshotCalls: number[] = [];
const createCalls: Array<ProjectCreateInput> = [];

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
    if (path === '/api/projects') {
      if (method === 'GET') return jsonResponse(await fetchSnapshotImpl());
      if (method === 'POST') return jsonResponse(await createImpl(JSON.parse(String(init?.body))));
    }
    const mutation = path.match(/^\/api\/projects\/([^/]+)$/);
    if (mutation) {
      const projectId = decodeURIComponent(mutation[1]);
      const ifMatchRevision = Number(new Headers(init?.headers).get('if-match'));
      if (method === 'PATCH') {
        return jsonResponse(await updateImpl(projectId, JSON.parse(String(init?.body)), ifMatchRevision));
      }
      if (method === 'DELETE') return jsonResponse({ revision: await deleteImpl(projectId, ifMatchRevision) });
    }
  } catch (error) {
    return errorResponse(error);
  }
  return jsonResponse({ error: 'Not found', code: 'catalog_http_error' }, 404);
};

const originalFetch = globalThis.fetch;
globalThis.fetch = stubControlPlaneFetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

const makeDescriptor = (id: string, overrides: Partial<ProjectDescriptor> = {}): ProjectDescriptor => ({
  id,
  connectionId: 'conn-1',
  path: `/home/${id}`,
  canonicalPath: `/home/${id}`,
  label: `Project ${id}`,
  orderKey: `order-${id}`,
  createdAt: 1000,
  updatedAt: 1000,
  ...overrides,
});

const makeSnapshot = (revision: number, projects: ProjectDescriptor[]): ProjectCatalogSnapshot => ({
  schemaVersion: 1,
  revision,
  connections: [],
  projects,
  migration: { legacyProjectsImported: true, pendingConnectionIds: [] },
});

describe('project catalog store', () => {
  beforeEach(() => {
    fetchSnapshotCalls.length = 0;
    createCalls.length = 0;
    useProjectCatalogStore.setState({ snapshot: null, status: 'idle', lastError: null });
    globalThis.fetch = stubControlPlaneFetch;
    fetchSnapshotImpl = async () => makeSnapshot(1, []);
    createImpl = async (input) => ({
      project: makeDescriptor('ws-created', { path: input.path, canonicalPath: input.path, label: input.label ?? 'Created project' }),
      revision: 2,
      created: true,
    });
    updateImpl = async () => ({ project: makeDescriptor('ws-1'), revision: 2 });
    deleteImpl = async () => 2;
  });

  test('refresh success sets status ready and stores the snapshot', async () => {
    fetchSnapshotImpl = async () => makeSnapshot(1, [makeDescriptor('ws-1')]);
    await useProjectCatalogStore.getState().refresh();
    const state = useProjectCatalogStore.getState();
    expect(state.status).toBe('ready');
    expect(state.lastError).toBeNull();
    expect(state.snapshot).toEqual(makeSnapshot(1, [makeDescriptor('ws-1')]));
  });

  test('refresh failure keeps the previous snapshot and marks error', async () => {
    fetchSnapshotImpl = async () => makeSnapshot(1, [makeDescriptor('ws-1')]);
    await useProjectCatalogStore.getState().refresh();
    const previous = useProjectCatalogStore.getState().snapshot;

    fetchSnapshotImpl = async () => {
      throw new CatalogClientError('Catalog down', 503, 'catalog_http_error');
    };
    await useProjectCatalogStore.getState().refresh();

    const state = useProjectCatalogStore.getState();
    expect(state.status).toBe('error');
    expect(state.lastError).toBe('Catalog down');
    expect(state.snapshot).toBe(previous);
    expect(state.snapshot).not.toBeNull();
    expect(state.snapshot).toEqual(makeSnapshot(1, [makeDescriptor('ws-1')]));
  });

  test('createProject inserts the descriptor and updates the revision', async () => {
    await useProjectCatalogStore.getState().refresh();
    const created = await useProjectCatalogStore.getState().createProject({ connectionId: 'conn-1', path: '/home/new' });
    expect(created).toEqual(makeDescriptor('ws-created', { path: '/home/new', canonicalPath: '/home/new', label: 'Created project' }));
    const state = useProjectCatalogStore.getState();
    expect(state.snapshot?.revision).toBe(2);
    expect(state.snapshot?.projects).toEqual([created]);
  });

  test('createProject replays after a 409 revision conflict', async () => {
    fetchSnapshotImpl = async () => {
      fetchSnapshotCalls.push(1);
      return makeSnapshot(1, []);
    };
    await useProjectCatalogStore.getState().refresh();
    expect(fetchSnapshotCalls).toHaveLength(1);

    let conflicted = true;
    createImpl = async (input) => {
      createCalls.push(input);
      if (conflicted) {
        conflicted = false;
        throw new CatalogClientError('Catalog revision conflict', 409, 'catalog_revision_conflict');
      }
      return {
        project: makeDescriptor('ws-created', { path: input.path, canonicalPath: input.path }),
        revision: 3,
        created: false,
      };
    };

    const result = await useProjectCatalogStore.getState().createProject({ connectionId: 'conn-1', path: '/home/replay' });
    expect(result).toEqual(makeDescriptor('ws-created', { path: '/home/replay', canonicalPath: '/home/replay' }));
    expect(createCalls).toHaveLength(2);
    expect(fetchSnapshotCalls).toHaveLength(2);

    const state = useProjectCatalogStore.getState();
    expect(state.snapshot?.revision).toBe(3);
    expect(state.snapshot?.projects).toEqual([result]);
    expect(state.status).toBe('ready');
  });

  test('updateProject applies the optimistic label before the request resolves', async () => {
    fetchSnapshotImpl = async () => makeSnapshot(1, [makeDescriptor('ws-1')]);
    await useProjectCatalogStore.getState().refresh();

    let resolveUpdate: (value: { project: ProjectDescriptor; revision: number }) => void = () => {};
    updateImpl = () => new Promise((resolve) => { resolveUpdate = resolve; });

    const pending = useProjectCatalogStore.getState().updateProject('ws-1', { label: 'Optimistic' });
    expect(useProjectCatalogStore.getState().snapshot?.projects[0]?.label).toBe('Optimistic');

    resolveUpdate({ project: makeDescriptor('ws-1', { label: 'Server label', updatedAt: 2000 }), revision: 4 });
    const result = await pending;
    expect(result).toEqual(makeDescriptor('ws-1', { label: 'Server label', updatedAt: 2000 }));

    const state = useProjectCatalogStore.getState();
    expect(state.snapshot?.revision).toBe(4);
    expect(state.snapshot?.projects[0]).toEqual(makeDescriptor('ws-1', { label: 'Server label', updatedAt: 2000 }));
  });

  test('updateProject reverts only the affected descriptor on failure', async () => {
    const project = makeDescriptor('ws-1');
    fetchSnapshotImpl = async () => makeSnapshot(1, [project]);
    await useProjectCatalogStore.getState().refresh();

    updateImpl = async () => {
      throw new Error('update exploded');
    };
    await expect(useProjectCatalogStore.getState().updateProject('ws-1', { label: 'Nope' })).rejects.toThrow('update exploded');

    const state = useProjectCatalogStore.getState();
    expect(state.snapshot).toEqual(makeSnapshot(1, [project]));
    expect(state.status).toBe('ready');
    expect(state.lastError).toBe('update exploded');
  });

  test('updateProject failure does not wipe concurrent changes to other projects', async () => {
    fetchSnapshotImpl = async () => makeSnapshot(1, [makeDescriptor('ws-1'), makeDescriptor('ws-2')]);
    await useProjectCatalogStore.getState().refresh();

    // A concurrent successful update lands while the failing update is in flight.
    let resolveUpdate: (value: { project: ProjectDescriptor; revision: number }) => void = () => {};
    updateImpl = (projectId) => {
      if (projectId === 'ws-1') {
        return new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error('update exploded')), 5);
        });
      }
      return new Promise((resolve) => { resolveUpdate = resolve; });
    };
    const pending = useProjectCatalogStore.getState().updateProject('ws-2', { label: 'Concurrent' });
    resolveUpdate({ project: makeDescriptor('ws-2', { label: 'Concurrent', updatedAt: 2000 }), revision: 4 });
    await pending;
    expect(useProjectCatalogStore.getState().snapshot?.projects[1]?.label).toBe('Concurrent');

    await expect(useProjectCatalogStore.getState().updateProject('ws-1', { label: 'Nope' })).rejects.toThrow('update exploded');

    const state = useProjectCatalogStore.getState();
    const byId = new Map(state.snapshot?.projects.map((entry) => [entry.id, entry]));
    expect(byId.get('ws-1')?.label).toBe('Project ws-1');
    // The concurrent success survives the rollback.
    expect(byId.get('ws-2')?.label).toBe('Concurrent');
    expect(state.snapshot?.revision).toBe(4);
  });

  test('updateProject replays after a 409 revision conflict', async () => {
    fetchSnapshotImpl = async () => makeSnapshot(1, [makeDescriptor('ws-1')]);
    await useProjectCatalogStore.getState().refresh();

    let updateCalls = 0;
    updateImpl = async (projectId, _patch, ifMatchRevision) => {
      updateCalls += 1;
      if (updateCalls === 1) {
        throw new CatalogClientError('Catalog revision conflict', 409, 'catalog_revision_conflict');
      }
      expect(ifMatchRevision).toBe(7);
      return { project: makeDescriptor('ws-1', { label: 'Replayed', updatedAt: 3000 }), revision: 8 };
    };
    fetchSnapshotImpl = async () => makeSnapshot(7, [makeDescriptor('ws-1')]);

    const result = await useProjectCatalogStore.getState().updateProject('ws-1', { label: 'Replayed' });
    expect(updateCalls).toBe(2);
    expect(result.label).toBe('Replayed');
    const state = useProjectCatalogStore.getState();
    expect(state.snapshot?.revision).toBe(8);
    expect(state.snapshot?.projects[0]?.label).toBe('Replayed');
  });

  test('deleteProject removes the project optimistically and updates the revision', async () => {
    fetchSnapshotImpl = async () => makeSnapshot(1, [makeDescriptor('ws-1'), makeDescriptor('ws-2')]);
    await useProjectCatalogStore.getState().refresh();

    let resolveDelete: (value: number) => void = () => {};
    deleteImpl = () => new Promise((resolve) => { resolveDelete = resolve; });

    const pending = useProjectCatalogStore.getState().deleteProject('ws-1');
    expect(useProjectCatalogStore.getState().snapshot?.projects.map((entry) => entry.id)).toEqual(['ws-2']);

    resolveDelete(5);
    await pending;

    const state = useProjectCatalogStore.getState();
    expect(state.snapshot?.revision).toBe(5);
    expect(state.snapshot?.projects.map((entry) => entry.id)).toEqual(['ws-2']);
  });

  test('deleteProject re-inserts the removed descriptor on failure', async () => {
    fetchSnapshotImpl = async () => makeSnapshot(1, [makeDescriptor('ws-1'), makeDescriptor('ws-2')]);
    await useProjectCatalogStore.getState().refresh();

    deleteImpl = async () => {
      throw new Error('delete exploded');
    };
    await expect(useProjectCatalogStore.getState().deleteProject('ws-1')).rejects.toThrow('delete exploded');

    const state = useProjectCatalogStore.getState();
    expect(state.snapshot?.projects.map((entry) => entry.id)).toEqual(['ws-1', 'ws-2']);
    expect(state.status).toBe('ready');
    expect(state.lastError).toBe('delete exploded');
  });

  test('deleteProject replays after a 409 revision conflict', async () => {
    fetchSnapshotImpl = async () => makeSnapshot(1, [makeDescriptor('ws-1')]);
    await useProjectCatalogStore.getState().refresh();

    let deleteCalls = 0;
    deleteImpl = async (_projectId, ifMatchRevision) => {
      deleteCalls += 1;
      if (deleteCalls === 1) {
        throw new CatalogClientError('Catalog revision conflict', 409, 'catalog_revision_conflict');
      }
      expect(ifMatchRevision).toBe(9);
      return 10;
    };
    fetchSnapshotImpl = async () => makeSnapshot(9, [makeDescriptor('ws-1')]);

    await useProjectCatalogStore.getState().deleteProject('ws-1');
    expect(deleteCalls).toBe(2);
    const state = useProjectCatalogStore.getState();
    expect(state.snapshot?.revision).toBe(10);
    expect(state.snapshot?.projects).toEqual([]);
  });

  test('a stale refresh response cannot clobber a newer snapshot', async () => {
    const newer = makeSnapshot(5, [makeDescriptor('ws-1', { label: 'Newer' })]);
    fetchSnapshotImpl = async () => newer;
    await useProjectCatalogStore.getState().refresh();

    // First refresh starts but resolves SLOWLY with an older revision.
    let resolveSlow: (value: ProjectCatalogSnapshot) => void = () => {};
    const slowSnapshot = makeSnapshot(2, [makeDescriptor('ws-1', { label: 'Stale' })]);
    fetchSnapshotImpl = () => new Promise((resolve) => { resolveSlow = resolve; });
    const slowRefresh = useProjectCatalogStore.getState().refresh();

    // A second, faster refresh applies the authoritative newer snapshot.
    fetchSnapshotImpl = async () => newer;
    await useProjectCatalogStore.getState().refresh();
    expect(useProjectCatalogStore.getState().snapshot?.revision).toBe(5);

    // The stale response arrives late and must be dropped.
    resolveSlow(slowSnapshot);
    await slowRefresh;
    expect(useProjectCatalogStore.getState().snapshot?.revision).toBe(5);
    expect(useProjectCatalogStore.getState().snapshot?.projects[0]?.label).toBe('Newer');
  });

  test('require returns the descriptor for a known project and throws otherwise', async () => {
    fetchSnapshotImpl = async () => makeSnapshot(1, [makeDescriptor('ws-1')]);
    await useProjectCatalogStore.getState().refresh();

    expect(useProjectCatalogStore.getState().require('ws-1')).toEqual(makeDescriptor('ws-1'));
    expect(() => useProjectCatalogStore.getState().require('ws-unknown')).toThrow('Project ws-unknown is not in the catalog');

    useProjectCatalogStore.setState({ snapshot: null, status: 'idle', lastError: null });
    expect(() => useProjectCatalogStore.getState().require('ws-1')).toThrow();
  });
});
