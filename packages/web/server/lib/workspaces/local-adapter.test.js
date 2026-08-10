import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLocalWorkspaceAdapter, LOCAL_CONNECTION_ID, localConnectionCapabilities } from './local-adapter.js';

const fsPromises = fs.promises;

let tempDir;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-adapter-test-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const createAdapter = (overrides = {}) => createLocalWorkspaceAdapter({
  fs: fsPromises,
  path,
  ...overrides,
});

const expectTypedError = async (promise, code, status) => {
  let error = null;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect(error.code).toBe(code);
  expect(error.status).toBe(status);
};

describe('createLocalWorkspaceAdapter', () => {
  it('exposes the local connection contract with all capabilities', () => {
    const adapter = createAdapter();
    expect(adapter.kind).toBe('local');
    expect(adapter.connectionId).toBe(LOCAL_CONNECTION_ID);
    expect(LOCAL_CONNECTION_ID).toBe('local');
    expect(adapter.capabilities).toEqual(localConnectionCapabilities);
    expect(localConnectionCapabilities).toEqual({
      pathBrowse: true,
      terminal: true,
      files: true,
      git: true,
      eventStream: true,
    });
  });

  describe('canonicalizePath', () => {
    it('resolves an absolute directory path', async () => {
      const adapter = createAdapter();
      const canonicalPath = await adapter.canonicalizePath({}, tempDir);
      expect(canonicalPath).toBe(path.resolve(tempDir));
    });

    it('resolves a relative path against the cwd', async () => {
      const adapter = createAdapter();
      const relative = path.relative(process.cwd(), tempDir);
      const canonicalPath = await adapter.canonicalizePath({}, relative);
      expect(canonicalPath).toBe(path.resolve(relative));
      expect(canonicalPath).toBe(tempDir);
    });

    it('trims surrounding whitespace', async () => {
      const adapter = createAdapter();
      const canonicalPath = await adapter.canonicalizePath({}, `  ${tempDir}  `);
      expect(canonicalPath).toBe(tempDir);
    });

    it('applies the normalizeDirectoryPath hook to the trimmed input', async () => {
      const normalizeDirectoryPath = vi.fn((input) => input);
      const adapter = createAdapter({ normalizeDirectoryPath });
      await adapter.canonicalizePath({}, `  ${tempDir}  `);
      expect(normalizeDirectoryPath).toHaveBeenCalledWith(tempDir);
    });

    it('rejects empty input', async () => {
      const adapter = createAdapter();
      await expectTypedError(adapter.canonicalizePath({}, ''), 'catalog_invalid_path', 400);
      await expectTypedError(adapter.canonicalizePath({}, '   '), 'catalog_invalid_path', 400);
      await expectTypedError(adapter.canonicalizePath({}, undefined), 'catalog_invalid_path', 400);
      await expectTypedError(adapter.canonicalizePath({}, null), 'catalog_invalid_path', 400);
    });

    it('rejects a missing path', async () => {
      const adapter = createAdapter();
      await expectTypedError(
        adapter.canonicalizePath({}, path.join(tempDir, 'does-not-exist')),
        'catalog_path_not_found',
        404,
      );
    });

    it('rejects a non-directory file', async () => {
      const filePath = path.join(tempDir, 'file.txt');
      fs.writeFileSync(filePath, 'content');
      const adapter = createAdapter();
      await expectTypedError(adapter.canonicalizePath({}, filePath), 'catalog_path_not_directory', 400);
    });
  });

  describe('probe', () => {
    it('returns an ok shape with canonical path and capabilities', async () => {
      const adapter = createAdapter();
      const probe = await adapter.probe({}, tempDir);
      expect(probe).toEqual({
        ok: true,
        canonicalPath: tempDir,
        capabilities: localConnectionCapabilities,
      });
    });

    it('returns a typed failure shape instead of throwing', async () => {
      const adapter = createAdapter();
      const probe = await adapter.probe({}, path.join(tempDir, 'missing'));
      expect(probe).toEqual({
        ok: false,
        canonicalPath: null,
        error: { code: 'catalog_path_not_found', message: 'path does not exist' },
      });
    });
  });

  describe('listChildren', () => {
    it('sorts directories first, then files, case-insensitively', async () => {
      fs.mkdirSync(path.join(tempDir, 'm-dir'));
      fs.mkdirSync(path.join(tempDir, 'Z-Dir'));
      fs.writeFileSync(path.join(tempDir, 'a-file'), '');
      fs.writeFileSync(path.join(tempDir, 'B-file'), '');

      const adapter = createAdapter();
      const result = await adapter.listChildren({}, tempDir);
      expect(result.directory).toBe(tempDir);
      expect(result.children.map((child) => child.name)).toEqual(['m-dir', 'Z-Dir', 'a-file', 'B-file']);
      expect(result.children.map((child) => child.kind)).toEqual(['directory', 'directory', 'file', 'file']);
    });

    it('resolves symlinks to directories through stat', async () => {
      const target = path.join(tempDir, 'target-dir');
      const link = path.join(tempDir, 'link-dir');
      fs.mkdirSync(target);
      fs.symlinkSync(target, link);

      const adapter = createAdapter();
      const result = await adapter.listChildren({}, tempDir);
      const entry = result.children.find((child) => child.name === 'link-dir');
      expect(entry.kind).toBe('directory');
      expect(entry.path).toBe(link);
    });

    it('rejects a missing directory with a typed error', async () => {
      const adapter = createAdapter();
      await expectTypedError(adapter.listChildren({}, path.join(tempDir, 'missing')), 'catalog_path_not_found', 404);
    });

    it('rejects a non-directory target with a typed error', async () => {
      const filePath = path.join(tempDir, 'file.txt');
      fs.writeFileSync(filePath, 'content');
      const adapter = createAdapter();
      await expectTypedError(adapter.listChildren({}, filePath), 'catalog_path_not_accessible', 500);
    });

    it('rejects empty input', async () => {
      const adapter = createAdapter();
      await expectTypedError(adapter.listChildren({}, ''), 'catalog_invalid_path', 400);
      await expectTypedError(adapter.listChildren({}, undefined), 'catalog_invalid_path', 400);
    });
  });

  it('stubs Phase 2 forwarding with capability_unavailable', async () => {
    const adapter = createAdapter();
    for (const method of [adapter.fetch, adapter.openEventStream, adapter.openWebSocket]) {
      let error = null;
      try {
        await method({});
      } catch (caught) {
        error = caught;
      }
      expect(error.code).toBe('capability_unavailable');
      expect(error.status).toBe(501);
    }
  });
});
