import { describe, expect, test } from 'bun:test';
import { getWorktreeFirstSeenAt, recordWorktreesSeen } from './worktreeFirstSeen';

describe('worktree first-seen ordering', () => {
  test('keeps equal paths isolated by workspace scope', () => {
    const path = '/workspace/shared-worktree-scope-test';

    recordWorktreesSeen([path], 10, 'workspace:one');
    recordWorktreesSeen([path], 20, 'workspace:two');
    recordWorktreesSeen([path], 30, 'workspace:one');

    expect(getWorktreeFirstSeenAt(path, 'workspace:one')).toBe(10);
    expect(getWorktreeFirstSeenAt(path, 'workspace:two')).toBe(20);
  });
});
