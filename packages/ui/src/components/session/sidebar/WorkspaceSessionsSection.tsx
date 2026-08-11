import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useShallow } from 'zustand/react/shallow';
import { toast } from '@/components/ui';
import { useWorkspaceCatalogStore } from '@/workspaces/catalog-store';
import { useWorkspaceSessionIndexStore, selectSessionsForWorkspace } from '@/workspaces/session-index-store';
import { createWorkspaceSession } from '@/workspaces/session-index-client';
import type { ConnectionProfileSummary, WorkspaceDescriptor, WorkspaceSessionSummary } from '@/workspaces/types';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { openWorkspaceSession } from './workspaceSessionOpen';

const RENDER_SESSION_LIMIT = 8;

const activityIcon = (activity: WorkspaceSessionSummary['activity']): 'loader-4' | 'error-warning' | 'time' => {
  if (activity === 'busy') return 'loader-4';
  if (activity === 'waiting') return 'error-warning';
  return 'time';
};

const activityClass = (activity: WorkspaceSessionSummary['activity']): string => {
  if (activity === 'busy') return 'text-primary';
  if (activity === 'waiting') return 'text-warning';
  return 'text-muted-foreground';
};

// Leaf subscription per row: the index store clones only the touched entry,
// so a `sessions.find(key)` keeps a stable reference unless THIS session
// changed. Any other event re-runs the cheap lookup but cannot re-render.
const WorkspaceSessionRow: React.FC<{
  workspace: WorkspaceDescriptor;
  connection: ConnectionProfileSummary | null;
  session: WorkspaceSessionSummary;
  isLocalConnection: boolean;
}> = React.memo(({ workspace, connection, session, isLocalConnection }) => {
  const { t } = useI18n();
  const [selected, setSelected] = React.useState(false);
  const sessionIndexStatus = useWorkspaceSessionIndexStore((state) => state.status);

  const onOpen = () => {
    setSelected(true);
    // Local AND remote sessions open through the same selection path; the
    // sync runs against the workspace-bound runtime handle (SSE via the
    // workspace runtime proxy), never the global runtime endpoint.
    openWorkspaceSession(session, (sessionId, directory) => {
      useSessionUIStore.getState().setCurrentSession(sessionId, directory);
    });
  };

  const freshness = sessionIndexStatus === 'error' ? 'stale' : null;

  return (
    <button
      type="button"
      onClick={onOpen}
      className={`flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-interactive-hover ${selected ? 'bg-interactive-hover' : ''}`}
      aria-label={t('workspaces.sidebar.openSessionAria', { title: session.title, workspace: workspace.label })}
    >
      <Icon name={activityIcon(session.activity)} className={`h-3.5 w-3.5 shrink-0 ${activityClass(session.activity)}`} />
      <span className="min-w-0 flex-1 truncate">{session.title}</span>
      {freshness === 'stale' ? (
        <span className="shrink-0 text-muted-foreground">{t('workspaces.sidebar.stale')}</span>
      ) : null}
      {!isLocalConnection && connection ? (
        <span className="hidden shrink-0 text-muted-foreground/70 group-hover:inline lg:inline">
          {t('workspaces.sidebar.serverOf', { server: connection.label })}
        </span>
      ) : null}
    </button>
  );
});
WorkspaceSessionRow.displayName = 'WorkspaceSessionRow';

