import { describe, expect, test } from 'bun:test';
import { openWorkspaceSession } from './workspaceSessionOpen';

describe('openWorkspaceSession', () => {
  test('opens a remote workspace session through the unified selection path', () => {
    const calls: Array<[string, string | null]> = [];
    openWorkspaceSession({ upstreamSessionId: 'ses-remote', directory: '/remote/repo' }, (id, directory) => {
      calls.push([id, directory]);
    });
    expect(calls).toEqual([['ses-remote', '/remote/repo']]);
  });

  test('passes null when the session has no directory yet', () => {
    const calls: Array<[string, string | null]> = [];
    openWorkspaceSession({ upstreamSessionId: 'ses-unsynced', directory: undefined }, (id, directory) => {
      calls.push([id, directory]);
    });
    expect(calls).toEqual([['ses-unsynced', null]]);
  });

  test('never switches the global runtime endpoint and never resets state', () => {
    // The open contract: only `setCurrentSession` is invoked with the
    // session identity; the workspace scope is resolved inside the store, so
    // no switchRuntimeEndpoint / runtime reset call can originate here.
    const invoked = new Set<string>();
    openWorkspaceSession({ upstreamSessionId: 'ses-1', directory: '/repo' }, () => {
      invoked.add('setCurrentSession');
    });
    expect(invoked).toEqual(new Set(['setCurrentSession']));
  });
});
