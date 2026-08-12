import { describe, expect, test } from 'bun:test';
import type { RelayTunnelWebSocket } from '@/lib/relay/tunnel-client';
import { createChatDraftIdentity, readChatDraft, writeChatDraft, type ChatDraftIdentity } from '@/lib/chatDraftPersistence';
import { usePermissionStore } from '@/stores/permissionStore';
import { ChildStoreManager } from '@/sync/child-store';
import { clearSyncRefs, setSyncRefs } from '@/sync/sync-refs';
import { workspaceScopeKey } from './identity';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const parseFrame = (value: string | ArrayBuffer | ArrayBufferView): Record<string, unknown> => {
  const bytes = typeof value === 'string'
    ? encoder.encode(value)
    : value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return JSON.parse(decoder.decode(bytes.subarray(1))) as Record<string, unknown>;
};

const encodeFrame = (message: Record<string, unknown>): ArrayBuffer => {
  const body = encoder.encode(JSON.stringify(message));
  const frame = new Uint8Array(body.length + 1);
  frame[0] = 1;
  frame.set(body, 1);
  return frame.buffer;
};

class FakeSocket implements RelayTunnelWebSocket {
  readyState = 0;
  binaryType: 'blob' | 'arraybuffer' = 'arraybuffer';
  onopen: (() => void) | null = null;
  onmessage: RelayTunnelWebSocket['onmessage'] = null;
  onerror: (() => void) | null = null;
  onclose: RelayTunnelWebSocket['onclose'] = null;
  sent: Record<string, unknown>[] = [];

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  emit(message: Record<string, unknown>): void {
    this.onmessage?.({ data: encodeFrame(message) });
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    this.sent.push(parseFrame(data));
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: '' });
  }
}

const sockets: FakeSocket[] = [];
const openedUrls: string[] = [];

// Injected through the registry's openSocket seam (never mock.module, which
// is process-global and leaks into other workspaces/sync test files).
const testOpenSocket = (url: string): RelayTunnelWebSocket => {
  openedUrls.push(url);
  const socket = new FakeSocket();
  sockets.push(socket);
  return socket;
};

const { createWorkspaceRuntimeRegistry } = await import('./workspace-runtime-registry');

