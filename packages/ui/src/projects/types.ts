/**
 * Shared project types: the renderer's mirror of the control plane's
 * Project Catalog contract. The server schema lives in
 * packages/web/server/lib/projects/catalog-schema.js and is guaranteed to
 * match by contract tests.
 *
 * Product invariants (enforced across the codebase):
 * - Projects are the only first-class navigation entity; sessions belong to
 *   projects. There is no isLocal/isRemote/projectType branch in this model.
 * - Connection kind is a NON-SENSITIVE tag in the public summary; the full
 *   private target (baseUrl, credentials, SSH/relay ids) lives only in the
 *   server Broker layer and is never projected.
 * - projectId is a stable random UUID, never derived from paths/URLs.
 */

export type ConnectionId = string;
export type ProjectId = string;
export type ProjectSessionKey = string;

export interface ConnectionCapabilities {
  pathBrowse: boolean;
  terminal: boolean;
  files: boolean;
  git: boolean;
  eventStream: boolean;
}

/** Server capability flags (plan §20), read from
 * `GET /api/projects/capabilities`. `projectCatalogV1: false` means the
 * operator disabled the catalog: the unified sidebar shows its read-only
 * degradation state and must not attempt catalog/session-index mutations.
 * Unknown (`null` in the store) is treated as enabled — only an
 * authoritative `false` disables the surface. */
export interface ProjectCapabilities {
  projectCatalogV1: boolean;
}

/** Safe to return to a plain browser: no tokens, headers or SSH references. */
export interface ConnectionProfileSummary {
  id: ConnectionId;
  label: string;
  accentColor?: string;
  /** Connection kind ('local'|'direct'|'ssh'|'relay') recorded server-side in
   * the profile target. Non-sensitive; omitted when the server omits it
   * (missing/illegal kinds, or older servers). Drives typed UI operations per
   * connection type. */
  kind?: 'local' | 'direct' | 'ssh' | 'relay';
  capabilities: ConnectionCapabilities;
  /** Epoch ms of the last successful live probe (server-recorded). Absent
   * when the connection never connected successfully. */
  lastProbeOkAt?: number;
}

export interface ProjectDescriptor {
  id: ProjectId;
  connectionId: ConnectionId;
  path: string;
  canonicalPath: string;
  label: string;
  color?: string;
  orderKey: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectCatalogSnapshot {
  schemaVersion: 1;
  revision: number;
  connections: ConnectionProfileSummary[];
  projects: ProjectDescriptor[];
  migration: {
    legacyProjectsImported: boolean;
    pendingConnectionIds: string[];
  };
}

export interface ProjectSessionSummary {
  key: ProjectSessionKey;
  projectId: ProjectId;
  connectionId: ConnectionId;
  upstreamSessionId: string;
  directory: string;
  title: string;
  updatedAt: number;
  archived: boolean;
  activity?: 'idle' | 'busy' | 'waiting';
  /** Parent session (subagent delegation) of the upstream session, when the
   * server reports one. Kept so sidebar trees can group child sessions
   * without holding full Session objects. */
  parentID?: string | null;
  /** Upstream `time.created` (epoch ms). Ordering baselines freeze on
   * creation time for pinned sessions, so summaries must carry it. */
  createdAt: number;
}

export interface SourceFreshness {
  complete: boolean;
  /** The source responded successfully, but the bounded page walk was not
   * exhaustive. Partial data must not be interpreted as deletion. */
  partial?: boolean;
  /** No successful snapshot has ever been received for this connection. */
  offline?: boolean;
  stale: boolean;
  lastSuccessAt: number | null;
  error: { code: string; message: string } | null;
}

export interface ProjectSessionSnapshot {
  revision: number;
  sessions: ProjectSessionSummary[];
  freshnessByConnection: Record<ConnectionId, SourceFreshness>;
  /** Per-connection flag: the upstream session list hit the server's
   * snapshot limit, so `sessions` is a partial view and must never be
   * treated as the authoritative full set. */
  truncatedByConnection?: Record<ConnectionId, boolean>;
}

export type ProjectSessionEvent = {
  revision: number;
  connectionId: ConnectionId;
  projectId: ProjectId;
  sessionId: string;
  type: 'session.upserted' | 'session.removed' | 'freshness.changed';
  payload: unknown;
};

/** Composite navigation target used by every session-open surface. */
export interface ProjectSessionTarget {
  projectId: ProjectId;
  sessionId: string;
}

export interface ProjectCreateInput {
  connectionId: ConnectionId;
  path: string;
  label?: string;
  color?: string;
}

export interface ProjectUpdateInput {
  label?: string;
  color?: string | null;
  orderKey?: string;
}

export interface CatalogMutationResult {
  project: ProjectDescriptor;
  revision: number;
  created: boolean;
}

/** Typed failure thrown by the catalog client; carries the HTTP code. */
export class CatalogClientError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'CatalogClientError';
    this.status = status;
    this.code = code;
  }
}
