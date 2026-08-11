import { lookup } from 'node:dns';
import { isPathWithinRoot, readRequestDirectoryHints } from './path-boundary.js';

/**
 * Direct connection adapter.
 *
 * `kind: 'direct'` profiles target a remote OpenCode/OpenChamber server over
 * HTTP/HTTPS. The control plane proxies workspace-scoped requests to the
 * SAVED baseUrl — the browser never sees the upstream URL or its credentials.
 *
 * Security contract (enforced here, not just in the UI):
 * - SSRF: the baseUrl host must not resolve to loopback/private/link-local/
 *   metadata addresses; every redirect hop is re-validated and cross-host
 *   redirects are rejected unless the host is on the profile's
 *   allowRedirectHosts allowlist.
 * - Credentials (clientToken / credentialRef) are attached server-side only
 *   and never returned to callers.
 * - Remote paths are NEVER canonicalized against the control plane's
 *   filesystem; canonicalPath for direct connections is the normalized raw
 *   client path under the target server's semantics.
 */

const SSRF_CHECK_TTL_MS = 60_000;

const BLOCKED_HOST_PATTERNS = [
  // loopback
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^0\.0\.0\.0$/,
  /^::1$/,
  /^::$/,
  // private IPv4
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^192\.168\.\d{1,3}\.\d{1,3}$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/,
  // link-local / metadata
  /^169\.254\.\d{1,3}\.\d{1,3}$/,
  // IPv6 ULA / link-local
  /^fc[0-9a-f]{2}:/i,
  /^fe80:/i,
];

const isBlockedAddress = (address) => {
  const normalized = address.toLowerCase();
  return BLOCKED_HOST_PATTERNS.some((pattern) => pattern.test(normalized));
};

const isLocalhostHostname = (hostname) => {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === '0.0.0.0';
};

/**
 * SSRF safety gate for a direct target baseUrl. Throws a typed error with
 * code `direct_unsafe_target` when the target is not safely reachable.
 * Resolution results are cached per (baseUrl) for a bounded TTL.
 */
