/**
 * VS Code webview control-plane handling.
 *
 * The OpenChamber control plane — the Workspace Catalog (`/api/workspaces*`),
 * the Session Index (`/api/workspace-sessions/*`) and connection profiles
 * (`/api/connections*`) — is NOT hosted by the opencode binary the extension
 * manages. Forwarding these paths to the binary would surface a confusing 404
 * from a server that cannot answer them.
 *
 * The current extension host has no control plane (no OpenChamber server to
 * connect to), so the webview answers these paths with an explicit
 * `control_plane_unavailable` 501. When a future version exposes a control
 * plane (e.g. `openchamber.apiUrl` pointing at an OpenChamber server), the
 * fetch override in `main.tsx` will route these paths through the bridge
 * (`api:proxy` with `controlPlane: true`) instead of short-circuiting here.
 * No URL is ever hardcoded in this module.
 */

export const CONTROL_PLANE_UNAVAILABLE_CODE = 'control_plane_unavailable';
const CONTROL_PLANE_UNAVAILABLE_STATUS = 501;

/** True for control-plane-owned API paths. */
export const isControlPlaneApiPath = (pathname: string): boolean => {
  if (pathname === '/api/workspaces' || pathname.startsWith('/api/workspaces/')) return true;
  if (pathname === '/api/connections' || pathname.startsWith('/api/connections/')) return true;
  return pathname === '/api/workspace-sessions' || pathname.startsWith('/api/workspace-sessions/');
};

/** Stable 501 payload for the webview fetch override. */
const controlPlaneUnavailableBody = (): { error: string; code: string } => ({
  error: 'Control plane is not available in the VS Code runtime',
  code: CONTROL_PLANE_UNAVAILABLE_CODE,
});

export const buildControlPlaneUnavailableResponse = (): Response => new Response(
  JSON.stringify(controlPlaneUnavailableBody()),
  {
    status: CONTROL_PLANE_UNAVAILABLE_STATUS,
    headers: { 'content-type': 'application/json' },
  },
);
