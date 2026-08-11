import { describe, expect, test } from 'bun:test';
import { buildDeepLink, parseDeepLink } from './deepLinks';

describe('workspace-scoped session deep links', () => {
  test('round-trips the composite workspace/session target', () => {
    const url = buildDeepLink({
      type: 'session',
      sessionId: 'session/with spaces',
      directory: '/srv/project',
      workspaceId: 'workspace-remote',
    });

    expect(url).toBe('openchamber://session/session%2Fwith%20spaces?dir=%2Fsrv%2Fproject&workspace=workspace-remote');
    expect(parseDeepLink(url)).toEqual({
      type: 'session',
      sessionId: 'session/with spaces',
      directory: '/srv/project',
      workspaceId: 'workspace-remote',
    });
  });

  test('keeps legacy session links compatible without a workspace id', () => {
    expect(parseDeepLink('openchamber://session/session-1?dir=%2Fwork')).toEqual({
      type: 'session',
      sessionId: 'session-1',
      directory: '/work',
      workspaceId: undefined,
    });
  });
});
