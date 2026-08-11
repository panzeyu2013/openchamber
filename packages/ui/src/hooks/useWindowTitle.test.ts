import { describe, expect, test } from 'bun:test';
import { resolveWorkspaceTitleContext } from './useWindowTitle';
import type { WorkspaceCatalogSnapshot } from '@/workspaces/types';

const snapshot: WorkspaceCatalogSnapshot = {
  schemaVersion: 1,
  revision: 4,
  connections: [
    {
      id: 'local',
      label: 'This computer',
      capabilities: {
        pathBrowse: true,
        terminal: true,
        files: true,
        git: true,
        eventStream: true,
      },
    },
    {
      id: 'remote-1',
      label: 'Remote Office',
      capabilities: {
        pathBrowse: true,
        terminal: true,
        files: true,
        git: true,
        eventStream: true,
      },
    },
  ],
  workspaces: [
    {
      id: 'local-workspace',
      connectionId: 'local',
      path: '/work/local-app',
      canonicalPath: '/work/local-app',
      label: 'Local App',
      orderKey: '000000000001',
      createdAt: 1,
      updatedAt: 2,
    },
    {
      id: 'remote-workspace',
      connectionId: 'remote-1',
      path: '/srv/remote-app',
      canonicalPath: '/srv/remote-app',
      label: 'Remote App',
      orderKey: '000000000002',
      createdAt: 1,
      updatedAt: 2,
    },
  ],
  migration: {
    legacyProjectsImported: true,
    pendingConnectionIds: [],
  },
};

describe('resolveWorkspaceTitleContext', () => {
  test('uses workspace and connection metadata for remote identity', () => {
    expect(resolveWorkspaceTitleContext('remote-workspace', snapshot)).toEqual({
      projectLabel: 'Remote App',
      instanceLabel: 'Remote Office',
    });
  });

  test('does not add a host label for local workspaces', () => {
    expect(resolveWorkspaceTitleContext('local-workspace', snapshot)).toEqual({
      projectLabel: 'Local App',
      instanceLabel: null,
    });
  });

  test('does not invent workspace identity when the catalog cannot resolve it', () => {
    expect(resolveWorkspaceTitleContext('missing-workspace', snapshot)).toBe(null);
    expect(resolveWorkspaceTitleContext('remote-workspace', null)).toBe(null);
  });
});
