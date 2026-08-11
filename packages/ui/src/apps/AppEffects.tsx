import React from 'react';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { usePwaManifestSync } from '@/hooks/usePwaManifestSync';
import { useQueuedMessageAutoSend } from '@/hooks/useQueuedMessageAutoSend';
import { useSessionAutoCleanup } from '@/hooks/useSessionAutoCleanup';
import { useWindowControlsOverlayLayout } from '@/hooks/useWindowControlsOverlayLayout';
import { setOptimisticRefs } from '@/sync/session-actions';
import { markSessionViewed } from '@/sync/notification-store';
import { setExternallyViewedSession } from '@/sync/sync-context';
import { useSessionUIStore } from '@/sync/session-ui-store';
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
  workspaceId?: string;
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
        markSessionViewed(data.sessionId, data.workspaceId ?? useSessionUIStore.getState().currentWorkspaceId);
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

// Hydrates the unified workspace catalog on boot. The catalog belongs to the
// LOCAL control plane and its client is pinned to it, so a runtime endpoint
// change (switching the active remote server) must NOT re-fetch or swap the
// catalog — "one local unified catalog" is the whole point. Reads only;
// mutations flow through the catalog store.
const WorkspaceCatalogBridge: React.FC = () => {
  React.useEffect(() => {
    void useWorkspaceCatalogStore.getState().refresh().catch(() => undefined);
  }, []);
  return null;
};

// Session Index bridge: hydrates the cross-connection lightweight session
// index, subscribes to the incremental event stream, and recovers from a
// revision gap by re-fetching the snapshot. One SSE connection serves the
// whole client; the server keeps at most one upstream stream per connection.
// Like the catalog, the session index lives on the LOCAL control plane and is
// pinned there, so runtime endpoint changes never re-fetch or swap it.
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
    return () => {
      stop();
    };
  }, []);
  return null;
};

/**
 * Bootstraps the control-plane-owned Catalog and Session Index for secondary
 * Electron surfaces. These stores are independent of the full SyncProvider,
 * so a workspace-targeted Mini Chat can resolve its handle before mounting
 * session sync without inheriting the ambient runtime.
 */
export const WorkspaceCatalogSessionIndexEffects: React.FC = () => (
  <>
    <WorkspaceCatalogBridge />
    <SessionIndexBridge />
  </>
);

export function SyncAppEffects({ embeddedBackgroundWorkEnabled, includeWorkspaceState = true }: {
  embeddedBackgroundWorkEnabled: boolean;
  /** Set false when the Catalog/Session Index bridges are mounted above a
   * workspace runtime gate so they can hydrate the handle before Sync mounts. */
  includeWorkspaceState?: boolean;
}) {
  usePwaManifestSync();
  useWindowControlsOverlayLayout();
  useKeyboardShortcuts();

  return (
    <>
      <SyncRuntimeEffects embeddedBackgroundWorkEnabled={embeddedBackgroundWorkEnabled} />
      <MiniChatPresenceBridge />
      <DesktopRuntimeSyncBridge />
      {includeWorkspaceState ? <WorkspaceCatalogSessionIndexEffects /> : null}
    </>
  );
}
