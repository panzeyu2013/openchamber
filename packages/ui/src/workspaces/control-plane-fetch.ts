import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';
import { getRuntimeBearerTokenSync, getRuntimeExtraHeadersSync } from '@/lib/runtime-auth';
import { sameRuntimeOrigin } from '@/lib/runtime-origin';
import { isRelayModeActive } from '@/lib/relay/runtime-tunnel';
import { runtimeFetch } from '@/lib/runtime-fetch';

/**
 * Control-plane pinned fetch for the Workspace Catalog, Session Index and
 * workspace-bound SDK clients.
 *
 * These surfaces ALWAYS belong to the local control plane — the OpenChamber
 * instance that served the UI — regardless of which remote runtime is
 * currently active. Using the global `runtimeFetch` here would follow the
 * Active Runtime and send `/api/workspaces` to e.g.
 * `https://active-remote.example/api/workspaces`, silently swapping the
 * unified catalog to another server. This module pins every request to the
 * control plane:
 *
 * - The control plane base resolves in priority order:
 *   1. an explicit `setControlPlaneOrigin(...)` injection (Capacitor mobile
 *      pins the connected OpenChamber server after a capability probe);
 *   2. `__OPENCHAMBER_LOCAL_ORIGIN__` (desktop loopback);
 *   3. the window origin; when the active runtime IS the control plane, its
 *      base URL keeps the deployment path prefix (nginx subpath deployments).
 * - Runtimes with NO control plane (a webview whose origin is not http(s) —
 *   `vscode-webview://`, `capacitor://localhost` — and no explicit origin)
 *   receive an explicit `control_plane_unavailable` 501 response instead of a
 *   request to the wrong target. A failure is never a silent empty success.
 * - In relay mode the control plane sits behind the active tunnel; requests
 *   ride `runtimeFetch` on the window (virtual) origin so the E2EE tunnel
 *   carries them.
 * - Auth: the active bearer token is attached ONLY when it belongs to the
 *   control plane (same origin); otherwise requests rely on the UI session
 *   cookie (`credentials: 'include'`), never on the remote runtime's token.
 * - The VS Code webview bridge overrides `window.fetch`, so requests here go
 *   through the same bridge as every other UI request (control-plane paths
 *   are answered explicitly there — never forwarded to the opencode binary).
 */

/** Stable code carried by the explicit 501 control-plane-unavailable error. */
export const CONTROL_PLANE_UNAVAILABLE_CODE = 'control_plane_unavailable';
const CONTROL_PLANE_UNAVAILABLE_STATUS = 501;

/** Explicitly injected control-plane origin (mobile direct connections). */
let explicitControlPlaneOrigin: string | null = null;

const normalizeOrigin = (origin: string | null): string | null => {
  if (typeof origin !== 'string') return null;
  const trimmed = origin.trim().replace(/\/+$/, '');
  return trimmed || null;
};

/** Pin the control-plane origin (Capacitor mobile direct connections), or
 * clear it (disconnect / pure-OpenCode server). `null` restores automatic
 * resolution. */
export const setControlPlaneOrigin = (origin: string | null): void => {
  explicitControlPlaneOrigin = normalizeOrigin(origin);
};

/** The explicitly injected control-plane origin, or null. */
export const getControlPlaneOrigin = (): string | null => explicitControlPlaneOrigin;

