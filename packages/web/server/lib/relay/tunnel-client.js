// Server-side Relay tunnel client: the initiator counterpart to tunnel-host.js.
//
// This module is intentionally a plain-JS mirror of the normative client in
// packages/ui/src/lib/relay/tunnel-client.ts. It is used by the project Relay
// adapter when the control plane itself must reach another OpenChamber host.
// Keep the E2EE and Layer 3 behavior byte-compatible with the UI client.

import { WebSocket } from 'ws';

import {
  RELAY_PROTOCOL_VERSION,
  RelayCloseCode,
  createClientHandshake,
} from './e2ee.js';
import {
  DEFAULT_BATCH_WINDOW_MS,
  TunnelFrameType,
  chunkPayload,
  createFragmentAssembler,
  createOutboundFrameBatcher,
  createStreamIdAllocator,
  decodeFrameBatch,
  decodeJsonPayload,
  decodeTunnelFrame,
  encodeFragmentedMessage,
  encodeJsonPayload,
  encodeTunnelFrame,
} from './tunnel-codec.js';

const EMPTY_PAYLOAD = new Uint8Array(0);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

const TERMINAL_RELAY_CLOSE_CODES = new Set([
  RelayCloseCode.AuthFailed,
  RelayCloseCode.DuplicateClient,
  RelayCloseCode.LimitExceeded,
]);

const RELAY_CLOSE_MESSAGES = {
  [RelayCloseCode.AuthFailed]: 'relay authentication failed',
  [RelayCloseCode.DuplicateClient]: 'relay connection replaced by another client',
  [RelayCloseCode.LimitExceeded]: 'relay connection limit reached',
};

const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const toError = (value) => (value instanceof Error ? value : new Error(String(value)));

const abortError = () => {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
};

const tunnelError = (message, code = 'relay_tunnel_failed') => {
  const error = new Error(message);
  error.code = code;
  return error;
};

const toBytes = (value) => {
  if (value instanceof Uint8Array) return value;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
};

const singleChunk = (bytes) => ({
  async *[Symbol.asyncIterator]() {
    yield bytes;
  },
});

const streamChunks = (stream) => ({
  async *[Symbol.asyncIterator]() {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value) yield toBytes(value) ?? new Uint8Array(value);
      }
    } finally {
      reader.releaseLock?.();
    }
  },
});

const resolveBody = async (body) => {
  if (body === null || body === undefined) return { body: null };
  if (typeof body?.[Symbol.asyncIterator] === 'function') return { body };
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
    return { body: streamChunks(body) };
  }
  if (typeof body === 'string') return { body: singleChunk(textEncoder.encode(body)) };
  const bytes = toBytes(body);
  if (bytes) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return { body: singleChunk(copy) };
  }
  // Match fetch's body serialization for FormData, URLSearchParams and Blob.
  // Plain objects are intentionally handled here too because the adapter's
  // Express request body may still be an object in a unit/runtime harness.
  if (typeof Response === 'function') {
    const probe = new Response(body);
    const contentType = probe.headers.get('content-type') ?? undefined;
    const serialized = new Uint8Array(await probe.arrayBuffer());
    return { body: singleChunk(serialized), contentType };
  }
  throw tunnelError('unsupported relay request body', 'relay_request_body_invalid');
};

const normalizeTunnelRequest = async (input, init = undefined) => {
  let urlValue;
  let method = 'GET';
  let sourceHeaders = null;
  let bodySource = null;
  let signal;

  if (typeof Request !== 'undefined' && input instanceof Request) {
    urlValue = input.url;
    method = input.method;
    sourceHeaders = input.headers;
    bodySource = input.body;
    signal = input.signal;
  } else {
    urlValue = input instanceof URL ? input.toString() : String(input);
  }

  const headers = new Headers(sourceHeaders ?? undefined);
  if (init?.method) method = init.method;
  if (init?.headers) new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  if (init && Object.prototype.hasOwnProperty.call(init, 'body')) bodySource = init.body;
  if (init?.signal) signal = init.signal;

  let parsed;
  try {
    parsed = new URL(urlValue, 'http://tunnel.invalid');
  } catch {
    throw tunnelError('invalid relay request URL', 'relay_request_url_invalid');
  }
  const resolved = await resolveBody(bodySource);
  if (resolved.contentType && !headers.has('content-type')) headers.set('content-type', resolved.contentType);
  const headerRecord = {};
  headers.forEach((value, name) => { headerRecord[name] = value; });

  return {
    method: String(method || 'GET').toUpperCase(),
    path: parsed.pathname || '/',
    query: parsed.search.startsWith('?') ? parsed.search.slice(1) : parsed.search,
    headers: headerRecord,
    body: resolved.body,
    signal,
  };
};

