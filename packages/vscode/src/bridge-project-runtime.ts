import { normalizeWindowsDriveLetter } from './pathUtils';
import type { WorkspaceFolderCandidate } from './workspaceResolver';

/**
 * VS Code bridge runtime for project identity.
 *
 * The unified project model requires the CURRENT VS Code folder(s) to resolve
 * to a stable project descriptor: a `ProjectDescriptor` carrying a stable
 * random-UUID `projectId` from the OpenChamber control plane (Project
 * Catalog). The webview consumes the shared catalog types
 * (`@openchamber/ui/projects/types`); this runtime is the extension-host side
 * of that contract.
 *
 * The extension host reads the catalog from the configured control plane
 * (`openchamber.apiUrl`, resolved by the bridge wiring in `bridge.ts`):
 * `fetchControlPlaneCatalogProjects` GETs `{origin}/api/projects` using
 * the same authenticated-fetch shape as every other host->server request
 * (`Accept: application/json` plus the manager's auth headers) and maps the
 * server's catalog snapshot to the shared `ProjectDescriptor` shape. It
 * returns `null` ONLY for a genuine unreachable-control-plane condition (no
 * origin configured, network failure, non-2xx, or a response that is not a
 * catalog snapshot) — never for an empty catalog, which is a real
 * authoritative state. The resolution NEVER fabricates an identity: `null`
 * makes the bridge answer an explicit deterministic `capability_unavailable`
 * state (`code: 'capability_unavailable'`,
 * `reason: 'control_plane_unavailable'`) instead of falling back to a
 * path-derived project identity as the authoritative identity.
 * `matchFolderToCatalogProject` below is the matching logic the seam
 * drives, and its input types mirror the shared `ProjectDescriptor`
 * contract.
 */

/**
 * Structural mirror of `ProjectDescriptor` from
 * `packages/ui/src/projects/types.ts`. The extension host cannot import
 * `@openchamber/ui` (no path mapping in the host tsconfig/build); the webview
 * wrapper in `webview/api/projects.ts` types the same payload with the real
 * shared type, which is the contract. Keep every field name in sync with the
 * shared type when either side changes.
 */
export interface ProjectDescriptorLike {
  id: string;
  connectionId: string;
  path: string;
  canonicalPath: string;
  label: string;
  color?: string;
  orderKey: string;
  createdAt: number;
  updatedAt: number;
}

export type ProjectBridgeDeps = {
  readWorkspaceFolders: () => WorkspaceFolderCandidate[];
  /** Control-plane catalog snapshot, or `null` when no control plane is
   * configured or reachable in this runtime. `null` is distinct from an empty
   * catalog: the former reports `capability_unavailable`, the latter
   * `not_found`. */
  fetchCatalogProjects: () => Promise<ProjectDescriptorLike[] | null>;
};

/** Injectable fetch shape for the catalog read: the implementation only ever
 * requests absolute HTTP(S) URLs, so callers can stub with a plain
 * `(url, init) => Promise<Response>` without widening to `typeof fetch`. */
export type ControlPlaneCatalogFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface ControlPlaneCatalogFetchOptions {
  /** Configured control-plane origin (`openchamber.apiUrl`), or `null` when
   * no control plane is configured. `null` answers `capability_unavailable`
   * without touching the network. */
  origin: string | null;
  /** Auth headers for the target server, spread after the base headers —
   * mirrors every other host->server fetch. */
  authHeaders?: Record<string, string>;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchImpl?: ControlPlaneCatalogFetch;
  /** Abort timeout for the catalog read, mirroring host API fetch timeouts. */
  timeoutMs?: number;
}

const CATALOG_FETCH_TIMEOUT_MS = 8000;

/**
 * Normalize one catalog entry into the structural mirror of
 * `ProjectDescriptor`. Entries that fail the same required-field validation
 * the server applies (`catalog-schema.js`) are dropped, never guessed at.
 */
const normalizeCatalogDescriptor = (value: unknown): ProjectDescriptorLike | null => {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  const id = typeof entry.id === 'string' ? entry.id.trim() : '';
  const connectionId = typeof entry.connectionId === 'string' ? entry.connectionId.trim() : '';
  const path = typeof entry.path === 'string' ? entry.path.trim() : '';
  const canonicalPath = typeof entry.canonicalPath === 'string' ? entry.canonicalPath.trim() : '';
  const label = typeof entry.label === 'string' ? entry.label.trim() : '';
  if (!id || !connectionId || !path || !canonicalPath || !label) return null;
  const color = typeof entry.color === 'string' && entry.color.trim().length > 0 ? entry.color.trim() : undefined;
  const orderKey = typeof entry.orderKey === 'string' ? entry.orderKey : '';
  const createdAt = typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt) && entry.createdAt >= 0
    ? entry.createdAt
    : 0;
  const updatedAt = typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt) && entry.updatedAt >= 0
    ? entry.updatedAt
    : 0;
  return {
    id,
    connectionId,
    path,
    canonicalPath,
    label,
    ...(color ? { color } : {}),
    orderKey,
    createdAt,
    updatedAt,
  };
};

