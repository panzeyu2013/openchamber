import { describe, expect, it } from 'vitest';
import { isPathWithinRoot, normalizePathForBoundary, readRequestDirectoryHints } from './path-boundary.js';

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
