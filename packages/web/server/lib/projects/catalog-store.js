import { createProjectId, projectLocationKey } from './project-identity.js';
import { validateCatalogDocument, toProjectDescriptor, CATALOG_SCHEMA_VERSION } from './catalog-schema.js';

/**
 * Project Catalog store.
 *
 * Authority: the catalog is the single source of truth for projects and
 * public connection metadata. It only ever persists sanitized public data —
 * never credentials, tokens, message content or terminal data.
 *
 * Persistence invariants:
 * - Every mutation runs through one serialized queue: read current revision,
 *   validate If-Match, build next revision, write temp file, fsync + atomic
 *   rename.
 * - The previous parseable document is kept as a backup; a corrupt primary
 *   file enters an explicit recovery state (never silently becomes empty).
 * - A malformed/unknown-schema file is a FAILURE, never an empty catalog.
 * - A legacy v1 document (old `workspaces` key / `workspace-catalog.json`
 *   file name) is migrated to the current schema ON LOAD: the migrated v2
 *   document is written to the new path and the legacy file is left in
 *   place as an explicit backup (never deleted). Migration failure is LOUD
 *   — it throws and must never masquerade as an empty catalog.
 * - Mutation conflicts return a typed error with code `catalog_revision_conflict`
 *   so callers can re-fetch and replay the user action.
 */

const BACKUP_FILE_NAME = 'project-catalog.json.bak';

/** On-disk schema version written before the project rename landed. */
const LEGACY_CATALOG_SCHEMA_VERSION = 1;

/** Legacy file name written before the project rename landed. */
const LEGACY_CATALOG_FILE_NAME = 'workspace-catalog.json';

export const catalogRevisionConflict = () => {
  const error = new Error('catalog revision conflict; re-fetch the snapshot and retry');
  error.code = 'catalog_revision_conflict';
  error.status = 409;
  return error;
};

