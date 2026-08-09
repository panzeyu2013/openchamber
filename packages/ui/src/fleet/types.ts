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

const stringRecordsEqual = (left?: Record<string, string>, right?: Record<string, string>): boolean => {
  if (left === right) return true;
  const leftEntries = Object.entries(left || {});
  if (leftEntries.length !== Object.keys(right || {}).length) return false;
  return leftEntries.every(([key, value]) => right?.[key] === value);
};

const jsonValuesEqual = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => jsonValuesEqual(value, right[index]));
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  return leftKeys.length === Object.keys(rightRecord).length
    && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(rightRecord, key) && jsonValuesEqual(leftRecord[key], rightRecord[key]));
};

export const fleetRuntimeDescriptorsEqual = (left: FleetRuntimeDescriptor, right: FleetRuntimeDescriptor): boolean => {
  if (left === right) return true;
  const leftRelay = left.relay;
  const rightRelay = right.relay;
  const relayEqual = leftRelay === rightRelay || Boolean(
    leftRelay
    && rightRelay
    && leftRelay.relayUrl === rightRelay.relayUrl
    && leftRelay.serverId === rightRelay.serverId
    && leftRelay.grant === rightRelay.grant
    && jsonValuesEqual(leftRelay.hostEncPubJwk, rightRelay.hostEncPubJwk),
  );
  return left.apiBaseUrl === right.apiBaseUrl
    && left.runtimeKey === right.runtimeKey
    && left.clientToken === right.clientToken
    && stringRecordsEqual(left.requestHeaders, right.requestHeaders)
    && relayEqual;
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
  activityUpdatedAt: number;
  pendingUpdatedAt: number;
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
  truncated: boolean;
  refreshedAt?: number;
  errorMessage?: string;
};
