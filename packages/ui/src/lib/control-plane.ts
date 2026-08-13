// Control-plane identity and switching.
//
// This module owns the ACTIVE control plane: its API base URL, its identity
// key, its bearer/extra-headers state, relay tunnel activation, and the
// change notifications fired when the active endpoint is replaced. It is the
// successor of the deleted legacy runtime-endpoint module: every export here
// is the byte-identical re-home of that role, renamed from
// "runtime endpoint" vocabulary to "control plane".
//
// Distinguish it from `projects/control-plane-fetch.ts`: that module owns
// the PINNED window-origin resolution used by the Project Catalog / Session
// Index (which control plane served THIS page), while this module owns the
// ACTIVE endpoint the rest of the UI talks to. Both concepts coexist; they
// are not interchangeable.

import { refreshRuntimeUrlAuthToken, setRuntimeAuthApiBaseUrl, setRuntimeBearerToken, setRuntimeExtraHeaders } from '@/lib/runtime-auth';
import { configureRuntimeUrlResolver } from '@/lib/runtime-url';
import {
  normalizeRuntimeBaseUrl,
  readInjectedDesktopHostId,
  readWindowRuntimeOriginContext,
  sanitizeRuntimeApiBaseUrl,
  sameRuntimeOrigin,
} from '@/lib/runtime-origin';
import {
  activateRelayTunnel,
  deactivateRelayTunnel,
  type RelayRuntimeDescriptor,
} from '@/lib/relay/runtime-tunnel';

export type ControlPlaneChangedDetail = {
  apiBaseUrl: string;
  previousApiBaseUrl: string;
  runtimeKey: string;
  previousRuntimeKey: string;
};

// The event names are a cross-module contract: dictation-client.ts listens to
// the raw `openchamber:runtime-endpoint-changed` string and tests dispatch the
// raw `openchamber:runtime-endpoint-will-change` string, so they must stay
// byte-identical to the legacy module they replace.
const RUNTIME_ENDPOINT_CHANGED_EVENT = 'openchamber:runtime-endpoint-changed';
const RUNTIME_ENDPOINT_WILL_CHANGE_EVENT = 'openchamber:runtime-endpoint-will-change';

let activeApiBaseUrl = '';
let activeRuntimeKey = '';

const setWindowRuntimeValue = <K extends '__OPENCHAMBER_API_BASE_URL__' | '__OPENCHAMBER_CLIENT_TOKEN__' | '__OPENCHAMBER_RUNTIME_HEADERS__'>(
  runtimeWindow: typeof window & {
    __OPENCHAMBER_API_BASE_URL__?: string;
    __OPENCHAMBER_CLIENT_TOKEN__?: string;
    __OPENCHAMBER_RUNTIME_HEADERS__?: Record<string, string>;
  },
  key: K,
  value: (typeof runtimeWindow)[K],
): void => {
  try {
    runtimeWindow[key] = value;
  } catch {
    // Electron preload exposes some initial globals through contextBridge, which
    // makes them read-only. Control-plane switching must still update in-memory state.
  }
};

const normalizeRuntimeUrlKey = (value: string): string => {
  try {
    const url = new URL(value);
    url.hash = '';
    url.search = '';
    // Normalise pathname so root `/` becomes empty and no path ends with `/`.
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    // url.toString() still appends `/` when pathname is `/`; strip it
    // so every key uses the bare-origin form: `url:https://example.com`.
    return `url:${url.toString().replace(/\/+$/, '')}`;
  } catch {
    return `url:${value.trim().replace(/\/+$/, '') || 'default'}`;
  }
};

const readInjectedLocalOrigin = (): string => {
  if (typeof window === 'undefined') return '';
  const injected = (window as typeof window & { __OPENCHAMBER_LOCAL_ORIGIN__?: string }).__OPENCHAMBER_LOCAL_ORIGIN__;
  return typeof injected === 'string' ? injected.trim() : '';
};

const getCurrentOrigin = (): string => {
  if (typeof window === 'undefined') return '';
  return window.location?.origin || '';
};

