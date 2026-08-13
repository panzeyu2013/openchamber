import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui';
import { isDesktopShell } from '@/lib/desktop';
import type { DesktopSshInstanceStatus } from '@/lib/desktopSsh';
import { useDesktopSshStore } from '@/stores/useDesktopSshStore';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SettingsSection,
  SettingsStackedField,
  SETTINGS_DESCRIPTION_CLASS,
  SETTINGS_FIELDS_STACK_CLASS,
  SETTINGS_FIELD_LABEL_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { useUIStore, type TimeFormatPreference } from '@/stores/useUIStore';
import { formatDateTimeForPreference } from '@/lib/timeFormat';
import { useProjectCatalogStore } from '@/projects/catalog-store';
import { useProjectSessionIndexStore } from '@/projects/session-index-store';
import {
  createConnection,
  deleteConnection,
  probeConnection,
  updateConnection,
} from '@/projects/catalog-client';
import type { ConnectionProfileSummary } from '@/projects/types';
import { useServersUiStore } from './servers-ui-store';
import {
  deriveConnectionStatus,
  deriveFreshness,
  sshInstanceIdOf,
  sshPhaseLabelKey,
  type ConnectionStatusKind,
  type FreshnessKind,
  type ProbeDisplayState,
} from './servers-status';

const CONNECTION_STATUS_LABEL_KEYS: Record<ConnectionStatusKind, I18nKey> = {
  checking: 'settings.servers.page.status.checking',
  connected: 'settings.servers.page.status.connected',
  unreachable: 'settings.servers.page.status.unreachable',
  neverConnected: 'settings.servers.page.status.neverConnected',
};

const CONNECTION_STATUS_DOT_CLASS: Record<ConnectionStatusKind, string> = {
  checking: 'bg-muted-foreground/40 animate-pulse',
  connected: 'bg-[var(--status-success)]',
  unreachable: 'bg-[var(--status-error)]',
  neverConnected: 'bg-muted-foreground/40',
};

const FRESHNESS_LABEL_KEYS: Record<FreshnessKind, I18nKey> = {
  synced: 'settings.servers.page.freshness.synced',
  stale: 'settings.servers.page.freshness.stale',
  offline: 'settings.servers.page.freshness.offline',
  unknown: 'settings.servers.page.freshness.unknown',
};

const connectionLabel = (connection: ConnectionProfileSummary, t: (key: I18nKey) => string): string => (
  connection.id === 'local' ? t('projects.dialog.server.thisComputer') : connection.label
);

const EMPTY_CAPABILITIES = { pathBrowse: false, terminal: false, files: false, git: false, eventStream: false };

