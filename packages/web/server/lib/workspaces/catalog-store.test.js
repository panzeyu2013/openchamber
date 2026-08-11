import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCatalogStore, catalogRevisionConflict } from './catalog-store.js';
import { isValidWorkspaceId } from './workspace-identity.js';

const fsPromises = fs.promises;

let tempDir;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-store-test-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const createStore = (dir = tempDir) => createCatalogStore({
  fs: fsPromises,
  path,
  filePath: path.join(dir, 'workspace-catalog.json'),
});

const createWorkspaceInput = (overrides = {}) => ({
  connectionId: 'local',
  canonicalPath: '/tmp/project',
  path: '/tmp/project',
  label: 'Project',
  color: null,
  orderKey: '',
  ...overrides,
});

describe('catalogRevisionConflict', () => {
  it('is a typed conflict carrying the 409 code', () => {
    const error = catalogRevisionConflict();
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('catalog_revision_conflict');
    expect(error.status).toBe(409);
  });
});

describe('createCatalogStore', () => {
  it('creates a workspace with a stable UUID id', async () => {
    const store = createStore();
    const outcome = await store.createWorkspace(createWorkspaceInput());

    expect(outcome.created).toBe(true);
    expect(outcome.revision).toBe(1);
    expect(isValidWorkspaceId(outcome.descriptor.id)).toBe(true);
    expect(outcome.descriptor).toEqual({
      id: outcome.descriptor.id,
      connectionId: 'local',
      path: '/tmp/project',
      canonicalPath: '/tmp/project',
      label: 'Project',
      orderKey: '',
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
    });
    expect(outcome.descriptor.createdAt).toBeGreaterThan(0);
  });

  it('returns the existing workspace for a duplicate location (idempotent retry)', async () => {
    const store = createStore();
    const first = await store.createWorkspace(createWorkspaceInput());
    const second = await store.createWorkspace(createWorkspaceInput());

    expect(second.created).toBe(false);
    expect(second.descriptor.id).toBe(first.descriptor.id);
    expect(second.revision).toBe(1);
    const snapshot = await store.getSnapshot();
    expect(snapshot.workspaces).toHaveLength(1);
  });

  it('creates a separate workspace for the same path on a different connection', async () => {
    const store = createStore();
    const local = await store.createWorkspace(createWorkspaceInput({ connectionId: 'local' }));
    const remote = await store.createWorkspace(createWorkspaceInput({ connectionId: 'remote-1' }));

    expect(remote.created).toBe(true);
    expect(remote.descriptor.id).not.toBe(local.descriptor.id);
    const snapshot = await store.getSnapshot();
    expect(snapshot.workspaces).toHaveLength(2);
  });

  it('increments the revision by exactly one per mutation', async () => {
    const store = createStore();
    const first = await store.createWorkspace(createWorkspaceInput());
    await store.createWorkspace(createWorkspaceInput({ canonicalPath: '/tmp/duplicate', path: '/tmp/duplicate' }));
    await store.createWorkspace(createWorkspaceInput({ canonicalPath: '/tmp/other', path: '/tmp/other', label: 'Other' }));

    expect((await store.getSnapshot()).revision).toBe(3);
    const duplicate = await store.createWorkspace(createWorkspaceInput({ canonicalPath: '/tmp/other', path: '/tmp/other', label: 'Other' }));
    expect(duplicate.revision).toBe(3);

    await store.updateWorkspace(first.descriptor.id, { label: 'Renamed' });
    expect((await store.getSnapshot()).revision).toBe(4);

    await store.deleteWorkspace(first.descriptor.id);
    expect((await store.getSnapshot()).revision).toBe(5);

    await store.setMigrationState({ legacyProjectsImported: true });
    expect((await store.getSnapshot()).revision).toBe(6);
  });

  it('exposes a public snapshot shape', async () => {
    const store = createStore();
    const initial = await store.getSnapshot();
    expect(initial).toEqual({
      schemaVersion: 1,
      revision: 0,
      connections: [],
      workspaces: [],
      migration: { legacyProjectsImported: false, pendingConnectionIds: [] },
    });

    await store.createWorkspace(createWorkspaceInput());
    await store.setConnections([{ id: 'c1', label: 'C1', capabilities: {} }]);
    const snapshot = await store.getSnapshot();
    expect(snapshot.connections).toEqual([{ id: 'c1', label: 'C1', capabilities: {} }]);
    expect(snapshot.workspaces).toHaveLength(1);
  });

  it('rejects a stale If-Match revision with a typed conflict', async () => {
    const store = createStore();
    const created = await store.createWorkspace(createWorkspaceInput());
    expect(created.revision).toBe(1);

    let conflict = null;
    try {
      await store.updateWorkspace(created.descriptor.id, { label: 'X' }, 0);
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(Error);
    expect(conflict.code).toBe('catalog_revision_conflict');
    expect(conflict.status).toBe(409);

    const updated = await store.updateWorkspace(created.descriptor.id, { label: 'X' }, 1);
    expect(updated.descriptor.label).toBe('X');
    expect(updated.revision).toBe(2);
  });

  it('applies a label/color/orderKey patch', async () => {
    const store = createStore();
    const created = await store.createWorkspace(createWorkspaceInput({ color: '#ABC' }));
    expect(created.descriptor.color).toBe('#abc');

    const updated = await store.updateWorkspace(created.descriptor.id, {
      label: 'New Label',
      color: null,
      orderKey: '99',
    });

    expect(updated.descriptor.label).toBe('New Label');
    expect(updated.descriptor).not.toHaveProperty('color');
    expect(updated.descriptor.orderKey).toBe('99');
    expect(updated.descriptor.updatedAt).toBeGreaterThanOrEqual(updated.descriptor.createdAt);
  });

  it('404s an update for an unknown workspace id', async () => {
    const store = createStore();
    let error = null;
    try {
      await store.updateWorkspace('missing-workspace', { label: 'X' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('catalog_workspace_not_found');
    expect(error.status).toBe(404);
  });

  it('deletes a workspace and 404s a second delete', async () => {
    const store = createStore();
    const created = await store.createWorkspace(createWorkspaceInput());

    const deleted = await store.deleteWorkspace(created.descriptor.id);
    expect(deleted.revision).toBe(2);
    expect((await store.getSnapshot()).workspaces).toHaveLength(0);
    expect(await store.getWorkspace(created.descriptor.id)).toBeNull();

    let error = null;
    try {
      await store.deleteWorkspace(created.descriptor.id);
    } catch (caught) {
      error = caught;
    }
    expect(error.code).toBe('catalog_workspace_not_found');
  });

  it('finds and lists workspaces by location and connection', async () => {
    const store = createStore();
    const local = await store.createWorkspace(createWorkspaceInput());
    await store.createWorkspace(createWorkspaceInput({ connectionId: 'remote-1', canonicalPath: '/remote/path', path: '/remote/path' }));

    const found = await store.findWorkspaceByLocation('local', '/tmp/project');
    expect(found.id).toBe(local.descriptor.id);
    expect(await store.findWorkspaceByLocation('remote-1', '/tmp/project')).toBeNull();

    const localList = await store.listWorkspacesForConnection('local');
    const remoteList = await store.listWorkspacesForConnection('remote-1');
    expect(localList).toHaveLength(1);
    expect(remoteList).toHaveLength(1);
    expect(await store.listWorkspacesForConnection('ghost')).toHaveLength(0);
  });

  it('recovers from the backup when the primary file is corrupt', async () => {
    const filePath = path.join(tempDir, 'workspace-catalog.json');
    const store = createStore();
    const created = await store.createWorkspace(createWorkspaceInput());

    fs.writeFileSync(filePath, '{garbage');

    const recovered = createStore();
    const document = await recovered.load();
    expect(document.workspaces).toHaveLength(1);
    expect(document.workspaces[0].id).toBe(created.descriptor.id);

    const snapshot = await recovered.getSnapshot();
    expect(snapshot.workspaces).toHaveLength(1);
    const diagnostics = await recovered.getDiagnostics();
    expect(diagnostics.recoveryState).toEqual({ recovered: true, reason: 'catalog file corrupt; recovered from backup' });
  });

  it('rejects a corrupt primary with no backup instead of silently emptying', async () => {
    const filePath = path.join(tempDir, 'workspace-catalog.json');
    fs.writeFileSync(filePath, 'not json at all');

    const store = createStore();
    let error = null;
    try {
      await store.load();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('catalog file is corrupt and no parseable backup exists');

    const diagnostics = await store.getDiagnostics();
    expect(diagnostics.loaded).toBe(false);
    expect(diagnostics.recoveryState).toEqual({ recovered: true, reason: 'catalog file corrupt; no parseable backup' });
  });

  it('also rejects a structurally invalid (wrong schema) primary with no backup', async () => {
    const filePath = path.join(tempDir, 'workspace-catalog.json');
    fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 99, revision: 0, connections: [], workspaces: [] }));

    const store = createStore();
    await expect(store.load()).rejects.toThrow('catalog file is corrupt and no parseable backup exists');
  });

  it('loads the valid subset but reports dropped entries as recovery', async () => {
    const filePath = path.join(tempDir, 'workspace-catalog.json');
    fs.writeFileSync(filePath, JSON.stringify({
      schemaVersion: 1,
      revision: 5,
      connections: [
        { id: 'ok-1', label: 'OK', capabilities: { pathBrowse: true } },
        { id: '', label: 'Bad id' },
        { id: 'ok-1', label: 'Duplicate' },
      ],
      workspaces: [
        {
          id: 'ws-1', connectionId: 'ok-1', path: '/a', canonicalPath: '/a', label: 'A',
          orderKey: '', createdAt: 1, updatedAt: 1,
        },
        { id: 'ws-2', connectionId: 'ok-1', path: '', canonicalPath: '/b', label: 'B' },
      ],
      migration: { legacyProjectsImported: true, pendingConnectionIds: [] },
    }));

    const store = createStore();
    const snapshot = await store.load();
    expect(snapshot.connections.map((entry) => entry.id)).toEqual(['ok-1']);
    expect(snapshot.workspaces.map((entry) => entry.id)).toEqual(['ws-1']);
    // The shrink is surfaced explicitly — never a silent clean load.
    const diagnostics = await store.getDiagnostics();
    expect(diagnostics.recoveryState).toEqual({
      recovered: true,
      reason: 'catalog file contained 2 invalid connection(s) and 1 invalid workspace(s); loaded the valid subset',
    });
    // The mutation queue still works on the loaded subset.
    const created = await store.createWorkspace({
      connectionId: 'ok-1', canonicalPath: '/c', path: '/c', label: 'C',
    });
    expect(created.created).toBe(true);
    // A later mutation clears the recovery state (the file is whole again).
    expect((await store.getDiagnostics()).recoveryState).toBeNull();
  });

  it('survives a restart on the same file', async () => {
    const first = createStore();
    await first.createWorkspace(createWorkspaceInput({ label: 'Alpha' }));
    await first.createWorkspace(createWorkspaceInput({ connectionId: 'remote-1', canonicalPath: '/remote/path', path: '/remote/path', label: 'Beta', color: '#ABC' }));
    await first.setConnections([{ id: 'c1', label: 'C1', capabilities: {} }]);
    await first.setMigrationState({ legacyProjectsImported: true, pendingConnectionIds: ['/gone'] });

    const second = createStore();
    await second.load();
    const firstSnapshot = await first.getSnapshot();
    const secondSnapshot = await second.getSnapshot();
    expect(secondSnapshot.revision).toBe(firstSnapshot.revision);
    expect(secondSnapshot.workspaces).toEqual(firstSnapshot.workspaces);
    expect(secondSnapshot.migration).toEqual(firstSnapshot.migration);
    expect(secondSnapshot.connections).toEqual([
      { id: 'c1', label: 'C1', capabilities: { pathBrowse: false, terminal: false, files: false, git: false, eventStream: false } },
    ]);

    const reloaded = await createStore().getSnapshot();
    expect(reloaded.workspaces.map((entry) => entry.label)).toEqual(['Alpha', 'Beta']);
    expect(reloaded.workspaces[1].color).toBe('#abc');
    expect(reloaded.migration).toEqual({ legacyProjectsImported: true, pendingConnectionIds: ['/gone'] });
  });

  it('commits migration state and keeps partial updates', async () => {
    const store = createStore();
    await store.setMigrationState({ legacyProjectsImported: true, pendingConnectionIds: ['/a', '/b'] });
    let snapshot = await store.getSnapshot();
    expect(snapshot.migration).toEqual({ legacyProjectsImported: true, pendingConnectionIds: ['/a', '/b'] });

    await store.setMigrationState({ pendingConnectionIds: ['/c'] });
    snapshot = await store.getSnapshot();
    expect(snapshot.migration.legacyProjectsImported).toBe(true);
    expect(snapshot.migration.pendingConnectionIds).toEqual(['/c']);
  });

  it('reports diagnostics for load state and counts', async () => {
    const store = createStore();
    const before = await store.getDiagnostics();
    expect(before).toEqual({
      schemaVersion: 1,
      revision: null,
      loaded: false,
      lastPersistSucceededAt: null,
      recoveryState: null,
      workspaceCount: null,
      connectionCount: null,
    });

    await store.createWorkspace(createWorkspaceInput());
    const after = await store.getDiagnostics();
    expect(after.loaded).toBe(true);
    expect(after.revision).toBe(1);
    expect(after.workspaceCount).toBe(1);
    expect(after.connectionCount).toBe(0);
    expect(after.lastPersistSucceededAt).toEqual(expect.any(Number));
    expect(after.recoveryState).toBeNull();
  });

  it('exposes the primary and backup file paths', async () => {
    const store = createStore();
    expect(store.filePath).toBe(path.join(tempDir, 'workspace-catalog.json'));
    expect(store.backupFilePath).toBe(path.join(tempDir, 'workspace-catalog.json.bak'));
  });

  it('reads never rewrite the store file (the disabled read gate is byte-preserving)', async () => {
    const filePath = path.join(tempDir, 'workspace-catalog.json');
    const store = createStore();
    await store.createWorkspace(createWorkspaceInput({ label: 'Alpha' }));
    await store.createWorkspace(createWorkspaceInput({
      connectionId: 'remote-1',
      canonicalPath: '/remote/path',
      path: '/remote/path',
      label: 'Beta',
    }));
    await store.setConnections([{ id: 'c1', label: 'C1', capabilities: {} }]);
    const beforeBytes = fs.readFileSync(filePath, 'utf8');

    // The flag-disabled surface is a READ GATE: the only store operations it
    // can trigger are load/reads. Those must never rewrite the file (no
    // persist call, no backup churn), so disabling can never corrupt, downgrade
    // or touch catalog data.
    const reader = createStore();
    await reader.load();
    const snapshot = await reader.getSnapshot();
    await reader.getWorkspace(snapshot.workspaces[0].id);
    await reader.findWorkspaceByLocation('remote-1', '/remote/path');
    await reader.listWorkspacesForConnection('local');
    await reader.getDiagnostics();

    expect(fs.readFileSync(filePath, 'utf8')).toBe(beforeBytes);
    expect(fs.existsSync(`${filePath}.bak`)).toBe(true);
    expect(fs.readFileSync(`${filePath}.bak`, 'utf8')).toBe(beforeBytes);
  });
});
