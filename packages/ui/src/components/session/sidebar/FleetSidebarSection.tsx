import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useShallow } from 'zustand/react/shallow';
import { useFleetStore } from '@/fleet/fleet-store';
import { useFleetSummaryStore } from '@/fleet/fleet-summary-store';
import { useFleetLiveStore } from '@/fleet/fleet-live-store';
import { fleetSessionKey, type FleetSessionActivity, type FleetSessionSummary, type FleetServer } from '@/fleet/types';
import { openFleetSession } from '@/fleet/fleet-navigation';
import { connectFleetSshServer } from '@/fleet/desktop-registry';

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

const RENDER_SESSION_LIMIT = 8;

// Leaf subscription per row: the live store clones only the changed entry
// (clone-on-write), so `sessions.get(key)` keeps a stable reference unless
// THIS session's liveness changed. A Fleet live event for any other server or
// session re-runs the cheap Map lookup but cannot re-render this row.
const FleetSessionRow: React.FC<{ serverId: string; serverLabel: string; session: FleetSessionSummary }> = React.memo(({ serverId, serverLabel, session }) => {
  const { t } = useI18n();
  const liveState = useFleetLiveStore((state) => state.sessions.get(fleetSessionKey(serverId, session.sessionId)));
  const activity = liveState?.activity ?? 'idle';
  return (
    <button
      type="button"
      onClick={() => void openFleetSession(serverId, session.sessionId, session.directory)}
      className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-interactive-hover"
      aria-label={t('sessions.fleet.openSession', { title: session.title, server: serverLabel })}
    >
      <Icon name={activityIcon[activity]} className={`h-3.5 w-3.5 shrink-0 ${activityClass[activity]}`} />
      <span className="min-w-0 flex-1 truncate">{session.title}</span>
      {liveState?.stale ? <span className="text-muted-foreground">{t('sessions.fleet.stale')}</span> : null}
    </button>
  );
});
FleetSessionRow.displayName = 'FleetSessionRow';

const FleetServerCard: React.FC<{ server: FleetServer }> = React.memo(({ server }) => {
  const { t } = useI18n();
  const summary = useFleetSummaryStore((state) => state.servers.get(server.id));
  const sessions = React.useMemo(() => {
    if (!summary) return [];
    return [...summary.sessions.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, RENDER_SESSION_LIMIT);
  }, [summary]);
  const stateLabel = t(`sessions.fleet.status.${server.status}`);

  const onServerClick = () => {
    // Saved SSH instances have no endpoint while disconnected; clicking one
    // establishes the tunnel first and activates it once it is up.
    if (server.kind === 'ssh' && server.status !== 'connected') {
      void connectFleetSshServer(server.id);
      return;
    }
    // Activation probes unverified endpoints and refuses to switch the
    // Active Runtime when the probe fails.
    void useFleetStore.getState().probeAndActivateServer(server.id);
  };

  return (
    <div className="rounded-md border border-border/50 bg-muted/20 px-1 py-1">
      <button
        type="button"
        onClick={onServerClick}
        disabled={server.status === 'connecting'}
        className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-70"
        aria-label={t('sessions.fleet.openServer', { label: server.label })}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${server.status === 'connected' ? 'bg-success' : server.status === 'degraded' || server.status === 'error' ? 'bg-destructive' : 'bg-muted-foreground'}`} />
        <span className="min-w-0 flex-1 truncate font-medium">{server.label}</span>
        <span className="text-muted-foreground">{stateLabel}</span>
      </button>
      {sessions.map((session) => (
        <FleetSessionRow key={session.sessionId} serverId={server.id} serverLabel={server.label} session={session} />
      ))}
      {!summary?.complete && summary?.errorMessage ? <p className="px-1.5 py-1 text-xs text-muted-foreground">{t('sessions.fleet.unavailable')}</p> : null}
    </div>
  );
});
FleetServerCard.displayName = 'FleetServerCard';

/** A compact read-only projection of inactive servers; detailed state lives in Active Runtime only. */
export const FleetSidebarSection: React.FC = () => {
  const { t } = useI18n();
  const { servers, activeServerId } = useFleetStore(useShallow((state) => ({ servers: state.servers, activeServerId: state.activeServerId })));
  const observedServers = React.useMemo(
    () => [...servers.values()].filter((server) => server.id !== 'local' && server.id !== activeServerId),
    [activeServerId, servers],
  );

  if (observedServers.length === 0) return null;

  return (
    <section className="border-b border-border/60 px-2.5 py-2" aria-label={t('sessions.fleet.title')}>
      <p className="px-1 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('sessions.fleet.title')}</p>
      <div className="space-y-1">
        {observedServers.map((server) => <FleetServerCard key={server.id} server={server} />)}
      </div>
    </section>
  );
};
