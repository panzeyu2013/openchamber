import { beforeEach, describe, expect, test } from 'bun:test';
import {
  createWorkspace,
  deleteWorkspace,
  fetchCatalogSnapshot,
  fetchWorkspaceCapabilities,
  listConnectionChildren,
  probeConnection,
  probeWorkspace,
  updateWorkspace,
} from './catalog-client';
import { CatalogClientError, type WorkspaceCatalogSnapshot, type WorkspaceDescriptor } from './types';

let runtimeFetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
const runtimeFetchCalls: Array<{ url: string; init?: RequestInit }> = [];

// The catalog client fetches through the control-plane-pinned fetch, which
// calls the global fetch at request time; stub that instead of the module.
// The stub is re-registered in beforeEach so a shared-process directory run
// always sees this file's stub for its own tests.
const headersToObject = (headers: HeadersInit | undefined): Record<string, string> | undefined => {
  if (!headers) return undefined;
  const result: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    result[key] = value;
  });
  return result;
};

const stubGlobalFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const raw = url instanceof Request ? url.url : String(url);
  runtimeFetchCalls.push({ url: raw, init: init ? { ...init, headers: headersToObject(init.headers) } : undefined });
  return runtimeFetchImpl(raw, init);
};

globalThis.fetch = stubGlobalFetch;

const jsonResponse = (body: unknown, status = 200): Response => (
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
);

const snapshotFixture: WorkspaceCatalogSnapshot = {
  schemaVersion: 1,
  revision: 1,
  connections: [],
  workspaces: [],
  migration: { legacyProjectsImported: true, pendingConnectionIds: [] },
};

const descriptorFixture: WorkspaceDescriptor = {
  id: 'ws-1',
  connectionId: 'conn-1',
  path: '/home/me',
  canonicalPath: '/home/me',
  label: 'Me',
  orderKey: 'order-1',
  createdAt: 1000,
  updatedAt: 1000,
};

const captureError = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return null;
};

