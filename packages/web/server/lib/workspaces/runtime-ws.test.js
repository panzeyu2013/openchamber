import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';

import { createCatalogStore } from './catalog-store.js';
import { createConnectionProfileStore } from './connection-profile-store.js';
import { createConnectionBroker } from './connection-broker.js';
import { createLocalWorkspaceAdapter } from './local-adapter.js';
import { WORKSPACE_RUNTIME_UPGRADE_MARKER, handleWorkspaceUpgrade } from './runtime-proxy.js';
import { createRequestSecurityRuntime } from '../security/request-security.js';

const fsPromises = fs.promises;

/** Boots a real HTTP server with the workspaces runtime pieces wired exactly
 * like the server entrypoint: the central workspace upgrade dispatcher is the
 * FIRST `upgrade` listener, and a module-style listener (mimicking the
 * terminal runtime) is registered afterwards to prove non-workspace upgrades
 * stay untouched. A fake upstream ws server receives forwarded upgrades. */
const createHarness = async ({ adapter = null, uiAuthController = null } = {}) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-ws-test-'));
  const upstreamServer = new WebSocketServer({ port: 0 });
  await new Promise((resolve) => upstreamServer.once('listening', resolve));
  const upstreamPort = upstreamServer.address().port;
  const upstreamConnections = [];
  upstreamServer.on('connection', (socket) => {
    upstreamConnections.push(socket);
    socket.on('message', (data, isBinary) => {
      socket.send(`echo:${isBinary ? 'binary' : 'text'}:${data}`, { binary: isBinary });
    });
  });

  const catalogStore = createCatalogStore({
    fs: fsPromises,
    path,
    filePath: path.join(tempDir, 'workspace-catalog.json'),
  });
  const profileStore = createConnectionProfileStore({
    fs: fsPromises,
    filePath: path.join(tempDir, 'connection-profiles.json'),
  });
  await Promise.all([catalogStore.load(), profileStore.load()]);

  const broker = createConnectionBroker({ profileStore });
  broker.registerAdapter(adapter ?? createLocalWorkspaceAdapter({
    fs: fsPromises,
    path,
    buildOpenCodeUrl: (restPath) => `http://127.0.0.1:${upstreamPort}${restPath}`,
    getOpenCodeAuthHeaders: async () => ({ 'x-openchamber-runtime-auth': 'injected-secret' }),
  }));
  await profileStore.upsertConnection({ id: 'local', label: 'Local', target: { kind: 'local' } });
  const { descriptor: workspace } = await catalogStore.createWorkspace({
    connectionId: 'local',
    canonicalPath: '/workspace/a',
    path: '/workspace/a',
    label: 'A',
    orderKey: '',
  });

  const app = express();
  const server = http.createServer(app);

  const { rejectWebSocketUpgrade } = createRequestSecurityRuntime({ readSettingsFromDiskMigrated: async () => ({}) });
  const upgradeRejections = [];

  server.on('upgrade', (req, socket, head) => {
    void handleWorkspaceUpgrade(req, socket, head, {
      catalogStore,
      connectionBroker: broker,
      getUiAuthController: () => uiAuthController,
      isRequestOriginAllowed: async () => true,
      rejectWebSocketUpgrade: (socket, status, message) => {
        upgradeRejections.push({ status, message });
        rejectWebSocketUpgrade(socket, status, message);
      },
    });
  });

  // Module-style listener registered AFTER the dispatcher, like the terminal
  // runtime: it owns only its exact path and skips dispatcher-marked
  // workspace upgrades.
  const moduleWsServer = new WebSocketServer({ noServer: true });
  const moduleConnections = [];
  moduleWsServer.on('connection', (socket) => { moduleConnections.push(socket); });
  server.on('upgrade', (req, socket, head) => {
    if (req[WORKSPACE_RUNTIME_UPGRADE_MARKER]) return;
    let pathname = '';
    try { pathname = new URL(req.url, 'http://127.0.0.1').pathname; } catch { return; }
    if (pathname !== '/api/terminal/ws') return;
    moduleWsServer.handleUpgrade(req, socket, head, (ws) => moduleWsServer.emit('connection', ws, req));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  return {
    tempDir,
    server,
    baseUrl,
    wsUrl: baseUrl.replace(/^http/, 'ws'),
    workspace,
    upstreamServer,
    upstreamConnections,
    moduleConnections,
    upgradeRejections,
  };
};

const waitForMessage = (socket) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('timed out waiting for socket message')), 5000);
  socket.on('message', (data) => { clearTimeout(timer); resolve(data); });
});

const open = async (url) => {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return socket;
};

/** Asserts the server rejects the upgrade: the client never completes the
 * handshake. Bun's http server does not deliver raw-socket error responses
 * to upgrade requests (the client only observes a reset), so the
 * authoritative status assertions come from the harness-recorded
 * `upgradeRejections`; this helper proves the upgrade never succeeded. */
