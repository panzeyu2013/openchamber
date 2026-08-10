import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createConnectionProfileStore } from './connection-profile-store.js';
import { isValidWorkspaceId } from './workspace-identity.js';

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

    expect(isValidWorkspaceId(record.id)).toBe(true);
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

  it('drops invalid records from a readable file instead of failing the store', async () => {
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
    const records = await store.listPrivateRecords();
    expect(records.map((entry) => entry.id)).toEqual(['local', 'ok-1']);
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
    expect(await store.getDiagnostics()).toEqual({ connectionCount: 1 });
    await store.upsertConnection({ id: 'conn-1', label: 'Remote', target: { kind: 'ssh', sshInstanceId: 'i-9' } });
    expect(await store.getDiagnostics()).toEqual({ connectionCount: 2 });
  });
});
