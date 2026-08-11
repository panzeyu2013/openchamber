import type { WorkspaceId } from './types';

/**
 * Workspace identity helpers — the renderer mirror of
 * packages/web/server/lib/workspaces/workspace-identity.js. The two files
 * must stay byte-compatible; contract tests cover slashes, unicode, identical
 * paths across connections and identical session IDs.
 */

/** Scopes client caches and sync to a single workspace. */
export const workspaceScopeKey = (workspaceId: WorkspaceId): string => `workspace:${workspaceId}`;

/** Inverse of `workspaceScopeKey`: returns the workspace id when the value is
 * a workspace scope key, or null for ambient (runtime-keyed) scopes. */
export const workspaceIdFromScopeKey = (scopeKey: string): WorkspaceId | null => {
  if (typeof scopeKey !== 'string' || !scopeKey.startsWith('workspace:')) return null;
  const workspaceId = scopeKey.slice('workspace:'.length);
  return workspaceId.length > 0 ? workspaceId : null;
};

/** Global session identity: (workspaceId, upstreamSessionId). The NUL
 * separator keeps composite keys unambiguous when either part contains
 * slashes or unicode. */
export const workspaceSessionKey = (
  workspaceId: WorkspaceId,
  upstreamSessionId: string,
): string => `${workspaceId}\0${upstreamSessionId}`;

export const parseWorkspaceSessionKey = (key: string): { workspaceId: WorkspaceId; upstreamSessionId: string } | null => {
  if (typeof key !== 'string') return null;
  const separator = key.indexOf('\0');
  if (separator <= 0 || separator === key.length - 1) return null;
  return { workspaceId: key.slice(0, separator), upstreamSessionId: key.slice(separator + 1) };
};
