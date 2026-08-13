import { describe, expect, test } from 'bun:test';
import {
  rewriteRuntimePathToProject,
  rewriteRuntimeUrlToProject,
  projectRuntimePrefix,
  projectSdkBaseUrl,
} from './project-runtime-fetch';

describe('project runtime path rewriting', () => {
  test('projectSdkBaseUrl maps a project to its runtime api prefix', () => {
    expect(projectSdkBaseUrl('ws-1')).toBe('/api/projects/ws-1/runtime/api');
  });

  test('projectRuntimePrefix maps a project to its raw runtime prefix', () => {
    expect(projectRuntimePrefix('ws-1')).toBe('/api/projects/ws-1/runtime');
  });

  test('rewriteRuntimePathToProject rewrites /api paths under the project prefix', () => {
    const result = rewriteRuntimePathToProject('ws-1', '/api/session');
    expect(result?.rewritten).toBe('/api/projects/ws-1/runtime/api/session');
    expect(result?.restPath).toBe('/api/session');
  });

  test('rewriteRuntimePathToProject keeps query strings', () => {
    const result = rewriteRuntimePathToProject('ws-1', '/api/session?x=1');
    expect(result?.rewritten).toBe('/api/projects/ws-1/runtime/api/session?x=1');
    expect(result?.restPath).toBe('/api/session?x=1');
  });

  test('rewriteRuntimePathToProject rewrites the bare /api root', () => {
    expect(rewriteRuntimePathToProject('ws-1', '/api')?.rewritten).toBe('/api/projects/ws-1/runtime/api');
  });

  test('rewriteRuntimePathToProject rejects non-/api paths', () => {
    expect(rewriteRuntimePathToProject('ws-1', '/health')).toBeNull();
    expect(rewriteRuntimePathToProject('ws-1', '/auth/session')).toBeNull();
    expect(rewriteRuntimePathToProject('ws-1', '')).toBeNull();
  });

  test('rewriteRuntimePathToProject rejects non-string input', () => {
    expect(rewriteRuntimePathToProject('ws-1', null as unknown as string)).toBeNull();
    expect(rewriteRuntimePathToProject('ws-1', undefined as unknown as string)).toBeNull();
    expect(rewriteRuntimePathToProject('ws-1', 42 as unknown as string)).toBeNull();
  });

  describe('rewriteRuntimeUrlToProject', () => {
    test('rewrites Request objects to the project prefix', () => {
      expect(rewriteRuntimeUrlToProject('ws-1', new Request('http://localhost:3000/api/session'))).toBe('/api/projects/ws-1/runtime/api/session');
      expect(rewriteRuntimeUrlToProject('ws-1', new Request('http://localhost:3000/api/session?x=1'))).toBe('/api/projects/ws-1/runtime/api/session?x=1');
    });

    test('rejects Request objects with non-/api paths', () => {
      expect(rewriteRuntimeUrlToProject('ws-1', new Request('http://localhost:3000/health'))).toBeNull();
    });

    test('rewrites relative /api paths', () => {
      expect(rewriteRuntimeUrlToProject('ws-1', '/api/session')).toBe('/api/projects/ws-1/runtime/api/session');
    });

    // The bun test env has no `window`, so the control-plane origin check
    // falls back to loopback hosts: localhost/127.0.0.1 URLs rewrite, foreign
    // origins never do.
    test('absolute loopback URL strings rewrite when window is undefined', () => {
      expect(rewriteRuntimeUrlToProject('ws-1', 'http://localhost:3000/api/session')).toBe('/api/projects/ws-1/runtime/api/session');
      expect(rewriteRuntimeUrlToProject('ws-1', 'http://127.0.0.1:3000/api/session')).toBe('/api/projects/ws-1/runtime/api/session');
      expect(rewriteRuntimeUrlToProject('ws-1', new URL('http://localhost:3000/api/session'))).toBe('/api/projects/ws-1/runtime/api/session');
    });

    test('foreign-origin URLs and Requests are never rewritten', () => {
      expect(rewriteRuntimeUrlToProject('ws-1', 'https://example.com/api/session')).toBeNull();
      expect(rewriteRuntimeUrlToProject('ws-1', new Request('https://example.com/api/session'))).toBeNull();
    });

    test('returns null for unparseable URL strings', () => {
      expect(rewriteRuntimeUrlToProject('ws-1', 'not a url')).toBeNull();
      expect(rewriteRuntimeUrlToProject('ws-1', 42 as unknown as string)).toBeNull();
    });
  });

  test('round-trips project ids with special characters through encodeURIComponent', () => {
    expect(projectSdkBaseUrl('a/b')).toBe('/api/projects/a%2Fb/runtime/api');
    expect(rewriteRuntimePathToProject('a/b', '/api/session')?.rewritten).toBe('/api/projects/a%2Fb/runtime/api/session');
    expect(rewriteRuntimeUrlToProject('a/b', new Request('http://localhost:3000/api/session'))).toBe('/api/projects/a%2Fb/runtime/api/session');
  });
});
