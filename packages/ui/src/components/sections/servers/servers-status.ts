import type { DesktopSshInstanceStatus } from '@/lib/desktopSsh';
import type { I18nKey } from '@/lib/i18n';
import type { ConnectionProfileSummary, SourceFreshness } from '@/projects/types';

/** Live probe state of one connection (page-local, from "Test connection"). */
export interface ProbeDisplayState {
  kind: 'idle' | 'checking' | 'ok' | 'fail';
  latencyMs?: number;
  error?: string;
}

export type ConnectionStatusKind = 'checking' | 'connected' | 'unreachable' | 'neverConnected';

export type FreshnessKind = 'synced' | 'stale' | 'offline' | 'unknown';

/** Primary status of a connection: a live probe result wins; otherwise the
 * persisted last successful probe; otherwise "never connected". The built-in
 * local connection is the control plane itself — its boot probe never writes
 * `lastProbeOkAt`, but it is always reachable. */
export const deriveConnectionStatus = (
  connection: ConnectionProfileSummary | null | undefined,
  probe: ProbeDisplayState | undefined,
): ConnectionStatusKind => {
  if (probe?.kind === 'checking') return 'checking';
  if (probe?.kind === 'fail') return 'unreachable';
  if (probe?.kind === 'ok' || connection?.lastProbeOkAt) return 'connected';
  if (connection?.id === 'local') return 'connected';
  return 'neverConnected';
};

/** Session-index freshness of a connection (the server-side observer state):
 * stale and offline match the SourceFreshness semantics; missing means the
 * observer has not reported yet (e.g. a just-registered connection). */
export const deriveFreshness = (freshness: SourceFreshness | undefined): FreshnessKind => {
  if (!freshness) return 'unknown';
  if (freshness.stale) return 'stale';
  if (freshness.offline || !freshness.complete) return 'offline';
  return 'synced';
};

/** Catalog connection ids of SSH connections are `ssh:<instanceId>`; the
 * suffix is the ssh-manager instance id the desktop tunnel actions operate
 * on. Returns null for any other id shape. */
export const sshInstanceIdOf = (connectionId: string): string | null => {
  return connectionId.startsWith('ssh:') ? connectionId.slice('ssh:'.length) : null;
};

/** i18n key for a desktop SSH instance phase, reusing the host-switcher
 * phase keys that every locale already ships. */
export const sshPhaseLabelKey = (phase: DesktopSshInstanceStatus['phase']): I18nKey => {
  switch (phase) {
    case 'ready':
      return 'desktopHostSwitcher.sshPhase.ready';
    case 'error':
      return 'desktopHostSwitcher.sshPhase.error';
    case 'degraded':
      return 'desktopHostSwitcher.sshPhase.reconnecting';
    case 'config_resolved':
      return 'desktopHostSwitcher.sshPhase.resolvingConfig';
    case 'auth_check':
      return 'desktopHostSwitcher.sshPhase.checkingAuth';
    case 'master_connecting':
      return 'desktopHostSwitcher.sshPhase.connectingSsh';
    case 'remote_probe':
      return 'desktopHostSwitcher.sshPhase.probingRemote';
    case 'installing':
      return 'desktopHostSwitcher.sshPhase.installing';
    case 'updating':
      return 'desktopHostSwitcher.sshPhase.updating';
    case 'server_detecting':
      return 'desktopHostSwitcher.sshPhase.detectingServer';
    case 'server_starting':
      return 'desktopHostSwitcher.sshPhase.startingServer';
    case 'forwarding':
      return 'desktopHostSwitcher.sshPhase.forwardingPorts';
    default:
      return 'desktopHostSwitcher.sshPhase.idle';
  }
};
