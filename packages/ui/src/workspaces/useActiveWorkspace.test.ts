import { describe, expect, test } from 'bun:test';
import { resolveActiveWorkspaceId } from './session-index-store';
import type { WorkspaceSessionSummary } from './types';

const makeSession = (workspaceId: string, sessionId: string, directory: string): WorkspaceSessionSummary => ({
  key: `${workspaceId}\0${sessionId}`,
  workspaceId,
  connectionId: 'conn-1',
  upstreamSessionId: sessionId,
  directory,
  title: `Session ${sessionId}`,
  updatedAt: 1000,
  archived: false,
});

describe('resolveActiveWorkspaceId', () => {
  test('resolves the workspace of the currently selected session', () => {
    const sessions = [makeSession('ws-1', 'ses-1', '/a')];
    expect(resolveActiveWorkspaceId(sessions, 'ses-1', '/a')).toBe('ws-1');
  });

  test('returns null when the session is not in the index (legacy path)', () => {
    const sessions = [makeSession('ws-1', 'ses-1', '/a')];
    expect(resolveActiveWorkspaceId(sessions, 'ses-legacy', '/b')).toBeNull();
  });

  test('returns null when no session is selected or no index exists', () => {
    expect(resolveActiveWorkspaceId(undefined, 'ses-1', '/a')).toBeNull();
    expect(resolveActiveWorkspaceId([], null, null)).toBeNull();
  });

  test('disambiguates a session id collision across workspaces by directory', () => {
    const sessions = [
      makeSession('ws-1', 'same-id', '/home/a'),
      makeSession('ws-2', 'same-id', '/home/b'),
    ];
    expect(resolveActiveWorkspaceId(sessions, 'same-id', '/home/b')).toBe('ws-2');
    expect(resolveActiveWorkspaceId(sessions, 'same-id', '/home/a')).toBe('ws-1');
  });

  test('falls back to the first match when the directory is unknown', () => {
    const sessions = [
      makeSession('ws-1', 'same-id', '/home/a'),
      makeSession('ws-2', 'same-id', '/home/b'),
    ];
    expect(resolveActiveWorkspaceId(sessions, 'same-id', '/elsewhere')).toBe('ws-1');
  });
});
