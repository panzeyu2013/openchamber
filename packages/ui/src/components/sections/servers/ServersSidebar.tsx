import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { SettingsSidebarLayout } from '@/components/sections/shared/SettingsSidebarLayout';
import { SettingsSidebarItem } from '@/components/sections/shared/SettingsSidebarItem';
import { SETTINGS_PANEL_TITLE_CLASS } from '@/components/sections/shared/SettingsSection';
import { cn } from '@/lib/utils';
import { isDesktopShell } from '@/lib/desktop';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { useDesktopSshStore } from '@/stores/useDesktopSshStore';
import { useProjectCatalogStore } from '@/projects/catalog-store';
import { useProjectSessionIndexStore } from '@/projects/session-index-store';
import type { ConnectionProfileSummary } from '@/projects/types';
import { useServersUiStore } from './servers-ui-store';
import {
  deriveConnectionStatus,
  deriveFreshness,
  sshInstanceIdOf,
  sshPhaseLabelKey,
  type FreshnessKind,
} from './servers-status';

const FRESHNESS_LABEL_KEYS: Record<FreshnessKind, I18nKey> = {
  synced: 'settings.servers.page.freshness.synced',
  stale: 'settings.servers.page.freshness.stale',
  offline: 'settings.servers.page.freshness.offline',
  unknown: 'settings.servers.page.freshness.unknown',
};

const dotClassFor = (connection: ConnectionProfileSummary, freshness: FreshnessKind): string => {
  const status = deriveConnectionStatus(connection, undefined);
  if (status === 'connected') return 'bg-[var(--status-success)]';
  // A connection that never probe-succeeded but whose session index is
  // healthy (the built-in local connection) is effectively reachable.
  if (freshness === 'synced') return 'bg-[var(--status-success)]';
  if (freshness === 'offline') return 'bg-[var(--status-error)]';
  if (freshness === 'stale') return 'bg-[var(--status-warning)]';
  return 'bg-muted-foreground/40';
};

const metadataFor = (connection: ConnectionProfileSummary, freshness: FreshnessKind, t: (key: I18nKey) => string): string => {
  const status = deriveConnectionStatus(connection, undefined);
  if (status === 'connected') return t('settings.servers.page.status.connected');
  return t(FRESHNESS_LABEL_KEYS[freshness]);
};

export const ServersSidebar: React.FC<{ onItemSelect?: () => void }> = ({ onItemSelect }) => {
  const { t } = useI18n();
  const snapshot = useProjectCatalogStore((state) => state.snapshot);
  const sessionSnapshot = useProjectSessionIndexStore(useShallow((state) => state.snapshot));
  const capabilities = useProjectSessionIndexStore((state) => state.capabilities);
  const selectedConnectionId = useServersUiStore((state) => state.selectedConnectionId);
  const setSelectedConnectionId = useServersUiStore((state) => state.setSelectedConnectionId);
  const setAddFormOpen = useServersUiStore((state) => state.setAddFormOpen);
  const sshStatusesById = useDesktopSshStore((state) => state.statusesById);
  const sshLoad = useDesktopSshStore((state) => state.load);
  const isDesktopRuntime = React.useMemo(() => isDesktopShell(), []);

  React.useEffect(() => {
    if (isDesktopRuntime) void sshLoad();
  }, [isDesktopRuntime, sshLoad]);

  const catalogDisabled = capabilities?.projectCatalogV1 === false;
  const connections = React.useMemo(() => snapshot?.connections ?? [], [snapshot]);

  React.useEffect(() => {
    if (connections.length === 0) {
      if (selectedConnectionId !== null) setSelectedConnectionId(null);
      return;
    }
    if (selectedConnectionId && connections.some((connection) => connection.id === selectedConnectionId)) {
      return;
    }
    setSelectedConnectionId(connections[0].id);
  }, [connections, selectedConnectionId, setSelectedConnectionId]);

  return (
    <SettingsSidebarLayout
      variant="background"
      header={
        <div className={cn('border-b px-3', 'pt-4 pb-3')}>
          <h2 className={`${SETTINGS_PANEL_TITLE_CLASS} mb-3`}>{t('settings.page.servers.title')}</h2>
          <div className="flex items-center justify-between gap-2">
            <span className="typography-meta text-muted-foreground">{t('settings.servers.sidebar.total', { count: connections.length })}</span>
            {!catalogDisabled ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 -my-1 text-muted-foreground"
                onClick={() => setAddFormOpen(true)}
                aria-label={t('settings.servers.sidebar.actions.addServer')}
              >
                <Icon name="add" className="size-4" />
              </Button>
            ) : null}
          </div>
        </div>
      }
    >
      {connections.map((connection) => {
        const freshness = deriveFreshness(sessionSnapshot?.freshnessByConnection[connection.id]);
        const selected = connection.id === selectedConnectionId;
        const instanceId = connection.kind === 'ssh' && isDesktopRuntime ? sshInstanceIdOf(connection.id) : null;
        const sshStatus = instanceId ? (sshStatusesById[instanceId] ?? null) : null;
        return (
          <SettingsSidebarItem
            key={connection.id}
            title={
              <span className="flex items-center gap-1.5">
                {connection.id === 'local' ? t('projects.dialog.server.thisComputer') : connection.label}
                {connection.kind ? (
                  <span className="typography-micro rounded bg-muted px-1 py-px text-muted-foreground">{connection.kind.toUpperCase()}</span>
                ) : null}
              </span>
            }
            metadata={sshStatus ? t(sshPhaseLabelKey(sshStatus.phase)) : metadataFor(connection, freshness, t)}
            icon={
              <span
                className={cn('h-2 w-2 shrink-0 rounded-full', dotClassFor(connection, freshness))}
                aria-hidden="true"
              />
            }
            selected={selected}
            onSelect={() => {
              setSelectedConnectionId(connection.id);
              setAddFormOpen(false);
              onItemSelect?.();
            }}
          />
        );
      })}
    </SettingsSidebarLayout>
  );
};
