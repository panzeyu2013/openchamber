import * as React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useWorkspaceSessionIndexStore, resolveActiveWorkspaceId } from './session-index-store';
import type { WorkspaceId } from './types';

/**
 * Hook form of `resolveActiveWorkspaceId` (see session-index-store.ts for
 * the matching contract). Returns the workspace of the currently selected
 * session, or null when the selection is not a workspace session — the
 * legacy ambient-runtime sync path then stays in charge.
 */
export const useActiveWorkspaceId = (): WorkspaceId | null => {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
  const sessions = useWorkspaceSessionIndexStore((state) => state.snapshot?.sessions);

  return React.useMemo(
    () => resolveActiveWorkspaceId(sessions, currentSessionId, currentSessionDirectory),
    [currentSessionDirectory, currentSessionId, sessions],
  );
};
