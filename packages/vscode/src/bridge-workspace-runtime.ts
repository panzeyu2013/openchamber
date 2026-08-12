import { normalizeWindowsDriveLetter } from './pathUtils';
import type { WorkspaceFolderCandidate } from './workspaceResolver';

/**
 * VS Code bridge runtime for workspace identity.
 *
 * The unified workspace model (plan §15.6) requires the CURRENT VS Code
 * folder(s) to resolve to a stable workspace descriptor: a
 * `WorkspaceDescriptor` carrying a stable random-UUID `workspaceId` from the
 * OpenChamber control plane (Workspace Catalog). The webview consumes the
 * shared catalog types (`@openchamber/ui/workspaces/types`); this runtime is
 * the extension-host side of that contract.
 *
 * The extension host currently has NO control plane (no OpenChamber server to
 * connect to — `openchamber.apiUrl` addresses an OpenCode API server, not an
 * OpenChamber control plane). The resolution therefore never fabricates an
 * identity: the folder set is resolved and reported, and the bridge answers
 * an explicit deterministic `capability_unavailable` state
 * (`code: 'capability_unavailable'`, `reason: 'control_plane_unavailable'`)
 * instead of falling back to a path-derived project identity as the
 * authoritative identity. A future control-plane proxy (resolving the catalog
 * from `openchamber.apiUrl`) supplies the catalog snapshot through the
 * `fetchCatalogWorkspaces` seam; `matchFolderToCatalogWorkspace` below is the
 * same matching logic that proxy will drive, and its input types mirror the
 * shared `WorkspaceDescriptor` contract.
 */

/**
 * Structural mirror of `WorkspaceDescriptor` from
 * `packages/ui/src/workspaces/types.ts`. The extension host cannot import
 * `@openchamber/ui` (no path mapping in the host tsconfig/build); the webview
 * wrapper in `webview/api/workspaces.ts` types the same payload with the real
 * shared type, which is the contract. Keep every field name in sync with the
 * shared type when either side changes.
 */
export interface WorkspaceDescriptorLike {
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

export type WorkspaceBridgeDeps = {
  readWorkspaceFolders: () => WorkspaceFolderCandidate[];
  /** Control-plane catalog snapshot, or `null` when no control plane is
   * available in this runtime. `null` is distinct from an empty catalog: the
   * former reports `capability_unavailable`, the latter `not_found`. */
  fetchCatalogWorkspaces: () => Promise<WorkspaceDescriptorLike[] | null>;
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
 * Resolve the current VS Code folder set to a catalog workspace descriptor.
 *
 * Matching mirrors the legacy folder-bridge precedence: the active folder
 * (when provided and present in the folder set) wins, otherwise the first
 * folder matches. A match requires the normalized folder path to equal a
 * workspace's normalized `canonicalPath`. The function is pure: connection
 * filtering and snapshot transport belong to the control-plane proxy.
 *
 * Returns `null` when no folder matches the catalog.
 */
export const matchFolderToCatalogWorkspace = (
  folders: WorkspaceFolderCandidate[],
  activePath: string | null,
  catalogWorkspaces: WorkspaceDescriptorLike[],
): { workspace: WorkspaceDescriptorLike; folder: WorkspaceFolderCandidate } | null => {
  const byCanonicalPath = new Map<string, WorkspaceDescriptorLike>();
  for (const workspace of catalogWorkspaces) {
    if (typeof workspace.canonicalPath !== 'string' || workspace.canonicalPath.length === 0) continue;
    const canonical = normalizePathForMatch(workspace.canonicalPath);
    if (!byCanonicalPath.has(canonical)) {
      byCanonicalPath.set(canonical, workspace);
    }
  }

  const pick = (folder: WorkspaceFolderCandidate) => byCanonicalPath.get(normalizePathForMatch(folder.path));

  if (activePath) {
    const activeFolder = folders.find((folder) => normalizePathForMatch(folder.path) === normalizePathForMatch(activePath)) ?? null;
    const activeMatch = activeFolder ? pick(activeFolder) : null;
    if (activeFolder && activeMatch) {
      return { workspace: activeMatch, folder: activeFolder };
    }
  }

  for (const folder of folders) {
    const match = pick(folder);
    if (match) {
      return { workspace: match, folder };
    }
  }

  return null;
};

const normalizeOptionalPath = (value: unknown): string | null => (
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
);

export async function handleWorkspaceBridgeMessage(
  message: BridgeMessageInput,
  deps: WorkspaceBridgeDeps,
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

      const catalogWorkspaces = await deps.fetchCatalogWorkspaces();
      if (catalogWorkspaces === null) {
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

      const match = matchFolderToCatalogWorkspace(folders, normalizedActivePath, catalogWorkspaces);
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
          workspaceId: match.workspace.id,
          workspace: match.workspace,
          activePath: match.folder.path,
        },
      };
    }

    default:
      return null;
  }
}
