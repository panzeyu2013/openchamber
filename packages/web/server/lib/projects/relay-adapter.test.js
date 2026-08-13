import { afterEach, describe, expect, it } from 'bun:test';
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';

import { startRelayHost } from '../relay/host-client.js';
import { exportPublicKeyJwk, generateEcdhKeyPair, importEcdhPrivateKey } from '../relay/e2ee.js';
import { createRelayTunnelClient } from '../relay/tunnel-client.js';
import { createConnectionBroker } from './connection-broker.js';
import { createRelayProjectAdapter } from './relay-adapter.js';

const resources = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (predicate, { timeoutMs = 5_000, intervalMs = 20 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await sleep(intervalMs);
  }
};

const waitForStatus = async (client, predicate, options) => {
  await waitFor(() => predicate(client.getStatus()), options);
  return client.getStatus();
};

const listen = (server) => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

const closeServer = (server) => new Promise((resolve) => {
  if (!server) return resolve();
  let settled = false;
  const done = () => {
    if (settled) return;
    settled = true;
    resolve();
  };
  server.close(done);
  server.closeAllConnections?.();
  const fallback = setTimeout(done, 250);
  fallback.unref?.();
});

/** Minimal blind relay. It routes a client to the matching host-data socket
 * after notifying the host-control socket, but never parses post-handshake
 * frames. The adapter test therefore exercises the real Layer 2/3 wire.
 *
 * `authFail: true` closes every client connection with the relay's auth-failed
 * close code (4010) before any routing, mimicking the relay worker rejecting a
 * client credential. */
const startFakeRelay = async ({ authFail = false } = {}) => {
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  const controls = new Map();
  const hostData = new Map();
  const clients = new Map();
  const buffered = new Map();
  const counts = { clients: 0 };

  const keyOf = (serverId, connectionId) => `${serverId}\0${connectionId}`;
  const route = (serverId, connectionId, data, isBinary, from) => {
    const key = keyOf(serverId, connectionId);
    const target = from === 'client' ? hostData.get(key) : clients.get(key);
    if (target?.readyState === WebSocket.OPEN) {
      target.send(data, { binary: isBinary });
      return;
    }
    if (from === 'client') {
      const queue = buffered.get(key) ?? [];
      queue.push([data, isBinary]);
      buffered.set(key, queue);
    }
  };

  wss.on('connection', (socket, request) => {
    const url = new URL(request.url, 'http://relay.invalid');
    const role = url.searchParams.get('role');
    const serverId = url.searchParams.get('serverId') ?? '';
    const connectionId = url.searchParams.get('connectionId') ?? '';
    if (!serverId || (role !== 'host-control' && !connectionId)) {
      socket.close(1008, 'invalid route');
      return;
    }
    if (role === 'host-control') {
      controls.set(serverId, socket);
      const activeIds = [];
      for (const key of clients.keys()) {
        if (key.startsWith(`${serverId}\0`)) activeIds.push(key.slice(serverId.length + 1));
      }
      socket.send(JSON.stringify({ type: 'sync', connectionIds: activeIds }));
      socket.on('close', () => {
        if (controls.get(serverId) === socket) controls.delete(serverId);
      });
      return;
    }
    const key = keyOf(serverId, connectionId);
    if (role === 'host-data') {
      hostData.set(key, socket);
      for (const [data, isBinary] of buffered.get(key) ?? []) socket.send(data, { binary: isBinary });
      buffered.delete(key);
      socket.on('message', (data, isBinary) => route(serverId, connectionId, data, isBinary, 'host'));
      socket.on('close', () => {
        if (hostData.get(key) === socket) hostData.delete(key);
      });
      return;
    }
    if (role === 'client') {
      counts.clients += 1;
      if (authFail) {
        socket.close(4010, 'authentication failed');
        return;
      }
      clients.set(key, socket);
      socket.on('message', (data, isBinary) => route(serverId, connectionId, data, isBinary, 'client'));
      socket.on('close', () => {
        if (clients.get(key) === socket) clients.delete(key);
        // A dead client leg tears down the matching host-data leg and tells
        // the control socket, so the host opens a FRESH responder handshake
        // when the client reconnects (mirrors the relay worker).
        hostData.get(key)?.terminate();
        const control = controls.get(serverId);
        if (control?.readyState === WebSocket.OPEN) {
          control.send(JSON.stringify({ type: 'disconnected', connectionId }));
        }
      });
      const control = controls.get(serverId);
      if (control?.readyState === WebSocket.OPEN) {
        control.send(JSON.stringify({ type: 'connected', connectionId }));
      }
    }
  });
  server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client, request));
  });

  const port = await listen(server);
  const stop = async () => {
    for (const socket of [...controls.values(), ...hostData.values(), ...clients.values()]) socket.terminate();
    for (const socket of wss.clients) socket.terminate();
    wss.close();
    await closeServer(server);
  };
  return { relayUrl: `ws://127.0.0.1:${port}`, counts, terminateClient: (serverId, connectionId) => clients.get(keyOf(serverId, connectionId))?.terminate(), stop };
};

