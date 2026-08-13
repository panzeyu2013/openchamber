import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useShallow } from 'zustand/react/shallow';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useDeviceInfo } from '@/lib/device';
import { useProjectCatalogStore } from '@/projects/catalog-store';
import { useProjectSessionIndexStore, selectSessionsForProject } from '@/projects/session-index-store';
import { createProjectSession } from '@/projects/session-index-client';
import type { ConnectionProfileSummary, SourceFreshness, ProjectDescriptor, ProjectSessionSummary } from '@/projects/types';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { openProjectSession } from './projectSessionOpen';

const RENDER_SESSION_LIMIT = 8;

const activityIcon = (activity: ProjectSessionSummary['activity']): 'loader-4' | 'error-warning' | 'time' => {
  if (activity === 'busy') return 'loader-4';
  if (activity === 'waiting') return 'error-warning';
  return 'time';
};

const activityClass = (activity: ProjectSessionSummary['activity']): string => {
  if (activity === 'busy') return 'text-primary';
  if (activity === 'waiting') return 'text-warning';
  return 'text-muted-foreground';
};

// Leaf subscription per row: the index store clones only the touched entry,
// so a `sessions.find(key)` keeps a stable reference unless THIS session
// changed. Any other event re-runs the cheap lookup but cannot re-render.
const ProjectSessionRow: React.FC<{
  project: ProjectDescriptor;
  connection: ConnectionProfileSummary | null;
  session: ProjectSessionSummary;
  isLocalConnection: boolean;
}> = React.memo(({ project, connection, session, isLocalConnection }) => {
  const { t } = useI18n();
  const [selected, setSelected] = React.useState(false);

  const onOpen = () => {
    setSelected(true);
    // Local AND remote sessions open through the same selection path; the
    // sync runs against the project-bound runtime handle (SSE via the
    // project runtime proxy), never the global runtime endpoint.
    openProjectSession(session, (sessionId, directory, projectId) => {
      useSessionUIStore.getState().setCurrentSession(sessionId, directory, projectId);
    });
  };

  return (
    <button
      type="button"
      onClick={onOpen}
      className={`group my-0.5 flex w-full items-center gap-2 rounded-sm py-1 pr-1.5 text-left typography-ui-label hover:bg-interactive-hover ${selected ? 'bg-interactive-hover' : ''}`}
      aria-label={t('projects.sidebar.openSessionAria', { title: session.title, project: project.label })}
    >
      <Icon name={activityIcon(session.activity)} className={`h-3.5 w-3.5 shrink-0 ${activityClass(session.activity)}`} />
      <span className="min-w-0 flex-1 truncate">{session.title}</span>
      {!isLocalConnection && connection ? (
        <span className="hidden shrink-0 text-muted-foreground/70 group-hover:inline lg:inline">
          {t('projects.sidebar.serverOf', { server: connection.label })}
        </span>
      ) : null}
    </button>
  );
});
ProjectSessionRow.displayName = 'ProjectSessionRow';

