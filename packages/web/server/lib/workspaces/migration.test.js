import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCatalogStore } from './catalog-store.js';
import { createLocalWorkspaceAdapter } from './local-adapter.js';
import { createLegacyWorkspaceMigration } from './migration.js';
import { isValidWorkspaceId } from './workspace-identity.js';

const fsPromises = fs.promises;

let tempDir;
let alphaDir;
let betaDir;
let catalogStore;
let localAdapter;
let settingsProjects;
let readSettings;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-test-'));
  alphaDir = path.join(tempDir, 'alpha');
  betaDir = path.join(tempDir, 'beta');
  fs.mkdirSync(alphaDir);
  fs.mkdirSync(betaDir);

  settingsProjects = [];
  readSettings = vi.fn(async () => ({ projects: settingsProjects }));

  catalogStore = createCatalogStore({
    fs: fsPromises,
    path,
    filePath: path.join(tempDir, 'workspace-catalog.json'),
  });
  localAdapter = createLocalWorkspaceAdapter({ fs: fsPromises, path });
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const createMigration = () => createLegacyWorkspaceMigration({ catalogStore, localAdapter, readSettings });

describe('createLegacyWorkspaceMigration', () => {
  it('imports legacy projects with stable UUID ids', async () => {
    settingsProjects.push(
      { path: alphaDir, label: 'Alpha' },
      { path: betaDir },
      { path: alphaDir, label: '', color: '#ABC' },
    );

    const migration = createMigration();
    const outcome = await migration.run();

    expect(outcome.status).toBe('done');
    expect(outcome.committed).toBe(true);
    expect(outcome.imported).toBe(2);
    expect(outcome.skipped).toBe(1);
    expect(outcome.pendingPaths).toEqual([]);

    const snapshot = await catalogStore.getSnapshot();
    expect(snapshot.migration).toEqual({ legacyProjectsImported: true, pendingConnectionIds: [] });
    expect(snapshot.workspaces.map((entry) => entry.label).sort()).toEqual(['Alpha', 'beta']);
    for (const workspace of snapshot.workspaces) {
      expect(isValidWorkspaceId(workspace.id)).toBe(true);
      expect(workspace.connectionId).toBe('local');
      expect(workspace.path).toBe(workspace.canonicalPath);
      expect(workspace.orderKey).toBe('');
    }

    const status = await migration.getStatus();
    expect(status).toEqual({ legacyProjectsImported: true, pendingConnectionIds: [], revision: snapshot.revision });
  });

  it('short-circuits with already-done once state is committed', async () => {
    settingsProjects.push({ path: alphaDir });
    const migration = createMigration();

    const first = await migration.run();
    const revisionAfterFirst = (await catalogStore.getSnapshot()).revision;
    const second = await migration.run();

    expect(first.status).toBe('done');
    expect(second).toEqual({ status: 'already-done', imported: 0, skipped: 0, pendingPaths: [] });
    const snapshot = await catalogStore.getSnapshot();
    expect(snapshot.revision).toBe(revisionAfterFirst);
    expect(snapshot.workspaces).toHaveLength(1);
  });

  it('skips duplicate paths instead of importing twice', async () => {
    settingsProjects.push({ path: alphaDir }, { path: alphaDir });
    const migration = createMigration();
    const outcome = await migration.run();

    expect(outcome.imported).toBe(1);
    expect(outcome.skipped).toBe(1);
    expect((await catalogStore.getSnapshot()).workspaces).toHaveLength(1);
  });

  it('records missing paths as pending without blocking the rest', async () => {
    settingsProjects.push(
      { path: alphaDir },
      { path: path.join(tempDir, 'missing-project') },
      { path: betaDir },
    );
    const migration = createMigration();
    const outcome = await migration.run();

    expect(outcome.status).toBe('done');
    expect(outcome.imported).toBe(2);
    expect(outcome.pendingPaths).toEqual([path.join(tempDir, 'missing-project')]);

    const snapshot = await catalogStore.getSnapshot();
    expect(snapshot.workspaces.map((entry) => entry.label).sort()).toEqual(['alpha', 'beta']);
    expect(snapshot.migration).toEqual({
      legacyProjectsImported: true,
      pendingConnectionIds: [path.join(tempDir, 'missing-project')],
    });
  });

  it('commits legacyProjectsImported after a successful run', async () => {
    settingsProjects.push({ path: alphaDir });
    const migration = createMigration();
    await migration.run();

    expect((await catalogStore.getSnapshot()).migration.legacyProjectsImported).toBe(true);
    expect((await migration.getStatus()).legacyProjectsImported).toBe(true);
  });

  it('is idempotent across repeated runs', async () => {
    settingsProjects.push({ path: alphaDir }, { path: betaDir });
    const migration = createMigration();

    const first = await migration.run();
    const second = await migration.run();
    const third = await migration.run();

    expect(first.status).toBe('done');
    expect(second.status).toBe('already-done');
    expect(third.status).toBe('already-done');
    expect((await catalogStore.getSnapshot()).workspaces).toHaveLength(2);
  });

  it('carries the legacy project color into the workspace descriptor', async () => {
    settingsProjects.push({ path: alphaDir, label: 'Alpha', color: '#ABC' });
    const migration = createMigration();
    await migration.run();

    const snapshot = await catalogStore.getSnapshot();
    expect(snapshot.workspaces[0].color).toBe('#abc');
  });

  it('reports unreadable settings without importing anything', async () => {
    readSettings.mockRejectedValue(new Error('settings are encrypted'));
    const migration = createMigration();
    const outcome = await migration.run();

    expect(outcome).toEqual({ status: 'settings-unreadable', imported: 0, skipped: 0, pendingPaths: [] });
    const snapshot = await catalogStore.getSnapshot();
    expect(snapshot.workspaces).toHaveLength(0);
    expect(snapshot.migration.legacyProjectsImported).toBe(false);
    expect(snapshot.revision).toBe(0);
  });

  it('ignores projects without a string path', async () => {
    settingsProjects.push({ label: 'No path' }, { path: alphaDir });
    const migration = createMigration();
    const outcome = await migration.run();

    expect(outcome.imported).toBe(1);
    expect(outcome.skipped).toBe(0);
    expect((await catalogStore.getSnapshot()).workspaces).toHaveLength(1);
  });
});