const startRemoteOrigin = async () => {
  const server = http.createServer(async (request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.url?.startsWith('/api/session')) {
      let body = '';
      for await (const chunk of request) body += chunk;
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: body ? 'created-with-body' : 'created' }));
      return;
    }
    if (request.url?.startsWith('/api/fs/list')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ entries: [{ name: 'project', path: '/remote/project', isDirectory: true }] }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (socket, request) => {
    socket.send(JSON.stringify({
      authorization: request.headers.authorization ?? null,
      directory: request.headers['x-opencode-directory'] ?? null,
      url: request.url ?? null,
    }));
    socket.on('message', (data, isBinary) => socket.send(data, { binary: isBinary }));
  });
  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url, 'http://remote.invalid').pathname;
    if (pathname !== '/api/terminal/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client, request));
  });
  const port = await listen(server);
  const stop = async () => {
    for (const client of wss.clients) client.terminate();
    wss.close();
    await closeServer(server);
  };
  return { port, stop };
};

const buildHostIdentity = async () => {
  const encryption = await generateEcdhKeyPair();
  const privateJwk = await globalThis.crypto.subtle.exportKey('jwk', encryption.privateKey);
  return {
    serverId: 'relay-adapter-test-server',
    hostEncPubJwk: await exportPublicKeyJwk(encryption.publicKey),
    hostEncPrivateKey: await importEcdhPrivateKey(privateJwk),
    signRelayAuth: () => ({ ts: Date.now(), sig: '', pk: '' }),
  };
};

afterEach(async () => {
  while (resources.length > 0) await resources.pop()();
});

