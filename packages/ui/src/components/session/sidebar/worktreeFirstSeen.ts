import { normalizePath } from './utils';

// In-memory first-seen tracker for worktree directories. Worktree metadata
// carries no creation time, so we record when a path first appears during
// this app run: a worktree created mid-session sorts to the top of its
// project's empty-worktree tail, while everything discovered at startup ties
// (same tick) and falls back to alphabetical order. The scope is part of the
// key because two workspace connections may expose the same path.
const firstSeenAtByScopePath = new Map<string, number>();

const makeKey = (scopeKey: string, path: string): string => `${scopeKey}\u0000${path}`;

export const recordWorktreesSeen = (
  paths: Iterable<string | null | undefined>,
  seenAt: number,
  scopeKey = 'legacy',
): void => {
  for (const path of paths) {
    const normalized = normalizePath(path ?? null);
    const key = normalized ? makeKey(scopeKey, normalized) : '';
    if (key && !firstSeenAtByScopePath.has(key)) {
      firstSeenAtByScopePath.set(key, seenAt);
    }
  }
};

export const getWorktreeFirstSeenAt = (path: string | null | undefined, scopeKey = 'legacy'): number => {
  const normalized = normalizePath(path ?? null);
  return normalized ? (firstSeenAtByScopePath.get(makeKey(scopeKey, normalized)) ?? 0) : 0;
};
