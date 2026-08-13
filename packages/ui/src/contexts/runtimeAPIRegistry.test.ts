import { afterEach, describe, expect, test } from 'bun:test';
import type { RuntimeAPIs } from '@/lib/api/types';
import {
  getRegisteredRuntimeAPIs,
  isProjectRuntimeActive,
  registerRuntimeAPIs,
  registerProjectRuntimeAPIs,
  setProjectRuntimeActive,
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
  registerProjectRuntimeAPIs(null);
  registerRuntimeAPIs(null);
  setProjectRuntimeActive(false);
});

describe('runtime API registry project boundary', () => {
  test('overlays project APIs without replacing the ambient registration', async () => {
    registerRuntimeAPIs(baseApis);
    const projectApis = { ...baseApis, runtime: { ...baseApis.runtime, isVSCode: true } };
    registerProjectRuntimeAPIs(projectApis);

    expect(getRegisteredRuntimeAPIs()).toBe(projectApis);
    expect(getRegisteredRuntimeAPIs()?.runtime.isVSCode).toBe(true);

    registerProjectRuntimeAPIs(null);
    expect(getRegisteredRuntimeAPIs()).toBe(baseApis);
  });

  test('exposes typed unavailable settings while a project is active before the handle is ready', async () => {
    registerRuntimeAPIs(baseApis);
    setProjectRuntimeActive(true);

    const settings = getRegisteredRuntimeAPIs()?.settings;
    await expectCapabilityUnavailable(settings?.load() ?? Promise.resolve());
    await expectCapabilityUnavailable(settings?.save({ theme: 'dark' }) ?? Promise.resolve());
    expect(isProjectRuntimeActive()).toBe(true);
  });
});
