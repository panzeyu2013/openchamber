import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { setControlPlane } from '@/lib/control-plane';
import { clearLastActiveSession, persistLastActiveSession } from '@/sync/last-session-cache';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { setControlPlaneOrigin } from '@/workspaces/control-plane-fetch';
import { useWorkspaceCatalogStore } from '@/workspaces/catalog-store';
import { useWorkspaceSessionIndexStore } from '@/workspaces/session-index-store';
import { workspaceSessionKey } from '@/workspaces/identity';
import type { WorkspaceCatalogSnapshot, WorkspaceSessionSnapshot, WorkspaceSessionSummary } from '@/workspaces/types';
import { refreshWorkspaceStateAfterResume } from './mobileWorkspaceResume';

// The clients fetch through the control-plane-pinned fetch calling the
// global fetch at request time; stub that and route by path (never
// mock.module, which is process-global and leaks into other suites).
const originalFetch = globalThis.fetch;

const stubControlPlaneFetch = async (input: string | URL | Request): Promise<Response> => {
  const raw = input instanceof Request ? input.url : String(input);
  const path = raw.startsWith('http') ? new URL(raw).pathname : raw;
  if (path === '/api/workspaces') return catalogBody();
  if (path === '/api/workspace-sessions/snapshot') return indexBody();
  return new Response(JSON.stringify({ error: 'Not found', code: 'catalog_http_error' }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });
};

const stubWindowOrigin = (origin: string): void => {
  const eventTarget = new EventTarget();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      location: { origin },
      dispatchEvent: (event: Event) => eventTarget.dispatchEvent(event),
      addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => eventTarget.addEventListener(type, listener),
    },
  });
};

const makeCatalogSnapshot = (): WorkspaceCatalogSnapshot => ({
  schemaVersion: 1,
  revision: 1,
  connections: [],
  workspaces: [],
  migration: { legacyProjectsImported: true, pendingConnectionIds: [] },
});

const makeIndexSession = (overrides: Partial<WorkspaceSessionSummary>): WorkspaceSessionSummary => {
  const session: WorkspaceSessionSummary = {
    key: '',
    workspaceId: 'ws-1',
    connectionId: 'conn-1',
    upstreamSessionId: 'ses-1',
    directory: '/home/a',
    title: 'Session 1',
    updatedAt: 1000,
    archived: false,
    createdAt: 1000,
    ...overrides,
  };
  return { ...session, key: session.key || workspaceSessionKey(session.workspaceId, session.upstreamSessionId) };
};

const makeIndexSnapshot = (sessions: WorkspaceSessionSummary[]): WorkspaceSessionSnapshot => ({
  revision: 1,
  sessions,
  freshnessByConnection: { 'conn-1': { complete: true, stale: false, lastSuccessAt: 1000, error: null } },
});

let catalogBody: () => Response;
let indexBody: () => Response;

