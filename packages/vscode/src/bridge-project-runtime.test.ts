import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchControlPlaneCatalogProjects,
  handleProjectBridgeMessage,
  matchFolderToCatalogProject,
  normalizePathForMatch,
  type ProjectDescriptorLike,
} from './bridge-project-runtime';
import type { WorkspaceFolderCandidate } from './workspaceResolver';

const FOLDER_ALPHA: WorkspaceFolderCandidate = { name: 'alpha', path: '/work/alpha' };
const FOLDER_BRAVO: WorkspaceFolderCandidate = { name: 'bravo', path: '/work/bravo' };

const descriptor = (overrides: Partial<ProjectDescriptorLike>): ProjectDescriptorLike => ({
  id: 'ws-1',
  connectionId: 'local',
  path: '/work/alpha',
  canonicalPath: '/work/alpha',
  label: 'Alpha',
  orderKey: '000000000001',
  createdAt: 100,
  updatedAt: 200,
  ...overrides,
});

const readFolders = (folders: WorkspaceFolderCandidate[]) => () => folders;

describe('bridge-project-runtime descriptor resolution', () => {
  test('no_folder when the window has no workspace folders', async () => {
    const response = await handleProjectBridgeMessage(
      { id: '1', type: 'api:workspace:descriptor:get', payload: {} },
      { readWorkspaceFolders: readFolders([]), fetchCatalogProjects: async () => null },
    );

    assert.equal(response?.success, true);
    assert.deepEqual(response?.data, {
      status: 'no_folder',
      workspaceFolders: [],
      activePath: null,
    });
  });

  test('capability_unavailable when the catalog is unreachable, with an explicit code and reason', async () => {
    const response = await handleProjectBridgeMessage(
      { id: '2', type: 'api:workspace:descriptor:get', payload: { activePath: '/work/alpha' } },
      {
        readWorkspaceFolders: readFolders([FOLDER_ALPHA, FOLDER_BRAVO]),
        fetchCatalogProjects: async () => null,
      },
    );

    assert.equal(response?.success, true);
    const data = response?.data as Record<string, unknown>;
    assert.equal(data.status, 'capability_unavailable');
    assert.equal(data.code, 'capability_unavailable');
    assert.equal(data.reason, 'control_plane_unavailable');
    assert.deepEqual(data.workspaceFolders, [FOLDER_ALPHA, FOLDER_BRAVO]);
    assert.equal(data.activePath, '/work/alpha');
    assert.equal('projectId' in data, false);
    assert.equal('project' in data, false);
  });

  test('available resolves the active folder to a catalog descriptor with a stable projectId', async () => {
    const catalog = [descriptor({ id: 'ws-alpha' }), descriptor({ id: 'ws-bravo', path: '/work/bravo', canonicalPath: '/work/bravo', label: 'Bravo' })];
    const response = await handleProjectBridgeMessage(
      { id: '3', type: 'api:workspace:descriptor:get', payload: { activePath: '/work/bravo' } },
      {
        readWorkspaceFolders: readFolders([FOLDER_ALPHA, FOLDER_BRAVO]),
        fetchCatalogProjects: async () => catalog,
      },
    );

    const data = response?.data as { status: string; projectId: string; project: ProjectDescriptorLike; activePath: string };
    assert.equal(data.status, 'available');
    assert.equal(data.projectId, 'ws-bravo');
    assert.equal(data.project.label, 'Bravo');
    assert.equal(data.activePath, '/work/bravo');
  });

  test('available falls back to the first folder when no activePath is supplied', async () => {
    const catalog = [descriptor({ id: 'ws-alpha' })];
    const response = await handleProjectBridgeMessage(
      { id: '4', type: 'api:workspace:descriptor:get' },
      {
        readWorkspaceFolders: readFolders([FOLDER_ALPHA, FOLDER_BRAVO]),
        fetchCatalogProjects: async () => catalog,
      },
    );

    const data = response?.data as { status: string; projectId: string };
    assert.equal(data.status, 'available');
    assert.equal(data.projectId, 'ws-alpha');
  });

  test('available falls back to a folder match when the activePath matches no folder', async () => {
    const catalog = [descriptor({ id: 'ws-alpha' })];
    const response = await handleProjectBridgeMessage(
      { id: '5', type: 'api:workspace:descriptor:get', payload: { activePath: '/work/nonexistent' } },
      {
        readWorkspaceFolders: readFolders([FOLDER_ALPHA, FOLDER_BRAVO]),
        fetchCatalogProjects: async () => catalog,
      },
    );

    const data = response?.data as { status: string; projectId: string };
    assert.equal(data.status, 'available');
    assert.equal(data.projectId, 'ws-alpha');
  });

  test('not_found when the catalog is reachable but no folder is cataloged', async () => {
    const response = await handleProjectBridgeMessage(
      { id: '6', type: 'api:workspace:descriptor:get' },
      {
        readWorkspaceFolders: readFolders([FOLDER_ALPHA]),
        fetchCatalogProjects: async () => [descriptor({ id: 'ws-other', path: '/work/other', canonicalPath: '/work/other' })],
      },
    );

    const data = response?.data as { status: string; workspaceFolders: WorkspaceFolderCandidate[] };
    assert.equal(data.status, 'not_found');
    assert.deepEqual(data.workspaceFolders, [FOLDER_ALPHA]);
  });

  test('unknown message types fall through to the bridge dispatcher', async () => {
    const response = await handleProjectBridgeMessage(
      { id: '7', type: 'api:something-else' },
      { readWorkspaceFolders: readFolders([FOLDER_ALPHA]), fetchCatalogProjects: async () => null },
    );
    assert.equal(response, null);
  });
});