const expectRejected = (url) => new Promise((resolve, reject) => {
  const socket = new WebSocket(url);
  let settled = false;
  // bun's ws client can emit `error` more than once on a rejected upgrade;
  // `.on` (not `.once`) keeps every emission handled.
  socket.on('error', () => { if (!settled) { settled = true; resolve(); } });
  socket.once('open', () => { if (!settled) { settled = true; socket.terminate(); reject(new Error('upgrade unexpectedly succeeded')); } });
});

describe('workspace runtime WebSocket upgrades (integration)', () => {
  let harness;
  afterEach(async () => {
    if (!harness) return;
    harness.upstreamServer.close();
    harness.server.closeAllConnections?.();
    await new Promise((resolve) => harness.server.close(resolve));
    fs.rmSync(harness.tempDir, { recursive: true, force: true });
    harness = null;
  });

  it('forwards a workspace-prefixed upgrade to the adapter upstream and pipes both ways', async () => {
    harness = await createHarness();
    const socket = await open(`${harness.wsUrl}/api/workspaces/${harness.workspace.id}/runtime/api/event/ws`);
    socket.send('ping');
    expect((await waitForMessage(socket)).toString()).toBe('echo:text:ping');
    expect(harness.upstreamConnections).toHaveLength(1);
    // Exactly one handler: the module-style listener never saw this upgrade.
    expect(harness.moduleConnections).toHaveLength(0);
    expect(harness.upgradeRejections).toHaveLength(0);
    socket.close();
  });

  it('injects upstream auth and directory headers, and never forwards browser auth', async () => {
    harness = await createHarness();
    let capturedHeaders = null;
    harness.upstreamServer.on('connection', (socket, req) => { capturedHeaders = req.headers; });
    const socket = await open(`${harness.wsUrl}/api/workspaces/${harness.workspace.id}/runtime/api/terminal/ws?oc_url_token=control-plane-token`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(capturedHeaders['x-openchamber-runtime-auth']).toBe('injected-secret');
    expect(capturedHeaders['x-opencode-directory']).toBe('/workspace/a');
    expect(capturedHeaders.cookie).toBeUndefined();
    // The control-plane URL token must never reach the upstream.
    expect(harness.upstreamConnections[0]?.url ?? '').not.toContain('oc_url_token');
    socket.close();
  });

  it('rejects unauthenticated workspace upgrades with 401', async () => {
    harness = await createHarness({
      uiAuthController: { enabled: true, ensureSessionToken: async () => null },
    });
    await expectRejected(`${harness.wsUrl}/api/workspaces/${harness.workspace.id}/runtime/api/event/ws`);
    expect(harness.upgradeRejections).toEqual([{ status: 401, message: expect.stringContaining('authentication') }]);
    expect(harness.upstreamConnections).toHaveLength(0);
  });

  it('rejects workspace upgrades when the connection lacks the capability', async () => {
    const withoutCapability = {
      connectionId: 'local',
      kind: 'local',
      capabilities: { pathBrowse: true, terminal: false, files: true, git: true, eventStream: false },
      fetch: async () => new Response('x', { status: 200 }),
      openWebSocket: async () => { throw new Error('must not be called'); },
      dispose: async () => {},
    };
    harness = await createHarness({ adapter: withoutCapability });
    await expectRejected(`${harness.wsUrl}/api/workspaces/${harness.workspace.id}/runtime/api/terminal/ws`);
    expect(harness.upgradeRejections).toEqual([{ status: 501, message: expect.stringContaining('terminal streaming is not available') }]);
    expect(harness.upstreamConnections).toHaveLength(0);
  });

  it('leaves non-workspace upgrades to the existing module listeners', async () => {
    harness = await createHarness();
    const socket = await open(`${harness.wsUrl}/api/terminal/ws`);
    socket.send('module-hello');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.moduleConnections).toHaveLength(1);
    expect(harness.upstreamConnections).toHaveLength(0);
    expect(harness.upgradeRejections).toHaveLength(0);
    socket.close();
  });

  it('does not intercept workspace-prefixed upgrades that are not sockets', async () => {
    harness = await createHarness();
    // An HTTP path under the runtime prefix that is not an upgrade path is
    // rejected by the dispatcher with an explicit error, never silently
    // forwarded or swallowed.
    await expectRejected(`${harness.wsUrl}/api/workspaces/${harness.workspace.id}/runtime/api/fs/list`);
    expect(harness.upgradeRejections).toEqual([{ status: 404, message: expect.stringContaining('forwardable workspace socket') }]);
    expect(harness.upstreamConnections).toHaveLength(0);
  });
});
