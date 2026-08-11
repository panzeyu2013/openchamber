import { describe, expect, test } from 'bun:test';
import { resolveActiveWorkspaceId } from './session-index-store';
import { resolveActiveWorkspaceCapabilities } from './useActiveWorkspace';
import type { ConnectionProfileSummary, WorkspaceCatalogSnapshot, WorkspaceSessionSummary } from './types';

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

const makeConnection = (id: string, terminal: boolean, overrides: Partial<ConnectionProfileSummary> = {}): ConnectionProfileSummary => ({
  id,
  label: `Connection ${id}`,
  capabilities: { pathBrowse: true, terminal, files: true, git: true, eventStream: true },
  ...overrides,
});

const makeSnapshot = (connections: ConnectionProfileSummary[], workspaces: WorkspaceCatalogSnapshot['workspaces']): WorkspaceCatalogSnapshot => ({
  schemaVersion: 1,
  revision: 1,
  connections,
  workspaces,
  migration: { legacyProjectsImported: true, pendingConnectionIds: [] },
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

describe('resolveActiveWorkspaceCapabilities', () => {
  const snapshot = makeSnapshot(
    [makeConnection('conn-a', true), makeConnection('conn-b', false)],
    [
      { id: 'ws-a', connectionId: 'conn-a', path: '/a', canonicalPath: '/a', label: 'A', orderKey: 'a', createdAt: 1, updatedAt: 1 },
      { id: 'ws-b', connectionId: 'conn-b', path: '/b', canonicalPath: '/b', label: 'B', orderKey: 'b', createdAt: 1, updatedAt: 1 },
    ],
  );

  test('returns the connection capabilities of the workspace', () => {
    const capabilities = resolveActiveWorkspaceCapabilities('ws-a', snapshot);
    expect(capabilities).not.toBeNull();
    expect(capabilities?.terminal).toBe(true);
    expect(resolveActiveWorkspaceCapabilities('ws-b', snapshot)?.terminal).toBe(false);
  });

  test('returns null when there is no active workspace', () => {
    expect(resolveActiveWorkspaceCapabilities(null, snapshot)).toBeNull();
    expect(resolveActiveWorkspaceCapabilities('ws-missing', snapshot)).toBeNull();
  });

  test('returns null while the catalog has no authoritative snapshot (do not gate)', () => {
    expect(resolveActiveWorkspaceCapabilities('ws-a', null)).toBeNull();
  });

  test('returns null when the workspace connection is missing from the snapshot', () => {
    const orphaned = makeSnapshot(
      [makeConnection('conn-a', true)],
      [{ id: 'ws-x', connectionId: 'conn-gone', path: '/x', canonicalPath: '/x', label: 'X', orderKey: 'x', createdAt: 1, updatedAt: 1 }],
    );
    expect(resolveActiveWorkspaceCapabilities('ws-x', orphaned)).toBeNull();
  });
});
