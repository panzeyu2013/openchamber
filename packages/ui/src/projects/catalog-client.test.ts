import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  createProject,
  deleteProject,
  fetchCatalogSnapshot,
  fetchProjectCapabilities,
  listConnectionChildren,
  probeConnection,
  probeProject,
  updateProject,
} from './catalog-client';
import { CatalogClientError, type ProjectCatalogSnapshot, type ProjectDescriptor } from './types';

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

const originalFetch = globalThis.fetch;
globalThis.fetch = stubGlobalFetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

const jsonResponse = (body: unknown, status = 200): Response => (
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
);

const snapshotFixture: ProjectCatalogSnapshot = {
  schemaVersion: 1,
  revision: 1,
  connections: [],
  projects: [],
  migration: { legacyProjectsImported: true, pendingConnectionIds: [] },
};

const descriptorFixture: ProjectDescriptor = {
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

describe('project catalog client', () => {
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

  test('fetchCatalogSnapshot rejects a body without a projects array', async () => {
    runtimeFetchImpl = async () => jsonResponse({ schemaVersion: 1, revision: 1 });
    const caught = await captureError(() => fetchCatalogSnapshot());
    expect(caught).toBeInstanceOf(CatalogClientError);
    expect((caught as CatalogClientError).status).toBe(500);
    expect((caught as CatalogClientError).code).toBe('catalog_invalid_response');
  });

  test('createProject POSTs JSON and returns the mutation result', async () => {
    const input = { connectionId: 'conn-1', path: '/home/me', label: 'Me' };
    runtimeFetchImpl = async () => jsonResponse({ project: descriptorFixture, revision: 2, created: true });
    const result = await createProject(input);
    expect(result).toEqual({ project: descriptorFixture, revision: 2, created: true });
    expect(runtimeFetchCalls).toHaveLength(1);
    expect(runtimeFetchCalls[0].url).toBe('/api/projects');
    expect(runtimeFetchCalls[0].init?.method).toBe('POST');
    expect(runtimeFetchCalls[0].init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(runtimeFetchCalls[0].init?.body).toBe(JSON.stringify(input));
  });

  test('createProject surfaces a 409 catalog_revision_conflict', async () => {
    runtimeFetchImpl = async () => jsonResponse({ error: 'Catalog revision conflict', code: 'catalog_revision_conflict' }, 409);
    const caught = await captureError(() => createProject({ connectionId: 'conn-1', path: '/home/me' }));
    expect(caught).toBeInstanceOf(CatalogClientError);
    const error = caught as CatalogClientError;
    expect(error.status).toBe(409);
    expect(error.code).toBe('catalog_revision_conflict');
    expect(error.message).toBe('Catalog revision conflict');
  });

  test('updateProject sends If-Match and the encoded project id', async () => {
    const updated = { ...descriptorFixture, label: 'Renamed', updatedAt: 2000 };
    runtimeFetchImpl = async () => jsonResponse({ project: updated, revision: 3 });
    const result = await updateProject('ws/1', { label: 'Renamed' }, 3);
    expect(result).toEqual({ project: updated, revision: 3 });
    expect(runtimeFetchCalls).toHaveLength(1);
    expect(runtimeFetchCalls[0].url).toBe('/api/projects/ws%2F1');
    expect(runtimeFetchCalls[0].init?.method).toBe('PATCH');
    const headers = runtimeFetchCalls[0].init?.headers as Record<string, string>;
    expect(headers['if-match']).toBe('3');
    expect(headers['content-type']).toBe('application/json');
    expect(runtimeFetchCalls[0].init?.body).toBe(JSON.stringify({ label: 'Renamed' }));
  });

  test('deleteProject returns the new revision', async () => {
    runtimeFetchImpl = async () => jsonResponse({ revision: 4 });
    expect(await deleteProject('ws-1', 2)).toBe(4);
    expect(runtimeFetchCalls).toHaveLength(1);
    expect(runtimeFetchCalls[0].url).toBe('/api/projects/ws-1');
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

  test('probeProject and probeConnection pass through valid probe shapes', async () => {
    const projectProbe = { ok: true, canonicalPath: '/home/me' };
    runtimeFetchImpl = async () => jsonResponse(projectProbe);
    expect(await probeProject('ws-1')).toEqual(projectProbe);
    expect(runtimeFetchCalls[0].url).toBe('/api/projects/ws-1/probe');
    expect(runtimeFetchCalls[0].init?.method).toBe('POST');

    runtimeFetchCalls.length = 0;
    const connectionProbe = { ok: false, canonicalPath: null, error: { code: 'not_found', message: 'Nope' } };
    runtimeFetchImpl = async () => jsonResponse(connectionProbe);
    const result = await probeConnection('conn-1');
    expect(result.ok).toBe(false);
    expect(result.error).toEqual({ code: 'not_found', message: 'Nope' });
    expect(typeof result.latencyMs).toBe('number');
    expect(runtimeFetchCalls[0].url).toBe('/api/connections/conn-1/probe');
    expect(runtimeFetchCalls[0].init?.method).toBe('POST');
  });

  test('probeConnection carries latency and authRequired from a successful probe', async () => {
    runtimeFetchImpl = async () => jsonResponse({ ok: true, canonicalPath: null, authRequired: true });
    const result = await probeConnection('conn-1');
    expect(result.ok).toBe(true);
    expect(result.authRequired).toBe(true);
    expect(typeof result.latencyMs).toBe('number');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test('probeProject rejects a non-object response', async () => {
    runtimeFetchImpl = async () => jsonResponse(null);
    const caught = await captureError(() => probeProject('ws-1'));
    expect(caught).toBeInstanceOf(CatalogClientError);
    expect((caught as CatalogClientError).code).toBe('catalog_invalid_response');
  });
});

describe('project catalog capabilities (plan §20)', () => {
  beforeEach(() => {
    runtimeFetchCalls.length = 0;
    runtimeFetchImpl = async () => jsonResponse({});
    globalThis.fetch = stubGlobalFetch;
  });

  test('fetchProjectCapabilities reads the flag from the control plane capabilities route', async () => {
    runtimeFetchImpl = async () => jsonResponse({ projectCatalogV1: true });
    expect(await fetchProjectCapabilities()).toEqual({ projectCatalogV1: true });
    expect(runtimeFetchCalls).toHaveLength(1);
    expect(runtimeFetchCalls[0].url).toBe('/api/projects/capabilities');
  });

  test('fetchProjectCapabilities surfaces the disabled degradation state authoritatively', async () => {
    runtimeFetchImpl = async () => jsonResponse({ projectCatalogV1: false });
    expect(await fetchProjectCapabilities()).toEqual({ projectCatalogV1: false });
    expect(runtimeFetchCalls[0].url).toBe('/api/projects/capabilities');
  });

  test('fetchProjectCapabilities throws CatalogClientError on a server error (never a fabricated state)', async () => {
    runtimeFetchImpl = async () => jsonResponse({ error: 'Catalog exploded', code: 'catalog_internal_error' }, 500);
    const caught = await captureError(() => fetchProjectCapabilities());
    expect(caught).toBeInstanceOf(CatalogClientError);
    const error = caught as CatalogClientError;
    expect(error.status).toBe(500);
    expect(error.code).toBe('catalog_internal_error');
  });

  test('fetchProjectCapabilities rejects a payload without a boolean flag', async () => {
    runtimeFetchImpl = async () => jsonResponse({ projectCatalogV1: 'enabled' });
    const caught = await captureError(() => fetchProjectCapabilities());
    expect(caught).toBeInstanceOf(CatalogClientError);
    expect((caught as CatalogClientError).code).toBe('catalog_invalid_response');
  });

  test('fetchProjectCapabilities rejects a non-object response', async () => {
    runtimeFetchImpl = async () => jsonResponse(null);
    const caught = await captureError(() => fetchProjectCapabilities());
    expect(caught).toBeInstanceOf(CatalogClientError);
    expect((caught as CatalogClientError).code).toBe('catalog_invalid_response');
  });
});
