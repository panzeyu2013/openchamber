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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { createConnection, listConnectionChildren, type BrowseChild } from './catalog-client';
import { useWorkspaceCatalogStore } from './catalog-store';
import type { ConnectionProfileSummary, WorkspaceDescriptor } from './types';

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

interface AddWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after the catalog insert succeeds (legacy sidebar dual-write). */
  onWorkspaceAdded?: (workspace: WorkspaceDescriptor) => void;
}

const basenameOf = (pathValue: string): string => {
  const parts = pathValue.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : pathValue;
};

export const AddWorkspaceDialog: React.FC<AddWorkspaceDialogProps> = ({
  open,
  onOpenChange,
  onWorkspaceAdded,
}) => {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const catalogStatus = useWorkspaceCatalogStore((state) => state.status);
  const catalogRefresh = useWorkspaceCatalogStore((state) => state.refresh);
  const createWorkspace = useWorkspaceCatalogStore((state) => state.createWorkspace);
  const snapshot = useWorkspaceCatalogStore((state) => state.snapshot);

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
  const [serverLabel, setServerLabel] = React.useState('');
  const [serverBaseUrl, setServerBaseUrl] = React.useState('');
  const [serverToken, setServerToken] = React.useState('');
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [isServerSubmitting, setIsServerSubmitting] = React.useState(false);

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
    setIsBrowseLoading(true);
    setBrowseError(null);
    try {
      const result = await listConnectionChildren(selectedConnection.id, directory);
      setBrowsePath(result.directory);
      setBrowseEntries(result.children);
    } catch (browseFailure) {
      setBrowseError(browseFailure instanceof Error ? browseFailure.message : t('workspaces.dialog.browse.loadFailed'));
      setBrowseEntries([]);
    } finally {
      setIsBrowseLoading(false);
    }
  }, [selectedConnection, t]);

  const handleAddServer = React.useCallback(async () => {
    setServerError(null);
    if (!serverLabel.trim() || !serverBaseUrl.trim()) {
      setServerError(t('workspaces.dialog.server.error.required'));
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
      setSelectedConnectionId(connection.id);
      setIsAddingServer(false);
      setServerLabel('');
      setServerBaseUrl('');
      setServerToken('');
    } catch (serverFailure) {
      setServerError(serverFailure instanceof Error ? serverFailure.message : t('workspaces.dialog.server.error.createFailed'));
    } finally {
      setIsServerSubmitting(false);
    }
  }, [catalogRefresh, serverBaseUrl, serverLabel, serverToken, t]);

  const openBrowser = React.useCallback(() => {
    setIsBrowsing(true);
    setBrowsePath(path || '/');
    void loadBrowse(path || '/');
  }, [path, loadBrowse]);

  const handleSubmit = React.useCallback(async () => {
    if (!selectedConnection || !path.trim()) {
      setError(t('workspaces.dialog.error.required'));
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      const workspace = await createWorkspace({
        connectionId: selectedConnection.id,
        path: path.trim(),
        label: name.trim() || undefined,
        color: color.trim() || undefined,
      });
      toast.success(t('workspaces.dialog.toast.added', { label: workspace.label }));
      onWorkspaceAdded?.(workspace);
      resetForm();
      onOpenChange(false);
    } catch (createFailure) {
      // Keep user input on failure and show a sanitized, actionable error.
      const message = createFailure instanceof Error ? createFailure.message : t('workspaces.dialog.error.createFailed');
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  }, [createWorkspace, color, name, onOpenChange, onWorkspaceAdded, path, resetForm, selectedConnection, t]);

  const content = (
    <>
      <DialogHeader>
        <DialogTitle>{t('workspaces.dialog.title')}</DialogTitle>
        <DialogDescription>{t('workspaces.dialog.description')}</DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-4 py-2">
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="workspace-connection">{t('workspaces.dialog.server.label')}</label>
          <Select
            value={selectedConnectionId}
            onValueChange={(value) => {
              setSelectedConnectionId(value);
              setBrowseEntries([]);
              setBrowseError(null);
            }}
          >
            <SelectTrigger id="workspace-connection" className="w-full">
              <SelectValue placeholder={t('workspaces.dialog.server.placeholder')} />
            </SelectTrigger>
            <SelectContent>
              {connections.length === 0 ? (
                <SelectItem value="local" disabled>{t('workspaces.dialog.server.loading')}</SelectItem>
              ) : connections.map((connection) => (
                <SelectItem key={connection.id} value={connection.id}>
                  {connection.id === 'local' ? t('workspaces.dialog.server.thisComputer') : connection.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!isAddingServer ? (
            <button
              type="button"
              className="self-start text-sm text-foreground/70 underline-offset-2 hover:underline"
              onClick={() => setIsAddingServer(true)}
            >
              {t('workspaces.dialog.server.add')}
            </button>
          ) : (
            <div className="flex flex-col gap-2 rounded-md border p-3">
              <label className="text-sm font-medium" htmlFor="server-label">{t('workspaces.dialog.server.form.label')}</label>
              <Input
                id="server-label"
                value={serverLabel}
                onChange={(event) => setServerLabel(event.target.value)}
                placeholder={t('workspaces.dialog.server.form.labelPlaceholder')}
              />
              <label className="text-sm font-medium" htmlFor="server-url">{t('workspaces.dialog.server.form.url')}</label>
              <Input
                id="server-url"
                value={serverBaseUrl}
                onChange={(event) => setServerBaseUrl(event.target.value)}
                placeholder="https://example.com"
              />
              <label className="text-sm font-medium" htmlFor="server-token">{t('workspaces.dialog.server.form.token')}</label>
              <Input
                id="server-token"
                type="password"
                value={serverToken}
                onChange={(event) => setServerToken(event.target.value)}
                placeholder={t('workspaces.dialog.server.form.tokenPlaceholder')}
              />
              {serverError && <p role="alert" className="text-sm text-destructive">{serverError}</p>}
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setIsAddingServer(false)}
                >
                  {t('gitView.common.cancel')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void handleAddServer()}
                  disabled={isServerSubmitting}
                >
                  {isServerSubmitting ? t('workspaces.dialog.server.form.saving') : t('workspaces.dialog.server.form.save')}
                </Button>
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="workspace-path">{t('workspaces.dialog.path.label')}</label>
          <div className="flex gap-2">
            <Input
              id="workspace-path"
              value={path}
              onChange={(event) => applyPath(event.target.value)}
              placeholder={t('workspaces.dialog.path.placeholder')}
              className="flex-1"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!selectedConnection?.capabilities.pathBrowse}
              onClick={openBrowser}
              aria-label={t('workspaces.dialog.path.browseAria')}
            >
              <Icon name="folder" className="mr-1 h-4 w-4" />
              {t('workspaces.dialog.path.browse')}
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
                onClick={() => void loadBrowse(browsePath === '/' ? '/' : (browsePath.split('/').slice(0, -1).join('/') || '/'))}
                disabled={browsePath === '/' || isBrowseLoading}
                aria-label={t('workspaces.dialog.browse.upAria')}
              >
                <Icon name="arrow-up" className="h-3.5 w-3.5" />
              </Button>
              <span className="truncate">{browsePath}</span>
            </div>
            {browseError && <p className="text-sm text-destructive">{browseError}</p>}
            <div className="flex max-h-48 flex-col gap-0.5 overflow-y-auto">
              {isBrowseLoading ? (
                <p className="px-2 py-1 text-sm text-foreground/60">{t('workspaces.dialog.browse.loading')}</p>
              ) : browseEntries.length === 0 && !browseError ? (
                <p className="px-2 py-1 text-sm text-foreground/60">{t('workspaces.dialog.browse.empty')}</p>
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
              {t('workspaces.dialog.browse.choose')}
            </Button>
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="workspace-name">{t('workspaces.dialog.name.label')}</label>
          <Input
            id="workspace-name"
            value={name}
            onChange={(event) => { setName(event.target.value); setNameEdited(true); }}
            placeholder={t('workspaces.dialog.name.placeholder')}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="workspace-color">{t('workspaces.dialog.color.label')}</label>
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
              id="workspace-color"
              value={color}
              onChange={(event) => setColor(event.target.value)}
              placeholder={t('workspaces.dialog.color.placeholder')}
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
          {isSubmitting ? t('workspaces.dialog.actions.adding') : t('workspaces.dialog.actions.add')}
        </Button>
      </DialogFooter>
    </>
  );

  if (isMobile) {
    return (
      <MobileOverlayPanel
        open={open}
        title={t('workspaces.dialog.title')}
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
