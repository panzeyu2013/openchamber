import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

describe('VS Code webview control-plane path handling', () => {
  test('recognizes workspace catalog paths', async () => {
    const { isControlPlaneApiPath } = await import('./controlPlane');
    assert.equal(isControlPlaneApiPath('/api/workspaces'), true);
    assert.equal(isControlPlaneApiPath('/api/workspaces/ws-1'), true);
    assert.equal(isControlPlaneApiPath('/api/workspaces/ws-1/runtime/api/session'), true);
  });

  test('recognizes session index and connection paths', async () => {
    const { isControlPlaneApiPath } = await import('./controlPlane');
    assert.equal(isControlPlaneApiPath('/api/workspace-sessions/snapshot'), true);
    assert.equal(isControlPlaneApiPath('/api/workspace-sessions/events'), true);
    assert.equal(isControlPlaneApiPath('/api/connections'), true);
    assert.equal(isControlPlaneApiPath('/api/connections/conn-1/probe'), true);
  });

  test('leaves opencode-owned paths alone', async () => {
    const { isControlPlaneApiPath } = await import('./controlPlane');
    assert.equal(isControlPlaneApiPath('/api/session'), false);
    assert.equal(isControlPlaneApiPath('/api/sessions/snapshot'), false);
    assert.equal(isControlPlaneApiPath('/health'), false);
    assert.equal(isControlPlaneApiPath('/'), false);
  });

  test('builds an explicit control_plane_unavailable 501 response', async () => {
    const { buildControlPlaneUnavailableResponse, CONTROL_PLANE_UNAVAILABLE_CODE } = await import('./controlPlane');
    const response = buildControlPlaneUnavailableResponse();
    assert.equal(response.status, 501);
    const body = await response.json() as { error?: string; code?: string };
    assert.equal(body.code, CONTROL_PLANE_UNAVAILABLE_CODE);
    assert.equal(typeof body.error, 'string');
    assert.equal(response.headers.get('content-type'), 'application/json');
  });
});
