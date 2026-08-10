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
import { useWorkspaceCatalogStore } from '@/workspaces/catalog-store';
import { useWorkspaceSessionIndexStore } from '@/workspaces/session-index-store';
import { openWorkspaceSessionEventStream } from '@/workspaces/session-index-client';
import { getRuntimeApiBaseUrl, getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { canUseElectronDesktopIPC, invokeDesktop } from '@/lib/desktop';
import { getRuntimeBearerTokenSync, getRuntimeExtraHeadersSync } from '@/lib/runtime-auth';

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

export function SyncRuntimeEffects({ embeddedBackgroundWorkEnabled }: {
  embeddedBackgroundWorkEnabled: boolean;
}) {
  useSessionAutoCleanup(embeddedBackgroundWorkEnabled);
  useQueuedMessageAutoSend(embeddedBackgroundWorkEnabled);

  return <SyncOptimisticBridge />;
}

// Keeps the main process's per-window runtime config in sync with the
// renderer's Active Runtime. switchRuntimeEndpoint only updates renderer-side
// state; the main process needs the live runtimeKey to route tray clicks to a
// window serving the SAME runtime. Gated to the desktop shell; the command
// itself is local-sender-only in main.mjs.
const DesktopRuntimeSyncBridge: React.FC = () => {
  React.useEffect(() => {
    if (!canUseElectronDesktopIPC()) return;

    const push = () => {
      void invokeDesktop('desktop_set_runtime_config', {
        apiBaseUrl: getRuntimeApiBaseUrl(),
        runtimeKey: getRuntimeKey(),
        clientToken: getRuntimeBearerTokenSync(),
        requestHeaders: getRuntimeExtraHeadersSync(),
      }).catch(() => {});
    };

    push();
    const unsubscribe = subscribeRuntimeEndpointChanged(push);
    return unsubscribe;
  }, []);

  return null;
};

// Hydrates the unified workspace catalog on boot and re-hydrates after a
// runtime endpoint change (the catalog always belongs to the CURRENT control
// plane). Reads only; mutations flow through the catalog store.
const WorkspaceCatalogBridge: React.FC = () => {
  React.useEffect(() => {
    void useWorkspaceCatalogStore.getState().refresh().catch(() => undefined);
    return subscribeRuntimeEndpointChanged(() => {
      void useWorkspaceCatalogStore.getState().refresh().catch(() => undefined);
    });
  }, []);
  return null;
};

// Session Index bridge: hydrates the cross-connection lightweight session
// index, subscribes to the incremental event stream, and recovers from a
// revision gap by re-fetching the snapshot. One SSE connection serves the
// whole client; the server keeps at most one upstream stream per connection.
const SessionIndexBridge: React.FC = () => {
  React.useEffect(() => {
    const store = useWorkspaceSessionIndexStore.getState();
    void store.refresh().catch(() => undefined);
    const stop = openWorkspaceSessionEventStream((event) => {
      useWorkspaceSessionIndexStore.getState().applyEvent(event);
      if (useWorkspaceSessionIndexStore.getState().consumeRevisionGap()) {
        void useWorkspaceSessionIndexStore.getState().refresh().catch(() => undefined);
      }
    }, new AbortController().signal);
    const unsubscribe = subscribeRuntimeEndpointChanged(() => {
      void useWorkspaceSessionIndexStore.getState().refresh().catch(() => undefined);
    });
    return () => {
      stop();
      unsubscribe();
    };
  }, []);
  return null;
};

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
      <DesktopRuntimeSyncBridge />
      <WorkspaceCatalogBridge />
      <SessionIndexBridge />
    </>
  );
}