/** Adapts the Node `ws` EventEmitter to the small transport surface used here. */
const wrapNodeWebSocket = (socket) => {
  socket.binaryType = 'arraybuffer';
  const wire = {
    get readyState() {
      return socket.readyState;
    },
    send(data) {
      socket.send(data);
    },
    close(code, reason) {
      socket.close(code, reason);
    },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  socket.on('open', () => wire.onopen?.());
  socket.on('message', (data, isBinary) => {
    const value = isBinary
      ? (toBytes(data) ?? new Uint8Array(data))
      : (typeof data === 'string' ? data : textDecoder.decode(toBytes(data) ?? new Uint8Array(data)));
    wire.onmessage?.({ data: value });
  });
  socket.on('close', (code, reason) => {
    wire.onclose?.({ code, reason: reason ? reason.toString('utf8') : '' });
  });
  socket.on('error', () => wire.onerror?.());
  return wire;
};

const isHttpResponsePayload = (value) => (
  isRecord(value)
  && typeof value.status === 'number'
  && isRecord(value.headers)
  && Object.values(value.headers).every((entry) => typeof entry === 'string')
);

const isStreamAbortPayload = (value) => isRecord(value) && typeof value.reason === 'string';

const isWsClosePayload = (value) => (
  isRecord(value)
  && typeof value.code === 'number'
  && typeof value.reason === 'string'
);

const isTunnelWsOpenPayload = (value) => (
  isRecord(value)
  && typeof value.path === 'string'
  && typeof value.query === 'string'
  && (value.protocols === undefined || Array.isArray(value.protocols))
  && (value.headers === undefined || (
    isRecord(value.headers)
    && Object.values(value.headers).every((entry) => typeof entry === 'string')
  ))
);

/**
 * @param {{
 *   relayUrl: string,
 *   serverId: string,
 *   connectionId: string,
 *   hostEncPubJwk: JsonWebKey,
 *   grant?: string,
 *   createWireSocket?: (url: string) => object,
 *   helloRetryMs?: number,
 *   helloTimeoutMs?: number,
 *   pingIntervalMs?: number,
 *   pingTimeoutMs?: number,
 *   batchWindowMs?: number,
 *   batch?: boolean,
 *   reconnectBaseDelayMs?: number,
 *   reconnectMaxDelayMs?: number,
 * }} options
 */
export const createRelayTunnelClient = (options) => {
  if (!options || typeof options.connectionId !== 'string' || options.connectionId.length === 0) {
    throw new Error('relay tunnel client requires a connectionId');
  }

  const helloRetryMs = options.helloRetryMs ?? 1_000;
  const helloTimeoutMs = options.helloTimeoutMs ?? 30_000;
  const pingIntervalMs = options.pingIntervalMs ?? 30_000;
  const pingTimeoutMs = options.pingTimeoutMs ?? 15_000;
  const batchWindowMs = options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS;
  const advertiseBatch = options.batch !== false;
  const reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? 1_000;
  const reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 30_000;
  const createWire = options.createWireSocket ?? ((url) => wrapNodeWebSocket(new WebSocket(url)));

  let closed = false;
  let status = { state: 'idle' };
  const statusListeners = new Set();
  let activeChannel = null;
  let currentWire = null;
  let currentAttemptCleanup = null;
  let attemptGeneration = 0;
  let consecutiveFailures = 0;
  let reconnectTimer = null;
  let channelWaiters = [];

  const setStatus = (next) => {
    if (status.state === next.state && status.lastError === next.lastError) return;
    status = next;
    for (const listener of statusListeners) {
      try { listener(status); } catch { /* status consumers are isolated */ }
    }
  };

  const rejectWaiters = (error) => {
    const waiters = channelWaiters;
    channelWaiters = [];
    for (const waiter of waiters) waiter.reject(error);
  };

  const resolveWaiters = (channel) => {
    const waiters = channelWaiters;
    channelWaiters = [];
    for (const waiter of waiters) waiter.resolve(channel);
  };

  const failChannelStreams = (channel, error) => {
    channel.dead = true;
    const handlers = [...channel.streams.values()];
    channel.streams.clear();
    for (const handler of handlers) {
      try { handler.fail(error); } catch { /* continue teardown */ }
    }
  };

  const clearReconnectTimer = () => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const scheduleReconnect = () => {
    if (closed || reconnectTimer !== null) return;
    const exponent = Math.min(Math.max(0, consecutiveFailures - 1), 10);
    const delay = Math.min(reconnectMaxDelayMs, reconnectBaseDelayMs * 2 ** exponent);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
    reconnectTimer.unref?.();
  };

  const buildRelayWsUrl = () => {
    const url = new URL(options.relayUrl);
    url.searchParams.set('v', String(RELAY_PROTOCOL_VERSION));
    url.searchParams.set('role', 'client');
    url.searchParams.set('serverId', options.serverId);
    url.searchParams.set('connectionId', options.connectionId);
    if (options.grant) url.searchParams.set('grant', options.grant);
    return url.toString();
  };

  const connect = async () => {
    if (closed) return;
    clearReconnectTimer();
    attemptGeneration += 1;
    const generation = attemptGeneration;
    setStatus({ state: consecutiveFailures > 0 ? 'reconnecting' : 'connecting', lastError: status.lastError });

    let handshake;
    try {
      handshake = await createClientHandshake(options.hostEncPubJwk, { batch: advertiseBatch });
    } catch (error) {
      if (generation !== attemptGeneration || closed) return;
      consecutiveFailures += 1;
      setStatus({ state: 'error', lastError: toError(error).message });
      scheduleReconnect();
      return;
    }
    if (generation !== attemptGeneration || closed) return;

    let wire;
    try {
      wire = createWire(buildRelayWsUrl());
    } catch (error) {
      consecutiveFailures += 1;
      setStatus({ state: 'reconnecting', lastError: toError(error).message });
      scheduleReconnect();
      return;
    }
    currentWire = wire;

    let settled = false;
    let helloInterval = null;
    let helloDeadline = null;
    let pingTimer = null;
    let pongDeadline = null;
    let recvChain = Promise.resolve();
    let channel = null;
    let cryptoChannel = null;
    let batchNegotiated = false;
    let batcher = null;
    let lastActivityAt = Date.now();

    const cleanupTimers = () => {
      if (helloInterval !== null) clearInterval(helloInterval);
      if (helloDeadline !== null) clearTimeout(helloDeadline);
      if (pingTimer !== null) clearInterval(pingTimer);
      if (pongDeadline !== null) clearTimeout(pongDeadline);
      helloInterval = null;
      helloDeadline = null;
      pingTimer = null;
      pongDeadline = null;
      batcher?.dispose();
      batcher = null;
    };
    currentAttemptCleanup = cleanupTimers;

    const failAttemptLocal = (errorValue, terminal = false) => {
      if (settled || generation !== attemptGeneration) return;
      const error = toError(errorValue);
      settled = true;
      cleanupTimers();
      if (channel) {
        if (activeChannel === channel) activeChannel = null;
        failChannelStreams(channel, tunnelError(`relay tunnel reset: ${error.message}`));
      }
      rejectWaiters(error);
      try { wire.close(); } catch { /* already closed */ }
      if (currentWire === wire) currentWire = null;
      if (closed) return;
      consecutiveFailures += 1;
      if (terminal) {
        setStatus({ state: 'error', lastError: error.message });
        return;
      }
      setStatus({ state: 'reconnecting', lastError: error.message });
      scheduleReconnect();
    };

    const sendHello = () => {
      try { wire.send(handshake.helloText); } catch { /* retry timer covers it */ }
    };

    const establish = (crypto, negotiatedBatch) => {
      cryptoChannel = crypto;
      batchNegotiated = negotiatedBatch === true;
      if (helloInterval !== null) clearInterval(helloInterval);
      if (helloDeadline !== null) clearTimeout(helloDeadline);
      helloInterval = null;
      helloDeadline = null;

      const streams = new Map();
      const allocator = createStreamIdAllocator();
      const assembler = createFragmentAssembler();
      let sendChain = Promise.resolve();

      const sendEncryptedPlaintext = (plaintext) => {
        sendChain = sendChain
          .then(async () => {
            if (channelObj.dead || wire.readyState !== WS_OPEN) return;
            const encrypted = await crypto.encryptor.encrypt(plaintext);
            wire.send(encrypted);
          })
          .catch(() => {
            // The socket close path owns stream failure and reconnect pacing.
          });
      };

      const localBatcher = batchNegotiated
        ? createOutboundFrameBatcher({ windowMs: batchWindowMs, sendBatch: sendEncryptedPlaintext })
        : null;
      batcher = localBatcher;
      const channelObj = {
        streams,
        assembler,
        nextStreamId: () => allocator.next(),
        dead: false,
        send(frame) {
          if (channelObj.dead) return;
          const frameType = frame[0] & 0x7f;
          if (frameType !== TunnelFrameType.Ping && frameType !== TunnelFrameType.Pong) {
            lastActivityAt = Date.now();
          }
          if (localBatcher) localBatcher.enqueue(frame);
          else sendEncryptedPlaintext(frame);
        },
      };
      channel = channelObj;
      activeChannel = channelObj;
      consecutiveFailures = 0;
      lastActivityAt = Date.now();
      setStatus({ state: 'connected' });
      resolveWaiters(channelObj);

      pingTimer = setInterval(() => {
        if (Date.now() - lastActivityAt < pingIntervalMs) return;
        channelObj.send(encodeTunnelFrame(TunnelFrameType.Ping, 0, EMPTY_PAYLOAD));
        if (pongDeadline === null) {
          pongDeadline = setTimeout(() => {
            pongDeadline = null;
            failAttemptLocal(tunnelError('relay keepalive timeout', 'relay_keepalive_timeout'));
          }, pingTimeoutMs);
          pongDeadline.unref?.();
        }
      }, pingIntervalMs);
      pingTimer.unref?.();
    };

    const handleTunnelFrame = (channelObj, plaintext) => {
      let frame;
      try {
        frame = decodeTunnelFrame(plaintext);
      } catch (error) {
        failAttemptLocal(error);
        return;
      }
      if (pongDeadline !== null) {
        clearTimeout(pongDeadline);
        pongDeadline = null;
      }
      if (frame.frameType === TunnelFrameType.Ping) {
        channelObj.send(encodeTunnelFrame(TunnelFrameType.Pong, frame.streamId, EMPTY_PAYLOAD));
        return;
      }
      if (frame.frameType === TunnelFrameType.Pong) return;
      lastActivityAt = Date.now();

      let payload = frame.payload;
      if (frame.frameType === TunnelFrameType.WsText || frame.frameType === TunnelFrameType.WsBinary) {
        try {
          payload = channelObj.assembler.push(frame);
        } catch (error) {
          failAttemptLocal(error);
          return;
        }
        if (payload === null) return;
      } else if (frame.hasMoreFragments) {
        failAttemptLocal(tunnelError('unexpected fragmented tunnel frame', 'relay_protocol_error'));
        return;
      }
      const handler = channelObj.streams.get(frame.streamId);
      if (!handler) return;
      handler.handleFrame(frame.frameType, payload);
    };

    wire.onopen = () => {
      if (settled || generation !== attemptGeneration) return;
      sendHello();
      helloInterval = setInterval(sendHello, helloRetryMs);
      helloInterval.unref?.();
    };

    wire.onmessage = (event) => {
      if (settled || generation !== attemptGeneration) return;
      const data = event?.data;
      if (typeof data === 'string') {
        recvChain = recvChain
          .then(async () => {
            if (settled || generation !== attemptGeneration) return;
            const action = await handshake.handleText(data);
            if (action.type === 'established') {
              if (!cryptoChannel) establish(action.channel, action.batch);
            } else if (action.type === 'fail') {
              failAttemptLocal(tunnelError(`relay handshake failed: ${action.reason}`, 'relay_handshake_failed'));
            }
          })
          .catch((error) => failAttemptLocal(error));
        return;
      }
      const bytes = toBytes(data);
      if (!bytes) return;
      recvChain = recvChain
        .then(async () => {
          if (settled || generation !== attemptGeneration) return;
          if (!channel || !cryptoChannel) {
            failAttemptLocal(tunnelError('encrypted frame before handshake completed', 'relay_protocol_error'));
            return;
          }
          let plaintext;
          try {
            plaintext = await cryptoChannel.decryptor.decrypt(bytes);
          } catch (error) {
            failAttemptLocal(error);
            return;
          }
          if (batchNegotiated) {
            let frames;
            try { frames = decodeFrameBatch(plaintext); } catch (error) {
              failAttemptLocal(error);
              return;
            }
            for (const frame of frames) {
              if (settled || generation !== attemptGeneration || channel.dead) return;
              handleTunnelFrame(channel, frame);
            }
          } else {
            handleTunnelFrame(channel, plaintext);
          }
        })
        .catch((error) => failAttemptLocal(error));
    };

    wire.onclose = (event) => {
      const terminal = TERMINAL_RELAY_CLOSE_CODES.has(event?.code);
      failAttemptLocal(
        tunnelError(RELAY_CLOSE_MESSAGES[event?.code] ?? `relay socket closed (code ${event?.code ?? 1006})`, terminal ? 'relay_terminal_failure' : 'relay_socket_closed'),
        terminal,
      );
    };
    wire.onerror = () => { /* onclose owns failure/reconnect */ };

    helloDeadline = setTimeout(() => {
      helloDeadline = null;
      failAttemptLocal(tunnelError('relay handshake timeout', 'relay_handshake_timeout'));
    }, helloTimeoutMs);
    helloDeadline.unref?.();
  };

  const waitForChannel = (signal) => {
    if (closed) return Promise.reject(tunnelError('relay tunnel closed', 'relay_tunnel_closed'));
    if (signal?.aborted) return Promise.reject(abortError());
    if (activeChannel && !activeChannel.dead) return Promise.resolve(activeChannel);
    // A terminal failure (relay auth rejected, duplicate client, limit
    // exceeded) never reconnects, so no new channel will ever arrive: fail
    // requests immediately instead of leaving them hanging until some
    // unrelated timeout.
    if (status.state === 'error') {
      return Promise.reject(tunnelError(status.lastError ?? 'relay tunnel failed', 'relay_tunnel_failed'));
    }
    return new Promise((resolve, reject) => {
      let onAbort = null;
      const waiter = {
        resolve(channel) {
          if (onAbort) signal?.removeEventListener?.('abort', onAbort);
          resolve(channel);
        },
        reject(error) {
          if (onAbort) signal?.removeEventListener?.('abort', onAbort);
          reject(error);
        },
      };
      if (signal) {
        onAbort = () => {
          channelWaiters = channelWaiters.filter((entry) => entry !== waiter);
          reject(abortError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      channelWaiters.push(waiter);
    });
  };

  const tunnelFetch = async (input, init = undefined) => {
    const request = await normalizeTunnelRequest(input, init);
    if (request.signal?.aborted) throw abortError();
    const channel = await waitForChannel(request.signal);

    return new Promise((resolve, reject) => {
      const streamId = channel.nextStreamId();
      let responseDelivered = false;
      let finished = false;
      let bodyController = null;
      let onAbort = null;

      const cleanupStream = () => {
        channel.streams.delete(streamId);
        channel.assembler.dropStream(streamId);
        if (onAbort) request.signal?.removeEventListener?.('abort', onAbort);
      };
      const finishError = (error) => {
        if (finished) return;
        finished = true;
        cleanupStream();
        if (!responseDelivered) reject(error);
        else bodyController?.error?.(error);
      };
      const sendAbort = (reason) => {
        if (!channel.dead) channel.send(encodeTunnelFrame(
          TunnelFrameType.StreamAbort,
          streamId,
          encodeJsonPayload({ reason }),
        ));
      };
      onAbort = () => {
        sendAbort('aborted');
        finishError(abortError());
      };

      channel.streams.set(streamId, {
        handleFrame(frameType, payload) {
          if (frameType === TunnelFrameType.HttpResponse) {
            if (responseDelivered || finished) return;
            let head;
            try { head = decodeJsonPayload(payload, isHttpResponsePayload); } catch (error) {
              sendAbort('malformed response head');
              finishError(toError(error));
              return;
            }
            const nullBody = head.status === 204 || head.status === 205 || head.status === 304;
            let body = null;
            if (!nullBody) {
              body = new ReadableStream({
                start(controller) { bodyController = controller; },
                cancel() {
                  if (finished) return;
                  finished = true;
                  cleanupStream();
                  sendAbort('response body cancelled');
                },
              });
            }
            responseDelivered = true;
            resolve(new Response(body, { status: head.status, headers: head.headers }));
            if (nullBody) {
              finished = true;
              cleanupStream();
            }
            return;
          }
          if (frameType === TunnelFrameType.HttpBody) {
            if (responseDelivered && !finished) bodyController?.enqueue?.(payload);
            return;
          }
          if (frameType === TunnelFrameType.StreamEnd) {
            if (finished) return;
            if (!responseDelivered) {
              finishError(tunnelError('tunnel stream ended before response head', 'relay_protocol_error'));
              return;
            }
            finished = true;
            cleanupStream();
            bodyController?.close?.();
            return;
          }
          if (frameType === TunnelFrameType.StreamAbort) {
            let reason = 'stream aborted by host';
            try { reason = decodeJsonPayload(payload, isStreamAbortPayload).reason; } catch { /* generic */ }
            finishError(tunnelError(reason, 'relay_stream_aborted'));
          }
        },
        fail(error) {
          finishError(tunnelError(error.message, 'relay_tunnel_reset'));
        },
      });

      if (request.signal) request.signal.addEventListener('abort', onAbort, { once: true });
      const head = {
        method: request.method,
        path: request.path,
        query: request.query,
        headers: request.headers,
      };
      channel.send(encodeTunnelFrame(TunnelFrameType.HttpRequest, streamId, encodeJsonPayload(head)));

      void (async () => {
        try {
          if (request.body) {
            for await (const chunk of request.body) {
              if (finished || channel.dead) return;
              const bytes = toBytes(chunk);
              if (!bytes) throw tunnelError('relay request body yielded invalid bytes', 'relay_request_body_invalid');
              for (const piece of chunkPayload(bytes)) {
                if (finished || channel.dead) return;
                channel.send(encodeTunnelFrame(TunnelFrameType.HttpBody, streamId, piece));
              }
            }
          }
          if (!finished && !channel.dead) {
            channel.send(encodeTunnelFrame(TunnelFrameType.StreamEnd, streamId, EMPTY_PAYLOAD));
          }
        } catch (error) {
          sendAbort('request body failed');
          finishError(toError(error));
        }
      })();
    });
  };

  const splitPathQuery = (value) => {
    const index = String(value).indexOf('?');
    if (index < 0) return { path: String(value), query: '' };
    return { path: String(value).slice(0, index), query: String(value).slice(index + 1) };
  };

  const openTunnelWebSocket = (pathWithQuery, protocols = undefined, headers = undefined) => {
    let readyState = WS_CONNECTING;
    let channelRef = null;
    let streamId = 0;
    let finished = false;

    const socket = {
      get readyState() { return readyState; },
      binaryType: 'arraybuffer',
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send(data) {
        if (readyState !== WS_OPEN || !channelRef || channelRef.dead) {
          throw tunnelError('relay tunnel socket is not open', 'relay_socket_not_open');
        }
        if (typeof data === 'string') {
          for (const frame of encodeFragmentedMessage(TunnelFrameType.WsText, streamId, textEncoder.encode(data))) {
            channelRef.send(frame);
          }
          return;
        }
        const bytes = toBytes(data);
        if (!bytes) throw tunnelError('relay WebSocket message is not bytes', 'relay_ws_message_invalid');
        for (const frame of encodeFragmentedMessage(TunnelFrameType.WsBinary, streamId, bytes)) {
          channelRef.send(frame);
        }
      },
      close(code = 1000, reason = '') {
        if (readyState === WS_CLOSED || readyState === WS_CLOSING) return;
        if (readyState === WS_OPEN && channelRef && !channelRef.dead) {
          readyState = WS_CLOSING;
          channelRef.send(encodeTunnelFrame(
            TunnelFrameType.WsClose,
            streamId,
            encodeJsonPayload({ code, reason }),
          ));
        }
        settleClose(code, reason);
      },
    };

    const settleClose = (code, reason, errored = false) => {
      if (finished) return;
      finished = true;
      if (channelRef) {
        channelRef.streams.delete(streamId);
        channelRef.assembler.dropStream(streamId);
      }
      readyState = WS_CLOSED;
      if (errored) {
        try { socket.onerror?.(); } catch { /* handler isolation */ }
      }
      try { socket.onclose?.({ code, reason }); } catch { /* handler isolation */ }
    };

    void (async () => {
      let channel;
      try { channel = await waitForChannel(); } catch (error) {
        settleClose(1006, toError(error).message, true);
        return;
      }
      if (finished) return;
      channelRef = channel;
      streamId = channel.nextStreamId();
      channel.streams.set(streamId, {
        handleFrame(frameType, payload) {
          if (frameType === TunnelFrameType.WsOpened) {
            if (readyState === WS_CONNECTING) {
              readyState = WS_OPEN;
              try { socket.onopen?.(); } catch { /* handler isolation */ }
            }
            return;
          }
          if (frameType === TunnelFrameType.WsText) {
            try { socket.onmessage?.({ data: textDecoder.decode(payload) }); } catch { /* isolate */ }
            return;
          }
          if (frameType === TunnelFrameType.WsBinary) {
            const buffer = new ArrayBuffer(payload.byteLength);
            new Uint8Array(buffer).set(payload);
            try { socket.onmessage?.({ data: buffer }); } catch { /* isolate */ }
            return;
          }
          if (frameType === TunnelFrameType.WsClose) {
            let close = { code: 1000, reason: '' };
            try { close = decodeJsonPayload(payload, isWsClosePayload); } catch { /* defaults */ }
            settleClose(close.code, close.reason);
            return;
          }
          if (frameType === TunnelFrameType.StreamAbort) {
            let reason = 'stream aborted';
            try { reason = decodeJsonPayload(payload, isStreamAbortPayload).reason; } catch { /* generic */ }
            settleClose(1006, reason, true);
          }
        },
        fail(error) {
          settleClose(1012, error.message, true);
        },
      });
      const { path, query } = splitPathQuery(pathWithQuery);
      const payload = {
        path,
        query,
        ...(protocols?.length ? { protocols } : {}),
        ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
      };
      if (!isTunnelWsOpenPayload(payload)) {
        settleClose(1002, 'invalid WebSocket open payload', true);
        return;
      }
      channel.send(encodeTunnelFrame(TunnelFrameType.WsOpen, streamId, encodeJsonPayload(payload)));
    })();

    return socket;
  };

  const close = () => {
    if (closed) return;
    closed = true;
    attemptGeneration += 1;
    clearReconnectTimer();
    currentAttemptCleanup?.();
    currentAttemptCleanup = null;
    const channel = activeChannel;
    activeChannel = null;
    if (channel) failChannelStreams(channel, tunnelError('relay tunnel closed', 'relay_tunnel_closed'));
    rejectWaiters(tunnelError('relay tunnel closed', 'relay_tunnel_closed'));
    try { currentWire?.close(); } catch { /* already closed */ }
    currentWire = null;
    setStatus({ state: 'idle' });
  };

  void connect();

  return {
    fetch: tunnelFetch,
    openWebSocket: openTunnelWebSocket,
    getStatus: () => status,
    subscribeStatus(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    close,
  };
};
