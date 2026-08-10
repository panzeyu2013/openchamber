import { describe, expect, it } from 'vitest';

import {
  createWorkspaceId,
  createConnectionId,
  workspaceScopeKey,
  workspaceSessionKey,
  parseWorkspaceSessionKey,
  workspaceLocationKey,
  isValidWorkspaceId,
  sameCanonicalPath,
} from './workspace-identity.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('createWorkspaceId / createConnectionId', () => {
  it('produces version-4 UUIDs', () => {
    const id = createWorkspaceId();
    expect(id).toMatch(UUID_PATTERN);
    expect(id[14]).toBe('4');
    expect(createConnectionId()).toMatch(UUID_PATTERN);
  });

  it('produces unique ids', () => {
    const ids = new Set(Array.from({ length: 100 }, () => createWorkspaceId()));
    expect(ids.size).toBe(100);
  });

  it('never derives ids from paths or names', () => {
    expect(createWorkspaceId()).not.toBe(createWorkspaceId());
    expect(createConnectionId()).not.toBe(createWorkspaceId());
  });
});

describe('workspaceScopeKey', () => {
  it('scopes a workspace id', () => {
    expect(workspaceScopeKey('abc-123')).toBe('workspace:abc-123');
  });
});

describe('workspaceSessionKey', () => {
  it('joins workspace and session ids with a NUL separator', () => {
    expect(workspaceSessionKey('ws-1', 'sess-1')).toBe('ws-1\0sess-1');
  });

  it('round-trips session ids containing slashes', () => {
    const key = workspaceSessionKey('ws-1', 'a/b/c');
    expect(parseWorkspaceSessionKey(key)).toEqual({ workspaceId: 'ws-1', upstreamSessionId: 'a/b/c' });
  });

  it('round-trips unicode session ids', () => {
    const key = workspaceSessionKey('ws-1', 'sess-日本語-проект');
    expect(parseWorkspaceSessionKey(key)).toEqual({ workspaceId: 'ws-1', upstreamSessionId: 'sess-日本語-проект' });
  });

  it('stays unambiguous when an id contains an embedded NUL', () => {
    expect(parseWorkspaceSessionKey('a\0b\0c')).toEqual({ workspaceId: 'a', upstreamSessionId: 'b\0c' });
  });
});

describe('parseWorkspaceSessionKey', () => {
  it('returns null for non-strings', () => {
    expect(parseWorkspaceSessionKey(null)).toBeNull();
    expect(parseWorkspaceSessionKey(undefined)).toBeNull();
    expect(parseWorkspaceSessionKey(42)).toBeNull();
    expect(parseWorkspaceSessionKey({})).toBeNull();
  });

  it('returns null when the separator is missing', () => {
    expect(parseWorkspaceSessionKey('')).toBeNull();
    expect(parseWorkspaceSessionKey('no-separator-here')).toBeNull();
  });

  it('returns null when the separator is at the start', () => {
    expect(parseWorkspaceSessionKey('\0suffix')).toBeNull();
  });

  it('returns null when the separator is at the end', () => {
    expect(parseWorkspaceSessionKey('prefix\0')).toBeNull();
  });
});

describe('workspaceLocationKey', () => {
  it('is stable for the same (connection, path) pair', () => {
    expect(workspaceLocationKey('conn-1', '/tmp/project')).toBe(workspaceLocationKey('conn-1', '/tmp/project'));
  });

  it('distinguishes the same path on different connections', () => {
    expect(workspaceLocationKey('conn-1', '/tmp/project')).not.toBe(workspaceLocationKey('conn-2', '/tmp/project'));
  });

  it('distinguishes different paths on the same connection', () => {
    expect(workspaceLocationKey('conn-1', '/tmp/project')).not.toBe(workspaceLocationKey('conn-1', '/tmp/other'));
  });

  it('keeps slashes inside the path unambiguous', () => {
    expect(workspaceLocationKey('conn-1', 'a/b')).toBe('conn-1\0a/b');
    expect(workspaceLocationKey('conn-1', 'a/b')).not.toBe(workspaceLocationKey('conn-1\0a', 'b'));
  });
});

describe('isValidWorkspaceId', () => {
  it('accepts UUID ids', () => {
    expect(isValidWorkspaceId('3f0c1b2a-1111-4aaa-8bbb-9ccccccccccc')).toBe(true);
  });

  it('accepts uppercase UUIDs', () => {
    expect(isValidWorkspaceId('3F0C1B2A-1111-4AAA-8BBB-9CCCCCCCCCCC')).toBe(true);
  });

  it('rejects path-derived ids', () => {
    expect(isValidWorkspaceId('/home/user/project')).toBe(false);
    expect(isValidWorkspaceId('path/catalog')).toBe(false);
    expect(isValidWorkspaceId('~/project')).toBe(false);
    expect(isValidWorkspaceId('workspace:abc')).toBe(false);
    expect(isValidWorkspaceId('local')).toBe(false);
    expect(isValidWorkspaceId('')).toBe(false);
    expect(isValidWorkspaceId(null)).toBe(false);
    expect(isValidWorkspaceId(undefined)).toBe(false);
  });
});

describe('sameCanonicalPath', () => {
  it('compares adapter-produced paths exactly', () => {
    expect(sameCanonicalPath('/a/b', '/a/b')).toBe(true);
    expect(sameCanonicalPath('/a/b', '/a/b/')).toBe(false);
    expect(sameCanonicalPath('/a/b', '/a/c')).toBe(false);
  });
});
