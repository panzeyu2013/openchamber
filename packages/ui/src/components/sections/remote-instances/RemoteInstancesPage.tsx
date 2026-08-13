import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SettingsSection,
  SettingsGroupTitle,
} from '@/components/sections/shared/SettingsSection';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { parsePairingConnectionPayload, type PairingEndpointCandidate } from '@/lib/connectionPayload';
import {
  desktopHostProbe,
  desktopHostsGet,
  desktopHostsSet,
  desktopInstallIdGet,
  getDesktopHostApiUrl,
  normalizeHostUrl,
  probeRelayDesktopHost,
  redactSensitiveUrl,
  resolveDesktopHostUrl,
  relayHostDisplayUrl,
  type DesktopHost,
  type DesktopHostRelay,
  type HostProbeResult,
} from '@/lib/desktopHosts';
import { createRelayTunnelClient } from '@/lib/relay/tunnel-client';
import { isDesktopShell } from '@/lib/desktop';

// Platform this desktop reports about itself when redeeming a pairing link —
// display-only metadata for the issuing server's device list.
const desktopPlatformName = (): string | undefined => {
  if (typeof navigator === 'undefined') return undefined;
  const ua = (navigator.userAgent || '').toLowerCase();
  if (ua.includes('mac')) return 'macos';
  if (ua.includes('win')) return 'windows';
  if (ua.includes('linux')) return 'linux';
  return undefined;
};

type HeaderDraft = {
  id: string;
  name: string;
  value: string;
};

