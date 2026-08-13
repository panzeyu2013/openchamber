import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Radio } from '@/components/ui/radio';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { useDeviceInfo } from '@/lib/device';
import { isDesktopLocalOriginActive } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { useDesktopSshStore } from '@/stores/useDesktopSshStore';
import { createConnection, listConnectionChildren, probeConnection, type BrowseChild } from './catalog-client';
import { useProjectCatalogStore } from './catalog-store';
import type { ConnectionProfileSummary, ProjectDescriptor } from './types';

const COLOR_SWATCHES = [
  '#d97706',
  '#dc2626',
  '#db2777',
  '#7c3aed',
  '#2563eb',
  '#0891b2',
  '#059669',
  '#65a30d',
];

interface AddProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after the catalog insert succeeds (legacy sidebar dual-write). */
  onProjectAdded?: (project: ProjectDescriptor) => void;
}

const basenameOf = (pathValue: string): string => {
  const parts = pathValue.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : pathValue;
};

/** True for path roots that have no parent: POSIX `/`, drive roots (`C:\`,
 * `C:/`), UNC server roots (`\\server`) and share roots (`\\server\share`). */
const isPathRoot = (pathValue: string): boolean => {
  const trimmed = pathValue.trim();
  if (trimmed === '/' || trimmed === '') return true;
  if (/^[A-Za-z]:[\\/]?$/.test(trimmed)) return true;
  if (/^\\\\[^\\/]+$/.test(trimmed)) return true;
  if (/^\\\\[^\\/]+\\[^\\/]+$/.test(trimmed)) return true;
  return false;
};

/** Parent of a browse path under POSIX, Windows drive and UNC semantics.
 * `/home/user` -> `/home`; `C:\Users\pan` -> `C:\Users`; `C:\Users` ->
 * `C:\`; `\\server\share\sub` -> `\\server\share`. Roots return themselves. */
