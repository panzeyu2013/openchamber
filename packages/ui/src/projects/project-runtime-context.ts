import * as React from 'react';
import type { ProjectRuntimeHandle } from './project-runtime-registry';
import type { ProjectId } from './types';

/**
 * Project runtime context value + hook. Kept separate from the provider
 * component file so fast-refresh lint rules stay satisfied.
 */

export interface ProjectRuntimeContextValue {
  projectId: ProjectId | null;
  handle: ProjectRuntimeHandle | null;
}

export const ProjectRuntimeContext = React.createContext<ProjectRuntimeContextValue>({
  projectId: null,
  handle: null,
});

export const useProjectRuntime = (): ProjectRuntimeContextValue => {
  const value = React.useContext(ProjectRuntimeContext);
  if (!value) {
    throw new Error('useProjectRuntime must be used inside ProjectRuntimeProvider');
  }
  return value;
};
