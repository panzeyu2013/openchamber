import { createControlPlaneFetch } from './control-plane-fetch';
import {
  CatalogClientError,
  type CatalogMutationResult,
  type ConnectionProfileSummary,
  type ProjectCapabilities,
  type ProjectCatalogSnapshot,
  type ProjectCreateInput,
  type ProjectDescriptor,
  type ProjectUpdateInput,
} from './types';

/**
 * Project Catalog client. All requests go to the LOCAL CONTROL PLANE (the
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

export const fetchCatalogSnapshot = async (): Promise<ProjectCatalogSnapshot> => {
  const body = await jsonRequest('/api/projects', { headers: { accept: 'application/json' } });
  if (!body || typeof body !== 'object' || !Array.isArray((body as ProjectCatalogSnapshot).projects)) {
    throw new CatalogClientError('Catalog response has an invalid shape', 500, 'catalog_invalid_response');
  }
  return body as ProjectCatalogSnapshot;
};

/** Reads the server capability flags (plan §20). This route STAYS available
 * when the catalog is disabled, so the client can detect the state and switch
 * the unified sidebar to its read-only degradation mode. Any failure (old
 * server, transient error, control plane unavailable) surfaces as
 * CatalogClientError; callers treat unknown as enabled, never as disabled. */
export const fetchProjectCapabilities = async (): Promise<ProjectCapabilities> => {
  const body = await jsonRequest('/api/projects/capabilities', { headers: { accept: 'application/json' } });
  if (!body || typeof body !== 'object' || typeof (body as ProjectCapabilities).projectCatalogV1 !== 'boolean') {
    throw new CatalogClientError('Capabilities response has an invalid shape', 500, 'catalog_invalid_response');
  }
  return body as ProjectCapabilities;
};

export const fetchConnections = async (): Promise<ConnectionProfileSummary[]> => {
  const body = await jsonRequest('/api/connections');
  const connections = body && typeof body === 'object' ? (body as { connections?: unknown }).connections : null;
  if (!Array.isArray(connections)) {
    throw new CatalogClientError('Connections response has an invalid shape', 500, 'catalog_invalid_response');
  }
  return connections as ConnectionProfileSummary[];
};

export const createProject = async (input: ProjectCreateInput): Promise<CatalogMutationResult> => {
  const body = await jsonRequest('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const result = body as CatalogMutationResult;
  if (!result?.project || typeof result.revision !== 'number') {
    throw new CatalogClientError('Create project response has an invalid shape', 500, 'catalog_invalid_response');
  }
  return result;
};

export const updateProject = async (
  projectId: string,
  patch: ProjectUpdateInput,
  ifMatchRevision: number,
): Promise<{ project: ProjectDescriptor; revision: number }> => {
  const body = await jsonRequest(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'if-match': String(ifMatchRevision),
    },
    body: JSON.stringify(patch),
  });
  const result = body as { project?: ProjectDescriptor; revision?: number };
  if (!result?.project || typeof result.revision !== 'number') {
    throw new CatalogClientError('Update project response has an invalid shape', 500, 'catalog_invalid_response');
  }
  return { project: result.project, revision: result.revision };
};

export const deleteProject = async (projectId: string, ifMatchRevision: number): Promise<number> => {
  const body = await jsonRequest(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: 'DELETE',
    headers: { 'if-match': String(ifMatchRevision) },
  });
  const revision = body && typeof body === 'object' ? (body as { revision?: unknown }).revision : null;
  if (typeof revision !== 'number') {
    throw new CatalogClientError('Delete project response has an invalid shape', 500, 'catalog_invalid_response');
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

export interface ProjectProbeResult {
  ok: boolean;
  canonicalPath: string | null;
  capabilities?: { pathBrowse: boolean; terminal: boolean; files: boolean; git: boolean; eventStream: boolean };
  error?: { code: string; message: string };
  authRequired?: boolean;
}

export const probeProject = async (projectId: string): Promise<ProjectProbeResult> => {
  const body = await jsonRequest(`/api/projects/${encodeURIComponent(projectId)}/probe`, { method: 'POST' });
  if (!body || typeof body !== 'object') {
    throw new CatalogClientError('Probe response has an invalid shape', 500, 'catalog_invalid_response');
  }
  return body as ProjectProbeResult;
};

export interface ConnectionProbeResult {
  ok: boolean;
  /** Round-trip time of the probe request (ms). */
  latencyMs?: number;
  error?: { code: string; message: string };
  authRequired?: boolean;
}

export const probeConnection = async (connectionId: string): Promise<ConnectionProbeResult> => {
  const startedAt = Date.now();
  const body = await jsonRequest(`/api/connections/${encodeURIComponent(connectionId)}/probe`, { method: 'POST' });
  const latencyMs = Math.max(0, Date.now() - startedAt);
  if (!body || typeof body !== 'object') {
    throw new CatalogClientError('Probe response has an invalid shape', 500, 'catalog_invalid_response');
  }
  const probe = body as ProjectProbeResult;
  return {
    ok: probe.ok === true,
    ...(Number.isFinite(latencyMs) ? { latencyMs } : {}),
    ...(probe.error ? { error: probe.error } : {}),
    ...(probe.authRequired === true ? { authRequired: true } : {}),
  };
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

export const listProjectChildren = async (projectId: string, directory: string): Promise<BrowseResult> => {
  const body = await jsonRequest(
    `/api/projects/${encodeURIComponent(projectId)}/children?path=${encodeURIComponent(directory)}`,
  );
  if (!body || typeof body !== 'object' || !Array.isArray((body as BrowseResult).children)) {
    throw new CatalogClientError('Browse response has an invalid shape', 500, 'catalog_invalid_response');
  }
  return body as BrowseResult;
};

/** Connection-scoped browse used by the Add Project dialog before the
 * project exists. The control plane canonicalizes and validates the path. */
export const listConnectionChildren = async (connectionId: string, directory: string): Promise<BrowseResult> => {
  const body = await jsonRequest(
    `/api/connections/${encodeURIComponent(connectionId)}/children?path=${encodeURIComponent(directory)}`,
  );
  if (!body || typeof body !== 'object' || !Array.isArray((body as BrowseResult).children)) {
    throw new CatalogClientError('Browse response has an invalid shape', 500, 'catalog_invalid_response');
  }
  return body as BrowseResult;
};
