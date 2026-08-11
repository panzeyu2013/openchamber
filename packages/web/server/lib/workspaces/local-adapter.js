/**
 * Local connection adapter.
 *
 * The `local` connection targets the control plane machine itself. It reuses
 * the existing managed/external OpenCode runtime of the control plane; the
 * browser never chooses or switches endpoints — the control plane resolves
 * `connectionId: 'local'` to this adapter.
 *
 * Path rules:
 * - `canonicalizePath` normalizes under the CONTROL PLANE's filesystem
 *   semantics (never a remote path) and requires the path to exist and be a
 *   directory.
 * - Browse lists a directory and refuses entries outside the requested
 *   directory. The browse root is the machine root so the unified "add
 *   workspace" flow can pick any folder on the current computer. Workspace-
 *   scoped browses carry `context.canonicalPath`; the candidate is then
 *   verified against the workspace boundary (lexically AND through symlink
 *   resolution) before anything is listed.
 * - `fetch` treats the workspace's canonical path as the authoritative
 *   working directory: client-supplied directory hints (headers and `directory`
 *   query/body fields) are validated against the workspace boundary and the
 *   `x-opencode-directory` header is ALWAYS overwritten with the canonical
 *   path, so no request can widen the directory to e.g. `/etc`.
 * - `openWebSocket` resolves the upstream ws(s):// URL for the same
 *   workspace-prefixed paths and applies the identical auth injection and
 *   directory-boundary rules as `fetch`; the ws client itself is created by
 *   the workspace runtime proxy.
 */

import {
  isPathWithinRoot,
  resolvePathWithinWorkspace,
  readRequestDirectoryHints,
  readRequestWorkspacePathHints,
  scopeWorkspaceDirectoryListRequest,
} from './path-boundary.js';

export const LOCAL_CONNECTION_ID = 'local';

export const localConnectionCapabilities = {
  pathBrowse: true,
  terminal: true,
  files: true,
  git: true,
  eventStream: true,
};

