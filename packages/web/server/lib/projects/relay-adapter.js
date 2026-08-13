/**
 * Connection-keyed Relay project adapter.
 *
 * A Relay profile stores only an opaque `credentialRef` and `relayId`. The
 * injected credential provider resolves that reference to the private relay
 * descriptor (`relayUrl`, `serverId`, `hostEncPubJwk`) and the upstream client
 * credential. The descriptor is never returned to the catalog or put in a URL
 * controlled by the renderer.
 */

import { createRelayTunnelClient } from '../relay/tunnel-client.js';
import {
  isPathWithinProject,
  readRequestDirectoryHints,
  readRequestProjectPathHints,
  scopeProjectDirectoryListRequest,
} from './path-boundary.js';

const RELAY_CAPABILITIES = {
  pathBrowse: true,
  terminal: true,
  files: true,
  git: true,
  eventStream: true,
};

// Errors the adapter raises itself; their messages are safe to surface.
// Tunnel-internal errors (e.g. `relay_tunnel_failed`) can wrap transport
// details and must stay generic in probe responses.
const SELF_TYPED_PROBE_ERROR_CODES = new Set([
  'capability_unavailable',
  'catalog_invalid_path',
  'catalog_path_not_accessible',
  'catalog_path_outside_project',
  'catalog_runtime_path_not_allowed',
  'relay_credentials_invalid',
  'relay_credentials_unavailable',
  'relay_profile_invalid',
]);

const BLOCKED_UPSTREAM_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
  'x-openchamber-client-token',
  'x-openchamber-runtime-headers',
  'x-openchamber-url-token',
]);

const isValidJwk = (value) => Boolean(
  value
  && typeof value === 'object'
  && !Array.isArray(value)
  && value.kty === 'EC'
  && value.crv === 'P-256'
  && typeof value.x === 'string'
  && typeof value.y === 'string',
);

const relayError = (code, status, message) => {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
};

const normalizeRemotePath = (inputPath) => {
  if (typeof inputPath !== 'string' || inputPath.trim().length === 0) {
    throw relayError('catalog_invalid_path', 400, 'path is required');
  }
  const trimmed = inputPath.trim().replace(/\\/g, '/');
  if (trimmed === '/') return '/';
  return trimmed.replace(/\/+$/, '');
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

const copySourceHeaders = (sourceHeaders, target) => {
  if (!sourceHeaders) return;
  const add = (name, value) => {
    if (value === undefined || value === null) return;
    const lower = String(name).toLowerCase();
    if (BLOCKED_UPSTREAM_HEADERS.has(lower)) return;
    if (/\r|\n/.test(String(name)) || /\r|\n/.test(String(value))) return;
    target.set(lower, Array.isArray(value) ? value.join(', ') : String(value));
  };
  if (typeof sourceHeaders.forEach === 'function') {
    sourceHeaders.forEach((value, name) => add(name, value));
    return;
  }
  if (typeof sourceHeaders === 'object') {
    for (const [name, value] of Object.entries(sourceHeaders)) add(name, value);
  }
};

const copyCredentialHeaders = (credential, headers) => {
  const values = credential?.headers;
  if (!values || typeof values !== 'object' || Array.isArray(values)) return;
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue;
    const lower = name.toLowerCase();
    if (BLOCKED_UPSTREAM_HEADERS.has(lower)) continue;
    if (/\r|\n/.test(name) || /\r|\n/.test(String(value))) continue;
    headers.set(lower, String(value));
  }
};

const directoryHints = (request) => {
  const hints = readRequestDirectoryHints(request);
  const headers = request?.headers;
  if (headers && typeof headers.forEach === 'function') {
    for (const name of ['x-opencode-directory', 'x-openchamber-directory']) {
      const value = headers.get(name);
      if (typeof value === 'string' && value.length > 0 && !hints.includes(value)) hints.push(value);
    }
  }
  return hints;
};

const appendQuery = (pathname, query) => {
  if (!query || typeof query !== 'object') return pathname;
  const params = new URLSearchParams();
  for (const [name, rawValue] of Object.entries(query)) {
    if (name === 'oc_url_token') continue;
    if (Array.isArray(rawValue)) {
      for (const value of rawValue) params.append(name, String(value));
    } else if (rawValue !== undefined && rawValue !== null) {
      params.append(name, String(rawValue));
    }
  }
  const encoded = params.toString();
  return encoded ? `${pathname}?${encoded}` : pathname;
};

/** Raw query append used ONLY for the upstream URL token supplied by the
 * credential provider. The provider's `oc_url_token` is an upstream
 * credential, so it must not be stripped like the control-plane token in
 * `appendQuery`. */
const appendRawQuery = (pathname, query) => {
  if (!query || typeof query !== 'object') return pathname;
  const params = new URLSearchParams();
  for (const [name, rawValue] of Object.entries(query)) {
    if (Array.isArray(rawValue)) {
      for (const value of rawValue) params.append(name, String(value));
    } else if (rawValue !== undefined && rawValue !== null) {
      params.append(name, String(rawValue));
    }
  }
  const encoded = params.toString();
  return encoded ? `${pathname}?${encoded}` : pathname;
};

