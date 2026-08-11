import { describe, expect, it } from 'vitest';
import {
  isPathWithinWorkspace,
  isPathWithinRoot,
  normalizePathForBoundary,
  readRequestDirectoryHints,
  readRequestWorkspacePathHints,
  resolvePathWithinWorkspace,
  scopeWorkspaceDirectoryListRequest,
} from './path-boundary.js';

describe('normalizePathForBoundary', () => {
  it('collapses dot segments and duplicate separators', () => {
    expect(normalizePathForBoundary('/safe/root/./sub//deep')).toBe('/safe/root/sub/deep');
  });

  it('collapses parent segments', () => {
    expect(normalizePathForBoundary('/safe/root/../secret')).toBe('/safe/secret');
    expect(normalizePathForBoundary('/safe/root/sub/../back')).toBe('/safe/root/back');
  });

  it('keeps absolute roots when parent segments reach the top', () => {
    expect(normalizePathForBoundary('/../secret')).toBe('/secret');
    expect(normalizePathForBoundary('/..')).toBe('/');
  });

  it('handles Windows drive and UNC roots', () => {
    expect(normalizePathForBoundary('C:\\safe\\..\\secret')).toBe('C:/secret');
    expect(normalizePathForBoundary('C:\\..')).toBe('C:/');
    expect(normalizePathForBoundary('\\\\server\\share\\..')).toBe('//server');
    expect(normalizePathForBoundary('\\\\server\\share\\sub')).toBe('//server/share/sub');
  });

  it('preserves relative parent segments above the start', () => {
    expect(normalizePathForBoundary('../secret')).toBe('../secret');
  });
});

describe('isPathWithinRoot', () => {
  it('accepts the root itself and descendants', () => {
    expect(isPathWithinRoot('/safe/root', '/safe/root')).toBe(true);
    expect(isPathWithinRoot('/safe/root', '/safe/root/sub')).toBe(true);
    expect(isPathWithinRoot('/safe/root', '/safe/root/sub/../sub2')).toBe(true);
  });

  it('rejects parent traversal out of the root', () => {
    expect(isPathWithinRoot('/safe/root', '/safe/root/../secret')).toBe(false);
    expect(isPathWithinRoot('/safe/root', '/safe/secret')).toBe(false);
    expect(isPathWithinRoot('/safe/root', '/etc')).toBe(false);
    expect(isPathWithinRoot('/safe/root', '../etc')).toBe(false);
  });

  it('rejects prefix-collision siblings', () => {
    expect(isPathWithinRoot('/safe/root', '/safe/rooted')).toBe(false);
  });

  it('handles Windows roots with backslashes', () => {
    expect(isPathWithinRoot('C:\\safe\\root', 'C:\\safe\\root\\sub')).toBe(true);
    expect(isPathWithinRoot('C:\\safe\\root', 'C:\\safe\\root\\..\\secret')).toBe(false);
    expect(isPathWithinRoot('C:\\safe\\root', 'C:\\safe\\rooted')).toBe(false);
  });

  it('treats the machine root as containing everything', () => {
    expect(isPathWithinRoot('/', '/etc/passwd')).toBe(true);
    expect(isPathWithinRoot('/', '/')).toBe(true);
  });
});

describe('workspace-relative path hints', () => {
  it('accepts relative descendants and resolves them against the root', () => {
    expect(isPathWithinWorkspace('/safe/root', 'src/index.ts')).toBe(true);
    expect(resolvePathWithinWorkspace('/safe/root', 'src/../README.md')).toBe('/safe/root/README.md');
    expect(resolvePathWithinWorkspace('/safe/root', '/safe/root/src')).toBe('/safe/root/src');
  });

  it('rejects relative parent traversal and absolute siblings', () => {
    expect(isPathWithinWorkspace('/safe/root', '../secret')).toBe(false);
    expect(isPathWithinWorkspace('/safe/root', '/safe/secret')).toBe(false);
    expect(resolvePathWithinWorkspace('/safe/root', '../secret')).toBeNull();
  });
});

