import React from 'react';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { usePwaManifestSync } from '@/hooks/usePwaManifestSync';
import { useQueuedMessageAutoSend } from '@/hooks/useQueuedMessageAutoSend';
import { useSessionAutoCleanup } from '@/hooks/useSessionAutoCleanup';
import { useWindowControlsOverlayLayout } from '@/hooks/useWindowControlsOverlayLayout';
import { setOptimisticRefs } from '@/sync/session-actions';
import { markSessionViewed } from '@/sync/notification-store';
import { setExternallyViewedSession } from '@/sync/sync-context';
import { useSync } from '@/sync/use-sync';
import { loadDesktopFleetServers } from '@/fleet/desktop-registry';
import { useFleetLiveStore } from '@/fleet/fleet-live-store';
import { useFleetStore } from '@/fleet/fleet-store';
import { useFleetSummaryStore } from '@/fleet/fleet-summary-store';
import { FleetSummaryBridge } from '@/fleet/FleetSummaryBridge';
import { useDesktopSshStore } from '@/stores/useDesktopSshStore';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

const MINI_CHAT_PRESENCE_CHANNEL = 'openchamber:mini-chat-presence';

type MiniChatPresenceMessage = {
  type?: string;
  sessionId?: string;
  directory?: string;
  viewed?: boolean;
};

const SyncOptimisticBridge: React.FC = () => {
  const sync = useSync();
  const addRef = React.useRef(sync.optimistic.add);
  const removeRef = React.useRef(sync.optimistic.remove);
  const confirmRef = React.useRef(sync.optimistic.confirm);
  addRef.current = sync.optimistic.add;
  removeRef.current = sync.optimistic.remove;
  confirmRef.current = sync.optimistic.confirm;

  React.useEffect(() => {
    setOptimisticRefs(
      (input) => addRef.current(input),
      (input) => removeRef.current(input),
      (input) => confirmRef.current(input),
    );
  }, []);

  return null;
};

const MiniChatPresenceBridge: React.FC = () => {
  React.useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;

    const channel = new BroadcastChannel(MINI_CHAT_PRESENCE_CHANNEL);
    channel.onmessage = (event) => {
      const data = event.data as MiniChatPresenceMessage | null;
      if (data?.type !== 'mini-chat-session-presence' || !data.sessionId || !data.directory) {
        return;
      }

      const viewed = data.viewed !== false;
      setExternallyViewedSession(data.directory, data.sessionId, viewed);
      if (viewed) {
        markSessionViewed(data.sessionId);
      }
    };

    return () => channel.close();
  }, []);

  return null;
};

const FleetRegistryBridge: React.FC = () => {
  React.useEffect(() => {
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;

    const refresh = () => {
      void loadDesktopFleetServers().then((servers) => {
        if (cancelled) return;
        const fleet = useFleetStore.getState();
        const previous = fleet.servers;
        const nextIds = new Set(servers.map((server) => server.id));
        for (const [id] of previous) {
          if (!nextIds.has(id)) {
            useFleetSummaryStore.getState().removeServer(id);
            useFleetLiveStore.getState().removeServer(id);
          }
        }
        // Non-SSH rows carry poll-derived status (connected/degraded) owned by
        // FleetSummaryBridge; re-registration must not reset them to
        // disconnected every time an SSH status event re-runs this refresh.
        const merged = servers.map((server) => {
          const existing = previous.get(server.id);
          if (!existing || server.kind === 'ssh' || server.kind === 'local') return server;
          return {
            ...server,
            status: existing.status,
            errorMessage: existing.errorMessage,
            lastSuccessAt: existing.lastSuccessAt,
          };
        });
        fleet.replaceServers(merged);
        fleet.syncActiveServer();
      }).catch(() => {
        // Non-desktop runtimes have no host registry. The local runtime remains
        // the sole active server until a runtime owns an explicit registry.
      });
    };

    void useDesktopSshStore.getState().load().catch(() => undefined);
    refresh();
    const unsubscribeSsh = useDesktopSshStore.subscribe(() => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        refresh();
      }, 150);
    });
    const unsubscribeRuntime = subscribeRuntimeEndpointChanged(() => useFleetStore.getState().syncActiveServer());
    return () => {
      cancelled = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      unsubscribeSsh();
      unsubscribeRuntime();
    };
  }, []);
  return null;
};

export function SyncRuntimeEffects({ embeddedBackgroundWorkEnabled }: {
  embeddedBackgroundWorkEnabled: boolean;
}) {
  useSessionAutoCleanup(embeddedBackgroundWorkEnabled);
  useQueuedMessageAutoSend(embeddedBackgroundWorkEnabled);

  return <SyncOptimisticBridge />;
}

export function SyncAppEffects({ embeddedBackgroundWorkEnabled }: {
  embeddedBackgroundWorkEnabled: boolean;
}) {
  usePwaManifestSync();
  useWindowControlsOverlayLayout();
  useKeyboardShortcuts();

  return (
    <>
      <SyncRuntimeEffects embeddedBackgroundWorkEnabled={embeddedBackgroundWorkEnabled} />
      <MiniChatPresenceBridge />
      <FleetRegistryBridge />
      <FleetSummaryBridge />
    </>
  );
}
