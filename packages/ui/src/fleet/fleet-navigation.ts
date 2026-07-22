import { useSessionUIStore } from '@/sync/session-ui-store';
import { useFleetStore } from './fleet-store';

let navigationGeneration = 0;

/**
 * Switches the single Active Runtime before naming the session. Runtime switch
 * listeners synchronously clear old sync state; the microtask then selects the
 * target session against the new runtime, never against a serverId-scoped cache.
 */
export const openFleetSession = (serverId: string, sessionId: string, directory: string): boolean => {
  const generation = ++navigationGeneration;
  if (!useFleetStore.getState().activateServer(serverId)) return false;
  queueMicrotask(() => {
    if (generation !== navigationGeneration) return;
    useSessionUIStore.getState().setCurrentSession(sessionId, directory || null);
  });
  return true;
};
