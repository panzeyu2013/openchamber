import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  bindProjectSession,
  createSeededRandom,
  createProjectSession,
  fetchProjectSessionSnapshot,
  openProjectSessionEventStream,
  withBackoffJitter,
} from './session-index-client';
import { CatalogClientError, type ProjectSessionEvent, type ProjectSessionSnapshot } from './types';

let runtimeFetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
const runtimeFetchCalls: Array<{ url: string; init?: RequestInit }> = [];

// The session index client fetches through the control-plane-pinned fetch,
// which calls the global fetch at request time; stub that instead of the
// module. The stub is re-registered in beforeEach so a shared-process
// directory run always sees this file's stub for its own tests.
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

const snapshotFixture: ProjectSessionSnapshot = {
  revision: 3,
  sessions: [],
  freshnessByConnection: { 'conn-1': { complete: true, partial: false, offline: false, stale: false, lastSuccessAt: 1000, error: null } },
};

const eventFixture = (revision: number, type: ProjectSessionEvent['type']): ProjectSessionEvent => ({
  revision,
  connectionId: 'conn-1',
  projectId: 'ws-1',
  sessionId: 'ses-1',
  type,
  payload: {},
});

const sseResponse = (chunks: string[]): Response => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
};

const neverEndingResponse = (): Response => (
  new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
);

const waitFor = async (predicate: () => boolean, timeoutMs = 2000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const captureError = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return null;
};