export const createLocalWorkspaceAdapter = (dependencies) => {
  const {
    fs,
    path,
    normalizeDirectoryPath = (input) => input,
    // Upstream resolution for the local OpenCode runtime of the control
    // plane. Injected by the server entrypoint; absent in headless tests.
    buildOpenCodeUrl = null,
    getOpenCodeAuthHeaders = null,
    fetchImpl = null,
  } = dependencies;

  /** Verifies a candidate path stays inside the workspace root: lexically AND
   * after symlink resolution (a symlink inside the workspace pointing outside
   * must not widen the boundary). The root is resolved through symlinks too,
   * so a workspace whose own path is a symlink is still enforced against its
   * real location. */
  const assertDirectoryWithin = async (rootPath, candidatePath) => {
    const resolvedCandidatePath = resolvePathWithinWorkspace(rootPath, candidatePath);
    if (!resolvedCandidatePath) {
      throw outsideWorkspaceError();
    }
    const [resolvedRoot, resolvedCandidate] = await Promise.all([
      fs.realpath(rootPath).catch(() => rootPath),
      fs.realpath(resolvedCandidatePath).catch(() => resolvedCandidatePath),
    ]);
    if (!isPathWithinRoot(resolvedRoot, resolvedCandidate)) {
      throw outsideWorkspaceError();
    }
  };

  const canonicalizePath = async (context, inputPath) => {
    if (typeof inputPath !== 'string' || inputPath.trim().length === 0) {
      const error = new Error('path is required');
      error.code = 'catalog_invalid_path';
      error.status = 400;
      throw error;
    }
    const normalized = normalizeDirectoryPath(inputPath.trim());
    const resolved = path.resolve(normalized);
    let stat;
    try {
      stat = await fs.stat(resolved);
    } catch (statError) {
      if (statError?.code === 'ENOENT') {
        const error = new Error('path does not exist');
        error.code = 'catalog_path_not_found';
        error.status = 404;
        throw error;
      }
      const error = new Error('path is not accessible');
      error.code = 'catalog_path_not_accessible';
      error.status = 500;
      throw error;
    }
    if (!stat.isDirectory()) {
      const error = new Error('path is not a directory');
      error.code = 'catalog_path_not_directory';
      error.status = 400;
      throw error;
    }
    return resolved;
  };

  const probe = async (context, inputPath) => {
    try {
      const canonicalPath = await canonicalizePath(context, inputPath);
      return {
        ok: true,
        canonicalPath,
        capabilities: { ...localConnectionCapabilities },
      };
    } catch (error) {
      return {
        ok: false,
        canonicalPath: null,
        error: {
          code: error?.code ?? 'catalog_probe_failed',
          message: error?.message ?? 'probe failed',
        },
      };
    }
  };

  const listChildren = async (context, directoryPath) => {
    if (typeof directoryPath !== 'string' || directoryPath.length === 0) {
      const error = new Error('directory is required');
      error.code = 'catalog_invalid_path';
      error.status = 400;
      throw error;
    }
    const scopedDirectory = context?.canonicalPath
      ? resolvePathWithinWorkspace(context.canonicalPath, directoryPath)
      : directoryPath;
    if (context?.canonicalPath) {
      await assertDirectoryWithin(context.canonicalPath, directoryPath);
    }
    const resolved = path.resolve(scopedDirectory ?? directoryPath);
    let entries;
    try {
      entries = await fs.readdir(resolved, { withFileTypes: true });
    } catch (error) {
      const wrapped = new Error('directory is not readable');
      wrapped.code = error?.code === 'ENOENT' ? 'catalog_path_not_found' : 'catalog_path_not_accessible';
      wrapped.status = error?.code === 'ENOENT' ? 404 : 500;
      throw wrapped;
    }
    const children = await Promise.all(entries.map(async (entry) => {
      const childPath = path.join(resolved, entry.name);
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (!isDirectory && !isFile) {
        try {
          const stat = await fs.stat(childPath);
          isDirectory = stat.isDirectory();
          isFile = stat.isFile();
        } catch {
          isDirectory = false;
          isFile = false;
        }
      }
      return {
        name: entry.name,
        path: childPath,
        kind: isDirectory ? 'directory' : (isFile ? 'file' : 'other'),
      };
    }));
    return {
      directory: resolved,
      children: children
        .filter((child) => child.name.length > 0 && child.name !== '.' && child.name !== '..')
        .sort((left, right) => {
          const leftDir = left.kind === 'directory' ? 0 : 1;
          const rightDir = right.kind === 'directory' ? 0 : 1;
          if (leftDir !== rightDir) return leftDir - rightDir;
          return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
        }),
    };
  };

  /**
   * Forwards a workspace-scoped request to the control plane's local OpenCode
   * runtime. `restPath` is the original SDK path (`/api/session` etc.); the
   * workspace's canonical path is injected as the working directory when the
   * request did not carry one, so file/Git/terminal requests stay inside the
   * workspace boundary. Upstream auth headers are added server-side and are
   * never returned to the browser.
   */
  const fetch = async (context, request, restPath) => {
    if (!buildOpenCodeUrl || !getOpenCodeAuthHeaders || !fetchImpl) {
      const error = new Error('local adapter HTTP forwarding is not wired');
      error.code = 'capability_unavailable';
      error.status = 501;
      throw error;
    }
    const scopedRestPath = scopeWorkspaceDirectoryListRequest(context?.canonicalPath, restPath);
    if (context?.canonicalPath) {
      const listUrl = new URL(scopedRestPath, 'http://workspace.local');
      if (listUrl.pathname === '/api/fs/list') {
        await assertDirectoryWithin(context.canonicalPath, listUrl.searchParams.get('path') ?? context.canonicalPath);
      }
      const hasValidatedOutsideFileGrant = (
        (listUrl.pathname === '/api/fs/read' || listUrl.pathname === '/api/fs/stat' || listUrl.pathname === '/api/fs/raw')
        && listUrl.searchParams.get('allowOutsideWorkspace') === 'true'
        && Boolean(listUrl.searchParams.get('outsideFileGrant'))
      );
      if (!hasValidatedOutsideFileGrant) {
        for (const hint of readRequestWorkspacePathHints(scopedRestPath, request)) {
          await assertDirectoryWithin(context.canonicalPath, hint);
        }
      }
    }
    const upstreamUrl = buildOpenCodeUrl(scopedRestPath, '');
    const headers = new Headers();
    const sourceHeaders = request?.headers;
    const copySourceHeader = (name, value) => {
      if (value === undefined || value === null) return;
      const normalizedName = String(name).toLowerCase();
      const normalizedValue = Array.isArray(value) ? value.join(', ') : String(value);
      if (BLOCKED_UPSTREAM_HEADERS.has(normalizedName)) return;
      if (/\r|\n/.test(String(name)) || /\r|\n/.test(normalizedValue)) return;
      headers.set(name, normalizedValue);
    };
    if (sourceHeaders && typeof sourceHeaders.forEach === 'function') {
      sourceHeaders.forEach(copySourceHeader);
    } else if (sourceHeaders && typeof sourceHeaders === 'object') {
      for (const [name, value] of Object.entries(sourceHeaders)) copySourceHeader(name, value);
    }
    const openChamberHeaders = await getOpenCodeAuthHeaders();
    if (openChamberHeaders && typeof openChamberHeaders === 'object') {
      for (const [name, value] of Object.entries(openChamberHeaders)) {
        if (value !== undefined && value !== null) headers.set(name, String(value));
      }
    }
    const canonicalPath = context?.canonicalPath;
    if (canonicalPath) {
      // The workspace canonical path is the authoritative working directory.
      // Client-supplied directory hints (headers, query, body) must stay
      // inside the workspace; the header is then overwritten unconditionally
      // so a request can never widen the directory to e.g. `/etc`.
      for (const hint of readRequestDirectoryHints(request)) {
        await assertDirectoryWithin(canonicalPath, hint);
      }
      const bodyDirectory = request?.body && typeof request.body === 'object' && !Buffer.isBuffer(request.body)
        ? request.body.directory
        : undefined;
      if (typeof bodyDirectory === 'string' && bodyDirectory.length > 0) {
        await assertDirectoryWithin(canonicalPath, bodyDirectory);
      }
      headers.set('x-opencode-directory', canonicalPath);
      headers.set('x-openchamber-directory-encoding', 'none');
      headers.delete('x-openchamber-directory');
    }
    // The control plane's JSON body parser consumed the request stream, so
    // `request.body` is the parsed object (or raw string/buffer). Reconstruct
    // the upstream body instead of re-streaming a consumed request.
    let body;
    const method = request?.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD' && request?.body !== undefined && request.body !== null) {
      if (typeof request.body === 'string' || Buffer.isBuffer(request.body)) {
        body = request.body;
      } else if (typeof request.body === 'object') {
        body = JSON.stringify(request.body);
        if (!headers.has('content-type')) headers.set('content-type', 'application/json');
      }
    }
    return fetchImpl(upstreamUrl, {
      method,
      headers,
      body,
      signal: request?.signal,
      duplex: 'half',
    });
  };

  /** Phase 2 SSE is served through `fetch` as a streaming pass-through. */
  const openEventStream = async (context, restPath, signal) => {
    const response = await fetch(context, { headers: new Headers({ accept: 'text/event-stream' }), method: 'GET', signal }, restPath);
    if (!response.ok || !response.body) {
      const error = new Error(`event stream unavailable: ${response.status}`);
      error.code = 'capability_unavailable';
      error.status = 502;
      throw error;
    }
    return response;
  };

  /**
   * Resolves the upstream WebSocket spec for a workspace-scoped upgrade
   * (`/api/event/ws`, `/api/global/event/ws`, `/api/terminal/ws`). The
   * browser never dials the control plane's OpenCode runtime directly: the
   * caller (workspace runtime proxy) creates the upstream ws client from
   * `{ url, headers }` and pipes it back. Upstream auth headers are injected
   * server-side and never echoed to the browser; the workspace canonical path
   * is enforced and the directory header is always overwritten, exactly like
   * `fetch`.
   */
  const openWebSocket = async (context, request = {}) => {
    if (!buildOpenCodeUrl || !getOpenCodeAuthHeaders) {
      const error = new Error('local adapter WebSocket forwarding is not wired');
      error.code = 'capability_unavailable';
      error.status = 501;
      throw error;
    }
    const pathname = getWsPathname(request.path);
    if (!pathname.startsWith('/api/')) {
      const error = new Error('Path is not a forwardable workspace socket');
      error.code = 'catalog_runtime_path_not_allowed';
      error.status = 404;
      throw error;
    }
    const upstreamUrl = buildOpenCodeUrl(pathname, '').replace(/^http/i, 'ws');
    const headers = new Headers();
    const sourceHeaders = request?.headers;
    if (sourceHeaders && typeof sourceHeaders === 'object') {
      for (const [name, value] of Object.entries(sourceHeaders)) {
        if (value === undefined || value === null) continue;
        if (!BLOCKED_UPSTREAM_HEADERS.has(name.toLowerCase())) headers.set(name, String(value));
      }
    }
    const openChamberHeaders = await getOpenCodeAuthHeaders();
    if (openChamberHeaders && typeof openChamberHeaders === 'object') {
      for (const [name, value] of Object.entries(openChamberHeaders)) {
        if (value !== undefined && value !== null) headers.set(name, String(value));
      }
    }
    const canonicalPath = context?.canonicalPath;
    if (canonicalPath) {
      // The workspace canonical path is the authoritative working directory;
      // client-supplied directory hints (headers, query) must stay inside the
      // workspace and the header is then overwritten unconditionally.
      for (const hint of readRequestDirectoryHints(request)) {
        await assertDirectoryWithin(canonicalPath, hint);
      }
      headers.set('x-opencode-directory', canonicalPath);
      headers.set('x-openchamber-directory-encoding', 'none');
      headers.delete('x-openchamber-directory');
    }
    return { url: upstreamUrl, headers: objectifyHeaders(headers) };
  };

  const dispose = async () => {};

  return {
    kind: 'local',
    connectionId: LOCAL_CONNECTION_ID,
    capabilities: { ...localConnectionCapabilities },
    canonicalizePath,
    probe,
    listChildren,
    fetch,
    openEventStream,
    openWebSocket,
    dispose,
  };
};

const BLOCKED_UPSTREAM_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-openchamber-client-token',
  'x-openchamber-runtime-headers',
  'x-openchamber-url-token',
]);

const getWsPathname = (inputPath) => {
  if (typeof inputPath !== 'string' || inputPath.length === 0) return '';
  try {
    return new URL(inputPath, 'http://localhost').pathname;
  } catch {
    return '';
  }
};

const objectifyHeaders = (headers) => {
  const result = {};
  headers.forEach((value, name) => { result[name] = value; });
  return result;
};

const outsideWorkspaceError = () => {
  const error = new Error('directory is outside the workspace');
  error.code = 'catalog_path_outside_workspace';
  error.status = 403;
  return error;
};