const parentPathOf = (pathValue: string): string => {
  const trimmed = pathValue.replace(/[\\/]+$/, '');
  if (!trimmed) return pathValue;
  if (isPathRoot(trimmed)) return pathValue;
  const lastSeparator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (lastSeparator < 0) return '';
  const parent = trimmed.slice(0, lastSeparator);
  const separator = trimmed[lastSeparator];
  if (!parent) return '/';
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}${separator}`;
  return parent;
};

export const AddProjectDialog: React.FC<AddProjectDialogProps> = ({
  open,
  onOpenChange,
  onProjectAdded,
}) => {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const isDesktopRuntime = React.useMemo(() => isDesktopLocalOriginActive(), []);
  const sshLoad = useDesktopSshStore((state) => state.load);
  const sshCreateFromCommand = useDesktopSshStore((state) => state.createFromCommand);
  const catalogStatus = useProjectCatalogStore((state) => state.status);
  const catalogRefresh = useProjectCatalogStore((state) => state.refresh);
  const createProject = useProjectCatalogStore((state) => state.createProject);
  const snapshot = useProjectCatalogStore((state) => state.snapshot);

  const connections = React.useMemo(
    () => snapshot?.connections ?? [],
    [snapshot],
  );
  const localConnection = connections.find((connection) => connection.id === 'local') ?? null;

  const [selectedConnectionId, setSelectedConnectionId] = React.useState<string>('local');
  const [path, setPath] = React.useState('');
  const [name, setName] = React.useState('');
  const [nameEdited, setNameEdited] = React.useState(false);
  const [color, setColor] = React.useState('');
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [isBrowsing, setIsBrowsing] = React.useState(false);
  const [browsePath, setBrowsePath] = React.useState<string>('/');
  const [browseEntries, setBrowseEntries] = React.useState<BrowseChild[]>([]);
  const [browseError, setBrowseError] = React.useState<string | null>(null);
  const [isBrowseLoading, setIsBrowseLoading] = React.useState(false);
  const [isAddingServer, setIsAddingServer] = React.useState(false);
  const [serverType, setServerType] = React.useState<'url' | 'ssh'>('url');
  const [serverLabel, setServerLabel] = React.useState('');
  const [serverBaseUrl, setServerBaseUrl] = React.useState('');
  const [serverToken, setServerToken] = React.useState('');
  const [serverNickname, setServerNickname] = React.useState('');
  const [serverSshCommand, setServerSshCommand] = React.useState('');
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [isServerSubmitting, setIsServerSubmitting] = React.useState(false);
  // Add-server probe lifecycle: the server is registered regardless of
  // reachability; the probe only decides whether the user is advanced to the
  // path step immediately or offered retry/continue on the form.
  const [serverProbeState, setServerProbeState] = React.useState<'idle' | 'probing' | 'connected' | 'unreachable'>('idle');
  const [registeredServerId, setRegisteredServerId] = React.useState<string | null>(null);
  const [serverProbeLatencyMs, setServerProbeLatencyMs] = React.useState<number | null>(null);
  // Note shown under the server select after a registered server was added.
  const [serverRegisteredOk, setServerRegisteredOk] = React.useState<boolean | null>(null);
  // Note shown after an SSH tunnel instance was created (no probe exists for
  // SSH: the tunnel is connected later from the Servers settings page).
  const [serverSshCreated, setServerSshCreated] = React.useState(false);
  // Browse generation: a slow server response for an earlier directory must
  // never overwrite the entries of a newer selection.
  const browseGenerationRef = React.useRef(0);

  const selectedConnection: ConnectionProfileSummary | null =
    connections.find((connection) => connection.id === selectedConnectionId) ?? localConnection;

  // Keep the catalog fresh whenever the dialog opens.
  React.useEffect(() => {
    if (open && catalogStatus !== 'ready' && catalogStatus !== 'loading') {
      void catalogRefresh();
    }
  }, [open, catalogStatus, catalogRefresh]);

  const resetForm = React.useCallback(() => {
    setPath('');
    setName('');
    setNameEdited(false);
    setColor('');
    setError(null);
    setIsBrowsing(false);
    setBrowseError(null);
  }, []);

  const applyPath = React.useCallback((nextPath: string) => {
    setPath(nextPath);
    if (!nameEdited) {
      setName(basenameOf(nextPath));
    }
  }, [nameEdited]);

  const loadBrowse = React.useCallback(async (directory: string) => {
    if (!selectedConnection) return;
    const generation = ++browseGenerationRef.current;
    setIsBrowseLoading(true);
    setBrowseError(null);
    try {
      const result = await listConnectionChildren(selectedConnection.id, directory);
      if (generation !== browseGenerationRef.current) return;
      setBrowsePath(result.directory);
      setBrowseEntries(result.children);
    } catch (browseFailure) {
      if (generation !== browseGenerationRef.current) return;
      setBrowseError(browseFailure instanceof Error ? browseFailure.message : t('projects.dialog.browse.loadFailed'));
      setBrowseEntries([]);
    } finally {
      if (generation === browseGenerationRef.current) {
        setIsBrowseLoading(false);
      }
    }
  }, [selectedConnection, t]);

  const resetAddServerForm = React.useCallback(() => {
    setIsAddingServer(false);
    setServerType('url');
    setServerLabel('');
    setServerBaseUrl('');
    setServerToken('');
    setServerNickname('');
    setServerSshCommand('');
    setServerError(null);
    setServerProbeState('idle');
    setRegisteredServerId(null);
    setServerProbeLatencyMs(null);
    setServerSshCreated(false);
  }, []);

  const advanceAfterRegister = React.useCallback((connection: ConnectionProfileSummary, probeOk: boolean, latencyMs: number | null) => {
    setSelectedConnectionId(connection.id);
    resetAddServerForm();
    setServerRegisteredOk(probeOk);
    setServerProbeLatencyMs(probeOk ? latencyMs : null);
  }, [resetAddServerForm]);

  const runServerProbe = React.useCallback(async (connectionId: string): Promise<boolean> => {
    setServerProbeState('probing');
    setServerError(null);
    try {
      const result = await probeConnection(connectionId);
      if (result.ok) {
        setServerProbeState('connected');
        setRegisteredServerId(null);
        return true;
      }
      setServerProbeState('unreachable');
      setRegisteredServerId(connectionId);
      setServerError(result.error?.message ?? t('projects.dialog.serverProbe.unreachable'));
      return false;
    } catch (probeFailure) {
      setServerProbeState('unreachable');
      setRegisteredServerId(connectionId);
      setServerError(probeFailure instanceof Error ? probeFailure.message : t('projects.dialog.serverProbe.unreachable'));
      return false;
    }
  }, [t]);

  const handleAddServer = React.useCallback(async () => {
    setServerError(null);
    if (serverType === 'ssh') {
      // SSH servers register an ssh-manager instance only: the catalog
      // connection is created later from Servers settings, and the tunnel is
      // connected there too (no probe exists in this dialog).
      if (!serverSshCommand.trim()) {
        setServerError(t('projects.dialog.server.error.sshCommandRequired'));
        return;
      }
      setIsServerSubmitting(true);
      try {
        await sshLoad();
        const id = `ssh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await sshCreateFromCommand(id, serverSshCommand.trim(), serverNickname.trim() || undefined);
        resetAddServerForm();
        setServerSshCreated(true);
      } catch (serverFailure) {
        setServerError(serverFailure instanceof Error ? serverFailure.message : t('projects.dialog.server.error.createFailed'));
      } finally {
        setIsServerSubmitting(false);
      }
      return;
    }
    if (!serverLabel.trim() || !serverBaseUrl.trim()) {
      setServerError(t('projects.dialog.server.error.required'));
      return;
    }
    setIsServerSubmitting(true);
    try {
      const connection = await createConnection({
        label: serverLabel.trim(),
        baseUrl: serverBaseUrl.trim(),
        ...(serverToken.trim() ? { clientToken: serverToken.trim() } : {}),
      });
      await catalogRefresh();
      // The server is registered globally regardless of reachability; probe
      // it to confirm and, on success, advance straight to the path step.
      const probeStartedAt = Date.now();
      const probeOk = await runServerProbe(connection.id);
      const latencyMs = Math.max(0, Date.now() - probeStartedAt);
      if (probeOk) {
        advanceAfterRegister(connection, true, latencyMs);
      }
    } catch (serverFailure) {
      setServerError(serverFailure instanceof Error ? serverFailure.message : t('projects.dialog.server.error.createFailed'));
    } finally {
      setIsServerSubmitting(false);
    }
  }, [advanceAfterRegister, catalogRefresh, resetAddServerForm, runServerProbe, serverBaseUrl, serverLabel, serverNickname, serverSshCommand, serverToken, serverType, sshCreateFromCommand, sshLoad, t]);

  const openBrowser = React.useCallback(() => {
    setIsBrowsing(true);
    setBrowsePath(path || '/');
    void loadBrowse(path || '/');
  }, [path, loadBrowse]);

  const handleSubmit = React.useCallback(async () => {
    if (!selectedConnection || !path.trim()) {
      setError(t('projects.dialog.error.required'));
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      const project = await createProject({
        connectionId: selectedConnection.id,
        path: path.trim(),
        label: name.trim() || undefined,
        color: color.trim() || undefined,
      });
      toast.success(t('projects.dialog.toast.added', { label: project.label }));
      onProjectAdded?.(project);
      resetForm();
      onOpenChange(false);
    } catch (createFailure) {
      // Keep user input on failure and show a sanitized, actionable error.
      const message = createFailure instanceof Error ? createFailure.message : t('projects.dialog.error.createFailed');
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  }, [createProject, color, name, onOpenChange, onProjectAdded, path, resetForm, selectedConnection, t]);

  const content = (
    <>
      <DialogHeader>
        <DialogTitle>{t('projects.dialog.title')}</DialogTitle>
        <DialogDescription>{t('projects.dialog.description')}</DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-4 py-2">
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="project-connection">{t('projects.dialog.server.label')}</label>
          <Select
            value={selectedConnectionId}
            onValueChange={(value) => {
              setSelectedConnectionId(value);
              // Invalidate any in-flight browse for the previous connection.
              browseGenerationRef.current += 1;
              setBrowseEntries([]);
              setBrowseError(null);
            }}
          >
            <SelectTrigger id="project-connection" className="w-full">
              <SelectValue placeholder={t('projects.dialog.server.placeholder')} />
            </SelectTrigger>
            <SelectContent>
              {connections.length === 0 ? (
                <SelectItem value="local" disabled>{t('projects.dialog.server.loading')}</SelectItem>
              ) : connections.map((connection) => (
                <SelectItem key={connection.id} value={connection.id}>
                  {connection.id === 'local' ? t('projects.dialog.server.thisComputer') : connection.label}
                </SelectItem>
              ))}
            </SelectContent>
            </Select>
            {serverRegisteredOk !== null && (
              <p
                role="status"
                className={serverRegisteredOk ? 'text-sm text-[var(--status-success)]' : 'text-sm text-[var(--status-warning)]'}
              >
                {serverRegisteredOk
                  ? (serverProbeLatencyMs != null
                      ? t('projects.dialog.serverProbe.connectedWithLatency', { latencyMs: serverProbeLatencyMs })
                      : t('projects.dialog.serverProbe.connected'))
                  : t('projects.dialog.serverProbe.registeredNote')}
              </p>
            )}
            {serverSshCreated && serverRegisteredOk === null && (
              <p role="status" className="text-sm text-[var(--status-success)]">
                {t('projects.dialog.server.form.sshCreated')}
              </p>
            )}
            {!isAddingServer ? (
                <button
                  type="button"
                  className="self-start text-sm text-foreground/70 underline-offset-2 hover:underline"
                  onClick={() => {
                    setServerError(null);
                    setServerProbeState('idle');
                    setRegisteredServerId(null);
                    setServerRegisteredOk(null);
                    setServerSshCreated(false);
                    setIsAddingServer(true);
                  }}
                >
                  {t('projects.dialog.server.add')}
                </button>
              ) : (
                <div className="flex flex-col gap-2 rounded-md border p-3">
                  {isDesktopRuntime && (
                    <div className="flex items-center gap-4" role="radiogroup" aria-label={t('projects.dialog.server.form.type')}>
                      <label className="flex cursor-pointer items-center gap-2 text-sm">
                        <Radio
                          checked={serverType === 'url'}
                          onChange={() => setServerType('url')}
                          ariaLabel={t('projects.dialog.server.form.typeUrl')}
                        />
                        {t('projects.dialog.server.form.typeUrl')}
                      </label>
                      <label className="flex cursor-pointer items-center gap-2 text-sm">
                        <Radio
                          checked={serverType === 'ssh'}
                          onChange={() => setServerType('ssh')}
                          ariaLabel={t('projects.dialog.server.form.typeSsh')}
                        />
                        {t('projects.dialog.server.form.typeSsh')}
                      </label>
                    </div>
                  )}
                  {serverType === 'url' ? (
                    <>
                      <label className="text-sm font-medium" htmlFor="server-label">{t('projects.dialog.server.form.label')}</label>
                      <Input
                        id="server-label"
                        value={serverLabel}
                        onChange={(event) => setServerLabel(event.target.value)}
                        placeholder={t('projects.dialog.server.form.labelPlaceholder')}
                      />
                      <label className="text-sm font-medium" htmlFor="server-url">{t('projects.dialog.server.form.url')}</label>
                      <Input
                        id="server-url"
                        value={serverBaseUrl}
                        onChange={(event) => setServerBaseUrl(event.target.value)}
                        placeholder="https://example.com"
                      />
                      <label className="text-sm font-medium" htmlFor="server-token">{t('projects.dialog.server.form.token')}</label>
                      <Input
                        id="server-token"
                        type="password"
                        value={serverToken}
                        onChange={(event) => setServerToken(event.target.value)}
                        placeholder={t('projects.dialog.server.form.tokenPlaceholder')}
                      />
                    </>
                  ) : (
                    <>
                      <label className="text-sm font-medium" htmlFor="server-nickname">{t('projects.dialog.server.form.nickname')}</label>
                      <Input
                        id="server-nickname"
                        value={serverNickname}
                        onChange={(event) => setServerNickname(event.target.value)}
                        placeholder={t('projects.dialog.server.form.nicknamePlaceholder')}
                      />
                      <label className="text-sm font-medium" htmlFor="server-ssh-command">{t('projects.dialog.server.form.sshCommand')}</label>
                      <Input
                        id="server-ssh-command"
                        value={serverSshCommand}
                        onChange={(event) => setServerSshCommand(event.target.value)}
                        placeholder={t('projects.dialog.server.form.sshCommandPlaceholder')}
                      />
                    </>
                  )}
                  {serverError && <p role="alert" className="text-sm text-destructive">{serverError}</p>}
                  {serverProbeState === 'probing' && (
                    <p role="status" className="text-sm text-muted-foreground">{t('projects.dialog.serverProbe.checking')}</p>
                  )}
                  <div className="flex gap-2">
                    {serverProbeState === 'unreachable' && registeredServerId ? (
                      <>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            resetAddServerForm();
                            setServerRegisteredOk(null);
                          }}
                        >
                          {t('gitView.common.cancel')}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={async () => {
                            const connection = connections.find((entry) => entry.id === registeredServerId);
                            if (!connection) return;
                            const probeStartedAt = Date.now();
                            const probeOk = await runServerProbe(connection.id);
                            if (probeOk) {
                              advanceAfterRegister(connection, true, Math.max(0, Date.now() - probeStartedAt));
                            }
                          }}
                        >
                          {t('projects.dialog.serverProbe.retry')}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => {
                            const connection = connections.find((entry) => entry.id === registeredServerId);
                            if (connection) advanceAfterRegister(connection, false, null);
                          }}
                          disabled={!connections.some((entry) => entry.id === registeredServerId)}
                        >
                          {t('projects.dialog.serverProbe.continue')}
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            resetAddServerForm();
                            setServerRegisteredOk(null);
                          }}
                        >
                          {t('gitView.common.cancel')}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => void handleAddServer()}
                          disabled={isServerSubmitting || serverProbeState === 'probing' || (serverType === 'ssh' && !serverSshCommand.trim())}
                        >
                          {isServerSubmitting ? t('projects.dialog.server.form.saving') : t('projects.dialog.server.form.save')}
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="project-path">{t('projects.dialog.path.label')}</label>
          <div className="flex gap-2">
            <Input
              id="project-path"
              value={path}
              onChange={(event) => applyPath(event.target.value)}
              placeholder={t('projects.dialog.path.placeholder')}
              className="flex-1"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!selectedConnection?.capabilities.pathBrowse}
              onClick={openBrowser}
              aria-label={t('projects.dialog.path.browseAria')}
            >
              <Icon name="folder" className="mr-1 h-4 w-4" />
              {t('projects.dialog.path.browse')}
            </Button>
          </div>
        </div>

        {isBrowsing && (
          <div className="flex flex-col gap-2 rounded-md border p-2">
            <div className="flex items-center gap-1 text-sm text-foreground/70">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-1"
                onClick={() => void loadBrowse(parentPathOf(browsePath))}
                disabled={isPathRoot(browsePath) || isBrowseLoading}
                aria-label={t('projects.dialog.browse.upAria')}
              >
                <Icon name="arrow-up" className="h-3.5 w-3.5" />
              </Button>
              <span className="truncate">{browsePath}</span>
            </div>
            {browseError && <p className="text-sm text-destructive">{browseError}</p>}
            <div className="flex max-h-48 flex-col gap-0.5 overflow-y-auto">
              {isBrowseLoading ? (
                <p className="px-2 py-1 text-sm text-foreground/60">{t('projects.dialog.browse.loading')}</p>
              ) : browseEntries.length === 0 && !browseError ? (
                <p className="px-2 py-1 text-sm text-foreground/60">{t('projects.dialog.browse.empty')}</p>
              ) : browseEntries.map((entry) => entry.kind === 'directory' ? (
                <button
                  key={entry.path}
                  type="button"
                  className="flex items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted"
                  onClick={() => {
                    setBrowsePath(entry.path);
                    void loadBrowse(entry.path);
                  }}
                >
                  <Icon name="folder" className="h-4 w-4 text-foreground/60" />
                  <span className="truncate">{entry.name}</span>
                </button>
              ) : null)}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!browsePath}
              onClick={() => applyPath(browsePath)}
            >
              {t('projects.dialog.browse.choose')}
            </Button>
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="project-name">{t('projects.dialog.name.label')}</label>
          <Input
            id="project-name"
            value={name}
            onChange={(event) => { setName(event.target.value); setNameEdited(true); }}
            placeholder={t('projects.dialog.name.placeholder')}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="project-color">{t('projects.dialog.color.label')}</label>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
              {COLOR_SWATCHES.map((swatch) => (
                <button
                  key={swatch}
                  type="button"
                  aria-label={swatch}
                  className={`h-5 w-5 rounded-full border ${color === swatch ? 'ring-2 ring-ring' : ''}`}
                  style={{ backgroundColor: swatch }}
                  onClick={() => setColor(color === swatch ? '' : swatch)}
                />
              ))}
            </div>
            <Input
              id="project-color"
              value={color}
              onChange={(event) => setColor(event.target.value)}
              placeholder={t('projects.dialog.color.placeholder')}
              className="w-28"
            />
          </div>
        </div>

        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          {t('gitView.common.cancel')}
        </Button>
        <Button type="button" onClick={() => void handleSubmit()} disabled={isSubmitting || !path.trim()}>
          {isSubmitting ? t('projects.dialog.actions.adding') : t('projects.dialog.actions.add')}
        </Button>
      </DialogFooter>
    </>
  );

  if (isMobile) {
    return (
      <MobileOverlayPanel
        open={open}
        title={t('projects.dialog.title')}
        onClose={() => onOpenChange(false)}
      >
        {content}
      </MobileOverlayPanel>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {content}
      </DialogContent>
    </Dialog>
  );
};
