import { createControlPlaneFetch } from './control-plane-fetch';
import {
  CatalogClientError,
  type CatalogMutationResult,
  type ConnectionProfileSummary,
  type WorkspaceCatalogSnapshot,
  type WorkspaceCreateInput,
  type WorkspaceDescriptor,
  type WorkspaceUpdateInput,
} from './types';

/**
 * Workspace Catalog client. All requests go to the LOCAL CONTROL PLANE (the
 * OpenChamber instance that served the UI), pinned via a control-plane fetch —
 * NEVER to a remote runtime URL and never following the Active Runtime. The
 * control plane resolves connectionIds into adapters server-side. Mutation
 * responses carry the new catalog revision; a 409 `catalog_revision_conflict`
 * surfaces as CatalogClientError so the caller can re-fetch the snapshot and
 * replay the user action.
 */

const controlPlaneFetch = createControlPlaneFetch();

const isJsonOk = async (response: Response): Promise<unknown> => {
  if (!response.ok) {
    let code = 'catalog_http_error';
    let message = `Request failed with status ${response.status}`;
    try {
      const body = await response.json();
      if (body && typeof body === 'object') {
        if (typeof body.error === 'string') message = body.error;
        if (typeof body.code === 'string') code = body.code;
      }
    } catch {
      // non-JSON error body; keep the status-based message
    }
    throw new CatalogClientError(message, response.status, code);
  }
  return response.json();
};

const jsonRequest = async (path: string, init?: RequestInit): Promise<unknown> => {
  const response = await controlPlaneFetch(path, init);
  return isJsonOk(response);
};

export const fetchCatalogSnapshot = async (): Promise<WorkspaceCatalogSnapshot> => {
  const body = await jsonRequest('/api/workspaces', { headers: { accept: 'application/json' } });
  if (!body || typeof body !== 'object' || !Array.isArray((body as WorkspaceCatalogSnapshot).workspaces)) {
    throw new CatalogClientError('Catalog response has an invalid shape', 500, 'catalog_invalid_response');
  }
  return body as WorkspaceCatalogSnapshot;
};

export const fetchConnections = async (): Promise<ConnectionProfileSummary[]> => {
  const body = await jsonRequest('/api/connections');
  const connections = body && typeof body === 'object' ? (body as { connections?: unknown }).connections : null;
  if (!Array.isArray(connections)) {
    throw new CatalogClientError('Connections response has an invalid shape', 500, 'catalog_invalid_response');
  }
  return connections as ConnectionProfileSummary[];
};

export const createWorkspace = async (input: WorkspaceCreateInput): Promise<CatalogMutationResult> => {
  const body = await jsonRequest('/api/workspaces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const result = body as CatalogMutationResult;
  if (!result?.workspace || typeof result.revision !== 'number') {
    throw new CatalogClientError('Create workspace response has an invalid shape', 500, 'catalog_invalid_response');
  }
  return result;
};

export const updateWorkspace = async (
  workspaceId: string,
  patch: WorkspaceUpdateInput,
  ifMatchRevision: number,
): Promise<{ workspace: WorkspaceDescriptor; revision: number }> => {
  const body = await jsonRequest(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'if-match': String(ifMatchRevision),
    },
    body: JSON.stringify(patch),
  });
  const result = body as { workspace?: WorkspaceDescriptor; revision?: number };
  if (!result?.workspace || typeof result.revision !== 'number') {
    throw new CatalogClientError('Update workspace response has an invalid shape', 500, 'catalog_invalid_response');
  }
  return { workspace: result.workspace, revision: result.revision };
};

export const deleteWorkspace = async (workspaceId: string, ifMatchRevision: number): Promise<number> => {
  const body = await jsonRequest(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
    method: 'DELETE',
    headers: { 'if-match': String(ifMatchRevision) },
  });
  const revision = body && typeof body === 'object' ? (body as { revision?: unknown }).revision : null;
  if (typeof revision !== 'number') {
    throw new CatalogClientError('Delete workspace response has an invalid shape', 500, 'catalog_invalid_response');
  }
  return revision;
};

