import { getRuntimeExtraHeadersSync, refreshLocalRuntimeUrlAuthToken, refreshRuntimeUrlAuthToken, setRuntimeBearerToken, setRuntimeExtraHeaders } from '@openchamber/ui/lib/runtime-auth';
import { installRuntimeFetchBridge } from '@openchamber/ui/lib/runtime-fetch';
import { sameRuntimeOrigin, sanitizeRuntimeApiBaseUrl } from '@openchamber/ui/lib/runtime-origin';
import { initializeRuntimeEndpoint } from '@openchamber/ui/lib/runtime-switch';
import { restoreDesktopRelayRuntime } from '@openchamber/ui/lib/desktopRelayRestore';
import { configureRuntimeUrlResolver } from '@openchamber/ui/lib/runtime-url';
import { createWebAPIs } from './api';

const sanitizeRuntimeKeyPart = (value: string | null): string => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return /^[a-zA-Z0-9._:-]+$/.test(trimmed) ? trimmed : '';
};

const readRuntimeKeyFromUrl = (): string | null => {
  const params = new URLSearchParams(window.location.search || '');
  const explicit = sanitizeRuntimeKeyPart(params.get('oc_runtime_key'));
  if (explicit) return explicit;
  const desktopHostId = sanitizeRuntimeKeyPart(params.get('oc_desktop_host_id'));
  if (desktopHostId) return `host:${desktopHostId}`;
  const injectedDesktopHostId = sanitizeRuntimeKeyPart(
    (window as typeof window & { __OPENCHAMBER_DESKTOP_HOST_ID__?: string }).__OPENCHAMBER_DESKTOP_HOST_ID__ || null,
  );
  return injectedDesktopHostId ? `host:${injectedDesktopHostId}` : null;
};

const removeRuntimeKeyParamsFromUrl = (): void => {
  if (typeof window.history?.replaceState !== 'function') return;
  const params = new URLSearchParams(window.location.search || '');
  let changed = false;
  for (const key of ['oc_runtime_key', 'oc_desktop_host_id']) {
    if (params.has(key)) {
      params.delete(key);
      changed = true;
    }
  }
  if (!changed) return;
  const nextSearch = params.toString();
  const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash || ''}`;
  window.history.replaceState(window.history.state, '', nextUrl);
};

declare global {
  interface Window {
    __OPENCHAMBER_API_BASE_URL__?: string;
    __OPENCHAMBER_CLIENT_TOKEN__?: string;
    __OPENCHAMBER_RUNTIME_HEADERS__?: Record<string, string>;
    __OPENCHAMBER_LOCAL_ORIGIN__?: string;
    __OPENCHAMBER_DESKTOP_HOST_ID__?: string;
  }
}

// Resolved once the desktop relay-host restore (if any) has picked a transport.
// Immediately-resolved everywhere else. See createConfiguredWebAPIs.
let desktopRelayRestoreReady: Promise<void> = Promise.resolve();
export const getDesktopRelayRestoreReady = (): Promise<void> => desktopRelayRestoreReady;

export const createConfiguredWebAPIs = () => {
  const injectedApiBaseUrl = typeof window.__OPENCHAMBER_API_BASE_URL__ === 'string'
    ? window.__OPENCHAMBER_API_BASE_URL__.trim()
    : '';
  const clientToken = typeof window.__OPENCHAMBER_CLIENT_TOKEN__ === 'string'
    ? window.__OPENCHAMBER_CLIENT_TOKEN__.trim()
    : '';
  const localOrigin = typeof window.__OPENCHAMBER_LOCAL_ORIGIN__ === 'string'
    ? window.__OPENCHAMBER_LOCAL_ORIGIN__.trim()
    : '';
  const apiBaseUrl = sanitizeRuntimeApiBaseUrl(injectedApiBaseUrl, {
    currentOrigin: window.location?.origin || '',
    localOrigin,
  });
  if (injectedApiBaseUrl && !apiBaseUrl) {
    window.__OPENCHAMBER_API_BASE_URL__ = '';
  }
  const runtimeKey = readRuntimeKeyFromUrl();
  removeRuntimeKeyParamsFromUrl();

  const urls = configureRuntimeUrlResolver({
    apiBaseUrl: apiBaseUrl || undefined,
    realtimeBaseUrl: apiBaseUrl || undefined,
  });
  initializeRuntimeEndpoint({
    apiBaseUrl,
    runtimeKey: runtimeKey || (sameRuntimeOrigin(apiBaseUrl, localOrigin) ? 'local' : null),
  });
  setRuntimeBearerToken(clientToken || null);
  setRuntimeExtraHeaders(window.__OPENCHAMBER_RUNTIME_HEADERS__ || null);
  void refreshRuntimeUrlAuthToken(apiBaseUrl || undefined).catch(() => {});
  if (localOrigin && !sameRuntimeOrigin(apiBaseUrl, localOrigin) && Object.keys(getRuntimeExtraHeadersSync()).length > 0) {
    void refreshLocalRuntimeUrlAuthToken(localOrigin).catch(() => {});
  }
  installRuntimeFetchBridge();
  // Desktop only: reconnect a relay-capable host now that the fetch bridge is
  // installed — either the host this window was opened for (injected id) or the
  // default host on relaunch. No-op elsewhere; resolves in milliseconds when no
  // relay host is involved. main.tsx holds the app render on this promise so
  // the user sees the splash instead of a transient auth screen against an
  // endpoint that is still being selected.
  const relayHostId = (window as typeof window & { __OPENCHAMBER_RELAY_HOST_ID__?: string }).__OPENCHAMBER_RELAY_HOST_ID__;
  desktopRelayRestoreReady = Promise.race([
    restoreDesktopRelayRuntime(typeof relayHostId === 'string' && relayHostId ? relayHostId : undefined).catch(() => {}),
    // Never hold the app hostage: a stuck probe/tunnel gives up to the UI.
    new Promise<void>((resolve) => { window.setTimeout(resolve, 10_000); }),
  ]);
  return createWebAPIs({ urls });
};
