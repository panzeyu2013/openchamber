import { describe, expect, it } from 'vitest';
import {
  isPathWithinProject,
  isPathWithinRoot,
  normalizePathForBoundary,
  readRequestDirectoryHints,
  readRequestProjectPathHints,
  resolvePathWithinProject,
  scopeProjectDirectoryListRequest,
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

describe('project-relative path hints', () => {
  it('accepts relative descendants and resolves them against the root', () => {
    expect(isPathWithinProject('/safe/root', 'src/index.ts')).toBe(true);
    expect(resolvePathWithinProject('/safe/root', 'src/../README.md')).toBe('/safe/root/README.md');
    expect(resolvePathWithinProject('/safe/root', '/safe/root/src')).toBe('/safe/root/src');
  });

  it('rejects relative parent traversal and absolute siblings', () => {
    expect(isPathWithinProject('/safe/root', '../secret')).toBe(false);
    expect(isPathWithinProject('/safe/root', '/safe/secret')).toBe(false);
    expect(resolvePathWithinProject('/safe/root', '../secret')).toBeNull();
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

describe('scopeProjectDirectoryListRequest', () => {
  it('fills the authoritative project directory when path is omitted', () => {
    expect(scopeProjectDirectoryListRequest('/project/app', '/api/fs/list?respectGitignore=true'))
      .toBe('/api/fs/list?respectGitignore=true&path=%2Fproject%2Fapp');
  });

  it('preserves an in-project path and rejects an outside path', () => {
    expect(scopeProjectDirectoryListRequest('/project/app', '/api/fs/list?path=%2Fproject%2Fapp%2Fsrc'))
      .toBe('/api/fs/list?path=%2Fproject%2Fapp%2Fsrc');
    expect(() => scopeProjectDirectoryListRequest('/project/app', '/api/fs/list?path=%2Fetc'))
      .toThrowError(expect.objectContaining({ code: 'catalog_path_outside_project', status: 403 }));
  });

  it('expands a relative list path under the authoritative project root', () => {
    expect(scopeProjectDirectoryListRequest('/project/app', '/api/fs/list?path=src'))
      .toBe('/api/fs/list?path=%2Fproject%2Fapp%2Fsrc');
  });
});

describe('readRequestProjectPathHints', () => {
  it('reads paths from filesystem and terminal routes with nonstandard scope fields', () => {
    expect(readRequestProjectPathHints('/api/fs/reveal', { body: { path: '/project/app/file' } }))
      .toEqual(['/project/app/file']);
    expect(readRequestProjectPathHints('/api/fs/clone', { body: { destinationPath: '/project/app/clone' } }))
      .toEqual(['/project/app/clone']);
    expect(readRequestProjectPathHints('/api/fs/exec', { body: { cwd: '/project/app' } }))
      .toEqual(['/project/app']);
    expect(readRequestProjectPathHints('/api/terminal/term-1/restart', { body: { cwd: '/project/app/sub' } }))
      .toEqual(['/project/app/sub']);
  });

  it('collects file and Git path fields from query and JSON bodies', () => {
    expect(readRequestProjectPathHints('/api/fs/rename?path=src%2Fold.ts', {
      body: { oldPath: 'src/old.ts', newPath: 'src/new.ts' },
    })).toEqual(['src/old.ts', 'src/new.ts']);
    expect(readRequestProjectPathHints('/api/git/stage', {
      body: { paths: ['src/a.ts', 'src/b.ts'] },
    })).toEqual(['src/a.ts', 'src/b.ts']);
    expect(readRequestProjectPathHints('/api/git/log?file=src%2Fmain.ts', { body: {} }))
      .toEqual(['src/main.ts']);
  });

  it('collects the route path from filesystem serving endpoints', () => {
    expect(readRequestProjectPathHints('/api/fs/serve/project%2Fapp%2Fpublic%2Findex.html', { body: {} }))
      .toEqual(['/project/app/public/index.html']);
    expect(readRequestProjectPathHints('/api/fs/serve/etc/passwd', { body: {} }))
      .toEqual(['/etc/passwd']);
  });
});