// The injected API base URL is only trustworthy when it belongs to the current
// page: a stale loopback URL from another SSH tunnel (or an old local server)
// must never become the active control plane. Sanitized lazily and cached
// against the raw globals it derives from, mirroring the getControlPlaneKey cache.
let cachedInjectedApiBaseUrl = '';
let cachedInjectedRawApiBaseUrl: string | undefined;
let cachedInjectedRawLocalOrigin: string | undefined;
let cachedInjectedCurrentOrigin = '';

const readInjectedApiBaseUrl = (): string => {
  if (typeof window === 'undefined') return '';
  const raw = (window as typeof window & { __OPENCHAMBER_API_BASE_URL__?: string }).__OPENCHAMBER_API_BASE_URL__;
  const rawLocalOrigin = (window as typeof window & { __OPENCHAMBER_LOCAL_ORIGIN__?: string }).__OPENCHAMBER_LOCAL_ORIGIN__;
  const currentOrigin = getCurrentOrigin();
  if (
    cachedInjectedRawApiBaseUrl === raw
    && cachedInjectedRawLocalOrigin === rawLocalOrigin
    && cachedInjectedCurrentOrigin === currentOrigin
  ) {
    return cachedInjectedApiBaseUrl;
  }
  cachedInjectedRawApiBaseUrl = raw;
  cachedInjectedRawLocalOrigin = rawLocalOrigin;
  cachedInjectedCurrentOrigin = currentOrigin;
  cachedInjectedApiBaseUrl = sanitizeRuntimeApiBaseUrl(raw, { currentOrigin, localOrigin: rawLocalOrigin });
  return cachedInjectedApiBaseUrl;
};

/** The ACTIVE control-plane base URL (explicit selection or sanitized boot
 * injection). Distinguish from the pinned window-origin resolution in
 * `projects/control-plane-fetch.ts`. */
export const getControlPlaneBaseUrl = (): string => activeApiBaseUrl || readInjectedApiBaseUrl();

// `getControlPlaneKey` keys caches, stores, and persisted state across the whole
// UI, so it runs on store reads, event handling, and render paths. Before the
// control plane is explicitly initialised, every call re-derived the key by
// trimming two injected globals and constructing three `URL` objects, which
// made this one of the most expensive functions during streaming.
//
// The result depends only on `activeApiBaseUrl` and the two injected globals,
// and `setControlPlane` writes the injected API base URL at runtime, so
// the cache is validated against the raw, untrimmed values. That comparison
// allocates nothing and still recomputes the moment any input changes.
let cachedRuntimeKey = '';
let cachedActiveApiBaseUrl: string | null = null;
let cachedRawApiBaseUrl: string | undefined;
let cachedRawLocalOrigin: string | undefined;
let cachedRawDesktopHostId = '';
let cachedDesktopLocalUi = false;
let cachedCurrentOrigin = '';

const readRawRuntimeGlobal = (key: '__OPENCHAMBER_API_BASE_URL__' | '__OPENCHAMBER_LOCAL_ORIGIN__'): string | undefined => {
  if (typeof window === 'undefined') return undefined;
  const value = (window as typeof window & {
    __OPENCHAMBER_API_BASE_URL__?: string;
    __OPENCHAMBER_LOCAL_ORIGIN__?: string;
  })[key];
  return typeof value === 'string' ? value : undefined;
};

/** Control-plane identity key for cache partitioning (host keys, 'local',
 * 'mobile-disconnected'). NOT the project scope key; project-bound sync
 * partitions on explicit project scope keys instead. */
