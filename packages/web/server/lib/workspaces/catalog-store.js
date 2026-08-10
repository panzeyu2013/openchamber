import { createWorkspaceId, workspaceLocationKey } from './workspace-identity.js';
import { validateCatalogDocument, toWorkspaceDescriptor } from './catalog-schema.js';

/**
 * Workspace Catalog store.
 *
 * Authority: the catalog is the single source of truth for workspaces and
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
 * - Mutation conflicts return a typed error with code `catalog_revision_conflict`
 *   so callers can re-fetch and replay the user action.
 */

const BACKUP_FILE_NAME = 'workspace-catalog.json.bak';

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
    backupFilePath = filePath.replace(/(\.json)?$/, '.json.bak'),
  } = dependencies;

  let snapshot = null;
  let backupSnapshot = null;
  let mutationChain = Promise.resolve();
  let lastPersistSucceededAt = null;
  let recoveryState = null; // { recovered: true, reason: string } | null

  const emptyDocument = (revision = 0) => ({
    schemaVersion: 1,
    revision,
    connections: [],
    workspaces: [],
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
    const validated = validateCatalogDocument(parsed);
    return validated ? { document: validated } : { corrupt: true };
  };

  /** Loads the catalog once; a corrupt primary falls back to the backup and
   * reports recovery. Missing files initialize an empty catalog. */
  const load = async () => {
    const primary = await loadFromFile(filePath);
    if (primary === null) {
      snapshot = emptyDocument(0);
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
      workspaces: current.workspaces.map((workspace) => toWorkspaceDescriptor(workspace)),
      migration: { ...current.migration, pendingConnectionIds: [...current.migration.pendingConnectionIds] },
    };
  };

  const getWorkspace = async (workspaceId) => {
    const current = await readStored();
    const workspace = current.workspaces.find((entry) => entry.id === workspaceId);
    return workspace ? toWorkspaceDescriptor(workspace) : null;
  };

  const findWorkspaceByLocation = async (connectionId, canonicalPath) => {
    const current = await readStored();
    const location = workspaceLocationKey(connectionId, canonicalPath);
    const workspace = current.workspaces.find((entry) => workspaceLocationKey(entry.connectionId, entry.canonicalPath) === location);
    return workspace ? toWorkspaceDescriptor(workspace) : null;
  };

  const listWorkspacesForConnection = async (connectionId) => {
    const current = await readStored();
    return current.workspaces
      .filter((entry) => entry.connectionId === connectionId)
      .map((entry) => toWorkspaceDescriptor(entry));
  };

  /**
   * Creates a workspace. `canonicalPath` must already be adapter-normalized.
   * Returns the new descriptor or the existing one when the location already
   * exists (idempotent retry contract: a lost response never duplicates).
   */
  const createWorkspace = async ({ connectionId, canonicalPath, path, label, color, orderKey }, ifMatchRevision) => {
    const result = await mutate(ifMatchRevision, (current) => {
      const location = workspaceLocationKey(connectionId, canonicalPath);
      const existing = current.workspaces.find((entry) => (
        workspaceLocationKey(entry.connectionId, entry.canonicalPath) === location
      ));
      if (existing) {
        return { next: current, changed: false, existing: toWorkspaceDescriptor(existing) };
      }
      const now = Date.now();
      const record = {
        id: createWorkspaceId(),
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
        next: { ...current, workspaces: [...current.workspaces, record] },
        changed: true,
        created: toWorkspaceDescriptor(record),
      };
    });
    if (result.existing) return { descriptor: result.existing, created: false, revision: result.revision };
    return { descriptor: result.created, created: true, revision: result.revision };
  };

  const updateWorkspace = async (workspaceId, patch, ifMatchRevision) => {
    const result = await mutate(ifMatchRevision, (current) => {
      const index = current.workspaces.findIndex((entry) => entry.id === workspaceId);
      if (index === -1) {
        const error = new Error('workspace not found');
        error.status = 404;
        error.code = 'catalog_workspace_not_found';
        throw error;
      }
      const existing = current.workspaces[index];
      const record = {
        ...existing,
        ...patch,
        updatedAt: Date.now(),
      };
      const workspaces = [...current.workspaces];
      workspaces[index] = record;
      return { next: { ...current, workspaces }, changed: true, updated: toWorkspaceDescriptor(record) };
    });
    return { descriptor: result.updated, revision: result.revision };
  };

  /** Deletes only the catalog reference; never touches upstream data. */
  const deleteWorkspace = async (workspaceId, ifMatchRevision) => {
    const result = await mutate(ifMatchRevision, (current) => {
      const index = current.workspaces.findIndex((entry) => entry.id === workspaceId);
      if (index === -1) {
        const error = new Error('workspace not found');
        error.status = 404;
        error.code = 'catalog_workspace_not_found';
        throw error;
      }
      const workspaces = current.workspaces.filter((entry) => entry.id !== workspaceId);
      return { next: { ...current, workspaces }, changed: true };
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
    schemaVersion: snapshot?.schemaVersion ?? 1,
    revision: snapshot?.revision ?? null,
    loaded: snapshot !== null,
    lastPersistSucceededAt,
    recoveryState,
    workspaceCount: snapshot?.workspaces?.length ?? null,
    connectionCount: snapshot?.connections?.length ?? null,
  });

  return {
    load,
    getSnapshot,
    getWorkspace,
    findWorkspaceByLocation,
    listWorkspacesForConnection,
    createWorkspace,
    updateWorkspace,
    deleteWorkspace,
    setConnections,
    setMigrationState,
    getDiagnostics,
    get filePath() { return filePath; },
    get backupFilePath() { return backupFilePath; },
  };
};
