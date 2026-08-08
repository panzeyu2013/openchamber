import { desktopHostsGet, getDesktopHostApiUrl, type DesktopHost } from '@/lib/desktopHosts';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';
import type { DesktopSshInstanceStatus } from '@/lib/desktopSsh';
import { useDesktopSshStore } from '@/stores/useDesktopSshStore';
import { useFleetStore } from './fleet-store';
import type { FleetServer, FleetServerStatus } from './types';

// The Active Runtime key namespace used by DesktopHostSwitcher for the same
// hosts: `host:<id>` for every saved host (desktop host or SSH instance).
const runtimeKeyForHost = (host: DesktopHost): string => `host:${host.id}`;

const sshStatusToFleetStatus = (status: DesktopSshInstanceStatus | null | undefined): FleetServerStatus => {
  if (!status) return 'disconnected';
  switch (status.phase) {
    case 'ready':
      return 'connected';
    case 'error':
      return 'error';
    case 'degraded':
      return 'degraded';
    case 'idle':
      return 'disconnected';
    default:
      return 'connecting';
  }
};

const toFleetServer = (host: DesktopHost, isSsh: boolean, sshStatus: DesktopSshInstanceStatus | null | undefined): FleetServer => {
  const readyUrl = isSsh && sshStatus?.phase === 'ready' ? (sshStatus.localUrl || '') : '';
  return {
    id: `desktop:${host.id}`,
    label: host.label,
    kind: isSsh ? 'ssh' : host.relay ? 'relay' : 'remote-url',
    status: isSsh ? sshStatusToFleetStatus(sshStatus) : 'disconnected',
    descriptor: {
      // SSH hosts are only reachable while their tunnel is up; a saved but
      // disconnected instance has no endpoint and must not be polled. Relay
      // traffic is routed by runtimeFetch through the tunnel; its API base
      // must remain the renderer origin, matching DesktopHostSwitcher.
      apiBaseUrl: isSsh
        ? readyUrl
        : (host.relay && typeof window !== 'undefined'
          ? window.location.origin
          : getDesktopHostApiUrl(host)),
      runtimeKey: runtimeKeyForHost(host),
      ...(host.clientToken ? { clientToken: host.clientToken } : {}),
      ...(host.requestHeaders ? { requestHeaders: host.requestHeaders } : {}),
      ...(host.relay ? { relay: host.relay } : {}),
    },
  };
};

/**
 * Projects the desktop shell's credential-owning host configuration into the
 * in-memory Fleet registry. This does not persist tokens or duplicate desktop
 * host storage; callers must discard the result when the runtime changes.
 *
 * Saved SSH instances appear here as desktop-host entries (the shell mirrors
 * every SSH instance into the host registry), so all connection methods —
 * local, direct URL, relay, and SSH tunnels — are covered by one registry.
 */
export const loadDesktopFleetServers = async (): Promise<FleetServer[]> => {
  const [config, sshInstances, sshStatusesById] = await Promise.all([
    desktopHostsGet(),
    Promise.resolve(useDesktopSshStore.getState().instances),
    Promise.resolve(useDesktopSshStore.getState().statusesById),
  ]);
  const sshIds = new Set(sshInstances.map((instance) => instance.id));
  const local: FleetServer = {
    id: 'local',
    label: 'Local',
    kind: 'local',
    status: 'connected',
    descriptor: { apiBaseUrl: config.localOrigin || getRuntimeApiBaseUrl(), runtimeKey: 'local' },
  };
  const hosts = config.hosts
    .filter((host) => host?.id && host.id !== 'local')
    .map((host) => toFleetServer(host, sshIds.has(host.id), sshIds.has(host.id) ? sshStatusesById[host.id] : undefined));
  return [local, ...hosts];
};

/**
 * Connect a saved SSH instance from the Fleet sidebar and activate it once its
 * tunnel is up. The registry re-registers the server on SSH status changes;
 * activation waits for that descriptor (real tunnel URL) so a runtime switch
 * never happens against an empty endpoint.
 */
export const connectFleetSshServer = async (fleetServerId: string): Promise<boolean> => {
  const sshId = fleetServerId.replace(/^desktop:/, '');
  const sshStore = useDesktopSshStore.getState();
  try {
    await sshStore.connect(sshId);
  } catch {
    return false;
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const server = useFleetStore.getState().servers.get(fleetServerId);
    if (server?.descriptor.apiBaseUrl) {
      useFleetStore.getState().activateServer(fleetServerId);
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
};
