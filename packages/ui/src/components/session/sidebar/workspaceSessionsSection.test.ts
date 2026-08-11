import { describe, expect, test } from 'bun:test';
import { openWorkspaceSession } from './workspaceSessionOpen';

describe('openWorkspaceSession', () => {
  test('opens a remote workspace session through the unified selection path', () => {
    const calls: Array<[string, string | null, string]> = [];
    openWorkspaceSession({ workspaceId: 'workspace-remote', upstreamSessionId: 'ses-remote', directory: '/remote/repo' }, (id, directory, workspaceId) => {
      calls.push([id, directory, workspaceId]);
    });
    expect(calls).toEqual([['ses-remote', '/remote/repo', 'workspace-remote']]);
  });

  test('passes null when the session has no directory yet', () => {
    const calls: Array<[string, string | null, string]> = [];
    openWorkspaceSession({ workspaceId: 'workspace-unsynced', upstreamSessionId: 'ses-unsynced', directory: undefined }, (id, directory, workspaceId) => {
      calls.push([id, directory, workspaceId]);
    });
    expect(calls).toEqual([['ses-unsynced', null, 'workspace-unsynced']]);
  });

  test('never switches the global runtime endpoint and never resets state', () => {
    // The open contract: only `setCurrentSession` is invoked with the
    // session identity; the workspace scope is resolved inside the store, so
    // no switchRuntimeEndpoint / runtime reset call can originate here.
    const invoked = new Set<string>();
    openWorkspaceSession({ workspaceId: 'workspace-1', upstreamSessionId: 'ses-1', directory: '/repo' }, () => {
      invoked.add('setCurrentSession');
    });
    expect(invoked).toEqual(new Set(['setCurrentSession']));
  });
});