export const createSafeUpstreamValidator = (dependencies = {}) => {
  const lookupImpl = dependencies.lookup ?? lookup;
  const ttlMs = dependencies.ttlMs ?? SSRF_CHECK_TTL_MS;
  const cache = new Map();

  const resolveAddresses = (hostname) => new Promise((resolve, reject) => {
    lookupImpl(hostname, { all: true }, (error, addresses) => {
      if (error) {
        reject(new Error(`host resolution failed: ${error.code ?? error.message}`));
        return;
      }
      resolve(Array.isArray(addresses) ? addresses.map((entry) => entry.address) : []);
    });
  });

  const assertSafeUpstreamUrl = async (baseUrl) => {
    let url;
    try {
      url = new URL(baseUrl);
    } catch {
      throw directError('direct_unsafe_target', 400, 'Invalid upstream URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw directError('direct_unsafe_target', 400, 'Upstream must use http or https');
    }
    const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw directError('direct_unsafe_target', 400, 'Upstream port is not allowed');
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (isLocalhostHostname(hostname)) {
      throw directError('direct_unsafe_target', 400, 'Loopback upstream hosts are not allowed for direct connections');
    }
    const cached = cache.get(baseUrl);
    if (cached && cached.expiresAt > Date.now()) {
      if (cached.blocked) throw directError('direct_unsafe_target', 400, 'Upstream host resolves to a private address');
      return;
    }
    let addresses;
    try {
      addresses = await resolveAddresses(hostname);
    } catch (error) {
      cache.set(baseUrl, { blocked: true, expiresAt: Date.now() + ttlMs });
      throw directError('direct_unsafe_target', 400, error.message);
    }
    if (addresses.length === 0 || addresses.some(isBlockedAddress)) {
      cache.set(baseUrl, { blocked: true, expiresAt: Date.now() + ttlMs });
      throw directError('direct_unsafe_target', 400, 'Upstream host resolves to a private address');
    }
    cache.set(baseUrl, { blocked: false, expiresAt: Date.now() + ttlMs });
  };

  const clearCache = () => cache.clear();

  return { assertSafeUpstreamUrl, clearCache };
};

export const createDirectWorkspaceAdapter = (dependencies) => {
  const {
    connectionId,
    fetchImpl = typeof fetch === 'function' ? fetch : null,
    path,
    lookupImpl,
    timeoutMs = 30_000,
    maxRedirects = 3,
  } = dependencies;

  const { assertSafeUpstreamUrl } = createSafeUpstreamValidator({ lookup: lookupImpl });

  if (!fetchImpl) {
    throw new Error('direct adapter requires a fetch implementation');
  }

  const normalizeRemotePath = (inputPath) => {
    if (typeof inputPath !== 'string' || inputPath.trim().length === 0) {
      const error = new Error('path is required');
      error.code = 'catalog_invalid_path';
      error.status = 400;
      throw error;
    }
    const trimmed = inputPath.trim().replace(/\\/g, '/');
    if (trimmed === '/') return '/';
    return trimmed.replace(/\/+$/, '');
  };

  const canonicalizePath = async (_context, inputPath) => normalizeRemotePath(inputPath);

  const buildUpstreamHeaders = async (context, sourceHeaders) => {
    const headers = new Headers();
    if (sourceHeaders && typeof sourceHeaders.forEach === 'function') {
      sourceHeaders.forEach((value, name) => {
        if (!BLOCKED_UPSTREAM_HEADERS.has(name.toLowerCase())) headers.set(name, value);
      });
    }
    const profile = context?.profile?.target;
    if (profile?.clientToken) {
      headers.set('authorization', `Bearer ${profile.clientToken}`);
    }
    if (profile?.credentialRef && context?.credentialProvider) {
      const credential = await context.credentialProvider.resolveCredential(profile.credentialRef);
      if (credential?.token) headers.set('authorization', `Bearer ${credential.token}`);
      if (credential?.headers && typeof credential.headers === 'object') {
        for (const [name, value] of Object.entries(credential.headers)) {
          if (value !== undefined && value !== null) headers.set(name, String(value));
        }
      }
    }
    return headers;
  };

  const reconstructBody = (request) => {
    const method = request?.method ?? 'GET';
    if (method === 'GET' || method === 'HEAD' || request?.body === undefined || request.body === null) {
      return undefined;
    }
    if (typeof request.body === 'string' || Buffer.isBuffer(request.body)) {
      return { body: request.body };
    }
    if (typeof request.body === 'object') {
      return { body: JSON.stringify(request.body), contentType: 'application/json' };
    }
    return undefined;
  };

  const requestWithRedirects = async (baseUrl, pathnameAndSearch, init, context, redirectCount = 0) => {
    await assertSafeUpstreamUrl(baseUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}${pathnameAndSearch}`, {
        ...init,
        signal: init?.signal ?? controller.signal,
        redirect: 'manual',
      });
      if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
        if (redirectCount >= maxRedirects) {
          throw directError('direct_redirect_forbidden', 502, 'Too many upstream redirects');
        }
        const location = response.headers.get('location');
        let nextUrl;
        try {
          nextUrl = new URL(location, baseUrl);
        } catch {
          throw directError('direct_redirect_forbidden', 502, 'Upstream returned an invalid redirect');
        }
        const nextBase = nextUrl.origin;
        const allowedHosts = context?.profile?.target?.allowRedirectHosts ?? [];
        if (nextBase !== baseUrl.replace(/\/+$/, '')
          && !allowedHosts.some((host) => nextUrl.hostname.toLowerCase() === String(host).toLowerCase())) {
          throw directError('direct_redirect_forbidden', 502, 'Upstream redirected to a disallowed host');
        }
        return requestWithRedirects(nextBase, `${nextUrl.pathname}${nextUrl.search}`, init, context, redirectCount + 1);
      }
      return response;
    } finally {
      clearTimeout(timeout);
    }
  };

  const probe = async (context, _inputPath) => {
    const baseUrl = context?.profile?.target?.baseUrl;
    if (!baseUrl) {
      return { ok: false, canonicalPath: null, error: { code: 'direct_no_target', message: 'Connection has no target URL' } };
    }
    try {
      await assertSafeUpstreamUrl(baseUrl);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.min(timeoutMs, 10_000));
      let response;
      try {
        response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/health`, {
          method: 'GET',
          signal: controller.signal,
          redirect: 'manual',
        });
      } finally {
        clearTimeout(timeout);
      }
      if (response.ok || response.status === 401 || response.status === 403) {
        return {
          ok: true,
          canonicalPath: null,
          capabilities: { pathBrowse: true, terminal: true, files: true, git: true, eventStream: true },
          ...(response.status === 401 || response.status === 403 ? { authRequired: true } : {}),
        };
      }
      return { ok: false, canonicalPath: null, error: { code: 'direct_wrong_service', message: `Unexpected upstream response (${response.status})` } };
    } catch (error) {
      return {
        ok: false,
        canonicalPath: null,
        error: {
          code: error?.code === 'direct_unsafe_target' ? 'direct_unsafe_target' : 'direct_unreachable',
          message: error?.code === 'direct_unsafe_target' ? error.message : 'Upstream server is unreachable',
        },
      };
    }
  };

  const listChildren = async (context, directoryPath) => {
    const baseUrl = context?.profile?.target?.baseUrl;
    if (!baseUrl) {
      const error = new Error('Connection has no target URL');
      error.code = 'direct_no_target';
      error.status = 500;
      throw error;
    }
    const directory = normalizeRemotePath(directoryPath);
    const headers = await buildUpstreamHeaders(context, null);
    headers.set('x-openchamber-directory', directory);
    headers.set('accept', 'application/json');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await requestWithRedirects(baseUrl, '/api/fs/list', {
        method: 'GET',
        headers,
        signal: controller.signal,
      }, context);
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      const error = new Error(`Remote directory listing failed (${response.status})`);
      error.code = response.status === 404 ? 'catalog_path_not_found' : 'catalog_path_not_accessible';
      error.status = response.status === 404 ? 404 : 502;
      throw error;
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      const error = new Error('Remote directory listing returned an invalid payload');
      error.code = 'catalog_path_not_accessible';
      error.status = 502;
      throw error;
    }
    const entries = Array.isArray(payload) ? payload : (Array.isArray(payload?.entries) ? payload.entries : null);
    if (!entries) {
      const error = new Error('Remote directory listing returned an invalid payload');
      error.code = 'catalog_path_not_accessible';
      error.status = 502;
      throw error;
    }
    const children = entries
      .filter((entry) => entry && typeof entry === 'object' && typeof entry.path === 'string' && typeof entry.name === 'string')
      .map((entry) => ({
        name: entry.name,
        path: entry.path,
        kind: entry.isDirectory ? 'directory' : (entry.isFile ? 'file' : 'other'),
      }));
    return { directory, children };
  };

  const fetch = async (context, request, restPath) => {
    const baseUrl = context?.profile?.target?.baseUrl;
    if (!baseUrl) {
      const error = new Error('Connection has no target URL');
      error.code = 'direct_no_target';
      error.status = 500;
      throw error;
    }
    const headers = await buildUpstreamHeaders(context, request?.headers);
    const canonicalPath = context?.canonicalPath;
    if (canonicalPath) {
      // Remote paths cannot be symlink-resolved from the control plane; the
      // lexical boundary check still blocks `..` traversal and arbitrary
      // directories. Both directory-header conventions are overwritten with
      // the workspace canonical path so the target server always resolves
      // the working directory inside the workspace.
      for (const hint of readRequestDirectoryHints(request)) {
        if (!isPathWithinRoot(canonicalPath, hint)) {
          throw directError('catalog_path_outside_workspace', 403, 'directory is outside the workspace');
        }
      }
      headers.set('x-opencode-directory', canonicalPath);
      headers.set('x-openchamber-directory', canonicalPath);
    }
    const reconstructed = reconstructBody(request);
    if (reconstructed?.contentType && !headers.has('content-type')) {
      headers.set('content-type', reconstructed.contentType);
    }
    return requestWithRedirects(baseUrl, restPath, {
      method: request?.method ?? 'GET',
      headers,
      body: reconstructed?.body,
      signal: request?.signal,
    }, context);
  };

  const openEventStream = async (context, restPath, signal) => {
    const baseUrl = context?.profile?.target?.baseUrl;
    if (!baseUrl) {
      const error = new Error('Connection has no target URL');
      error.code = 'direct_no_target';
      error.status = 500;
      throw error;
    }
    const headers = await buildUpstreamHeaders(context, null);
    headers.set('accept', 'text/event-stream');
    const response = await requestWithRedirects(baseUrl, restPath, {
      method: 'GET',
      headers,
      signal,
    }, context);
    if (!response.ok || !response.body) {
      const error = new Error(`Event stream unavailable (${response.status})`);
      error.code = 'capability_unavailable';
      error.status = 502;
      throw error;
    }
    return response;
  };

  /**
   * Resolves the upstream ws(s):// URL for a workspace-scoped WebSocket
   * upgrade. Applies the same SSRF gate (saved baseUrl must not resolve to
   * private addresses), the same server-side credential injection and the
   * same lexical directory-boundary enforcement as `fetch`. The ws client
   * itself is created by the workspace runtime proxy, which applies the
   * connect timeout.
   */
  const openWebSocket = async (context, request = {}) => {
    const baseUrl = context?.profile?.target?.baseUrl;
    if (!baseUrl) {
      throw directError('direct_no_target', 500, 'Connection has no target URL');
    }
    await assertSafeUpstreamUrl(baseUrl);
    const pathname = getWsPathname(request.path);
    if (!pathname.startsWith('/api/')) {
      throw directError('catalog_runtime_path_not_allowed', 404, 'Path is not a forwardable workspace socket');
    }
    const headers = await buildUpstreamHeaders(context, request?.headers);
    const canonicalPath = context?.canonicalPath;
    if (canonicalPath) {
      // Remote paths cannot be symlink-resolved from the control plane; the
      // lexical boundary check still blocks `..` traversal and arbitrary
      // directories. Both directory-header conventions are overwritten with
      // the workspace canonical path, matching `fetch`.
      for (const hint of readRequestDirectoryHints(request)) {
        if (!isPathWithinRoot(canonicalPath, hint)) {
          throw directError('catalog_path_outside_workspace', 403, 'directory is outside the workspace');
        }
      }
      headers.set('x-opencode-directory', canonicalPath);
      headers.set('x-openchamber-directory', canonicalPath);
    }
    return {
      url: `${baseUrl.replace(/\/+$/, '').replace(/^http/i, 'ws')}${pathname}`,
      headers: objectifyHeaders(headers),
      timeoutMs,
    };
  };

  const dispose = async () => {};

  return {
    kind: 'direct',
    connectionId,
    capabilities: { pathBrowse: true, terminal: true, files: true, git: true, eventStream: true },
    canonicalizePath,
    probe,
    listChildren,
    fetch,
    openEventStream,
    openWebSocket,
    dispose,
  };
};

const directError = (code, status, message) => {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
};

const getWsPathname = (inputPath) => {
  if (typeof inputPath !== 'string' || inputPath.length === 0) return '';
  try {
    return new URL(inputPath, 'http://localhost').pathname;
  } catch {
    return '';
  }
};

const objectifyHeaders = (headers) => {
  const result = {};
  headers.forEach((value, name) => { result[name] = value; });
  return result;
};

const BLOCKED_UPSTREAM_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-openchamber-client-token',
  'x-openchamber-runtime-headers',
  'x-openchamber-url-token',
]);
