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
import { setControlPlaneOrigin } from '@/projects/control-plane-fetch';
import { ProjectRuntimeProvider } from '@/projects/ProjectRuntimeProvider';
import { useProjectRuntime } from '@/projects/project-runtime-context';
import { ProjectCatalogSessionIndexEffects, SyncAppEffects } from './AppEffects';
import { useAppFontEffects } from './useAppFontEffects';
import type { ProjectDescriptor } from '@/projects/types';

type VSCodePanelType = 'chat' | 'agentManager';

declare global {
  interface Window {
    __OPENCHAMBER_PANEL_TYPE__?: VSCodePanelType;
  }
}

/**
 * VS Code project descriptor (structural mirror of the bridge payload in
 * `packages/vscode/webview/api/projects.ts`). The webview resolves it
 * through the extension bridge and passes it down; the UI never fabricates a
 * project identity from paths. States:
 * - `loading`: the bridge has not answered yet — render a loading state,
 *   never a fake scope.
 * - `available`: the current VS Code folder resolves to a catalog project —
 *   mount the project-scoped runtime + sync.
 * - `no_folder` / `capability_unavailable` / `not_found`: no project
 *   identity exists in this runtime — render the explicit unavailable state.
 */
export type VSCodeProjectDescriptorResult =
  | { phase: 'loading' }
  | {
      phase: 'available';
      projectId: string;
      project: ProjectDescriptor;
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
  projectDescriptor?: VSCodeProjectDescriptorResult;
};

const VSCodeProjectGate: React.FC = () => {
  const { t } = useI18n();
  return (
    <div className="flex h-full items-center justify-center bg-background px-4 text-center text-sm text-muted-foreground">
      {t('common.loading')}
    </div>
  );
};

const VSCodeProjectUnavailable: React.FC<{ reason?: string }> = ({ reason }) => {
  const { t } = useI18n();
  return (
    <div className="flex h-full items-center justify-center bg-background px-4 text-center text-sm text-muted-foreground">
      <div>
        <p>{t('projects.sidebar.unavailable')}</p>
        {reason ? (
          <p className="mt-1 truncate text-xs text-muted-foreground/70" title={reason}>{reason}</p>
        ) : null}
      </div>
    </div>
  );
};

/**
 * Project-scoped sync mount for the VS Code webview. Follows the main app
 * pattern: the sync always runs against the bound project handle; a missing
 * handle renders the gate instead of falling back to an ambient scope.
 */
const VSCodeProjectSyncMount: React.FC<{
  children: React.ReactNode;
}> = ({ children }) => {
  const { handle } = useProjectRuntime();
  if (!handle) {
    return <VSCodeProjectGate />;
  }
  return (
    <SyncProvider key={handle.projectId} projectHandle={handle}>
      {children}
    </SyncProvider>
  );
};

const VSCodeProjectRuntime: React.FC<{
  apis: RuntimeAPIs;
  projectId: string;
  children: React.ReactNode;
}> = ({ apis, projectId, children }) => (
  <ProjectRuntimeProvider projectId={projectId}>
    <ProjectCatalogSessionIndexEffects />
    <VSCodeProjectSyncMount>
      <RuntimeAPIProvider apis={apis}>
        {children}
      </RuntimeAPIProvider>
    </VSCodeProjectSyncMount>
  </ProjectRuntimeProvider>
);

export function VSCodeApp({ apis, projectDescriptor = { phase: 'loading' } }: VSCodeAppProps) {
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
  // project descriptor from a configured control plane
  // (`openchamber.apiUrl`). Without this the project runtime registry's
  // pinned fetch would 501 on the webview origin.
  React.useEffect(() => {
    if (projectDescriptor.phase !== 'available') return;
    const configured = typeof window !== 'undefined'
      ? (window as unknown as { __VSCODE_CONFIG__?: { apiUrl?: string } }).__VSCODE_CONFIG__?.apiUrl?.trim()
      : '';
    if (configured) {
      setControlPlaneOrigin(configured);
    }
  }, [projectDescriptor]);

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

  if (projectDescriptor.phase === 'loading') {
    return (
      <ErrorBoundary>
        <VSCodeProjectGate />
      </ErrorBoundary>
    );
  }

  if (projectDescriptor.phase !== 'available') {
    return (
      <ErrorBoundary>
        <VSCodeProjectUnavailable reason={projectDescriptor.reason} />
      </ErrorBoundary>
    );
  }

  const { projectId } = projectDescriptor;

  if (panelType === 'agentManager') {
    return (
      <ErrorBoundary>
        <VSCodeProjectRuntime apis={apis} projectId={projectId}>
          <TooltipProvider delayDuration={300} skipDelayDuration={150}>
            <div className="h-full text-foreground bg-background">
              <SyncAppEffects embeddedBackgroundWorkEnabled={true} />
              <AgentManagerView />
              <OpenCodeUpdateToast />
              <Toaster position="top-center" />
            </div>
          </TooltipProvider>
        </VSCodeProjectRuntime>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <VSCodeProjectRuntime apis={apis} projectId={projectId}>
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
      </VSCodeProjectRuntime>
    </ErrorBoundary>
  );
}
