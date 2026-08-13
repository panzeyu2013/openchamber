import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCatalogStore } from './catalog-store.js';
import { createLocalProjectAdapter } from './local-adapter.js';
import { createLegacyProjectMigration } from './migration.js';
import { isValidProjectId } from './project-identity.js';

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
    filePath: path.join(tempDir, 'project-catalog.json'),
  });
  localAdapter = createLocalProjectAdapter({ fs: fsPromises, path });
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const createMigration = () => createLegacyProjectMigration({ catalogStore, localAdapter, readSettings });

describe('createLegacyProjectMigration', () => {
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
    expect(snapshot.projects.map((entry) => entry.label).sort()).toEqual(['Alpha', 'beta']);
    for (const project of snapshot.projects) {
      expect(isValidProjectId(project.id)).toBe(true);
      expect(project.connectionId).toBe('local');
      expect(project.path).toBe(project.canonicalPath);
      expect(project.orderKey).toBe('');
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
    expect(snapshot.projects).toHaveLength(1);
  });

  it('skips duplicate paths instead of importing twice', async () => {
    settingsProjects.push({ path: alphaDir }, { path: alphaDir });
    const migration = createMigration();
    const outcome = await migration.run();

    expect(outcome.imported).toBe(1);
    expect(outcome.skipped).toBe(1);
    expect((await catalogStore.getSnapshot()).projects).toHaveLength(1);
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
    expect(snapshot.projects.map((entry) => entry.label).sort()).toEqual(['alpha', 'beta']);
    expect(snapshot.migration).toEqual({
      legacyProjectsImported: true,
      pendingConnectionIds: [path.join(tempDir, 'missing-project')],
    });
  });

  it('re-attempts pending paths on a later run once they become reachable', async () => {
    const lateProject = path.join(tempDir, 'late-project');
    settingsProjects.push({ path: lateProject }, { path: alphaDir });
    const migration = createMigration();
    const first = await migration.run();

    expect(first.status).toBe('done');
    expect(first.pendingPaths).toEqual([lateProject]);
    expect((await catalogStore.getSnapshot()).migration).toEqual({
      legacyProjectsImported: true,
      pendingConnectionIds: [lateProject],
    });

    // The project appears; the next boot run must import it and clear pending.
    fs.mkdirSync(lateProject);
    const second = await migration.run();
    expect(second.status).toBe('done');
    expect(second.imported).toBe(1);
    expect(second.pendingPaths).toEqual([]);

    const snapshot = await catalogStore.getSnapshot();
    expect(snapshot.projects.map((entry) => entry.label).sort()).toEqual(['alpha', 'late-project']);
    expect(snapshot.migration).toEqual({ legacyProjectsImported: true, pendingConnectionIds: [] });

    // A fully-clean state short-circuits on the next run.
    const third = await migration.run();
    expect(third.status).toBe('already-done');
  });

  it('keeps pending paths when they stay unreachable across runs', async () => {
    const stillMissing = path.join(tempDir, 'still-missing');
    settingsProjects.push({ path: stillMissing }, { path: alphaDir });
    const migration = createMigration();
    const first = await migration.run();
    expect(first.pendingPaths).toEqual([stillMissing]);

    const second = await migration.run();
    expect(second.status).toBe('done');
    expect(second.imported).toBe(0);
    expect(second.pendingPaths).toEqual([stillMissing]);
    expect((await catalogStore.getSnapshot()).migration).toEqual({
      legacyProjectsImported: true,
      pendingConnectionIds: [stillMissing],
    });
  });

  it('does not clear pending state when settings are unreadable during a retry', async () => {
    const missing = path.join(tempDir, 'missing-for-retry');
    settingsProjects.push({ path: missing }, { path: alphaDir });
    const migration = createMigration();
    await migration.run();
    expect((await catalogStore.getSnapshot()).migration.pendingConnectionIds).toEqual([missing]);

    readSettings.mockRejectedValue(new Error('settings are encrypted'));
    const retry = await migration.run();
    expect(retry.status).toBe('settings-unreadable');
    expect(retry.pendingPaths).toEqual([missing]);
    expect((await catalogStore.getSnapshot()).migration.pendingConnectionIds).toEqual([missing]);
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
    expect((await catalogStore.getSnapshot()).projects).toHaveLength(2);
  });

  it('carries the legacy project color into the project descriptor', async () => {
    settingsProjects.push({ path: alphaDir, label: 'Alpha', color: '#ABC' });
    const migration = createMigration();
    await migration.run();

    const snapshot = await catalogStore.getSnapshot();
    expect(snapshot.projects[0].color).toBe('#abc');
  });

  it('reports unreadable settings without importing anything', async () => {
    readSettings.mockRejectedValue(new Error('settings are encrypted'));
    const migration = createMigration();
    const outcome = await migration.run();

    expect(outcome).toEqual({ status: 'settings-unreadable', imported: 0, skipped: 0, pendingPaths: [] });
    const snapshot = await catalogStore.getSnapshot();
    expect(snapshot.projects).toHaveLength(0);
    expect(snapshot.migration.legacyProjectsImported).toBe(false);
    expect(snapshot.revision).toBe(0);
  });

  it('ignores projects without a string path', async () => {
    settingsProjects.push({ label: 'No path' }, { path: alphaDir });
    const migration = createMigration();
    const outcome = await migration.run();

    expect(outcome.imported).toBe(1);
    expect(outcome.skipped).toBe(0);
    expect((await catalogStore.getSnapshot()).projects).toHaveLength(1);
  });
});