describe('refreshWorkspaceStateAfterResume', () => {
  beforeEach(() => {
    stubWindowOrigin('capacitor://localhost');
    setControlPlaneOrigin(null);
    globalThis.fetch = stubControlPlaneFetch;
    // Establish the active runtime key so the persisted last-session entry is
    // read under the same scope the app would use.
    setControlPlane({ apiBaseUrl: 'http://192.168.1.5:3901', clientToken: null, runtimeKey: 'rt-1' });
    // The deferred storage is a process-wide singleton — clear the entry so
    // tests never read each other's persisted sessions.
    clearLastActiveSession('rt-1');
    useWorkspaceCatalogStore.setState({ snapshot: null, status: 'idle', lastError: null });
    useWorkspaceSessionIndexStore.setState({
      snapshot: null,
      status: 'idle',
      lastError: null,
      lastAppliedRevision: 0,
      sessionKeys: new Set(),
      revisionGap: false,
    });
    useSessionUIStore.getState().setCurrentSession(null);
    catalogBody = () => new Response(JSON.stringify(makeCatalogSnapshot()), { status: 200, headers: { 'content-type': 'application/json' } });
    indexBody = () => new Response(JSON.stringify(makeIndexSnapshot([])), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    setControlPlaneOrigin(null);
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  test('skips the workspace refresh when the control plane is unavailable', async () => {
    // Non-http webview origin + no explicit origin → no control plane.
    persistLastActiveSession('rt-1', { sessionId: 'ses-1', directory: '/home/a' });
    const outcome = await refreshWorkspaceStateAfterResume();
    expect(outcome).toEqual({ restored: false, reason: 'no-control-plane' });
    expect(useWorkspaceCatalogStore.getState().status).toBe('idle');
  });

  test('reports no-last-session when nothing is persisted', async () => {
    setControlPlaneOrigin('http://192.168.1.5:3901');
    const outcome = await refreshWorkspaceStateAfterResume();
    expect(outcome).toEqual({ restored: false, reason: 'no-last-session' });
  });

  test('a catalog failure is not empty success — skips with no-control-plane', async () => {
    setControlPlaneOrigin('http://192.168.1.5:3901');
    persistLastActiveSession('rt-1', { sessionId: 'ses-1', directory: '/home/a' });
    catalogBody = () => new Response(
      JSON.stringify({ error: 'Control plane is not available in this runtime', code: 'control_plane_unavailable' }),
      { status: 501, headers: { 'content-type': 'application/json' } },
    );
    const outcome = await refreshWorkspaceStateAfterResume();
    expect(outcome).toEqual({ restored: false, reason: 'no-control-plane' });
    expect(useWorkspaceCatalogStore.getState().status).toBe('error');
    expect(useWorkspaceCatalogStore.getState().snapshot).toBeNull();
  });

  test('a session-index failure skips the restore', async () => {
    setControlPlaneOrigin('http://192.168.1.5:3901');
    persistLastActiveSession('rt-1', { sessionId: 'ses-1', directory: '/home/a' });
    indexBody = () => new Response(
      JSON.stringify({ error: 'Control plane is not available in this runtime', code: 'control_plane_unavailable' }),
      { status: 501, headers: { 'content-type': 'application/json' } },
    );
    const outcome = await refreshWorkspaceStateAfterResume();
    expect(outcome).toEqual({ restored: false, reason: 'no-control-plane' });
    expect(useWorkspaceSessionIndexStore.getState().status).toBe('error');
  });

  test('a session not bound to a workspace keeps the legacy path', async () => {
    setControlPlaneOrigin('http://192.168.1.5:3901');
    persistLastActiveSession('rt-1', { sessionId: 'ses-ghost', directory: '/home/a' });
    indexBody = () => new Response(
      JSON.stringify(makeIndexSnapshot([makeIndexSession({ upstreamSessionId: 'ses-1' })])),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
    const outcome = await refreshWorkspaceStateAfterResume();
    expect(outcome).toEqual({ restored: false, reason: 'session-not-in-workspace-index' });
    expect(useSessionUIStore.getState().currentSessionId).toBeNull();
  });

  test('restores the last session through the workspace index', async () => {
    setControlPlaneOrigin('http://192.168.1.5:3901');
    persistLastActiveSession('rt-1', { sessionId: 'ses-1', directory: '/home/a' });
    indexBody = () => new Response(
      JSON.stringify(makeIndexSnapshot([makeIndexSession({ upstreamSessionId: 'ses-1', directory: '/home/a' })])),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
    const outcome = await refreshWorkspaceStateAfterResume();
    expect(outcome).toEqual({ restored: true, workspaceId: 'ws-1', sessionId: 'ses-1' });
    expect(useWorkspaceCatalogStore.getState().status).toBe('ready');
    expect(useWorkspaceSessionIndexStore.getState().status).toBe('ready');
    expect(useSessionUIStore.getState().currentSessionId).toBe('ses-1');
  });

  test('does not override an already-open session', async () => {
    setControlPlaneOrigin('http://192.168.1.5:3901');
    // Opening a session persists it as the last-active under the ambient
    // runtime scope — persist AFTER, so it records the OTHER session.
    useSessionUIStore.getState().setCurrentSession('ses-open', '/home/open');
    persistLastActiveSession('rt-1', { sessionId: 'ses-1', directory: '/home/a' });
    indexBody = () => new Response(
      JSON.stringify(makeIndexSnapshot([makeIndexSession({ upstreamSessionId: 'ses-1', directory: '/home/a' })])),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
    const outcome = await refreshWorkspaceStateAfterResume();
    expect(outcome).toEqual({ restored: true, workspaceId: 'ws-1', sessionId: 'ses-1' });
    expect(useSessionUIStore.getState().currentSessionId).toBe('ses-open');
  });
});
