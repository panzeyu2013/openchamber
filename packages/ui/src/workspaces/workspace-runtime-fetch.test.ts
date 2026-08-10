import { describe, expect, test } from 'bun:test';
import {
  rewriteRuntimePathToWorkspace,
  rewriteRuntimeUrlToWorkspace,
  workspaceRuntimePrefix,
  workspaceSdkBaseUrl,
} from './workspace-runtime-fetch';

describe('workspace runtime path rewriting', () => {
  test('workspaceSdkBaseUrl maps a workspace to its runtime api prefix', () => {
    expect(workspaceSdkBaseUrl('ws-1')).toBe('/api/workspaces/ws-1/runtime/api');
  });

  test('workspaceRuntimePrefix maps a workspace to its raw runtime prefix', () => {
    expect(workspaceRuntimePrefix('ws-1')).toBe('/api/workspaces/ws-1/runtime');
  });

  test('rewriteRuntimePathToWorkspace rewrites /api paths under the workspace prefix', () => {
    const result = rewriteRuntimePathToWorkspace('ws-1', '/api/session');
    expect(result?.rewritten).toBe('/api/workspaces/ws-1/runtime/api/session');
    expect(result?.restPath).toBe('/api/session');
  });

  test('rewriteRuntimePathToWorkspace keeps query strings', () => {
    const result = rewriteRuntimePathToWorkspace('ws-1', '/api/session?x=1');
    expect(result?.rewritten).toBe('/api/workspaces/ws-1/runtime/api/session?x=1');
    expect(result?.restPath).toBe('/api/session?x=1');
  });

  test('rewriteRuntimePathToWorkspace rewrites the bare /api root', () => {
    expect(rewriteRuntimePathToWorkspace('ws-1', '/api')?.rewritten).toBe('/api/workspaces/ws-1/runtime/api');
  });

  test('rewriteRuntimePathToWorkspace rejects non-/api paths', () => {
    expect(rewriteRuntimePathToWorkspace('ws-1', '/health')).toBeNull();
    expect(rewriteRuntimePathToWorkspace('ws-1', '/auth/session')).toBeNull();
    expect(rewriteRuntimePathToWorkspace('ws-1', '')).toBeNull();
  });

  test('rewriteRuntimePathToWorkspace rejects non-string input', () => {
    expect(rewriteRuntimePathToWorkspace('ws-1', null as unknown as string)).toBeNull();
    expect(rewriteRuntimePathToWorkspace('ws-1', undefined as unknown as string)).toBeNull();
    expect(rewriteRuntimePathToWorkspace('ws-1', 42 as unknown as string)).toBeNull();
  });

  describe('rewriteRuntimeUrlToWorkspace', () => {
    test('rewrites Request objects to the workspace prefix', () => {
      expect(rewriteRuntimeUrlToWorkspace('ws-1', new Request('http://localhost:3000/api/session'))).toBe('/api/workspaces/ws-1/runtime/api/session');
      expect(rewriteRuntimeUrlToWorkspace('ws-1', new Request('http://localhost:3000/api/session?x=1'))).toBe('/api/workspaces/ws-1/runtime/api/session?x=1');
    });

    test('rejects Request objects with non-/api paths', () => {
      expect(rewriteRuntimeUrlToWorkspace('ws-1', new Request('http://localhost:3000/health'))).toBeNull();
    });

    test('rewrites relative /api paths', () => {
      expect(rewriteRuntimeUrlToWorkspace('ws-1', '/api/session')).toBe('/api/workspaces/ws-1/runtime/api/session');
    });

    // The bun test env has no `window`, so the control-plane origin check
    // falls back to loopback hosts: localhost/127.0.0.1 URLs rewrite, foreign
    // origins never do.
    test('absolute loopback URL strings rewrite when window is undefined', () => {
      expect(rewriteRuntimeUrlToWorkspace('ws-1', 'http://localhost:3000/api/session')).toBe('/api/workspaces/ws-1/runtime/api/session');
      expect(rewriteRuntimeUrlToWorkspace('ws-1', 'http://127.0.0.1:3000/api/session')).toBe('/api/workspaces/ws-1/runtime/api/session');
      expect(rewriteRuntimeUrlToWorkspace('ws-1', new URL('http://localhost:3000/api/session'))).toBe('/api/workspaces/ws-1/runtime/api/session');
    });

    test('foreign-origin URLs and Requests are never rewritten', () => {
      expect(rewriteRuntimeUrlToWorkspace('ws-1', 'https://example.com/api/session')).toBeNull();
      expect(rewriteRuntimeUrlToWorkspace('ws-1', new Request('https://example.com/api/session'))).toBeNull();
    });

    test('returns null for unparseable URL strings', () => {
      expect(rewriteRuntimeUrlToWorkspace('ws-1', 'not a url')).toBeNull();
      expect(rewriteRuntimeUrlToWorkspace('ws-1', 42 as unknown as string)).toBeNull();
    });
  });

  test('round-trips workspace ids with special characters through encodeURIComponent', () => {
    expect(workspaceSdkBaseUrl('a/b')).toBe('/api/workspaces/a%2Fb/runtime/api');
    expect(rewriteRuntimePathToWorkspace('a/b', '/api/session')?.rewritten).toBe('/api/workspaces/a%2Fb/runtime/api/session');
    expect(rewriteRuntimeUrlToWorkspace('a/b', new Request('http://localhost:3000/api/session'))).toBe('/api/workspaces/a%2Fb/runtime/api/session');
  });
});
