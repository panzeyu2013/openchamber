import type { RelayRuntimeDescriptor } from '@/lib/relay/runtime-tunnel';

export type FleetServerKind = 'local' | 'remote-url' | 'ssh' | 'relay';

export type FleetServerStatus = 'connected' | 'connecting' | 'degraded' | 'disconnected' | 'error';

/**
 * An endpoint that can become the single active OpenCode runtime.
 *
 * Credentials are deliberately in-memory only. Persistent host configuration
 * continues to be owned by the runtime-specific desktop/mobile host stores.
 */
export type FleetRuntimeDescriptor = {
  apiBaseUrl: string;
  runtimeKey: string;
  clientToken?: string;
  requestHeaders?: Record<string, string>;
  relay?: RelayRuntimeDescriptor;
};

export type FleetServer = {
  id: string;
  label: string;
  kind: FleetServerKind;
  descriptor: FleetRuntimeDescriptor;
  status: FleetServerStatus;
  errorMessage?: string;
  lastSuccessAt?: number;
};

export const fleetSessionKey = (serverId: string, sessionId: string): string => `${serverId}\u0000${sessionId}`;

export type FleetSessionActivity = 'idle' | 'busy' | 'retry' | 'error';

/** Deliberately narrow cross-runtime live state for sidebar observation. */
export type FleetLiveSessionState = {
  serverId: string;
  sessionId: string;
  activity: FleetSessionActivity;
  hasPendingPermission: boolean;
  hasPendingQuestion: boolean;
  updatedAt: number;
  stale: boolean;
};

/**
 * The only persisted-in-memory session shape Fleet is allowed to retain for a
 * non-active runtime. Full session/message data remains owned by Active Runtime
 * sync after the user opens that server.
 */
export type FleetSessionSummary = {
  serverId: string;
  sessionId: string;
  title: string;
  directory: string;
  updatedAt: number;
  archived: boolean;
};

export type FleetServerSummary = {
  serverId: string;
  sessions: Map<string, FleetSessionSummary>;
  complete: boolean;
  refreshedAt?: number;
  errorMessage?: string;
  /**
   * True when the summary fetch returned exactly the server's limit, so the
   * list may not cover every session. Never rendered as an exact count.
   */
  truncated?: boolean;
};
