/**
 * Project path boundary helpers.
 *
 * Adapter-agnostic lexical containment check: collapses `.`/`..` segments
 * without touching the filesystem, so client paths like
 * `/safe/root/../secret` cannot bypass the project boundary. Real-path
 * (symlink) resolution is adapter-owned — only the local adapter can resolve
 * symlinks on the control plane machine; remote adapters rely on the lexical
 * check plus their target server's own enforcement.
 *
 * Path semantics stay per-adapter: this module only normalizes and compares
 * paths as opaque strings under POSIX-style rules with `\` treated as a
 * separator (so Windows drive and UNC roots are handled).
 */

/** Collapses `.` and `..` segments lexically. Absolute paths can never escape
 * their root (`/..` is `/`, `C:\..` is `C:\`); relative `..` above the start
 * is preserved. Returns the normalized path with `/` separators. */
export const normalizePathForBoundary = (input) => {
  if (typeof input !== 'string' || input.length === 0) return input;
  const isAbsolute = input.startsWith('/')
    || /^[A-Za-z]:[\\/]/.test(input)
    || input.startsWith('\\\\');
  const segments = [];
  for (const segment of input.split(/[\\/]+/)) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      const last = segments[segments.length - 1];
      if (last !== undefined && last !== '..') {
        segments.pop();
      } else if (!isAbsolute) {
        segments.push('..');
      }
      continue;
    }
    segments.push(segment);
  }
  let normalized = segments.join('/');
  if (isAbsolute) {
    if (input.startsWith('\\\\')) {
      normalized = `//${normalized}`;
    } else if (/^[A-Za-z]:/.test(input)) {
      const drive = input.slice(0, 2);
      normalized = normalized.startsWith(`${drive}/`) || normalized === drive ? normalized : `${drive}/${normalized}`;
    } else {
      normalized = `/${normalized}`;
    }
  }
  return normalized || (isAbsolute ? '/' : '');
};

/** True when `candidate` stays inside `root` after lexical normalization
 * (equal to the root, or a descendant of it). Never resolves symlinks. */