const isHttpOrigin = (value: string): boolean => {
  if (!value) return false;
  try {
    return new URL(value).protocol === 'http:' || new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
};

/** True when the current runtime can reach a control plane at all: an
 * explicit origin is pinned, the desktop injected origin is present, a relay
 * tunnel is active (the control plane is behind the tunnel), or the window
 * origin itself is http(s). Non-http webview origins (VS Code, Capacitor)
 * with no injection are NOT available. */
export const isControlPlaneAvailable = (): boolean => {
  if (explicitControlPlaneOrigin) return true;
  if (isRelayModeActive()) return true;
  if (typeof window === 'undefined') return false;
  const injected = (window as typeof window & { __OPENCHAMBER_LOCAL_ORIGIN__?: string }).__OPENCHAMBER_LOCAL_ORIGIN__;
  if (typeof injected === 'string' && injected.trim()) return true;
  return isHttpOrigin(window.location.origin || '');
};

const controlPlaneUnavailableResponse = (): Response => new Response(
  JSON.stringify({
    error: 'Control plane is not available in this runtime',
    code: CONTROL_PLANE_UNAVAILABLE_CODE,
  }),
  {
    status: CONTROL_PLANE_UNAVAILABLE_STATUS,
    headers: { 'content-type': 'application/json' },
  },
);

/** Resolves the control-plane base URL (no trailing slash). */
export const getControlPlaneBaseUrl = (): string => {
  if (explicitControlPlaneOrigin) return explicitControlPlaneOrigin;
  const injected = typeof window !== 'undefined'
    ? (window as typeof window & { __OPENCHAMBER_LOCAL_ORIGIN__?: string }).__OPENCHAMBER_LOCAL_ORIGIN__
    : '';
  if (typeof injected === 'string' && injected.trim()) {
    return injected.trim().replace(/\/+$/, '');
  }
  if (typeof window === 'undefined') return '';
  const windowOrigin = window.location.origin || '';
  const apiBaseUrl = getRuntimeApiBaseUrl();
  // When the active runtime is the control plane itself, keep its path
  // prefix so subpath deployments (nginx `location /chamber`) stay correct.
  // In relay mode the active runtime base IS the window (virtual) origin, so
  // this branch yields the virtual origin the tunnel listens on.
  if (apiBaseUrl && sameRuntimeOrigin(apiBaseUrl, windowOrigin)) {
    return apiBaseUrl.replace(/\/+$/, '');
  }
  return windowOrigin;
};

const resolveControlPlaneUrl = (input: string | URL | Request): string => {
  const base = getControlPlaneBaseUrl();
  if (typeof input === 'string') {
    if (input.startsWith('/')) return `${base}${input}`;
    return rewriteWindowOriginUrl(input, base);
  }
  if (input instanceof URL) {
    return rewriteWindowOriginUrl(input.toString(), base);
  }
  return rewriteWindowOriginUrl(input.url, base);
};

/** The SDK resolves relative base URLs against `window.location.href`, so a
 * workspace-bound client produces absolute URLs on the WINDOW origin (vite
 * dev server, packaged `openchamber-ui://`, or the control plane itself).
 * Those must be rewritten to the control-plane base; foreign URLs (an
 * explicit absolute base, or a stray remote origin) stay untouched. */
const rewriteWindowOriginUrl = (raw: string, base: string): string => {
  if (!isAbsoluteHttpUrl(raw) || !base) return raw;
  try {
    const url = new URL(raw);
    const windowOrigin = typeof window !== 'undefined' ? window.location.origin : '';
    if (windowOrigin && url.origin === windowOrigin) {
      return `${base}${url.pathname}${url.search}`;
    }
    const baseUrl = new URL(base);
    if (url.origin === baseUrl.origin && url.pathname.startsWith(baseUrl.pathname === '/' ? '/' : baseUrl.pathname)) {
      return raw;
    }
    return raw;
  } catch {
    return raw;
  }
};

const isAbsoluteHttpUrl = (value: string): boolean => /^[a-z][a-z\d+.-]*:\/\//i.test(value);

/** True when the caller's URL is the control plane itself (same origin), so
 * its bearer credential is the control plane's own and can be attached. */
const credentialBelongsToControlPlane = (): boolean => {
  const base = getControlPlaneBaseUrl();
  if (!base) return false;
  const apiBaseUrl = getRuntimeApiBaseUrl();
  if (!apiBaseUrl) return false;
  if (sameRuntimeOrigin(apiBaseUrl, base)) return true;
  // Relay-mode virtual base URLs equal the window origin, which IS the
  // control plane origin for relay-hosted pages.
  if (typeof window !== 'undefined' && sameRuntimeOrigin(apiBaseUrl, window.location.origin)) {
    return sameRuntimeOrigin(base, window.location.origin);
  }
  return false;
};

export const createControlPlaneFetch = (): typeof fetch => {
  return async (input, init) => {
    const url = resolveControlPlaneUrl(input);
    // Relay mode: the control plane is behind the active E2EE tunnel, which
    // carries requests addressed to the window (virtual) origin. Delegate to
    // runtimeFetch so the tunnel transport + auth headers apply.
    if (isRelayModeActive()) {
      return runtimeFetch(url, { ...init });
    }
    const base = getControlPlaneBaseUrl();
    // No http(s) control plane in this runtime (VS Code / Capacitor webview
    // with no injected origin): answer explicitly instead of dispatching a
    // request to a virtual origin's static server or the opencode binary.
    // Without a window (SSR/tests) the relative path is passed through
    // unchanged, preserving the pre-window behavior.
    if (typeof window !== 'undefined' && !isHttpOrigin(base)) {
      return controlPlaneUnavailableResponse();
    }
    const headers = new Headers(init?.headers);
    if (credentialBelongsToControlPlane()) {
      const bearer = getRuntimeBearerTokenSync();
      if (bearer && !headers.has('Authorization')) {
        headers.set('Authorization', `Bearer ${bearer}`);
      }
      for (const [name, value] of Object.entries(getRuntimeExtraHeadersSync())) {
        if (!headers.has(name)) headers.set(name, value);
      }
    }
    return fetch(url, { ...init, headers, credentials: 'include' });
  };
};
