import { describe, expect, test } from 'bun:test';
import { parseWorkspaceSessionKey, workspaceScopeKey, workspaceSessionKey } from './identity';

describe('workspace identity keys', () => {
  test('workspaceScopeKey is the workspace: prefix plus the workspace id', () => {
    expect(workspaceScopeKey('ws-1')).toBe('workspace:ws-1');
    expect(workspaceScopeKey('ws/a/ünicode')).toBe('workspace:ws/a/ünicode');
  });

  test('workspaceSessionKey joins workspace id and session id with a NUL separator', () => {
    const key = workspaceSessionKey('ws-1', 'ses-1');
    expect(key).toBe('ws-1\0ses-1');
    expect(key).toContain('\0');
  });

  test('the same upstream session id in different workspaces yields different keys', () => {
    expect(workspaceSessionKey('ws-1', 'ses-1')).not.toBe(workspaceSessionKey('ws-2', 'ses-1'));
    expect(workspaceSessionKey('ws-1', 'ses-1')).not.toBe(workspaceSessionKey('ws-1', 'ses-2'));
  });

  test('keys remain unambiguous when the workspace id contains slashes and unicode', () => {
    const workspaceId = 'ws/alpha/日本語';
    const upstreamSessionId = 'ses/1';
    const key = workspaceSessionKey(workspaceId, upstreamSessionId);
    expect(key).toBe('ws/alpha/日本語\0ses/1');
    expect(parseWorkspaceSessionKey(key)).toEqual({ workspaceId, upstreamSessionId });
  });

  test('parseWorkspaceSessionKey round-trips valid keys', () => {
    expect(parseWorkspaceSessionKey('ws-1\0ses-1')).toEqual({ workspaceId: 'ws-1', upstreamSessionId: 'ses-1' });
    expect(parseWorkspaceSessionKey('ws/a/日本\0ses/2')).toEqual({ workspaceId: 'ws/a/日本', upstreamSessionId: 'ses/2' });
    expect(parseWorkspaceSessionKey(workspaceSessionKey('ws-1', 'ses-1'))).toEqual({ workspaceId: 'ws-1', upstreamSessionId: 'ses-1' });
  });

  test('parseWorkspaceSessionKey splits on the first NUL only', () => {
    expect(parseWorkspaceSessionKey('ws-1\0ses-1\0extra')).toEqual({ workspaceId: 'ws-1', upstreamSessionId: 'ses-1\0extra' });
  });

  test('parseWorkspaceSessionKey returns null when the NUL separator is missing', () => {
    expect(parseWorkspaceSessionKey('ws-1ses-1')).toBeNull();
    expect(parseWorkspaceSessionKey('ws/a/日本/ses/2')).toBeNull();
    expect(parseWorkspaceSessionKey('')).toBeNull();
  });

  test('parseWorkspaceSessionKey returns null when the NUL is at position 0', () => {
    expect(parseWorkspaceSessionKey('\0ses-1')).toBeNull();
    expect(parseWorkspaceSessionKey('\0')).toBeNull();
  });

  test('parseWorkspaceSessionKey returns null when the NUL is at the end', () => {
    expect(parseWorkspaceSessionKey('ws-1\0')).toBeNull();
  });

  test('parseWorkspaceSessionKey returns null for non-string inputs', () => {
    expect(parseWorkspaceSessionKey(42 as unknown as string)).toBeNull();
    expect(parseWorkspaceSessionKey(null as unknown as string)).toBeNull();
    expect(parseWorkspaceSessionKey(undefined as unknown as string)).toBeNull();
    expect(parseWorkspaceSessionKey({} as unknown as string)).toBeNull();
  });
});