export const ServersPage: React.FC = () => {
  const { t } = useI18n();
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const snapshot = useProjectCatalogStore((state) => state.snapshot);
  const catalogStatus = useProjectCatalogStore((state) => state.status);
  const catalogError = useProjectCatalogStore((state) => state.lastError);
  const catalogRefresh = useProjectCatalogStore((state) => state.refresh);
  const sessionSnapshot = useProjectSessionIndexStore(useShallow((state) => state.snapshot));
  const capabilities = useProjectSessionIndexStore((state) => state.capabilities);
  const selectedConnectionId = useServersUiStore((state) => state.selectedConnectionId);
  const setSelectedConnectionId = useServersUiStore((state) => state.setSelectedConnectionId);
  const addFormOpen = useServersUiStore((state) => state.addFormOpen);
  const setAddFormOpen = useServersUiStore((state) => state.setAddFormOpen);
  // Desktop-only: live tunnel status of the ssh-manager instances backing
  // kind==='ssh' catalog connections. Loaded lazily on the desktop shell only;
  // other runtimes never touch the IPC bridge.
  const sshStatusesById = useDesktopSshStore((state) => state.statusesById);
  const sshLoad = useDesktopSshStore((state) => state.load);
  const isDesktopRuntime = React.useMemo(() => isDesktopShell(), []);

  React.useEffect(() => {
    if (isDesktopRuntime) void sshLoad();
  }, [isDesktopRuntime, sshLoad]);

  const connections = React.useMemo(() => snapshot?.connections ?? [], [snapshot]);
  const catalogDisabled = capabilities?.projectCatalogV1 === false;
  const selectedConnection = connections.find((connection) => connection.id === selectedConnectionId) ?? null;

  const selectedSshStatus = React.useMemo(() => {
    if (!selectedConnection || selectedConnection.kind !== 'ssh' || !isDesktopRuntime) return null;
    const instanceId = sshInstanceIdOf(selectedConnection.id);
    return instanceId ? (sshStatusesById[instanceId] ?? null) : null;
  }, [isDesktopRuntime, selectedConnection, sshStatusesById]);

  const [probeStates, setProbeStates] = React.useState<Record<string, ProbeDisplayState>>({});
  const [testingId, setTestingId] = React.useState<string | null>(null);
  const [editingConnection, setEditingConnection] = React.useState<ConnectionProfileSummary | null>(null);
  const [removingConnection, setRemovingConnection] = React.useState<ConnectionProfileSummary | null>(null);

  React.useEffect(() => {
    if (addFormOpen) return;
    if (connections.length === 0) {
      if (selectedConnectionId !== null) setSelectedConnectionId(null);
      return;
    }
    if (selectedConnectionId && connections.some((connection) => connection.id === selectedConnectionId)) {
      return;
    }
    setSelectedConnectionId(connections[0].id);
  }, [addFormOpen, connections, selectedConnectionId, setSelectedConnectionId]);

  const runProbe = React.useCallback(async (connectionId: string) => {
    setTestingId(connectionId);
    setProbeStates((prev) => ({ ...prev, [connectionId]: { kind: 'checking' } }));
    try {
      const result = await probeConnection(connectionId);
      setProbeStates((prev) => ({
        ...prev,
        [connectionId]: result.ok
          ? { kind: 'ok', latencyMs: result.latencyMs }
          : { kind: 'fail', error: result.error?.message },
      }));
      if (result.ok) {
        // The server records the probe; refresh so lastProbeOkAt surfaces.
        void catalogRefresh();
      }
    } catch (error) {
      setProbeStates((prev) => ({
        ...prev,
        [connectionId]: { kind: 'fail', error: error instanceof Error ? error.message : String(error) },
      }));
    } finally {
      setTestingId(null);
    }
  }, [catalogRefresh]);

  if (catalogStatus === 'error') {
    return (
      <SettingsPageLayout title={t('settings.page.servers.title')}>
        <p className="typography-ui text-muted-foreground">{t('settings.servers.page.unavailable')}</p>
        {catalogError ? (
          <p className="typography-meta text-muted-foreground/70">{catalogError}</p>
        ) : null}
        <div className="mt-3">
          <Button type="button" variant="outline" size="sm" onClick={() => void catalogRefresh()}>
            {t('settings.servers.probe.retry')}
          </Button>
        </div>
      </SettingsPageLayout>
    );
  }

  if (!snapshot) {
    // No authoritative snapshot yet (boot or a just-opened settings pane):
    // loading is honest; "no servers" would be a fabricated empty state.
    return (
      <SettingsPageLayout title={t('settings.page.servers.title')}>
        <p className="typography-meta text-muted-foreground">{t('common.loading')}</p>
      </SettingsPageLayout>
    );
  }

  return (
    <SettingsPageLayout
      title={t('settings.page.servers.title')}
      description={t('settings.page.servers.description')}
    >
      {catalogDisabled ? (
        <SettingsSection divider={false}>
          <p className="typography-ui text-warning">{t('projects.sidebar.capabilityDisabled.title')}</p>
          <p className={`${SETTINGS_DESCRIPTION_CLASS} mt-1`}>{t('projects.sidebar.capabilityDisabled.description')}</p>
        </SettingsSection>
      ) : null}

      {addFormOpen && !catalogDisabled ? (
        <ServerAddForm
          onRegistered={(connection, probeOk, latencyMs) => {
            setAddFormOpen(false);
            setSelectedConnectionId(connection.id);
            setProbeStates((prev) => ({
              ...prev,
              [connection.id]: { kind: probeOk ? 'ok' : 'fail', ...(probeOk && latencyMs != null ? { latencyMs } : {}) },
            }));
          }}
          onCancel={() => setAddFormOpen(false)}
        />
      ) : selectedConnection ? (
        <SettingsSection title={connectionLabel(selectedConnection, t)} divider={false}>
          <ConnectionDetail
            connection={selectedConnection}
            probe={probeStates[selectedConnection.id]}
            freshness={deriveFreshness(sessionSnapshot?.freshnessByConnection[selectedConnection.id])}
            timeFormatPreference={timeFormatPreference}
            testing={testingId === selectedConnection.id}
            readOnly={catalogDisabled}
            sshStatus={selectedSshStatus}
            onTest={() => void runProbe(selectedConnection.id)}
            onEdit={() => setEditingConnection(selectedConnection)}
            onRemove={() => setRemovingConnection(selectedConnection)}
          />
        </SettingsSection>
      ) : (
        <SettingsSection divider={false}>
          <p className="typography-meta text-muted-foreground">{t('settings.servers.page.empty.noServers')}</p>
          {!catalogDisabled ? (
            <div className="mt-3" data-settings-item="servers.add">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setAddFormOpen(true)}
              >
                {t('settings.servers.page.actions.addServer')}
              </Button>
            </div>
          ) : null}
        </SettingsSection>
      )}

      <EditServerDialog
        connection={editingConnection}
        onClose={() => setEditingConnection(null)}
        onSaved={() => void catalogRefresh()}
      />
      <RemoveServerDialog
        connection={removingConnection}
        onClose={() => setRemovingConnection(null)}
        onRemoved={() => {
          if (removingConnection && removingConnection.id === selectedConnectionId) {
            setSelectedConnectionId(null);
          }
          void catalogRefresh();
        }}
      />
    </SettingsPageLayout>
  );
};

