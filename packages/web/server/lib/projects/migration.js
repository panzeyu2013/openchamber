/**
 * Legacy migration: settings.projects -> Project Catalog.
 *
 * Runs on control plane boot and is idempotent + resumable:
 * - The built-in `local` connection is registered (profile store already
 *   ensures it).
 * - Each legacy local project is imported as a project keyed by
 *   (localConnectionId, adapter-canonicalized path). Existing locations are
 *   skipped (they already have stable UUIDs).
 * - A project whose path no longer exists is recorded in `pendingPaths` —
 *   never treated as an authoritative empty result, never blocking the rest.
 * - Migration state is committed to the catalog after each run; a later run
 *   resumes from where the last committed state stopped.
 * - A later run whose state says `legacyProjectsImported: true` but still
 *   lists pending paths RE-ATTEMPTS those paths (a temporarily unavailable
 *   project that recovers later must still be imported), and only clears the
 *   pending list once every pending path succeeded.
 *
 * The legacy projects cache stays readable for the whole compatibility
 * period (dual read). Deletion of legacy data is a separate, later,
 * audited release step — never part of this migration.
 */

import { LOCAL_CONNECTION_ID } from './local-adapter.js';

const DEFAULT_LABEL_FROM_PATH = (canonicalPath) => {
  const parts = canonicalPath.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : canonicalPath;
};

export const createLegacyProjectMigration = (dependencies) => {
  const {
    catalogStore,
    localAdapter,
    readSettings, // async () => settings document (sanitized)
  } = dependencies;

  const run = async () => {
    const catalog = await catalogStore.getSnapshot();
    const migration = catalog.migration;
    const pendingFromState = migration.legacyProjectsImported
      ? (Array.isArray(migration.pendingConnectionIds) ? migration.pendingConnectionIds : [])
      : null;
    if (pendingFromState !== null && pendingFromState.length === 0) {
      return { status: 'already-done', imported: 0, skipped: 0, pendingPaths: [] };
    }

    // Retry mode: a previous run completed but left pending paths; only those
    // paths are re-attempted (the rest of the legacy list is not re-scanned —
    // uniqueness constraints make re-imports harmless, but pending retries are
    // the point here). First run: process the full legacy project list.
    const retryOnly = pendingFromState !== null;

    let settings;
    try {
      settings = await readSettings();
    } catch {
      // In retry mode keep the committed pending state untouched; in first-run
      // mode nothing was committed yet, so nothing to preserve.
      return {
        status: 'settings-unreadable',
        imported: 0,
        skipped: 0,
        pendingPaths: retryOnly ? pendingFromState : [],
      };
    }
    const projects = Array.isArray(settings?.projects) ? settings.projects : [];
    const candidates = retryOnly
      ? pendingFromState.map((path) => ({ path }))
      : projects;

    const imported = [];
    const skipped = [];
    const pendingPaths = [];

    for (const project of candidates) {
      if (!project || typeof project.path !== 'string' || project.path.trim().length === 0) continue;
      try {
        const canonicalPath = await localAdapter.canonicalizePath({}, project.path);
        const label = project.label && project.label.trim().length > 0
          ? project.label.trim()
          : DEFAULT_LABEL_FROM_PATH(canonicalPath);
        const outcome = await catalogStore.createProject({
          connectionId: LOCAL_CONNECTION_ID,
          canonicalPath,
          path: canonicalPath,
          label,
          color: project.color ?? null,
          orderKey: '',
        });
        if (outcome.created) imported.push({ path: canonicalPath, id: outcome.descriptor.id });
        else skipped.push({ path: canonicalPath, id: outcome.descriptor.id });
      } catch (error) {
        if (error?.code === 'catalog_path_not_found' || error?.code === 'catalog_path_not_accessible') {
          pendingPaths.push(project.path);
        } else {
          throw error;
        }
      }
    }

    // Commit migration state with the CURRENT catalog revision (the create
    // loop advanced it). A concurrent writer may have bumped revision between
    // the last create and this commit; retry the commit once, then re-fetch.
    const setState = async (revision) => {
      try {
        await catalogStore.setMigrationState({
          legacyProjectsImported: true,
          pendingConnectionIds: pendingPaths,
        }, revision);
        return true;
      } catch (error) {
        if (error?.code === 'catalog_revision_conflict') return false;
        throw error;
      }
    };
    let committed = false;
    for (let attempt = 0; attempt < 3 && !committed; attempt += 1) {
      const snapshot = await catalogStore.getSnapshot();
      committed = await setState(snapshot.revision);
    }

    return {
      status: 'done',
      committed,
      imported: imported.length,
      skipped: skipped.length,
      pendingPaths,
    };
  };

  const getStatus = async () => {
    const catalog = await catalogStore.getSnapshot();
    return {
      legacyProjectsImported: catalog.migration.legacyProjectsImported,
      pendingConnectionIds: catalog.migration.pendingConnectionIds,
      revision: catalog.revision,
    };
  };

  return { run, getStatus };
};
