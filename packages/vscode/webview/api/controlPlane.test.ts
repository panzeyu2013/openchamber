import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

describe('VS Code webview control-plane path handling', () => {
  test('recognizes project catalog paths', async () => {
    const { isControlPlaneApiPath } = await import('./controlPlane');
    assert.equal(isControlPlaneApiPath('/api/projects'), true);
    assert.equal(isControlPlaneApiPath('/api/projects/p-1'), true);
    assert.equal(isControlPlaneApiPath('/api/projects/p-1/runtime/api/session'), true);
  });

  test('recognizes session index and connection paths', async () => {
    const { isControlPlaneApiPath } = await import('./controlPlane');
    assert.equal(isControlPlaneApiPath('/api/project-sessions/snapshot'), true);
    assert.equal(isControlPlaneApiPath('/api/project-sessions/events'), true);
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

  test('detects control-plane SSE requests by the accept header', async () => {
    const { isControlPlaneSseRequest } = await import('./controlPlane');
    assert.equal(isControlPlaneSseRequest({ accept: 'text/event-stream' }), true);
    assert.equal(isControlPlaneSseRequest({ Accept: 'text/event-stream, text/html' }), true);
    assert.equal(isControlPlaneSseRequest({ accept: 'application/json' }), false);
    assert.equal(isControlPlaneSseRequest(undefined), false);
    assert.equal(isControlPlaneSseRequest({}), false);
  });
});