describe('relay project adapter', () => {
  it('reuses one connection-keyed tunnel across HTTP, SSE, and WebSocket calls and closes it on dispose', async () => {
    const identity = await buildHostIdentity();
    const tunnels = [];
    const adapter = createRelayProjectAdapter({
      connectionId: 'connection-1',
      createTunnelClient: (options) => {
        const tunnel = {
          options,
          closed: false,
          fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
          openEventStream: async () => new Response('data: ok\n\n', { status: 200 }),
          openWebSocket: () => ({ socket: {} }),
          close: () => { tunnel.closed = true; },
        };
        tunnels.push(tunnel);
        return tunnel;
      },
    });
    const context = {
      profile: { target: { kind: 'relay', relayId: identity.serverId, credentialRef: 'credential-1' } },
      credentialProvider: {
        resolveCredential: async () => ({
          relay: {
            relayUrl: 'wss://relay.example.test',
            serverId: identity.serverId,
            hostEncPubJwk: identity.hostEncPubJwk,
          },
          token: 'private-token',
        }),
      },
    };

    await adapter.probe(context);
    await adapter.fetch(context, { method: 'GET', headers: {} }, '/api/session');
    await adapter.openEventStream(context, '/api/global/event', new AbortController().signal);
    const spec = await adapter.openWebSocket(context, { path: '/api/terminal/ws', headers: {}, query: {} });
    expect(spec.socket).toBeDefined();

    expect(tunnels).toHaveLength(1);
    expect(tunnels[0].options.connectionId).toBe('connection-1');
    expect(tunnels[0].options).not.toHaveProperty('token');
    await adapter.dispose();
    expect(tunnels[0].closed).toBe(true);
  });

  it('multiplexes HTTP and WebSocket traffic over the real relay wire', async () => {
    const relay = await startFakeRelay();
    resources.push(relay.stop);
    const origin = await startRemoteOrigin();
    resources.push(origin.stop);
    const identity = await buildHostIdentity();
    const host = startRelayHost({
      relayUrl: relay.relayUrl,
      identity,
      getLocalPort: () => origin.port,
      logger: console,
    });
    resources.push(async () => host.stop());

    const credentialProvider = {
      resolveCredential: async () => ({
        relay: {
          relayUrl: relay.relayUrl,
          serverId: identity.serverId,
          hostEncPubJwk: identity.hostEncPubJwk,
        },
        token: 'remote-client-token',
      }),
    };
    const adapter = createRelayProjectAdapter({
      connectionId: 'connection-1',
      tunnelOptions: {
        helloTimeoutMs: 2_000,
        reconnectBaseDelayMs: 10,
        reconnectMaxDelayMs: 50,
      },
    });
    resources.push(async () => adapter.dispose());
    const context = {
      canonicalPath: '/remote/project',
      profile: { target: { kind: 'relay', relayId: identity.serverId, credentialRef: 'credential-1' } },
      credentialProvider,
    };

    const probe = await adapter.probe(context);
    expect(probe.ok).toBe(true);
    expect(probe.capabilities.eventStream).toBe(true);

    const response = await adapter.fetch(context, {
      method: 'POST',
      headers: { 'x-opencode-directory': '/remote/project' },
      body: { prompt: 'hello' },
    }, '/api/session?from=relay');
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: 'created-with-body' });

    const children = await adapter.listChildren(context, '/remote/project');
    expect(children.children[0]).toEqual({ name: 'project', path: '/remote/project', kind: 'directory' });

    const spec = await adapter.openWebSocket(context, {
      path: '/api/terminal/ws',
      query: { ignored: 'yes', oc_url_token: 'control-plane-secret' },
      headers: { authorization: 'Bearer browser-secret' },
    });
    expect(spec.url).toBeUndefined();
    const socket = spec.socket;
    const opened = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out opening tunneled WebSocket')), 2_000);
      socket.onopen = () => { clearTimeout(timer); resolve(); };
      socket.onerror = () => { clearTimeout(timer); reject(new Error('tunneled WebSocket failed')); };
    });
    const message = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out receiving tunneled WebSocket message')), 2_000);
      socket.onmessage = (event) => { clearTimeout(timer); resolve(JSON.parse(event.data)); };
    });
    await opened;
    socket.send('ignored until open');
    expect(await message).toEqual(expect.objectContaining({
      authorization: 'Bearer remote-client-token',
      directory: '/remote/project',
    }));
    socket.close();
  });

  it('passes a provider-supplied upstream url token on tunneled WebSocket upgrades', async () => {
    const relay = await startFakeRelay();
    resources.push(relay.stop);
    const origin = await startRemoteOrigin();
    resources.push(origin.stop);
    const identity = await buildHostIdentity();
    const host = startRelayHost({
      relayUrl: relay.relayUrl,
      identity,
      getLocalPort: () => origin.port,
      logger: console,
    });
    resources.push(async () => host.stop());

    const adapter = createRelayProjectAdapter({
      connectionId: 'connection-1',
      tunnelOptions: {
        helloTimeoutMs: 2_000,
        reconnectBaseDelayMs: 10,
        reconnectMaxDelayMs: 50,
      },
    });
    resources.push(async () => adapter.dispose());
    const context = {
      canonicalPath: '/remote/project',
      profile: { target: { kind: 'relay', relayId: identity.serverId, credentialRef: 'credential-1' } },
      credentialProvider: {
        resolveCredential: async () => ({
          relay: {
            relayUrl: relay.relayUrl,
            serverId: identity.serverId,
            hostEncPubJwk: identity.hostEncPubJwk,
          },
          token: 'remote-client-token',
          urlToken: 'upstream-url-token',
        }),
      },
    };

    const spec = await adapter.openWebSocket(context, {
      path: '/api/terminal/ws',
      query: { oc_url_token: 'control-plane-token', x: '1' },
      headers: {},
    });
    const socket = spec.socket;
    const opened = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out opening tunneled WebSocket')), 2_000);
      socket.onopen = () => { clearTimeout(timer); resolve(); };
      socket.onerror = () => { clearTimeout(timer); reject(new Error('tunneled WebSocket failed')); };
    });
    const message = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out receiving tunneled WebSocket message')), 2_000);
      socket.onmessage = (event) => { clearTimeout(timer); resolve(JSON.parse(event.data)); };
    });
    await opened;
    const received = await message;
    const upstreamUrl = new URL(received.url, 'http://remote.invalid');
    expect(received).toEqual(expect.objectContaining({
      authorization: 'Bearer remote-client-token',
      directory: '/remote/project',
    }));
    // The provider's URL token reaches the upstream query; the control-plane
    // token the browser may have appended is never forwarded.
    expect(upstreamUrl.searchParams.get('oc_url_token')).toBe('upstream-url-token');
    expect(upstreamUrl.searchParams.get('x')).toBe('1');
    socket.close();
  });

  it('closes the connection tunnel once the last broker lease releases after the idle grace', async () => {
    const identity = await buildHostIdentity();
    const tunnels = [];
    const adapter = createRelayProjectAdapter({
      connectionId: 'connection-1',
      createTunnelClient: (options) => {
        const tunnel = {
          options,
          closed: false,
          fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
          openWebSocket: () => { throw new Error('not needed'); },
          close: () => { tunnel.closed = true; },
        };
        tunnels.push(tunnel);
        return tunnel;
      },
    });
    const broker = createConnectionBroker({ idleGraceMs: 40 });
    broker.registerAdapter(adapter);
    const context = {
      profile: { target: { kind: 'relay', relayId: identity.serverId, credentialRef: 'credential-1' } },
      credentialProvider: {
        resolveCredential: async () => ({
          relay: {
            relayUrl: 'wss://relay.example.test',
            serverId: identity.serverId,
            hostEncPubJwk: identity.hostEncPubJwk,
          },
          token: 'private-token',
        }),
      },
    };

    const release1 = broker.acquireLease('connection-1');
    const release2 = broker.acquireLease('connection-1');
    await adapter.probe(context);
    expect(tunnels).toHaveLength(1);

    release1();
    await sleep(20);
    expect(tunnels[0].closed).toBe(false);
    release2();
    await sleep(20);
    expect(tunnels[0].closed).toBe(false);
    await sleep(80);
    expect(tunnels[0].closed).toBe(true);
    expect(broker.getLifecycleState('connection-1').leaseCount).toBe(0);
    await broker.dispose();
  });

  it('isolates a failed relay connection from other connections', async () => {
    const relay = await startFakeRelay();
    resources.push(relay.stop);
    const origin = await startRemoteOrigin();
    resources.push(origin.stop);
    const identity = await buildHostIdentity();
    const host = startRelayHost({
      relayUrl: relay.relayUrl,
      identity,
      getLocalPort: () => origin.port,
      logger: console,
    });
    resources.push(async () => host.stop());

    const options = {
      relayUrl: relay.relayUrl,
      serverId: identity.serverId,
      hostEncPubJwk: identity.hostEncPubJwk,
      helloTimeoutMs: 2_000,
      reconnectBaseDelayMs: 120,
      reconnectMaxDelayMs: 400,
    };
    const client1 = createRelayTunnelClient({ ...options, connectionId: 'connection-1' });
    const client2 = createRelayTunnelClient({ ...options, connectionId: 'connection-2' });
    resources.push(() => { client1.close(); client2.close(); });
    await waitForStatus(client1, (status) => status.state === 'connected');
    await waitForStatus(client2, (status) => status.state === 'connected');

    const health = await client2.fetch('/health', { headers: {} });
    expect(health.status).toBe(200);

    relay.terminateClient(identity.serverId, 'connection-1');
    await waitForStatus(client1, (status) => status.state === 'reconnecting');
    expect(client2.getStatus().state).toBe('connected');
    const healthAfter = await client2.fetch('/health', { headers: {} });
    expect(healthAfter.status).toBe(200);

    await waitForStatus(client1, (status) => status.state === 'connected', { timeoutMs: 5_000 });
  });
});

