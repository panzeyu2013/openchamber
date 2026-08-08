import { hasDesktopInvoke } from '@/lib/desktop';
import { desktopHostProbe, probeRelayDesktopHost, type HostProbeResult } from '@/lib/desktopHosts';
import type { FleetServer } from './types';

/**
 * Pre-activation reachability check for a Fleet server, mirroring the Host
 * Switcher's probe. Relay descriptors are verified through a throwaway E2EE
 * tunnel; direct endpoints through the main-process host probe. Returns null
 * when no probe is possible (non-desktop runtime), so the caller never
 * switches against an unverifiable endpoint.
 */
export const probeFleetServer = async (server: FleetServer): Promise<HostProbeResult | null> => {
  const { apiBaseUrl, clientToken, requestHeaders, relay } = server.descriptor;
  if (relay) {
    return probeRelayDesktopHost(relay, { clientToken: clientToken || null, requestHeaders: requestHeaders || null });
  }
  if (!hasDesktopInvoke() || !apiBaseUrl) return null;
  return desktopHostProbe(apiBaseUrl, { clientToken: clientToken || null, requestHeaders: requestHeaders || null });
};
