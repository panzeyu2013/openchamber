import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { WorkspaceDescriptor } from './types';

interface FakeSdk {
  id: number;
  baseUrl: string;
  directory: string | undefined;
}

let sdkCalls: Array<{ baseUrl: string; directory: string | undefined }> = [];
let sdkCounter = 0;

const fakeCreateSdkClient = (config: { baseUrl: string; directory: string }): FakeSdk => {
  sdkCalls.push({ baseUrl: config.baseUrl, directory: config.directory });
  sdkCounter += 1;
  return { id: sdkCounter, baseUrl: config.baseUrl, directory: config.directory };
};

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

const expectCapabilityUnavailable = async (operation: Promise<unknown>): Promise<void> => {
  let error: unknown;
  try {
    await operation;
  } catch (caught) {
    error = caught;
  }

  expect(error).toBeDefined();
  const details = error as { code?: unknown; status?: unknown };
  expect(details.code).toBe('capability_unavailable');
  expect(details.status).toBe(501);
};

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
    registry = createWorkspaceRuntimeRegistry({ createSdkClient: fakeCreateSdkClient });
    const handle = registry.get(descriptor('ws-1', { canonicalPath: '/projects/alpha' }));
    expect(handle.scopeKey).toBe('workspace:ws-1');
    expect(handle.directory).toBe('/projects/alpha');
    expect(handle.service.getSdkClient()).toBe(handle.sdk);
    expect(handle.service.getDirectory()).toBe('/projects/alpha');
    expect(sdkCalls).toEqual([{ baseUrl: '/api/workspaces/ws-1/runtime/api', directory: '/projects/alpha' }]);
  });

  test('get() with the same id returns the same handle without a new sdk', () => {
    registry = createWorkspaceRuntimeRegistry({ createSdkClient: fakeCreateSdkClient });
    const first = registry.get(descriptor('ws-1'));
    const second = registry.get(descriptor('ws-1', { canonicalPath: '/elsewhere' }));
    expect(second).toBe(first);
    expect(second.sdk).toBe(first.sdk);
    expect(second.directory).toBe('/canonical/ws-1');
    expect(sdkCalls).toHaveLength(1);
  });

  test('workspace Git mutations carry the workspace directory query', async () => {
    const requests: Array<{ url: string; query?: unknown }> = [];
    registry = createWorkspaceRuntimeRegistry({
      createSdkClient: fakeCreateSdkClient,
      controlPlaneFetch: async (input, init) => {
        requests.push({ url: String(input), query: (init as RequestInit & { query?: unknown })?.query });
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    const handle = registry.get(descriptor('ws-1', { canonicalPath: '/projects/alpha' }));
    await handle.apis.git.stageGitFiles!('/projects/alpha', ['src/main.ts']);
    expect(requests).toEqual([{
      url: '/api/workspaces/ws-1/runtime/api/git/stage',
      query: { directory: '/projects/alpha' },
    }]);
  });

  test('workspace settings stay explicitly unavailable instead of using the ambient API', async () => {
    registry = createWorkspaceRuntimeRegistry({ createSdkClient: fakeCreateSdkClient });
    const handle = registry.get(descriptor('ws-1'));

    await expectCapabilityUnavailable(handle.apis.settings.load());
    await expectCapabilityUnavailable(handle.apis.settings.save({ theme: 'dark' }));
  });

  test('a handle survives the grace window while retained, then is evicted after release', async () => {
    registry = createWorkspaceRuntimeRegistry({ disposeGraceMs: 5, createSdkClient: fakeCreateSdkClient });
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
    registry = createWorkspaceRuntimeRegistry({ disposeGraceMs: 5, createSdkClient: fakeCreateSdkClient });
    const handle = registry.get(descriptor('ws-1'));
    const release = handle.retain();
    release();
    release();
    await sleep(30);
    expect(registry.get(descriptor('ws-1'))).not.toBe(handle);
    expect(sdkCalls).toHaveLength(2);
  });

  test('re-acquiring a lease during the grace period cancels disposal', async () => {
    registry = createWorkspaceRuntimeRegistry({ disposeGraceMs: 20, createSdkClient: fakeCreateSdkClient });
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
    registry = createWorkspaceRuntimeRegistry({ createSdkClient: fakeCreateSdkClient });
    const first = registry.get(descriptor('ws-1'));
    registry.invalidate('ws-1');
    const second = registry.get(descriptor('ws-1'));
    expect(second).not.toBe(first);
    expect(sdkCalls).toHaveLength(2);
  });

  test('dispose() clears every handle', () => {
    registry = createWorkspaceRuntimeRegistry({ createSdkClient: fakeCreateSdkClient });
    const first = registry.get(descriptor('ws-1'));
    const other = registry.get(descriptor('ws-2'));
    registry.dispose();
    expect(registry.get(descriptor('ws-1'))).not.toBe(first);
    expect(registry.get(descriptor('ws-2'))).not.toBe(other);
    expect(sdkCalls).toHaveLength(4);
  });

  test('LRU eviction drops a released handle when over maxRetained', async () => {
    registry = createWorkspaceRuntimeRegistry({ maxRetained: 2, createSdkClient: fakeCreateSdkClient });
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
    registry = createWorkspaceRuntimeRegistry({ maxRetained: 2, createSdkClient: fakeCreateSdkClient });
    const first = registry.get(descriptor('ws-1'));
    const second = registry.get(descriptor('ws-2'));
    const third = registry.get(descriptor('ws-3'));
    await sleep(10);
    expect(registry.get(descriptor('ws-1'))).not.toBe(first);
    expect(registry.get(descriptor('ws-2'))).toBe(second);
    expect(registry.get(descriptor('ws-3'))).toBe(third);
    expect(sdkCalls).toHaveLength(4);
  });

  test('the default MAX_RETAINED_HANDLES of 8 bounds retained handles', async () => {
    registry = createWorkspaceRuntimeRegistry({ createSdkClient: fakeCreateSdkClient });
    const handles = Array.from({ length: 9 }, (_, index) => registry!.get(descriptor(`ws-${index + 1}`)));
    await sleep(10);
    expect(registry.get(descriptor('ws-1'))).not.toBe(handles[0]);
    for (let index = 1; index < handles.length; index += 1) {
      expect(registry.get(descriptor(`ws-${index + 1}`))).toBe(handles[index]);
    }
    expect(sdkCalls).toHaveLength(10);
  });
});