export const isPathWithinRoot = (root, candidate) => {
  if (typeof root !== 'string' || typeof candidate !== 'string') return false;
  const normalizedRoot = normalizePathForBoundary(root);
  const normalizedCandidate = normalizePathForBoundary(candidate);
  if (normalizedRoot === normalizedCandidate) return true;
  if (!normalizedRoot.endsWith('/')) {
    const prefixedRoot = `${normalizedRoot}/`;
    return normalizedCandidate.startsWith(prefixedRoot)
      || normalizedCandidate.startsWith(prefixedRoot.replace(/\//g, '\\'));
  }
  return normalizedCandidate.startsWith(normalizedRoot);
};

const isAbsoluteBoundaryPath = (value) => (
  typeof value === 'string'
  && (value.startsWith('/')
    || /^[A-Za-z]:[\\/]/.test(value)
    || value.startsWith('\\\\'))
);

/** Resolves a path hint against the project root for boundary checks. A
 * relative file/Git path is intentionally interpreted as project-relative;
 * an absolute path must already be inside the root. Returns null when the
 * candidate would escape the project. */
export const resolvePathWithinProject = (root, candidate) => {
  if (typeof root !== 'string' || typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  if (!trimmed) return null;
  if (isPathWithinRoot(root, trimmed)) return normalizePathForBoundary(trimmed);
  if (isAbsoluteBoundaryPath(trimmed)) return null;
  const resolved = normalizePathForBoundary(`${root}/${trimmed}`);
  return isPathWithinRoot(root, resolved) ? resolved : null;
};

/** Project boundary check that accepts the relative paths used by Git and
 * filesystem APIs while still rejecting absolute and `..` escapes. */
export const isPathWithinProject = (root, candidate) => (
  resolvePathWithinProject(root, candidate) !== null
);

/**
 * Scopes the filesystem directory-list endpoint to the project root.
 * `/api/fs/list` is an intentionally simple route that selects its directory
 * from the `path` query parameter, not from the project directory headers.
 * Project adapters therefore validate that query here and fill it from the
 * authoritative project path when omitted.
 */
export const scopeProjectDirectoryListRequest = (canonicalPath, restPath) => {
  if (typeof canonicalPath !== 'string' || canonicalPath.length === 0) return restPath;
  let url;
  try {
    url = new URL(restPath, 'http://project.local');
  } catch {
    return restPath;
  }
  if (url.pathname !== '/api/fs/list') return restPath;

  const pathValues = url.searchParams.getAll('path');
  const scopedPaths = pathValues.map((value) => resolvePathWithinProject(canonicalPath, value));
  if (scopedPaths.some((value) => value === null)) {
    const error = new Error('directory is outside the project');
    error.code = 'catalog_path_outside_project';
    error.status = 403;
    throw error;
  }
  url.searchParams.delete('path');
  if (scopedPaths.length === 0) {
    url.searchParams.set('path', normalizePathForBoundary(canonicalPath));
  } else {
    for (const scopedPath of scopedPaths) url.searchParams.append('path', scopedPath);
  }
  return `${url.pathname}${url.search}`;
};

/** Reads filesystem/terminal path fields whose owning routes do not reliably
 * resolve the active project from the directory header (for example
 * `/api/fs/reveal`, `/api/fs/clone`, `/api/fs/exec`, and terminal `cwd`). */
export const readRequestProjectPathHints = (restPath, request) => {
  let url;
  try {
    url = new URL(restPath, 'http://project.local');
  } catch {
    return [];
  }
  const pathname = url.pathname;
  const hints = [];
  const push = (value) => {
    if (typeof value === 'string' && value.trim().length > 0 && !hints.includes(value)) hints.push(value);
  };
  const pushMany = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) push(item);
      return;
    }
    push(value);
  };
  const body = request?.body && typeof request.body === 'object' && !Buffer.isBuffer(request.body)
    ? request.body
    : null;

  if (pathname.startsWith('/api/fs/') || pathname.startsWith('/api/file/') || pathname.startsWith('/api/find/')) {
    for (const key of ['path', 'file', 'worktreeRoot']) {
      for (const value of url.searchParams.getAll(key)) push(value);
    }
  }
  if (pathname.startsWith('/api/fs/serve/')) {
    const encodedPath = pathname.slice('/api/fs/serve/'.length);
    try {
      const decodedPath = decodeURIComponent(encodedPath);
      push(decodedPath.startsWith('/') ? decodedPath : `/${decodedPath}`);
    } catch {
      push(encodedPath.startsWith('/') ? encodedPath : `/${encodedPath}`);
    }
  }
  if (pathname.startsWith('/api/git/') || pathname.startsWith('/api/vcs/')) {
    for (const key of ['path', 'file', 'worktreeRoot']) {
      for (const value of url.searchParams.getAll(key)) push(value);
    }
  }
  if (pathname.startsWith('/api/fs/')) {
    for (const key of ['path', 'destinationPath', 'oldPath', 'newPath', 'cwd']) {
      pushMany(body?.[key]);
    }
  }
  if (pathname.startsWith('/api/git/') || pathname.startsWith('/api/vcs/')) {
    for (const key of ['path', 'file', 'oldPath', 'newPath', 'worktreeRoot']) {
      pushMany(body?.[key]);
    }
    for (const key of ['paths', 'files', 'stageFiles']) {
      pushMany(body?.[key]);
    }
  }
  if (pathname === '/api/fs/exec') push(body?.cwd);
  if (pathname === '/api/terminal/create' || /\/api\/terminal\/[^/]+\/restart$/.test(pathname)) {
    push(body?.cwd);
  }
  return hints;
};

/** Reads directory hints from an Express request: the x-opencode-directory /
 * x-openchamber-directory headers and the `directory` query parameter.
 * Returns a de-duplicated list of hint values (empty when absent). */
export const readRequestDirectoryHints = (request) => {
  const hints = [];
  const push = (value) => {
    if (typeof value === 'string' && value.length > 0 && !hints.includes(value)) {
      hints.push(value);
    }
  };
  const headers = request?.headers;
  if (headers) {
    if (Array.isArray(headers)) {
      for (const entry of headers) {
        if (!Array.isArray(entry)) continue;
        const name = String(entry[0] ?? '').toLowerCase();
        if (name === 'x-opencode-directory' || name === 'x-openchamber-directory') {
          push(entry[1]);
        }
      }
    } else {
      push(headers['x-opencode-directory']);
      push(headers['x-openchamber-directory']);
    }
  }
  const query = request?.query;
  if (query && typeof query === 'object') {
    const directory = query.directory;
    if (Array.isArray(directory)) {
      for (const value of directory) push(value);
    } else if (typeof directory === 'string') {
      push(directory);
    }
  }
  return hints;
};
