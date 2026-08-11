import { afterEach, describe, expect, test } from 'bun:test';
import type { RuntimeAPIs } from '@/lib/api/types';
import {
  getRegisteredRuntimeAPIs,
  isWorkspaceRuntimeActive,
  registerRuntimeAPIs,
  registerWorkspaceRuntimeAPIs,
  setWorkspaceRuntimeActive,
} from './runtimeAPIRegistry';

const baseApis = {
  runtime: { isVSCode: false } as RuntimeAPIs['runtime'],
  settings: {
    load: async () => ({ settings: {}, source: 'web' as const }),
    save: async () => ({}),
  },
} as unknown as RuntimeAPIs;

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

afterEach(() => {
  registerWorkspaceRuntimeAPIs(null);
  registerRuntimeAPIs(null);
  setWorkspaceRuntimeActive(false);
});

describe('runtime API registry workspace boundary', () => {
  test('overlays workspace APIs without replacing the ambient registration', async () => {
    registerRuntimeAPIs(baseApis);
    const workspaceApis = { ...baseApis, runtime: { ...baseApis.runtime, isVSCode: true } };
    registerWorkspaceRuntimeAPIs(workspaceApis);

    expect(getRegisteredRuntimeAPIs()).toBe(workspaceApis);
    expect(getRegisteredRuntimeAPIs()?.runtime.isVSCode).toBe(true);

    registerWorkspaceRuntimeAPIs(null);
    expect(getRegisteredRuntimeAPIs()).toBe(baseApis);
  });

  test('exposes typed unavailable settings while a workspace is active before the handle is ready', async () => {
    registerRuntimeAPIs(baseApis);
    setWorkspaceRuntimeActive(true);

    const settings = getRegisteredRuntimeAPIs()?.settings;
    await expectCapabilityUnavailable(settings?.load() ?? Promise.resolve());
    await expectCapabilityUnavailable(settings?.save({ theme: 'dark' }) ?? Promise.resolve());
    expect(isWorkspaceRuntimeActive()).toBe(true);
  });
});
