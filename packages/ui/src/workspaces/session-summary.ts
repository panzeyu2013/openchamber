import type { Session } from '@opencode-ai/sdk/v2';
import { normalizePath } from '@/lib/pathNormalization';
import type { ConnectionId, WorkspaceSessionSnapshot, WorkspaceSessionSummary } from './types';

/**
 * Session-index consumer surface (legacy full-session surfaces).
 *
 * The Session Index is the cross-workspace authority for session summaries.
 * These helpers are the single entry point for surfaces that previously
 * consumed the retired global sessions store:
 *
 * - Cold lists (sidebar, archive, switchers, mobile sheets) read index
 *   summaries, never a full-session cache.
 * - Surfaces that still render the SDK `Session` shape project summaries
 *   through `sessionFromSummary`: the projection carries exactly the fields
 *   the summary carries and leaves the rest undefined — it never guesses
 *   metadata the index does not know.
 * - Live full-session data for the ACTIVE workspace continues to come from
 *   the workspace runtime handle's SDK (or the live child stores), and
 *   `mergeLiveSessionWithSummary` combines the two without a global store.
 */

export const selectSessionsForConnection = (
  snapshot: WorkspaceSessionSnapshot | null,
  connectionId: ConnectionId,
): WorkspaceSessionSummary[] => (
  snapshot ? snapshot.sessions.filter((session) => session.connectionId === connectionId) : []
);

/**
 * Session-shaped projection of an index summary for legacy surfaces that
 * still render SDK `Session` objects (sidebar nodes, switchers, archive rows).
 * Only fields the index carries are projected; everything else stays absent
 * so no consumer can mistake a projection for a full session record.
 */
export const sessionFromSummary = (summary: WorkspaceSessionSummary): Session => ({
  id: summary.upstreamSessionId,
  slug: '',
  projectID: summary.workspaceId,
  workspaceID: summary.workspaceId,
  directory: summary.directory,
  parentID: summary.parentID ?? undefined,
  title: summary.title,
  version: '',
  time: {
    created: summary.createdAt,
    updated: summary.updatedAt,
    archived: summary.archived ? summary.updatedAt : undefined,
  },
});

/**
 * Merge a live (full) session with its index summary, preserving stable
 * directory/share metadata when the live payload omits it — the index-only
 * successor of the retired global-store merge helpers.
 */
export const mergeLiveSessionWithSummary = (
  liveSession: Session,
  summary: WorkspaceSessionSummary,
): Session => {
  const liveRecord = liveSession as Session & { directory?: string | null };
  const normalizedLive = normalizePath(liveRecord.directory);
  if (normalizedLive || !summary.directory) {
    return liveSession;
  }
  const next = { ...liveSession };
  (next as Session & { directory?: string | null }).directory = summary.directory;
  return next;
};