const descriptor = (id: string) => ({
  id,
  connectionId: `connection-${id}`,
  path: `/path/${id}`,
  canonicalPath: `/workspace/${id}`,
  label: id,
  orderKey: '0',
  createdAt: 0,
  updatedAt: 0,
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('workspace runtime terminal transport', () => {
  test('routes socket traffic and URL auth per workspace scope', async () => {
    sockets.length = 0;
    openedUrls.length = 0;
    let tokenRequests = 0;
    const registry = createWorkspaceRuntimeRegistry({
      controlPlaneFetch: async (input) => {
        expect(String(input)).toBe('/auth/url-token');
        tokenRequests += 1;
        return new Response(JSON.stringify({ token: `url-token-${tokenRequests}`, expiresAt: Date.now() + 60_000 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
      openSocket: testOpenSocket,
    });

    const first = registry.get(descriptor('ws-1'));
    const second = registry.get(descriptor('ws-2'));
    const firstEvents: string[] = [];
    const secondEvents: string[] = [];
    const firstSubscription = first.apis.terminal.connect('term-1', {
      onEvent: (event) => firstEvents.push(`${event.type}:${event.data ?? ''}`),
    });
    const secondSubscription = second.apis.terminal.connect('term-2', {
      onEvent: (event) => secondEvents.push(`${event.type}:${event.data ?? ''}`),
    });

    await tick();
    await tick();
    expect(tokenRequests).toBe(2);
    expect(openedUrls[0]).toContain('/api/workspaces/ws-1/runtime/api/terminal/ws');
    expect(openedUrls[1]).toContain('/api/workspaces/ws-2/runtime/api/terminal/ws');
    expect(new URL(openedUrls[0]!).searchParams.get('oc_url_token')).toBe('url-token-1');
    expect(new URL(openedUrls[1]!).searchParams.get('oc_url_token')).toBe('url-token-2');

    sockets[0]!.open();
    sockets[1]!.open();
    await tick();
    expect(sockets[0]!.sent.some((message) => message.t === 'attach' && message.v === 3 && message.s === 'term-1')).toBe(true);
    expect(sockets[1]!.sent.some((message) => message.t === 'attach' && message.v === 3 && message.s === 'term-2')).toBe(true);

    sockets[0]!.emit({ t: 'snapshot', v: 3, s: 'term-1', q: 1, history: 'one', status: 'running' });
    sockets[1]!.emit({ t: 'snapshot', v: 3, s: 'term-2', q: 1, history: 'two', status: 'running' });
    await tick();
    expect(firstEvents).toEqual(['snapshot:one']);
    expect(secondEvents).toEqual(['snapshot:two']);

    await second.apis.terminal.sendInput('term-2', 'echo two\r');
    expect(sockets[1]!.sent.some((message) => message.t === 'write' && message.v === 3 && message.s === 'term-2' && message.d === 'echo two\r')).toBe(true);
    expect(sockets[0]!.sent.some((message) => message.t === 'write' && message.v === 3 && message.s === 'term-2' && message.d === 'echo two\r')).toBe(false);

    firstSubscription.close();
    first.dispose();
    expect(sockets[0]!.readyState).toBe(3);
    expect(sockets[1]!.readyState).toBe(1);
    secondSubscription.close();
    registry.dispose();
  });

  test('keeps messages, directories, terminal streams, permissions, and drafts isolated across 100 switches', async () => {
    sockets.length = 0;
    openedUrls.length = 0;
    let tokenRequests = 0;
    const registry = createWorkspaceRuntimeRegistry({
      controlPlaneFetch: async () => {
        tokenRequests += 1;
        return new Response(JSON.stringify({ token: `rapid-token-${tokenRequests}`, expiresAt: Date.now() + 60_000 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
      openSocket: testOpenSocket,
    });
    const childStores = new ChildStoreManager('ambient-runtime');
    const draftIdentities: ChatDraftIdentity[] = [];

    try {
      for (let index = 0; index < 100; index += 1) {
        const workspaceId = `rapid-${index}`;
        const scopeKey = workspaceScopeKey(workspaceId);
        const directory = '/same/repository';
        const sessionId = 'same-session';
        const handle = registry.get(descriptor(workspaceId));
        const child = childStores.ensureChild(directory, { bootstrap: false, scopeKey });
        child.getState().patch({
          message: {
            [sessionId]: [{
              info: { id: `message-${index}`, sessionID: sessionId, role: 'user', time: { created: index } },
              parts: [],
            } as never],
          },
          permission: {
            [sessionId]: [{
              id: `permission-${index}`,
              sessionID: sessionId,
              permission: 'bash',
              patterns: [],
              metadata: {},
              always: [],
            } as never],
          },
          question: {
            [sessionId]: [{
              id: `question-${index}`,
              sessionID: sessionId,
              questions: [],
            } as never],
          },
        });
        const identity = createChatDraftIdentity(scopeKey, directory, sessionId)!;
        draftIdentities.push(identity);
        writeChatDraft(identity, `draft-${index}`, []);
        expect(readChatDraft(identity).text).toBe(`draft-${index}`);

        setSyncRefs({} as never, childStores, directory, undefined, undefined, scopeKey);
        await usePermissionStore.getState().hydrate();
        expect(usePermissionStore.getState().autoAccept).toEqual({});

        const events: string[] = [];
        const subscription = handle.apis.terminal.connect('same-terminal', {
          onEvent: (event) => events.push(`${event.type}:${event.data ?? ''}`),
        });
        await tick();
        const socket = sockets[sockets.length - 1]!;
        socket.open();
        await tick();
        socket.emit({ t: 'snapshot', v: 3, s: 'same-terminal', q: 1, history: `terminal-${index}`, status: 'running' });
        await tick();
        expect(events).toEqual([`snapshot:terminal-${index}`]);
        subscription.close();
        handle.dispose();
      }

      expect(tokenRequests).toBe(100);
      expect(sockets).toHaveLength(100);
      const message = childStores.getChild('/same/repository', workspaceScopeKey('rapid-50'))?.getState().message['same-session']?.[0] as unknown as { info?: { id?: string } } | undefined;
      expect(message?.info?.id).toBe('message-50');
      const permission = childStores.getChild('/same/repository', workspaceScopeKey('rapid-50'))?.getState().permission['same-session']?.[0] as unknown as { id?: string } | undefined;
      expect(permission?.id).toBe('permission-50');
      expect(childStores.getChild('/same/repository', workspaceScopeKey('rapid-49'))?.getState().permission['same-session']?.[0]?.id).toBe('permission-49');
      const question = childStores.getChild('/same/repository', workspaceScopeKey('rapid-50'))?.getState().question['same-session']?.[0] as unknown as { id?: string } | undefined;
      expect(question?.id).toBe('question-50');
      expect(readChatDraft(draftIdentities[99]!).text).toBe('draft-99');
      expect(readChatDraft(draftIdentities[98]!).text).toBe('draft-98');
      expect(sockets[0]!.readyState).toBe(3);
      expect(sockets[99]!.readyState).toBe(3);
    } finally {
      usePermissionStore.getState().reset();
      clearSyncRefs();
      childStores.disposeAll();
      registry.dispose();
    }
  });
});
