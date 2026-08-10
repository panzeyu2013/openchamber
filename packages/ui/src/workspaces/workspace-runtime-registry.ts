import { createWorkspaceOpencodeClient } from '@/lib/opencode/client';
import { createControlPlaneFetch } from './control-plane-fetch';
import { workspaceScopeKey } from './identity';
import { workspaceSdkBaseUrl } from './workspace-runtime-fetch';
import type { WorkspaceDescriptor, WorkspaceId } from './types';

export interface RuntimeUrlResolver {
  api(path: string): string;
  health(path: string): string;
  auth(path: string): string;
}

export interface WorkspaceRuntimeHandle {
  workspaceId: WorkspaceId;
  scopeKey: string;
  directory: string;
  sdk: ReturnType<typeof createWorkspaceOpencodeClient>;
  urls: RuntimeUrlResolver;
  retain(): () => void;
  dispose(): void;
}

export interface WorkspaceRuntimeRegistry {
  get(workspace: WorkspaceDescriptor): WorkspaceRuntimeHandle;
  invalidate(workspaceId: WorkspaceId): void;
  dispose(): void;
}

/**
 * Workspace Runtime Registry.
 *
 * Builds one workspace-bound handle per workspace: an SDK client whose base
 * URL is the control-plane workspace prefix (`/api/workspaces/:id/runtime/api`)
 * and a URL resolver scoped to the same prefix. No global endpoint mutation
 * ever happens here — every request stays on the current control plane and
 * the server resolves the workspace to its connection adapter.
 *
 * - Handles carry a lease (`retain()` / release); the last release schedules
 *   disposal, so a handle can never be evicted while a consumer (full sync,
 *   mini-chat window, notification click) still uses it.
 * - Non-retained handles are held in a bounded LRU; overflow evicts the
 *   least-recently-used handle only after its idle grace.
 * - A handle's SDK client is a lightweight factory product; disposing it
 *   releases nothing server-side (the server connection lifecycle is owned by
 *   the broker's leases).
 */

const MAX_RETAINED_HANDLES = 8;
const DISPOSE_GRACE_MS = 5_000;

const createWorkspaceUrlResolver = (workspaceId: WorkspaceId): RuntimeUrlResolver => {
  const prefix = workspaceSdkBaseUrl(workspaceId);
  return {
    api: (path) => `${prefix}${path}`,
    health: (path) => `${prefix}${path}`,
    auth: (path) => `${prefix}${path}`,
  };
};

export const createWorkspaceRuntimeRegistry = (dependencies: {
  maxRetained?: number;
  disposeGraceMs?: number;
  /** SDK factory seam for tests; defaults to the workspace-bound SDK
   * factory on the control-plane pinned fetch. */
  createSdkClient?: (config: { baseUrl: string; directory: string; fetch?: typeof fetch }) => unknown;
} = {}): WorkspaceRuntimeRegistry => {
  const maxRetained = dependencies.maxRetained ?? MAX_RETAINED_HANDLES;
  const disposeGraceMs = dependencies.disposeGraceMs ?? DISPOSE_GRACE_MS;
  const createSdkClient = dependencies.createSdkClient ?? ((config: { baseUrl: string; directory: string; fetch?: typeof fetch }) => (
    createWorkspaceOpencodeClient(config as { baseUrl: string; directory: string })
  ));

  const handles = new Map<WorkspaceId, WorkspaceRuntimeHandle>();
  const leaseCounts = new Map<WorkspaceId, number>();
  const idleTimers = new Map<WorkspaceId, ReturnType<typeof setTimeout>>();
  let evictionScheduled = false;
  // One pinned control-plane fetch shared by every workspace SDK client: the
  // workspace prefix is resolved against the CURRENT control plane, never the
  // Active Runtime.
  const controlPlaneFetch = createControlPlaneFetch();

  const clearIdleTimer = (workspaceId: WorkspaceId): void => {
    const timer = idleTimers.get(workspaceId);
    if (timer) {
      clearTimeout(timer);
      idleTimers.delete(workspaceId);
    }
  };

  const scheduleEviction = (): void => {
    if (evictionScheduled) return;
    evictionScheduled = true;
    // Coalesced deferred pass: a render mounting many handles scans once.
    setTimeout(() => {
      evictionScheduled = false;
      for (const [workspaceId, handle] of handles) {
        if ((leaseCounts.get(workspaceId) ?? 0) === 0 && handles.size > maxRetained) {
          handles.delete(workspaceId);
          handle.dispose();
        }
      }
    }, 0);
  };

  const get = (workspace: WorkspaceDescriptor): WorkspaceRuntimeHandle => {
    const existing = handles.get(workspace.id);
    if (existing) {
      clearIdleTimer(workspace.id);
      return existing;
    }
    const sdk = createSdkClient({
      baseUrl: workspaceSdkBaseUrl(workspace.id),
      directory: workspace.canonicalPath,
      fetch: controlPlaneFetch,
    }) as WorkspaceRuntimeHandle['sdk'];
    const handle: WorkspaceRuntimeHandle = {
      workspaceId: workspace.id,
      scopeKey: workspaceScopeKey(workspace.id),
      directory: workspace.canonicalPath,
      sdk,
      urls: createWorkspaceUrlResolver(workspace.id),
      retain: () => {
        leaseCounts.set(workspace.id, (leaseCounts.get(workspace.id) ?? 0) + 1);
        clearIdleTimer(workspace.id);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          const next = Math.max(0, (leaseCounts.get(workspace.id) ?? 1) - 1);
          leaseCounts.set(workspace.id, next);
          if (next === 0) {
            const timer = setTimeout(() => {
              idleTimers.delete(workspace.id);
              if ((leaseCounts.get(workspace.id) ?? 0) === 0) {
                handles.delete(workspace.id);
                handle.dispose();
              }
            }, disposeGraceMs);
            idleTimers.set(workspace.id, timer);
          }
        };
      },
      dispose: () => {
        clearIdleTimer(workspace.id);
        leaseCounts.delete(workspace.id);
        handles.delete(workspace.id);
      },
    };
    handles.set(workspace.id, handle);
    scheduleEviction();
    return handle;
  };

  const invalidate = (workspaceId: WorkspaceId): void => {
    const handle = handles.get(workspaceId);
    if (handle) handle.dispose();
  };

  const dispose = (): void => {
    for (const handle of handles.values()) {
      clearIdleTimer(handle.workspaceId);
      handle.dispose();
    }
    handles.clear();
    leaseCounts.clear();
  };

  return { get, invalidate, dispose };
};
