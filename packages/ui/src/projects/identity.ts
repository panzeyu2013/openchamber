import type { ProjectId } from './types';

/**
 * Project identity helpers — the renderer mirror of
 * packages/web/server/lib/projects/project-identity.js. The two files
 * must stay byte-compatible; contract tests cover slashes, unicode, identical
 * paths across connections and identical session IDs.
 */

/** Legacy scope-key prefix written by builds before the workspace→project
 * rename (P-MIG). New code only writes `project:`; readers must recognize
 * both prefixes so persisted user data never disappears. */
export const LEGACY_WORKSPACE_SCOPE_PREFIX = 'workspace:';
export const PROJECT_SCOPE_PREFIX = 'project:';

/** Scopes client caches and sync to a single project. */
export const projectScopeKey = (projectId: ProjectId): string => `${PROJECT_SCOPE_PREFIX}${projectId}`;

/** The legacy `workspace:`-prefixed variant of a `project:` scope key, or
 * null when the key was not written with the current prefix. Used by
 * persisted-data reads that must recognize pre-rename keys. */
export const legacyScopeKeyForProjectKey = (scopeKey: string): string | null => {
  if (typeof scopeKey !== 'string' || !scopeKey.startsWith(PROJECT_SCOPE_PREFIX)) return null;
  const projectId = scopeKey.slice(PROJECT_SCOPE_PREFIX.length);
  return projectId.length > 0 ? `${LEGACY_WORKSPACE_SCOPE_PREFIX}${projectId}` : null;
};

/** Inverse of `projectScopeKey`: returns the project id when the value is a
 * project scope key — recognizing the legacy `workspace:` prefix (P-MIG) —
 * or null for ambient (runtime-keyed) scopes. */
export const projectIdFromScopeKey = (scopeKey: string): ProjectId | null => {
  if (typeof scopeKey !== 'string') return null;
  if (scopeKey.startsWith(PROJECT_SCOPE_PREFIX)) {
    const projectId = scopeKey.slice(PROJECT_SCOPE_PREFIX.length);
    return projectId.length > 0 ? projectId : null;
  }
  if (scopeKey.startsWith(LEGACY_WORKSPACE_SCOPE_PREFIX)) {
    const projectId = scopeKey.slice(LEGACY_WORKSPACE_SCOPE_PREFIX.length);
    return projectId.length > 0 ? projectId : null;
  }
  return null;
};

/** Global session identity: (projectId, upstreamSessionId). The NUL
 * separator keeps composite keys unambiguous when either part contains
 * slashes or unicode. */
export const projectSessionKey = (
  projectId: ProjectId,
  upstreamSessionId: string,
): string => `${projectId}\0${upstreamSessionId}`;

export const parseProjectSessionKey = (key: string): { projectId: ProjectId; upstreamSessionId: string } | null => {
  if (typeof key !== 'string') return null;
  const separator = key.indexOf('\0');
  if (separator <= 0 || separator === key.length - 1) return null;
  return { projectId: key.slice(0, separator), upstreamSessionId: key.slice(separator + 1) };
};
