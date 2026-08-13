/**
 * VS Code webview control-plane handling.
 *
 * The OpenChamber control plane — the Project Catalog (`/api/projects*`),
 * the Session Index (`/api/project-sessions/*`) and connection profiles
 * (`/api/connections*`) — is NOT hosted by the opencode binary the extension
 * manages. Forwarding these paths to the binary would surface a confusing 404
 * from a server that cannot answer them.
 *
 * The fetch override in `main.tsx` routes these paths through the bridge:
 * regular requests ride `api:proxy` with `controlPlane: true` and the
 * extension host forwards them to the configured `openchamber.apiUrl` (or
 * answers an explicit `capability_unavailable` 501 when no control plane is
 * configured). SSE streams (`/api/project-sessions/events`) ride the
 * dedicated streamed SSE bridge (`api:sse:start` with `controlPlane: true`),
 * because a single-response proxy message cannot stream. No URL is ever
 * hardcoded in this module.
 */

export const CONTROL_PLANE_UNAVAILABLE_CODE = 'control_plane_unavailable';
const CONTROL_PLANE_UNAVAILABLE_STATUS = 501;

/** True for control-plane-owned API paths. */
export const isControlPlaneApiPath = (pathname: string): boolean => {
  if (pathname === '/api/projects' || pathname.startsWith('/api/projects/')) return true;
  if (pathname === '/api/connections' || pathname.startsWith('/api/connections/')) return true;
  return pathname === '/api/project-sessions' || pathname.startsWith('/api/project-sessions/');
};

/** True for a control-plane request that expects an SSE stream (the
 * session-index event stream). Such requests are answered through the streamed
 * SSE bridge (`api:sse:start` with `controlPlane: true`) instead of the
 * single-response `api:proxy` forward, which cannot stream. */
export const isControlPlaneSseRequest = (headers: Record<string, string> | undefined): boolean => {
  if (!headers) {
    return false;
  }
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'accept' && value.toLowerCase().includes('text/event-stream')) {
      return true;
    }
  }
  return false;
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
