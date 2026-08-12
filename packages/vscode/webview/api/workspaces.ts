import type { WorkspaceDescriptor } from '@openchamber/ui/workspaces/types';
import { sendBridgeMessage } from './bridge';

/**
 * VS Code webview workspace-identity bridge.
 *
 * Resolves the CURRENT VS Code folder(s) to a stable workspace descriptor —
 * the webview's consumption side of the `api:workspace:descriptor:get`
 * bridge message implemented by `src/bridge-workspace-runtime.ts`. The result
 * is typed against the SHARED catalog types (`WorkspaceDescriptor` from
 * `@openchamber/ui/workspaces/types`); the extension host produces a
 * structurally identical payload.
 *
 * Identity rule (mirrors the shared UI invariant): `workspaceId` is a stable
 * random UUID from the control-plane catalog and is NEVER derived from paths.
 * The extension host resolves the catalog from the configured control plane
 * (`openchamber.apiUrl`); when the control plane is not configured or is
 * unreachable, the bridge answers an explicit deterministic
 * `capability_unavailable` state (`code: 'capability_unavailable'`,
 * `reason: 'control_plane_unavailable'`) carrying the resolved folder set —
 * the caller must not fall back to a path-derived project identity as
 * authoritative. When the catalog is reachable the same message returns
 * `available` with the catalog descriptor; requests that touch
 * workspace-scoped state then carry the resolved `workspaceId` (same shape as
 * the `api:proxy` `controlPlane`/`workspaceId` passthrough).
 */

export const WORKSPACE_DESCRIPTOR_BRIDGE_TYPE = 'api:workspace:descriptor:get';

export interface WorkspaceFolderInfo {
  name: string;
  path: string;
}

export type WorkspaceDescriptorResult =
  | {
      status: 'available';
      workspaceId: string;
      workspace: WorkspaceDescriptor;
      activePath: string;
    }
  | {
      status: 'not_found';
      workspaceFolders: WorkspaceFolderInfo[];
      activePath: string | null;
    }
  | {
      status: 'capability_unavailable';
      code: 'capability_unavailable';
      reason: 'control_plane_unavailable';
      workspaceFolders: WorkspaceFolderInfo[];
      activePath: string | null;
    }
  | {
      status: 'no_folder';
      workspaceFolders: [];
      activePath: null;
    };

export interface WorkspaceDescriptorRequestPayload {
  activePath?: string;
}

/** Build the bridge request payload for the current folder's descriptor.
 * `activePath` is the webview's known active folder path when it has one
 * (e.g. the `newSession` directory override); when absent the key is omitted
 * and the extension host falls back to the first folder. */
export const buildWorkspaceDescriptorRequestPayload = (
  options?: { activePath?: string },
): WorkspaceDescriptorRequestPayload => (
  options?.activePath !== undefined ? { activePath: options.activePath } : {}
);

export const resolveCurrentWorkspaceDescriptor = (
  options?: { activePath?: string },
): Promise<WorkspaceDescriptorResult> => (
  sendBridgeMessage<WorkspaceDescriptorResult>(
    WORKSPACE_DESCRIPTOR_BRIDGE_TYPE,
    buildWorkspaceDescriptorRequestPayload(options),
  )
);