const ConnectionDetail: React.FC<{
  connection: ConnectionProfileSummary;
  probe: ProbeDisplayState | undefined;
  freshness: FreshnessKind;
  timeFormatPreference: TimeFormatPreference;
  testing: boolean;
  readOnly: boolean;
  /** Tunnel status of the ssh-manager instance backing this connection.
   * Non-null only for kind==='ssh' connections on the desktop shell. */
  sshStatus: DesktopSshInstanceStatus | null;
  onTest: () => void;
  onEdit: () => void;
  onRemove: () => void;
}> = ({ connection, probe, freshness, timeFormatPreference, testing, readOnly, sshStatus, onTest, onEdit, onRemove }) => {
  const { t } = useI18n();
  const sshConnect = useDesktopSshStore((state) => state.connect);
  const sshDisconnect = useDesktopSshStore((state) => state.disconnect);
  const sshRetry = useDesktopSshStore((state) => state.retry);
  const [sshActionPending, setSshActionPending] = React.useState(false);
  const statusKind = deriveConnectionStatus(connection, probe);
  const isLocal = connection.id === 'local';
  const lastConnectedText = connection.lastProbeOkAt
    ? t('settings.servers.page.lastConnectedAt', {
      date: formatDateTimeForPreference(
        connection.lastProbeOkAt,
        timeFormatPreference,
        { dateStyle: 'medium', timeStyle: 'short' },
      ),
    })
    : null;

  const runSshAction = React.useCallback(async (action: () => Promise<void>, failureKey: I18nKey) => {
    setSshActionPending(true);
    try {
      await action();
    } catch (actionFailure) {
      toast.error(t(failureKey), {
        description: actionFailure instanceof Error ? actionFailure.message : String(actionFailure),
      });
    } finally {
      setSshActionPending(false);
    }
  }, [t]);

  return (
    <div className={`${SETTINGS_FIELDS_STACK_CLASS} max-w-[32rem]`}>
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${CONNECTION_STATUS_DOT_CLASS[statusKind]}`} aria-hidden="true" />
        <span className={`${SETTINGS_FIELD_LABEL_CLASS} text-foreground`}>{t(CONNECTION_STATUS_LABEL_KEYS[statusKind])}</span>
        {probe?.latencyMs != null && statusKind === 'connected' ? (
          <span className="typography-micro text-muted-foreground/70">{t('settings.servers.page.status.latency', { latencyMs: probe.latencyMs })}</span>
        ) : null}
        {connection.kind ? (
          <span className="typography-micro rounded bg-muted px-1.5 py-0.5 text-muted-foreground">{connection.kind.toUpperCase()}</span>
        ) : null}
      </div>
      {probe?.error ? (
        <p role="alert" className="typography-ui text-destructive">{probe.error}</p>
      ) : null}
      {lastConnectedText ? (
        <p className={`${SETTINGS_DESCRIPTION_CLASS}`}>{lastConnectedText}</p>
      ) : null}
      <p className={`${SETTINGS_DESCRIPTION_CLASS}`}>
        <span className="text-muted-foreground/70">{t('settings.servers.page.freshness.label')}: </span>
        <span>{t(FRESHNESS_LABEL_KEYS[freshness])}</span>
      </p>
      {sshStatus ? (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <span className="typography-micro rounded bg-muted px-1.5 py-0.5 text-foreground/80">{t(sshPhaseLabelKey(sshStatus.phase))}</span>
          {sshStatus.phase === 'ready' ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void runSshAction(() => sshDisconnect(sshStatus.id), 'settings.remoteInstances.page.toast.disconnectFailed')}
              disabled={sshActionPending}
            >
              {t('settings.remoteInstances.sidebar.actions.disconnect')}
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void runSshAction(() => sshConnect(sshStatus.id), 'settings.remoteInstances.page.toast.connectFailed')}
                disabled={sshActionPending}
              >
                {t('settings.remoteInstances.sidebar.actions.connect')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void runSshAction(() => sshRetry(sshStatus.id), 'settings.remoteInstances.page.toast.retryFailed')}
                disabled={sshActionPending}
              >
                {t('settings.remoteInstances.sidebar.actions.retry')}
              </Button>
            </>
          )}
        </div>
      ) : null}
      {!readOnly ? (
        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onTest}
            disabled={testing}
          >
            {testing ? t('settings.servers.probe.checking') : t('settings.servers.page.actions.test')}
          </Button>
          {!isLocal ? (
            <>
              <Button type="button" variant="outline" size="sm" onClick={onEdit}>
                {t('settings.servers.page.actions.edit')}
              </Button>
              <Button type="button" variant="destructive" size="sm" onClick={onRemove}>
                {t('settings.servers.page.actions.remove')}
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

const ServerAddForm: React.FC<{
  onRegistered: (connection: ConnectionProfileSummary, probeOk: boolean, latencyMs: number | null) => void;
  onCancel: () => void;
}> = ({ onRegistered, onCancel }) => {
  const { t } = useI18n();
  const catalogRefresh = useProjectCatalogStore((state) => state.refresh);
  const [label, setLabel] = React.useState('');
  const [url, setUrl] = React.useState('');
  const [token, setToken] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [phase, setPhase] = React.useState<'idle' | 'probing' | 'fail'>('idle');
  const [registeredId, setRegisteredId] = React.useState<string | null>(null);
  const [latencyMs, setLatencyMs] = React.useState<number | null>(null);

  const runProbe = React.useCallback(async (connectionId: string) => {
    setPhase('probing');
    setError(null);
    try {
      const result = await probeConnection(connectionId);
      if (result.ok) {
        setLatencyMs(result.latencyMs ?? null);
        return true;
      }
      setPhase('fail');
      setRegisteredId(connectionId);
      setError(result.error?.message ?? t('settings.servers.probe.unreachable'));
      return false;
    } catch (probeFailure) {
      setPhase('fail');
      setRegisteredId(connectionId);
      setError(probeFailure instanceof Error ? probeFailure.message : t('settings.servers.probe.unreachable'));
      return false;
    }
  }, [t]);

  const handleSave = React.useCallback(async () => {
    setError(null);
    if (!label.trim() || !url.trim()) {
      setError(t('projects.dialog.server.error.required'));
      return;
    }
    setPhase('probing');
    try {
      const connection = await createConnection({
        label: label.trim(),
        baseUrl: url.trim(),
        ...(token.trim() ? { clientToken: token.trim() } : {}),
      });
      await catalogRefresh();
      const probeStartedAt = Date.now();
      const probeOk = await runProbe(connection.id);
      if (probeOk) {
        onRegistered(connection, true, Math.max(0, Date.now() - probeStartedAt));
      }
    } catch (serverFailure) {
      setPhase('idle');
      setError(serverFailure instanceof Error ? serverFailure.message : t('projects.dialog.server.error.createFailed'));
    }
  }, [catalogRefresh, label, onRegistered, runProbe, token, t, url]);

  const handleRetry = React.useCallback(async () => {
    if (!registeredId) return;
    const probeOk = await runProbe(registeredId);
    if (probeOk) {
      onRegistered(
        { id: registeredId, label, capabilities: EMPTY_CAPABILITIES },
        true,
        latencyMs,
      );
    }
  }, [label, latencyMs, onRegistered, registeredId, runProbe]);

  const handleContinue = React.useCallback(() => {
    if (!registeredId) return;
    onRegistered(
      { id: registeredId, label, capabilities: EMPTY_CAPABILITIES },
      false,
      null,
    );
  }, [label, onRegistered, registeredId]);

  return (
    <SettingsSection title={t('settings.servers.page.section.addServer')} divider={false}>
      <div className={SETTINGS_FIELDS_STACK_CLASS}>
        <SettingsStackedField label={t('projects.dialog.server.form.label')}>
          <Input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder={t('projects.dialog.server.form.labelPlaceholder')}
            className="h-8 rounded-md px-3"
          />
        </SettingsStackedField>
        <SettingsStackedField label={t('projects.dialog.server.form.url')}>
          <Input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://example.com"
            className="h-8 rounded-md px-3"
          />
        </SettingsStackedField>
        <SettingsStackedField label={t('projects.dialog.server.form.token')}>
          <Input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder={t('projects.dialog.server.form.tokenPlaceholder')}
            className="h-8 rounded-md px-3"
          />
        </SettingsStackedField>
        {error ? <p role="alert" className="typography-ui text-destructive">{error}</p> : null}
        {phase === 'probing' ? (
          <p role="status" className="typography-ui text-muted-foreground">{t('settings.servers.probe.checking')}</p>
        ) : null}
        <div className="flex gap-2">
          {phase === 'fail' && registeredId ? (
            <>
              <Button type="button" variant="outline" size="sm" onClick={() => void handleRetry()}>
                {t('settings.servers.probe.retry')}
              </Button>
              <Button type="button" size="sm" onClick={handleContinue}>
                {t('settings.servers.probe.continue')}
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="outline" size="sm" onClick={onCancel}>
                {t('gitView.common.cancel')}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => void handleSave()}
                disabled={phase === 'probing' || !label.trim() || !url.trim()}
              >
                {phase === 'probing' ? t('projects.dialog.server.form.saving') : t('projects.dialog.server.form.save')}
              </Button>
            </>
          )}
        </div>
      </div>
    </SettingsSection>
  );
};

const EditServerDialog: React.FC<{
  connection: ConnectionProfileSummary | null;
  onClose: () => void;
  onSaved: () => void;
}> = ({ connection, onClose, onSaved }) => {
  const { t } = useI18n();
  const [label, setLabel] = React.useState('');
  const [url, setUrl] = React.useState('');
  const [token, setToken] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (!connection) return;
    setLabel(connection.label);
    setUrl('');
    setToken('');
    setError(null);
  }, [connection]);

  const handleSave = React.useCallback(async () => {
    if (!connection) return;
    if (!label.trim()) {
      setError(t('settings.servers.page.edit.labelRequired'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await updateConnection(connection.id, {
        label: label.trim(),
        ...(url.trim() ? { baseUrl: url.trim() } : {}),
        ...(token.trim() ? { clientToken: token.trim() } : {}),
      });
      onSaved();
      onClose();
    } catch (saveFailure) {
      setError(saveFailure instanceof Error ? saveFailure.message : String(saveFailure));
    } finally {
      setSaving(false);
    }
  }, [connection, label, onClose, onSaved, token, t, url]);

  return (
    <Dialog open={connection != null} onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('settings.servers.page.edit.title')}</DialogTitle>
          <DialogDescription>{connection ? connection.label : ''}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          <SettingsStackedField label={t('projects.dialog.server.form.label')}>
            <Input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder={t('projects.dialog.server.form.labelPlaceholder')}
              className="h-8 rounded-md px-3"
            />
          </SettingsStackedField>
          <SettingsStackedField label={t('projects.dialog.server.form.url')} description={t('settings.servers.page.edit.keepUrl')}>
            <Input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://example.com"
              className="h-8 rounded-md px-3"
            />
          </SettingsStackedField>
          <SettingsStackedField label={t('projects.dialog.server.form.token')} description={t('settings.servers.page.edit.keepToken')}>
            <Input
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              className="h-8 rounded-md px-3"
            />
          </SettingsStackedField>
          {error ? <p role="alert" className="typography-ui text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={saving}>
            {t('gitView.common.cancel')}
          </Button>
          <Button type="button" size="sm" onClick={() => void handleSave()} disabled={saving || !label.trim()}>
            {saving ? t('projects.dialog.server.form.saving') : t('settings.servers.page.edit.actions.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const RemoveServerDialog: React.FC<{
  connection: ConnectionProfileSummary | null;
  onClose: () => void;
  onRemoved: () => void;
}> = ({ connection, onClose, onRemoved }) => {
  const { t } = useI18n();
  const sshRemoveInstance = useDesktopSshStore((state) => state.removeInstance);
  const [error, setError] = React.useState<string | null>(null);
  const [removing, setRemoving] = React.useState(false);

  React.useEffect(() => {
    setError(null);
  }, [connection]);

  const handleRemove = React.useCallback(async () => {
    if (!connection) return;
    setRemoving(true);
    setError(null);
    try {
      await deleteConnection(connection.id);
      toast.success(t('settings.servers.page.toast.removed'));
      onRemoved();
      onClose();
      // SSH connections keep one ssh-manager instance per catalog connection;
      // removing the connection must also remove the tunnel instance. The
      // catalog removal already succeeded, so this cleanup is best-effort: a
      // failure only warns and never rolls back the removal. removeInstance
      // itself disconnects the tunnel first (idempotent in the main process).
      if (connection.kind === 'ssh' && isDesktopShell()) {
        const instanceId = sshInstanceIdOf(connection.id);
        if (instanceId) {
          void sshRemoveInstance(instanceId).catch(() => {
            toast.error(t('settings.remoteInstances.page.toast.removeInstanceFailed'));
          });
        }
      }
    } catch (removeFailure) {
      // 409 when projects still reference the connection: surface the
      // server's message so the user knows why removal was refused.
      setError(removeFailure instanceof Error ? removeFailure.message : String(removeFailure));
    } finally {
      setRemoving(false);
    }
  }, [connection, onClose, onRemoved, sshRemoveInstance, t]);

  return (
    <Dialog open={connection != null} onOpenChange={(open) => { if (!open && !removing) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('settings.servers.page.confirm.remove.title')}</DialogTitle>
          <DialogDescription>
            {connection ? connection.label : ''} — {t('settings.servers.page.confirm.remove.description')}
          </DialogDescription>
        </DialogHeader>
        {error ? <p role="alert" className="typography-ui text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={removing}>
            {t('gitView.common.cancel')}
          </Button>
          <Button type="button" variant="destructive" size="sm" onClick={() => void handleRemove()} disabled={removing}>
            {removing ? t('settings.common.actions.saving') : t('settings.servers.page.confirm.remove.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
