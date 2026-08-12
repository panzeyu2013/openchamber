import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getRuntimeUrlResolver, setRuntimeUrlResolver, type RuntimeUrlResolver } from './runtime-url';

const originalResolver = getRuntimeUrlResolver();

const testResolver: RuntimeUrlResolver = {
  api: (path: string) => path,
  authenticatedAsset: (path: string) => path,
  auth: (path: string) => path,
  health: () => '/api/health',
  rawFile: (path: string) => path,
  sse: (path: string) => `http://runtime.test${path}`,
  websocket: (path: string) => path,
};

class MockEventSource {
  static CLOSED = 2;
  static instances: MockEventSource[] = [];

  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public readonly url: string) {
    MockEventSource.instances.push(this);
  }

  close() {
    this.readyState = MockEventSource.CLOSED;
  }
}

describe('openchamber events', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    const eventTarget = new EventTarget();
    globalThis.window = {
      addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => eventTarget.addEventListener(type, listener),
      removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => eventTarget.removeEventListener(type, listener),
      dispatchEvent: (event: Event) => eventTarget.dispatchEvent(event),
    } as Window & typeof globalThis;
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    setRuntimeUrlResolver(testResolver);
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { EventSource?: unknown }).EventSource;
    setRuntimeUrlResolver(originalResolver);
  });

  test('dispatches externally created session events', async () => {
    const { subscribeOpenchamberEvents } = await import('./openchamberEvents');
    const events: unknown[] = [];
    const listener = (event: unknown) => events.push(event);
    const unsubscribe = subscribeOpenchamberEvents(listener);
    const source = MockEventSource.instances[0];

    source.onmessage?.({
      data: JSON.stringify({
        type: 'openchamber:session-created',
        properties: {
          sessionId: 'ses_123',
          directory: '/repo/worktrees/research',
          projectId: 'project_1',
          createdAt: 123,
          promptDispatched: true,
          dispatchedAsCommand: false,
        },
      }),
    });

    expect(events).toEqual([
      {
        type: 'session-created',
        sessionId: 'ses_123',
        directory: '/repo/worktrees/research',
        projectId: 'project_1',
        createdAt: 123,
        promptDispatched: true,
        dispatchedAsCommand: false,
      },
    ]);
    unsubscribe();
  });
});
