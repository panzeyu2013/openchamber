import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCatalogStore, catalogRevisionConflict } from './catalog-store.js';
import { isValidProjectId } from './project-identity.js';

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
  filePath: path.join(dir, 'project-catalog.json'),
});

const createProjectInput = (overrides = {}) => ({
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
  it('creates a project with a stable UUID id', async () => {
    const store = createStore();
    const outcome = await store.createProject(createProjectInput());

    expect(outcome.created).toBe(true);
    expect(outcome.revision).toBe(1);
    expect(isValidProjectId(outcome.descriptor.id)).toBe(true);
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

  it('returns the existing project for a duplicate location (idempotent retry)', async () => {
    const store = createStore();
    const first = await store.createProject(createProjectInput());
    const second = await store.createProject(createProjectInput());

    expect(second.created).toBe(false);
    expect(second.descriptor.id).toBe(first.descriptor.id);
    expect(second.revision).toBe(1);
    const snapshot = await store.getSnapshot();
    expect(snapshot.projects).toHaveLength(1);
  });

  it('creates a separate project for the same path on a different connection', async () => {
    const store = createStore();
    const local = await store.createProject(createProjectInput({ connectionId: 'local' }));
    const remote = await store.createProject(createProjectInput({ connectionId: 'remote-1' }));

    expect(remote.created).toBe(true);
    expect(remote.descriptor.id).not.toBe(local.descriptor.id);
    const snapshot = await store.getSnapshot();
    expect(snapshot.projects).toHaveLength(2);
  });

  it('increments the revision by exactly one per mutation', async () => {
    const store = createStore();
    const first = await store.createProject(createProjectInput());
    await store.createProject(createProjectInput({ canonicalPath: '/tmp/duplicate', path: '/tmp/duplicate' }));
    await store.createProject(createProjectInput({ canonicalPath: '/tmp/other', path: '/tmp/other', label: 'Other' }));

    expect((await store.getSnapshot()).revision).toBe(3);
    const duplicate = await store.createProject(createProjectInput({ canonicalPath: '/tmp/other', path: '/tmp/other', label: 'Other' }));
    expect(duplicate.revision).toBe(3);

    await store.updateProject(first.descriptor.id, { label: 'Renamed' });
    expect((await store.getSnapshot()).revision).toBe(4);

    await store.deleteProject(first.descriptor.id);
    expect((await store.getSnapshot()).revision).toBe(5);

    await store.setMigrationState({ legacyProjectsImported: true });
    expect((await store.getSnapshot()).revision).toBe(6);
  });

  it('exposes a public snapshot shape', async () => {
    const store = createStore();
    const initial = await store.getSnapshot();
    expect(initial).toEqual({
      schemaVersion: 2,
      revision: 0,
      connections: [],
      projects: [],
      migration: { legacyProjectsImported: false, pendingConnectionIds: [] },
    });

    await store.createProject(createProjectInput());
    await store.setConnections([{ id: 'c1', label: 'C1', capabilities: {} }]);
    const snapshot = await store.getSnapshot();
    expect(snapshot.connections).toEqual([{ id: 'c1', label: 'C1', capabilities: {} }]);
    expect(snapshot.projects).toHaveLength(1);
  });

  it('rejects a stale If-Match revision with a typed conflict', async () => {
    const store = createStore();
    const created = await store.createProject(createProjectInput());
    expect(created.revision).toBe(1);

    let conflict = null;
    try {
      await store.updateProject(created.descriptor.id, { label: 'X' }, 0);
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(Error);
    expect(conflict.code).toBe('catalog_revision_conflict');
    expect(conflict.status).toBe(409);

    const updated = await store.updateProject(created.descriptor.id, { label: 'X' }, 1);
    expect(updated.descriptor.label).toBe('X');
    expect(updated.revision).toBe(2);
  });

  it('applies a label/color/orderKey patch', async () => {
    const store = createStore();
    const created = await store.createProject(createProjectInput({ color: '#ABC' }));
    expect(created.descriptor.color).toBe('#abc');

    const updated = await store.updateProject(created.descriptor.id, {
      label: 'New Label',
      color: null,
      orderKey: '99',
    });

    expect(updated.descriptor.label).toBe('New Label');
    expect(updated.descriptor).not.toHaveProperty('color');
    expect(updated.descriptor.orderKey).toBe('99');
    expect(updated.descriptor.updatedAt).toBeGreaterThanOrEqual(updated.descriptor.createdAt);
  });

  it('404s an update for an unknown project id', async () => {
    const store = createStore();
    let error = null;
    try {
      await store.updateProject('missing-project', { label: 'X' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('catalog_project_not_found');
    expect(error.status).toBe(404);
  });

  it('deletes a project and 404s a second delete', async () => {
    const store = createStore();
    const created = await store.createProject(createProjectInput());

    const deleted = await store.deleteProject(created.descriptor.id);
    expect(deleted.revision).toBe(2);
    expect((await store.getSnapshot()).projects).toHaveLength(0);
    expect(await store.getProject(created.descriptor.id)).toBeNull();

    let error = null;
    try {
      await store.deleteProject(created.descriptor.id);
    } catch (caught) {
      error = caught;
    }
    expect(error.code).toBe('catalog_project_not_found');
  });

  it('finds and lists projects by location and connection', async () => {
    const store = createStore();
    const local = await store.createProject(createProjectInput());
    await store.createProject(createProjectInput({ connectionId: 'remote-1', canonicalPath: '/remote/path', path: '/remote/path' }));

    const found = await store.findProjectByLocation('local', '/tmp/project');
    expect(found.id).toBe(local.descriptor.id);
    expect(await store.findProjectByLocation('remote-1', '/tmp/project')).toBeNull();

    const localList = await store.listProjectsForConnection('local');
    const remoteList = await store.listProjectsForConnection('remote-1');
    expect(localList).toHaveLength(1);
    expect(remoteList).toHaveLength(1);
    expect(await store.listProjectsForConnection('ghost')).toHaveLength(0);
  });

  it('recovers from the backup when the primary file is corrupt', async () => {
    const filePath = path.join(tempDir, 'project-catalog.json');
    const store = createStore();
    const created = await store.createProject(createProjectInput());

    fs.writeFileSync(filePath, '{garbage');

    const recovered = createStore();
    const document = await recovered.load();
    expect(document.projects).toHaveLength(1);
    expect(document.projects[0].id).toBe(created.descriptor.id);

    const snapshot = await recovered.getSnapshot();
    expect(snapshot.projects).toHaveLength(1);
    const diagnostics = await recovered.getDiagnostics();
    expect(diagnostics.recoveryState).toEqual({ recovered: true, reason: 'catalog file corrupt; recovered from backup' });
  });

  it('rejects a corrupt primary with no backup instead of silently emptying', async () => {
    const filePath = path.join(tempDir, 'project-catalog.json');
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
    const filePath = path.join(tempDir, 'project-catalog.json');
    fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 99, revision: 0, connections: [], projects: [] }));

    const store = createStore();
    await expect(store.load()).rejects.toThrow('catalog file is corrupt and no parseable backup exists');
  });

  it('loads the valid subset but reports dropped entries as recovery', async () => {
    const filePath = path.join(tempDir, 'project-catalog.json');
    fs.writeFileSync(filePath, JSON.stringify({
      schemaVersion: 2,
      revision: 5,
      connections: [
        { id: 'ok-1', label: 'OK', capabilities: { pathBrowse: true } },
        { id: '', label: 'Bad id' },
        { id: 'ok-1', label: 'Duplicate' },
      ],
      projects: [
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
    expect(snapshot.projects.map((entry) => entry.id)).toEqual(['ws-1']);
    // The shrink is surfaced explicitly — never a silent clean load.
    const diagnostics = await store.getDiagnostics();
    expect(diagnostics.recoveryState).toEqual({
      recovered: true,
      reason: 'catalog file contained 2 invalid connection(s) and 1 invalid project(s); loaded the valid subset',
    });
    // The mutation queue still works on the loaded subset.
    const created = await store.createProject({
      connectionId: 'ok-1', canonicalPath: '/c', path: '/c', label: 'C',
    });
    expect(created.created).toBe(true);
    // A later mutation clears the recovery state (the file is whole again).
    expect((await store.getDiagnostics()).recoveryState).toBeNull();
  });

  it('survives a restart on the same file', async () => {
    const first = createStore();
    await first.createProject(createProjectInput({ label: 'Alpha' }));
    await first.createProject(createProjectInput({ connectionId: 'remote-1', canonicalPath: '/remote/path', path: '/remote/path', label: 'Beta', color: '#ABC' }));
    await first.setConnections([{ id: 'c1', label: 'C1', capabilities: {} }]);
    await first.setMigrationState({ legacyProjectsImported: true, pendingConnectionIds: ['/gone'] });

    const second = createStore();
    await second.load();
    const firstSnapshot = await first.getSnapshot();
    const secondSnapshot = await second.getSnapshot();
    expect(secondSnapshot.revision).toBe(firstSnapshot.revision);
    expect(secondSnapshot.projects).toEqual(firstSnapshot.projects);
    expect(secondSnapshot.migration).toEqual(firstSnapshot.migration);
    expect(secondSnapshot.connections).toEqual([
      { id: 'c1', label: 'C1', capabilities: { pathBrowse: false, terminal: false, files: false, git: false, eventStream: false } },
    ]);

    const reloaded = await createStore().getSnapshot();
    expect(reloaded.projects.map((entry) => entry.label)).toEqual(['Alpha', 'Beta']);
    expect(reloaded.projects[1].color).toBe('#abc');
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
      schemaVersion: 2,
      revision: null,
      loaded: false,
      lastPersistSucceededAt: null,
      recoveryState: null,
      projectCount: null,
      connectionCount: null,
    });

    await store.createProject(createProjectInput());
    const after = await store.getDiagnostics();
    expect(after.loaded).toBe(true);
    expect(after.revision).toBe(1);
    expect(after.projectCount).toBe(1);
    expect(after.connectionCount).toBe(0);
    expect(after.lastPersistSucceededAt).toEqual(expect.any(Number));
    expect(after.recoveryState).toBeNull();
  });

  it('exposes the primary and backup file paths', async () => {
    const store = createStore();
    expect(store.filePath).toBe(path.join(tempDir, 'project-catalog.json'));
    expect(store.backupFilePath).toBe(path.join(tempDir, 'project-catalog.json.bak'));
  });

  it('reads never rewrite the store file (the disabled read gate is byte-preserving)', async () => {
    const filePath = path.join(tempDir, 'project-catalog.json');
    const store = createStore();
    await store.createProject(createProjectInput({ label: 'Alpha' }));
    await store.createProject(createProjectInput({
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
    await reader.getProject(snapshot.projects[0].id);
    await reader.findProjectByLocation('remote-1', '/remote/path');
    await reader.listProjectsForConnection('local');
    await reader.getDiagnostics();

    expect(fs.readFileSync(filePath, 'utf8')).toBe(beforeBytes);
    expect(fs.existsSync(`${filePath}.bak`)).toBe(true);
    expect(fs.readFileSync(`${filePath}.bak`, 'utf8')).toBe(beforeBytes);
  });
});

describe('legacy v1 catalog migration', () => {
  const legacyPath = () => path.join(tempDir, 'workspace-catalog.json');
  const newPath = () => path.join(tempDir, 'project-catalog.json');

  const legacyDocument = (overrides = {}) => ({
    schemaVersion: 1,
    revision: 4,
    connections: [{ id: 'conn-1', label: 'Local', capabilities: { pathBrowse: true } }],
    workspaces: [{
      id: 'ws-1',
      connectionId: 'conn-1',
      path: '/tmp/project',
      canonicalPath: '/tmp/project',
      label: 'Project',
      color: '#ABC',
      orderKey: '',
      createdAt: 1,
      updatedAt: 2,
    }],
    migration: { legacyProjectsImported: true, pendingConnectionIds: ['/gone'] },
    ...overrides,
  });

  it('migrates a legacy v1 file at the old path when the new path is missing', async () => {
    fs.writeFileSync(legacyPath(), JSON.stringify(legacyDocument()));

    const store = createStore();
    const snapshot = await store.load();
    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.revision).toBe(4);
    expect(snapshot.connections).toHaveLength(1);
    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.projects[0].id).toBe('ws-1');
    expect(snapshot.projects[0].color).toBe('#abc');
    expect(snapshot.migration).toEqual({ legacyProjectsImported: true, pendingConnectionIds: ['/gone'] });

    // The migrated document is written to the NEW path with the current
    // schema and `projects` key...
    const onDisk = JSON.parse(fs.readFileSync(newPath(), 'utf8'));
    expect(onDisk.schemaVersion).toBe(2);
    expect(onDisk.projects).toHaveLength(1);
    expect(onDisk.workspaces).toBeUndefined();
    // ...and the legacy file is preserved untouched as an explicit backup.
    expect(fs.existsSync(legacyPath())).toBe(true);
    const legacyOnDisk = JSON.parse(fs.readFileSync(legacyPath(), 'utf8'));
    expect(legacyOnDisk.schemaVersion).toBe(1);
    expect(Array.isArray(legacyOnDisk.workspaces)).toBe(true);

    // A reload reads the migrated new-path file (idempotent; no rewrite).
    const reloaded = createStore();
    expect((await reloaded.load()).projects).toHaveLength(1);
  });

  it('migrates a legacy v1 document present at the new path in place', async () => {
    fs.writeFileSync(newPath(), JSON.stringify(legacyDocument()));

    const store = createStore();
    const snapshot = await store.load();
    expect(snapshot.schemaVersion).toBe(2);
    expect(JSON.parse(fs.readFileSync(newPath(), 'utf8')).schemaVersion).toBe(2);
  });

  it('surfaces entries dropped during migration as an explicit recovery state', async () => {
    fs.writeFileSync(legacyPath(), JSON.stringify(legacyDocument({
      workspaces: [
        ...legacyDocument().workspaces,
        { id: '', connectionId: 'conn-1', path: '/b', canonicalPath: '/b', label: 'B' },
      ],
    })));

    const store = createStore();
    await store.load();
    const diagnostics = await store.getDiagnostics();
    expect(diagnostics.recoveryState.recovered).toBe(true);
    expect(diagnostics.recoveryState.reason).toContain('1 invalid project(s)');
    expect((await store.getSnapshot()).projects.map((entry) => entry.id)).toEqual(['ws-1']);
  });

  it('fails loudly when the legacy file is corrupt (never an empty catalog)', async () => {
    fs.writeFileSync(legacyPath(), 'not json');

    const store = createStore();
    await expect(store.load()).rejects.toThrow('legacy catalog file is corrupt and cannot be migrated');
    expect((await store.getDiagnostics()).loaded).toBe(false);
  });

  it('fails loudly when the legacy document cannot be migrated', async () => {
    fs.writeFileSync(legacyPath(), JSON.stringify({ schemaVersion: 1, revision: 0 }));

    const store = createStore();
    await expect(store.load()).rejects.toThrow('catalog migration failed');
    expect((await store.getDiagnostics()).loaded).toBe(false);
  });

  it('treats missing new and legacy files as a fresh empty v2 catalog', async () => {
    const store = createStore();
    const snapshot = await store.load();
    expect(snapshot).toEqual({
      schemaVersion: 2,
      revision: 0,
      connections: [],
      projects: [],
      migration: { legacyProjectsImported: false, pendingConnectionIds: [] },
    });
    expect(fs.existsSync(legacyPath())).toBe(false);
  });
});
