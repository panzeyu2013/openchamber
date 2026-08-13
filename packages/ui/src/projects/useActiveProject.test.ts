import { describe, expect, test } from 'bun:test';
import { resolveActiveProjectId } from './session-index-store';
import { resolveActiveProjectCapabilities } from './useActiveProject';
import type { ConnectionProfileSummary, ProjectCatalogSnapshot, ProjectSessionSummary } from './types';

const makeSession = (projectId: string, sessionId: string, directory: string): ProjectSessionSummary => ({
  key: `${projectId}\0${sessionId}`,
  projectId,
  connectionId: 'conn-1',
  upstreamSessionId: sessionId,
  directory,
  title: `Session ${sessionId}`,
  updatedAt: 1000,
  archived: false,
  createdAt: 1000,
});

const makeConnection = (id: string, terminal: boolean, overrides: Partial<ConnectionProfileSummary> = {}): ConnectionProfileSummary => ({
  id,
  label: `Connection ${id}`,
  capabilities: { pathBrowse: true, terminal, files: true, git: true, eventStream: true },
  ...overrides,
});

const makeSnapshot = (connections: ConnectionProfileSummary[], projects: ProjectCatalogSnapshot['projects']): ProjectCatalogSnapshot => ({
  schemaVersion: 1,
  revision: 1,
  connections,
  projects,
  migration: { legacyProjectsImported: true, pendingConnectionIds: [] },
});

describe('resolveActiveProjectId', () => {
  test('resolves the project of the currently selected session', () => {
    const sessions = [makeSession('ws-1', 'ses-1', '/a')];
    expect(resolveActiveProjectId(sessions, 'ses-1', '/a')).toBe('ws-1');
  });

  test('returns null when the session is not in the index (legacy path)', () => {
    const sessions = [makeSession('ws-1', 'ses-1', '/a')];
    expect(resolveActiveProjectId(sessions, 'ses-legacy', '/b')).toBeNull();
  });

  test('returns null when no session is selected or no index exists', () => {
    expect(resolveActiveProjectId(undefined, 'ses-1', '/a')).toBeNull();
    expect(resolveActiveProjectId([], null, null)).toBeNull();
  });

  test('disambiguates a session id collision across projects by directory', () => {
    const sessions = [
      makeSession('ws-1', 'same-id', '/home/a'),
      makeSession('ws-2', 'same-id', '/home/b'),
    ];
    expect(resolveActiveProjectId(sessions, 'same-id', '/home/b')).toBe('ws-2');
    expect(resolveActiveProjectId(sessions, 'same-id', '/home/a')).toBe('ws-1');
  });

  test('falls back to the first match when the directory is unknown', () => {
    const sessions = [
      makeSession('ws-1', 'same-id', '/home/a'),
      makeSession('ws-2', 'same-id', '/home/b'),
    ];
    expect(resolveActiveProjectId(sessions, 'same-id', '/elsewhere')).toBe('ws-1');
  });
});

describe('resolveActiveProjectCapabilities', () => {
  const snapshot = makeSnapshot(
    [makeConnection('conn-a', true), makeConnection('conn-b', false)],
    [
      { id: 'ws-a', connectionId: 'conn-a', path: '/a', canonicalPath: '/a', label: 'A', orderKey: 'a', createdAt: 1, updatedAt: 1 },
      { id: 'ws-b', connectionId: 'conn-b', path: '/b', canonicalPath: '/b', label: 'B', orderKey: 'b', createdAt: 1, updatedAt: 1 },
    ],
  );

  test('returns the connection capabilities of the project', () => {
    const capabilities = resolveActiveProjectCapabilities('ws-a', snapshot);
    expect(capabilities).not.toBeNull();
    expect(capabilities?.terminal).toBe(true);
    expect(resolveActiveProjectCapabilities('ws-b', snapshot)?.terminal).toBe(false);
  });

  test('returns null when there is no active project', () => {
    expect(resolveActiveProjectCapabilities(null, snapshot)).toBeNull();
    expect(resolveActiveProjectCapabilities('ws-missing', snapshot)).toBeNull();
  });

  test('returns null while the catalog has no authoritative snapshot (do not gate)', () => {
    expect(resolveActiveProjectCapabilities('ws-a', null)).toBeNull();
  });

  test('returns null when the project connection is missing from the snapshot', () => {
    const orphaned = makeSnapshot(
      [makeConnection('conn-a', true)],
      [{ id: 'ws-x', connectionId: 'conn-gone', path: '/x', canonicalPath: '/x', label: 'X', orderKey: 'x', createdAt: 1, updatedAt: 1 }],
    );
    expect(resolveActiveProjectCapabilities('ws-x', orphaned)).toBeNull();
  });
});
