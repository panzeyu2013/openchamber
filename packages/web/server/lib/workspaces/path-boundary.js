/**
 * Workspace path boundary helpers.
 *
 * Adapter-agnostic lexical containment check: collapses `.`/`..` segments
 * without touching the filesystem, so client paths like
 * `/safe/root/../secret` cannot bypass the workspace boundary. Real-path
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