describe('fetchControlPlaneCatalogProjects', () => {
  const snapshotResponse = (projects: unknown[], status = 200): Response => new Response(
    JSON.stringify({
      schemaVersion: 2,
      revision: 3,
      connections: [],
      projects,
      migration: { legacyProjectsImported: true, pendingConnectionIds: [] },
    }),
    { status, headers: { 'content-type': 'application/json' } },
  );

  const stubFetch = (
    respond: (url: string, init?: RequestInit) => Response | Promise<Response>,
  ): { fetchImpl: (url: string, init?: RequestInit) => Promise<Response>; calls: Array<{ url: string; init: RequestInit }> } => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    return {
      calls,
      fetchImpl: async (url: string, init?: RequestInit) => {
        calls.push({ url, init: init || {} });
        return respond(url, init);
      },
    };
  };

  test('maps a reachable catalog snapshot to descriptor shapes with auth headers', async () => {
    const { fetchImpl, calls } = stubFetch(() => snapshotResponse([
      {
        id: 'ws-1',
        connectionId: 'local',
        path: '/work/alpha',
        canonicalPath: '/work/alpha',
        label: 'Alpha',
        orderKey: '000000000001',
        createdAt: 100,
        updatedAt: 200,
        color: '#66800B',
      },
    ]));

    const result = await fetchControlPlaneCatalogProjects({
      origin: 'http://control.test:3000',
      authHeaders: { Authorization: 'Basic abc123' },
      fetchImpl,
    });

    assert.deepEqual(result, [{
      id: 'ws-1',
      connectionId: 'local',
      path: '/work/alpha',
      canonicalPath: '/work/alpha',
      label: 'Alpha',
      color: '#66800B',
      orderKey: '000000000001',
      createdAt: 100,
      updatedAt: 200,
    }]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://control.test:3000/api/projects');
    assert.deepEqual(calls[0].init.headers, { Accept: 'application/json', Authorization: 'Basic abc123' });
  });

  test('preserves a path-prefixed control-plane origin', async () => {
    const { fetchImpl, calls } = stubFetch(() => snapshotResponse([]));
    await fetchControlPlaneCatalogProjects({ origin: 'http://host:8080/openchamber/', fetchImpl });
    assert.equal(calls[0]?.url, 'http://host:8080/openchamber/api/projects');
  });

  test('returns null without fetching when no control plane origin is configured', async () => {
    const { fetchImpl, calls } = stubFetch(() => snapshotResponse([]));
    const result = await fetchControlPlaneCatalogProjects({ origin: null, fetchImpl });
    assert.equal(result, null);
    assert.equal(calls.length, 0);
  });

  test('returns null on a non-2xx catalog response', async () => {
    const { fetchImpl, calls } = stubFetch(() => new Response(JSON.stringify({ error: 'boom' }), { status: 503 }));
    const result = await fetchControlPlaneCatalogProjects({ origin: 'http://control.test', fetchImpl });
    assert.equal(result, null);
    assert.equal(calls.length, 1);
  });

  test('returns null when the control plane is unreachable (fetch throws)', async () => {
    const { fetchImpl } = stubFetch(() => { throw new TypeError('fetch failed'); });
    const result = await fetchControlPlaneCatalogProjects({ origin: 'http://control.test', fetchImpl });
    assert.equal(result, null);
  });

  test('returns null for a 2xx payload that is not a catalog snapshot', async () => {
    const { fetchImpl } = stubFetch(() => new Response(JSON.stringify({ hello: 'world' }), { status: 200 }));
    const result = await fetchControlPlaneCatalogProjects({ origin: 'http://control.test', fetchImpl });
    assert.equal(result, null);
  });

  test('returns null for a 2xx non-JSON body', async () => {
    const { fetchImpl } = stubFetch(() => new Response('not json at all', { status: 200 }));
    const result = await fetchControlPlaneCatalogProjects({ origin: 'http://control.test', fetchImpl });
    assert.equal(result, null);
  });

  test('drops malformed entries but keeps valid ones', async () => {
    const { fetchImpl } = stubFetch(() => snapshotResponse([
      { id: 'ws-ok', connectionId: 'local', path: '/work/ok', canonicalPath: '/work/ok', label: 'Ok' },
      { id: 'ws-bad', canonicalPath: '/work/bad' },
      'garbage',
      null,
    ]));
    const result = await fetchControlPlaneCatalogProjects({ origin: 'http://control.test', fetchImpl });
    assert.equal(result?.length, 1);
    assert.equal(result?.[0]?.id, 'ws-ok');
  });

  test('returns an empty array (not null) for a reachable empty catalog', async () => {
    const { fetchImpl } = stubFetch(() => snapshotResponse([]));
    const result = await fetchControlPlaneCatalogProjects({ origin: 'http://control.test', fetchImpl });
    assert.deepEqual(result, []);
  });

  test('available descriptor resolution drives the real fetch seam end to end', async () => {
    const { fetchImpl } = stubFetch(() => snapshotResponse([
      descriptor({ id: 'ws-alpha' }),
    ]));
    const response = await handleProjectBridgeMessage(
      { id: 'e2e', type: 'api:workspace:descriptor:get', payload: { activePath: '/work/alpha' } },
      {
        readWorkspaceFolders: readFolders([FOLDER_ALPHA]),
        fetchCatalogProjects: () => fetchControlPlaneCatalogProjects({
          origin: 'http://control.test',
          authHeaders: { Authorization: 'Basic abc123' },
          fetchImpl,
        }),
      },
    );
    const data = response?.data as { status: string; projectId: string };
    assert.equal(data.status, 'available');
    assert.equal(data.projectId, 'ws-alpha');
  });

  test('unreachable real fetch seam still answers capability_unavailable without fabricating an id', async () => {
    const { fetchImpl } = stubFetch(() => { throw new TypeError('fetch failed'); });
    const response = await handleProjectBridgeMessage(
      { id: 'e2e-unreachable', type: 'api:workspace:descriptor:get' },
      {
        readWorkspaceFolders: readFolders([FOLDER_ALPHA]),
        fetchCatalogProjects: () => fetchControlPlaneCatalogProjects({ origin: null, fetchImpl }),
      },
    );
    const data = response?.data as Record<string, unknown>;
    assert.equal(data.status, 'capability_unavailable');
    assert.equal(data.code, 'capability_unavailable');
    assert.equal(data.reason, 'control_plane_unavailable');
    assert.equal('projectId' in data, false);
  });
});