export interface ConnectionCreateInput {
  label: string;
  baseUrl: string;
  clientToken?: string;
}

export interface ConnectionUpdateInput {
  label?: string;
  baseUrl?: string;
  clientToken?: string;
}

export const createConnection = async (input: ConnectionCreateInput): Promise<ConnectionProfileSummary> => {
  const body = await jsonRequest('/api/connections', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const connection = body && typeof body === 'object' ? (body as { connection?: ConnectionProfileSummary }).connection : null;
  if (!connection) {
    throw new CatalogClientError('Create connection response has an invalid shape', 500, 'catalog_invalid_response');
  }
  return connection;
};

export const updateConnection = async (
  connectionId: string,
  patch: ConnectionUpdateInput,
): Promise<ConnectionProfileSummary> => {
  const body = await jsonRequest(`/api/connections/${encodeURIComponent(connectionId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const connection = body && typeof body === 'object' ? (body as { connection?: ConnectionProfileSummary }).connection : null;
  if (!connection) {
    throw new CatalogClientError('Update connection response has an invalid shape', 500, 'catalog_invalid_response');
  }
  return connection;
};

export const deleteConnection = async (connectionId: string): Promise<void> => {
  await jsonRequest(`/api/connections/${encodeURIComponent(connectionId)}`, { method: 'DELETE' });
};

export interface WorkspaceProbeResult {
  ok: boolean;
  canonicalPath: string | null;
  capabilities?: { pathBrowse: boolean; terminal: boolean; files: boolean; git: boolean; eventStream: boolean };
  error?: { code: string; message: string };
}

export const probeWorkspace = async (workspaceId: string): Promise<WorkspaceProbeResult> => {
  const body = await jsonRequest(`/api/workspaces/${encodeURIComponent(workspaceId)}/probe`, { method: 'POST' });
  if (!body || typeof body !== 'object') {
    throw new CatalogClientError('Probe response has an invalid shape', 500, 'catalog_invalid_response');
  }
  return body as WorkspaceProbeResult;
};

export const probeConnection = async (connectionId: string): Promise<WorkspaceProbeResult> => {
  const body = await jsonRequest(`/api/connections/${encodeURIComponent(connectionId)}/probe`, { method: 'POST' });
  if (!body || typeof body !== 'object') {
    throw new CatalogClientError('Probe response has an invalid shape', 500, 'catalog_invalid_response');
  }
  return body as WorkspaceProbeResult;
};

export interface BrowseChild {
  name: string;
  path: string;
  kind: 'directory' | 'file' | 'other';
}

export interface BrowseResult {
  directory: string;
  children: BrowseChild[];
}

export const listWorkspaceChildren = async (workspaceId: string, directory: string): Promise<BrowseResult> => {
  const body = await jsonRequest(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/children?path=${encodeURIComponent(directory)}`,
  );
  if (!body || typeof body !== 'object' || !Array.isArray((body as BrowseResult).children)) {
    throw new CatalogClientError('Browse response has an invalid shape', 500, 'catalog_invalid_response');
  }
  return body as BrowseResult;
};

/** Connection-scoped browse used by the Add Workspace dialog before the
 * workspace exists. The control plane canonicalizes and validates the path. */
export const listConnectionChildren = async (connectionId: string, directory: string): Promise<BrowseResult> => {
  const body = await jsonRequest(
    `/api/connections/${encodeURIComponent(connectionId)}/children?path=${encodeURIComponent(directory)}`,
  );
  if (!body || typeof body !== 'object' || !Array.isArray((body as BrowseResult).children)) {
    throw new CatalogClientError('Browse response has an invalid shape', 500, 'catalog_invalid_response');
  }
  return body as BrowseResult;
};
