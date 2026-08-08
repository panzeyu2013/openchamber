import { createOpencodeClient, type Session } from '@opencode-ai/sdk/v2';
import { createRelayTunnelClient, type RelayTunnelClient } from '@/lib/relay/tunnel-client';
import type { FleetRuntimeDescriptor, FleetSessionSummary } from './types';

const SUMMARY_LIMIT = 100;

// A stream that stayed up this long is healthy; shorter-lived connections
// count as failures so a connect/EOF loop keeps backing off instead of
// reconnecting at full frequency forever.
const HEALTHY_STREAM_MS = 30_000;

const describeError = (value: unknown): string => {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  return 'fleet summary request failed';
};

const toPath = (input: string | URL | Request): string => {
  const raw = input instanceof Request ? input.url : input.toString();
  if (raw.startsWith('/')) return raw;
  const url = new URL(raw);
  return `${url.pathname}${url.search}`;
};

// The OpenCode SDK owns paths below /api. Fleet descriptors intentionally hold
// the same runtime root used by runtime-switch, so derive the SDK base exactly
// as RuntimeUrlResolver.api('/api') does for the active runtime.
const getSdkBaseUrl = (descriptor: FleetRuntimeDescriptor): string => new URL('/api', `${descriptor.apiBaseUrl}/`).toString();

