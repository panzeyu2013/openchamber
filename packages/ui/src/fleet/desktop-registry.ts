import { desktopHostsGet, getDesktopHostApiUrl, type DesktopHost } from '@/lib/desktopHosts';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';
import type { FleetServer } from './types';

const runtimeKeyForHost = (host: DesktopHost): string => `desktop-host:${host.id}`;

const toFleetServer = (host: DesktopHost): FleetServer => ({
  id: `desktop:${host.id}`,
  label: host.label,
  kind: host.relay ? 'relay' : 'remote-url',
  status: 'disconnected',
  descriptor: {
    // Relay traffic is routed by runtimeFetch through the tunnel; its API base
    // must remain the renderer origin, matching DesktopHostSwitcher.
    apiBaseUrl: host.relay && typeof window !== 'undefined'
      ? window.location.origin
      : getDesktopHostApiUrl(host),
    runtimeKey: runtimeKeyForHost(host),
    ...(host.clientToken ? { clientToken: host.clientToken } : {}),
    ...(host.requestHeaders ? { requestHeaders: host.requestHeaders } : {}),
    ...(host.relay ? { relay: host.relay } : {}),
  },
});

/**
 * Projects the desktop shell's credential-owning host configuration into the
 * in-memory Fleet registry. This does not persist tokens or duplicate desktop
 * host storage; callers must discard the result when the runtime changes.
 */
export const loadDesktopFleetServers = async (): Promise<FleetServer[]> => {
  const config = await desktopHostsGet();
  const local: FleetServer = {
    id: 'local',
    label: 'Local',
    kind: 'local',
    status: 'connected',
    descriptor: { apiBaseUrl: config.localOrigin || getRuntimeApiBaseUrl(), runtimeKey: 'local' },
  };
  return [local, ...config.hosts.map(toFleetServer)];
};