describe('workspace catalog client', () => {
  beforeEach(() => {
    runtimeFetchCalls.length = 0;
    runtimeFetchImpl = async () => jsonResponse({});
    globalThis.fetch = stubGlobalFetch;
  });

  test('fetchCatalogSnapshot returns the parsed snapshot', async () => {
    runtimeFetchImpl = async () => jsonResponse(snapshotFixture);
    expect(await fetchCatalogSnapshot()).toEqual(snapshotFixture);
  });

  test('fetchCatalogSnapshot throws CatalogClientError carrying status/code/message when the response is not ok', async () => {
    runtimeFetchImpl = async () => jsonResponse({ error: 'Catalog exploded', code: 'catalog_internal_error' }, 500);
    const caught = await captureError(() => fetchCatalogSnapshot());
    expect(caught).toBeInstanceOf(CatalogClientError);
    const error = caught as CatalogClientError;
    expect(error.status).toBe(500);
    expect(error.code).toBe('catalog_internal_error');
    expect(error.message).toBe('Catalog exploded');
  });

  test('fetchCatalogSnapshot rejects a body without a workspaces array', async () => {
    runtimeFetchImpl = async () => jsonResponse({ schemaVersion: 1, revision: 1 });
    const caught = await captureError(() => fetchCatalogSnapshot());
    expect(caught).toBeInstanceOf(CatalogClientError);
    expect((caught as CatalogClientError).status).toBe(500);
    expect((caught as CatalogClientError).code).toBe('catalog_invalid_response');
  });

  test('createWorkspace POSTs JSON and returns the mutation result', async () => {
    const input = { connectionId: 'conn-1', path: '/home/me', label: 'Me' };
    runtimeFetchImpl = async () => jsonResponse({ workspace: descriptorFixture, revision: 2, created: true });
    const result = await createWorkspace(input);
    expect(result).toEqual({ workspace: descriptorFixture, revision: 2, created: true });
    expect(runtimeFetchCalls).toHaveLength(1);
    expect(runtimeFetchCalls[0].url).toBe('/api/workspaces');
    expect(runtimeFetchCalls[0].init?.method).toBe('POST');
    expect(runtimeFetchCalls[0].init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(runtimeFetchCalls[0].init?.body).toBe(JSON.stringify(input));
  });

  test('createWorkspace surfaces a 409 catalog_revision_conflict', async () => {
    runtimeFetchImpl = async () => jsonResponse({ error: 'Catalog revision conflict', code: 'catalog_revision_conflict' }, 409);
    const caught = await captureError(() => createWorkspace({ connectionId: 'conn-1', path: '/home/me' }));
    expect(caught).toBeInstanceOf(CatalogClientError);
    const error = caught as CatalogClientError;
    expect(error.status).toBe(409);
    expect(error.code).toBe('catalog_revision_conflict');
    expect(error.message).toBe('Catalog revision conflict');
  });

  test('updateWorkspace sends If-Match and the encoded workspace id', async () => {
    const updated = { ...descriptorFixture, label: 'Renamed', updatedAt: 2000 };
    runtimeFetchImpl = async () => jsonResponse({ workspace: updated, revision: 3 });
    const result = await updateWorkspace('ws/1', { label: 'Renamed' }, 3);
    expect(result).toEqual({ workspace: updated, revision: 3 });
    expect(runtimeFetchCalls).toHaveLength(1);
    expect(runtimeFetchCalls[0].url).toBe('/api/workspaces/ws%2F1');
    expect(runtimeFetchCalls[0].init?.method).toBe('PATCH');
    const headers = runtimeFetchCalls[0].init?.headers as Record<string, string>;
    expect(headers['if-match']).toBe('3');
    expect(headers['content-type']).toBe('application/json');
    expect(runtimeFetchCalls[0].init?.body).toBe(JSON.stringify({ label: 'Renamed' }));
  });

  test('deleteWorkspace returns the new revision', async () => {
    runtimeFetchImpl = async () => jsonResponse({ revision: 4 });
    expect(await deleteWorkspace('ws-1', 2)).toBe(4);
    expect(runtimeFetchCalls).toHaveLength(1);
    expect(runtimeFetchCalls[0].url).toBe('/api/workspaces/ws-1');
    expect(runtimeFetchCalls[0].init?.method).toBe('DELETE');
    const headers = runtimeFetchCalls[0].init?.headers as Record<string, string>;
    expect(headers['if-match']).toBe('2');
  });

  test('listConnectionChildren encodes the path query parameter', async () => {
    runtimeFetchImpl = async () => jsonResponse({ directory: '/home/user', children: [] });
    const result = await listConnectionChildren('conn-1', '/home/user/My Docs');
    expect(result).toEqual({ directory: '/home/user', children: [] });
    expect(runtimeFetchCalls[0].url).toBe('/api/connections/conn-1/children?path=%2Fhome%2Fuser%2FMy%20Docs');
    expect(runtimeFetchCalls[0].url).not.toContain('path=/home');
  });

  test('probeWorkspace and probeConnection pass through valid probe shapes', async () => {
    const workspaceProbe = { ok: true, canonicalPath: '/home/me' };
    runtimeFetchImpl = async () => jsonResponse(workspaceProbe);
    expect(await probeWorkspace('ws-1')).toEqual(workspaceProbe);
    expect(runtimeFetchCalls[0].url).toBe('/api/workspaces/ws-1/probe');
    expect(runtimeFetchCalls[0].init?.method).toBe('POST');

    runtimeFetchCalls.length = 0;
    const connectionProbe = { ok: false, canonicalPath: null, error: { code: 'not_found', message: 'Nope' } };
    runtimeFetchImpl = async () => jsonResponse(connectionProbe);
    expect(await probeConnection('conn-1')).toEqual(connectionProbe);
    expect(runtimeFetchCalls[0].url).toBe('/api/connections/conn-1/probe');
    expect(runtimeFetchCalls[0].init?.method).toBe('POST');
  });

  test('probeWorkspace rejects a non-object response', async () => {
    runtimeFetchImpl = async () => jsonResponse(null);
    const caught = await captureError(() => probeWorkspace('ws-1'));
    expect(caught).toBeInstanceOf(CatalogClientError);
    expect((caught as CatalogClientError).code).toBe('catalog_invalid_response');
  });
});

describe('workspace catalog capabilities (plan §20)', () => {
  beforeEach(() => {
    runtimeFetchCalls.length = 0;
    runtimeFetchImpl = async () => jsonResponse({});
    globalThis.fetch = stubGlobalFetch;
  });

  test('fetchWorkspaceCapabilities reads the flag from the control plane capabilities route', async () => {
    runtimeFetchImpl = async () => jsonResponse({ workspaceCatalogV1: true });
    expect(await fetchWorkspaceCapabilities()).toEqual({ workspaceCatalogV1: true });
    expect(runtimeFetchCalls).toHaveLength(1);
    expect(runtimeFetchCalls[0].url).toBe('/api/workspaces/capabilities');
  });

  test('fetchWorkspaceCapabilities surfaces the disabled degradation state authoritatively', async () => {
    runtimeFetchImpl = async () => jsonResponse({ workspaceCatalogV1: false });
    expect(await fetchWorkspaceCapabilities()).toEqual({ workspaceCatalogV1: false });
    expect(runtimeFetchCalls[0].url).toBe('/api/workspaces/capabilities');
  });

  test('fetchWorkspaceCapabilities throws CatalogClientError on a server error (never a fabricated state)', async () => {
    runtimeFetchImpl = async () => jsonResponse({ error: 'Catalog exploded', code: 'catalog_internal_error' }, 500);
    const caught = await captureError(() => fetchWorkspaceCapabilities());
    expect(caught).toBeInstanceOf(CatalogClientError);
    const error = caught as CatalogClientError;
    expect(error.status).toBe(500);
    expect(error.code).toBe('catalog_internal_error');
  });

  test('fetchWorkspaceCapabilities rejects a payload without a boolean flag', async () => {
    runtimeFetchImpl = async () => jsonResponse({ workspaceCatalogV1: 'enabled' });
    const caught = await captureError(() => fetchWorkspaceCapabilities());
    expect(caught).toBeInstanceOf(CatalogClientError);
    expect((caught as CatalogClientError).code).toBe('catalog_invalid_response');
  });

  test('fetchWorkspaceCapabilities rejects a non-object response', async () => {
    runtimeFetchImpl = async () => jsonResponse(null);
    const caught = await captureError(() => fetchWorkspaceCapabilities());
    expect(caught).toBeInstanceOf(CatalogClientError);
    expect((caught as CatalogClientError).code).toBe('catalog_invalid_response');
  });
});