const ProjectGroup: React.FC<{
  project: ProjectDescriptor;
  connection: ConnectionProfileSummary | null;
  sessions: ProjectSessionSummary[];
  truncated: boolean;
  connectionTruncated: boolean;
  freshness: SourceFreshness | undefined;
  isLocalConnection: boolean;
}> = React.memo(({ project, connection, sessions, truncated, connectionTruncated, freshness, isLocalConnection }) => {
  const { t } = useI18n();
  const { isMobile, isTablet } = useDeviceInfo();
  const stickyZoneHeaders = useSessionDisplayStore((state) => state.stickyZoneHeaders);
  const [collapsed, setCollapsed] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [confirmRemove, setConfirmRemove] = React.useState(false);
  const [removing, setRemoving] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [editDraft, setEditDraft] = React.useState('');
  const editInputRef = React.useRef<HTMLInputElement | null>(null);
  const editClosedRef = React.useRef(false);
  const needsServerDisambiguation = !isLocalConnection && Boolean(connection);
  const shownSessions = sessions.slice(0, RENDER_SESSION_LIMIT);
  const freshnessLabel = freshness?.stale
    ? t('projects.sidebar.stale')
    : freshness && (freshness.offline || !freshness.complete)
      ? t('projects.sidebar.unavailable')
      : null;
  // A connection whose session index is offline/incomplete cannot create
  // sessions either: pre-disable the affordance instead of failing with a
  // generic toast after the server answers 502. The predicate mirrors the
  // freshness label so the button never disagrees with what the row shows.
  const newSessionUnavailable = Boolean(freshness && (freshness.offline || !freshness.complete));
  // Touch surfaces have no hover: keep the row actions always visible there
  // (mirrors the main project card's `alwaysShowActions` mobile behavior).
  const alwaysShowActions = isMobile || isTablet;
  const iconColorStyle = project.color ? { color: project.color } : undefined;

  // Creates a session on the project's server through the session index
  // (`POST /api/projects/:id/sessions`). The new session appears through
  // the index SSE stream; navigation is deliberately NOT triggered here —
  // opening before the index maps the session would fall back to the
  // ambient runtime scope instead of the project scope.
  const onCreateSession = async () => {
    if (creating) return;
    setCreating(true);
    try {
      await createProjectSession(project.id);
    } catch {
      toast.error(t('rightSidebar.contextNotesTodo.toast.createSessionFailed'));
    } finally {
      setCreating(false);
    }
  };

  // Inline label rename (the card's "Edit…"): commits through the catalog
  // store's optimistic update; failures roll back the label and set lastError.
  const doRename = async (next: string) => {
    try {
      await useProjectCatalogStore.getState().updateProject(project.id, { label: next });
    } catch {
      // Optimistic rollback restores the previous label.
    }
  };

  const startEdit = () => {
    setEditDraft(project.label);
    editClosedRef.current = false;
    setEditing(true);
  };

  React.useEffect(() => {
    if (editing && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editing]);

  const closeEdit = (commit: boolean) => {
    if (editClosedRef.current) return;
    editClosedRef.current = true;
    setEditing(false);
    if (commit) {
      const next = editDraft.trim();
      if (next && next !== project.label) {
        void doRename(next);
      }
    }
  };

  // Optimistic removal through the catalog store; on failure the store
  // re-inserts the descriptor at its previous position and sets lastError.
  const handleRemove = async () => {
    if (removing) return;
    setRemoving(true);
    try {
      await useProjectCatalogStore.getState().deleteProject(project.id);
    } catch {
      // Rollback re-inserts the project; lastError is surfaced by the
      // catalog error state.
    } finally {
      setRemoving(false);
      setConfirmRemove(false);
    }
  };

  const secondaryLine = needsServerDisambiguation || freshnessLabel
    ? (
      <span className="truncate text-[11px] font-medium text-muted-foreground/80">
        {needsServerDisambiguation ? t('projects.sidebar.serverOf', { server: connection?.label ?? '' }) : null}
        {needsServerDisambiguation && freshnessLabel ? (
          <span aria-hidden="true"> · </span>
        ) : null}
        {freshnessLabel ? <span>{freshnessLabel}</span> : null}
      </span>
    )
    : null;

  const actionVisibilityClass = alwaysShowActions
    ? 'opacity-100'
    : 'opacity-0 pointer-events-none group-hover/project:opacity-100 group-hover/project:pointer-events-auto group-focus-within/project:opacity-100 group-focus-within/project:pointer-events-auto';

  const header = editing ? (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      <span className="inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center">
        <Icon name="folder" className="h-3.5 w-3.5 text-muted-foreground" style={iconColorStyle} />
      </span>
      <input
        ref={editInputRef}
        type="text"
        value={editDraft}
        onChange={(event) => setEditDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            closeEdit(true);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            closeEdit(false);
          }
        }}
        onBlur={() => closeEdit(true)}
        className="min-w-0 flex-1 rounded-sm bg-[var(--surface-elevated)] px-1.5 py-0.5 typography-ui-label text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
        aria-label={t('projects.sidebar.menu.edit')}
      />
    </div>
  ) : (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md pr-7 text-left transition-[padding] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 group-hover/project:pr-16 group-focus-within/project:pr-16"
          aria-expanded={!collapsed}
          aria-label={project.label}
        >
          <span className="inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center">
            <span className={cn(
              'h-3.5 w-3.5 items-center justify-center text-muted-foreground',
              alwaysShowActions ? 'inline-flex' : 'hidden group-hover/project:inline-flex group-focus-within/project:inline-flex',
            )}>
              <Icon name={collapsed ? 'arrow-right-s' : 'arrow-down-s'} className="h-3.5 w-3.5" />
            </span>
            <Icon
              name="folder"
              className={cn('h-3.5 w-3.5 text-muted-foreground', alwaysShowActions ? 'hidden' : 'group-hover/project:hidden group-focus-within/project:hidden')}
              style={iconColorStyle}
            />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[14px] font-semibold lowercase text-foreground">{project.label}</span>
            {secondaryLine}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {project.canonicalPath}
      </TooltipContent>
    </Tooltip>
  );

  return (
    <div>
      <div
        className={cn(
          '-ml-2.5 -mr-2 text-left group/project select-none',
          stickyZoneHeaders && 'sticky top-0 z-20 bg-sidebar',
        )}
        data-sidebar-sticky-header={stickyZoneHeaders ? 'true' : undefined}
      >
        <div className="relative flex items-center gap-1 py-1 pl-4 pr-3.5">
          {header}
          <div className={cn(
            'absolute top-1/2 z-10 flex -translate-y-1/2 items-center gap-1',
            alwaysShowActions ? 'right-0.5' : 'right-7',
          )}>
            <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    'inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 hover:text-foreground',
                    menuOpen ? 'opacity-100 pointer-events-auto' : actionVisibilityClass,
                  )}
                  aria-label={t('sessions.sidebar.project.actions.projectMenu')}
                >
                  <Icon name="more-2" className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[180px]">
                <DropdownMenuItem onClick={() => void onCreateSession()} disabled={creating || newSessionUnavailable}>
                  <Icon name="add" className="h-4 w-4" />
                  {t('sessions.sidebar.header.actions.newSession')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={startEdit}>
                  <Icon name="pencil-ai" className="h-4 w-4" />
                  {t('projects.sidebar.menu.edit')}
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onClick={() => setConfirmRemove(true)}>
                  <Icon name="close" className="h-4 w-4" />
                  {t('projects.sidebar.menu.remove')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="absolute right-0.5 top-1/2 z-10 -translate-y-1/2">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => void onCreateSession()}
                  disabled={creating || newSessionUnavailable}
                  className={cn(
                    'inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-opacity hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:opacity-50',
                    actionVisibilityClass,
                  )}
                  aria-label={newSessionUnavailable
                    ? t('projects.sidebar.newSessionUnavailable')
                    : t('sessions.sidebar.header.actions.newSession')}
                >
                  <Icon name="add" className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}>
                <p>{newSessionUnavailable
                  ? t('projects.sidebar.newSessionUnavailable')
                  : t('sessions.sidebar.header.actions.newSession')}</p>
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
        {confirmRemove ? (
          <div className="flex items-center gap-2 border-t border-border/60 px-4 py-1.5">
            <span className="min-w-0 flex-1 truncate typography-meta text-muted-foreground">
              {t('projects.sidebar.menu.removeConfirm', { label: project.label })}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setConfirmRemove(false)}
              disabled={removing}
            >
              {t('sessions.sidebar.dialogs.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => void handleRemove()}
              disabled={removing}
            >
              {t('projects.sidebar.menu.remove')}
            </Button>
          </div>
        ) : null}
      </div>
      {!collapsed ? (
        <div className="pb-1">
          {shownSessions.map((session) => (
            <ProjectSessionRow
              key={session.key}
              project={project}
              connection={connection}
              session={session}
              isLocalConnection={isLocalConnection}
            />
          ))}
          {truncated ? (
            <p className="px-1 py-0.5 typography-meta text-muted-foreground">{t('projects.sidebar.moreAvailable')}</p>
          ) : null}
          {connectionTruncated ? (
            <p className="px-1 py-0.5 typography-meta text-muted-foreground">{t('projects.sidebar.serverHasMoreSessions')}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
ProjectGroup.displayName = 'ProjectGroup';

/**
 * Unified project/session sidebar section (Phase 4).
 *
 * Renders ONE flat tree: projects from the catalog, sessions from the
 * server-side Session Index, connection labels only as secondary
 * disambiguation. There are no local/remote cards and no server activation
 * steps. Per-connection freshness is textual (stale / cannot connect /
 * loading) — color is never the only signal. A failing connection keeps its
 * last snapshot and shows its own error state; other projects are
 * unaffected.
 */
export const ProjectSessionsSection: React.FC<{ searchQuery?: string }> = ({ searchQuery = '' }) => {
  const { t } = useI18n();
  const snapshot = useProjectCatalogStore((state) => state.snapshot);
  const catalogStatus = useProjectCatalogStore((state) => state.status);
  const catalogError = useProjectCatalogStore((state) => state.lastError);
  const sessionSnapshot = useProjectSessionIndexStore(useShallow((state) => state.snapshot));
  const sessionIndexStatus = useProjectSessionIndexStore((state) => state.status);
  const requestAddProject = () => {
    void import('@/lib/sessionEvents').then(({ sessionEvents }) => sessionEvents.requestAddProjectDialog());
  };
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();

  const groups = React.useMemo(() => {
    if (!snapshot || !sessionSnapshot) return [];
    const connectionsById = new Map(snapshot.connections.map((connection) => [connection.id, connection]));
    return snapshot.projects
      .map((project) => {
        const allSessions = selectSessionsForProject(sessionSnapshot, project.id);
        const sessions = (normalizedSearchQuery
          ? allSessions.filter((session) => (
            `${session.title} ${session.directory}`.toLowerCase().includes(normalizedSearchQuery)
          ))
          : allSessions)
          .sort((left, right) => right.updatedAt - left.updatedAt);
        const freshness = sessionSnapshot.freshnessByConnection[project.connectionId];
        return {
          project,
          connection: connectionsById.get(project.connectionId) ?? null,
          sessions,
          truncated: sessions.length > RENDER_SESSION_LIMIT,
          connectionTruncated: sessionSnapshot.truncatedByConnection?.[project.connectionId] === true,
          freshness,
          isLocalConnection: project.connectionId === 'local',
        };
      })
      .filter((group) => !normalizedSearchQuery
        || group.project.label.toLowerCase().includes(normalizedSearchQuery)
        || group.sessions.length > 0)
      .sort((left, right) => left.project.orderKey.localeCompare(right.project.orderKey) || left.project.label.localeCompare(right.project.label));
  }, [normalizedSearchQuery, sessionSnapshot, snapshot]);

  const hasProjects = Boolean(snapshot && snapshot.projects.length > 0);
  const sectionClassName = 'border-b border-border/60 px-2.5 py-2';
  const sectionTitle = (
    <p className="px-1 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('projects.sidebar.title')}</p>
  );

  if (!hasProjects) {
    // A failed authoritative load is NOT the same as "no projects": the
    // store keeps its prior snapshot and marks error. With no snapshot at all
    // (VS Code / Capacitor without a control plane) the sidebar must say the
    // projects are unavailable rather than inviting the user to add one.
    if (catalogStatus === 'error') {
      return (
        <section className={sectionClassName} aria-label={t('projects.sidebar.title')}>
          {sectionTitle}
          <div className="flex flex-col gap-1 px-1 py-1">
            <p className="typography-ui-label text-muted-foreground">{t('projects.sidebar.unavailable')}</p>
            {catalogError ? (
              <p className="truncate typography-meta text-muted-foreground/70" title={catalogError}>
                {catalogError}
              </p>
            ) : null}
          </div>
        </section>
      );
    }
    return (
      <section className={sectionClassName} aria-label={t('projects.sidebar.title')}>
        {sectionTitle}
        <div className="py-6 text-center text-muted-foreground">
          <p className="typography-ui-label font-semibold">{t('projects.sidebar.empty')}</p>
          <button
            type="button"
            onClick={requestAddProject}
            className="typography-meta mt-1 text-foreground/70 underline-offset-2 hover:underline"
          >
            {t('projects.sidebar.empty.add')}
          </button>
        </div>
      </section>
    );
  }

  if (!sessionSnapshot) {
    return (
      <section
        className={sectionClassName}
        aria-label={t('projects.sidebar.title')}
        aria-busy={sessionIndexStatus === 'loading'}
      >
        {sectionTitle}
        <p className="px-1 py-1 typography-ui-label text-muted-foreground">
          {sessionIndexStatus === 'error' ? t('projects.sidebar.unavailable') : t('common.loading')}
        </p>
      </section>
    );
  }

  return (
    <section className={sectionClassName} aria-label={t('projects.sidebar.title')}>
      <div className="space-y-1">
        {groups.map((group) => (
          <ProjectGroup
            key={group.project.id}
            project={group.project}
            connection={group.connection}
            sessions={group.sessions}
            truncated={group.truncated}
            connectionTruncated={group.connectionTruncated}
            freshness={group.freshness}
            isLocalConnection={group.isLocalConnection}
          />
        ))}
      </div>
    </section>
  );
};