export const getControlPlaneKey = (): string => {
  if (activeRuntimeKey) return activeRuntimeKey;

  const rawApiBaseUrl = readRawRuntimeGlobal('__OPENCHAMBER_API_BASE_URL__');
  const rawLocalOrigin = readRawRuntimeGlobal('__OPENCHAMBER_LOCAL_ORIGIN__');
  const rawDesktopHostId = readInjectedDesktopHostId();
  const desktopLocalUi = typeof window !== 'undefined'
    && (window as typeof window & { __OPENCHAMBER_DESKTOP_LOCAL_UI__?: boolean }).__OPENCHAMBER_DESKTOP_LOCAL_UI__ === true;
  const currentOrigin = getCurrentOrigin();
  if (
    cachedActiveApiBaseUrl === activeApiBaseUrl
    && cachedRawApiBaseUrl === rawApiBaseUrl
    && cachedRawLocalOrigin === rawLocalOrigin
    && cachedRawDesktopHostId === rawDesktopHostId
    && cachedDesktopLocalUi === desktopLocalUi
    && cachedCurrentOrigin === currentOrigin
  ) {
    return cachedRuntimeKey;
  }

  const apiBaseUrl = getControlPlaneBaseUrl();
  cachedRuntimeKey = apiBaseUrl
    ? (sameRuntimeOrigin(apiBaseUrl, readInjectedLocalOrigin())
      ? 'local'
      : normalizeRuntimeUrlKey(apiBaseUrl))
    : (rawDesktopHostId === 'local' || desktopLocalUi
      ? 'local'
      : rawDesktopHostId
        ? `host:${rawDesktopHostId}`
      : `url:${currentOrigin || 'default'}`);
  cachedActiveApiBaseUrl = activeApiBaseUrl;
  cachedRawApiBaseUrl = rawApiBaseUrl;
  cachedRawLocalOrigin = rawLocalOrigin;
  cachedRawDesktopHostId = rawDesktopHostId;
  cachedDesktopLocalUi = desktopLocalUi;
  cachedCurrentOrigin = currentOrigin;
  return cachedRuntimeKey;
};

/** Boot-time control-plane initialization: silent, fires no events, and is a
 * no-op once an active control plane exists. Successor of
 * `initializeRuntimeEndpoint`. */
export const initializeControlPlane = (options: { apiBaseUrl?: string | null; runtimeKey?: string | null } = {}): void => {
  if (activeApiBaseUrl || activeRuntimeKey) {
    return;
  }

  const context = readWindowRuntimeOriginContext();
  const apiBaseUrl = sanitizeRuntimeApiBaseUrl(options.apiBaseUrl, context) || readInjectedApiBaseUrl();
  const explicitKey = options.runtimeKey?.trim();
  if (!apiBaseUrl && !explicitKey) {
    return;
  }

  if (apiBaseUrl) {
    activeApiBaseUrl = apiBaseUrl;
  }
  activeRuntimeKey = explicitKey || (sameRuntimeOrigin(apiBaseUrl, context.localOrigin)
    ? 'local'
    : normalizeRuntimeUrlKey(apiBaseUrl));
};

/** Replace the ACTIVE control plane. Byte-identical successor of the legacy
 * runtime-endpoint switch: fires will-change + changed notifications, updates
 * the runtime auth state, window globals and URL resolver, activates or
 * deactivates the relay tunnel singleton, and refreshes the URL-scoped token
 * through the active transport. */
