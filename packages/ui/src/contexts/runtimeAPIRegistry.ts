import type { RuntimeAPIs } from '@/lib/api/types';

let registeredRuntimeAPIs: RuntimeAPIs | null = null;
let workspaceRuntimeAPIs: RuntimeAPIs | null = null;
let workspaceRuntimeActive = false;

const createCapabilityUnavailableError = (): Error & { code: string; status: number } => {
  const error = new Error('Workspace settings are not available for a workspace runtime') as Error & {
    code: string;
    status: number;
  };
  error.name = 'WorkspaceCapabilityUnavailableError';
  error.code = 'capability_unavailable';
  error.status = 501;
  return error;
};

const workspaceSettingsUnavailable: RuntimeAPIs['settings'] = {
  load: async () => {
    throw createCapabilityUnavailableError();
  },
  save: async () => {
    throw createCapabilityUnavailableError();
  },
};

export const registerRuntimeAPIs = (apis: RuntimeAPIs | null): void => {
  registeredRuntimeAPIs = apis;
};

/**
 * Runtime API consumers outside React (stores and persistence) use this
 * registry. Keep their view aligned with the provider without replacing the
 * ambient base registration used by legacy/non-workspace mounts.
 */
export const registerWorkspaceRuntimeAPIs = (apis: RuntimeAPIs | null): void => {
  workspaceRuntimeAPIs = apis;
};

/** The workspace provider sets this before its child effects run. */
export const setWorkspaceRuntimeActive = (active: boolean): void => {
  workspaceRuntimeActive = active;
};

export const isWorkspaceRuntimeActive = (): boolean => workspaceRuntimeActive;

export const getRegisteredRuntimeAPIs = (): RuntimeAPIs | null => {
  if (workspaceRuntimeAPIs) {
    return workspaceRuntimeAPIs;
  }

  let apis = registeredRuntimeAPIs;
  if (!apis && typeof window !== 'undefined') {
    apis = (window as typeof window & { __OPENCHAMBER_RUNTIME_APIS__?: RuntimeAPIs })
      .__OPENCHAMBER_RUNTIME_APIS__ ?? null;
  }

  if (workspaceRuntimeActive && apis) {
    return { ...apis, settings: workspaceSettingsUnavailable };
  }

  return apis;
};
