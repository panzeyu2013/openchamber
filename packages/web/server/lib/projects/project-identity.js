import { randomUUID } from 'node:crypto';

/**
 * Project identity helpers. These functions are the ONLY place allowed to
 * encode project/session scope keys so renderer caches, server stores and
 * tests stay in lock-step. The renderer mirrors these helpers in
 * `packages/ui/src/projects/identity.ts`; the two files must stay
 * byte-compatible (covered by contract tests).
 */

/** Project and connection IDs are stable random UUIDs, never derived from
 * paths, URLs or server names. */
export const createProjectId = () => randomUUID();

export const createConnectionId = () => randomUUID();

/** Scopes client caches and sync to a single project. */
export const projectScopeKey = (projectId) => `project:${projectId}`;

/** Global session identity: (projectId, upstreamSessionId). The NUL
 * separator keeps composite keys unambiguous when either part contains
 * slashes or unicode. */
export const projectSessionKey = (projectId, upstreamSessionId) => `${projectId}\0${upstreamSessionId}`;

export const parseProjectSessionKey = (key) => {
  if (typeof key !== 'string') return null;
  const separator = key.indexOf('\0');
  if (separator <= 0 || separator === key.length - 1) return null;
  return { projectId: key.slice(0, separator), upstreamSessionId: key.slice(separator + 1) };
};

/** Stable (connectionId, canonicalPath) uniqueness key for projects. */
export const projectLocationKey = (connectionId, canonicalPath) => `${connectionId}\0${canonicalPath}`;

export const isValidProjectId = (value) => (
  typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
);

/** Path comparison is intentionally OUT of this module: canonicalization is a
 * per-connection-adapter concern (the control plane must never apply its own
 * filesystem semantics to remote paths). Adapters return canonical paths; the
 * catalog only ever compares adapter-produced strings exactly. */
export const sameCanonicalPath = (left, right) => left === right;