/**
 * Fetch the Project Catalog snapshot from the configured control plane.
 *
 * GETs `{origin}/api/projects` with the same auth shape every other
 * host->server request uses (`Accept: application/json` plus `authHeaders`,
 * which the bridge wiring takes from `OpenCodeManager.getOpenCodeAuthHeaders`).
 * The server answers with `ProjectCatalogSnapshot`; the `projects` array
 * is mapped to the shared `ProjectDescriptor` shape.
 *
 * Returns `null` ONLY when the control plane is genuinely unreachable: no
 * origin configured, network/parse failure, non-2xx, or a payload that is not
 * a catalog snapshot. Never throws; an empty catalog is returned as `[]` so
 * the bridge can distinguish `not_found` from `capability_unavailable`.
 */
export const fetchControlPlaneCatalogProjects = async (
  options: ControlPlaneCatalogFetchOptions,
): Promise<ProjectDescriptorLike[] | null> => {
  const { origin, authHeaders, timeoutMs = CATALOG_FETCH_TIMEOUT_MS } = options;
  if (!origin) {
    return null;
  }
  const base = origin.endsWith('/') ? origin : `${origin}/`;
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));

  let response: Response;
  try {
    response = await fetchImpl(new URL('api/projects', base).toString(), {
      method: 'GET',
      headers: { Accept: 'application/json', ...(authHeaders || {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return null;
  }

  if (!response.ok) {
    return null;
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const projects = (payload as Record<string, unknown>).projects;
  if (!Array.isArray(projects)) {
    return null;
  }

  const catalog: ProjectDescriptorLike[] = [];
  for (const entry of projects) {
    const descriptor = normalizeCatalogDescriptor(entry);
    if (descriptor) {
      catalog.push(descriptor);
    }
  }
  return catalog;
};

type BridgeMessageInput = {
  id: string;
  type: string;
  payload?: unknown;
};

type BridgeResponse = {
  id: string;
  type: string;
  success: boolean;
  data?: unknown;
  error?: string;
};

/** Normalize a path for folder-vs-canonicalPath comparison: forward slashes,
 * trailing separators stripped (root preserved), Windows drive letter
 * uppercased (matches `normalizeWindowsDriveLetter` used by the folder
 * resolver and the server's canonicalPath normalization). */
export const normalizePathForMatch = (value: string): string => {
  const replaced = normalizeWindowsDriveLetter(value).replace(/\\/g, '/');
  if (replaced === '/') return '/';
  return replaced.replace(/\/+$/, '');
};

/**
 * Resolve the current VS Code folder set to a catalog project descriptor.
 *
 * Matching mirrors the legacy folder-bridge precedence: the active folder
 * (when provided and present in the folder set) wins, otherwise the first
 * folder matches. A match requires the normalized folder path to equal a
 * project's normalized `canonicalPath`. The function is pure: connection
 * filtering and snapshot transport belong to the control-plane proxy.
 *
 * Returns `null` when no folder matches the catalog.
 */
export const matchFolderToCatalogProject = (
  folders: WorkspaceFolderCandidate[],
  activePath: string | null,
  catalogProjects: ProjectDescriptorLike[],
): { project: ProjectDescriptorLike; folder: WorkspaceFolderCandidate } | null => {
  const byCanonicalPath = new Map<string, ProjectDescriptorLike>();
  for (const project of catalogProjects) {
    if (typeof project.canonicalPath !== 'string' || project.canonicalPath.length === 0) continue;
    const canonical = normalizePathForMatch(project.canonicalPath);
    if (!byCanonicalPath.has(canonical)) {
      byCanonicalPath.set(canonical, project);
    }
  }

  const pick = (folder: WorkspaceFolderCandidate) => byCanonicalPath.get(normalizePathForMatch(folder.path));

  if (activePath) {
    const activeFolder = folders.find((folder) => normalizePathForMatch(folder.path) === normalizePathForMatch(activePath)) ?? null;
    const activeMatch = activeFolder ? pick(activeFolder) : null;
    if (activeFolder && activeMatch) {
      return { project: activeMatch, folder: activeFolder };
    }
  }

  for (const folder of folders) {
    const match = pick(folder);
    if (match) {
      return { project: match, folder };
    }
  }

  return null;
};

const normalizeOptionalPath = (value: unknown): string | null => (
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
);

export async function handleProjectBridgeMessage(
  message: BridgeMessageInput,
  deps: ProjectBridgeDeps,
): Promise<BridgeResponse | null> {
  const { id, type, payload } = message;

  switch (type) {
    case 'api:workspace:descriptor:get': {
      const { activePath } = (payload || {}) as { activePath?: unknown };
      const normalizedActivePath = normalizeOptionalPath(activePath);
      const folders = deps.readWorkspaceFolders();

      if (folders.length === 0) {
        return {
          id,
          type,
          success: true,
          data: { status: 'no_folder', workspaceFolders: [], activePath: null },
        };
      }

      const catalogProjects = await deps.fetchCatalogProjects();
      if (catalogProjects === null) {
        return {
          id,
          type,
          success: true,
          data: {
            status: 'capability_unavailable',
            code: 'capability_unavailable',
            reason: 'control_plane_unavailable',
            workspaceFolders: folders,
            activePath: normalizedActivePath,
          },
        };
      }

      const match = matchFolderToCatalogProject(folders, normalizedActivePath, catalogProjects);
      if (!match) {
        return {
          id,
          type,
          success: true,
          data: {
            status: 'not_found',
            workspaceFolders: folders,
            activePath: normalizedActivePath,
          },
        };
      }

      return {
        id,
        type,
        success: true,
        data: {
          status: 'available',
          projectId: match.project.id,
          project: match.project,
          activePath: match.folder.path,
        },
      };
    }

    default:
      return null;
  }
}
