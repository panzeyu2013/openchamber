import type { Session } from '@opencode-ai/sdk/v2';
import { normalizePath } from '@/lib/pathNormalization';

/**
 * Normalized directory of a session record: the record's own `directory`,
 * falling back to the project worktree path. Never returns a guessed or
 * persisted-elsewhere value — this is a pure record projection, not the
 * send-routing resolution in `sync/session-directory-resolution.ts`.
 */
export const resolveSessionDirectory = (session: Session): string | null => {
  const record = session as Session & {
    directory?: string | null;
    project?: { worktree?: string | null } | null;
  };
  return normalizePath(record.directory ?? null)
    ?? normalizePath(record.project?.worktree ?? null);
};

/**
 * Merge a session record with the cached version, preserving stable raw
 * directory metadata when the incoming payload omits it (some live session
 * updates omit directory/project fields; without the merge, project grouping
 * would temporarily lose the session).
 */
export const mergeSessionDirectoryMetadata = (incoming: Session, existing?: Session | null): Session => {
  if (!existing) {
    return incoming;
  }

  const incomingRecord = incoming as Session & {
    directory?: string | null;
    project?: ({ worktree?: string | null } & Record<string, unknown>) | null;
  };
  const existingRecord = existing as Session & {
    directory?: string | null;
    project?: ({ worktree?: string | null } & Record<string, unknown>) | null;
  };

  const incomingDirectory = normalizePath(incomingRecord.directory ?? null);
  const incomingWorktree = normalizePath(incomingRecord.project?.worktree ?? null);
  const existingDirectory = normalizePath(existingRecord.directory ?? null);
  const existingWorktree = normalizePath(existingRecord.project?.worktree ?? null);

  let changed = false;
  const next: typeof incomingRecord = { ...incomingRecord };

  if (!incomingDirectory && existingDirectory) {
    next.directory = existingRecord.directory;
    changed = true;
  }

  if (!incomingWorktree && existingWorktree) {
    next.project = {
      ...(existingRecord.project ?? {}),
      ...(incomingRecord.project ?? {}),
      worktree: existingRecord.project?.worktree,
    };
    changed = true;
  } else if (!incomingRecord.project && existingRecord.project) {
    next.project = existingRecord.project;
    changed = true;
  }

  return changed ? next : incoming;
};