describe('session index client', () => {
  beforeEach(() => {
    runtimeFetchCalls.length = 0;
    runtimeFetchImpl = async () => jsonResponse({});
    globalThis.fetch = stubGlobalFetch;
  });

  test('fetchProjectSessionSnapshot returns the parsed snapshot', async () => {
    runtimeFetchImpl = async () => jsonResponse(snapshotFixture);
    expect(await fetchProjectSessionSnapshot()).toEqual(snapshotFixture);
    expect(runtimeFetchCalls).toHaveLength(1);
    expect(runtimeFetchCalls[0].url).toBe('/api/project-sessions/snapshot');
    expect(runtimeFetchCalls[0].init?.headers).toEqual({ accept: 'application/json' });
  });

  test('fetchProjectSessionSnapshot rejects a body missing the sessions array', async () => {
    runtimeFetchImpl = async () => jsonResponse({ revision: 1, freshnessByConnection: {} });
    const caught = await captureError(() => fetchProjectSessionSnapshot());
    expect(caught).toBeInstanceOf(CatalogClientError);
    const error = caught as CatalogClientError;
    expect(error.status).toBe(500);
    expect(error.code).toBe('session_index_invalid_response');
  });

  test('fetchProjectSessionSnapshot throws CatalogClientError carrying status/code/message on failure', async () => {
    runtimeFetchImpl = async () => jsonResponse({ error: 'Index exploded', code: 'session_index_upstream_error' }, 502);
    const caught = await captureError(() => fetchProjectSessionSnapshot());
    expect(caught).toBeInstanceOf(CatalogClientError);
    const error = caught as CatalogClientError;
    expect(error.status).toBe(502);
    expect(error.code).toBe('session_index_upstream_error');
    expect(error.message).toBe('Index exploded');
  });

  test('createProjectSession POSTs the prompt JSON and returns the ids', async () => {
    runtimeFetchImpl = async () => jsonResponse({ sessionId: 'ses-1', projectId: 'ws-1' }, 201);
    const result = await createProjectSession('ws-1', 'Hello');
    expect(result).toEqual({ sessionId: 'ses-1', projectId: 'ws-1' });
    expect(runtimeFetchCalls).toHaveLength(1);
    expect(runtimeFetchCalls[0].url).toBe('/api/projects/ws-1/sessions');
    expect(runtimeFetchCalls[0].init?.method).toBe('POST');
    expect(runtimeFetchCalls[0].init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(runtimeFetchCalls[0].init?.body).toBe(JSON.stringify({ prompt: 'Hello' }));
  });

  test('createProjectSession omits the prompt when not provided', async () => {
    runtimeFetchImpl = async () => jsonResponse({ sessionId: 'ses-1', projectId: 'ws-1' }, 201);
    await createProjectSession('ws-1');
    expect(runtimeFetchCalls[0].init?.body).toBe('{}');
  });

  test('createProjectSession rejects a response without a session id', async () => {
    runtimeFetchImpl = async () => jsonResponse({ projectId: 'ws-1' }, 201);
    const caught = await captureError(() => createProjectSession('ws-1'));
    expect(caught).toBeInstanceOf(CatalogClientError);
    expect((caught as CatalogClientError).code).toBe('session_index_invalid_response');
  });

  test('bindProjectSession POSTs the bind request and returns bound', async () => {
    runtimeFetchImpl = async () => jsonResponse({ bound: true, projectId: 'ws-1', upstreamSessionId: 'ses/1' });
    const result = await bindProjectSession('ws-1', 'ses/1', '/home/me');
    expect(result).toEqual({ bound: true });
    expect(runtimeFetchCalls).toHaveLength(1);
    expect(runtimeFetchCalls[0].url).toBe('/api/projects/ws-1/sessions/ses%2F1/bind');
    expect(runtimeFetchCalls[0].init?.method).toBe('POST');
    expect(runtimeFetchCalls[0].init?.body).toBe(JSON.stringify({ directory: '/home/me' }));
  });

  test('bindProjectSession sends an empty body without a directory', async () => {
    runtimeFetchImpl = async () => jsonResponse({ bound: true });
    await bindProjectSession('ws-1', 'ses-1');
    expect(runtimeFetchCalls[0].init?.body).toBe('{}');
  });

  test('openProjectSessionEventStream delivers data events, reconnects on EOF, and aborts on cleanup', async () => {
    const firstEvent = eventFixture(1, 'session.upserted');
    const secondEvent = eventFixture(2, 'freshness.changed');
    let fetchCount = 0;
    runtimeFetchImpl = async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return sseResponse([
          `data: ${JSON.stringify(firstEvent)}\n\n`,
          `: ping\n\n`,
          `retry: 3000\n\n`,
          `data: ${JSON.stringify(secondEvent)}\n\n`,
        ]);
      }
      return neverEndingResponse();
    };

    const delivered: ProjectSessionEvent[] = [];
    const controller = new AbortController();
    const cleanup = openProjectSessionEventStream(
      (event) => delivered.push(event),
      controller.signal,
      { initialBackoffMs: 10 },
    );

    await waitFor(() => delivered.length >= 2);
    expect(delivered).toEqual([firstEvent, secondEvent]);

    // EOF counts as a failure; the 10ms base backoff must produce a reconnect.
    await waitFor(() => runtimeFetchCalls.length >= 2);
    expect(runtimeFetchCalls[1].url).toBe('/api/project-sessions/events');
    expect(runtimeFetchCalls[0].init?.headers).toEqual({ accept: 'text/event-stream' });

    cleanup();
    const streamSignal = runtimeFetchCalls[0].init?.signal;
    expect(streamSignal).toBeDefined();
    expect(streamSignal?.aborted).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runtimeFetchCalls.length).toBe(2);
  });

  test('openProjectSessionEventStream ignores malformed data lines', async () => {
    runtimeFetchImpl = async () => sseResponse([
      `data: not-json\n\n`,
      `data: ${JSON.stringify(eventFixture(1, 'session.upserted'))}\n\n`,
    ]);
    const delivered: ProjectSessionEvent[] = [];
    const controller = new AbortController();
    const cleanup = openProjectSessionEventStream(
      (event) => delivered.push(event),
      controller.signal,
      { initialBackoffMs: 10 },
    );
    await waitFor(() => delivered.length >= 1);
    expect(delivered).toEqual([eventFixture(1, 'session.upserted')]);
    cleanup();
  });

  test('withBackoffJitter stays inside the configured bounds (performance budget §17.5)', () => {
    expect(withBackoffJitter(5000, 0, 100, 30_000)).toBe(4000);
    expect(withBackoffJitter(5000, 0.5, 100, 30_000)).toBe(5000);
    expect(withBackoffJitter(5000, 1, 100, 30_000)).toBe(6000);
    expect(withBackoffJitter(100, 0, 100, 30_000)).toBe(100);
    expect(withBackoffJitter(30_000, 1, 100, 30_000)).toBe(30_000);
    for (const base of [100, 1000, 10_000, 30_000]) {
      for (const randomValue of [0, 0.1, 0.33, 0.5, 0.9, 1]) {
        const delay = withBackoffJitter(base, randomValue, 100, 30_000);
        expect(delay).toBeGreaterThanOrEqual(100);
        expect(delay).toBeLessThan(30_001);
      }
    }
  });

  test('reconnect jitter is deterministic per seed and differs across seeds (performance budget §17.5)', () => {
    const first = createSeededRandom(11);
    const second = createSeededRandom(11);
    for (let i = 0; i < 5; i += 1) expect(first()).toBe(second());

    const randA = createSeededRandom(11);
    const scheduleA = Array.from({ length: 20 }, () => withBackoffJitter(2000, randA(), 100, 30_000));
    const randB = createSeededRandom(12);
    const scheduleB = Array.from({ length: 20 }, () => withBackoffJitter(2000, randB(), 100, 30_000));
    expect(new Set(scheduleA).size).toBeGreaterThan(1);
    expect(scheduleA.some((delay, index) => delay !== scheduleB[index])).toBe(true);
    for (const delay of [...scheduleA, ...scheduleB]) {
      expect(delay).toBeGreaterThanOrEqual(100);
      expect(delay).toBeLessThan(30_001);
    }
  });
});
