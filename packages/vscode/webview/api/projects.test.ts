import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProjectDescriptorResult } from './projects';

describe('VS Code webview project descriptor bridge contract', () => {
  test('uses the api:workspace:descriptor:get bridge message and request payload shape', async () => {
    // bridge.ts registers window message listeners at module load; install a
    // window stub before the dynamic import so the module graph loads in a
    // plain node:test process (and independently of other test files that may
    // have already cached the module in the shared process).
    const originalWindow = globalThis.window;
    try {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: new EventTarget(),
      });

      const {
        WORKSPACE_DESCRIPTOR_BRIDGE_TYPE,
        buildProjectDescriptorRequestPayload,
      } = await import('./projects');

      assert.equal(WORKSPACE_DESCRIPTOR_BRIDGE_TYPE, 'api:workspace:descriptor:get');

      assert.equal('activePath' in buildProjectDescriptorRequestPayload(), false);
      assert.deepEqual(
        buildProjectDescriptorRequestPayload({ activePath: '/work/alpha' }),
        { activePath: '/work/alpha' },
      );
    } finally {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    }
  });

  test('types the capability_unavailable result without a projectId or project', () => {
    const result: ProjectDescriptorResult = {
      status: 'capability_unavailable',
      code: 'capability_unavailable',
      reason: 'control_plane_unavailable',
      workspaceFolders: [{ name: 'alpha', path: '/work/alpha' }],
      activePath: '/work/alpha',
    };
    assert.equal(result.status, 'capability_unavailable');
    assert.equal('projectId' in result, false);
    assert.equal('project' in result, false);
  });

  test('types the available result with the shared catalog descriptor', () => {
    const result: ProjectDescriptorResult = {
      status: 'available',
      projectId: 'ws-1',
      project: {
        id: 'ws-1',
        connectionId: 'local',
        path: '/work/alpha',
        canonicalPath: '/work/alpha',
        label: 'Alpha',
        orderKey: '000000000001',
        createdAt: 100,
        updatedAt: 200,
      },
      activePath: '/work/alpha',
    };
    assert.equal(result.status, 'available');
    assert.equal(result.projectId, 'ws-1');
    assert.equal(result.project.canonicalPath, '/work/alpha');
  });
});
