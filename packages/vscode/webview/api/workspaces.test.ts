import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkspaceDescriptorResult } from './workspaces';

describe('VS Code webview workspace descriptor bridge contract', () => {
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
        buildWorkspaceDescriptorRequestPayload,
      } = await import('./workspaces');

      assert.equal(WORKSPACE_DESCRIPTOR_BRIDGE_TYPE, 'api:workspace:descriptor:get');

      assert.equal('activePath' in buildWorkspaceDescriptorRequestPayload(), false);
      assert.deepEqual(
        buildWorkspaceDescriptorRequestPayload({ activePath: '/work/alpha' }),
        { activePath: '/work/alpha' },
      );
    } finally {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    }
  });

  test('types the capability_unavailable result without a workspaceId or workspace', () => {
    const result: WorkspaceDescriptorResult = {
      status: 'capability_unavailable',
      code: 'capability_unavailable',
      reason: 'control_plane_unavailable',
      workspaceFolders: [{ name: 'alpha', path: '/work/alpha' }],
      activePath: '/work/alpha',
    };
    assert.equal(result.status, 'capability_unavailable');
    assert.equal('workspaceId' in result, false);
    assert.equal('workspace' in result, false);
  });

  test('types the available result with the shared catalog descriptor', () => {
    const result: WorkspaceDescriptorResult = {
      status: 'available',
      workspaceId: 'ws-1',
      workspace: {
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
    assert.equal(result.workspaceId, 'ws-1');
    assert.equal(result.workspace.canonicalPath, '/work/alpha');
  });
});