const descriptorFromCredential = async (context) => {
  const target = context?.profile?.target;
  if (target?.kind !== 'relay' || typeof target.relayId !== 'string' || !target.relayId) {
    throw relayError('relay_profile_invalid', 500, 'Relay connection profile is invalid');
  }
  const provider = context?.credentialProvider;
  if (!provider || typeof provider.resolveCredential !== 'function') {
    throw relayError('relay_credentials_unavailable', 503, 'Relay credentials are unavailable');
  }
  let credential;
  try {
    credential = await provider.resolveCredential(target.credentialRef);
  } catch {
    throw relayError('relay_credentials_unavailable', 503, 'Relay credentials are unavailable');
  }
  const relay = credential?.relay && typeof credential.relay === 'object'
    ? credential.relay
    : credential;
  const relayUrl = typeof relay?.relayUrl === 'string' ? relay.relayUrl.trim() : '';
  const serverId = typeof relay?.serverId === 'string' && relay.serverId.length > 0
    ? relay.serverId
    : target.relayId;
  if (!/^wss?:\/\//i.test(relayUrl) || serverId !== target.relayId || !isValidJwk(relay?.hostEncPubJwk)) {
    throw relayError('relay_credentials_invalid', 503, 'Relay connection credentials are invalid');
  }
  return {
    relayUrl,
    serverId,
    hostEncPubJwk: relay.hostEncPubJwk,
    grant: typeof relay.grant === 'string' && relay.grant.length > 0 ? relay.grant : undefined,
    token: typeof credential?.token === 'string' ? credential.token : (typeof credential?.clientToken === 'string' ? credential.clientToken : ''),
    headers: credential?.headers,
    urlToken: typeof credential?.urlToken === 'string' ? credential.urlToken : '',
  };
};