const createHeaderDraft = (name = '', value = ''): HeaderDraft => ({
  id: typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `header-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  name,
  value,
});

const isReservedRequestHeaderName = (name: string): boolean => name.trim().toLowerCase() === 'authorization';

const buildRequestHeaders = (headers: HeaderDraft[]): Record<string, string> | undefined => {
  const next: Record<string, string> = {};
  for (const header of headers) {
    const name = header.name.trim();
    const value = header.value.trim();
    if (name && value && !isReservedRequestHeaderName(name)) next[name] = value;
  }
  return Object.keys(next).length > 0 ? next : undefined;
};

const readRequestHeaderDrafts = (headers: Record<string, string> | undefined): HeaderDraft[] => {
  return Object.entries(headers || {}).map(([name, value]) => createHeaderDraft(name, value));
};

const navigateToUrl = (rawUrl: string): void => {
  const target = rawUrl.trim();
  if (!target) {
    return;
  }
  try {
    window.location.assign(target);
  } catch {
    window.location.href = target;
  }
};

export const RemoteInstancesPage: React.FC = () => {
  const { t } = useI18n();
  const showInstanceManagement = isDesktopShell();
  const [directHosts, setDirectHosts] = React.useState<DesktopHost[]>([]);
  // Live reachability per saved host (undefined = probe in flight), mirroring
  // the host switcher's status line so this list is not just dead text.
  const [directHostStatus, setDirectHostStatus] = React.useState<Record<string, HostProbeResult>>({});
  const [directDefaultHostId, setDirectDefaultHostId] = React.useState<string | null>('local');
  const [directLoading, setDirectLoading] = React.useState(false);
  const [directSaving, setDirectSaving] = React.useState(false);
  const [directLabel, setDirectLabel] = React.useState('');
  const [directUrl, setDirectUrl] = React.useState('');
  const [directToken, setDirectToken] = React.useState('');
  const [directHeaders, setDirectHeaders] = React.useState<HeaderDraft[]>([]);
  const [directConnectLink, setDirectConnectLink] = React.useState('');
  const [directError, setDirectError] = React.useState<string | null>(null);
  const [directAddDialogOpen, setDirectAddDialogOpen] = React.useState(false);
  const [directImportDialogOpen, setDirectImportDialogOpen] = React.useState(false);
  const [directEditingId, setDirectEditingId] = React.useState<string | null>(null);
  const [directEditLabel, setDirectEditLabel] = React.useState('');
  const [directEditUrl, setDirectEditUrl] = React.useState('');
  const [directEditToken, setDirectEditToken] = React.useState('');
  const [directEditHeaders, setDirectEditHeaders] = React.useState<HeaderDraft[]>([]);

  const loadDirectHosts = React.useCallback(async () => {
    setDirectLoading(true);
    setDirectError(null);
    try {
      const config = await desktopHostsGet();
      setDirectHosts(config.hosts || []);
      setDirectDefaultHostId(config.defaultHostId || 'local');
    } catch (err) {
      setDirectError(err instanceof Error ? err.message : String(err));
    } finally {
      setDirectLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadDirectHosts();
  }, [loadDirectHosts]);

  const persistDirectHosts = React.useCallback(async (hosts: DesktopHost[], defaultHostId: string | null = directDefaultHostId) => {
    setDirectSaving(true);
    setDirectError(null);
    try {
      await desktopHostsSet({ hosts, defaultHostId, initialHostChoiceCompleted: true });
      setDirectHosts(hosts);
      setDirectDefaultHostId(defaultHostId);
    } catch (err) {
      setDirectError(err instanceof Error ? err.message : String(err));
    } finally {
      setDirectSaving(false);
    }
  }, [directDefaultHostId]);

  const handleAddDirectHost = React.useCallback(async () => {
    const resolved = resolveDesktopHostUrl(directUrl);
    if (!resolved) {
      setDirectError(t('desktopHostSwitcher.error.invalidUrl'));
      return;
    }
    const url = resolved.persistedUrl;
    const id = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `host-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const host: DesktopHost = {
      id,
      label: directLabel.trim() || redactSensitiveUrl(url),
      url,
      apiUrl: url,
      ...(directToken.trim() ? { clientToken: directToken.trim() } : {}),
      ...(buildRequestHeaders(directHeaders) ? { requestHeaders: buildRequestHeaders(directHeaders) } : {}),
    };
    await persistDirectHosts([host, ...directHosts], directDefaultHostId);
    setDirectLabel('');
    setDirectUrl('');
    setDirectToken('');
    setDirectHeaders([]);
    setDirectAddDialogOpen(false);
    if (resolved.redeemUrl) {
      navigateToUrl(resolved.redeemUrl);
    }
  }, [directDefaultHostId, directHeaders, directHosts, directLabel, directToken, directUrl, persistDirectHosts, t]);

  const importDirectConnectLink = React.useCallback(async () => {
    const payload = parsePairingConnectionPayload(directConnectLink);
    if (!payload) {
      setDirectError(t('settings.remoteInstances.direct.error.invalidConnectLink'));
      return;
    }
    // The redeem body is identical across every transport (the desktop is the
    // same device however it reaches the server). The install-id dedupe key
    // collapses re-pairing / re-auth of this desktop into one device record.
    const installId = await desktopInstallIdGet().catch(() => '');
    const redeemBody = JSON.stringify({
      pairingId: payload.pairingId,
      secret: payload.secret,
      clientLabel: payload.label || 'OpenChamber Desktop',
      clientKind: 'desktop',
      deviceName: 'OpenChamber Desktop',
      devicePlatform: desktopPlatformName(),
      ...(installId ? { dedupeKey: `desktop:${installId}` } : {}),
    });
    const redeemInit: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: redeemBody,
    };
    const tokenFromResponse = async (response: Response): Promise<string | null> => {
      if (!response.ok) return null;
      const body = (await response.json().catch(() => null)) as { clientToken?: unknown } | null;
      const token = typeof body?.clientToken === 'string' ? body.clientToken.trim() : '';
      return token || null;
    };

    // Try direct (LAN/tunnel) candidates first — they're cheaper and don't need
    // relay infrastructure — then fall back to relay. Ordered by payload priority.
    const ordered = [...payload.candidates].sort(
      (a, b) => (a.type === 'relay' ? 1 : 0) - (b.type === 'relay' ? 1 : 0),
    );

    let redeemed:
      | { kind: 'direct'; url: string; token: string }
      | { kind: 'relay'; relay: DesktopHostRelay; token: string }
      | null = null;

    for (const candidate of ordered) {
      if (candidate.type === 'relay') {
        // Open a throwaway E2EE tunnel just to redeem the one-time secret; the
        // grant (if any) authorizes admission to the relay for this serverId.
        const tunnel = createRelayTunnelClient({
          relayUrl: candidate.relayUrl,
          serverId: candidate.serverId,
          hostEncPubJwk: candidate.hostEncPubJwk,
          ...(candidate.grant ? { grant: candidate.grant } : {}),
        });
        try {
          const response = await tunnel.fetch('/api/client-auth/pairing/redeem', redeemInit);
          const token = await tokenFromResponse(response);
          if (token) {
            redeemed = {
              kind: 'relay',
              // grant is intentionally not persisted (one-time pairing artifact).
              relay: { relayUrl: candidate.relayUrl, serverId: candidate.serverId, hostEncPubJwk: candidate.hostEncPubJwk },
              token,
            };
            break;
          }
        } catch {
          // Relay unreachable / handshake failed — try the next candidate.
        } finally {
          tunnel.close();
        }
        continue;
      }
      // Direct: the remote instance is a user-provided URL, so a plain
      // cross-origin fetch is correct here (not the active runtime).
      const candidateUrl = normalizeHostUrl(candidate.url);
      if (!candidateUrl) continue;
      try {
        const response = await fetch(`${candidateUrl}/api/client-auth/pairing/redeem`, redeemInit);
        const token = await tokenFromResponse(response);
        if (token) {
          redeemed = { kind: 'direct', url: candidateUrl, token };
          break;
        }
      } catch {
        // Unreachable candidate — try the next one.
      }
    }

    if (!redeemed) {
      setDirectError(t('desktopHostSwitcher.error.invalidUrl'));
      return;
    }

    const makeId = (): string => (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `host-${Date.now()}-${Math.random().toString(16).slice(2)}`);

    // Persist EVERY transport the link carried, not just the one that answered
    // the redeem — a multi-transport host connects directly on the home network
    // and falls back to the relay away from it (same model as mobile devices).
    // The single token works over both transports.
    const linkRelayCandidate = payload.candidates.find(
      (candidate): candidate is Extract<PairingEndpointCandidate, { type: 'relay' }> => candidate.type === 'relay',
    );
    const relay: DesktopHostRelay | undefined = redeemed.kind === 'relay'
      ? redeemed.relay
      : linkRelayCandidate
        ? { relayUrl: linkRelayCandidate.relayUrl, serverId: linkRelayCandidate.serverId, hostEncPubJwk: linkRelayCandidate.hostEncPubJwk }
        : undefined;
    const firstDirectUrl = payload.candidates
      .filter((candidate): candidate is Extract<PairingEndpointCandidate, { type: 'lan' | 'tunnel' }> => candidate.type !== 'relay')
      .map((candidate) => normalizeHostUrl(candidate.url))
      .find((value): value is string => Boolean(value));
    const directUrl = redeemed.kind === 'direct' ? redeemed.url : firstDirectUrl;
    const { token } = redeemed;

    const url = directUrl || (relay ? relayHostDisplayUrl(relay.serverId) : null);
    if (!url) {
      setDirectError(t('desktopHostSwitcher.error.invalidUrl'));
      return;
    }
    const transportFields = {
      url,
      apiUrl: directUrl || undefined,
      clientToken: token,
      ...(relay ? { relay } : {}),
    };
    // One host per server: match by relay serverId when the link has a relay
    // leg, else by direct URL — re-importing updates the record in place.
    const existing = directHosts.find((host) => (
      relay ? host.relay?.serverId === relay.serverId : (!host.relay && normalizeHostUrl(host.apiUrl || host.url) === url)
    ));
    if (existing) {
      const nextHosts = directHosts.map((host) => host.id === existing.id
        ? { ...host, label: payload.label || host.label, ...transportFields }
        : host);
      await persistDirectHosts(nextHosts, directDefaultHostId);
    } else {
      // payload.label is normally the issuing server's hostname.
      await persistDirectHosts([{ id: makeId(), label: payload.label || redactSensitiveUrl(url), ...transportFields }, ...directHosts], directDefaultHostId);
    }
    setDirectConnectLink('');
    setDirectError(null);
    setDirectImportDialogOpen(false);
  }, [directConnectLink, directDefaultHostId, directHosts, persistDirectHosts, t]);

  const handleRemoveDirectHost = React.useCallback(async (id: string) => {
    const nextHosts = directHosts.filter((host) => host.id !== id);
    const nextDefault = directDefaultHostId === id ? 'local' : directDefaultHostId;
    await persistDirectHosts(nextHosts, nextDefault);
    if (directEditingId === id) {
      setDirectEditingId(null);
    }
  }, [directDefaultHostId, directEditingId, directHosts, persistDirectHosts]);

  const beginEditDirectHost = React.useCallback((host: DesktopHost) => {
    setDirectEditingId(host.id);
    setDirectEditLabel(host.label);
    setDirectEditUrl(host.apiUrl || host.url);
    setDirectEditToken(host.clientToken || '');
    setDirectEditHeaders(readRequestHeaderDrafts(host.requestHeaders));
    setDirectError(null);
  }, []);

  const saveDirectHostEdit = React.useCallback(async () => {
    if (!directEditingId) return;
    const resolved = resolveDesktopHostUrl(directEditUrl);
    if (!resolved) {
      setDirectError(t('desktopHostSwitcher.error.invalidUrl'));
      return;
    }
    const url = resolved.persistedUrl;
    const nextHosts = directHosts.map((host) => host.id === directEditingId
      ? {
        ...host,
        label: directEditLabel.trim() || redactSensitiveUrl(url),
        url,
        apiUrl: url,
        clientToken: directEditToken.trim() || undefined,
        requestHeaders: buildRequestHeaders(directEditHeaders),
      }
      : host);
    await persistDirectHosts(nextHosts, directDefaultHostId);
    setDirectEditingId(null);
    if (resolved.redeemUrl) {
      navigateToUrl(resolved.redeemUrl);
    }
  }, [directDefaultHostId, directEditHeaders, directEditLabel, directEditToken, directEditUrl, directEditingId, directHosts, persistDirectHosts, t]);

  const setDefaultDirectHost = React.useCallback(async (id: string) => {
    await persistDirectHosts(directHosts, id);
  }, [directHosts, persistDirectHosts]);

  // Probe saved hosts whenever the list changes so each row shows a live
  // Connected/Unreachable status like the host switcher does. One pass per
  // list identity — no polling; the row set changes rarely.
  React.useEffect(() => {
    if (!showInstanceManagement || directHosts.length === 0) return;
    let cancelled = false;
    void Promise.all(directHosts.map(async (host) => {
      const relayProbe = () => probeRelayDesktopHost(host.relay!, { clientToken: host.clientToken || null, requestHeaders: host.requestHeaders || null }).catch((): HostProbeResult => ({ status: 'unreachable', latencyMs: 0 }));
      // Relay-only host: tunnel probe. Multi-transport host: direct first,
      // relay as the away-from-home fallback.
      if (host.relay && !host.apiUrl) {
        return [host.id, await relayProbe()] as const;
      }
      const url = normalizeHostUrl(getDesktopHostApiUrl(host));
      if (!url) {
        return [host.id, host.relay ? await relayProbe() : ({ status: 'unreachable', latencyMs: 0 } as HostProbeResult)] as const;
      }
      const direct = await desktopHostProbe(url, {
        clientToken: host.clientToken || null,
        requestHeaders: host.requestHeaders || null,
        expectedServerId: host.relay?.serverId || null,
      })
        .catch((): HostProbeResult => ({ status: 'unreachable', latencyMs: 0 }));
      if (direct.status === 'unreachable' && host.relay) {
        const relayResult = await relayProbe();
        if (relayResult.status === 'ok') return [host.id, relayResult] as const;
      }
      return [host.id, direct] as const;
    })).then((entries) => {
      if (cancelled) return;
      setDirectHostStatus(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [directHosts, showInstanceManagement]);

  return (
    <SettingsPageLayout title={t('settings.page.remoteInstances.title')}>
      {showInstanceManagement ? <SettingsSection
        title={t('settings.remoteInstances.direct.title')}
        info={t('settings.remoteInstances.direct.description')}
        settingsItem="remote-instances.direct-hosts"
        contentClassName="space-y-4"
        headerAction={(
          /* Importing a pairing link is the flagship path; add-by-address is
             the manual fallback. The token-storage note lives in the add
             dialog next to the token field it describes. */
          <div className="flex shrink-0 items-center gap-2">
            <Button type="button" size="xs" className="!font-normal" onClick={() => setDirectImportDialogOpen(true)} disabled={directSaving}>
              {t('settings.remoteInstances.direct.import.action')}
            </Button>
            <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={() => setDirectAddDialogOpen(true)} disabled={directSaving}>
              <Icon name="add" className="h-3.5 w-3.5" />
              {t('settings.remoteInstances.direct.actions.add')}
            </Button>
          </div>
        )}
      >
          <div className="space-y-2.5">
            {directLoading ? (
              <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.direct.state.loading')}</p>
            ) : directHosts.length === 0 ? (
              <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.direct.state.empty')}</p>
            ) : directHosts.map((host) => {
              const probe = directHostStatus[host.id];
              const statusKey: I18nKey = !probe
                ? 'desktopHostSwitcher.status.checking'
                : probe.status === 'ok'
                  ? 'desktopHostSwitcher.status.connected'
                  : probe.status === 'auth'
                    ? 'desktopHostSwitcher.status.authRequired'
                    : probe.status === 'update-recommended'
                      ? 'desktopHostSwitcher.status.updateRecommended'
                      : probe.status === 'incompatible'
                        ? 'desktopHostSwitcher.status.incompatible'
                        : probe.status === 'wrong-service'
                          ? 'desktopHostSwitcher.status.wrongService'
                          : 'desktopHostSwitcher.status.unreachable';
              const isOnline = probe?.status === 'ok';
              return (
              <div key={host.id} className="py-1.5">
                <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className={cn(
                          'h-2 w-2 shrink-0 rounded-full',
                          !probe ? 'bg-muted-foreground/30 animate-pulse' : isOnline ? 'bg-[var(--status-success)]' : 'bg-[var(--status-error)]',
                        )} />
                        <p className="typography-ui-label text-foreground truncate">{redactSensitiveUrl(host.label)}</p>
                        {directDefaultHostId === host.id ? <span className="typography-micro text-muted-foreground shrink-0">{t('desktopHostSwitcher.header.default')}</span> : null}
                        <span className={cn('typography-micro shrink-0', isOnline ? 'text-[var(--status-success)]' : 'text-muted-foreground')}>
                          {t(statusKey)}
                          {isOnline && typeof probe?.latencyMs === 'number'
                            ? t('desktopHostSwitcher.status.ping', { ms: Math.max(0, Math.round(probe.latencyMs)) })
                            : ''}
                        </span>
                      </div>
                      <p className={cn('typography-micro text-muted-foreground truncate', host.apiUrl && 'font-mono')}>
                        {host.relay && !host.apiUrl ? t('mobile.connect.relay.badge') : redactSensitiveUrl(host.apiUrl || host.url)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => void setDefaultDirectHost(host.id)} disabled={directSaving || directDefaultHostId === host.id} aria-label={t('desktopHostSwitcher.actions.setAsDefaultAria')}>
                        {directDefaultHostId === host.id ? <Icon name="star-fill" className="h-3.5 w-3.5" /> : <Icon name="star" className="h-3.5 w-3.5" />}
                      </Button>
                      {/* The edit form is URL/token-centric; relay-ONLY hosts have
                          nothing it can edit and are re-imported via a fresh pairing
                          link instead. Multi-transport hosts keep their relay leg
                          through the edit (object spread preserves it). */}
                      {host.relay && !host.apiUrl ? null : (
                        <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => beginEditDirectHost(host)} disabled={directSaving}>
                          <Icon name="pencil" className="h-3.5 w-3.5" />
                          {t('desktopHostSwitcher.actions.edit')}
                        </Button>
                      )}
                      <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => void handleRemoveDirectHost(host.id)} disabled={directSaving}>
                        <Icon name="delete-bin" className="h-3.5 w-3.5" />
                        {t('settings.common.actions.delete')}
                      </Button>
                    </div>
                </div>
              </div>
              );
            })}
          </div>

          {directError ? <p className="typography-meta text-[var(--status-error)]">{directError}</p> : null}
      </SettingsSection> : null}

      {showInstanceManagement ? <Dialog open={directAddDialogOpen} onOpenChange={setDirectAddDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('settings.remoteInstances.direct.actions.add')}</DialogTitle>
            <DialogDescription>{t('settings.remoteInstances.direct.addDialog.description')}</DialogDescription>
          </DialogHeader>
          <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void handleAddDirectHost(); }}>
            <Input className="h-8" value={directLabel} onChange={(event) => setDirectLabel(event.target.value)} placeholder={t('settings.remoteInstances.direct.field.labelPlaceholder')} disabled={directSaving} />
            <Input className="h-8" value={directUrl} onChange={(event) => setDirectUrl(event.target.value)} placeholder={t('settings.remoteInstances.direct.field.urlPlaceholder')} disabled={directSaving} autoFocus />
            <div className="space-y-1">
              <Input className="h-8" value={directToken} onChange={(event) => setDirectToken(event.target.value)} placeholder={t('settings.remoteInstances.direct.field.tokenPlaceholder')} type="password" disabled={directSaving} />
              <p className="px-1 typography-micro text-muted-foreground">{t('settings.remoteInstances.direct.note')}</p>
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-1.5">
                <SettingsGroupTitle>{t('settings.remoteInstances.direct.headers.title')}</SettingsGroupTitle>
                <SettingsInfoHint>{t('settings.remoteInstances.direct.headers.description')}</SettingsInfoHint>
              </div>
              {directHeaders.map((header) => (
                <div key={header.id} className="flex w-full gap-2">
                  <Input className="h-8 font-mono text-xs" value={header.name} onChange={(event) => setDirectHeaders((headers) => headers.map((item) => item.id === header.id ? { ...item, name: event.target.value } : item))} placeholder={t('settings.remoteInstances.direct.headers.field.namePlaceholder')} disabled={directSaving} />
                  <Input className="h-8 font-mono text-xs" value={header.value} onChange={(event) => setDirectHeaders((headers) => headers.map((item) => item.id === header.id ? { ...item, value: event.target.value } : item))} placeholder={t('settings.remoteInstances.direct.headers.field.valuePlaceholder')} type="password" disabled={directSaving} />
                  <button type="button" onClick={() => setDirectHeaders((headers) => headers.filter((item) => item.id !== header.id))} className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--status-error-background)] hover:text-[var(--status-error)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]" aria-label={t('settings.remoteInstances.direct.headers.removeAria')} disabled={directSaving}>
                    <Icon name="close" className="h-4 w-4" />
                  </button>
                </div>
              ))}
              <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => setDirectHeaders((headers) => [...headers, createHeaderDraft()])} disabled={directSaving}>
                <Icon name="add" className="h-3.5 w-3.5" />
                {t('settings.remoteInstances.direct.headers.actions.add')}
              </Button>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={() => setDirectAddDialogOpen(false)} disabled={directSaving}>{t('settings.common.actions.cancel')}</Button>
              <Button type="submit" size="xs" className="!font-normal" disabled={directSaving || !directUrl.trim()}>{t('settings.remoteInstances.direct.actions.add')}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog> : null}

      {showInstanceManagement ? <Dialog open={Boolean(directEditingId)} onOpenChange={(open) => { if (!open) setDirectEditingId(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('desktopHostSwitcher.actions.edit')}</DialogTitle>
            <DialogDescription>{t('settings.remoteInstances.direct.description')}</DialogDescription>
          </DialogHeader>
          <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void saveDirectHostEdit(); }}>
            <Input className="h-8" value={directEditLabel} onChange={(event) => setDirectEditLabel(event.target.value)} placeholder={t('settings.remoteInstances.direct.field.labelPlaceholder')} disabled={directSaving} />
            <Input className="h-8" value={directEditUrl} onChange={(event) => setDirectEditUrl(event.target.value)} placeholder={t('settings.remoteInstances.direct.field.urlPlaceholder')} disabled={directSaving} autoFocus />
            <Input className="h-8" value={directEditToken} onChange={(event) => setDirectEditToken(event.target.value)} placeholder={t('settings.remoteInstances.direct.field.tokenPlaceholder')} type="password" disabled={directSaving} />
            <div className="space-y-2">
              <div className="flex items-center gap-1.5">
                <SettingsGroupTitle>{t('settings.remoteInstances.direct.headers.title')}</SettingsGroupTitle>
                <SettingsInfoHint>{t('settings.remoteInstances.direct.headers.description')}</SettingsInfoHint>
              </div>
              {directEditHeaders.map((header) => (
                <div key={header.id} className="flex w-full gap-2">
                  <Input className="h-8 font-mono text-xs" value={header.name} onChange={(event) => setDirectEditHeaders((headers) => headers.map((item) => item.id === header.id ? { ...item, name: event.target.value } : item))} placeholder={t('settings.remoteInstances.direct.headers.field.namePlaceholder')} disabled={directSaving} />
                  <Input className="h-8 font-mono text-xs" value={header.value} onChange={(event) => setDirectEditHeaders((headers) => headers.map((item) => item.id === header.id ? { ...item, value: event.target.value } : item))} placeholder={t('settings.remoteInstances.direct.headers.field.valuePlaceholder')} type="password" disabled={directSaving} />
                  <button type="button" onClick={() => setDirectEditHeaders((headers) => headers.filter((item) => item.id !== header.id))} className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--status-error-background)] hover:text-[var(--status-error)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]" aria-label={t('settings.remoteInstances.direct.headers.removeAria')} disabled={directSaving}>
                    <Icon name="close" className="h-4 w-4" />
                  </button>
                </div>
              ))}
              <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => setDirectEditHeaders((headers) => [...headers, createHeaderDraft()])} disabled={directSaving}>
                <Icon name="add" className="h-3.5 w-3.5" />
                {t('settings.remoteInstances.direct.headers.actions.add')}
              </Button>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={() => setDirectEditingId(null)} disabled={directSaving}>{t('settings.common.actions.cancel')}</Button>
              <Button type="submit" size="xs" className="!font-normal" disabled={directSaving}>{t('settings.common.actions.saveChanges')}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog> : null}

      {showInstanceManagement ? <Dialog open={directImportDialogOpen} onOpenChange={setDirectImportDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('settings.remoteInstances.direct.import.action')}</DialogTitle>
            <DialogDescription>{t('settings.remoteInstances.direct.import.description')}</DialogDescription>
          </DialogHeader>
          <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void importDirectConnectLink(); }}>
            <Input className="h-8" value={directConnectLink} onChange={(event) => setDirectConnectLink(event.target.value)} placeholder={t('settings.remoteInstances.direct.import.placeholder')} disabled={directSaving} autoFocus />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={() => setDirectImportDialogOpen(false)} disabled={directSaving}>{t('settings.common.actions.cancel')}</Button>
              <Button type="submit" size="xs" className="!font-normal" disabled={directSaving || !directConnectLink.trim()}>{t('settings.remoteInstances.direct.import.action')}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog> : null}
    </SettingsPageLayout>
  );
};