describe('relay tunnel client reconnect semantics (server-side initiator)', () => {
  it('treats relay auth failure as terminal: error status, no reconnect, requests fail fast', async () => {
    const relay = await startFakeRelay({ authFail: true });
    resources.push(relay.stop);
    const identity = await buildHostIdentity();
    const client = createRelayTunnelClient({
      relayUrl: relay.relayUrl,
      serverId: identity.serverId,
      connectionId: 'connection-1',
      hostEncPubJwk: identity.hostEncPubJwk,
      reconnectBaseDelayMs: 100,
      reconnectMaxDelayMs: 200,
    });
    resources.push(() => client.close());

    const status = await waitForStatus(client, (next) => next.state === 'error');
    expect(status.lastError).toContain('relay authentication failed');
    await sleep(300);
    expect(relay.counts.clients).toBe(1);
    await expect(client.fetch('/health', { headers: {} }))
      .rejects.toMatchObject({ code: 'relay_tunnel_failed' });
  });

  it('backs off after EOF and recovers through a fresh handshake', async () => {
    const relay = await startFakeRelay();
    resources.push(relay.stop);
    const identity = await buildHostIdentity();
    const host = startRelayHost({
      relayUrl: relay.relayUrl,
      identity,
      getLocalPort: () => 1,
      logger: console,
    });
    resources.push(async () => host.stop());
    const client = createRelayTunnelClient({
      relayUrl: relay.relayUrl,
      serverId: identity.serverId,
      connectionId: 'connection-1',
      hostEncPubJwk: identity.hostEncPubJwk,
      reconnectBaseDelayMs: 120,
      reconnectMaxDelayMs: 400,
      helloTimeoutMs: 2_000,
    });
    resources.push(() => client.close());
    await waitForStatus(client, (status) => status.state === 'connected');

    relay.terminateClient(identity.serverId, 'connection-1');
    await waitForStatus(client, (status) => status.state === 'reconnecting');

    const connectionsAfterEof = relay.counts.clients;
    await sleep(60);
    expect(relay.counts.clients).toBe(connectionsAfterEof);

    await waitForStatus(client, (status) => status.state === 'connected', { timeoutMs: 5_000 });
    expect(relay.counts.clients).toBeGreaterThan(connectionsAfterEof);
  });

  it('backs off after a handshake failure instead of fast-retrying, and close() cancels reconnects', async () => {
    const relay = await startFakeRelay();
    resources.push(relay.stop);
    const identity = await buildHostIdentity();
    const client = createRelayTunnelClient({
      relayUrl: relay.relayUrl,
      serverId: identity.serverId,
      connectionId: 'connection-1',
      hostEncPubJwk: identity.hostEncPubJwk,
      reconnectBaseDelayMs: 120,
      reconnectMaxDelayMs: 300,
      helloRetryMs: 60,
      helloTimeoutMs: 200,
    });
    resources.push(() => client.close());

    await waitForStatus(client, (status) => status.state === 'reconnecting');
    const connectionsAfterFailure = relay.counts.clients;
    const startedAt = Date.now();
    await waitFor(() => relay.counts.clients > connectionsAfterFailure, { timeoutMs: 3_000 });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);

    client.close();
    const connectionsAtClose = relay.counts.clients;
    await sleep(500);
    expect(relay.counts.clients).toBe(connectionsAtClose);
  });
});
