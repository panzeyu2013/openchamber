import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useShallow } from 'zustand/react/shallow';
import { useFleetStore } from '@/fleet/fleet-store';
import { useFleetSummaryStore } from '@/fleet/fleet-summary-store';
import { useFleetLiveStore } from '@/fleet/fleet-live-store';
import { fleetSessionKey, type FleetSessionActivity } from '@/fleet/types';
import { openFleetSession } from '@/fleet/fleet-navigation';

const activityIcon: Record<FleetSessionActivity, 'loader-4' | 'error-warning' | 'time'> = {
  busy: 'loader-4',
  retry: 'time',
  error: 'error-warning',
  idle: 'time',
};

const activityClass: Record<FleetSessionActivity, string> = {
  busy: 'text-primary',
  retry: 'text-warning',
  error: 'text-destructive',
  idle: 'text-muted-foreground',
};

/** A compact read-only projection of inactive servers; detailed state lives in Active Runtime only. */
export const FleetSidebarSection: React.FC = () => {
  const { t } = useI18n();
  const { servers, activeServerId } = useFleetStore(useShallow((state) => ({ servers: state.servers, activeServerId: state.activeServerId })));
  const summaries = useFleetSummaryStore((state) => state.servers);
  const live = useFleetLiveStore((state) => state.sessions);
  const observedServers = React.useMemo(
    () => [...servers.values()].filter((server) => server.id !== 'local' && server.id !== activeServerId),
    [activeServerId, servers],
  );

  if (observedServers.length === 0) return null;

  return (
    <section className="border-b border-border/60 px-2.5 py-2" aria-label={t('sessions.fleet.title')}>
      <p className="px-1 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('sessions.fleet.title')}</p>
      <div className="space-y-1">
        {observedServers.map((server) => {
          const summary = summaries.get(server.id);
          const sessions = summary ? [...summary.sessions.values()].sort((left, right) => right.updatedAt - left.updatedAt) : [];
          const stateLabel = t(`sessions.fleet.status.${server.status}`);
          return (
            <div key={server.id} className="rounded-md border border-border/50 bg-muted/20 px-1 py-1">
              <button
                type="button"
                onClick={() => useFleetStore.getState().activateServer(server.id)}
                className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-interactive-hover"
                aria-label={t('sessions.fleet.openServer', { label: server.label })}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${server.status === 'connected' ? 'bg-success' : server.status === 'degraded' || server.status === 'error' ? 'bg-destructive' : 'bg-muted-foreground'}`} />
                <span className="min-w-0 flex-1 truncate font-medium">{server.label}</span>
                <span className="text-muted-foreground">{stateLabel}</span>
              </button>
              {sessions.slice(0, 8).map((session) => {
                const state = live.get(fleetSessionKey(server.id, session.sessionId));
                const activity = state?.activity ?? 'idle';
                return (
                  <button
                    key={session.sessionId}
                    type="button"
                    onClick={() => openFleetSession(server.id, session.sessionId, session.directory)}
                    className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-interactive-hover"
                    aria-label={t('sessions.fleet.openSession', { title: session.title, server: server.label })}
                  >
                    <Icon name={activityIcon[activity]} className={`h-3.5 w-3.5 shrink-0 ${activityClass[activity]}`} />
                    <span className="min-w-0 flex-1 truncate">{session.title}</span>
                    {state?.stale ? <span className="text-muted-foreground">{t('sessions.fleet.stale')}</span> : null}
                  </button>
                );
              })}
              {!summary?.complete && summary?.errorMessage ? <p className="px-1.5 py-1 text-xs text-muted-foreground">{t('sessions.fleet.unavailable')}</p> : null}
            </div>
          );
        })}
      </div>
    </section>
  );
};