export const createCatalogStore = (dependencies) => {
  const {
    fs,
    path,
    filePath,
    // Legacy v1 file name (workspace-catalog.json). Migration reads it when
    // the current path is missing and keeps it untouched after migrating.
    legacyFilePath = filePath ? path.join(path.dirname(filePath), LEGACY_CATALOG_FILE_NAME) : null,
    backupFilePath = filePath.replace(/(\.json)?$/, '.json.bak'),
  } = dependencies;

  let snapshot = null;
  let backupSnapshot = null;
  let mutationChain = Promise.resolve();
  let lastPersistSucceededAt = null;
  let recoveryState = null; // { recovered: true, reason: string } | null

  const emptyDocument = (revision = 0) => ({
    schemaVersion: CATALOG_SCHEMA_VERSION,
    revision,
    connections: [],
    projects: [],
    migration: { legacyProjectsImported: false, pendingConnectionIds: [] },
  });

  const loadFromFile = async (candidatePath) => {
    let raw;
    try {
      raw = await fs.readFile(candidatePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { corrupt: true };
    }
    if (parsed && typeof parsed === 'object' && parsed.schemaVersion === LEGACY_CATALOG_SCHEMA_VERSION) {
      // A legacy v1 document (pre-rename `workspaces` key): not corrupt, it
      // is a candidate for in-place migration.
      return { legacy: true, document: parsed };
    }
    const validated = validateCatalogDocument(parsed);
    if (!validated) return { corrupt: true };
    const dropped = validated.dropped;
    return dropped ? { document: validated, dropped } : { document: validated };
  };

  /** Converts a legacy v1 catalog document to the current schema, persists
   * the migrated v2 document to the NEW path (backup included) and returns
   * the loaded snapshot. The legacy file is left untouched as an explicit
   * backup. Migration failure is LOUD: it throws and never fabricates an
   * empty catalog. */
  const migrateDocumentToV2 = async (legacyDocument, sourcePath) => {
    const draft = {
      schemaVersion: CATALOG_SCHEMA_VERSION,
      revision: legacyDocument?.revision,
      connections: legacyDocument?.connections,
      projects: legacyDocument?.workspaces,
      migration: legacyDocument?.migration,
    };
    const migrated = validateCatalogDocument(draft);
    if (!migrated) {
      throw new Error(`catalog migration failed: legacy document at ${sourcePath} is unusable`);
    }
    await persist(migrated);
    snapshot = migrated;
    backupSnapshot = migrated;
    if (migrated.dropped) {
      recoveryState = {
        recovered: true,
        reason: `migrated catalog contained ${migrated.dropped.connections} invalid connection(s) and ${migrated.dropped.projects} invalid project(s); migrated the valid subset`,
      };
    }
    return snapshot;
  };

  /** Loads the catalog once; a corrupt primary falls back to the backup and
   * reports recovery. A primary whose validation dropped invalid/duplicate
   * entries is loaded from its valid subset but enters an EXPLICIT recovery
   * state (never a silent clean load). A legacy v1 document (old file name
   * or old schema at the new path) is migrated to v2; migration failure
   * throws. Missing files initialize an empty catalog. */
  const load = async () => {
    const primary = await loadFromFile(filePath);
    if (primary === null) {
      // The new path is missing. A legacy v1 file (old file name) is
      // migrated to the new path; a missing legacy file is a fresh install.
      if (legacyFilePath && legacyFilePath !== filePath) {
        const legacy = await loadFromFile(legacyFilePath);
        if (legacy !== null) {
          if (legacy.legacy) return migrateDocumentToV2(legacy.document, legacyFilePath);
          if (legacy.corrupt || legacy.document === undefined) {
            throw new Error('legacy catalog file is corrupt and cannot be migrated');
          }
          // A current-schema document at the legacy path is unexpected but
          // usable: treat it as authoritative without rewriting.
          snapshot = legacy.document;
          backupSnapshot = legacy.document;
          if (legacy.dropped) {
            recoveryState = {
              recovered: true,
              reason: `legacy catalog file contained ${legacy.dropped.connections} invalid connection(s) and ${legacy.dropped.projects} invalid project(s); loaded the valid subset`,
            };
          }
          return snapshot;
        }
      }
      snapshot = emptyDocument(0);
      return snapshot;
    }
    if (primary.legacy) {
      // A v1 document written at the new path (e.g. a downgrade-then-upgrade
      // cycle): migrate it in place.
      return migrateDocumentToV2(primary.document, filePath);
    }
    if (primary.document) {
      if (primary.dropped) {
        recoveryState = {
          recovered: true,
          reason: `catalog file contained ${primary.dropped.connections} invalid connection(s) and ${primary.dropped.projects} invalid project(s); loaded the valid subset`,
        };
      }
      snapshot = primary.document;
      backupSnapshot = primary.document;
      return snapshot;
    }
    if (primary.corrupt || primary.document === undefined) {
      const backup = await loadFromFile(backupFilePath);
      if (backup && backup.document) {
        snapshot = backup.document;
        backupSnapshot = backup.document;
        recoveryState = { recovered: true, reason: 'catalog file corrupt; recovered from backup' };
        return snapshot;
      }
      recoveryState = { recovered: true, reason: 'catalog file corrupt; no parseable backup' };
      // Do NOT fabricate an empty document over a corrupt one: the store is
      // in recovery and mutations remain blocked until the operator replaces
      // the file or the migration repopulates it explicitly.
      throw new Error('catalog file is corrupt and no parseable backup exists');
    }
    snapshot = primary.document;
    backupSnapshot = primary.document;
    return snapshot;
  };

  const readStored = async () => {
    if (!snapshot) await load();
    return snapshot;
  };

  const persist = async (nextDocument) => {
    const json = JSON.stringify(nextDocument, null, 2);
    // The backup is written FIRST: if the primary write then fails, the
    // backup holds the newer document and recovery restores it; the in-memory
    // snapshot is only replaced after both files are on disk.
    if (backupFilePath && backupFilePath !== filePath) {
      const backupHandle = await fs.open(backupFilePath, 'w');
      try {
        await backupHandle.writeFile(json, 'utf8');
        await backupHandle.sync();
      } finally {
        await backupHandle.close();
      }
    }
    const temporaryPath = `${filePath}.tmp`;
    const handle = await fs.open(temporaryPath, 'w');
    try {
      await handle.writeFile(json, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporaryPath, filePath);
    backupSnapshot = snapshot;
    snapshot = nextDocument;
    lastPersistSucceededAt = Date.now();
    recoveryState = null;
  };

  /** Serializes a mutation against the authoritative document. */
  const enqueueMutation = (mutation) => {
    const run = mutationChain.then(async () => {
      const current = await readStored();
      return mutation(current);
    });
    mutationChain = run.then(() => {}, () => {});
    return run;
  };

  const mutate = async (ifMatchRevision, mutator) => {
    const result = await enqueueMutation(async (current) => {
      if (ifMatchRevision !== undefined && current.revision !== ifMatchRevision) {
        throw catalogRevisionConflict();
      }
      const outcome = mutator(current);
      const { next, changed } = outcome;
      if (!changed) return { ...outcome, revision: current.revision, changed: false };
      const nextDocument = { ...next, revision: current.revision + 1 };
      await persist(nextDocument);
      return { ...outcome, revision: nextDocument.revision, changed: true };
    });
    return result;
  };

  const getSnapshot = async () => {
    const current = await readStored();
    return {
      schemaVersion: current.schemaVersion,
      revision: current.revision,
      connections: current.connections.map((connection) => ({ ...connection })),
      projects: current.projects.map((project) => toProjectDescriptor(project)),
      migration: { ...current.migration, pendingConnectionIds: [...current.migration.pendingConnectionIds] },
    };
  };

  const getProject = async (projectId) => {
    const current = await readStored();
    const project = current.projects.find((entry) => entry.id === projectId);
    return project ? toProjectDescriptor(project) : null;
  };

  const findProjectByLocation = async (connectionId, canonicalPath) => {
    const current = await readStored();
    const location = projectLocationKey(connectionId, canonicalPath);
    const project = current.projects.find((entry) => projectLocationKey(entry.connectionId, entry.canonicalPath) === location);
    return project ? toProjectDescriptor(project) : null;
  };

  const listProjectsForConnection = async (connectionId) => {
    const current = await readStored();
    return current.projects
      .filter((entry) => entry.connectionId === connectionId)
      .map((entry) => toProjectDescriptor(entry));
  };

  /**
   * Creates a project. `canonicalPath` must already be adapter-normalized.
   * Returns the new descriptor or the existing one when the location already
   * exists (idempotent retry contract: a lost response never duplicates).
   */
  const createProject = async ({ connectionId, canonicalPath, path, label, color, orderKey }, ifMatchRevision) => {
    const result = await mutate(ifMatchRevision, (current) => {
      const location = projectLocationKey(connectionId, canonicalPath);
      const existing = current.projects.find((entry) => (
        projectLocationKey(entry.connectionId, entry.canonicalPath) === location
      ));
      if (existing) {
        return { next: current, changed: false, existing: toProjectDescriptor(existing) };
      }
      const now = Date.now();
      const record = {
        id: createProjectId(),
        connectionId,
        path,
        canonicalPath,
        label,
        color: color ?? null,
        orderKey: orderKey ?? '',
        createdAt: now,
        updatedAt: now,
      };
      return {
        next: { ...current, projects: [...current.projects, record] },
        changed: true,
        created: toProjectDescriptor(record),
      };
    });
    if (result.existing) return { descriptor: result.existing, created: false, revision: result.revision };
    return { descriptor: result.created, created: true, revision: result.revision };
  };

  const updateProject = async (projectId, patch, ifMatchRevision) => {
    const result = await mutate(ifMatchRevision, (current) => {
      const index = current.projects.findIndex((entry) => entry.id === projectId);
      if (index === -1) {
        const error = new Error('project not found');
        error.status = 404;
        error.code = 'catalog_project_not_found';
        throw error;
      }
      const existing = current.projects[index];
      const record = {
        ...existing,
        ...patch,
        updatedAt: Date.now(),
      };
      const projects = [...current.projects];
      projects[index] = record;
      return { next: { ...current, projects }, changed: true, updated: toProjectDescriptor(record) };
    });
    return { descriptor: result.updated, revision: result.revision };
  };

  /** Deletes only the catalog reference; never touches upstream data. */
  const deleteProject = async (projectId, ifMatchRevision) => {
    const result = await mutate(ifMatchRevision, (current) => {
      const index = current.projects.findIndex((entry) => entry.id === projectId);
      if (index === -1) {
        const error = new Error('project not found');
        error.status = 404;
        error.code = 'catalog_project_not_found';
        throw error;
      }
      const projects = current.projects.filter((entry) => entry.id !== projectId);
      return { next: { ...current, projects }, changed: true };
    });
    return { revision: result.revision };
  };

  const setConnections = async (connections, ifMatchRevision) => {
    const result = await mutate(ifMatchRevision, (current) => {
      if (connections === current.connections) return { next: current, changed: false };
      return { next: { ...current, connections }, changed: true };
    });
    return { revision: result.revision };
  };

  const setMigrationState = async (migration, ifMatchRevision) => {
    const result = await mutate(ifMatchRevision, (current) => {
      return {
        next: { ...current, migration: { ...current.migration, ...migration } },
        changed: true,
      };
    });
    return { revision: result.revision };
  };

  const getDiagnostics = async () => ({
    schemaVersion: snapshot?.schemaVersion ?? CATALOG_SCHEMA_VERSION,
    revision: snapshot?.revision ?? null,
    loaded: snapshot !== null,
    lastPersistSucceededAt,
    recoveryState,
    projectCount: snapshot?.projects?.length ?? null,
    connectionCount: snapshot?.connections?.length ?? null,
  });

  return {
    load,
    getSnapshot,
    getProject,
    findProjectByLocation,
    listProjectsForConnection,
    createProject,
    updateProject,
    deleteProject,
    setConnections,
    setMigrationState,
    getDiagnostics,
    get filePath() { return filePath; },
    get backupFilePath() { return backupFilePath; },
  };
};
