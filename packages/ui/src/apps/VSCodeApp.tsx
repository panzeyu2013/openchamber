import React from 'react';
import { AgentManagerView } from '@/components/views/agent-manager';
import { FireworksProvider } from '@/contexts/FireworksContext';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { ConfigUpdateOverlay } from '@/components/ui/ConfigUpdateOverlay';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { OpenCodeUpdateToast } from '@/components/update/OpenCodeUpdateToast';
import { VSCodeLayout } from '@/components/layout/VSCodeLayout';
import { usePushVisibilityBeacon } from '@/hooks/usePushVisibilityBeacon';
import { useRouter } from '@/hooks/useRouter';
import { useWindowTitle } from '@/hooks/useWindowTitle';
import type { RuntimeAPIs } from '@/lib/api/types';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useI18n } from '@/lib/i18n';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { SyncProvider } from '@/sync/sync-context';
import { setControlPlaneOrigin } from '@/workspaces/control-plane-fetch';
import { WorkspaceRuntimeProvider } from '@/workspaces/WorkspaceRuntimeProvider';
import { useWorkspaceRuntime } from '@/workspaces/workspace-runtime-context';
import { WorkspaceCatalogSessionIndexEffects, SyncAppEffects } from './AppEffects';
import { useAppFontEffects } from './useAppFontEffects';
import type { WorkspaceDescriptor } from '@/workspaces/types';

type VSCodePanelType = 'chat' | 'agentManager';

declare global {
  interface Window {
    __OPENCHAMBER_PANEL_TYPE__?: VSCodePanelType;
  }
}

/**
 * VS Code workspace descriptor (structural mirror of the bridge payload in
 * `packages/vscode/webview/api/workspaces.ts`). The webview resolves it
 * through the extension bridge and passes it down; the UI never fabricates a
 * workspace identity from paths. States:
 * - `loading`: the bridge has not answered yet — render a loading state,
 *   never a fake scope.
 * - `available`: the current VS Code folder resolves to a catalog workspace —
 *   mount the workspace-scoped runtime + sync.
 * - `no_folder` / `capability_unavailable` / `not_found`: no workspace
 *   identity exists in this runtime — render the explicit unavailable state.
 */
export type VSCodeWorkspaceDescriptorResult =
  | { phase: 'loading' }
  | {
      phase: 'available';
      workspaceId: string;
      workspace: WorkspaceDescriptor;
      activePath: string;
    }
  | {
      phase: 'unavailable';
      code?: string;
      reason?: string;
    };

type VSCodeAppProps = {
  apis: RuntimeAPIs;
  /** Resolved by the webview through the extension bridge. `loading` means
   * the bridge has not answered yet. */
  workspaceDescriptor?: VSCodeWorkspaceDescriptorResult;
};

const VSCodeWorkspaceGate: React.FC = () => {
  const { t } = useI18n();
  return (
    <div className="flex h-full items-center justify-center bg-background px-4 text-center text-sm text-muted-foreground">
      {t('common.loading')}
    </div>
  );
};

const VSCodeWorkspaceUnavailable: React.FC<{ reason?: string }> = ({ reason }) => {
  const { t } = useI18n();
  return (
    <div className="flex h-full items-center justify-center bg-background px-4 text-center text-sm text-muted-foreground">
      <div>
        <p>{t('workspaces.sidebar.unavailable')}</p>
        {reason ? (
          <p className="mt-1 truncate text-xs text-muted-foreground/70" title={reason}>{reason}</p>
        ) : null}
      </div>
    </div>
  );
};

/**
 * Workspace-scoped sync mount for the VS Code webview. Follows the main app
 * pattern: the sync always runs against the bound workspace handle; a missing
 * handle renders the gate instead of falling back to an ambient scope.
 */
const VSCodeWorkspaceSyncMount: React.FC<{
  children: React.ReactNode;
}> = ({ children }) => {
  const { handle } = useWorkspaceRuntime();
  if (!handle) {
    return <VSCodeWorkspaceGate />;
  }
  return (
    <SyncProvider key={handle.workspaceId} workspaceHandle={handle}>
      {children}
    </SyncProvider>
  );
};

const VSCodeWorkspaceRuntime: React.FC<{
  apis: RuntimeAPIs;
  workspaceId: string;
  children: React.ReactNode;
}> = ({ apis, workspaceId, children }) => (
  <WorkspaceRuntimeProvider workspaceId={workspaceId}>
    <WorkspaceCatalogSessionIndexEffects />
    <VSCodeWorkspaceSyncMount>
      <RuntimeAPIProvider apis={apis}>
        {children}
      </RuntimeAPIProvider>
    </VSCodeWorkspaceSyncMount>
  </WorkspaceRuntimeProvider>
);

