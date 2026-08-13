import { describe, expect, it } from 'vitest';

import {
  createProjectId,
  createConnectionId,
  projectScopeKey,
  projectSessionKey,
  parseProjectSessionKey,
  projectLocationKey,
  isValidProjectId,
  sameCanonicalPath,
} from './project-identity.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('createProjectId / createConnectionId', () => {
  it('produces version-4 UUIDs', () => {
    const id = createProjectId();
    expect(id).toMatch(UUID_PATTERN);
    expect(id[14]).toBe('4');
    expect(createConnectionId()).toMatch(UUID_PATTERN);
  });

  it('produces unique ids', () => {
    const ids = new Set(Array.from({ length: 100 }, () => createProjectId()));
    expect(ids.size).toBe(100);
  });

  it('never derives ids from paths or names', () => {
    expect(createProjectId()).not.toBe(createProjectId());
    expect(createConnectionId()).not.toBe(createProjectId());
  });
});

describe('projectScopeKey', () => {
  it('scopes a project id', () => {
    expect(projectScopeKey('abc-123')).toBe('project:abc-123');
  });
});

describe('projectSessionKey', () => {
  it('joins project and session ids with a NUL separator', () => {
    expect(projectSessionKey('ws-1', 'sess-1')).toBe('ws-1\0sess-1');
  });

  it('round-trips session ids containing slashes', () => {
    const key = projectSessionKey('ws-1', 'a/b/c');
    expect(parseProjectSessionKey(key)).toEqual({ projectId: 'ws-1', upstreamSessionId: 'a/b/c' });
  });

  it('round-trips unicode session ids', () => {
    const key = projectSessionKey('ws-1', 'sess-日本語-проект');
    expect(parseProjectSessionKey(key)).toEqual({ projectId: 'ws-1', upstreamSessionId: 'sess-日本語-проект' });
  });

  it('stays unambiguous when an id contains an embedded NUL', () => {
    expect(parseProjectSessionKey('a\0b\0c')).toEqual({ projectId: 'a', upstreamSessionId: 'b\0c' });
  });
});

describe('parseProjectSessionKey', () => {
  it('returns null for non-strings', () => {
    expect(parseProjectSessionKey(null)).toBeNull();
    expect(parseProjectSessionKey(undefined)).toBeNull();
    expect(parseProjectSessionKey(42)).toBeNull();
    expect(parseProjectSessionKey({})).toBeNull();
  });

  it('returns null when the separator is missing', () => {
    expect(parseProjectSessionKey('')).toBeNull();
    expect(parseProjectSessionKey('no-separator-here')).toBeNull();
  });

  it('returns null when the separator is at the start', () => {
    expect(parseProjectSessionKey('\0suffix')).toBeNull();
  });

  it('returns null when the separator is at the end', () => {
    expect(parseProjectSessionKey('prefix\0')).toBeNull();
  });
});

describe('projectLocationKey', () => {
  it('is stable for the same (connection, path) pair', () => {
    expect(projectLocationKey('conn-1', '/tmp/project')).toBe(projectLocationKey('conn-1', '/tmp/project'));
  });

  it('distinguishes the same path on different connections', () => {
    expect(projectLocationKey('conn-1', '/tmp/project')).not.toBe(projectLocationKey('conn-2', '/tmp/project'));
  });

  it('distinguishes different paths on the same connection', () => {
    expect(projectLocationKey('conn-1', '/tmp/project')).not.toBe(projectLocationKey('conn-1', '/tmp/other'));
  });

  it('keeps slashes inside the path unambiguous', () => {
    expect(projectLocationKey('conn-1', 'a/b')).toBe('conn-1\0a/b');
    expect(projectLocationKey('conn-1', 'a/b')).not.toBe(projectLocationKey('conn-1\0a', 'b'));
  });
});

describe('isValidProjectId', () => {
  it('accepts UUID ids', () => {
    expect(isValidProjectId('3f0c1b2a-1111-4aaa-8bbb-9ccccccccccc')).toBe(true);
  });

  it('accepts uppercase UUIDs', () => {
    expect(isValidProjectId('3F0C1B2A-1111-4AAA-8BBB-9CCCCCCCCCCC')).toBe(true);
  });

  it('rejects path-derived ids', () => {
    expect(isValidProjectId('/home/user/project')).toBe(false);
    expect(isValidProjectId('path/catalog')).toBe(false);
    expect(isValidProjectId('~/project')).toBe(false);
    expect(isValidProjectId('project:abc')).toBe(false);
    expect(isValidProjectId('local')).toBe(false);
    expect(isValidProjectId('')).toBe(false);
    expect(isValidProjectId(null)).toBe(false);
    expect(isValidProjectId(undefined)).toBe(false);
  });
});

describe('sameCanonicalPath', () => {
  it('compares adapter-produced paths exactly', () => {
    expect(sameCanonicalPath('/a/b', '/a/b')).toBe(true);
    expect(sameCanonicalPath('/a/b', '/a/b/')).toBe(false);
    expect(sameCanonicalPath('/a/b', '/a/c')).toBe(false);
  });
});
