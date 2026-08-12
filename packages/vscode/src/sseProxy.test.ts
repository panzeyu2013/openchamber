import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenCodeManager } from './opencode';
import { openSseProxy } from './sseProxy';

const createManager = (): OpenCodeManager => ({
  start: async () => {},
  stop: async () => {},
  restart: async () => {},
  setWorkingDirectory: async (path) => ({ success: true, path }),
  getStatus: () => 'connected',
  getApiUrl: () => 'http://127.0.0.1:3902',
  getOpenCodeAuthHeaders: () => ({}),
  getWorkingDirectory: () => '/workspace',
  isCliAvailable: () => true,
  getDebugInfo: () => ({
    mode: 'managed',
    status: 'connected',
    workingDirectory: '/workspace',
    cliAvailable: true,
    cliPath: null,
    configuredApiUrl: null,
    configuredPort: null,
    detectedPort: 3902,
    apiPrefix: '',
    apiPrefixDetected: true,
    startCount: 1,
    restartCount: 0,
    lastStartAt: null,
    lastConnectedAt: null,
    lastExitCode: null,
    serverUrl: 'http://127.0.0.1:3902',
    lastReadyElapsedMs: null,
    lastReadyAttempts: null,
    lastStartAttempts: null,
    version: null,
    secureConnection: false,
    authSource: null,
  }),
  onStatusChange: (callback) => {
    callback('connected');
    return { dispose: () => {} };
  },
});

describe('VS Code SSE proxy', () => {
  test('closes a quiet upstream SSE stream after the stall timeout', async () => {
    const originalFetch = globalThis.fetch;

    try {
      globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({}), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as typeof fetch;

      const controller = new AbortController();
      const proxy = await openSseProxy({
        manager: createManager(),
        path: '/global/event',
        signal: controller.signal,
        stallTimeoutMs: 20,
        onChunk: () => assert.fail('quiet stream should not emit chunks'),
      });

      await assert.doesNotReject(proxy.run);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('resets the stall timeout when upstream bytes arrive', async () => {
    const originalFetch = globalThis.fetch;

    try {
      globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          setTimeout(() => controller.enqueue(new TextEncoder().encode(':first\n\n')), 5);
          setTimeout(() => controller.enqueue(new TextEncoder().encode('data: second\n\n')), 15);
        },
      }), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as typeof fetch;

      const chunks: string[] = [];
      const controller = new AbortController();
      const proxy = await openSseProxy({
        manager: createManager(),
        path: '/global/event',
        signal: controller.signal,
        stallTimeoutMs: 18,
        onChunk: (chunk) => chunks.push(chunk),
      });

      await assert.doesNotReject(proxy.run);
      assert.deepEqual(chunks, [':first\n\n', 'data: second\n\n']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('VS Code SSE proxy control plane', () => {
  test('forwards to {origin}{path} with auth headers and streams chunks without /event normalization', async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; init: RequestInit }> = [];

    try {
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        calls.push({ url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url, init: init || {} });
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            setTimeout(() => controller.enqueue(new TextEncoder().encode('data: {"revision":1}\n\n')), 5);
            setTimeout(() => controller.enqueue(new TextEncoder().encode('data: {"revision":2}\n\n')), 15);
            setTimeout(() => controller.close(), 25);
          },
        }), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }) as typeof fetch;

      const manager = createManager();
      manager.getOpenCodeAuthHeaders = () => ({ Authorization: 'Bearer control-token' });
      const chunks: string[] = [];
      const controller = new AbortController();
      const proxy = await openSseProxy({
        manager,
        path: '/api/workspace-sessions/events?revision=0',
        signal: controller.signal,
        controlPlane: true,
        controlPlaneOrigin: 'http://control.test:3000',
        stallTimeoutMs: 2000,
        onChunk: (chunk) => chunks.push(chunk),
      });

      await assert.doesNotReject(proxy.run);
      assert.deepEqual(chunks, ['data: {"revision":1}\n\n', 'data: {"revision":2}\n\n']);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.url, 'http://control.test:3000/api/workspace-sessions/events?revision=0');
      const headers = new Headers(calls[0]?.init.headers);
      assert.equal(headers.get('authorization'), 'Bearer control-token');
      assert.equal(headers.get('accept'), 'text/event-stream');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('preserves a path-prefixed control-plane origin', async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<string> = [];

    try {
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
        calls.push(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            setTimeout(() => controller.close(), 5);
          },
        }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }) as typeof fetch;

      const controller = new AbortController();
      const proxy = await openSseProxy({
        manager: createManager(),
        path: '/api/workspace-sessions/events',
        signal: controller.signal,
        controlPlane: true,
        controlPlaneOrigin: 'http://host:8080/chamber/',
        onChunk: () => {},
      });

      await assert.doesNotReject(proxy.run);
      assert.deepEqual(calls, ['http://host:8080/chamber/api/workspace-sessions/events']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fails fast (no reconnect retries) when the control plane rejects the stream', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;

    try {
      globalThis.fetch = (async () => {
        fetchCount += 1;
        return new Response(JSON.stringify({ error: 'nope' }), { status: 404, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;

      const controller = new AbortController();
      const startedAt = Date.now();
      await assert.rejects(
        openSseProxy({
          manager: createManager(),
          path: '/api/workspace-sessions/events',
          signal: controller.signal,
          controlPlane: true,
          controlPlaneOrigin: 'http://control.test',
          onChunk: () => assert.fail('no chunks expected'),
        }),
        /OpenCode SSE request failed \(404\)/,
      );
      assert.equal(fetchCount, 1);
      assert.ok(Date.now() - startedAt < 1000, 'must fail fast without backoff retries');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('throws without fetching when no control-plane origin is configured', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;

    try {
      globalThis.fetch = (async () => {
        fetchCount += 1;
        return new Response('{}', { status: 200 });
      }) as typeof fetch;

      const controller = new AbortController();
      await assert.rejects(
        openSseProxy({
          manager: createManager(),
          path: '/api/workspace-sessions/events',
          signal: controller.signal,
          controlPlane: true,
          controlPlaneOrigin: null,
          onChunk: () => assert.fail('no chunks expected'),
        }),
        /Control plane is not available/,
      );
      assert.equal(fetchCount, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
