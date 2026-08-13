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
 *   project" flow can pick any folder on the current computer. Project-
 *   scoped browses carry `context.canonicalPath`; the candidate is then
 *   verified against the project boundary (lexically AND through symlink
 *   resolution) before anything is listed.
 * - `fetch` treats the project's canonical path as the authoritative
 *   working directory: client-supplied directory hints (headers and `directory`
 *   query/body fields) are validated against the project boundary and the
 *   `x-opencode-directory` header is ALWAYS overwritten with the canonical
 *   path, so no request can widen the directory to e.g. `/etc`.
 * - `openWebSocket` resolves the upstream ws(s):// URL for the same
 *   project-prefixed paths and applies the identical auth injection and
 *   directory-boundary rules as `fetch`; the ws client itself is created by
 *   the project runtime proxy.
 */

import {
  isPathWithinRoot,
  resolvePathWithinProject,
  readRequestDirectoryHints,
  readRequestProjectPathHints,
  scopeProjectDirectoryListRequest,
} from './path-boundary.js';

export const LOCAL_CONNECTION_ID = 'local';

// The managed local OpenCode runtime serves prefix-free routes: the renderer
// proxy strips the leading `/api` the same way (proxy.js), and routes like
// `/global/event` exist only in the prefix-free form — the `/api` variant
// falls through to the embedded WebUI catch-all and breaks the event stream.
// Remote control-plane adapters (relay/direct/SSH) keep the `/api` convention
// and must NOT use this helper.
export const toUpstreamOpenCodePath = (restPath) => {
  const path = restPath.startsWith('/api') ? restPath.slice(4) || '/' : restPath;
  return path.startsWith('/') ? path : `/${path}`;
};

export const localConnectionCapabilities = {
  pathBrowse: true,
  terminal: true,
  files: true,
  git: true,
  eventStream: true,
};

export const createLocalProjectAdapter = (dependencies) => {
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

  /** Verifies a candidate path stays inside the project root: lexically AND
   * after symlink resolution (a symlink inside the project pointing outside
   * must not widen the boundary). The root is resolved through symlinks too,
   * so a project whose own path is a symlink is still enforced against its
   * real location. */
  const assertDirectoryWithin = async (rootPath, candidatePath) => {
    const resolvedCandidatePath = resolvePathWithinProject(rootPath, candidatePath);
    if (!resolvedCandidatePath) {
      throw outsideProjectError();
    }
    const resolvedRoot = await fs.realpath(rootPath).catch(() => rootPath);
    // The project root may itself live behind a symlink (macOS: /var ->
    // /private/var). A candidate that does not exist on disk has no realpath;
    // anchor it under the REAL root and resolve again so the comparison never
    // mixes a resolved root with an unresolved candidate.
    const anchoredCandidate = path.join(resolvedRoot, path.relative(rootPath, resolvedCandidatePath));
    const resolvedCandidate = await fs.realpath(anchoredCandidate).catch(() => anchoredCandidate);
    if (!isPathWithinRoot(resolvedRoot, resolvedCandidate)) {
      throw outsideProjectError();
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
      ? resolvePathWithinProject(context.canonicalPath, directoryPath)
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
   * Forwards a project-scoped request to the control plane's local OpenCode
   * runtime. `restPath` is the original SDK path (`/api/session` etc.); the
   * project's canonical path is injected as the working directory when the
   * request did not carry one, so file/Git/terminal requests stay inside the
   * project boundary. Upstream auth headers are added server-side and are
   * never returned to the browser.
   */
  const fetch = async (context, request, restPath) => {
    if (!buildOpenCodeUrl || !getOpenCodeAuthHeaders || !fetchImpl) {
      const error = new Error('local adapter HTTP forwarding is not wired');
      error.code = 'capability_unavailable';
      error.status = 501;
      throw error;
    }
    const scopedRestPath = scopeProjectDirectoryListRequest(context?.canonicalPath, restPath);
    if (context?.canonicalPath) {
      const listUrl = new URL(scopedRestPath, 'http://project.local');
      if (listUrl.pathname === '/api/fs/list') {
        await assertDirectoryWithin(context.canonicalPath, listUrl.searchParams.get('path') ?? context.canonicalPath);
      }
      const hasValidatedOutsideFileGrant = (
        (listUrl.pathname === '/api/fs/read' || listUrl.pathname === '/api/fs/stat' || listUrl.pathname === '/api/fs/raw')
        && listUrl.searchParams.get('allowOutsideProject') === 'true'
        && Boolean(listUrl.searchParams.get('outsideFileGrant'))
      );
      if (!hasValidatedOutsideFileGrant) {
        for (const hint of readRequestProjectPathHints(scopedRestPath, request)) {
          await assertDirectoryWithin(context.canonicalPath, hint);
        }
      }
    }
    const upstreamUrl = buildOpenCodeUrl(toUpstreamOpenCodePath(scopedRestPath), '');
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
      // Headers.forEach calls back with (value, key), unlike Object.entries.
      sourceHeaders.forEach((value, name) => copySourceHeader(name, value));
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
      // The project canonical path is the authoritative working directory.
      // Client-supplied directory hints (headers, query, body) must stay
      // inside the project; the header is then overwritten unconditionally
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
   * Resolves the upstream WebSocket spec for a project-scoped upgrade
   * (`/api/event/ws`, `/api/global/event/ws`, `/api/terminal/ws`). The
   * browser never dials the control plane's OpenCode runtime directly: the
   * caller (project runtime proxy) creates the upstream ws client from
   * `{ url, headers }` and pipes it back. Upstream auth headers are injected
   * server-side and never echoed to the browser; the project canonical path
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
      const error = new Error('Path is not a forwardable project socket');
      error.code = 'catalog_runtime_path_not_allowed';
      error.status = 404;
      throw error;
    }
    const upstreamUrl = buildOpenCodeUrl(toUpstreamOpenCodePath(pathname), '').replace(/^http/i, 'ws');
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
      // The project canonical path is the authoritative working directory;
      // client-supplied directory hints (headers, query) must stay inside the
      // project and the header is then overwritten unconditionally.
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

const outsideProjectError = () => {
  const error = new Error('directory is outside the project');
  error.code = 'catalog_path_outside_project';
  error.status = 403;
  return error;
};
