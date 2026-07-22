import React from 'react';
import { useFleetLiveStore, fleetActivityFromSessionStatus } from './fleet-live-store';
import { useFleetStore } from './fleet-store';
import { useFleetSummaryStore } from './fleet-summary-store';
import { FleetSummaryTransport } from './fleet-summary-transport';

const FOREGROUND_REFRESH_MS = 5_000;
const BACKGROUND_REFRESH_MS = 30_000;

const toErrorMessage = (value: unknown): string => value instanceof Error ? value.message : 'fleet summary request failed';

/**
 * Polls only non-active runtimes for the small observation contract. The
 * active runtime continues to get complete event/SSE synchronization upstream.
 */
export const FleetSummaryBridge: React.FC = () => {
  React.useEffect(() => {
    const transport = new FleetSummaryTransport();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let refreshing = false;
    const observers = new Map<string, () => void>();
    const structuralRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const pendingServerRefreshes = new Set<string>();

    const reconcileObservers = () => {
      const { activeServerId, servers } = useFleetStore.getState();
      const eligible = new Set([...servers.values()]
        .filter((server) => server.id !== activeServerId && server.id !== 'local')
        .map((server) => server.id));
      for (const [serverId, stop] of observers) {
        if (eligible.has(serverId)) continue;
        stop();
        observers.delete(serverId);
      }
      for (const serverId of eligible) {
        if (observers.has(serverId)) continue;
        const server = servers.get(serverId);
        if (!server) continue;
        observers.set(serverId, transport.observeServer(
          serverId,
          server.descriptor,
          (event) => {
            if (event.structural === 'deleted') {
              useFleetSummaryStore.getState().removeSession(serverId, event.sessionId);
              useFleetLiveStore.getState().removeSession(serverId, event.sessionId);
            }
            if (event.structural !== 'deleted') {
              const previous = useFleetLiveStore.getState().sessions.get(`${serverId}\u0000${event.sessionId}`);
              useFleetLiveStore.getState().applySessionState({
                serverId,
                sessionId: event.sessionId,
                activity: event.activity ?? previous?.activity ?? 'idle',
                hasPendingPermission: event.hasPendingPermission ?? previous?.hasPendingPermission ?? false,
                hasPendingQuestion: event.hasPendingQuestion ?? previous?.hasPendingQuestion ?? false,
              });
            }
            if (event.structural) {
              const previousTimer = structuralRefreshTimers.get(serverId);
              if (previousTimer) clearTimeout(previousTimer);
              structuralRefreshTimers.set(serverId, setTimeout(() => {
                structuralRefreshTimers.delete(serverId);
                if (refreshing) {
                  pendingServerRefreshes.add(serverId);
                  return;
                }
                void refresh(serverId);
              }, 250));
            }
          },
          () => useFleetLiveStore.getState().markServerStale(serverId),
        ));
      }
    };

    const schedule = () => {
      if (stopped) return;
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      timer = setTimeout(() => void refresh(), hidden ? BACKGROUND_REFRESH_MS : FOREGROUND_REFRESH_MS);
    };

    const refresh = async (onlyServerId?: string) => {
      if (stopped || refreshing) return;
      refreshing = true;
      reconcileObservers();
      const { activeServerId, servers } = useFleetStore.getState();
      const inactive = [...servers.values()].filter((server) => server.id !== activeServerId && (!onlyServerId || server.id === onlyServerId));
      await Promise.all(inactive.map(async (server) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8_000);
        try {
          useFleetStore.getState().updateServerStatus(server.id, 'connecting');
          const result = await transport.fetchServerSummary(server.id, server.descriptor, controller.signal);
          if (stopped) return;
          useFleetSummaryStore.getState().replaceServerSummary(server.id, result.sessions);
          const now = Date.now();
          for (const session of result.sessions) {
            const status = result.status[session.sessionId] as { type?: unknown } | undefined;
            const previous = useFleetLiveStore.getState().sessions.get(`${server.id}\u0000${session.sessionId}`);
            useFleetLiveStore.getState().applySessionState({
              serverId: server.id,
              sessionId: session.sessionId,
              activity: fleetActivityFromSessionStatus(status?.type),
              // Status polling cannot authoritatively answer pending request
              // state. Preserve the SSE-derived flags until their matching
              // replied/rejected event arrives.
              hasPendingPermission: previous?.hasPendingPermission ?? false,
              hasPendingQuestion: previous?.hasPendingQuestion ?? false,
              updatedAt: now,
            });
          }
          useFleetStore.getState().updateServerStatus(server.id, 'connected');
        } catch (error) {
          if (!stopped && !controller.signal.aborted) {
            const message = toErrorMessage(error);
            useFleetSummaryStore.getState().markServerFailed(server.id, message);
            useFleetLiveStore.getState().markServerStale(server.id);
            useFleetStore.getState().updateServerStatus(server.id, 'degraded', message);
          }
        } finally {
          clearTimeout(timeout);
        }
      }));
      refreshing = false;
      if (pendingServerRefreshes.size > 0) {
        const [serverId] = pendingServerRefreshes;
        pendingServerRefreshes.delete(serverId);
        void refresh(serverId);
        return;
      }
      schedule();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible' || refreshing) return;
      if (timer) clearTimeout(timer);
      void refresh();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    const unsubscribe = useFleetStore.subscribe(reconcileObservers);
    void refresh();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      unsubscribe();
      for (const stop of observers.values()) stop();
      observers.clear();
      for (const timeout of structuralRefreshTimers.values()) clearTimeout(timeout);
      structuralRefreshTimers.clear();
      transport.close();
    };
  }, []);

  return null;
};