export function VSCodeApp({ apis, workspaceDescriptor = { phase: 'loading' } }: VSCodeAppProps) {
  const error = useSessionUIStore((state) => state.error);
  const clearError = useSessionUIStore((state) => state.clearError);
  const wideChatLayoutEnabled = useUIStore((state) => state.wideChatLayoutEnabled);
  const refreshGitHubAuthStatus = useGitHubAuthStore((state) => state.refreshStatus);
  const setPlanModeEnabled = useFeatureFlagsStore((state) => state.setPlanModeEnabled);
  const panelType = typeof window !== 'undefined'
    ? window.__OPENCHAMBER_PANEL_TYPE__ ?? 'chat'
    : 'chat';

  React.useEffect(() => {
    registerRuntimeAPIs(apis);
    return () => registerRuntimeAPIs(null);
  }, [apis]);

  // Pin the control-plane origin when the extension host resolved a
  // workspace descriptor from a configured control plane
  // (`openchamber.apiUrl`). Without this the workspace runtime registry's
  // pinned fetch would 501 on the webview origin.
  React.useEffect(() => {
    if (workspaceDescriptor.phase !== 'available') return;
    const configured = typeof window !== 'undefined'
      ? (window as unknown as { __VSCODE_CONFIG__?: { apiUrl?: string } }).__VSCODE_CONFIG__?.apiUrl?.trim()
      : '';
    if (configured) {
      setControlPlaneOrigin(configured);
    }
  }, [workspaceDescriptor]);

  useAppFontEffects();
  usePushVisibilityBeacon({ enabled: true });
  useWindowTitle();
  useRouter();

  React.useEffect(() => {
    document.documentElement.classList.toggle('wide-chat-layout', wideChatLayoutEnabled);
    return () => {
      document.documentElement.classList.remove('wide-chat-layout');
    };
  }, [wideChatLayoutEnabled]);

  React.useEffect(() => {
    void refreshGitHubAuthStatus(apis.github, { force: true });
  }, [apis.github, refreshGitHubAuthStatus]);

  React.useEffect(() => {
    let cancelled = false;

    const run = async () => {
      const res = await runtimeFetch('/health', { method: 'GET' }).catch(() => null);
      if (!res || !res.ok || cancelled) return;
      const data = (await res.json().catch(() => null)) as null | {
        planModeExperimentalEnabled?: unknown;
      };
      if (!data || cancelled) return;
      const raw = data.planModeExperimentalEnabled;
      const enabled = raw === true || raw === 1 || raw === '1' || raw === 'true';
      setPlanModeEnabled(enabled);
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [setPlanModeEnabled]);

  React.useEffect(() => {
    if (!error) {
      return;
    }

    const timeout = window.setTimeout(() => clearError(), 5000);
    return () => window.clearTimeout(timeout);
  }, [clearError, error]);

  if (workspaceDescriptor.phase === 'loading') {
    return (
      <ErrorBoundary>
        <VSCodeWorkspaceGate />
      </ErrorBoundary>
    );
  }

  if (workspaceDescriptor.phase !== 'available') {
    return (
      <ErrorBoundary>
        <VSCodeWorkspaceUnavailable reason={workspaceDescriptor.reason} />
      </ErrorBoundary>
    );
  }

  const { workspaceId } = workspaceDescriptor;

  if (panelType === 'agentManager') {
    return (
      <ErrorBoundary>
        <VSCodeWorkspaceRuntime apis={apis} workspaceId={workspaceId}>
          <TooltipProvider delayDuration={300} skipDelayDuration={150}>
            <div className="h-full text-foreground bg-background">
              <SyncAppEffects embeddedBackgroundWorkEnabled={true} />
              <AgentManagerView />
              <OpenCodeUpdateToast />
              <Toaster position="top-center" />
            </div>
          </TooltipProvider>
        </VSCodeWorkspaceRuntime>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <VSCodeWorkspaceRuntime apis={apis} workspaceId={workspaceId}>
        <FireworksProvider>
          <TooltipProvider delayDuration={300} skipDelayDuration={150}>
            <div className="h-full text-foreground bg-background">
              <SyncAppEffects embeddedBackgroundWorkEnabled={true} />
              <VSCodeLayout />
              <OpenCodeUpdateToast />
              <Toaster position="top-center" />
              <ConfigUpdateOverlay />
            </div>
          </TooltipProvider>
        </FireworksProvider>
      </VSCodeWorkspaceRuntime>
    </ErrorBoundary>
  );
}
