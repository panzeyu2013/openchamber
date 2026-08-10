import { createConnectionId } from './workspace-identity.js';

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
 * configuration failure and must never delete or empty catalog workspaces.
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
      // empty profile set that could silently orphan catalog workspaces; the
      // local connection is rebuilt but the failure is surfaced to callers.
      records = ensureLocalConnection([]);
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
    for (const entry of input) {
      const record = validatePrivateRecord(entry, seenIds);
      if (record) validated.push(record);
    }
    records = ensureLocalConnection(validated);
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

  const upsertConnection = async (record) => {
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
  };

  const deleteConnection = async (connectionId) => {
    const current = await readRecords();
    if (connectionId === 'local' || !current.some((entry) => entry.id === connectionId)) {
      const error = new Error('connection not found');
      error.status = 404;
      error.code = 'connection_not_found';
      throw error;
    }
    await persist(current.filter((entry) => entry.id !== connectionId));
  };

  const getDiagnostics = async () => ({
    connectionCount: (await readRecords()).length,
  });

  return {
    load,
    getPrivateRecord,
    listPrivateRecords,
    upsertConnection,
    deleteConnection,
    getDiagnostics,
  };
};
