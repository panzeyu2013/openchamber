import { beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  bindWorkspaceSession,
  createWorkspaceSession,
  fetchWorkspaceSessionSnapshot,
  openWorkspaceSessionEventStream,
} from './session-index-client';
import { CatalogClientError, type WorkspaceSessionEvent, type WorkspaceSessionSnapshot } from './types';

let runtimeFetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
const runtimeFetchCalls: Array<{ url: string; init?: RequestInit }> = [];

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: async (url: string, init?: RequestInit) => {
    runtimeFetchCalls.push({ url: String(url), init });
    return runtimeFetchImpl(url, init);
  },
}));

const jsonResponse = (body: unknown, status = 200): Response => (
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
);

const snapshotFixture: WorkspaceSessionSnapshot = {
  revision: 3,
  sessions: [],
  freshnessByConnection: { 'conn-1': { complete: true, stale: false, lastSuccessAt: 1000, error: null } },
};

const eventFixture = (revision: number, type: WorkspaceSessionEvent['type']): WorkspaceSessionEvent => ({
  revision,
  connectionId: 'conn-1',
  workspaceId: 'ws-1',
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
  });

  test('fetchWorkspaceSessionSnapshot returns the parsed snapshot', async () => {
    runtimeFetchImpl = async () => jsonResponse(snapshotFixture);
    expect(await fetchWorkspaceSessionSnapshot()).toEqual(snapshotFixture);
    expect(runtimeFetchCalls).toHaveLength(1);
    expect(runtimeFetchCalls[0].url).toBe('/api/workspace-sessions/snapshot');
    expect(runtimeFetchCalls[0].init?.headers).toEqual({ accept: 'application/json' });
  });

  test('fetchWorkspaceSessionSnapshot rejects a body missing the sessions array', async () => {
    runtimeFetchImpl = async () => jsonResponse({ revision: 1, freshnessByConnection: {} });
    const caught = await captureError(() => fetchWorkspaceSessionSnapshot());
    expect(caught).toBeInstanceOf(CatalogClientError);
    const error = caught as CatalogClientError;
    expect(error.status).toBe(500);
    expect(error.code).toBe('session_index_invalid_response');
  });

  test('fetchWorkspaceSessionSnapshot throws CatalogClientError carrying status/code/message on failure', async () => {
    runtimeFetchImpl = async () => jsonResponse({ error: 'Index exploded', code: 'session_index_upstream_error' }, 502);
    const caught = await captureError(() => fetchWorkspaceSessionSnapshot());
    expect(caught).toBeInstanceOf(CatalogClientError);
    const error = caught as CatalogClientError;
    expect(error.status).toBe(502);
    expect(error.code).toBe('session_index_upstream_error');
    expect(error.message).toBe('Index exploded');
  });

  test('createWorkspaceSession POSTs the prompt JSON and returns the ids', async () => {
    runtimeFetchImpl = async () => jsonResponse({ sessionId: 'ses-1', workspaceId: 'ws-1' }, 201);
    const result = await createWorkspaceSession('ws-1', 'Hello');
    expect(result).toEqual({ sessionId: 'ses-1', workspaceId: 'ws-1' });
    expect(runtimeFetchCalls).toHaveLength(1);
    expect(runtimeFetchCalls[0].url).toBe('/api/workspaces/ws-1/sessions');
    expect(runtimeFetchCalls[0].init?.method).toBe('POST');
    expect(runtimeFetchCalls[0].init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(runtimeFetchCalls[0].init?.body).toBe(JSON.stringify({ prompt: 'Hello' }));
  });

  test('createWorkspaceSession omits the prompt when not provided', async () => {
    runtimeFetchImpl = async () => jsonResponse({ sessionId: 'ses-1', workspaceId: 'ws-1' }, 201);
    await createWorkspaceSession('ws-1');
    expect(runtimeFetchCalls[0].init?.body).toBe('{}');
  });

  test('createWorkspaceSession rejects a response without a session id', async () => {
    runtimeFetchImpl = async () => jsonResponse({ workspaceId: 'ws-1' }, 201);
    const caught = await captureError(() => createWorkspaceSession('ws-1'));
    expect(caught).toBeInstanceOf(CatalogClientError);
    expect((caught as CatalogClientError).code).toBe('session_index_invalid_response');
  });

  test('bindWorkspaceSession POSTs the bind request and returns bound', async () => {
    runtimeFetchImpl = async () => jsonResponse({ bound: true, workspaceId: 'ws-1', upstreamSessionId: 'ses/1' });
    const result = await bindWorkspaceSession('ws-1', 'ses/1', '/home/me');
    expect(result).toEqual({ bound: true });
    expect(runtimeFetchCalls).toHaveLength(1);
    expect(runtimeFetchCalls[0].url).toBe('/api/workspaces/ws-1/sessions/ses%2F1/bind');
    expect(runtimeFetchCalls[0].init?.method).toBe('POST');
    expect(runtimeFetchCalls[0].init?.body).toBe(JSON.stringify({ directory: '/home/me' }));
  });

  test('bindWorkspaceSession sends an empty body without a directory', async () => {
    runtimeFetchImpl = async () => jsonResponse({ bound: true });
    await bindWorkspaceSession('ws-1', 'ses-1');
    expect(runtimeFetchCalls[0].init?.body).toBe('{}');
  });

  test('openWorkspaceSessionEventStream delivers data events, reconnects on EOF, and aborts on cleanup', async () => {
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

    const delivered: WorkspaceSessionEvent[] = [];
    const controller = new AbortController();
    const cleanup = openWorkspaceSessionEventStream(
      (event) => delivered.push(event),
      controller.signal,
      { initialBackoffMs: 10 },
    );

    await waitFor(() => delivered.length >= 2);
    expect(delivered).toEqual([firstEvent, secondEvent]);

    // EOF counts as a failure; the 10ms base backoff must produce a reconnect.
    await waitFor(() => runtimeFetchCalls.length >= 2);
    expect(runtimeFetchCalls[1].url).toBe('/api/workspace-sessions/events');
    expect(runtimeFetchCalls[0].init?.headers).toEqual({ accept: 'text/event-stream' });

    cleanup();
    const streamSignal = runtimeFetchCalls[0].init?.signal;
    expect(streamSignal).toBeDefined();
    expect(streamSignal?.aborted).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runtimeFetchCalls.length).toBe(2);
  });

  test('openWorkspaceSessionEventStream ignores malformed data lines', async () => {
    runtimeFetchImpl = async () => sseResponse([
      `data: not-json\n\n`,
      `data: ${JSON.stringify(eventFixture(1, 'session.upserted'))}\n\n`,
    ]);
    const delivered: WorkspaceSessionEvent[] = [];
    const controller = new AbortController();
    const cleanup = openWorkspaceSessionEventStream(
      (event) => delivered.push(event),
      controller.signal,
      { initialBackoffMs: 10 },
    );
    await waitFor(() => delivered.length >= 1);
    expect(delivered).toEqual([eventFixture(1, 'session.upserted')]);
    cleanup();
  });
});
