import type { RuntimeAPIs } from '@/lib/api/types';

let registeredRuntimeAPIs: RuntimeAPIs | null = null;
let projectRuntimeAPIs: RuntimeAPIs | null = null;
let projectRuntimeActive = false;

const createCapabilityUnavailableError = (): Error & { code: string; status: number } => {
  const error = new Error('Project settings are not available for a project runtime') as Error & {
    code: string;
    status: number;
  };
  error.name = 'ProjectCapabilityUnavailableError';
  error.code = 'capability_unavailable';
  error.status = 501;
  return error;
};

const projectSettingsUnavailable: RuntimeAPIs['settings'] = {
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
 * ambient base registration used by legacy/non-project mounts.
 */
export const registerProjectRuntimeAPIs = (apis: RuntimeAPIs | null): void => {
  projectRuntimeAPIs = apis;
};

/** The project provider sets this before its child effects run. */
export const setProjectRuntimeActive = (active: boolean): void => {
  projectRuntimeActive = active;
};

export const isProjectRuntimeActive = (): boolean => projectRuntimeActive;

export const getRegisteredRuntimeAPIs = (): RuntimeAPIs | null => {
  if (projectRuntimeAPIs) {
    return projectRuntimeAPIs;
  }

  let apis = registeredRuntimeAPIs;
  if (!apis && typeof window !== 'undefined') {
    apis = (window as typeof window & { __OPENCHAMBER_RUNTIME_APIS__?: RuntimeAPIs })
      .__OPENCHAMBER_RUNTIME_APIS__ ?? null;
  }

  if (projectRuntimeActive && apis) {
    return { ...apis, settings: projectSettingsUnavailable };
  }

  return apis;
};
