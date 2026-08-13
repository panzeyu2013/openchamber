import { describe, expect, test } from 'bun:test';
import {
  legacyScopeKeyForProjectKey,
  parseProjectSessionKey,
  projectIdFromScopeKey,
  projectScopeKey,
  projectSessionKey,
} from './identity';

describe('project identity keys', () => {
  test('projectScopeKey is the project: prefix plus the project id', () => {
    expect(projectScopeKey('ws-1')).toBe('project:ws-1');
    expect(projectScopeKey('ws/a/ünicode')).toBe('project:ws/a/ünicode');
  });

  test('projectSessionKey joins project id and session id with a NUL separator', () => {
    const key = projectSessionKey('ws-1', 'ses-1');
    expect(key).toBe('ws-1\0ses-1');
    expect(key).toContain('\0');
  });

  test('the same upstream session id in different projects yields different keys', () => {
    expect(projectSessionKey('ws-1', 'ses-1')).not.toBe(projectSessionKey('ws-2', 'ses-1'));
    expect(projectSessionKey('ws-1', 'ses-1')).not.toBe(projectSessionKey('ws-1', 'ses-2'));
  });

  test('keys remain unambiguous when the project id contains slashes and unicode', () => {
    const projectId = 'ws/alpha/日本語';
    const upstreamSessionId = 'ses/1';
    const key = projectSessionKey(projectId, upstreamSessionId);
    expect(key).toBe('ws/alpha/日本語\0ses/1');
    expect(parseProjectSessionKey(key)).toEqual({ projectId, upstreamSessionId });
  });

  test('parseProjectSessionKey round-trips valid keys', () => {
    expect(parseProjectSessionKey('ws-1\0ses-1')).toEqual({ projectId: 'ws-1', upstreamSessionId: 'ses-1' });
    expect(parseProjectSessionKey('ws/a/日本\0ses/2')).toEqual({ projectId: 'ws/a/日本', upstreamSessionId: 'ses/2' });
    expect(parseProjectSessionKey(projectSessionKey('ws-1', 'ses-1'))).toEqual({ projectId: 'ws-1', upstreamSessionId: 'ses-1' });
  });

  test('parseProjectSessionKey splits on the first NUL only', () => {
    expect(parseProjectSessionKey('ws-1\0ses-1\0extra')).toEqual({ projectId: 'ws-1', upstreamSessionId: 'ses-1\0extra' });
  });

  test('parseProjectSessionKey returns null when the NUL separator is missing', () => {
    expect(parseProjectSessionKey('ws-1ses-1')).toBeNull();
    expect(parseProjectSessionKey('ws/a/日本/ses/2')).toBeNull();
    expect(parseProjectSessionKey('')).toBeNull();
  });

  test('parseProjectSessionKey returns null when the NUL is at position 0', () => {
    expect(parseProjectSessionKey('\0ses-1')).toBeNull();
    expect(parseProjectSessionKey('\0')).toBeNull();
  });

  test('parseProjectSessionKey returns null when the NUL is at the end', () => {
    expect(parseProjectSessionKey('ws-1\0')).toBeNull();
  });

  test('parseProjectSessionKey returns null for non-string inputs', () => {
    expect(parseProjectSessionKey(42 as unknown as string)).toBeNull();
    expect(parseProjectSessionKey(null as unknown as string)).toBeNull();
    expect(parseProjectSessionKey(undefined as unknown as string)).toBeNull();
    expect(parseProjectSessionKey({} as unknown as string)).toBeNull();
  });
});

describe('scope key legacy compatibility (P-MIG)', () => {
  test('projectIdFromScopeKey parses project: prefix keys', () => {
    expect(projectIdFromScopeKey('project:ws-1')).toBe('ws-1');
    expect(projectIdFromScopeKey('project:ws/a/ünicode')).toBe('ws/a/ünicode');
  });

  test('projectIdFromScopeKey recognizes the legacy workspace: prefix', () => {
    expect(projectIdFromScopeKey('workspace:ws-1')).toBe('ws-1');
    expect(projectIdFromScopeKey('workspace:ws/a/ünicode')).toBe('ws/a/ünicode');
  });

  test('projectIdFromScopeKey returns null for ambient/runtime keys and empty ids', () => {
    expect(projectIdFromScopeKey('')).toBeNull();
    expect(projectIdFromScopeKey('project:')).toBeNull();
    expect(projectIdFromScopeKey('workspace:')).toBeNull();
    expect(projectIdFromScopeKey('runtime:xyz')).toBeNull();
    expect(projectIdFromScopeKey('ws-1')).toBeNull();
    expect(projectIdFromScopeKey(42 as unknown as string)).toBeNull();
  });

  test('legacyScopeKeyForProjectKey maps a project: key to its workspace: variant', () => {
    expect(legacyScopeKeyForProjectKey('project:ws-1')).toBe('workspace:ws-1');
    expect(legacyScopeKeyForProjectKey('project:ws/a/ünicode')).toBe('workspace:ws/a/ünicode');
  });

  test('legacyScopeKeyForProjectKey returns null for non-project-prefixed keys', () => {
    expect(legacyScopeKeyForProjectKey('workspace:ws-1')).toBeNull();
    expect(legacyScopeKeyForProjectKey('project:')).toBeNull();
    expect(legacyScopeKeyForProjectKey('')).toBeNull();
    expect(legacyScopeKeyForProjectKey(42 as unknown as string)).toBeNull();
  });
});
