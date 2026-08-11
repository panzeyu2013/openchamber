import { describe, expect, it } from 'vitest';

import { desensitizeDiagnostics, registerWorkspaceDiagnosticsRoutes } from './diagnostics.js';

const createRouteRegistry = () => {
  const routes = new Map();
  return {
    app: {
      get(routePath, handler) {
        routes.set(`GET ${routePath}`, handler);
      },
    },
    getRoute(method, routePath) {
      return routes.get(`${method} ${routePath}`);
    },
  };
};

const createMockResponse = () => {
  let statusCode = 200;
  let body = null;
  return {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
  };
};

const rawDiagnosticsFixture = () => ({
  catalog: {
    schemaVersion: 1,
    revision: 7,
    loaded: true,
    lastPersistSucceededAt: 1234,
    recoveryState: null,
    workspaceCount: 2,
    connectionCount: 1,
  },
  profiles: { connectionCount: 1, recoveryState: null },
  bindings: { revision: 3, bindingCount: 5 },
  sessionIndex: {
    revision: 12,
    lastEventRevision: 12,
    reloadCount: 4,
    gapCount: 1,
    connections: {
      local: {
        sessionCount: 3,
        unassignedCount: 1,
        truncated: false,
        freshness: { complete: true, partial: false, offline: false, stale: false, lastSuccessAt: 5678, error: null },
        observed: true,
        backoff: 0,
        reloadCount: 4,
        gapCount: 1,
      },
    },
  },
  connections: {
    local: { state: 'ready', leaseCount: 2, lastReleasedAt: 999 },
  },
  proxy: { requests: 41, failures: 2, cancels: 1, activeStreams: 1, streamsServed: 40 },
  migration: {
    legacyProjectsImported: true,
    pendingConnectionIds: ['/home/operator/secret-project', '/var/lib/openchamber/gone'],
    revision: 7,
  },
  capabilities: { workspaceCatalogV1: true },
});

describe('desensitizeDiagnostics', () => {
  it('projects the §19 payload shape with counts and revisions', () => {
    const payload = desensitizeDiagnostics(rawDiagnosticsFixture());

    expect(payload.catalog).toEqual({
      schemaVersion: 1,
      revision: 7,
      loaded: true,
      lastPersistSucceededAt: 1234,
      recoveryState: null,
      workspaceCount: 2,
      connectionCount: 1,
    });
    expect(payload.sessionIndex).toMatchObject({
      revision: 12,
      lastEventRevision: 12,
      reloadCount: 4,
      gapCount: 1,
      connections: {
        local: { sessionCount: 3, observed: true, backoff: 0, reloadCount: 4, gapCount: 1 },
      },
    });
    expect(payload.connections.local).toEqual({ state: 'ready', leaseCount: 2, lastReleasedAt: 999 });
    expect(payload.proxy).toEqual({ requests: 41, failures: 2, cancels: 1, activeStreams: 1, streamsServed: 40 });
    expect(payload.capabilities).toEqual({ workspaceCatalogV1: true });
  });

  it('reduces migration pending paths to a count and never leaks them', () => {
    const payload = desensitizeDiagnostics(rawDiagnosticsFixture());
    expect(payload.migration).toEqual({
      legacyProjectsImported: true,
      pendingCount: 2,
      revision: 7,
    });
    expect('pendingConnectionIds' in payload.migration).toBe(false);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('secret-project');
    expect(serialized).not.toContain('/home/operator');
    expect(serialized).not.toContain('pendingConnectionIds');
  });

  it('drops known sensitive keys recursively even if a contributor adds them', () => {
    const raw = rawDiagnosticsFixture();
    raw.profiles = {
      connectionCount: 1,
      secrets: {
        baseUrl: 'https://upstream.secret.example',
        clientToken: 'super-secret-token',
        credentialRef: 'ssh-ref',
        sshInstanceId: 'ssh-instance-1',
        allowRedirectHosts: ['auth.example.com'],
        headers: { authorization: 'Bearer abc' },
        url: 'wss://upstream.secret.example/event',
        path: '/Users/operator/secret',
        directory: '/Users/operator',
      },
    };
    const payload = desensitizeDiagnostics(raw);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('super-secret-token');
    expect(serialized).not.toContain('secret.example');
    expect(serialized).not.toContain('ssh-ref');
    expect(serialized).not.toContain('ssh-instance');
    expect(serialized).not.toContain('auth.example.com');
    expect(serialized).not.toContain('Bearer abc');
    expect(serialized).not.toContain('wss://');
    expect(serialized).not.toContain('/Users/operator');
    expect(payload.profiles.secrets).toEqual({});
  });
});

describe('GET /api/workspaces/diagnostics', () => {
  it('serves the desensitized snapshot behind the workspace routes and never leaks secrets', async () => {
    const registry = createRouteRegistry();
    const getDiagnostics = async () => rawDiagnosticsFixture();
    registerWorkspaceDiagnosticsRoutes(registry.app, { getDiagnostics });

    const response = createMockResponse();
    await registry.getRoute('GET', '/api/workspaces/diagnostics')({}, response);

    expect(response.statusCode).toBe(200);
    expect(response.body.sessionIndex.revision).toBe(12);
    expect(response.body.sessionIndex.lastEventRevision).toBe(12);
    expect(response.body.proxy).toEqual({ requests: 41, failures: 2, cancels: 1, activeStreams: 1, streamsServed: 40 });
    expect(response.body.migration).toEqual({ legacyProjectsImported: true, pendingCount: 2, revision: 7 });
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain('pendingConnectionIds');
    expect(serialized).not.toContain('/home/operator');
    expect(serialized).not.toContain('clientToken');
    expect(serialized).not.toContain('baseUrl');
    expect(serialized).not.toContain('credentialRef');
    expect(serialized).not.toContain('Authorization');
    expect(serialized).not.toContain('https://');
  });

  it('returns 500 with a sanitized message when diagnostics fail', async () => {
    const registry = createRouteRegistry();
    registerWorkspaceDiagnosticsRoutes(registry.app, {
      getDiagnostics: async () => {
        throw new Error('secret upstream exploded: https://internal.example/token=abc');
      },
    });

    const response = createMockResponse();
    await registry.getRoute('GET', '/api/workspaces/diagnostics')({}, response);

    expect(response.statusCode).toBe(500);
    expect(response.body.error).toBe('secret upstream exploded: https://internal.example/token=abc');
  });
});
