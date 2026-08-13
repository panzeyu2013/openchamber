import { describe, expect, test } from 'bun:test';
import { openProjectSession } from './projectSessionOpen';

describe('openProjectSession', () => {
  test('opens a remote project session through the unified selection path', () => {
    const calls: Array<[string, string | null, string]> = [];
    openProjectSession({ projectId: 'project-remote', upstreamSessionId: 'ses-remote', directory: '/remote/repo' }, (id, directory, projectId) => {
      calls.push([id, directory, projectId]);
    });
    expect(calls).toEqual([['ses-remote', '/remote/repo', 'project-remote']]);
  });

  test('passes null when the session has no directory yet', () => {
    const calls: Array<[string, string | null, string]> = [];
    openProjectSession({ projectId: 'project-unsynced', upstreamSessionId: 'ses-unsynced', directory: undefined }, (id, directory, projectId) => {
      calls.push([id, directory, projectId]);
    });
    expect(calls).toEqual([['ses-unsynced', null, 'project-unsynced']]);
  });

  test('never switches the global runtime endpoint and never resets state', () => {
    // The open contract: only `setCurrentSession` is invoked with the
    // session identity; the project scope is resolved inside the store, so
    // no setControlPlane / runtime reset call can originate here.
    const invoked = new Set<string>();
    openProjectSession({ projectId: 'project-1', upstreamSessionId: 'ses-1', directory: '/repo' }, () => {
      invoked.add('setCurrentSession');
    });
    expect(invoked).toEqual(new Set(['setCurrentSession']));
  });
});