const WorkspaceGroup: React.FC<{
  workspace: WorkspaceDescriptor;
  connection: ConnectionProfileSummary | null;
  sessions: WorkspaceSessionSummary[];
  truncated: boolean;
  connectionTruncated: boolean;
  isLocalConnection: boolean;
}> = React.memo(({ workspace, connection, sessions, truncated, connectionTruncated, isLocalConnection }) => {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const needsServerDisambiguation = !isLocalConnection && Boolean(connection);
  const shownSessions = sessions.slice(0, RENDER_SESSION_LIMIT);

  // Creates a session on the workspace's server through the session index
  // (`POST /api/workspaces/:id/sessions`). The new session appears through
  // the index SSE stream; navigation is deliberately NOT triggered here —
  // opening before the index maps the session would fall back to the
  // ambient runtime scope instead of the workspace scope.
  const onCreateSession = async () => {
    if (creating) return;
    setCreating(true);
    try {
      await createWorkspaceSession(workspace.id);
    } catch {
      toast.error(t('rightSidebar.contextNotesTodo.toast.createSessionFailed'));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="group">
      <div className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-xs hover:bg-interactive-hover">
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          aria-expanded={!collapsed}
          aria-label={workspace.label}
        >
          <Icon name={collapsed ? 'arrow-right' : 'arrow-down'} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          {workspace.color ? (
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: workspace.color }} aria-hidden="true" />
          ) : (
            <Icon name="folder" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate font-medium">{workspace.label}</span>
          {needsServerDisambiguation ? (
            <span className="shrink-0 text-muted-foreground/70">{connection?.label}</span>
          ) : null}
        </button>
        <button
          type="button"
          onClick={() => void onCreateSession()}
          disabled={creating}
          className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          aria-label={t('sessions.sidebar.header.actions.newSession')}
          title={t('sessions.sidebar.header.actions.newSession')}
        >
          <Icon name="add" className="h-3.5 w-3.5" />
        </button>
      </div>
      {!collapsed ? (
        <div className="ml-3 border-l border-border/50 pl-1">
          {shownSessions.map((session) => (
            <WorkspaceSessionRow
              key={session.key}
              workspace={workspace}
              connection={connection}
              session={session}
              isLocalConnection={isLocalConnection}
            />
          ))}
          {truncated ? (
            <p className="px-1.5 py-0.5 text-[11px] text-muted-foreground">{t('workspaces.sidebar.moreAvailable')}</p>
          ) : null}
          {connectionTruncated ? (
            <p className="px-1.5 py-0.5 text-[11px] text-muted-foreground">{t('workspaces.sidebar.serverHasMoreSessions')}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
WorkspaceGroup.displayName = 'WorkspaceGroup';

/**
 * Unified workspace/session sidebar section (Phase 4).
 *
 * Renders ONE flat tree: workspaces from the catalog, sessions from the
 * server-side Session Index, connection labels only as secondary
 * disambiguation. There are no local/remote cards and no server activation
 * steps. Per-connection freshness is textual (stale / cannot connect /
 * loading) — color is never the only signal. A failing connection keeps its
 * last snapshot and shows its own error state; other workspaces are
 * unaffected.
 */
export const WorkspaceSessionsSection: React.FC = () => {
  const { t } = useI18n();
  const snapshot = useWorkspaceCatalogStore((state) => state.snapshot);
  const catalogStatus = useWorkspaceCatalogStore((state) => state.status);
  const catalogError = useWorkspaceCatalogStore((state) => state.lastError);
  const sessionSnapshot = useWorkspaceSessionIndexStore(useShallow((state) => state.snapshot));
  const requestAddWorkspace = () => {
    void import('@/lib/sessionEvents').then(({ sessionEvents }) => sessionEvents.requestAddWorkspaceDialog());
  };

  const groups = React.useMemo(() => {
    if (!snapshot || !sessionSnapshot) return [];
    const connectionsById = new Map(snapshot.connections.map((connection) => [connection.id, connection]));
    return snapshot.workspaces
      .map((workspace) => {
        const sessions = selectSessionsForWorkspace(sessionSnapshot, workspace.id)
          .sort((left, right) => right.updatedAt - left.updatedAt);
        const freshness = sessionSnapshot.freshnessByConnection[workspace.connectionId];
        return {
          workspace,
          connection: connectionsById.get(workspace.connectionId) ?? null,
          sessions,
          truncated: sessions.length > RENDER_SESSION_LIMIT,
          connectionTruncated: sessionSnapshot.truncatedByConnection?.[workspace.connectionId] === true,
          freshness,
          isLocalConnection: workspace.connectionId === 'local',
        };
      })
      .sort((left, right) => left.workspace.orderKey.localeCompare(right.workspace.orderKey) || left.workspace.label.localeCompare(right.workspace.label));
  }, [sessionSnapshot, snapshot]);

  const hasWorkspaces = Boolean(snapshot && snapshot.workspaces.length > 0);
  if (!hasWorkspaces) {
    // A failed authoritative load is NOT the same as "no workspaces": the
    // store keeps its prior snapshot and marks error. With no snapshot at all
    // (VS Code / Capacitor without a control plane) the sidebar must say the
    // workspaces are unavailable rather than inviting the user to add one.
    if (catalogStatus === 'error') {
      return (
        <section className="border-b border-border/60 px-2.5 py-2" aria-label={t('workspaces.sidebar.title')}>
          <p className="px-1 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('workspaces.sidebar.title')}</p>
          <div className="flex flex-col gap-1 px-1">
            <p className="text-xs text-muted-foreground">{t('workspaces.sidebar.unavailable')}</p>
            {catalogError ? (
              <p className="truncate text-[11px] text-muted-foreground/70" title={catalogError}>
                {catalogError}
              </p>
            ) : null}
          </div>
        </section>
      );
    }
    return (
      <section className="border-b border-border/60 px-2.5 py-2" aria-label={t('workspaces.sidebar.title')}>
        <p className="px-1 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('workspaces.sidebar.title')}</p>
        <div className="flex flex-col gap-1 px-1">
          <p className="text-xs text-muted-foreground">{t('workspaces.sidebar.empty')}</p>
          <button type="button" onClick={requestAddWorkspace} className="text-left text-xs text-foreground/70 underline-offset-2 hover:underline">
            {t('workspaces.sidebar.empty.add')}
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="border-b border-border/60 px-2.5 py-2" aria-label={t('workspaces.sidebar.title')}>
      <div className="space-y-1">
        {groups.map((group) => (
          <WorkspaceGroup
            key={group.workspace.id}
            workspace={group.workspace}
            connection={group.connection}
            sessions={group.sessions}
            truncated={group.truncated}
            connectionTruncated={group.connectionTruncated}
            isLocalConnection={group.isLocalConnection}
          />
        ))}
      </div>
    </section>
  );
};
