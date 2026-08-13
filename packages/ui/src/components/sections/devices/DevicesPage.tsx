import React from 'react';
import QRCode from 'qrcode';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Radio } from '@/components/ui/radio';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { toast } from '@/components/ui';
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import { formatDateTimeForPreference } from '@/lib/timeFormat';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useUIStore } from '@/stores/useUIStore';
import type { PendingPairingRecord, RemoteClientRecord } from '@/lib/api/types';
import { buildPairingConnectionPayload, encodePairingConnectionPayload, type PairingEndpointCandidate } from '@/lib/connectionPayload';
import { desktopHostsGet, desktopHostsSet, normalizeHostUrl } from '@/lib/desktopHosts';
import { getDesktopLanAddress, isDesktopLocalOriginActive, isDesktopShell } from '@/lib/desktop';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getControlPlaneBaseUrl, setControlPlane } from '@/lib/control-plane';

// Friendly label for a device's self-reported platform in the device list.
const devicePlatformLabel = (platform?: string | null): string | null => {
  switch ((platform || '').toLowerCase()) {
    case 'ios': return 'iOS';
    case 'android': return 'Android';
    case 'macos':
    case 'darwin': return 'macOS';
    case 'windows':
    case 'win32': return 'Windows';
    case 'linux': return 'Linux';
    default: return null;
  }
};

const getRuntimePort = (): number | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  const runtimeApiBaseUrl = getControlPlaneBaseUrl();
  const portSource = runtimeApiBaseUrl || window.location.href;
  try {
    const port = Number(new URL(portSource).port || window.location.port);
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    const port = Number(window.location.port);
    return Number.isFinite(port) && port > 0 ? port : null;
  }
};

const isLoopbackUrl = (value: string): boolean => {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
};

