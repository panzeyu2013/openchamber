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

    it('rejects parent traversal out of the workspace boundary', async () => {
      const workspaceDir = path.join(tempDir, 'workspace');
      fs.mkdirSync(workspaceDir);
      const adapter = createAdapter();
      await expectTypedError(
        adapter.listChildren({ canonicalPath: workspaceDir }, path.join(workspaceDir, '..', 'secret')),
        'catalog_path_outside_workspace',
        403,
      );
    });

    it('rejects a symlink that escapes the workspace boundary', async () => {
      const outsideDir = path.join(tempDir, 'outside');
      const workspaceDir = path.join(tempDir, 'workspace');
      fs.mkdirSync(outsideDir);
      fs.mkdirSync(workspaceDir);
      fs.symlinkSync(outsideDir, path.join(workspaceDir, 'escape'));
      const adapter = createAdapter();
      await expectTypedError(
        adapter.listChildren({ canonicalPath: workspaceDir }, path.join(workspaceDir, 'escape')),
        'catalog_path_outside_workspace',
        403,
      );
    });

    it('allows listing the workspace root and real descendants', async () => {
      const workspaceDir = path.join(tempDir, 'workspace');
      const subDir = path.join(workspaceDir, 'sub');
      fs.mkdirSync(subDir, { recursive: true });
      const adapter = createAdapter();
      expect((await adapter.listChildren({ canonicalPath: workspaceDir }, workspaceDir)).directory).toBe(workspaceDir);
      expect((await adapter.listChildren({ canonicalPath: workspaceDir }, subDir)).directory).toBe(subDir);
    });
  });

  it('reports capability_unavailable when HTTP/SSE/WS forwarding deps are missing', async () => {
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

  describe('openWebSocket', () => {
    const wsWorkspaceDir = () => {
      const dir = path.join(tempDir, 'ws-workspace');
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    };

    const createWsAdapter = (dependencies = {}) => createLocalWorkspaceAdapter({
      fs: fsPromises,
      path,
      buildOpenCodeUrl: (restPath) => `http://opencode.test${restPath}`,
      getOpenCodeAuthHeaders: async () => ({ 'x-openchamber-runtime-auth': 'secret' }),
      ...dependencies,
    });

    it('resolves a ws spec to the local OpenCode runtime with injected auth', async () => {
      const adapter = createWsAdapter();
      const spec = await adapter.openWebSocket(
        { canonicalPath: wsWorkspaceDir() },
        { path: '/api/terminal/ws', headers: { cookie: 'oc_ui_session=leak' } },
      );
      expect(spec.url).toBe('ws://opencode.test/api/terminal/ws');
      expect(spec.headers['x-openchamber-runtime-auth']).toBe('secret');
      expect(spec.headers.cookie).toBeUndefined();
      expect(spec.headers['x-opencode-directory']).toBe(wsWorkspaceDir());
    });

    it('overwrites the directory header with the canonical path', async () => {
      const adapter = createWsAdapter();
      const spec = await adapter.openWebSocket(
        { canonicalPath: wsWorkspaceDir() },
        { path: '/api/event/ws', headers: { 'x-opencode-directory': path.join(wsWorkspaceDir(), 'sub') } },
      );
      expect(spec.headers['x-opencode-directory']).toBe(wsWorkspaceDir());
    });

    it('rejects directory hints outside the workspace and non-/api paths', async () => {
      const adapter = createWsAdapter();
      await expectTypedError(
        adapter.openWebSocket({ canonicalPath: wsWorkspaceDir() }, { path: '/api/terminal/ws', headers: { 'x-opencode-directory': '/etc' } }),
        'catalog_path_outside_workspace',
        403,
      );
      await expectTypedError(
        adapter.openWebSocket({ canonicalPath: wsWorkspaceDir() }, { path: '/health' }),
        'catalog_runtime_path_not_allowed',
        404,
      );
    });
  });

  describe('fetch directory boundary enforcement', () => {
    const workspaceDir = () => {
      const dir = path.join(tempDir, 'workspace');
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    };

    const createForwardingAdapter = (dependencies = {}) => createLocalWorkspaceAdapter({
      fs: fsPromises,
      path,
      buildOpenCodeUrl: (restPath) => `http://opencode.test${restPath}`,
      getOpenCodeAuthHeaders: async () => ({ 'x-openchamber-runtime-auth': 'secret' }),
      fetchImpl: async (url, init) => ({ url, init, status: 200, ok: true, headers: new Headers(), body: null }),
      ...dependencies,
    });

    const createRequest = (overrides = {}) => ({
      method: 'GET',
      headers: {},
      query: {},
      body: null,
      ...overrides,
    });

    it('injects the workspace directory when the request carries no hint', async () => {
      const adapter = createForwardingAdapter();
      const forwarded = await adapter.fetch(
        { canonicalPath: workspaceDir() },
        createRequest(),
        '/api/session',
      );
      expect(forwarded.init.headers.get('x-opencode-directory')).toBe(workspaceDir());
      expect(forwarded.init.headers.get('x-openchamber-runtime-auth')).toBe('secret');
    });

    it('copies plain request headers while filtering browser credentials', async () => {
      const adapter = createForwardingAdapter();
      const forwarded = await adapter.fetch(
        { canonicalPath: workspaceDir() },
        createRequest({ headers: { accept: 'application/json', cookie: 'browser-secret' } }),
        '/api/session',
      );
      expect(forwarded.init.headers.get('accept')).toBe('application/json');
      expect(forwarded.init.headers.get('cookie')).toBeNull();
    });

    it('overwrites a client-supplied directory header inside the workspace', async () => {
      const adapter = createForwardingAdapter();
      const forwarded = await adapter.fetch(
        { canonicalPath: workspaceDir() },
        createRequest({ headers: { 'x-opencode-directory': path.join(workspaceDir(), 'sub') } }),
        '/api/session',
      );
      expect(forwarded.init.headers.get('x-opencode-directory')).toBe(workspaceDir());
    });

    it('rejects a client-supplied directory header outside the workspace', async () => {
      const adapter = createForwardingAdapter();
      await expectTypedError(
        adapter.fetch(
          { canonicalPath: workspaceDir() },
          createRequest({ headers: { 'x-opencode-directory': '/etc' } }),
          '/api/session',
        ),
        'catalog_path_outside_workspace',
        403,
      );
      await expectTypedError(
        adapter.fetch(
          { canonicalPath: workspaceDir() },
          createRequest({ headers: { 'x-opencode-directory': path.join(workspaceDir(), '..', 'secret') } }),
          '/api/session',
        ),
        'catalog_path_outside_workspace',
        403,
      );
    });

    it('rejects a directory query parameter outside the workspace', async () => {
      const adapter = createForwardingAdapter();
      await expectTypedError(
        adapter.fetch(
          { canonicalPath: workspaceDir() },
          createRequest({ query: { directory: '/etc' } }),
          '/api/session',
        ),
        'catalog_path_outside_workspace',
        403,
      );
    });

    it('scopes filesystem directory listing queries to the workspace', async () => {
      let capturedUrl = '';
      const adapter = createForwardingAdapter({
        buildOpenCodeUrl: (restPath) => {
          capturedUrl = restPath;
          return `http://opencode.test${restPath}`;
        },
      });
      await adapter.fetch(
        { canonicalPath: workspaceDir() },
        createRequest(),
        '/api/fs/list',
      );
      expect(capturedUrl).toBe(`/api/fs/list?path=${encodeURIComponent(workspaceDir())}`);
      await expectTypedError(
        adapter.fetch(
          { canonicalPath: workspaceDir() },
          createRequest(),
          '/api/fs/list?path=%2Fetc',
        ),
        'catalog_path_outside_workspace',
        403,
      );
    });

    it('rejects filesystem and terminal path fields outside the workspace', async () => {
      const adapter = createForwardingAdapter();
      for (const [restPath, body] of [
        ['/api/fs/mkdir', { path: '/etc/new-dir' }],
        ['/api/fs/write', { path: '/etc/file', content: 'x' }],
        ['/api/fs/delete', { path: '/etc/file' }],
        ['/api/fs/rename', { oldPath: path.join(workspaceDir(), 'file'), newPath: '/etc/file' }],
        ['/api/fs/reveal', { path: '/etc' }],
        ['/api/fs/serve/etc/passwd', {}],
        ['/api/fs/clone', { destinationPath: '/etc/clone' }],
        ['/api/fs/exec', { cwd: '/etc' }],
        ['/api/terminal/create', { cwd: '/etc' }],
        ['/api/git/stage', { paths: ['/etc/file'] }],
      ]) {
        await expectTypedError(
          adapter.fetch(
            { canonicalPath: workspaceDir() },
            createRequest({ method: 'POST', body }),
            restPath,
          ),
          'catalog_path_outside_workspace',
          403,
        );
      }
    });

    it('resolves workspace-relative file and Git paths against the workspace root', async () => {
      const adapter = createForwardingAdapter();
      const forwarded = await adapter.fetch(
        { canonicalPath: workspaceDir() },
        createRequest({ method: 'POST', body: { path: 'src/file.ts', content: 'x' } }),
        '/api/fs/write',
      );
      expect(forwarded.init.body).toBe(JSON.stringify({ path: 'src/file.ts', content: 'x' }));
      await expect(adapter.fetch(
        { canonicalPath: workspaceDir() },
        createRequest({ method: 'POST', body: { paths: ['src/a.ts'] } }),
        '/api/git/stage',
      )).resolves.toMatchObject({ status: 200 });
    });

    it('preserves the server-validated outside-file grant exception for local reads', async () => {
      const adapter = createForwardingAdapter();
      const forwarded = await adapter.fetch(
        { canonicalPath: workspaceDir() },
        createRequest(),
        '/api/fs/read?path=%2Ftmp%2Feditor-only.txt&allowOutsideWorkspace=true&outsideFileGrant=grant-1',
      );
      expect(forwarded.url).toContain('allowOutsideWorkspace=true');
      expect(forwarded.url).toContain('outsideFileGrant=grant-1');
    });

    it('rejects a directory body field outside the workspace', async () => {
      const adapter = createForwardingAdapter();
      await expectTypedError(
        adapter.fetch(
          { canonicalPath: workspaceDir() },
          createRequest({ method: 'POST', body: { directory: '/etc', prompt: 'hi' } }),
          '/api/session',
        ),
        'catalog_path_outside_workspace',
        403,
      );
    });

    it('rejects a symlink that escapes through the directory hint', async () => {
      const outsideDir = path.join(tempDir, 'outside');
      fs.mkdirSync(outsideDir);
      const root = workspaceDir();
      fs.symlinkSync(outsideDir, path.join(root, 'escape'));
      const adapter = createForwardingAdapter();
      await expectTypedError(
        adapter.fetch(
          { canonicalPath: root },
          createRequest({ headers: { 'x-opencode-directory': path.join(root, 'escape') } }),
          '/api/session',
        ),
        'catalog_path_outside_workspace',
        403,
      );
    });

    it('does not enforce a boundary when no workspace path is in context', async () => {
      const adapter = createForwardingAdapter();
      const forwarded = await adapter.fetch({}, createRequest(), '/api/session');
      expect(forwarded.init.headers.get('x-opencode-directory')).toBeNull();
    });
  });
});
