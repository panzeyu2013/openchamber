import { describe, expect, test } from 'bun:test';
import { getWorktreeFirstSeenAt, recordWorktreesSeen } from './worktreeFirstSeen';

describe('worktree first-seen ordering', () => {
  test('keeps equal paths isolated by project scope', () => {
    const path = '/project/shared-worktree-scope-test';

    recordWorktreesSeen([path], 10, 'project:one');
    recordWorktreesSeen([path], 20, 'project:two');
    recordWorktreesSeen([path], 30, 'project:one');

    expect(getWorktreeFirstSeenAt(path, 'project:one')).toBe(10);
    expect(getWorktreeFirstSeenAt(path, 'project:two')).toBe(20);
  });
});
