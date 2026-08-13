import { describe, expect, test } from 'bun:test';

// Mirrors useConfigStore.cycle.test.ts in the opposite entry order: a bundle
// that imports useConfigStore first (e.g. the models/pickers entry) must not
// read the useDirectoryStore binding while its module graph is still
// settling. bun's concurrent loader differs from browser ESM order, so the
// stores are loaded with sequential dynamic imports inside the test body.
const storage = new Map<string, string>();
const localStorageMock = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
  clear: () => void storage.clear(),
};

const defineGlobal = (key: string, value: unknown) => {
  const existing = Object.getOwnPropertyDescriptor(globalThis, key);
  if (existing && !existing.configurable) return;
  try {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  } catch {
    // Shared-process run: another test file already owns this global.
  }
};

defineGlobal('localStorage', localStorageMock);
const existingWindow = (globalThis as Record<string, unknown>).window;
if (existingWindow && typeof existingWindow === 'object') {
  const win = existingWindow as Record<string, unknown>;
  if (!win.location) win.location = new URL('https://openchamber.local/');
  if (!win.addEventListener) win.addEventListener = () => {};
  if (!win.removeEventListener) win.removeEventListener = () => {};
  if (!win.dispatchEvent) win.dispatchEvent = () => true;
  if (!win.localStorage) win.localStorage = localStorageMock;
} else {
  defineGlobal('window', {
    location: new URL('https://openchamber.local/'),
    navigator: { userAgent: 'bun-test' },
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    localStorage: localStorageMock,
  });
}

describe('store module initialization order (config first)', () => {
  test('useConfigStore evaluates before useDirectoryStore without TDZ crash', async () => {
    const { useConfigStore } = await import('./useConfigStore');
    const { useDirectoryStore } = await import('./useDirectoryStore');

    expect(typeof useConfigStore.getState().activeDirectoryKey).toBe('string');
    expect(typeof useDirectoryStore.getState().currentDirectory).toBe('string');
  });
});
