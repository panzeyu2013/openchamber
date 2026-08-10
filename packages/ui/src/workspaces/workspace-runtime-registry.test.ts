import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { WorkspaceDescriptor } from './types';

interface FakeSdk {
  id: number;
  baseUrl: string;
  directory: string | undefined;
}

let sdkCalls: Array<{ baseUrl: string; directory: string | undefined }> = [];
let sdkCounter = 0;

mock.module('@/lib/opencode/client', () => ({
  createWorkspaceOpencodeClient: (config: { baseUrl: string; directory?: string }): FakeSdk => {
    sdkCalls.push({ baseUrl: config.baseUrl, directory: config.directory });
    sdkCounter += 1;
    return { id: sdkCounter, baseUrl: config.baseUrl, directory: config.directory };
  },
}));

const { createWorkspaceRuntimeRegistry } = await import('./workspace-runtime-registry');

const descriptor = (id: string, overrides: Partial<WorkspaceDescriptor> = {}): WorkspaceDescriptor => ({
  id,
  connectionId: 'conn-1',
  path: `/path/${id}`,
  canonicalPath: `/canonical/${id}`,
  label: id,
  orderKey: '0',
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('workspace runtime registry', () => {
  let registry: ReturnType<typeof createWorkspaceRuntimeRegistry> | undefined;

  beforeEach(() => {
    sdkCalls = [];
    sdkCounter = 0;
  });

  afterEach(() => {
    registry?.dispose();
  });

  test('get() creates a handle with workspace-scoped identity and sdk', () => {
    registry = createWorkspaceRuntimeRegistry();
    const handle = registry.get(descriptor('ws-1', { canonicalPath: '/projects/alpha' }));
    expect(handle.scopeKey).toBe('workspace:ws-1');
    expect(handle.directory).toBe('/projects/alpha');
    expect(sdkCalls).toEqual([{ baseUrl: '/api/workspaces/ws-1/runtime/api', directory: '/projects/alpha' }]);
  });

  test('get() with the same id returns the same handle without a new sdk', () => {
    registry = createWorkspaceRuntimeRegistry();
    const first = registry.get(descriptor('ws-1'));
    const second = registry.get(descriptor('ws-1', { canonicalPath: '/elsewhere' }));
    expect(second).toBe(first);
    expect(second.sdk).toBe(first.sdk);
    expect(second.directory).toBe('/canonical/ws-1');
    expect(sdkCalls).toHaveLength(1);
  });

  test('a handle survives the grace window while retained, then is evicted after release', async () => {
    registry = createWorkspaceRuntimeRegistry({ disposeGraceMs: 5 });
    const handle = registry.get(descriptor('ws-1'));
    const release = handle.retain();
    await sleep(20);
    expect(registry.get(descriptor('ws-1'))).toBe(handle);
    expect(sdkCalls).toHaveLength(1);
    release();
    await sleep(30);
    const next = registry.get(descriptor('ws-1'));
    expect(next).not.toBe(handle);
    expect(sdkCalls).toHaveLength(2);
  });

  test('release() is idempotent', async () => {
    registry = createWorkspaceRuntimeRegistry({ disposeGraceMs: 5 });
    const handle = registry.get(descriptor('ws-1'));
    const release = handle.retain();
    release();
    release();
    await sleep(30);
    expect(registry.get(descriptor('ws-1'))).not.toBe(handle);
    expect(sdkCalls).toHaveLength(2);
  });

  test('re-acquiring a lease during the grace period cancels disposal', async () => {
    registry = createWorkspaceRuntimeRegistry({ disposeGraceMs: 20 });
    const handle = registry.get(descriptor('ws-1'));
    handle.retain()();
    await sleep(10);
    expect(registry.get(descriptor('ws-1'))).toBe(handle);
    expect(sdkCalls).toHaveLength(1);
    handle.retain()();
    await sleep(40);
    expect(registry.get(descriptor('ws-1'))).not.toBe(handle);
    expect(sdkCalls).toHaveLength(2);
  });

  test('invalidate() disposes the handle immediately', () => {
    registry = createWorkspaceRuntimeRegistry();
    const first = registry.get(descriptor('ws-1'));
    registry.invalidate('ws-1');
    const second = registry.get(descriptor('ws-1'));
    expect(second).not.toBe(first);
    expect(sdkCalls).toHaveLength(2);
  });

  test('dispose() clears every handle', () => {
    registry = createWorkspaceRuntimeRegistry();
    const first = registry.get(descriptor('ws-1'));
    const other = registry.get(descriptor('ws-2'));
    registry.dispose();
    expect(registry.get(descriptor('ws-1'))).not.toBe(first);
    expect(registry.get(descriptor('ws-2'))).not.toBe(other);
    expect(sdkCalls).toHaveLength(4);
  });

  test('LRU eviction drops a released handle when over maxRetained', async () => {
    registry = createWorkspaceRuntimeRegistry({ maxRetained: 2 });
    const first = registry.get(descriptor('ws-1'));
    first.retain()();
    const second = registry.get(descriptor('ws-2'));
    const third = registry.get(descriptor('ws-3'));
    await sleep(10);
    expect(registry.get(descriptor('ws-1'))).not.toBe(first);
    expect(registry.get(descriptor('ws-2'))).toBe(second);
    expect(registry.get(descriptor('ws-3'))).toBe(third);
    expect(sdkCalls).toHaveLength(4);
  });

  test('LRU eviction also drops never-retained handles when over maxRetained', async () => {
    registry = createWorkspaceRuntimeRegistry({ maxRetained: 2 });
    const first = registry.get(descriptor('ws-1'));
    const second = registry.get(descriptor('ws-2'));
    const third = registry.get(descriptor('ws-3'));
    await sleep(10);
    expect(registry.get(descriptor('ws-1'))).not.toBe(first);
    expect(registry.get(descriptor('ws-2'))).toBe(second);
    expect(registry.get(descriptor('ws-3'))).toBe(third);
    expect(sdkCalls).toHaveLength(4);
  });
});