describe('readRequestDirectoryHints', () => {
  it('collects header and query directory hints', () => {
    const hints = readRequestDirectoryHints({
      headers: { 'x-opencode-directory': '/a', 'x-openchamber-directory': '/b' },
      query: { directory: '/c' },
    });
    expect(hints).toEqual(['/a', '/b', '/c']);
  });

  it('de-duplicates repeated hints', () => {
    const hints = readRequestDirectoryHints({
      headers: { 'x-opencode-directory': '/a' },
      query: { directory: ['/a', '/b'] },
    });
    expect(hints).toEqual(['/a', '/b']);
  });

  it('returns an empty list when nothing is present', () => {
    expect(readRequestDirectoryHints({ headers: {}, query: {} })).toEqual([]);
    expect(readRequestDirectoryHints(undefined)).toEqual([]);
  });
});

describe('scopeWorkspaceDirectoryListRequest', () => {
  it('fills the authoritative workspace directory when path is omitted', () => {
    expect(scopeWorkspaceDirectoryListRequest('/workspace/app', '/api/fs/list?respectGitignore=true'))
      .toBe('/api/fs/list?respectGitignore=true&path=%2Fworkspace%2Fapp');
  });

  it('preserves an in-workspace path and rejects an outside path', () => {
    expect(scopeWorkspaceDirectoryListRequest('/workspace/app', '/api/fs/list?path=%2Fworkspace%2Fapp%2Fsrc'))
      .toBe('/api/fs/list?path=%2Fworkspace%2Fapp%2Fsrc');
    expect(() => scopeWorkspaceDirectoryListRequest('/workspace/app', '/api/fs/list?path=%2Fetc'))
      .toThrowError(expect.objectContaining({ code: 'catalog_path_outside_workspace', status: 403 }));
  });

  it('expands a relative list path under the authoritative workspace root', () => {
    expect(scopeWorkspaceDirectoryListRequest('/workspace/app', '/api/fs/list?path=src'))
      .toBe('/api/fs/list?path=%2Fworkspace%2Fapp%2Fsrc');
  });
});

describe('readRequestWorkspacePathHints', () => {
  it('reads paths from filesystem and terminal routes with nonstandard scope fields', () => {
    expect(readRequestWorkspacePathHints('/api/fs/reveal', { body: { path: '/workspace/app/file' } }))
      .toEqual(['/workspace/app/file']);
    expect(readRequestWorkspacePathHints('/api/fs/clone', { body: { destinationPath: '/workspace/app/clone' } }))
      .toEqual(['/workspace/app/clone']);
    expect(readRequestWorkspacePathHints('/api/fs/exec', { body: { cwd: '/workspace/app' } }))
      .toEqual(['/workspace/app']);
    expect(readRequestWorkspacePathHints('/api/terminal/term-1/restart', { body: { cwd: '/workspace/app/sub' } }))
      .toEqual(['/workspace/app/sub']);
  });

  it('collects file and Git path fields from query and JSON bodies', () => {
    expect(readRequestWorkspacePathHints('/api/fs/rename?path=src%2Fold.ts', {
      body: { oldPath: 'src/old.ts', newPath: 'src/new.ts' },
    })).toEqual(['src/old.ts', 'src/new.ts']);
    expect(readRequestWorkspacePathHints('/api/git/stage', {
      body: { paths: ['src/a.ts', 'src/b.ts'] },
    })).toEqual(['src/a.ts', 'src/b.ts']);
    expect(readRequestWorkspacePathHints('/api/git/log?file=src%2Fmain.ts', { body: {} }))
      .toEqual(['src/main.ts']);
  });

  it('collects the route path from filesystem serving endpoints', () => {
    expect(readRequestWorkspacePathHints('/api/fs/serve/workspace%2Fapp%2Fpublic%2Findex.html', { body: {} }))
      .toEqual(['/workspace/app/public/index.html']);
    expect(readRequestWorkspacePathHints('/api/fs/serve/etc/passwd', { body: {} }))
      .toEqual(['/etc/passwd']);
  });
});
