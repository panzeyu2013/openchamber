import * as React from 'react';
import type { WorkspaceRuntimeHandle } from './workspace-runtime-registry';
import type { WorkspaceId } from './types';

/**
 * Workspace runtime context value + hook. Kept separate from the provider
 * component file so fast-refresh lint rules stay satisfied.
 */

export interface WorkspaceRuntimeContextValue {
  workspaceId: WorkspaceId | null;
  handle: WorkspaceRuntimeHandle | null;
}

export const WorkspaceRuntimeContext = React.createContext<WorkspaceRuntimeContextValue>({
  workspaceId: null,
  handle: null,
});

export const useWorkspaceRuntime = (): WorkspaceRuntimeContextValue => {
  const value = React.useContext(WorkspaceRuntimeContext);
  if (!value) {
    throw new Error('useWorkspaceRuntime must be used inside WorkspaceRuntimeProvider');
  }
  return value;
};