const createTransportFetch = (descriptor: FleetRuntimeDescriptor, tunnel: RelayTunnelClient | null, signal?: AbortSignal) => async (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const headers = new Headers(descriptor.requestHeaders);
  if (input instanceof Request) {
    input.headers.forEach((value, key) => headers.set(key, value));
  }
  if (init?.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  if (descriptor.clientToken) headers.set('Authorization', `Bearer ${descriptor.clientToken}`);
  const requestInit = { ...init, headers, signal: init?.signal ?? signal };
  if (tunnel) return tunnel.fetch(toPath(input), requestInit);
  return fetch(input, requestInit);
};

type SummaryResult = {
  sessions: FleetSessionSummary[];
  status: Record<string, unknown>;
  /**
   * True when the server returned exactly the summary limit, which means
   * sessions may exist beyond it. The API exposes no total, so callers must
   * never render an exact "N more" derived from the returned list length.
   */
  truncated: boolean;
};

export type FleetLiveEvent = {
  sessionId: string;
  activity?: 'idle' | 'busy' | 'retry' | 'error';
  hasPendingPermission?: boolean;
  hasPendingQuestion?: boolean;
  structural?: 'created' | 'updated' | 'deleted';
};

const readString = (value: unknown): string | null => typeof value === 'string' && value.length > 0 ? value : null;

export const parseFleetLiveEvent = (value: unknown): FleetLiveEvent | null => {
  const payload = value && typeof value === 'object' && 'payload' in value
    ? (value as { payload?: unknown }).payload
    : value;
  if (!payload || typeof payload !== 'object') return null;
  const event = payload as { type?: unknown; properties?: unknown };
  if (typeof event.type !== 'string' || !event.properties || typeof event.properties !== 'object') return null;
  const properties = event.properties as Record<string, unknown>;
  const info = properties.info && typeof properties.info === 'object' ? properties.info as Record<string, unknown> : null;
  const sessionId = readString(properties.sessionID) ?? readString(properties.sessionId) ?? readString(info?.id);
  if (!sessionId) return null;
  if (event.type === 'session.status') {
    const status = properties.status as { type?: unknown } | undefined;
    const type = status?.type;
    return { sessionId, activity: type === 'busy' || type === 'retry' ? type : 'idle' };
  }
  if (event.type === 'permission.asked') return { sessionId, hasPendingPermission: true };
  if (event.type === 'permission.replied') return { sessionId, hasPendingPermission: false };
  if (event.type === 'question.asked') return { sessionId, hasPendingQuestion: true };
  if (event.type === 'question.replied' || event.type === 'question.rejected') return { sessionId, hasPendingQuestion: false };
  if (event.type === 'session.created') return { sessionId, structural: 'created' };
  if (event.type === 'session.updated') return { sessionId, structural: 'updated' };
  if (event.type === 'session.deleted') return { sessionId, structural: 'deleted' };
  return null;
};

/** One reusable tunnel per Fleet server; never shares or replaces Active Runtime's tunnel. */
export class FleetSummaryTransport {
  private readonly tunnels = new Map<string, RelayTunnelClient>();

  private getTunnel(serverId: string, descriptor: FleetRuntimeDescriptor): RelayTunnelClient | null {
    if (!descriptor.relay) return null;
    const existing = this.tunnels.get(serverId);
    if (existing) return existing;
    const tunnel = createRelayTunnelClient(descriptor.relay);
    this.tunnels.set(serverId, tunnel);
    return tunnel;
  }

  async fetchServerSummary(serverId: string, descriptor: FleetRuntimeDescriptor, signal?: AbortSignal): Promise<SummaryResult> {
    const client = this.createClient(serverId, descriptor, signal);
    const [sessionsResult, statusResult] = await Promise.all([
      client.experimental.session.list({ archived: false, limit: SUMMARY_LIMIT }),
      client.session.status(),
    ]);
    if (sessionsResult.error) throw new Error(describeError(sessionsResult.error));
    if (statusResult.error) throw new Error(describeError(statusResult.error));
    if (!Array.isArray(sessionsResult.data) || !statusResult.data || typeof statusResult.data !== 'object') {
      throw new Error('fleet summary returned an invalid payload');
    }
    const sessions = (sessionsResult.data as Session[]).map((session) => ({
      serverId,
      sessionId: session.id,
      title: session.title || session.id,
      directory: session.directory,
      updatedAt: session.time.updated,
      archived: Boolean(session.time.archived),
    }));
    return { sessions, status: statusResult.data as Record<string, unknown>, truncated: sessions.length >= SUMMARY_LIMIT };
  }

  /**
   * A narrow SSE observer for an inactive server. It intentionally handles
   * only sidebar-liveness fields and never forwards message/part payloads into
   * Fleet memory. Reconnect pacing mirrors the background-friendly transport:
   * delay grows with consecutive failures (EOF counts as a failure) and only
   * a stream that stayed up long enough resets the backoff.
   */
  observeServer(
    serverId: string,
    descriptor: FleetRuntimeDescriptor,
    onEvent: (event: FleetLiveEvent) => void,
    onDisconnected: () => void,
  ): () => void {
    const abort = new AbortController();
    const client = this.createClient(serverId, descriptor, abort.signal);
    let consecutiveFailures = 0;
    const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    void (async () => {
      while (!abort.signal.aborted) {
        const acquiredAt = Date.now();
        try {
          const stream = await client.global.event({ signal: abort.signal });
          for await (const raw of stream.stream) {
            if (abort.signal.aborted) return;
            const event = parseFleetLiveEvent(raw);
            if (event) onEvent(event);
          }
          // A normal EOF is still a disconnect: the server closed the stream,
          // so liveness is stale and the next attempt must back off.
          if (abort.signal.aborted) return;
        } catch {
          if (abort.signal.aborted) return;
        }
        onDisconnected();
        // Only a genuinely healthy stream (long enough to outlive brief
        // churn) resets the backoff; short connect/EOF loops keep growing it.
        consecutiveFailures = Date.now() - acquiredAt >= HEALTHY_STREAM_MS ? 0 : consecutiveFailures + 1;
        const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
        const baseDelay = Math.min(1_000 * (2 ** consecutiveFailures), 60_000);
        await wait(hidden ? baseDelay : Math.min(baseDelay, 10_000));
      }
    })();
    return () => abort.abort();
  }

  removeServer(serverId: string): void {
    this.tunnels.get(serverId)?.close();
    this.tunnels.delete(serverId);
  }

  close(): void {
    for (const tunnel of this.tunnels.values()) tunnel.close();
    this.tunnels.clear();
  }

  private createClient(serverId: string, descriptor: FleetRuntimeDescriptor, signal?: AbortSignal) {
    return createOpencodeClient({
      baseUrl: getSdkBaseUrl(descriptor),
      fetch: createTransportFetch(descriptor, this.getTunnel(serverId, descriptor), signal),
    });
  }
}