export const setControlPlane = (options: { apiBaseUrl: string; clientToken?: string | null; runtimeKey?: string | null; requestHeaders?: Record<string, string> | null; relay?: RelayRuntimeDescriptor | null }): void => {
  const context = readWindowRuntimeOriginContext();
  // Control-plane switches are explicit user/application selections. Unlike boot
  // globals, a distinct loopback endpoint here is authoritative (for example
  // switching between two SSH forwards in the same renderer).
  const apiBaseUrl = normalizeRuntimeBaseUrl(options.apiBaseUrl);
  const previousApiBaseUrl = getControlPlaneBaseUrl();
  const previousRuntimeKey = getControlPlaneKey();
  // An explicit key always wins. Without one, a base URL normalizes to its
  // `url:` key and an empty base derives from the desktop host identity or the
  // window origin. This also covers the disconnected state, whose explicit
  // 'mobile-disconnected' key must never be replaced by a derived key.
  const runtimeKey = options.runtimeKey?.trim()
    || (apiBaseUrl
      ? normalizeRuntimeUrlKey(apiBaseUrl)
      : (readInjectedDesktopHostId() === 'local'
        ? 'local'
        : readInjectedDesktopHostId()
          ? `host:${readInjectedDesktopHostId()}`
          : `url:${context.currentOrigin || 'default'}`));
  const detail = { apiBaseUrl, previousApiBaseUrl, runtimeKey, previousRuntimeKey };
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<ControlPlaneChangedDetail>(RUNTIME_ENDPOINT_WILL_CHANGE_EVENT, { detail }));
  }
  activeApiBaseUrl = apiBaseUrl;
  activeRuntimeKey = runtimeKey;
  setRuntimeAuthApiBaseUrl(apiBaseUrl, true);
  if (typeof window !== 'undefined') {
    const runtimeWindow = window as typeof window & {
      __OPENCHAMBER_API_BASE_URL__?: string;
      __OPENCHAMBER_CLIENT_TOKEN__?: string;
      __OPENCHAMBER_RUNTIME_HEADERS__?: Record<string, string>;
    };
    setWindowRuntimeValue(runtimeWindow, '__OPENCHAMBER_API_BASE_URL__', apiBaseUrl);
    setWindowRuntimeValue(runtimeWindow, '__OPENCHAMBER_CLIENT_TOKEN__', options.clientToken || undefined);
    setWindowRuntimeValue(runtimeWindow, '__OPENCHAMBER_RUNTIME_HEADERS__', options.requestHeaders || undefined);
  }
  configureRuntimeUrlResolver({ apiBaseUrl, realtimeBaseUrl: apiBaseUrl, source: 'runtime-selection' });
  setRuntimeExtraHeaders(options.requestHeaders || null);
  setRuntimeBearerToken(options.clientToken || null);
  // Relay mode routes runtime HTTP/WS through an E2EE tunnel instead of the
  // network. Activate the tunnel BEFORE minting the url token, since the mint
  // itself rides the tunnel (runtimeFetch -> tunnel.fetch).
  if (options.relay) {
    activateRelayTunnel(options.relay);
  } else {
    deactivateRelayTunnel();
  }
  void refreshRuntimeUrlAuthToken(apiBaseUrl || undefined).catch(() => {});
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<ControlPlaneChangedDetail>(RUNTIME_ENDPOINT_CHANGED_EVENT, {
      detail,
    }));
  }
};

/** Disconnect the control plane (mobile disconnect / connect-screen state).
 * Successor of the legacy disconnected-state switch (empty base URL, no
 * client token, `runtimeKey: 'mobile-disconnected'`). `getControlPlaneKey()` keeps
 * returning 'mobile-disconnected' in this state so the key never matches a
 * saved mobile connection. */
export const resetControlPlane = (): void => {
  setControlPlane({ apiBaseUrl: '', clientToken: null, runtimeKey: 'mobile-disconnected' });
};

export const subscribeControlPlaneWillChange = (callback: (detail: ControlPlaneChangedDetail) => void): (() => void) => {
  if (typeof window === 'undefined') return () => {};
  const listener = (event: Event) => {
    callback((event as CustomEvent<ControlPlaneChangedDetail>).detail);
  };
  window.addEventListener(RUNTIME_ENDPOINT_WILL_CHANGE_EVENT, listener);
  return () => window.removeEventListener(RUNTIME_ENDPOINT_WILL_CHANGE_EVENT, listener);
};

export const subscribeControlPlaneChanged = (callback: (detail: ControlPlaneChangedDetail) => void): (() => void) => {
  if (typeof window === 'undefined') return () => {};
  const listener = (event: Event) => {
    callback((event as CustomEvent<ControlPlaneChangedDetail>).detail);
  };
  window.addEventListener(RUNTIME_ENDPOINT_CHANGED_EVENT, listener);
  return () => window.removeEventListener(RUNTIME_ENDPOINT_CHANGED_EVENT, listener);
};

// Control-plane bearer/extra-header state lives in runtime-auth; these are the
// control-plane-named successors of getRuntimeBearerTokenSync /
// getRuntimeExtraHeadersSync.
export { getRuntimeBearerTokenSync as getControlPlaneBearerTokenSync, getRuntimeExtraHeadersSync as getControlPlaneExtraHeadersSync } from '@/lib/runtime-auth';
