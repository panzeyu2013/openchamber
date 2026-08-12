import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  handleWorkspaceBridgeMessage,
  matchFolderToCatalogWorkspace,
  normalizePathForMatch,
  type WorkspaceDescriptorLike,
} from './bridge-workspace-runtime';
import type { WorkspaceFolderCandidate } from './workspaceResolver';

const FOLDER_ALPHA: WorkspaceFolderCandidate = { name: 'alpha', path: '/work/alpha' };
const FOLDER_BRAVO: WorkspaceFolderCandidate = { name: 'bravo', path: '/work/bravo' };

const descriptor = (overrides: Partial<WorkspaceDescriptorLike>): WorkspaceDescriptorLike => ({
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

describe('bridge-workspace-runtime descriptor resolution', () => {
  test('no_folder when the window has no workspace folders', async () => {
    const response = await handleWorkspaceBridgeMessage(
      { id: '1', type: 'api:workspace:descriptor:get', payload: {} },
      { readWorkspaceFolders: readFolders([]), fetchCatalogWorkspaces: async () => null },
    );

    assert.equal(response?.success, true);
    assert.deepEqual(response?.data, {
      status: 'no_folder',
      workspaceFolders: [],
      activePath: null,
    });
  });

  test('capability_unavailable when the catalog is unreachable, with an explicit code and reason', async () => {
    const response = await handleWorkspaceBridgeMessage(
      { id: '2', type: 'api:workspace:descriptor:get', payload: { activePath: '/work/alpha' } },
      {
        readWorkspaceFolders: readFolders([FOLDER_ALPHA, FOLDER_BRAVO]),
        fetchCatalogWorkspaces: async () => null,
      },
    );

    assert.equal(response?.success, true);
    const data = response?.data as Record<string, unknown>;
    assert.equal(data.status, 'capability_unavailable');
    assert.equal(data.code, 'capability_unavailable');
    assert.equal(data.reason, 'control_plane_unavailable');
    assert.deepEqual(data.workspaceFolders, [FOLDER_ALPHA, FOLDER_BRAVO]);
    assert.equal(data.activePath, '/work/alpha');
    assert.equal('workspaceId' in data, false);
    assert.equal('workspace' in data, false);
  });

  test('available resolves the active folder to a catalog descriptor with a stable workspaceId', async () => {
    const catalog = [descriptor({ id: 'ws-alpha' }), descriptor({ id: 'ws-bravo', path: '/work/bravo', canonicalPath: '/work/bravo', label: 'Bravo' })];
    const response = await handleWorkspaceBridgeMessage(
      { id: '3', type: 'api:workspace:descriptor:get', payload: { activePath: '/work/bravo' } },
      {
        readWorkspaceFolders: readFolders([FOLDER_ALPHA, FOLDER_BRAVO]),
        fetchCatalogWorkspaces: async () => catalog,
      },
    );

    const data = response?.data as { status: string; workspaceId: string; workspace: WorkspaceDescriptorLike; activePath: string };
    assert.equal(data.status, 'available');
    assert.equal(data.workspaceId, 'ws-bravo');
    assert.equal(data.workspace.label, 'Bravo');
    assert.equal(data.activePath, '/work/bravo');
  });

  test('available falls back to the first folder when no activePath is supplied', async () => {
    const catalog = [descriptor({ id: 'ws-alpha' })];
    const response = await handleWorkspaceBridgeMessage(
      { id: '4', type: 'api:workspace:descriptor:get' },
      {
        readWorkspaceFolders: readFolders([FOLDER_ALPHA, FOLDER_BRAVO]),
        fetchCatalogWorkspaces: async () => catalog,
      },
    );

    const data = response?.data as { status: string; workspaceId: string };
    assert.equal(data.status, 'available');
    assert.equal(data.workspaceId, 'ws-alpha');
  });

  test('available falls back to a folder match when the activePath matches no folder', async () => {
    const catalog = [descriptor({ id: 'ws-alpha' })];
    const response = await handleWorkspaceBridgeMessage(
      { id: '5', type: 'api:workspace:descriptor:get', payload: { activePath: '/work/nonexistent' } },
      {
        readWorkspaceFolders: readFolders([FOLDER_ALPHA, FOLDER_BRAVO]),
        fetchCatalogWorkspaces: async () => catalog,
      },
    );

    const data = response?.data as { status: string; workspaceId: string };
    assert.equal(data.status, 'available');
    assert.equal(data.workspaceId, 'ws-alpha');
  });

  test('not_found when the catalog is reachable but no folder is cataloged', async () => {
    const response = await handleWorkspaceBridgeMessage(
      { id: '6', type: 'api:workspace:descriptor:get' },
      {
        readWorkspaceFolders: readFolders([FOLDER_ALPHA]),
        fetchCatalogWorkspaces: async () => [descriptor({ id: 'ws-other', path: '/work/other', canonicalPath: '/work/other' })],
      },
    );

    const data = response?.data as { status: string; workspaceFolders: WorkspaceFolderCandidate[] };
    assert.equal(data.status, 'not_found');
    assert.deepEqual(data.workspaceFolders, [FOLDER_ALPHA]);
  });

  test('unknown message types fall through to the bridge dispatcher', async () => {
    const response = await handleWorkspaceBridgeMessage(
      { id: '7', type: 'api:something-else' },
      { readWorkspaceFolders: readFolders([FOLDER_ALPHA]), fetchCatalogWorkspaces: async () => null },
    );
    assert.equal(response, null);
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

describe('matchFolderToCatalogWorkspace', () => {
  test('matches a folder to a workspace by normalized canonicalPath', () => {
    const catalog = [descriptor({ id: 'ws-alpha', canonicalPath: '/work/alpha//' })];
    const match = matchFolderToCatalogWorkspace([FOLDER_ALPHA], '/work/alpha', catalog);
    assert.equal(match?.workspace.id, 'ws-alpha');
    assert.equal(match?.folder.path, '/work/alpha');
  });

  test('matches Windows folder paths against canonicalized descriptors', () => {
    const catalog = [descriptor({ id: 'ws-win', path: 'C:/work/alpha', canonicalPath: 'C:/work/alpha' })];
    const windowsFolder: WorkspaceFolderCandidate = { name: 'alpha', path: 'c:\\work\\alpha' };
    const match = matchFolderToCatalogWorkspace([windowsFolder], null, catalog);
    assert.equal(match?.workspace.id, 'ws-win');
  });

  test('returns null when no folder is cataloged', () => {
    const match = matchFolderToCatalogWorkspace([FOLDER_ALPHA], null, [descriptor({ id: 'ws-other', canonicalPath: '/work/other' })]);
    assert.equal(match, null);
  });
});
