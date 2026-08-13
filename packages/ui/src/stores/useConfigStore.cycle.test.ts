import { describe, expect, test } from 'bun:test';

// Regression test for a browser-boot crash:
// App.tsx → use-sync → useDirectoryStore → useFileSearchStore /
// lib/persistence → session-ui-store → useConfigStore. useConfigStore's
// module body ran while useDirectoryStore was still being evaluated (TDZ),
// and the persist-name resolution in resolveInitialDirectoryKey crashed with
// "Cannot access 'useDirectoryStore' before initialization".
//
// bun's concurrent module loader evaluates bodies in a different order than a
// browser's depth-first ESM traversal, so the stores are loaded with
// sequential dynamic imports inside the test body to reproduce the browser
// order deterministically. A browser-like `window` is required: without it
// resolveInitialDirectoryKey returns early (useConfigStore.ts:709).
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
  // Shared-process run: patch only the pieces the module graph touches.
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

describe('store module initialization order', () => {
  test('useDirectoryStore finishes evaluating before useConfigStore reads it', async () => {
    const { useDirectoryStore } = await import('./useDirectoryStore');
    const { useConfigStore } = await import('./useConfigStore');

    expect(typeof useConfigStore.getState().activeDirectoryKey).toBe('string');
    expect(typeof useDirectoryStore.getState().currentDirectory).toBe('string');
  });
});
