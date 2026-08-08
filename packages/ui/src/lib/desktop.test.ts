import { describe, expect, test } from 'bun:test';
import {
  checkForDesktopUpdates,
  downloadDesktopUpdate,
  isBrowserClientRuntime,
  isDesktopLocalOriginActive,
  restartToApplyUpdate,
} from './desktop';

describe('desktop local-origin guards', () => {
  const withWindow = async <T>(value: unknown, callback: () => T | Promise<T>): Promise<T> => {
    const originalWindow = globalThis.window;
    try {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value,
      });
      return await callback();
    } finally {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    }
  };

  test('allows local-only desktop IPC on the actual local origin', async () => {
    await withWindow({
      location: { origin: 'http://127.0.0.1:3901', href: 'http://127.0.0.1:3901/index' },
      __OPENCHAMBER_ELECTRON__: { runtime: 'electron' },
      __OPENCHAMBER_LOCAL_ORIGIN__: 'http://127.0.0.1:3901',
      __OPENCHAMBER_DESKTOP__: {
        invoke: async () => null,
      },
    }, () => {
      expect(isDesktopLocalOriginActive()).toBe(true);
    });
  });

  test('does not call local-only update IPC from an SSH tunnel origin', async () => {
    let invokeCount = 0;

    await withWindow({
      location: { origin: 'http://127.0.0.1:49932', href: 'http://127.0.0.1:49932/index' },
      __OPENCHAMBER_ELECTRON__: { runtime: 'electron' },
      __OPENCHAMBER_LOCAL_ORIGIN__: 'http://127.0.0.1:3901',
      __OPENCHAMBER_DESKTOP__: {
        invoke: async () => {
          invokeCount += 1;
          throw new Error('IPC should not be called');
        },
      },
    }, async () => {
      expect(isDesktopLocalOriginActive()).toBe(false);
      expect(await checkForDesktopUpdates()).toBeNull();
      expect(await downloadDesktopUpdate()).toBe(false);
      expect(await restartToApplyUpdate()).toBe(false);
    });

    expect(invokeCount).toBe(0);
  });
});

describe('browser client runtime', () => {
  test('uses browser file behavior only outside the Electron shell', () => {
    expect(isBrowserClientRuntime('web', false)).toBe(true);
    expect(isBrowserClientRuntime('web', true)).toBe(false);
  });

  test('keeps desktop and VS Code runtime behavior out of browser-only flows', () => {
    expect(isBrowserClientRuntime('desktop', false)).toBe(false);
    expect(isBrowserClientRuntime('vscode', false)).toBe(false);
  });
});
