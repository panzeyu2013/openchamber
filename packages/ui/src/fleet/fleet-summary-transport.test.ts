import { describe, expect, mock, setSystemTime, test } from 'bun:test';
import { parseFleetLiveEvent, FleetSummaryTransport } from './fleet-summary-transport';
import type { FleetRuntimeDescriptor } from './types';

const descriptor: FleetRuntimeDescriptor = {
  apiBaseUrl: 'http://alpha.test',
  runtimeKey: 'desktop-host:alpha',
};

const immediateEofStream = (): AsyncIterable<unknown> => ({
  [Symbol.asyncIterator]: async function* () { /* ends immediately */ },
});

// The reconnect delay doubles after every short-lived connect/EOF cycle until
// the 60s cap; a stream that lived long enough resets the counter. The fake
// SDK client returns immediate-EOF streams and optionally advances the mocked
// clock to simulate a stream that stayed up for the healthy threshold.
type FakeEventOptions = { bumpMs?: number };
const createFakeClient = (onEventCall: (callIndex: number) => FakeEventOptions) => ({
  global: {
    event: () => {
      const { bumpMs } = onEventCall(eventCallIndex);
      eventCallIndex += 1;
      if (bumpMs) setSystemTime(Date.now() + bumpMs);
      return { stream: immediateEofStream() };
    },
  },
});

let eventCallIndex = 0;
let fakeClient: ReturnType<typeof createFakeClient> | null = null;
mock.module('@opencode-ai/sdk/v2', () => ({
  createOpencodeClient: () => fakeClient,
}));

describe('Fleet live-event projection', () => {
  test('projects status without retaining an event payload', () => {
    expect(parseFleetLiveEvent({
      payload: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } },
    })).toEqual({ sessionId: 'ses_1', activity: 'busy' });
  });

  test('projects request lifecycle into boolean indicators', () => {
    expect(parseFleetLiveEvent({ type: 'permission.asked', properties: { sessionID: 'ses_1', id: 'per_1' } }))
      .toEqual({ sessionId: 'ses_1', hasPendingPermission: true });
    expect(parseFleetLiveEvent({ type: 'question.rejected', properties: { sessionID: 'ses_1', requestID: 'que_1' } }))
      .toEqual({ sessionId: 'ses_1', hasPendingQuestion: false });
  });

  test('projects structural session lifecycle without retaining session content', () => {
    expect(parseFleetLiveEvent({ type: 'session.updated', properties: { info: { id: 'ses_1', title: 'not retained' } } }))
      .toEqual({ sessionId: 'ses_1', structural: 'updated' });
    expect(parseFleetLiveEvent({ type: 'session.deleted', properties: { sessionID: 'ses_1' } }))
      .toEqual({ sessionId: 'ses_1', structural: 'deleted' });
  });

  test('drops message content and unsupported events', () => {
    expect(parseFleetLiveEvent({ type: 'message.part.delta', properties: { sessionID: 'ses_1', delta: 'secret' } })).toBeNull();
  });
});

describe('Fleet summary observer backoff', () => {
  const realSetTimeout = globalThis.setTimeout;
  let recordedDelays: number[];

  // Replaces setTimeout with a recorder that resolves instantly so the
  // backoff sequence can be observed without waiting real seconds.
  const installInstantTimers = (): void => {
    recordedDelays = [];
    globalThis.setTimeout = ((fn: () => void, delay?: number) => {
      recordedDelays.push(delay ?? 0);
      return realSetTimeout(fn, 0);
    }) as typeof setTimeout;
  };

  const restoreTimers = (): void => {
    globalThis.setTimeout = realSetTimeout;
  };

  const drainUntil = async (condition: () => boolean, guard = 10_000): Promise<boolean> => {
    while (!condition() && guard > 0) {
      // Yield through a real (unmocked) timer so pending 0ms waits resolve;
      // microtask-only yields never let the event loop run timers.
      await new Promise((resolve) => { realSetTimeout(resolve, 0); });
      guard -= 1;
    }
    return condition();
  };

  test('a short connect/EOF loop grows the reconnect delay with no zero-delay spin', async () => {
    installInstantTimers();
    setSystemTime();
    eventCallIndex = 0;
    fakeClient = createFakeClient(() => ({}));

    const transport = new FleetSummaryTransport();
    const disconnects: number[] = [];
    const stop = transport.observeServer('desktop:alpha', descriptor, () => {}, () => { disconnects.push(disconnects.length + 1); });

    const satisfied = await drainUntil(() => recordedDelays.length >= 3);
    stop();
    restoreTimers();

    expect(satisfied).toBe(true);
    expect(recordedDelays.slice(0, 3)).toEqual([1_000, 2_000, 4_000]);
    expect(disconnects.length).toBeGreaterThanOrEqual(3);
  });

  test('a stream that outlives the healthy threshold resets the backoff to the base delay', async () => {
    installInstantTimers();
    setSystemTime();
    eventCallIndex = 0;
    // The second stream "lived" 31s (>= the 30s healthy threshold) before
    // EOF, so the counter resets: without the reset the third reconnect
    // would be at the doubled 2000ms, with the reset it stays at 1000ms.
    fakeClient = createFakeClient((callIndex) => (callIndex === 1 ? { bumpMs: 31_000 } : {}));

    const transport = new FleetSummaryTransport();
    const stop = transport.observeServer('desktop:alpha', descriptor, () => {}, () => {});

    const satisfied = await drainUntil(() => recordedDelays.length >= 3);
    stop();
    restoreTimers();

    expect(satisfied).toBe(true);
    expect(recordedDelays.slice(0, 3)).toEqual([1_000, 1_000, 1_000]);
  });
});