describe('normalizePathForMatch', () => {
  test('normalizes backslashes, trailing separators and Windows drive letters', () => {
    assert.equal(normalizePathForMatch('C:\\work\\alpha\\'), 'C:/work/alpha');
    assert.equal(normalizePathForMatch('c:/work/alpha'), 'C:/work/alpha');
    assert.equal(normalizePathForMatch('/work/alpha///'), '/work/alpha');
    assert.equal(normalizePathForMatch('/'), '/');
  });
});

describe('matchFolderToCatalogProject', () => {
  test('matches a folder to a project by normalized canonicalPath', () => {
    const catalog = [descriptor({ id: 'ws-alpha', canonicalPath: '/work/alpha//' })];
    const match = matchFolderToCatalogProject([FOLDER_ALPHA], '/work/alpha', catalog);
    assert.equal(match?.project.id, 'ws-alpha');
    assert.equal(match?.folder.path, '/work/alpha');
  });

  test('matches Windows folder paths against canonicalized descriptors', () => {
    const catalog = [descriptor({ id: 'ws-win', path: 'C:/work/alpha', canonicalPath: 'C:/work/alpha' })];
    const windowsFolder: WorkspaceFolderCandidate = { name: 'alpha', path: 'c:\\work\\alpha' };
    const match = matchFolderToCatalogProject([windowsFolder], null, catalog);
    assert.equal(match?.project.id, 'ws-win');
  });

  test('returns null when no folder is cataloged', () => {
    const match = matchFolderToCatalogProject([FOLDER_ALPHA], null, [descriptor({ id: 'ws-other', canonicalPath: '/work/other' })]);
    assert.equal(match, null);
  });
});