export const createRelayProjectAdapter = (dependencies = {}) => {
  const {
    connectionId,
    createTunnelClient = createRelayTunnelClient,
    tunnelOptions = {},
  } = dependencies;
  if (typeof connectionId !== 'string' || connectionId.length === 0) {
    throw new Error('relay adapter requires a connectionId');
  }

  let tunnelState = null;

  const getResolvedConnection = async (context) => {
    const resolved = await descriptorFromCredential(context);
    const key = `${resolved.relayUrl}\0${resolved.serverId}\0${JSON.stringify(resolved.hostEncPubJwk)}\0${resolved.grant ?? ''}`;
    if (!tunnelState || tunnelState.key !== key) {
      tunnelState?.tunnel?.close();
      tunnelState = {
        key,
        tunnel: createTunnelClient({
          ...tunnelOptions,
          relayUrl: resolved.relayUrl,
          serverId: resolved.serverId,
          connectionId,
          hostEncPubJwk: resolved.hostEncPubJwk,
          ...(resolved.grant ? { grant: resolved.grant } : {}),
        }),
      };
    }
    return { ...resolved, tunnel: tunnelState.tunnel };
  };

  const buildHeaders = async (context, sourceHeaders) => {
    const resolved = await getResolvedConnection(context);
    const headers = new Headers();
    copySourceHeaders(sourceHeaders, headers);
    if (resolved.token) headers.set('authorization', `Bearer ${resolved.token}`);
    copyCredentialHeaders(resolved, headers);
    return { resolved, headers };
  };

  const assertProjectDirectory = (context, request, headers) => {
    const canonicalPath = context?.canonicalPath;
    if (!canonicalPath) return;
    for (const hint of directoryHints(request)) {
      if (!isPathWithinProject(canonicalPath, hint)) {
        throw relayError('catalog_path_outside_project', 403, 'directory is outside the project');
      }
    }
    const bodyDirectory = request?.body && typeof request.body === 'object' && !Buffer.isBuffer(request.body)
      ? request.body.directory
      : undefined;
    if (typeof bodyDirectory === 'string' && bodyDirectory.length > 0 && !isPathWithinProject(canonicalPath, bodyDirectory)) {
      throw relayError('catalog_path_outside_project', 403, 'directory is outside the project');
    }
    headers.set('x-opencode-directory', canonicalPath);
    headers.set('x-openchamber-directory', canonicalPath);
    headers.set('x-openchamber-directory-encoding', 'none');
  };

  const canonicalizePath = async (_context, inputPath) => normalizeRemotePath(inputPath);

  const probe = async (context) => {
    try {
      const { resolved, headers } = await buildHeaders(context, null);
      const response = await resolved.tunnel.fetch('/health', { method: 'GET', headers });
      if (response.ok || response.status === 401 || response.status === 403) {
        return {
          ok: true,
          canonicalPath: null,
          capabilities: { ...RELAY_CAPABILITIES },
          ...(response.status === 401 || response.status === 403 ? { authRequired: true } : {}),
        };
      }
      return {
        ok: false,
        canonicalPath: null,
        error: { code: 'relay_wrong_service', message: `Unexpected upstream response (${response.status})` },
      };
    } catch (error) {
      // Typed failures the adapter itself raises carry safe messages;
      // anything else (including tunnel-internal errors whose messages can
      // wrap transport details) stays generic so inner relay internals never
      // reach the authenticated response.
      const code = typeof error?.code === 'string' && error.code.length > 0
        ? error.code
        : 'relay_unreachable';
      const messagePasses = SELF_TYPED_PROBE_ERROR_CODES.has(code)
        && typeof error?.message === 'string'
        && error.message.length > 0;
      return {
        ok: false,
        canonicalPath: null,
        error: {
          code,
          message: messagePasses ? error.message : 'Relay server is unreachable',
        },
      };
    }
  };

  const listChildren = async (context, directoryPath) => {
    const directory = normalizeRemotePath(directoryPath);
    if (context?.canonicalPath && !isPathWithinProject(context.canonicalPath, directory)) {
      throw relayError('catalog_path_outside_project', 403, 'directory is outside the project');
    }
    const { resolved, headers } = await buildHeaders(context, null);
    headers.set('x-openchamber-directory', directory);
    headers.set('x-opencode-directory', directory);
    headers.set('accept', 'application/json');
    const response = await resolved.tunnel.fetch(appendQuery('/api/fs/list', { path: directory }), { method: 'GET', headers });
    if (!response.ok) {
      throw relayError(
        response.status === 404 ? 'catalog_path_not_found' : 'catalog_path_not_accessible',
        response.status === 404 ? 404 : 502,
        `Remote directory listing failed (${response.status})`,
      );
    }
    let payload;
    try { payload = await response.json(); } catch {
      throw relayError('catalog_path_not_accessible', 502, 'Remote directory listing returned an invalid payload');
    }
    const entries = Array.isArray(payload) ? payload : (Array.isArray(payload?.entries) ? payload.entries : null);
    if (!entries) throw relayError('catalog_path_not_accessible', 502, 'Remote directory listing returned an invalid payload');
    return {
      directory,
      children: entries
        .filter((entry) => entry && typeof entry === 'object' && typeof entry.path === 'string' && typeof entry.name === 'string')
        .map((entry) => ({
          name: entry.name,
          path: entry.path,
          kind: entry.isDirectory ? 'directory' : (entry.isFile ? 'file' : 'other'),
        })),
    };
  };

  const fetch = async (context, request, restPath) => {
    const scopedRestPath = scopeProjectDirectoryListRequest(context?.canonicalPath, restPath);
    const { resolved, headers } = await buildHeaders(context, request?.headers);
    assertProjectDirectory(context, request, headers);
    if (context?.canonicalPath) {
      for (const hint of readRequestProjectPathHints(scopedRestPath, request)) {
        if (!isPathWithinProject(context.canonicalPath, hint)) {
          throw relayError('catalog_path_outside_project', 403, 'path is outside the project');
        }
      }
    }
    const method = request?.method ?? 'GET';
    let body;
    if (method !== 'GET' && method !== 'HEAD' && request?.body !== undefined && request.body !== null) {
      body = request.body;
      if (typeof body === 'object' && !Buffer.isBuffer(body) && typeof body?.[Symbol.asyncIterator] !== 'function') {
        body = JSON.stringify(body);
        if (!headers.has('content-type')) headers.set('content-type', 'application/json');
      }
    }
    return resolved.tunnel.fetch(scopedRestPath, {
      method,
      headers,
      body,
      signal: request?.signal,
    });
  };

  const openEventStream = async (context, restPath, signal) => {
    const { resolved, headers } = await buildHeaders(context, { headers: new Headers({ accept: 'text/event-stream' }) });
    headers.set('accept', 'text/event-stream');
    const response = await resolved.tunnel.fetch(restPath, { method: 'GET', headers, signal });
    if (!response.ok || !response.body) {
      throw relayError('capability_unavailable', 502, `Event stream unavailable (${response.status})`);
    }
    return response;
  };

  const openWebSocket = async (context, request = {}) => {
    const pathname = getWsPathname(request.path);
    if (!pathname.startsWith('/api/')) {
      throw relayError('catalog_runtime_path_not_allowed', 404, 'Path is not a forwardable project socket');
    }
    const { resolved, headers } = await buildHeaders(context, request.headers);
    assertProjectDirectory(context, request, headers);
    if (resolved.urlToken) {
      // URL auth is short-lived and may be supplied by a credential provider
      // when the remote server does not accept bearer auth on WS upgrades.
      const query = { ...(request.query ?? {}), oc_url_token: resolved.urlToken };
      return { socket: resolved.tunnel.openWebSocket(appendRawQuery(pathname, query), undefined, objectifyHeaders(headers)) };
    }
    return { socket: resolved.tunnel.openWebSocket(appendQuery(pathname, request.query), undefined, objectifyHeaders(headers)) };
  };

  const dispose = async () => {
    tunnelState?.tunnel?.close();
    tunnelState = null;
  };

  return {
    kind: 'relay',
    connectionId,
    capabilities: { ...RELAY_CAPABILITIES },
    canonicalizePath,
    probe,
    listChildren,
    fetch,
    openEventStream,
    openWebSocket,
    dispose,
  };
};
