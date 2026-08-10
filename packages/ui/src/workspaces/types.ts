/**
 * Shared workspace types: the renderer's mirror of the control plane's
 * Workspace Catalog contract. The server schema lives in
 * packages/web/server/lib/workspaces/catalog-schema.js and is guaranteed to
 * match by contract tests.
 *
 * Product invariants (enforced across the codebase):
 * - Workspaces are the only first-class navigation entity; sessions belong to
 *   workspaces. There is no isLocal/isRemote/projectType branch in this model.
 * - Connection kind lives only inside the server Broker layer.
 * - workspaceId is a stable random UUID, never derived from paths/URLs.
 */

export type ConnectionId = string;
export type WorkspaceId = string;
export type WorkspaceSessionKey = string;

export interface ConnectionCapabilities {
  pathBrowse: boolean;
  terminal: boolean;
  files: boolean;
  git: boolean;
  eventStream: boolean;
}

/** Safe to return to a plain browser: no tokens, headers or SSH references. */
export interface ConnectionProfileSummary {
  id: ConnectionId;
  label: string;
  accentColor?: string;
  capabilities: ConnectionCapabilities;
}

export interface WorkspaceDescriptor {
  id: WorkspaceId;
  connectionId: ConnectionId;
  path: string;
  canonicalPath: string;
  label: string;
  color?: string;
  orderKey: string;
  createdAt: number;
  updatedAt: number;
}

export interface WorkspaceCatalogSnapshot {
  schemaVersion: 1;
  revision: number;
  connections: ConnectionProfileSummary[];
  workspaces: WorkspaceDescriptor[];
  migration: {
    legacyProjectsImported: boolean;
    pendingConnectionIds: string[];
  };
}

export interface WorkspaceSessionSummary {
  key: WorkspaceSessionKey;
  workspaceId: WorkspaceId;
  upstreamSessionId: string;
  directory: string;
  title: string;
  updatedAt: number;
  archived: boolean;
  activity?: 'idle' | 'busy' | 'waiting';
}

export interface SourceFreshness {
  complete: boolean;
  stale: boolean;
  lastSuccessAt: number | null;
  error: { code: string; message: string } | null;
}

export interface WorkspaceSessionSnapshot {
  revision: number;
  sessions: WorkspaceSessionSummary[];
  freshnessByConnection: Record<ConnectionId, SourceFreshness>;
}

export type WorkspaceSessionEvent = {
  revision: number;
  connectionId: ConnectionId;
  workspaceId: WorkspaceId;
  sessionId: string;
  type: 'session.upserted' | 'session.removed' | 'freshness.changed';
  payload: unknown;
};

/** Composite navigation target used by every session-open surface. */
export interface WorkspaceSessionTarget {
  workspaceId: WorkspaceId;
  sessionId: string;
}

export interface WorkspaceCreateInput {
  connectionId: ConnectionId;
  path: string;
  label?: string;
  color?: string;
}

export interface WorkspaceUpdateInput {
  label?: string;
  color?: string | null;
  orderKey?: string;
}

export interface CatalogMutationResult {
  workspace: WorkspaceDescriptor;
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
