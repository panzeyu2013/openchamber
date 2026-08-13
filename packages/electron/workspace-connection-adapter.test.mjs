import { afterEach, describe, expect, it } from 'bun:test';
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

import { createSshWorkspaceConnectionAdapter } from './workspace-connection-adapter.mjs';

const resources = [];

const listen = (server) => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

const closeServer = async (server) => {
  for (const socket of server.__webSockets ?? []) socket.terminate();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(() => resolve()));
};

const openSocket = (url, headers) => new Promise((resolve, reject) => {
  const socket = new WebSocket(url, { headers });
  socket.once('open', () => resolve(socket));
  socket.once('error', reject);
});

const nextMessage = (socket) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('timed out waiting for SSH adapter socket message')), 2_000);
  socket.once('message', (data) => {
    clearTimeout(timer);
    resolve(data.toString());
  });
});

afterEach(async () => {
  while (resources.length > 0) await resources.pop()();
});

describe('Electron SSH workspace connection adapter', () => {
  it('forwards HTTP, SSE, and WebSocket traffic through the active tunnel with server credentials', async () => {
    let connected = true;
    let capturedHttpHeaders = null;
    let capturedWsHeaders = null;
    const server = http.createServer((request, response) => {
      if (request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      if (request.url === '/api/fs/list') {
        capturedHttpHeaders = request.headers;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ entries: [{ name: 'src', path: '/remote/src', isDirectory: true }] }));
        return;
      }
      if (request.url === '/api/global/event') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end('data: {"type":"session.status"}\n\n');
        return;
      }
      response.writeHead(404);
      response.end();
    });
    const wss = new WebSocketServer({ noServer: true });
    server.__webSockets = [];
    wss.on('connection', (socket, request) => {
      server.__webSockets.push(socket);
      capturedWsHeaders = request.headers;
      socket.on('message', (data, isBinary) => socket.send(data, { binary: isBinary }));
    });
    server.on('upgrade', (request, socket, head) => {
      wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client, request));
    });
    const port = await listen(server);
    resources.push(async () => {
      wss.close();
      await closeServer(server);
    });

    const origin = `http://127.0.0.1:${port}`;
    const sshManager = {
      async statusesWithDefaults(id) {
        return [{ id, phase: connected ? 'ready' : 'idle', localUrl: connected ? origin : null }];
      },
      runtimeCredentialsForInstance: () => ({ clientToken: 'ssh-runtime-token' }),
    };
    const adapter = createSshWorkspaceConnectionAdapter({
      connectionId: 'ssh:one',
      label: 'SSH One',
      sshInstanceId: 'one',
      sshManager,
      fetchImpl: globalThis.fetch,
    });
    const context = {
      profile: { target: { kind: 'ssh', sshInstanceId: 'one' } },
      canonicalPath: '/remote',
    };

    await expect(adapter.probe(context, '/remote')).resolves.toMatchObject({ ok: true });
    const children = await adapter.listChildren(context, '/remote');
    expect(children.children).toEqual([{ name: 'src', path: '/remote/src', kind: 'directory' }]);
    expect(capturedHttpHeaders.authorization).toBe('Bearer ssh-runtime-token');
    expect(capturedHttpHeaders['x-openchamber-directory']).toBe('/remote');

    const response = await adapter.fetch(context, {
      method: 'GET',
      headers: new Headers({ authorization: 'Bearer browser-token', cookie: 'session=browser' }),
    }, '/api/fs/list');
    expect(response.status).toBe(200);
    expect(capturedHttpHeaders.authorization).toBe('Bearer ssh-runtime-token');
    expect(capturedHttpHeaders.cookie).toBeUndefined();

    const eventStream = await adapter.openEventStream(context, '/api/global/event', new AbortController().signal);
    expect(eventStream.headers.get('content-type')).toContain('text/event-stream');
    expect(await eventStream.text()).toContain('session.status');

    const spec = await adapter.openWebSocket(context, { path: '/api/terminal/ws?oc_url_token=control-plane-token' });
    expect(spec.url).toBe(`${origin.replace(/^http/, 'ws')}/api/terminal/ws`);
    const socket = await openSocket(spec.url, spec.headers);
    socket.send('terminal-ping');
    expect(await nextMessage(socket)).toBe('terminal-ping');
    expect(capturedWsHeaders.authorization).toBe('Bearer ssh-runtime-token');
    expect(capturedWsHeaders.cookie).toBeUndefined();
    socket.close();
  });

  it('returns an explicit capability-unavailable error after the SSH tunnel is disconnected', async () => {
    let connected = false;
    const sshManager = {
      async statusesWithDefaults(id) {
        return [{ id, phase: connected ? 'ready' : 'idle', localUrl: connected ? 'http://127.0.0.1:1' : null }];
      },
    };
    const adapter = createSshWorkspaceConnectionAdapter({
      connectionId: 'ssh:one',
      label: 'SSH One',
      sshInstanceId: 'one',
      sshManager,
      fetchImpl: globalThis.fetch,
    });
    const context = { profile: { target: { kind: 'ssh', sshInstanceId: 'one' } } };

    await expect(adapter.fetch(context, { method: 'GET', headers: new Headers() }, '/api/session'))
      .rejects.toMatchObject({ code: 'capability_unavailable', status: 503 });
    await expect(adapter.openEventStream(context, '/api/global/event', new AbortController().signal))
      .rejects.toMatchObject({ code: 'capability_unavailable', status: 503 });
    await expect(adapter.openWebSocket(context, { path: '/api/terminal/ws' }))
      .rejects.toMatchObject({ code: 'capability_unavailable', status: 503 });
    expect(connected).toBe(false);
  });
});
