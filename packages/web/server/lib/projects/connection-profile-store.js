import { createConnectionId } from './project-identity.js';

/**
 * Connection Profile Store.
 *
 * Private connection records (targets, credential refs) live ONLY server-side
 * and are persisted in their own file — never inside the public catalog file.
 * Public responses are built exclusively through `toConnectionSummary`
 * (catalog-schema.js); private records are never spread into a response.
 *
 * Phase 1 ships the built-in `local` connection. Direct/Relay/SSH targets are
 * structurally supported so later phases can add adapters without changing
 * the store contract; loading a malformed private store is a connection
 * configuration failure and must never delete or empty catalog projects.
 */

const DEFAULT_LOCAL_LABEL = 'This computer';

const validateTarget = (target) => {
  if (!target || typeof target !== 'object') return null;
  if (target.kind === 'local') return { kind: 'local' };
  if (target.kind === 'direct') {
    if (typeof target.baseUrl !== 'string' || !/^https?:\/\//i.test(target.baseUrl)) return null;
    return {
      kind: 'direct',
      baseUrl: target.baseUrl,
      ...(typeof target.credentialRef === 'string' && target.credentialRef.length > 0
        ? { credentialRef: target.credentialRef }
        : {}),
      ...(typeof target.clientToken === 'string' && target.clientToken.length > 0
        ? { clientToken: target.clientToken }
        : {}),
      ...(Array.isArray(target.allowRedirectHosts)
        ? { allowRedirectHosts: target.allowRedirectHosts.filter((host) => typeof host === 'string' && host.length > 0) }
        : {}),
    };
  }
  if (target.kind === 'relay') {
    if (typeof target.relayId !== 'string' || typeof target.credentialRef !== 'string') return null;
    return { kind: 'relay', relayId: target.relayId, credentialRef: target.credentialRef };
  }
  if (target.kind === 'ssh') {
    if (typeof target.sshInstanceId !== 'string' || target.sshInstanceId.length === 0) return null;
    return { kind: 'ssh', sshInstanceId: target.sshInstanceId };
  }
  return null;
};

const validatePrivateRecord = (value, seenIds) => {
  if (!value || typeof value !== 'object') return null;
  const id = typeof value.id === 'string' ? value.id : '';
  const label = typeof value.label === 'string' ? value.label.trim() : '';
  if (!id || !label || seenIds.has(id)) return null;
  const target = validateTarget(value.target);
  if (!target) return null;
  seenIds.add(id);
  return {
    id,
    label,
    target,
    ...(typeof value.accentColor === 'string' && value.accentColor.length > 0
      ? { accentColor: value.accentColor }
      : {}),
    // Epoch ms of the last successful connection probe. Written only by the
    // server after a live probe succeeds; never accepted from clients.
    ...(Number.isFinite(value.lastProbeOkAt) && value.lastProbeOkAt > 0
      ? { lastProbeOkAt: value.lastProbeOkAt }
      : {}),
  };
};

const ensureLocalConnection = (records) => {
  const existing = records.find((record) => record.target?.kind === 'local');
  if (existing) return records;
  return [
    {
      id: 'local',
      label: DEFAULT_LOCAL_LABEL,
      target: { kind: 'local' },
    },
    ...records,
  ];
};

export const createConnectionProfileStore = (dependencies) => {
  const {
    fs,
    filePath,
  } = dependencies;

  let records = null;
  let recoveryState = null; // { recovered: true, reason: string } | null

  const load = async () => {
    let raw;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        records = ensureLocalConnection([]);
        return records;
      }
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Corrupt private store = configuration failure. Never fabricate an
      // empty profile set that could silently orphan catalog projects; the
      // local connection is rebuilt but the failure is surfaced to callers.
      records = ensureLocalConnection([]);
      recoveryState = { recovered: true, reason: 'connection profiles file is corrupt' };
      const error = new Error('connection profile store is corrupt');
      error.code = 'connection_profiles_corrupt';
      error.recovered = true;
      throw error;
    }
    const input = parsed && typeof parsed === 'object' && Array.isArray(parsed.connections)
      ? parsed.connections
      : [];
    const seenIds = new Set();
    const validated = [];
    let dropped = 0;
    for (const entry of input) {
      const record = validatePrivateRecord(entry, seenIds);
      if (record) validated.push(record);
      else dropped += 1;
    }
    records = ensureLocalConnection(validated);
    if (dropped > 0) {
      // Dropping invalid records silently would orphan catalog projects
      // that reference them; surface the shrink as an explicit recovery
      // state and a loud config failure instead.
      recoveryState = {
        recovered: true,
        reason: `connection profiles contained ${dropped} invalid record(s); loaded the valid subset`,
      };
      const error = new Error(`connection profile store contains ${dropped} invalid record(s)`);
      error.code = 'connection_profiles_corrupt';
      error.recovered = true;
      error.dropped = dropped;
      throw error;
    }
    return records;
  };

  const readRecords = async () => {
    if (!records) await load();
    return records;
  };

  const persist = async (nextRecords) => {
    const json = JSON.stringify({ schemaVersion: 1, connections: nextRecords }, null, 2);
    const temporaryPath = `${filePath}.tmp`;
    const handle = await fs.open(temporaryPath, 'w');
    try {
      await handle.writeFile(json, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporaryPath, filePath);
    records = nextRecords;
  };

  // All mutations share one serialized queue: read-modify-persist sequences
  // must not interleave (boot-time probes for N connections all record
  // success concurrently), and the shared `.tmp` path must never see two
  // writers. Each queued mutation reads the records fresh when it runs.
  let mutationQueue = Promise.resolve();
  const enqueueMutation = (mutation) => {
    const run = mutationQueue.then(mutation, mutation);
    mutationQueue = run.catch(() => {});
    return run;
  };

  const getPrivateRecord = async (connectionId) => {
    const current = await readRecords();
    return current.find((record) => record.id === connectionId) ?? null;
  };

  const listPrivateRecords = async () => {
    const current = await readRecords();
    return current.map((record) => ({
      ...record,
      target: { ...record.target },
    }));
  };

  const upsertConnection = (record) => enqueueMutation(async () => {
    const current = await readRecords();
    const candidate = { ...record };
    if (candidate.id !== 'local' && (typeof candidate.id !== 'string' || candidate.id.length === 0)) {
      candidate.id = createConnectionId();
    }
    const validated = validatePrivateRecord(candidate, new Set());
    if (!validated) {
      const error = new Error('invalid connection profile record');
      error.code = 'connection_profiles_invalid';
      error.status = 400;
      throw error;
    }
    const index = current.findIndex((entry) => entry.id === validated.id);
    const nextRecords = [...current];
    if (index === -1) nextRecords.push(validated);
    else nextRecords[index] = validated;
    await persist(nextRecords);
    return { ...validated };
  });

  const deleteConnection = (connectionId) => enqueueMutation(async () => {
    const current = await readRecords();
    if (connectionId === 'local' || !current.some((entry) => entry.id === connectionId)) {
      const error = new Error('connection not found');
      error.status = 404;
      error.code = 'connection_not_found';
      throw error;
    }
    await persist(current.filter((entry) => entry.id !== connectionId));
  });

  /** Records a successful live probe for an existing connection without
   * touching its other fields. Returns false (no write) when the connection
   * is unknown. The timestamp is epoch ms. */
  const recordProbeSuccess = (connectionId, lastProbeOkAt) => enqueueMutation(async () => {
    const current = await readRecords();
    const index = current.findIndex((entry) => entry.id === connectionId);
    if (index === -1 || current[index].lastProbeOkAt === lastProbeOkAt) return false;
    const nextRecords = [...current];
    nextRecords[index] = { ...current[index], lastProbeOkAt };
    await persist(nextRecords);
    return true;
  });

  const getDiagnostics = async () => ({
    connectionCount: (await readRecords()).length,
    recoveryState,
  });

  return {
    load,
    getPrivateRecord,
    listPrivateRecords,
    upsertConnection,
    deleteConnection,
    recordProbeSuccess,
    getDiagnostics,
  };
};
