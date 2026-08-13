import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createConnectionProfileStore } from './connection-profile-store.js';
import { isValidProjectId } from './project-identity.js';

const fsPromises = fs.promises;

let tempDir;
let filePath;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-store-test-'));
  filePath = path.join(tempDir, 'connection-profiles.json');
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const createStore = () => createConnectionProfileStore({ fs: fsPromises, filePath });

const localRecord = { id: 'local', label: 'This computer', target: { kind: 'local' } };

describe('createConnectionProfileStore', () => {
  it('loads the built-in local connection when the file is missing', async () => {
    const store = createStore();
    const records = await store.load();
    expect(records).toEqual([localRecord]);
  });

  it('lists private records including the built-in local connection', async () => {
    const store = createStore();
    const records = await store.listPrivateRecords();
    expect(records).toEqual([localRecord]);
  });

  it('generates an id when upserting a new connection without one', async () => {
    const store = createStore();
    const record = await store.upsertConnection({
      label: 'SSH Host',
      target: { kind: 'ssh', sshInstanceId: 'i-123' },
    });

    expect(isValidProjectId(record.id)).toBe(true);
    expect(record.label).toBe('SSH Host');
    expect(record.target).toEqual({ kind: 'ssh', sshInstanceId: 'i-123' });

    const records = await store.listPrivateRecords();
    expect(records).toHaveLength(2);
    expect(records.find((entry) => entry.id === record.id).target).toEqual({ kind: 'ssh', sshInstanceId: 'i-123' });
  });

  it('upserts by id, replacing an existing record', async () => {
    const store = createStore();
    const first = await store.upsertConnection({
      id: 'conn-1',
      label: 'Before',
      target: { kind: 'direct', baseUrl: 'https://a.example.com' },
    });
    const second = await store.upsertConnection({
      id: 'conn-1',
      label: 'After',
      target: { kind: 'direct', baseUrl: 'https://b.example.com' },
    });

    expect(second.id).toBe(first.id);
    expect(second.label).toBe('After');
    const records = await store.listPrivateRecords();
    expect(records).toHaveLength(2);
    expect(records.find((entry) => entry.id === 'conn-1').label).toBe('After');
  });

  it('returns private records in full from listPrivateRecords', async () => {
    const store = createStore();
    await store.upsertConnection({
      id: 'direct-1',
      label: 'Direct',
      accentColor: '#ABC',
      target: { kind: 'direct', baseUrl: 'https://example.com', credentialRef: 'secret-token' },
    });

    const records = await store.listPrivateRecords();
    const direct = records.find((entry) => entry.id === 'direct-1');
    expect(direct.target).toEqual({ kind: 'direct', baseUrl: 'https://example.com', credentialRef: 'secret-token' });
    expect(direct.accentColor).toBe('#ABC');

    const privateRecord = await store.getPrivateRecord('direct-1');
    expect(privateRecord.target.credentialRef).toBe('secret-token');
    expect(await store.getPrivateRecord('ghost')).toBeNull();
  });

  it('throws a typed error on a corrupt file after rebuilding local', async () => {
    fs.writeFileSync(filePath, '{broken');

    const store = createStore();
    let error = null;
    try {
      await store.load();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('connection_profiles_corrupt');
    expect(error.recovered).toBe(true);

    const records = await store.listPrivateRecords();
    expect(records).toEqual([localRecord]);
  });

  it('surfaces invalid records as an explicit recovery failure instead of silently shrinking', async () => {
    fs.writeFileSync(filePath, JSON.stringify({
      schemaVersion: 1,
      connections: [
        { id: 'ok-1', label: 'OK', target: { kind: 'ssh', sshInstanceId: 'i-1' } },
        { id: '', label: 'No id' },
        { id: 'bad-1', label: 'Bad target', target: { kind: 'weird' } },
        { id: 'ok-1', label: 'Duplicate id', target: { kind: 'local' } },
      ],
    }));

    const store = createStore();
    let error = null;
    try {
      await store.load();
    } catch (caught) {
      error = caught;
    }
    // The shrink is a configuration failure, never a silent clean load: the
    // valid subset is kept (so surviving connections keep working) but the
    // caller must see the recovery signal.
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('connection_profiles_corrupt');
    expect(error.recovered).toBe(true);
    expect(error.dropped).toBe(3);

    const records = await store.listPrivateRecords();
    expect(records.map((entry) => entry.id)).toEqual(['local', 'ok-1']);
    const diagnostics = await store.getDiagnostics();
    expect(diagnostics.recoveryState).toEqual({
      recovered: true,
      reason: 'connection profiles contained 3 invalid record(s); loaded the valid subset',
    });
  });

  it('persists upserts across a restart', async () => {
    const first = createStore();
    await first.upsertConnection({ id: 'conn-1', label: 'Remote', target: { kind: 'ssh', sshInstanceId: 'i-9' } });

    const second = createStore();
    const records = await second.listPrivateRecords();
    expect(records.map((entry) => entry.id).sort()).toEqual(['conn-1', 'local']);
    expect(records.find((entry) => entry.id === 'conn-1').target).toEqual({ kind: 'ssh', sshInstanceId: 'i-9' });
  });

  it('rejects invalid upsert records with a typed error', async () => {
    const store = createStore();
    let error = null;
    try {
      await store.upsertConnection({ label: 'No target' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('connection_profiles_invalid');
    expect(error.status).toBe(400);
    expect(await store.listPrivateRecords()).toEqual([localRecord]);
  });

  it('refuses to delete the built-in local connection', async () => {
    const store = createStore();
    let error = null;
    try {
      await store.deleteConnection('local');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('connection_not_found');
    expect(error.status).toBe(404);
    expect(await store.listPrivateRecords()).toEqual([localRecord]);
  });

  it('404s deleting an unknown connection', async () => {
    const store = createStore();
    await expect(store.deleteConnection('ghost')).rejects.toMatchObject({ code: 'connection_not_found', status: 404 });
  });

  it('deletes an upserted connection', async () => {
    const store = createStore();
    await store.upsertConnection({ id: 'conn-1', label: 'Remote', target: { kind: 'ssh', sshInstanceId: 'i-9' } });

    await store.deleteConnection('conn-1');
    const records = await store.listPrivateRecords();
    expect(records.map((entry) => entry.id)).toEqual(['local']);
    expect(await store.getPrivateRecord('conn-1')).toBeNull();
  });

  it('reports diagnostics', async () => {
    const store = createStore();
    expect(await store.getDiagnostics()).toEqual({ connectionCount: 1, recoveryState: null });
    await store.upsertConnection({ id: 'conn-1', label: 'Remote', target: { kind: 'ssh', sshInstanceId: 'i-9' } });
    expect(await store.getDiagnostics()).toEqual({ connectionCount: 2, recoveryState: null });
  });

  it('persists a valid lastProbeOkAt and drops invalid values', async () => {
    const store = createStore();
    const record = await store.upsertConnection({
      id: 'direct-1',
      label: 'Direct',
      lastProbeOkAt: 1700000000000,
      target: { kind: 'direct', baseUrl: 'https://example.com' },
    });
    expect(record.lastProbeOkAt).toBe(1700000000000);

    // A full upsert whose candidate carries an invalid timestamp drops the
    // field (invalid values never survive validation).
    for (const invalid of ['not-a-number', 0, -5]) {
      await store.upsertConnection({
        id: 'direct-1',
        label: 'Direct',
        lastProbeOkAt: invalid,
        target: { kind: 'direct', baseUrl: 'https://example.com' },
      });
      expect((await store.getPrivateRecord('direct-1')).lastProbeOkAt).toBeUndefined();
    }

    await store.upsertConnection({
      id: 'direct-1',
      label: 'Direct',
      lastProbeOkAt: 1700000000000,
      target: { kind: 'direct', baseUrl: 'https://example.com' },
    });
    const restarted = createStore();
    const loaded = await restarted.listPrivateRecords();
    expect(loaded.find((entry) => entry.id === 'direct-1').lastProbeOkAt).toBe(1700000000000);
  });

  it('recordProbeSuccess updates only the timestamp, preserving other fields', async () => {
    const store = createStore();
    await store.upsertConnection({
      id: 'direct-1',
      label: 'Before',
      target: { kind: 'direct', baseUrl: 'https://example.com', credentialRef: 'secret-token' },
    });

    expect(await store.recordProbeSuccess('direct-1', 1700000000000)).toBe(true);
    const record = await store.getPrivateRecord('direct-1');
    expect(record.lastProbeOkAt).toBe(1700000000000);
    expect(record.label).toBe('Before');
    expect(record.target).toEqual({ kind: 'direct', baseUrl: 'https://example.com', credentialRef: 'secret-token' });

    expect(await store.recordProbeSuccess('direct-1', 1700000000000)).toBe(false);
    expect(await store.recordProbeSuccess('ghost', 1700000000000)).toBe(false);
  });
});
