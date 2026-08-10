/**
 * Electron workspace connection adapter (SSH).
 *
 * Bridges the in-process web server's Connection Broker to ssh-manager-owned
 * tunnels WITHOUT importing packages/web from packages/electron (the reverse
 * direction is forbidden): the main process builds one adapter instance per
 * saved SSH connection and passes them to startWebUiServer via
 * `workspaceConnectionAdapters`.
 *
 * Security contract:
 * - The adapter forwards ONLY to `localUrl` values produced by ssh-manager
 *   for the SAVED sshInstanceId — never to caller-supplied URLs. Tunnel
 *   URLs are loopback (trusted, main-process-owned), so the direct adapter's
 *   SSRF gate is not applied here; the renderer still never sees the tunnel
 *   URL or any SSH material.
 * - Request headers from the browser are forwarded except blocked auth
 *   headers; the local OpenChamber server behind the tunnel authenticates
 *   with the tunnel's own clientToken when the SSH-managed runtime provides
 *   one.
 * - `dispose()` never tears down the tunnel: ssh-manager remains the single
 *   lifecycle owner. The adapter only releases its lease.
 */

const BLOCKED_UPSTREAM_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-openchamber-client-token',
  'x-openchamber-runtime-headers',
  'x-openchamber-url-token',
]);

export const createSshWorkspaceConnectionAdapter = (dependencies) => {
  const {
    connectionId,
    label,
    sshInstanceId,
    sshManager,
    fetchImpl = typeof fetch === 'function' ? fetch : null,
  } = dependencies;

  if (!sshManager || typeof sshManager.statusesWithDefaults !== 'function') {
    throw new Error('ssh adapter requires an ssh-manager-compatible lifecycle owner');
  }

  const resolveTunnelUrl = async (sshInstanceId) => {
    const statuses = await sshManager.statusesWithDefaults(sshInstanceId);
    const status = statuses?.[sshInstanceId] ?? null;
    if (!status || status.status !== 'connected' || typeof status.localUrl !== 'string' || status.localUrl.length === 0) {
      const error = new Error('SSH tunnel is not connected');
      error.code = 'capability_unavailable';
      error.status = 503;
      throw error;
    }
    return status.localUrl.replace(/\/+$/, '');
  };

  const buildUpstreamHeaders = (sourceHeaders, clientToken) => {
    const headers = new Headers();
    if (sourceHeaders && typeof sourceHeaders.forEach === 'function') {
      sourceHeaders.forEach((value, name) => {
        if (!BLOCKED_UPSTREAM_HEADERS.has(name.toLowerCase())) headers.set(name, value);
      });
    }
    if (clientToken) headers.set('authorization', `Bearer ${clientToken}`);
    return headers;
  };

  const canonicalizePath = async (_context, inputPath) => {
    // Remote paths under SSH follow the TARGET server's semantics; the
    // control plane only trims trivially, exactly like the direct adapter.
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

  const probe = async (context, _inputPath) => {
    try {
      const baseUrl = await resolveTunnelUrl(context?.profile?.target?.sshInstanceId);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetchImpl(`${baseUrl}/health`, { method: 'GET', signal: controller.signal });
        if (response.ok || response.status === 401 || response.status === 403) {
          return {
            ok: true,
            canonicalPath: null,
            capabilities: { pathBrowse: true, terminal: true, files: true, git: true, eventStream: true },
          };
        }
        return { ok: false, canonicalPath: null, error: { code: 'ssh_wrong_service', message: `Unexpected tunnel response (${response.status})` } };
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      return {
        ok: false,
        canonicalPath: null,
        error: {
          code: error?.code === 'capability_unavailable' ? 'ssh_tunnel_not_connected' : 'ssh_unreachable',
          message: error?.message ?? 'SSH tunnel is unreachable',
        },
      };
    }
  };

  const listChildren = async (context, directoryPath) => {
    const baseUrl = await resolveTunnelUrl(context?.profile?.target?.sshInstanceId);
    const headers = buildUpstreamHeaders(null, context?.profile?.target?.clientToken);
    headers.set('x-openchamber-directory', String(directoryPath).replace(/\\/g, '/').replace(/\/+$/, ''));
    headers.set('accept', 'application/json');
    const response = await fetchImpl(`${baseUrl}/api/fs/list`, { method: 'GET', headers });
    if (!response.ok) {
      const error = new Error(`Remote directory listing failed (${response.status})`);
      error.code = response.status === 404 ? 'catalog_path_not_found' : 'catalog_path_not_accessible';
      error.status = response.status === 404 ? 404 : 502;
      throw error;
    }
    const payload = await response.json();
    const entries = Array.isArray(payload) ? payload : (Array.isArray(payload?.entries) ? payload.entries : null);
    if (!entries) {
      const error = new Error('Remote directory listing returned an invalid payload');
      error.code = 'catalog_path_not_accessible';
      error.status = 502;
      throw error;
    }
    return {
      directory: String(directoryPath).replace(/\/+$/, ''),
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
    const baseUrl = await resolveTunnelUrl(context?.profile?.target?.sshInstanceId);
    const headers = buildUpstreamHeaders(request?.headers, context?.profile?.target?.clientToken);
    let body;
    const method = request?.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD' && request?.body !== undefined && request.body !== null) {
      if (typeof request.body === 'string' || Buffer.isBuffer(request.body)) {
        body = request.body;
      } else if (typeof request.body === 'object') {
        body = JSON.stringify(request.body);
        if (!headers.has('content-type')) headers.set('content-type', 'application/json');
      }
    }
    return fetchImpl(`${baseUrl}${restPath}`, {
      method,
      headers,
      body,
      signal: request?.signal,
    });
  };

  const openEventStream = async (context, restPath, signal) => {
    const baseUrl = await resolveTunnelUrl(context?.profile?.target?.sshInstanceId);
    const headers = buildUpstreamHeaders(null, context?.profile?.target?.clientToken);
    headers.set('accept', 'text/event-stream');
    const response = await fetchImpl(`${baseUrl}${restPath}`, { method: 'GET', headers, signal });
    if (!response.ok || !response.body) {
      const error = new Error(`Event stream unavailable (${response.status})`);
      error.code = 'capability_unavailable';
      error.status = 502;
      throw error;
    }
    return response;
  };

  const openWebSocket = async () => {
    const error = new Error('WebSocket forwarding for SSH tunnels is not wired yet');
    error.code = 'capability_unavailable';
    error.status = 501;
    throw error;
  };

  const dispose = async () => {
    // Tunnel lifecycle stays with ssh-manager; nothing to tear down here.
  };

  return {
    kind: 'ssh',
    connectionId,
    label,
    sshInstanceId,
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
