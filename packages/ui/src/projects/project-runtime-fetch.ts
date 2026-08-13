import type { ProjectId } from './types';

/**
 * Project runtime path rewriting (renderer).
 *
 * The project runtime proxy contract (server side:
 * packages/web/server/lib/projects/runtime-proxy.js):
 *   /api/projects/:projectId/runtime/<restPath>
 *
 * SDK base URL for a project: `/api/projects/:projectId/runtime/api`.
 * SDK calls then land on `/api/projects/:projectId/runtime/api/...`,
 * which the control plane forwards to the project's connection adapter.
 *
 * These helpers are pure and shared by the runtime registry and any
 * project-scoped fetch; they never mutate global endpoint state.
 */

/** SDK base URL for a project handle. */
export const projectSdkBaseUrl = (projectId: ProjectId): string =>
  `/api/projects/${encodeURIComponent(projectId)}/runtime/api`;

/** Prefix for raw runtime paths (SSE, etc.). */
export const projectRuntimePrefix = (projectId: ProjectId): string =>
  `/api/projects/${encodeURIComponent(projectId)}/runtime`;

export interface ProjectPathRewrite {
  rewritten: string;
  restPath: string;
}

/**
 * Rewrites a control-plane runtime path to the project prefix. Only
 * `/api/...` paths (the OpenCode/OpenChamber API surface) are rewritten;
 * anything else returns null so callers can decide (never silently forward).
 */
export const rewriteRuntimePathToProject = (
  projectId: ProjectId,
  inputPath: string,
): ProjectPathRewrite | null => {
  if (typeof inputPath !== 'string') return null;
  let pathname = inputPath;
  let search = '';
  const queryIndex = inputPath.indexOf('?');
  if (queryIndex >= 0) {
    pathname = inputPath.slice(0, queryIndex);
    search = inputPath.slice(queryIndex);
  }
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    const restPath = pathname === '/api' ? '/api' : pathname;
    return {
      rewritten: `${projectRuntimePrefix(projectId)}${restPath}${search}`,
      restPath: `${restPath}${search}`,
    };
  }
  return null;
};

/**
 * Rewrites an absolute same-origin URL to the project prefix while keeping
 * foreign URLs untouched. Used by project-scoped fetch implementations.
 */
export const rewriteRuntimeUrlToProject = (
  projectId: ProjectId,
  input: string | URL | Request,
): string | null => {
  if (input == null) return null;
  if (input instanceof Request) {
    const url = new URL(input.url);
    if (!isControlPlaneOrigin(url)) return null;
    return rewriteRuntimePathToProject(projectId, url.pathname + url.search)?.rewritten ?? null;
  }
  const raw = input.toString();
  if (raw.startsWith('/')) {
    return rewriteRuntimePathToProject(projectId, raw)?.rewritten ?? null;
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!isControlPlaneOrigin(url)) return null;
  return rewriteRuntimePathToProject(projectId, url.pathname + url.search)?.rewritten ?? null;
};

/** Same-origin with the current control plane (window origin, or any
 * localhost/loopback origin when the window is unavailable, e.g. tests/SSR). */
const isControlPlaneOrigin = (url: URL): boolean => {
  if (typeof window !== 'undefined') {
    if (url.origin === window.location.origin) return true;
  }
  const hostname = url.hostname;
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
};
