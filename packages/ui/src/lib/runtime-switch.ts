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

export type RuntimeEndpointChangedDetail = {
  apiBaseUrl: string;
  previousApiBaseUrl: string;
  runtimeKey: string;
  previousRuntimeKey: string;
};

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
    // makes them read-only. Runtime switching must still update in-memory state.
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
// must never become the active runtime. Sanitized lazily and cached against
// the raw globals it derives from, mirroring the getRuntimeKey cache.
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

export const getRuntimeApiBaseUrl = (): string => activeApiBaseUrl || readInjectedApiBaseUrl();

// `getRuntimeKey` keys caches, stores, and persisted state across the whole UI,
// so it runs on store reads, event handling, and render paths. Before the
// runtime endpoint is explicitly initialised, every call re-derived the key by
// trimming two injected globals and constructing three `URL` objects, which
// made this one of the most expensive functions during streaming.
//
// The result depends only on `activeApiBaseUrl` and the two injected globals,
// and `switchRuntimeEndpoint` writes the injected API base URL at runtime, so
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

export const getRuntimeKey = (): string => {
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

  const apiBaseUrl = getRuntimeApiBaseUrl();
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

export const initializeRuntimeEndpoint = (options: { apiBaseUrl?: string | null; runtimeKey?: string | null } = {}): void => {
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

export const switchRuntimeEndpoint = (options: { apiBaseUrl: string; clientToken?: string | null; runtimeKey?: string | null; requestHeaders?: Record<string, string> | null; relay?: RelayRuntimeDescriptor | null }): void => {
  const context = readWindowRuntimeOriginContext();
  // Runtime switches are explicit user/application selections. Unlike boot
  // globals, a distinct loopback endpoint here is authoritative (for example
  // switching between two SSH forwards in the same renderer).
  const apiBaseUrl = normalizeRuntimeBaseUrl(options.apiBaseUrl);
  const previousApiBaseUrl = getRuntimeApiBaseUrl();
  const previousRuntimeKey = getRuntimeKey();
  const runtimeKey = apiBaseUrl
    ? (options.runtimeKey?.trim() || normalizeRuntimeUrlKey(apiBaseUrl))
    : (readInjectedDesktopHostId() === 'local'
      ? 'local'
      : readInjectedDesktopHostId()
        ? `host:${readInjectedDesktopHostId()}`
      : `url:${context.currentOrigin || 'default'}`);
  const detail = { apiBaseUrl, previousApiBaseUrl, runtimeKey, previousRuntimeKey };
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<RuntimeEndpointChangedDetail>(RUNTIME_ENDPOINT_WILL_CHANGE_EVENT, { detail }));
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
    window.dispatchEvent(new CustomEvent<RuntimeEndpointChangedDetail>(RUNTIME_ENDPOINT_CHANGED_EVENT, {
      detail,
    }));
  }
};

export const subscribeRuntimeEndpointWillChange = (callback: (detail: RuntimeEndpointChangedDetail) => void): (() => void) => {
  if (typeof window === 'undefined') return () => {};
  const listener = (event: Event) => {
    callback((event as CustomEvent<RuntimeEndpointChangedDetail>).detail);
  };
  window.addEventListener(RUNTIME_ENDPOINT_WILL_CHANGE_EVENT, listener);
  return () => window.removeEventListener(RUNTIME_ENDPOINT_WILL_CHANGE_EVENT, listener);
};

export const subscribeRuntimeEndpointChanged = (callback: (detail: RuntimeEndpointChangedDetail) => void): (() => void) => {
  if (typeof window === 'undefined') return () => {};
  const listener = (event: Event) => {
    callback((event as CustomEvent<RuntimeEndpointChangedDetail>).detail);
  };
  window.addEventListener(RUNTIME_ENDPOINT_CHANGED_EVENT, listener);
  return () => window.removeEventListener(RUNTIME_ENDPOINT_CHANGED_EVENT, listener);
};
