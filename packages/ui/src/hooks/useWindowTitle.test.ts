import { describe, expect, test } from 'bun:test';
import { resolveProjectTitleContext } from './useWindowTitle';
import type { ProjectCatalogSnapshot } from '@/projects/types';

const snapshot: ProjectCatalogSnapshot = {
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
  projects: [
    {
      id: 'local-project',
      connectionId: 'local',
      path: '/work/local-app',
      canonicalPath: '/work/local-app',
      label: 'Local App',
      orderKey: '000000000001',
      createdAt: 1,
      updatedAt: 2,
    },
    {
      id: 'remote-project',
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

describe('resolveProjectTitleContext', () => {
  test('uses project and connection metadata for remote identity', () => {
    expect(resolveProjectTitleContext('remote-project', snapshot)).toEqual({
      projectLabel: 'Remote App',
      instanceLabel: 'Remote Office',
    });
  });

  test('does not add a host label for local projects', () => {
    expect(resolveProjectTitleContext('local-project', snapshot)).toEqual({
      projectLabel: 'Local App',
      instanceLabel: null,
    });
  });

  test('does not invent project identity when the catalog cannot resolve it', () => {
    expect(resolveProjectTitleContext('missing-project', snapshot)).toBe(null);
    expect(resolveProjectTitleContext('remote-project', null)).toBe(null);
  });
});