const resolvePairingServerUrl = async (): Promise<string> => {
  const fallback = normalizeHostUrl(getControlPlaneBaseUrl()) || window.location.origin;
  if (!isDesktopShell() || !isDesktopLocalOriginActive()) {
    return fallback;
  }

  let response: Response;
  try {
    response = await runtimeFetch('/api/config/settings', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  } catch {
    return fallback;
  }
  if (!response.ok) return fallback;

  const settings = (await response.json().catch(() => null)) as null | {
    desktopLanAccessActive?: unknown;
  };
  if (settings?.desktopLanAccessActive !== true) {
    return fallback;
  }

  const address = await getDesktopLanAddress();
  const port = getRuntimePort();
  if (!address || !port) {
    return fallback;
  }

  return `http://${address}:${port}`;
};

export const DevicesPage: React.FC = () => {
  const { t } = useI18n();
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const { clientAuth } = useRuntimeAPIs();

  const [remoteClients, setRemoteClients] = React.useState<RemoteClientRecord[]>([]);
  const [pendingPairings, setPendingPairings] = React.useState<PendingPairingRecord[]>([]);
  const [remoteClientsLoading, setRemoteClientsLoading] = React.useState(false);
  const [remoteClientLabel, setRemoteClientLabel] = React.useState('');
  const [remoteClientError, setRemoteClientError] = React.useState<string | null>(null);
  const [pairingUrl, setPairingUrl] = React.useState<string | null>(null);
  // The pairing session shown in the QR dialog; used to auto-close the dialog
  // once the device redeems it (the pairing leaves the pending list).
  const [createdPairingId, setCreatedPairingId] = React.useState<string | null>(null);
  const [pairingQrDataUrl, setPairingQrDataUrl] = React.useState<string | null>(null);
  const [pairingCopied, setPairingCopied] = React.useState(false);
  // "Add a device" dialog: a configure phase (name + transport + fallback) then a
  // result phase (QR + link). The QR only ever shows inside this dialog.
  const [addDeviceOpen, setAddDeviceOpen] = React.useState(false);
  const [addDevicePhase, setAddDevicePhase] = React.useState<'configure' | 'result'>('configure');
  const [addDeviceCreating, setAddDeviceCreating] = React.useState(false);
  const [addDeviceTransport, setAddDeviceTransport] = React.useState<'local' | 'lan' | 'relay'>('relay');
  const [addDeviceFallback, setAddDeviceFallback] = React.useState(true);
  const [transportOptions, setTransportOptions] = React.useState<{ localUrl: string | null; lanUrl: string | null; relayAvailable: boolean } | null>(null);
  const revokedClientCount = React.useMemo(() => remoteClients.filter((client) => Boolean(client.revokedAt)).length, [remoteClients]);

  const loadRemoteClients = React.useCallback(async (options?: { silent?: boolean }) => {
    if (!clientAuth) return;
    if (!options?.silent) setRemoteClientsLoading(true);
    if (!options?.silent) setRemoteClientError(null);
    try {
      // Pending fetch failure returns null (NOT []) so a transient blip neither
      // blanks the pending list nor fakes a "pairing redeemed" signal for the
      // QR dialog's auto-close below.
      const [clients, pending] = await Promise.all([
        clientAuth.listClients(),
        clientAuth.listPendingPairings().catch(() => null),
      ]);
      setRemoteClients(clients);
      if (pending) setPendingPairings(pending);
    } catch (err) {
      // A silent poll must not surface a transient error over the live list.
      if (!options?.silent) setRemoteClientError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!options?.silent) setRemoteClientsLoading(false);
    }
  }, [clientAuth]);

  // Auto-close the QR/link dialog once the device connects: the pairing session
  // is single-use, so it leaving the pending list means it was redeemed (or
  // expired/cancelled — the dialog is stale either way). Armed only after the
  // pairing has been SEEN in the pending list — the result phase renders before
  // the refreshed list arrives, and closing on that stale "absent" would blink
  // the dialog shut immediately. Successful-fetch-only updates keep transient
  // poll failures from faking the disappearance.
  const pairingSeenPendingRef = React.useRef(false);
  React.useEffect(() => {
    if (!addDeviceOpen || addDevicePhase !== 'result' || !createdPairingId) return;
    if (pendingPairings.some((pending) => pending.id === createdPairingId)) {
      pairingSeenPendingRef.current = true;
      return;
    }
    if (!pairingSeenPendingRef.current) return;
    setCreatedPairingId(null);
    setAddDeviceOpen(false);
    // Celebrate only an actual redeem (a client minted from this pairing exists);
    // an expired or cancelled session closes the stale dialog silently.
    if (remoteClients.some((client) => client.pairingId === createdPairingId)) {
      toast.success(t('settings.remoteInstances.clientAuth.addDevice.connectedToast'));
    }
  }, [addDeviceOpen, addDevicePhase, createdPairingId, pendingPairings, remoteClients, t]);

  const cancelPendingPairing = React.useCallback(async (id: string) => {
    if (!clientAuth) return;
    try {
      await clientAuth.cancelPairing(id);
      setPendingPairings((prev) => prev.filter((entry) => entry.id !== id));
      await loadRemoteClients({ silent: true });
    } catch (err) {
      setRemoteClientError(err instanceof Error ? err.message : String(err));
    }
  }, [clientAuth, loadRemoteClients]);

  // Load on mount, then poll while the page is visible so a device that redeems
  // a pairing link shows up in the list without reopening settings.
  React.useEffect(() => {
    if (!clientAuth) return;
    void loadRemoteClients();
    const interval = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      void loadRemoteClients({ silent: true });
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [clientAuth, loadRemoteClients]);

  // Available direct transports for the create dialog. The server is authoritative
  // for LAN reachability (derived from its bind, not the UI origin), so "Local
  // network" works even when the UI is opened on localhost. Falls back to the
  // client-side guess if the endpoint is unavailable.
  const resolveTransportOptions = React.useCallback(async (): Promise<{ localUrl: string | null; lanUrl: string | null; relayAvailable: boolean }> => {
    if (clientAuth?.getPairingTransports) {
      try {
        const transports = await clientAuth.getPairingTransports();
        return { localUrl: transports.local, lanUrl: transports.lan, relayAvailable: transports.relayAvailable };
      } catch {
        // fall through to the client-side guess
      }
    }
    const port = getRuntimePort();
    const localUrl = port ? `http://127.0.0.1:${port}` : (isLoopbackUrl(window.location.origin) ? window.location.origin : null);
    let lanUrl: string | null = null;
    try {
      const resolved = normalizeHostUrl(await resolvePairingServerUrl());
      lanUrl = resolved && !isLoopbackUrl(resolved) ? resolved : null;
    } catch {
      // keep null
    }
    return { localUrl, lanUrl, relayAvailable: true };
  }, [clientAuth]);

  const openAddDevice = React.useCallback(async () => {
    setRemoteClientError(null);
    setPairingUrl(null);
    setPairingQrDataUrl(null);
    setPairingCopied(false);
    setCreatedPairingId(null);
    setAddDevicePhase('configure');
    setAddDeviceFallback(true);
    setAddDeviceOpen(true);
    const opts = await resolveTransportOptions();
    setTransportOptions(opts);
    // "Anywhere" (relay, with home-network preference) is the right default for
    // most people; fall back to narrower options only when relay is unavailable.
    setAddDeviceTransport(opts.relayAvailable ? 'relay' : opts.lanUrl ? 'lan' : 'local');
  }, [resolveTransportOptions]);

  const createPairingLink = React.useCallback(async () => {
    if (!clientAuth?.createPairingSession || !transportOptions) return;
    setRemoteClientError(null);
    setAddDeviceCreating(true);
    try {
      const label = remoteClientLabel.trim() || undefined;
      // Map the chosen transport (+ fallback) to the per-link candidate request.
      let serverUrl: string | undefined;
      let includeRelay: boolean;
      let includeDirect = true;
      if (addDeviceTransport === 'local') {
        serverUrl = transportOptions.localUrl ?? undefined;
        includeRelay = false;
      } else if (addDeviceTransport === 'lan') {
        serverUrl = transportOptions.lanUrl ?? undefined;
        includeRelay = addDeviceFallback;
      } else if (addDeviceFallback && transportOptions.lanUrl) {
        // Relay, but prefer the local network when available: carry both.
        serverUrl = transportOptions.lanUrl;
        includeRelay = true;
      } else {
        // Relay only.
        includeDirect = false;
        includeRelay = true;
      }
      const { pairing, server } = await clientAuth.createPairingSession({
        label,
        allowedClientKinds: ['mobile', 'desktop'],
        serverUrl,
        includeRelay,
        includeDirect,
      });
      const payload = buildPairingConnectionPayload({
        pairingId: pairing.id,
        secret: pairing.secret,
        // The typed name (`label`) is the per-device label shown in THIS server's
        // device list; it already went to createPairingSession above. The payload
        // label is what the paired device names its connection by, which must be
        // the issuing server's name (hostname), not the device's own name.
        label: server.label,
        fingerprint: pairing.fingerprint ?? undefined,
        expiresAt: pairing.expiresAt,
        candidates: server.candidates as unknown as PairingEndpointCandidate[],
      });
      const encoded = encodePairingConnectionPayload(payload);
      setPairingUrl(encoded);
      // Pairing payloads are dense (multiple transport candidates + the relay
      // E2EE key), so render at high resolution with low error-correction.
      setPairingQrDataUrl(await QRCode.toDataURL(encoded, { width: 1024, margin: 2, errorCorrectionLevel: 'L' }));
      setPairingCopied(false);
      pairingSeenPendingRef.current = false;
      setCreatedPairingId(pairing.id);
      setAddDevicePhase('result');
      // Loads the pending list including this pairing BEFORE the result phase
      // polls it, so the auto-close effect sees "present -> gone" transitions.
      await loadRemoteClients({ silent: true });
    } catch (err) {
      setRemoteClientError(err instanceof Error ? err.message : String(err));
    } finally {
      setAddDeviceCreating(false);
    }
  }, [clientAuth, transportOptions, addDeviceTransport, addDeviceFallback, remoteClientLabel, loadRemoteClients]);

  const handleCopyPairing = React.useCallback(() => {
    if (!pairingUrl) return;
    void copyTextToClipboard(pairingUrl).then((result) => {
      if (!result.ok) return;
      setPairingCopied(true);
      window.setTimeout(() => setPairingCopied(false), 2000);
    });
  }, [pairingUrl]);

  const revokeRemoteClient = React.useCallback(async (client: RemoteClientRecord) => {
    if (!clientAuth) return;
    const isLocalDesktopClient = client.clientKind === 'desktop-local';
    setRemoteClientError(null);
    try {
      await clientAuth.revokeClient(client.id);
      if (isLocalDesktopClient && isDesktopShell()) {
        const config = await desktopHostsGet();
        await desktopHostsSet({
          hosts: config.hosts,
          defaultHostId: config.defaultHostId,
          initialHostChoiceCompleted: config.initialHostChoiceCompleted,
          localClientToken: null,
        });
        setRemoteClients((clients) => clients.map((entry) => entry.id === client.id
          ? { ...entry, revokedAt: new Date().toISOString() }
          : entry));
        setControlPlane({ apiBaseUrl: getControlPlaneBaseUrl(), clientToken: null, runtimeKey: 'local' });
        return;
      }
      await loadRemoteClients();
    } catch (err) {
      setRemoteClientError(err instanceof Error ? err.message : String(err));
    }
  }, [clientAuth, loadRemoteClients]);

  const purgeRevokedRemoteClients = React.useCallback(async () => {
    if (!clientAuth) return;
    setRemoteClientError(null);
    try {
      await clientAuth.purgeRevokedClients();
      await loadRemoteClients();
    } catch (err) {
      setRemoteClientError(err instanceof Error ? err.message : String(err));
    }
  }, [clientAuth, loadRemoteClients]);

  return (
    <SettingsPageLayout title={t('settings.page.devices.title')}>
      {clientAuth ? (
        <SettingsSection
          title={t('settings.remoteInstances.clientAuth.title')}
          info={t('settings.remoteInstances.clientAuth.description')}
          divider={false}
          settingsItem="remote-instances.client-auth"
          contentClassName="space-y-3"
        >
            <div>
              <Button type="button" size="xs" className="!font-normal" onClick={() => void openAddDevice()}>
                <Icon name="add" className="h-3.5 w-3.5" />
                {t('settings.remoteInstances.clientAuth.actions.addDevice')}
              </Button>
            </div>
            <div className="space-y-2.5">
              {revokedClientCount > 0 ? (
                <div className="flex justify-end">
                  <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => void purgeRevokedRemoteClients()}>
                    {t('settings.remoteInstances.clientAuth.actions.clearRevoked')}
                  </Button>
                </div>
              ) : null}
              {remoteClientsLoading && remoteClients.length === 0 && pendingPairings.length === 0 ? (
                <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.clientAuth.state.loading')}</p>
              ) : remoteClients.length === 0 && pendingPairings.length === 0 ? (
                <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.clientAuth.state.empty')}</p>
              ) : (
                <>
                  {pendingPairings.map((pending) => (
                    <div key={`pending-${pending.id}`} className="flex items-center justify-between gap-3 py-1.5">
                      <div className="min-w-0 space-y-0.5">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--status-warning)] animate-pulse" />
                          <p className="typography-ui-label text-foreground truncate">{pending.label || t('settings.remoteInstances.clientAuth.field.labelPlaceholder')}</p>
                          {pending.usesRelay ? (
                            <span className="typography-micro text-muted-foreground bg-muted px-1 rounded shrink-0 leading-none pb-px border border-border/50">{t('settings.remoteInstances.clientAuth.state.viaRelay')}</span>
                          ) : null}
                        </div>
                        <p className="typography-micro text-muted-foreground truncate">{t('settings.remoteInstances.clientAuth.state.pending')}</p>
                      </div>
                      <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => void cancelPendingPairing(pending.id)}>
                        {t('settings.common.actions.cancel')}
                      </Button>
                    </div>
                  ))}
                  {remoteClients.map((client) => {
                    const isLocalDesktopClient = client.clientKind === 'desktop-local';
                    // Live presence: the server refreshes lastUsedAt on every
                    // authenticated request (writes throttled to 60s), so a
                    // device with activity in the last 90s is connected NOW.
                    // The list polls every 5s, keeping this fresh.
                    const lastUsedMs = client.lastUsedAt ? Date.parse(client.lastUsedAt) : Number.NaN;
                    const isOnline = !client.revokedAt
                      && (isLocalDesktopClient || (Number.isFinite(lastUsedMs) && Date.now() - lastUsedMs < 90_000));
                    const statusText = client.revokedAt
                      ? t('settings.remoteInstances.clientAuth.state.revoked')
                      : isOnline
                        ? (client.lastTransport === 'relay' && !isLocalDesktopClient
                          ? t('settings.remoteInstances.clientAuth.state.connectedRelay')
                          : t('settings.remoteInstances.clientAuth.state.connectedDirect'))
                        : Number.isFinite(lastUsedMs)
                          ? t('settings.remoteInstances.clientAuth.lastUsed', {
                              date: formatDateTimeForPreference(lastUsedMs, timeFormatPreference, {
                                month: 'short',
                                day: 'numeric',
                                hour: 'numeric',
                                minute: '2-digit',
                              }),
                            })
                          : t('settings.remoteInstances.clientAuth.neverUsed');
                    return (
                      <div key={client.id} className="flex items-center justify-between gap-3 py-1.5">
                        <div className="min-w-0">
                          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                            <span className={cn(
                              'h-2 w-2 shrink-0 rounded-full',
                              client.revokedAt ? 'bg-muted-foreground/20' : isOnline ? 'bg-[var(--status-success)]' : 'bg-muted-foreground/30',
                            )} />
                            <p className="typography-ui-label text-foreground truncate">{client.label}</p>
                            {devicePlatformLabel(client.devicePlatform) ? (
                              <span className="typography-micro text-muted-foreground bg-muted px-1 rounded shrink-0 leading-none pb-px border border-border/50">
                                {devicePlatformLabel(client.devicePlatform)}
                              </span>
                            ) : null}
                            {isLocalDesktopClient ? (
                              <span className="typography-micro text-muted-foreground bg-muted px-1 rounded flex-shrink-0 leading-none pb-px border border-border/50">
                                {t('settings.remoteInstances.clientAuth.state.thisDevice')}
                              </span>
                            ) : null}
                            <span className={cn('typography-micro truncate', isOnline && !client.revokedAt ? 'text-[var(--status-success)]' : 'text-muted-foreground')}>{statusText}</span>
                          </div>
                        </div>
                        <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => void revokeRemoteClient(client)} disabled={Boolean(client.revokedAt)}>
                          {t('settings.remoteInstances.clientAuth.actions.revoke')}
                        </Button>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
            {remoteClientError ? <p className="typography-meta text-[var(--status-error)]">{remoteClientError}</p> : null}
        </SettingsSection>
      ) : null}

      <Dialog open={addDeviceOpen} onOpenChange={setAddDeviceOpen}>
        <DialogContent className={addDevicePhase === 'result' ? 'sm:max-w-lg' : 'sm:max-w-md'}>
          <DialogHeader>
            <DialogTitle>{addDevicePhase === 'result' ? t('settings.remoteInstances.clientAuth.qrDialogTitle') : t('settings.remoteInstances.clientAuth.actions.addDevice')}</DialogTitle>
            {/* Configure phase: what this dialog will produce. Result phase: what
                to do with the QR code that is now on screen. */}
            <DialogDescription>{addDevicePhase === 'result' ? t('settings.remoteInstances.clientAuth.qrScanHint') : t('settings.remoteInstances.clientAuth.addDevice.subtitle')}</DialogDescription>
          </DialogHeader>
          {addDevicePhase === 'configure' ? (
            <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void createPairingLink(); }}>
              <Input
                className="h-8"
                value={remoteClientLabel}
                onChange={(event) => setRemoteClientLabel(event.target.value)}
                placeholder={t('settings.remoteInstances.clientAuth.field.labelPlaceholder')}
                autoFocus
              />
              <div className="space-y-1.5">
                <p className="typography-ui-label text-foreground">{t('settings.remoteInstances.clientAuth.addDevice.transportLabel')}</p>
                {/* Ordered by how likely a first-time user is to want each option;
                    "Anywhere" is the default. Every option explains its outcome in
                    plain words — "relay" appears only inside the description. */}
                <div role="radiogroup" aria-label={t('settings.remoteInstances.clientAuth.addDevice.transportLabel')} className="space-y-1.5">
                  {([
                    { key: 'relay' as const, label: t('settings.remoteInstances.clientAuth.addDevice.transport.relay'), hint: t('settings.remoteInstances.clientAuth.addDevice.transport.relayHint'), available: Boolean(transportOptions?.relayAvailable) },
                    { key: 'lan' as const, label: t('settings.remoteInstances.clientAuth.addDevice.transport.lan'), hint: t('settings.remoteInstances.clientAuth.addDevice.transport.lanHint'), available: Boolean(transportOptions?.lanUrl) },
                    { key: 'local' as const, label: t('settings.remoteInstances.clientAuth.addDevice.transport.local'), hint: t('settings.remoteInstances.clientAuth.addDevice.transport.localHint'), available: Boolean(transportOptions?.localUrl) },
                  ]).map((option) => {
                    const selected = addDeviceTransport === option.key;
                    return (
                      <div
                        key={option.key}
                        className={cn('flex items-start gap-2 py-0.5', option.available ? 'cursor-pointer' : 'opacity-45')}
                        onClick={() => { if (option.available) setAddDeviceTransport(option.key); }}
                        role="presentation"
                      >
                        <Radio
                          checked={selected}
                          disabled={!option.available}
                          onChange={() => setAddDeviceTransport(option.key)}
                          ariaLabel={option.label}
                          className="mt-0.5"
                        />
                        <div className="min-w-0">
                          <p className={cn('typography-ui-label font-normal', selected ? 'text-foreground' : 'text-foreground/70')}>{option.label}</p>
                          <p className="typography-meta text-muted-foreground">{option.hint}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {addDeviceTransport === 'lan' ? (
                  <label className="flex w-fit cursor-pointer items-center gap-2 pt-1">
                    <Checkbox checked={addDeviceFallback} onChange={setAddDeviceFallback} ariaLabel={t('settings.remoteInstances.clientAuth.addDevice.fallback.relay')} />
                    <span className="typography-meta text-muted-foreground">{t('settings.remoteInstances.clientAuth.addDevice.fallback.relay')}</span>
                  </label>
                ) : null}
                {addDeviceTransport === 'relay' && transportOptions?.lanUrl ? (
                  <label className="flex w-fit cursor-pointer items-center gap-2 pt-1">
                    <Checkbox checked={addDeviceFallback} onChange={setAddDeviceFallback} ariaLabel={t('settings.remoteInstances.clientAuth.addDevice.fallback.preferLocal')} />
                    <span className="typography-meta text-muted-foreground">{t('settings.remoteInstances.clientAuth.addDevice.fallback.preferLocal')}</span>
                  </label>
                ) : null}
              </div>
              {remoteClientError ? <p className="typography-meta text-[var(--status-error)]">{remoteClientError}</p> : null}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={() => setAddDeviceOpen(false)} disabled={addDeviceCreating}>{t('settings.common.actions.cancel')}</Button>
                <Button type="submit" size="xs" className="!font-normal" disabled={addDeviceCreating || !transportOptions}>{t('settings.remoteInstances.clientAuth.addDevice.create')}</Button>
              </div>
            </form>
          ) : (
            <div className="space-y-3">
              {pairingQrDataUrl ? (
                <div className="flex justify-center">
                  <img src={pairingQrDataUrl} alt={t('settings.remoteInstances.clientAuth.qrAlt')} className="w-full max-w-[420px] rounded-md bg-white p-4" />
                </div>
              ) : null}
              {pairingUrl ? (
                <div className="flex items-center gap-2 rounded-md border border-[var(--interactive-border)] p-2">
                  <code className="min-w-0 flex-1 truncate typography-code text-muted-foreground">{pairingUrl}</code>
                  <Button type="button" variant="outline" size="xs" className="!font-normal shrink-0" onClick={handleCopyPairing}>
                    <Icon name={pairingCopied ? 'check' : 'file-copy'} className={cn('h-3.5 w-3.5', pairingCopied && 'text-[var(--status-success)]')} />
                    {pairingCopied ? t('settings.remoteInstances.clientAuth.actions.copied') : t('settings.common.actions.copyAll')}
                  </Button>
                </div>
              ) : null}
              <div className="flex justify-end">
                <Button type="button" size="xs" className="!font-normal" onClick={() => setAddDeviceOpen(false)}>{t('settings.remoteInstances.clientAuth.addDevice.done')}</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </SettingsPageLayout>
  );
};
