/**
 * Session Binding Store (Phase 4 server module).
 *
 * Owns the (connectionId, upstreamSessionId) -> workspaceId binding map: the
 * server-side source of truth for which workspace a given upstream session
 * belongs to, per connection. Same physical connection's session ids are
 * unique, so the composite key is unambiguous.
 *
 * Security contract: bindings reference workspace and connection ids only.
 * No credentials, tokens or upstream session payloads are ever persisted
 * here, and no upstream data is ever touched by any mutation.
 *
 * Persistence invariants:
 * - Every mutation runs through one serialized queue: read current document,
 *   build next document, write temp file, fsync + atomic rename.
 * - The previous parseable document is kept as a backup; a corrupt primary
 *   file enters an explicit recovery state (never silently becomes empty).
 * - A malformed/unknown-schema file is a FAILURE, never an empty store.
 * - Unlike the catalog store there is NO If-Match semantics: bindings are
 *   high-churn and low-criticality, so the queue is the only serializer.
 *   Callers MUST re-read (`getSnapshot`/`listBindings`) after their awaited
 *   mutation before building on top of it — never reuse a pre-mutation view.
 */

const BINDING_SCHEMA_VERSION = 1;

const BINDING_SOURCES = new Set(['created-in-workspace', 'explicit', 'legacy-exact-path']);

/** Composite in-memory map key: (connectionId, upstreamSessionId). The NUL
 * separator keeps the key unambiguous when either part contains slashes or
 * unicode. */
const bindingKey = (connectionId, upstreamSessionId) => `${connectionId}\0${upstreamSessionId}`;

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;

const isFiniteNonNegativeNumber = (value) => Number.isFinite(value) && value >= 0;

const stripTrailingSlashes = (value) => value.replace(/\/+$/, '');

/** Validates and normalizes one binding record; duplicate composite keys and
 * unknown sources are dropped. */
const validateBinding = (value, seenKeys) => {
  if (!value || typeof value !== 'object') return null;
  const connectionId = isNonEmptyString(value.connectionId) ? value.connectionId : '';
  const upstreamSessionId = isNonEmptyString(value.upstreamSessionId) ? value.upstreamSessionId : '';
  const workspaceId = isNonEmptyString(value.workspaceId) ? value.workspaceId : '';
  if (!connectionId || !upstreamSessionId || !workspaceId) return null;
  if (!BINDING_SOURCES.has(value.source)) return null;
  const key = bindingKey(connectionId, upstreamSessionId);
  if (seenKeys.has(key)) return null;
  seenKeys.add(key);
  return {
    workspaceId,
    connectionId,
    upstreamSessionId,
    observedDirectory: isNonEmptyString(value.observedDirectory) ? value.observedDirectory : null,
    source: value.source,
    updatedAt: isFiniteNonNegativeNumber(value.updatedAt) ? value.updatedAt : 0,
  };
};

/** Validates a full binding document read from disk. Returns a normalized
 * copy or null when the document is unusable (missing core fields, wrong
 * schema version). Corrupt documents must never be treated as an empty store. */
const validateBindingsDocument = (value) => {
  if (!value || typeof value !== 'object') return null;
  if (value.schemaVersion !== BINDING_SCHEMA_VERSION) return null;
  if (!Number.isInteger(value.revision) || value.revision < 0) return null;
  if (!Array.isArray(value.bindings)) return null;
  const seenKeys = new Set();
  const bindings = [];
  for (const entry of value.bindings) {
    const normalized = validateBinding(entry, seenKeys);
    if (normalized) bindings.push(normalized);
  }
  return {
    schemaVersion: BINDING_SCHEMA_VERSION,
    revision: value.revision,
    bindings,
  };
};

/** Typed error for re-binding a session that already points at a different
 * workspace without an explicit move. */
export const bindingConflict = () => {
  const error = new Error('session binding already points at a different workspace; retry with an explicit move');
  error.code = 'binding_conflict';
  error.status = 409;
  return error;
};

const createInputError = (message) => {
  const error = new Error(message);
  error.code = 'session_binding_invalid_input';
  error.status = 400;
  return error;
};

/** Creates the session binding store. `backupFilePath` defaults to
 * `filePath` with a `.bak` suffix. */
