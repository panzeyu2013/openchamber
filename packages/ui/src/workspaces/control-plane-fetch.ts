import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';
import { getRuntimeBearerTokenSync, getRuntimeExtraHeadersSync } from '@/lib/runtime-auth';
import { sameRuntimeOrigin } from '@/lib/runtime-origin';

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
 * - The control plane base is `__OPENCHAMBER_LOCAL_ORIGIN__` (desktop
 *   loopback) when injected, otherwise the window origin; when the active
 *   runtime IS the control plane, its base URL keeps the deployment path
 *   prefix (nginx subpath deployments).
 * - Auth: the active bearer token is attached ONLY when it belongs to the
 *   control plane (same origin); otherwise requests rely on the UI session
 *   cookie (`credentials: 'include'`), never on the remote runtime's token.
 * - The VS Code webview bridge overrides `window.fetch`, so requests here go
 *   through the same bridge as every other UI request.
 */

/** Resolves the control-plane base URL (no trailing slash). */
export const getControlPlaneBaseUrl = (): string => {
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
