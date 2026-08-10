import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSessionBindingStore, bindingConflict } from './session-binding-store.js';

const fsPromises = fs.promises;

let tempDir;
let filePath;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-binding-store-test-'));
  filePath = path.join(tempDir, 'workspace-session-bindings.json');
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const createStore = (dir = tempDir) => createSessionBindingStore({
  fs: fsPromises,
  filePath: path.join(dir, 'workspace-session-bindings.json'),
});

const bindInput = (overrides = {}) => ({
  connectionId: 'conn-1',
  upstreamSessionId: 'session-1',
  workspaceId: 'ws-1',
  observedDirectory: '/tmp/project',
  source: 'explicit',
  ...overrides,
});

describe('bindingConflict', () => {
  it('is a typed conflict carrying the 409 code', () => {
    const error = bindingConflict();
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('binding_conflict');
    expect(error.status).toBe(409);
  });
});

describe('createSessionBindingStore', () => {
  it('initializes an empty store with revision 0 when the file is missing', async () => {
    const store = createStore();
    const document = await store.load();
    expect(document).toEqual({ schemaVersion: 1, revision: 0, bindings: [] });
    expect(await store.getSnapshot()).toEqual({ revision: 0, bindings: [] });
    expect(await store.getDiagnostics()).toEqual({ revision: 0, bindingCount: 0 });
  });

  it('creates a binding and bumps the revision', async () => {
    const store = createStore();
    const outcome = await store.bindSession(bindInput());

    expect(outcome.created).toBe(true);
    expect(outcome.moved).toBe(false);
    expect(outcome.changed).toBe(true);
    expect(outcome.revision).toBe(1);
    expect(outcome.binding).toEqual({
      workspaceId: 'ws-1',
      connectionId: 'conn-1',
      upstreamSessionId: 'session-1',
      observedDirectory: '/tmp/project',
      source: 'explicit',
      updatedAt: expect.any(Number),
    });
    expect(outcome.binding.updatedAt).toBeGreaterThan(0);
  });

  it('re-binding the same key to the same workspace is an idempotent no-op', async () => {
    const store = createStore();
    const first = await store.bindSession(bindInput());
    const second = await store.bindSession(bindInput({ observedDirectory: '/tmp/changed' }));

    expect(second.created).toBe(false);
    expect(second.changed).toBe(false);
    expect(second.revision).toBe(1);
    expect(second.binding).toEqual(first.binding);
    const snapshot = await store.getSnapshot();
    expect(snapshot.revision).toBe(1);
    expect(snapshot.bindings).toHaveLength(1);
  });

  it('rejects re-binding to a different workspace without an explicit move', async () => {
    const store = createStore();
    await store.bindSession(bindInput({ source: 'created-in-workspace' }));

    let error = null;
    try {
      await store.bindSession(bindInput({ source: 'created-in-workspace', workspaceId: 'ws-other' }));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('binding_conflict');
    expect(error.status).toBe(409);

    const binding = await store.getBinding('conn-1', 'session-1');
    expect(binding.workspaceId).toBe('ws-1');
    expect((await store.getSnapshot()).revision).toBe(1);
  });

  it('updates in place when re-binding to a different workspace with allowMove', async () => {
    const store = createStore();
    await store.bindSession(bindInput({ source: 'created-in-workspace' }));

    const moved = await store.bindSession(bindInput({ workspaceId: 'ws-2', source: 'created-in-workspace', allowMove: true }));
    expect(moved.moved).toBe(true);
    expect(moved.created).toBe(false);
    expect(moved.binding.workspaceId).toBe('ws-2');
    expect(moved.binding.source).toBe('created-in-workspace');
    expect(moved.revision).toBe(2);

    const snapshot = await store.getSnapshot();
    expect(snapshot.bindings).toHaveLength(1);
    expect(snapshot.bindings[0].workspaceId).toBe('ws-2');
  });

  it('allows an explicit re-bind to a different workspace without allowMove', async () => {
    const store = createStore();
    await store.bindSession(bindInput({ source: 'created-in-workspace' }));

    const moved = await store.bindSession(bindInput({ workspaceId: 'ws-2', source: 'explicit' }));
    expect(moved.moved).toBe(true);
    expect(moved.binding.workspaceId).toBe('ws-2');
    expect((await store.getSnapshot()).bindings).toHaveLength(1);
  });

  it('rejects invalid input with a typed error and persists nothing', async () => {
    const store = createStore();
    let error = null;
    try {
      await store.bindSession(bindInput({ source: 'made-up' }));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('session_binding_invalid_input');
    expect(error.status).toBe(400);
    await expect(store.bindSession(bindInput({ workspaceId: '' }))).rejects.toMatchObject({
      code: 'session_binding_invalid_input',
      status: 400,
    });
    expect((await store.getSnapshot()).revision).toBe(0);
  });

  it('createBindingForNewSession forces source created-in-workspace and never moves silently', async () => {
    const store = createStore();
    const outcome = await store.createBindingForNewSession({
      connectionId: 'conn-1',
      upstreamSessionId: 'session-new',
      workspaceId: 'ws-1',
      observedDirectory: '/tmp/project',
    });
    expect(outcome.binding.source).toBe('created-in-workspace');

    await store.bindSession(bindInput({ upstreamSessionId: 'session-existing' }));
    await expect(store.createBindingForNewSession({
      connectionId: 'conn-1',
      upstreamSessionId: 'session-existing',
      workspaceId: 'ws-other',
      observedDirectory: null,
    })).rejects.toMatchObject({ code: 'binding_conflict' });
  });

  it('lists bindings optionally filtered by connection, returning copies', async () => {
    const store = createStore();
    await store.bindSession(bindInput());
    await store.bindSession(bindInput({ upstreamSessionId: 'session-2' }));
    await store.bindSession(bindInput({ connectionId: 'conn-2', upstreamSessionId: 'session-3' }));

    const all = await store.listBindings();
    expect(all).toHaveLength(3);
    const connOne = await store.listBindings('conn-1');
    expect(connOne.map((entry) => entry.upstreamSessionId)).toEqual(['session-1', 'session-2']);
    expect(await store.listBindings('ghost')).toEqual([]);

    connOne[0].workspaceId = 'mutated';
    expect((await store.getBinding('conn-1', 'session-1')).workspaceId).toBe('ws-1');
  });

  it('getBinding returns the binding for the exact composite key or null', async () => {
    const store = createStore();
    await store.bindSession(bindInput());
    await store.bindSession(bindInput({ connectionId: 'conn-2', upstreamSessionId: 'session-1' }));

    expect((await store.getBinding('conn-1', 'session-1')).workspaceId).toBe('ws-1');
    expect((await store.getBinding('conn-2', 'session-1')).workspaceId).toBe('ws-1');
    expect(await store.getBinding('conn-1', 'ghost')).toBeNull();
    expect(await store.getBinding('ghost', 'session-1')).toBeNull();
  });

  it('treats session ids containing slashes and NUL as distinct keys', async () => {
    const store = createStore();
    await store.bindSession(bindInput({ upstreamSessionId: 'a', workspaceId: 'ws-a' }));
    await store.bindSession(bindInput({ upstreamSessionId: 'a\0b', workspaceId: 'ws-ab' }));
    await store.bindSession(bindInput({ upstreamSessionId: 'a/b', workspaceId: 'ws-slash' }));

    expect((await store.getBinding('conn-1', 'a')).workspaceId).toBe('ws-a');
    expect((await store.getBinding('conn-1', 'a\0b')).workspaceId).toBe('ws-ab');
    expect((await store.getBinding('conn-1', 'a/b')).workspaceId).toBe('ws-slash');
    expect((await store.getSnapshot()).bindings).toHaveLength(3);
  });

  it('removeBinding removes only the target binding', async () => {
    const store = createStore();
    await store.bindSession(bindInput());
    await store.bindSession(bindInput({ upstreamSessionId: 'session-2' }));
    await store.bindSession(bindInput({ connectionId: 'conn-2', upstreamSessionId: 'session-3' }));

    const removed = await store.removeBinding('conn-1', 'session-1');
    expect(removed).toEqual({ removed: true, revision: 4 });

    const bindings = await store.listBindings();
    expect(bindings.map((entry) => entry.upstreamSessionId)).toEqual(['session-2', 'session-3']);
    expect(await store.getBinding('conn-1', 'session-1')).toBeNull();
    expect((await store.getBinding('conn-1', 'session-2')).workspaceId).toBe('ws-1');
    expect((await store.getBinding('conn-2', 'session-3')).workspaceId).toBe('ws-1');

    const again = await store.removeBinding('conn-1', 'session-1');
    expect(again).toEqual({ removed: false, revision: 4 });
  });

  it('removeBindingsForWorkspace removes all bindings for the workspace and leaves others intact', async () => {
    const store = createStore();
    await store.bindSession(bindInput({ upstreamSessionId: 's1', workspaceId: 'ws-a' }));
    await store.bindSession(bindInput({ upstreamSessionId: 's2', workspaceId: 'ws-a' }));
    await store.bindSession(bindInput({ upstreamSessionId: 's3', workspaceId: 'ws-b' }));
    await store.bindSession(bindInput({ connectionId: 'conn-2', upstreamSessionId: 's1', workspaceId: 'ws-a' }));

    const outcome = await store.removeBindingsForWorkspace('ws-a');
    expect(outcome.removed).toBe(3);
    expect(outcome.revision).toBe(5);

    const bindings = await store.listBindings();
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({ connectionId: 'conn-1', upstreamSessionId: 's3', workspaceId: 'ws-b' });

    const again = await store.removeBindingsForWorkspace('ws-a');
    expect(again).toEqual({ removed: 0, revision: 5 });
  });

  it('importLegacyExactPath binds only exact directory matches', async () => {
    const store = createStore();
    const outcome = await store.importLegacyExactPath({
      connectionId: 'conn-1',
      workspaceId: 'ws-1',
      canonicalPath: '/a/b',
      sessions: [
        { id: 's1', directory: '/a/b' },
        { id: 's2', directory: '/a/b/' },
        { id: 's3', directory: '/a/b/c' },
        { id: 's4', directory: null },
        { id: 's5', directory: '/a/b' },
      ],
    });

    expect(outcome).toEqual({ bound: 3, skipped: 2, revision: 1 });
    const bindings = await store.listBindings();
    expect(bindings).toHaveLength(3);
    for (const binding of bindings) {
      expect(binding.source).toBe('legacy-exact-path');
      expect(binding.workspaceId).toBe('ws-1');
      expect(binding.connectionId).toBe('conn-1');
    }
    expect(bindings.map((entry) => entry.upstreamSessionId)).toEqual(['s1', 's2', 's5']);
  });

  it('importLegacyExactPath is idempotent and skips sessions bound to another workspace', async () => {
    const store = createStore();
    const first = await store.importLegacyExactPath({
      connectionId: 'conn-1',
      workspaceId: 'ws-1',
      canonicalPath: '/a/b',
      sessions: [
        { id: 's1', directory: '/a/b' },
        { id: 's2', directory: '/a/b' },
      ],
    });
    expect(first.bound).toBe(2);

    const second = await store.importLegacyExactPath({
      connectionId: 'conn-1',
      workspaceId: 'ws-1',
      canonicalPath: '/a/b',
      sessions: [{ id: 's1', directory: '/a/b' }],
    });
    expect(second).toEqual({ bound: 1, skipped: 0, revision: 1 });

    await store.bindSession(bindInput({ upstreamSessionId: 's2', workspaceId: 'ws-other' }));
    const third = await store.importLegacyExactPath({
      connectionId: 'conn-1',
      workspaceId: 'ws-1',
      canonicalPath: '/a/b',
      sessions: [{ id: 's2', directory: '/a/b' }],
    });
    expect(third).toEqual({ bound: 0, skipped: 1, revision: 2 });
    expect((await store.getBinding('conn-1', 's2')).workspaceId).toBe('ws-other');
  });

  it('persists bindings and revision across a fresh store instance', async () => {
    const first = createStore();
    await first.bindSession(bindInput());
    await first.bindSession(bindInput({ upstreamSessionId: 'session-2' }));

    const second = createStore();
    const snapshot = await second.getSnapshot();
    expect(snapshot.revision).toBe(2);
    expect(snapshot.bindings.map((entry) => entry.upstreamSessionId)).toEqual(['session-1', 'session-2']);
    expect((await second.getBinding('conn-1', 'session-2')).workspaceId).toBe('ws-1');
    expect(await second.getDiagnostics()).toEqual({ revision: 2, bindingCount: 2 });
  });

  it('serializes concurrent mutations through one queue', async () => {
    const store = createStore();
    const calls = [];
    for (let index = 0; index < 10; index += 1) {
      calls.push(store.bindSession(bindInput({ upstreamSessionId: `session-${index}` })));
    }
    const outcomes = await Promise.all(calls);

    expect(outcomes.map((outcome) => outcome.created)).toEqual(Array(10).fill(true));
    const snapshot = await store.getSnapshot();
    expect(snapshot.revision).toBe(10);
    expect(snapshot.bindings).toHaveLength(10);
    expect(await store.getDiagnostics()).toEqual({ revision: 10, bindingCount: 10 });
  });

  it('recovers from the backup when the primary file is corrupt', async () => {
    const store = createStore();
    const created = await store.bindSession(bindInput());

    fs.writeFileSync(filePath, '{garbage');

    const recovered = createStore();
    const document = await recovered.load();
    expect(document.bindings).toHaveLength(1);
    expect(document.bindings[0].upstreamSessionId).toBe(created.binding.upstreamSessionId);
    expect(document.revision).toBe(1);
    expect(recovered.recoveryState).toEqual({ recovered: true, reason: 'binding store file corrupt; recovered from backup' });

    const snapshot = await recovered.getSnapshot();
    expect(snapshot.revision).toBe(1);
    expect(snapshot.bindings).toHaveLength(1);
    expect((await recovered.getBinding('conn-1', 'session-1')).workspaceId).toBe('ws-1');
  });

  it('rejects a corrupt primary with no backup instead of silently emptying', async () => {
    fs.writeFileSync(filePath, 'not json at all');

    const store = createStore();
    let error = null;
    try {
      await store.load();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('session binding store file is corrupt and no parseable backup exists');

    expect(store.recoveryState).toEqual({ recovered: true, reason: 'binding store file corrupt; no parseable backup' });
    expect(await store.getDiagnostics()).toEqual({ revision: null, bindingCount: null });
    await expect(store.bindSession(bindInput())).rejects.toThrow('session binding store file is corrupt and no parseable backup exists');
  });

  it('also rejects a structurally invalid (wrong schema) primary with no backup', async () => {
    fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 99, revision: 0, bindings: [] }));

    const store = createStore();
    await expect(store.load()).rejects.toThrow('session binding store file is corrupt and no parseable backup exists');
  });

  it('drops invalid records from a readable file instead of failing the store', async () => {
    fs.writeFileSync(filePath, JSON.stringify({
      schemaVersion: 1,
      revision: 2,
      bindings: [
        { workspaceId: 'ws-1', connectionId: 'conn-1', upstreamSessionId: 's1', observedDirectory: '/a', source: 'explicit', updatedAt: 1 },
        { workspaceId: '', connectionId: 'conn-1', upstreamSessionId: 'bad', observedDirectory: null, source: 'explicit', updatedAt: 1 },
        { workspaceId: 'ws-1', connectionId: 'conn-1', upstreamSessionId: 's2', observedDirectory: null, source: 'made-up', updatedAt: 1 },
        { workspaceId: 'ws-1', connectionId: 'conn-1', upstreamSessionId: 's1', observedDirectory: '/dup', source: 'explicit', updatedAt: 1 },
      ],
    }));

    const store = createStore();
    const snapshot = await store.getSnapshot();
    expect(snapshot.revision).toBe(2);
    expect(snapshot.bindings).toEqual([{
      workspaceId: 'ws-1',
      connectionId: 'conn-1',
      upstreamSessionId: 's1',
      observedDirectory: '/a',
      source: 'explicit',
      updatedAt: 1,
    }]);
  });

  it('getSnapshot returns copies', async () => {
    const store = createStore();
    await store.bindSession(bindInput());

    const snapshot = await store.getSnapshot();
    snapshot.bindings[0].workspaceId = 'mutated';
    snapshot.bindings.push({ workspaceId: 'fake' });
    snapshot.revision = 99;

    const fresh = await store.getSnapshot();
    expect(fresh.revision).toBe(1);
    expect(fresh.bindings).toHaveLength(1);
    expect(fresh.bindings[0].workspaceId).toBe('ws-1');
  });

  it('exposes the primary and backup file paths', async () => {
    const store = createStore();
    expect(store.filePath).toBe(path.join(tempDir, 'workspace-session-bindings.json'));
    expect(store.backupFilePath).toBe(path.join(tempDir, 'workspace-session-bindings.json.bak'));
  });
});