export const createSessionBindingStore = (dependencies) => {
  const {
    fs,
    filePath,
    backupFilePath = filePath.replace(/(\.json)?$/, '.json.bak'),
  } = dependencies;

  let snapshot = null;
  let mutationChain = Promise.resolve();
  let recoveryState = null; // { recovered: true, reason: string } | null

  const emptyDocument = (revision = 0) => ({
    schemaVersion: BINDING_SCHEMA_VERSION,
    revision,
    bindings: [],
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
    const validated = validateBindingsDocument(parsed);
    return validated ? { document: validated } : { corrupt: true };
  };

  /** Loads the binding store from disk; a corrupt primary falls back to the
   * backup and reports recovery. Missing files initialize an empty store. */
  const loadFromDisk = async () => {
    const primary = await loadFromFile(filePath);
    if (primary === null) {
      snapshot = emptyDocument(0);
      return snapshot;
    }
    if (primary.corrupt || primary.document === undefined) {
      if (backupFilePath) {
        const backup = await loadFromFile(backupFilePath);
        if (backup && backup.document) {
          snapshot = backup.document;
          recoveryState = { recovered: true, reason: 'binding store file corrupt; recovered from backup' };
          return snapshot;
        }
      }
      recoveryState = { recovered: true, reason: 'binding store file corrupt; no parseable backup' };
      // Do NOT fabricate an empty document over a corrupt one: the store
      // stays unloaded and mutations remain blocked until the file is
      // replaced or recovered.
      throw new Error('session binding store file is corrupt and no parseable backup exists');
    }
    snapshot = primary.document;
    return snapshot;
  };

  const readStored = async () => {
    if (!snapshot) await loadFromDisk();
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
    snapshot = nextDocument;
    recoveryState = null;
  };

  /** Serializes a mutation: at most one read-modify-write runs at a time. */
  const enqueueMutation = (mutation) => {
    const run = mutationChain.then(async () => {
      const current = await readStored();
      return mutation(current);
    });
    mutationChain = run.then(() => {}, () => {});
    return run;
  };

  const mutate = async (mutator) => {
    const result = await enqueueMutation(async (current) => {
      const outcome = mutator(current);
      const { next, changed } = outcome;
      if (!changed) return { ...outcome, revision: current.revision, changed: false };
      const nextDocument = { ...next, revision: current.revision + 1 };
      await persist(nextDocument);
      return { ...outcome, revision: nextDocument.revision, changed: true };
    });
    return result;
  };

  /** Loads the store (idempotent) and returns the current document. */
  const load = async () => {
    const current = await readStored();
    return current;
  };

  /** Returns a copy of every binding, optionally filtered by connection. */
  const listBindings = async (connectionId) => {
    const current = await readStored();
    return current.bindings
      .filter((entry) => connectionId === undefined || entry.connectionId === connectionId)
      .map((entry) => ({ ...entry }));
  };

  /** Returns a copy of the binding for one upstream session, or null. */
  const getBinding = async (connectionId, upstreamSessionId) => {
    const current = await readStored();
    const key = bindingKey(connectionId, upstreamSessionId);
    const entry = current.bindings.find((candidate) => (
      bindingKey(candidate.connectionId, candidate.upstreamSessionId) === key
    ));
    return entry ? { ...entry } : null;
  };

  /**
   * Upserts the binding for one upstream session.
   *
   * Re-binding the same (connectionId, upstreamSessionId) to the SAME
   * workspace is an idempotent no-op (no revision bump). Re-binding to a
   * DIFFERENT workspace updates the binding in place and requires
   * `source === 'explicit'` or `allowMove: true`; otherwise a typed
   * `binding_conflict` error is thrown and nothing changes.
   *
   * Returns `{ binding, created, moved, changed, revision }`.
   */
  const bindSession = async ({ connectionId, upstreamSessionId, workspaceId, observedDirectory = null, source, allowMove = false }) => {
    if (!isNonEmptyString(connectionId) || !isNonEmptyString(upstreamSessionId) || !isNonEmptyString(workspaceId)) {
      throw createInputError('connectionId, upstreamSessionId and workspaceId are required');
    }
    if (!BINDING_SOURCES.has(source)) {
      throw createInputError(`source must be one of: ${[...BINDING_SOURCES].join(', ')}`);
    }
    const result = await mutate((current) => {
      const key = bindingKey(connectionId, upstreamSessionId);
      const index = current.bindings.findIndex((entry) => (
        bindingKey(entry.connectionId, entry.upstreamSessionId) === key
      ));
      const observed = isNonEmptyString(observedDirectory) ? observedDirectory : null;
      if (index === -1) {
        const record = {
          workspaceId,
          connectionId,
          upstreamSessionId,
          observedDirectory: observed,
          source,
          updatedAt: Date.now(),
        };
        return {
          next: { ...current, bindings: [...current.bindings, record] },
          changed: true,
          binding: { ...record },
          created: true,
          moved: false,
        };
      }
      const existing = current.bindings[index];
      if (existing.workspaceId === workspaceId) {
        return { next: current, changed: false, binding: { ...existing }, created: false, moved: false };
      }
      if (source !== 'explicit' && allowMove !== true) throw bindingConflict();
      const record = {
        ...existing,
        workspaceId,
        observedDirectory: observed,
        source,
        updatedAt: Date.now(),
      };
      const bindings = [...current.bindings];
      bindings[index] = record;
      return { next: { ...current, bindings }, changed: true, binding: { ...record }, created: false, moved: true };
    });
    return {
      binding: result.binding,
      created: result.created,
      moved: result.moved,
      changed: result.changed,
      revision: result.revision,
    };
  };

  /** Convenience wrapper for binding a session that was created inside a
   * workspace; forces `source: 'created-in-workspace'`. */
  const createBindingForNewSession = async ({ connectionId, upstreamSessionId, workspaceId, observedDirectory = null }) => {
    return bindSession({
      connectionId,
      upstreamSessionId,
      workspaceId,
      observedDirectory,
      source: 'created-in-workspace',
    });
  };

  /** Removes only the binding for one upstream session. Returns
   * `{ removed, revision }`; `removed` is false when no binding existed. */
  const removeBinding = async (connectionId, upstreamSessionId) => {
    const result = await mutate((current) => {
      const key = bindingKey(connectionId, upstreamSessionId);
      const index = current.bindings.findIndex((entry) => (
        bindingKey(entry.connectionId, entry.upstreamSessionId) === key
      ));
      if (index === -1) return { next: current, changed: false, removed: false };
      return {
        next: { ...current, bindings: current.bindings.filter((entry, entryIndex) => entryIndex !== index) },
        changed: true,
        removed: true,
      };
    });
    return { removed: result.removed, revision: result.revision };
  };

  /** Removes every binding pointing at a workspace (used when a workspace is
   * deleted). Never touches upstream data. Returns `{ removed, revision }`
   * with `removed` being the count of bindings deleted. */
  const removeBindingsForWorkspace = async (workspaceId) => {
    const result = await mutate((current) => {
      const remaining = current.bindings.filter((entry) => entry.workspaceId !== workspaceId);
      const removed = current.bindings.length - remaining.length;
      if (removed === 0) return { next: current, changed: false, removed: 0 };
      return { next: { ...current, bindings: remaining }, changed: true, removed };
    });
    return { removed: result.removed, revision: result.revision };
  };

  /**
   * Binds legacy sessions to a workspace by exact path: every session whose
   * `directory` (trailing slashes stripped) EXACTLY equals `canonicalPath` is
   * upserted with `source: 'legacy-exact-path'`. Sessions with a missing id,
   * a non-string directory, a non-matching path, or an existing binding to a
   * DIFFERENT workspace are skipped (a legacy import never moves a binding
   * silently). Re-importing an already-bound session is an idempotent no-op.
   *
   * Returns `{ bound, skipped, revision }`; `bound` counts the sessions that
   * match and are bound to this workspace after the call.
   */
  const importLegacyExactPath = async ({ connectionId, workspaceId, canonicalPath, sessions }) => {
    if (!isNonEmptyString(connectionId) || !isNonEmptyString(workspaceId) || !isNonEmptyString(canonicalPath)) {
      throw createInputError('connectionId, workspaceId and canonicalPath are required');
    }
    if (!Array.isArray(sessions)) throw createInputError('sessions must be an array');
    const result = await mutate((current) => {
      const bindings = [...current.bindings];
      let bound = 0;
      let skipped = 0;
      let changed = false;
      for (const session of sessions) {
        const upstreamSessionId = session && typeof session === 'object' ? session.id : null;
        const directory = session && typeof session === 'object' ? session.directory : null;
        if (!isNonEmptyString(upstreamSessionId) || !isNonEmptyString(directory)) {
          skipped += 1;
          continue;
        }
        if (stripTrailingSlashes(directory) !== canonicalPath) {
          skipped += 1;
          continue;
        }
        const key = bindingKey(connectionId, upstreamSessionId);
        const index = bindings.findIndex((entry) => (
          bindingKey(entry.connectionId, entry.upstreamSessionId) === key
        ));
        if (index === -1) {
          bindings.push({
            workspaceId,
            connectionId,
            upstreamSessionId,
            observedDirectory: directory,
            source: 'legacy-exact-path',
            updatedAt: Date.now(),
          });
          bound += 1;
          changed = true;
        } else if (bindings[index].workspaceId === workspaceId) {
          bound += 1;
        } else {
          skipped += 1;
        }
      }
      if (!changed) return { next: current, changed: false, bound, skipped };
      return { next: { ...current, bindings }, changed: true, bound, skipped };
    });
    return { bound: result.bound, skipped: result.skipped, revision: result.revision };
  };

  /** Returns `{ revision, bindings }` with deep copies of every binding. */
  const getSnapshot = async () => {
    const current = await readStored();
    return {
      revision: current.revision,
      bindings: current.bindings.map((entry) => ({ ...entry })),
    };
  };

  /** Returns `{ revision, bindingCount }` (nulls until the store is loaded). */
  const getDiagnostics = async () => ({
    revision: snapshot?.revision ?? null,
    bindingCount: snapshot?.bindings?.length ?? null,
  });

  return {
    load,
    listBindings,
    getBinding,
    bindSession,
    createBindingForNewSession,
    removeBinding,
    removeBindingsForWorkspace,
    importLegacyExactPath,
    getSnapshot,
    getDiagnostics,
    get filePath() { return filePath; },
    get backupFilePath() { return backupFilePath; },
    get recoveryState() { return recoveryState; },
  };
};
