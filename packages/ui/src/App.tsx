import React from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import { ChatView } from '@/components/views/ChatView';
import { FireworksProvider } from '@/contexts/FireworksContext';
import { Toaster } from '@/components/ui/sonner';
import { Button } from '@/components/ui/button';
import { MemoryDebugPanel } from '@/components/ui/MemoryDebugPanel';
import { setStreamPerfEnabled } from '@/stores/utils/streamDebug';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
// useEventStream removed — replaced by SyncProvider + SyncBridge
import { useMenuActions } from '@/hooks/useMenuActions';
import { useSessionStatusBootstrap } from '@/hooks/useSessionStatusBootstrap';
import { useTraySync } from '@/hooks/useTraySync';
import { useRouter } from '@/hooks/useRouter';
import { usePushVisibilityBeacon } from '@/hooks/usePushVisibilityBeacon';
import { useWebNotificationStream } from '@/hooks/useWebNotificationStream';
import { usePwaInstallPrompt } from '@/hooks/usePwaInstallPrompt';
import { useWindowTitle } from '@/hooks/useWindowTitle';
import { useConfigStore } from '@/stores/useConfigStore';
import { hasModifier } from '@/lib/utils';
import { getDesktopRuntimeEndpointArgs, isDesktopLocalOriginActive, isDesktopShell, restartDesktopApp, invokeDesktop } from '@/lib/desktop';
import {
  getInjectedBootOutcome,
  getBootInjectionStatus,
  resolveDesktopBootView,
  canDismissInitialLoading,
  shouldRestartDesktopBootFlow,
  type BootInjectionStatus,
  type DesktopBootView,
} from '@/lib/desktopBoot';
import type { RecoveryVariant } from '@/components/onboarding/DesktopConnectionRecovery';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { markSessionViewed } from '@/sync/notification-store';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { normalizePath } from '@/lib/pathNormalization';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { opencodeClient } from '@/lib/opencode/client';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getControlPlaneKey, subscribeControlPlaneChanged } from '@/lib/control-plane';
import { useAutoReviewStore } from '@/stores/useAutoReviewStore';
import { resumeAutoReviewRun } from '@/lib/reviewFlow';
import { SyncProvider, useSyncDirectory } from '@/sync/sync-context';
import { useSync } from '@/sync/use-sync';
import { ProjectRuntimeGate, ProjectRuntimeProvider } from '@/projects/ProjectRuntimeProvider';
import { useProjectRuntime } from '@/projects/project-runtime-context';
import { useActiveProjectId } from '@/projects/useActiveProject';
import { ProjectSessionsSection } from '@/components/session/sidebar/ProjectSessionsSection';
import { ConfigUpdateOverlay } from '@/components/ui/ConfigUpdateOverlay';
import { AboutDialog } from '@/components/ui/AboutDialog';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { isProjectRuntimeActive, registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useUIStore } from '@/stores/useUIStore';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';
import type { RuntimeAPIs } from '@/lib/api/types';
import { TooltipProvider } from '@/components/ui/tooltip';
import { McpOAuthCallbackPage } from '@/components/sections/mcp/McpOAuthCallbackPage';
import { MCP_OAUTH_CALLBACK_PATH } from '@/components/sections/mcp/mcpOAuth';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { useI18n } from '@/lib/i18n';
import { applyMobileKeyboardMode } from '@/lib/mobileKeyboardMode';
import { isEmbeddedSessionChat } from '@/components/layout/contextPanelEmbeddedChat';
import { SyncAppEffects, ProjectCatalogSessionIndexEffects } from '@/apps/AppEffects';
import { useProjectCatalogStore } from '@/projects/catalog-store';
import { useProjectSessionIndexStore } from '@/projects/session-index-store';
import { useAppFontEffects } from '@/apps/useAppFontEffects';
import { OpenCodeUpdateToast } from '@/components/update/OpenCodeUpdateToast';
import { markStartupTrace, startupTraceEnabled } from '@/lib/startupTrace';

// Lazy-loaded heavy views — loaded on demand to reduce initial bundle size.
const OnboardingScreen = lazyWithChunkRecovery(() =>
  import('@/components/onboarding/OnboardingScreen').then((m) => ({ default: m.OnboardingScreen })),
);

const AboutDialogWrapper: React.FC = () => {
  const isAboutDialogOpen = useUIStore((s) => s.isAboutDialogOpen);
  const setAboutDialogOpen = useUIStore((s) => s.setAboutDialogOpen);
  return (
    <AboutDialog
      open={isAboutDialogOpen}
      onOpenChange={setAboutDialogOpen}
    />
  );
};

const StartupInitializationRecovery: React.FC<{
  onRetry: () => void;
  isRetrying: boolean;
}> = ({ onRetry, isRetrying }) => {
  const { t } = useI18n();

  return (
    <div className="flex h-full items-center justify-center bg-background px-6 text-foreground">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <div className="flex flex-col gap-2">
          <h1 className="typography-title text-foreground">{t('startup.initRecovery.title')}</h1>
          <p className="typography-body text-muted-foreground">{t('startup.initRecovery.description')}</p>
        </div>
        <Button type="button" onClick={onRetry} disabled={isRetrying}>
          {isRetrying ? t('startup.initRecovery.retrying') : t('startup.initRecovery.retry')}
        </Button>
      </div>
    </div>
  );
};

type AppProps = {
  apis: RuntimeAPIs;
};

type EmbeddedSessionChatConfig = {
  sessionId: string;
  directory: string | null;
  projectId: string | null;
  readOnly: boolean;
};

type EmbeddedVisibilityPayload = {
  visible?: unknown;
};

const normalizeEmbeddedDirectory = (value: string | null | undefined): string => {
  if (!value) return '';
  return value.replace(/\\/g, '/').replace(/\/+$/g, '');
};

const readEmbeddedSessionChatConfig = (): EmbeddedSessionChatConfig | null => {
  if (typeof window === 'undefined' || !isEmbeddedSessionChat()) {
    return null;
  }

  const params = new URLSearchParams(window.location.search);
  const sessionIdRaw = params.get('sessionId');
  const sessionId = typeof sessionIdRaw === 'string' ? sessionIdRaw.trim() : '';
  if (!sessionId) {
    return null;
  }

  const directoryRaw = params.get('directory');
  const directory = typeof directoryRaw === 'string' && directoryRaw.trim().length > 0
    ? directoryRaw.trim()
    : null;
  const projectRaw = params.get('project');
  const projectId = typeof projectRaw === 'string' && projectRaw.trim().length > 0
    ? projectRaw.trim()
    : null;

  return {
    sessionId,
    directory,
    projectId,
    readOnly: params.get('readOnly') === '1' || params.get('readOnly') === 'true',
  };
};

const isMcpOAuthCallbackPath = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.location.pathname === MCP_OAUTH_CALLBACK_PATH;
};

const EmbeddedSessionChatContent: React.FC<{
  embeddedSessionChat: EmbeddedSessionChatConfig;
  isVSCodeRuntime: boolean;
  embeddedBackgroundWorkEnabled: boolean;
}> = ({ embeddedSessionChat, isVSCodeRuntime, embeddedBackgroundWorkEnabled }) => {
  const syncDirectory = useSyncDirectory();
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const sync = useSync();
  const bootstrapKeyRef = React.useRef<string | null>(null);

  const expectedDirectory = normalizeEmbeddedDirectory(embeddedSessionChat.directory);
  const activeDirectory = normalizeEmbeddedDirectory(syncDirectory);

  React.useEffect(() => {
    if (isVSCodeRuntime) return;
    if (expectedDirectory && activeDirectory !== expectedDirectory) return;

    const bootstrapKey = `${embeddedSessionChat.projectId ?? ''}\n${expectedDirectory}\n${embeddedSessionChat.sessionId}`;
    // Skip if this session was already bootstrapped and a session is still
    // active — allows in-place navigation (e.g. "Open subtask") to change
    // currentSessionId without this effect forcing it back. Only re-bootstrap
    // when currentSessionId was cleared (store init, draft, delete/archive,
    // control-plane-change remount).
    if (bootstrapKeyRef.current === bootstrapKey && currentSessionId) {
      return;
    }

    bootstrapKeyRef.current = bootstrapKey;
    setCurrentSession(embeddedSessionChat.sessionId, embeddedSessionChat.directory, embeddedSessionChat.projectId);
    void sync.ensureSessionRenderable(embeddedSessionChat.sessionId, true);
  }, [
    activeDirectory,
    currentSessionId,
    embeddedSessionChat.directory,
    embeddedSessionChat.sessionId,
    embeddedSessionChat.projectId,
    expectedDirectory,
    isVSCodeRuntime,
    setCurrentSession,
    sync,
  ]);

  if (expectedDirectory && activeDirectory !== expectedDirectory) {
    return null;
  }

  return (
    <>
      <SyncAppEffects
        embeddedBackgroundWorkEnabled={embeddedBackgroundWorkEnabled}
        includeProjectState={!embeddedSessionChat.projectId}
      />
      <OpenCodeUpdateToast />
      <ChatView readOnly={embeddedSessionChat.readOnly} />
      <Toaster />
    </>
  );
};

const EmbeddedSessionChatRuntime: React.FC<{
  embeddedSessionChat: EmbeddedSessionChatConfig;
  isVSCodeRuntime: boolean;
  embeddedBackgroundWorkEnabled: boolean;
  runtimeEndpointEpoch: number;
  apis: RuntimeAPIs;
}> = ({ embeddedSessionChat, isVSCodeRuntime, embeddedBackgroundWorkEnabled, runtimeEndpointEpoch, apis }) => {
  const { handle } = useProjectRuntime();
  const projectId = embeddedSessionChat.projectId;

  if (projectId && !handle) {
    return <ProjectRuntimeGate />;
  }
  if (!handle) {
    // No project identity for this embedded frame: there is no ambient
    // sync to fall back to, so render the explicit unavailable state.
    return <ProjectRuntimeGate />;
  }

  return (
    <SyncProvider
      key={`${runtimeEndpointEpoch}:${projectId ?? ''}`}
      projectHandle={handle}
    >
      <RuntimeAPIProvider apis={apis}>
        <TooltipProvider delayDuration={300} skipDelayDuration={150}>
          <div className="h-full text-foreground bg-background">
            <EmbeddedSessionChatContent
              embeddedSessionChat={embeddedSessionChat}
              isVSCodeRuntime={isVSCodeRuntime}
              embeddedBackgroundWorkEnabled={embeddedBackgroundWorkEnabled}
            />
          </div>
        </TooltipProvider>
      </RuntimeAPIProvider>
    </SyncProvider>
  );
};

// Full-sync mount for the CURRENT project: when a project session is
// selected, the sync runs against the project-bound runtime handle (SDK on
// the control-plane project prefix + project directory) and the tree is
// keyed by projectId, so switching projects remounts the sync WITHOUT a
// global runtime switch and without touching other projects' state. With no
// project selected the sync surface shows the project selection gate: the
// unified sidebar is index-driven and needs no ambient sync.
const ProjectSyncGate: React.FC = () => {
  const { t } = useI18n();
  const catalogStatus = useProjectCatalogStore((state) => state.status);
  const catalogSnapshot = useProjectCatalogStore((state) => state.snapshot);
  if (catalogStatus === 'idle' || catalogStatus === 'loading' || !catalogSnapshot) {
    return (
      <div className="flex h-full items-center justify-center bg-background px-4 text-center text-sm text-muted-foreground">
        {t('common.loading')}
      </div>
    );
  }
  return (
    <div className="flex h-full items-start justify-center overflow-y-auto bg-background px-4 pt-16">
      <div className="w-full max-w-md">
        <ProjectSessionsSection />
      </div>
    </div>
  );
};

const ProjectSyncMount: React.FC<{
  runtimeEndpointEpoch: number;
  children: React.ReactNode;
}> = ({ runtimeEndpointEpoch, children }) => {
  const { handle } = useProjectRuntime();
  if (!handle) {
    return <ProjectSyncGate />;
  }
  return (
    <SyncProvider
      key={`${runtimeEndpointEpoch}:${handle.projectId}`}
      projectHandle={handle}
    >
      {children}
    </SyncProvider>
  );
};

function App({ apis }: AppProps) {
  React.useEffect(() => {
    markStartupTrace('App:mounted');
    if (startupTraceEnabled()) {
      console.info('[startup-trace] enabled. Run console.table(window.__OPENCHAMBER_STARTUP_TRACE__) after startup.');
    }
  }, []);

  const initializeApp = useConfigStore((s) => s.initializeApp);
  const isInitialized = useConfigStore((s) => s.isInitialized);
  const isConnected = useConfigStore((s) => s.isConnected);
  const providersCount = useConfigStore((state) => state.providers.length);
  const agentsCount = useConfigStore((state) => state.agents.length);
  const loadProviders = useConfigStore((state) => state.loadProviders);
  const loadAgents = useConfigStore((state) => state.loadAgents);
  const error = useSessionUIStore((s) => s.error);
  const clearError = useSessionUIStore((s) => s.clearError);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const setDirectory = useDirectoryStore((state) => state.setDirectory);
  const isSwitchingDirectory = useDirectoryStore((state) => state.isSwitchingDirectory);
  const activeProjectId = useActiveProjectId();
  const [showMemoryDebug, setShowMemoryDebug] = React.useState(false);
  const refreshGitHubAuthStatus = useGitHubAuthStore((state) => state.refreshStatus);
  const [isVSCodeRuntime, setIsVSCodeRuntime] = React.useState<boolean>(() => apis.runtime.isVSCode);
  const [isEmbeddedVisible, setIsEmbeddedVisible] = React.useState(true);
  const [initRetryExhausted, setInitRetryExhausted] = React.useState(false);
  const [initRetryEpoch, setInitRetryEpoch] = React.useState(0);
  const [runtimeEndpointEpoch, setRuntimeEndpointEpoch] = React.useState(0);
  const [manualInitRetrying, setManualInitRetrying] = React.useState(false);
  const wideChatLayoutEnabled = useUIStore((state) => state.wideChatLayoutEnabled);
  const mobileKeyboardMode = useUIStore((state) => state.mobileKeyboardMode);
  const isDesktopRuntime = React.useMemo(() => isDesktopShell(), []);
  // Desktop cold start: no session is selected yet, so useActiveProjectId()
  // is null and ProjectSyncMount would strand the app on the project
  // selection gate. Auto-select the local project matching the restored
  // directory (falling back to the first local project) so the main layout
  // mounts and the composer's auto-draft opens — the pre-project-refactor
  // launch experience. An explicit selection (current session / draft) always
  // wins because useActiveProjectId() is non-null then.
  const appCatalogSnapshot = useProjectCatalogStore((state) => state.snapshot);
  const desktopDefaultProjectId = React.useMemo(() => {
    if (activeProjectId || !isDesktopRuntime || !appCatalogSnapshot) {
      return null;
    }
    const localProjects = appCatalogSnapshot.projects.filter((project) => project.connectionId === 'local');
    if (localProjects.length === 0) {
      return null;
    }
    const normalizedDirectory = normalizePath(currentDirectory);
    if (normalizedDirectory) {
      const match = localProjects.find(
        (project) => normalizePath(project.canonicalPath) === normalizedDirectory,
      );
      if (match) return match.id;
    }
    return localProjects[0].id;
  }, [activeProjectId, appCatalogSnapshot, currentDirectory, isDesktopRuntime]);
  const resolvedProjectId = activeProjectId ?? desktopDefaultProjectId;
  const setPlanModeEnabled = useFeatureFlagsStore((state) => state.setPlanModeEnabled);
  const [bootInjectionStatus, setBootInjectionStatus] = React.useState<BootInjectionStatus>(() => {
    return getBootInjectionStatus();
  });
  const [bootView, setBootView] = React.useState<DesktopBootView | null>(() => {
    const outcome = getInjectedBootOutcome();
    return outcome !== null
      ? resolveDesktopBootView({ isDesktopShell: true, bootOutcome: outcome })
      : null;
  });
  const appReadyDispatchedRef = React.useRef(false);
  const embeddedSessionChat = React.useMemo<EmbeddedSessionChatConfig | null>(() => readEmbeddedSessionChatConfig(), []);
  const embeddedBackgroundWorkEnabled = !embeddedSessionChat || isEmbeddedVisible;
  const isMcpOAuthCallback = React.useMemo(() => isMcpOAuthCallbackPath(), []);

  React.useEffect(() => {
    setStreamPerfEnabled(showMemoryDebug);
    return () => {
      setStreamPerfEnabled(false);
    };
  }, [showMemoryDebug]);

  React.useEffect(() => {
    applyMobileKeyboardMode(mobileKeyboardMode);
  }, [mobileKeyboardMode]);

  React.useEffect(() => {
    setIsVSCodeRuntime(apis.runtime.isVSCode);
  }, [apis.runtime.isVSCode]);

  React.useEffect(() => {
    return subscribeControlPlaneChanged(() => {
      // Project sessions are bound to the pinned control plane and their
      // handle does not follow the legacy active-runtime endpoint. A Host
      // Switcher event must therefore not reset/remount the project sync
      // while a composite project/session target is active. Mobile's
      // explicit connection/disconnect path owns its separate reset semantics.
      if (activeProjectId || embeddedSessionChat?.projectId) {
        return;
      }
      // Narrow control-plane bootstrap: re-fetch the control-plane-owned
      // catalog + session index through the existing store refresh paths.
      // Project-scoped session stores are NEVER cleared — a failed refresh
      // keeps the prior snapshot (the stores signal failure, not empty success).
      void useProjectCatalogStore.getState().refresh().catch(() => undefined);
      void useProjectSessionIndexStore.getState().refresh().catch(() => undefined);
      setRuntimeEndpointEpoch((epoch) => epoch + 1);
      setInitRetryExhausted(false);
      setInitRetryEpoch((epoch) => epoch + 1);
    });
  }, [activeProjectId, embeddedSessionChat?.projectId]);

  const autoReviewResumeSignature = useAutoReviewStore((state) => {
    const runtimeKey = getControlPlaneKey();
    return Object.values(state.runsByOriginalSessionID)
      .filter((run) => run.status === 'running' && run.runtimeKey === runtimeKey)
      .map((run) => `${run.originalSessionID}:${run.phase}:${run.lastForwardedMessageID ?? ''}:${run.expectedAssistantParentID ?? ''}`)
      .sort()
      .join('|');
  });

  React.useEffect(() => {
    if (embeddedSessionChat) {
      return;
    }

    const runtimeKey = getControlPlaneKey();
    const runs = Object.values(useAutoReviewStore.getState().runsByOriginalSessionID)
      .filter((run) => run.status === 'running' && run.runtimeKey === runtimeKey);
    for (const run of runs) {
      resumeAutoReviewRun(run.originalSessionID);
    }
  }, [autoReviewResumeSignature, embeddedSessionChat, runtimeEndpointEpoch]);

  React.useEffect(() => {
    document.documentElement.classList.toggle('wide-chat-layout', wideChatLayoutEnabled);
    return () => {
      document.documentElement.classList.remove('wide-chat-layout');
    };
  }, [wideChatLayoutEnabled]);

  React.useEffect(() => {
    registerRuntimeAPIs(apis);
    return () => registerRuntimeAPIs(null);
  }, [apis]);

  React.useEffect(() => {
    if (embeddedSessionChat) {
      return;
    }

    void refreshGitHubAuthStatus(apis.github, { force: true });
  }, [apis.github, embeddedSessionChat, refreshGitHubAuthStatus]);

  useAppFontEffects();

  const bootOutcomeKnown = bootInjectionStatus === 'valid';
  const bootViewIsMain = bootView?.screen === 'main';

  // Splash dismissal: use the authoritative loading gate from desktopBoot.
  // Desktop shells strictly require a valid boot outcome before dismissing.
  // Non-main outcomes (chooser/recovery) can dismiss without waiting for init.
  React.useEffect(() => {
    if (!canDismissInitialLoading({
      isDesktopShell: isDesktopRuntime,
      isInitialized,
      bootOutcomeKnown,
      bootViewIsMain,
    })) {
      return;
    }

    const timer = setTimeout(() => {
      const loadingElement = document.getElementById('initial-loading');
      if (loadingElement) {
        loadingElement.classList.add('fade-out');
        setTimeout(() => {
          loadingElement.remove();
        }, 300);
      }
    }, 150);

    return () => clearTimeout(timer);
  }, [isDesktopRuntime, isInitialized, bootOutcomeKnown, bootViewIsMain]);

  // Deterministic malformed handling: update splash text so the user
  // sees a specific error instead of a generic spinner, but do NOT
  // dismiss the splash (that only happens on a valid outcome).
  React.useEffect(() => {
    if (!isDesktopRuntime || bootInjectionStatus !== 'malformed') {
      return;
    }

    const loadingElement = document.getElementById('initial-loading');
    if (loadingElement) {
      loadingElement.textContent = 'Desktop startup failed — please restart the app.';
    }
  }, [isDesktopRuntime, bootInjectionStatus]);

  // Non-desktop fallback: remove splash after 5 seconds even if init stalls.
  React.useEffect(() => {
    if (isDesktopRuntime) {
      return;
    }

    const fallbackTimer = setTimeout(() => {
      const loadingElement = document.getElementById('initial-loading');
      if (loadingElement && !isInitialized) {
        loadingElement.classList.add('fade-out');
        setTimeout(() => {
          loadingElement.remove();
        }, 300);
      }
    }, 5000);

    return () => clearTimeout(fallbackTimer);
  }, [isDesktopRuntime, isInitialized]);

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
    // VS Code runtime bootstraps config + sessions after the managed OpenCode instance reports "connected".
    // Doing the default initialization here can race with startup and lead to one-shot failures.
    if (isVSCodeRuntime) {
      return;
    }
    void initializeApp();
  }, [initializeApp, isVSCodeRuntime]);

  React.useEffect(() => {
    if (isVSCodeRuntime || isInitialized) return;

    let active = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryCount = 0;
    const MAX_RETRIES = 10;
    const BASE_DELAY_MS = 1000;

    const retryInitialization = async () => {
      if (!active) return;
      if (retryCount >= MAX_RETRIES) {
        setInitRetryExhausted(true);
        return;
      }
      const state = useConfigStore.getState();
      if (state.isInitialized) {
        setInitRetryExhausted(false);
        return;
      }
      retryCount += 1;
      await state.initializeApp();

      const next = useConfigStore.getState();
      if (!active) return;
      if (next.isInitialized) {
        setInitRetryExhausted(false);
        return;
      }
      if (retryCount >= MAX_RETRIES) {
        setInitRetryExhausted(true);
        return;
      }
      const delay = Math.min(BASE_DELAY_MS * Math.pow(2, retryCount - 1), 16000);
      retryTimer = setTimeout(retryInitialization, delay);
    };

    retryTimer = setTimeout(retryInitialization, BASE_DELAY_MS);

    return () => {
      active = false;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [initRetryEpoch, isInitialized, isVSCodeRuntime]);

  React.useEffect(() => {
    if (isInitialized) {
      setInitRetryExhausted(false);
    }
  }, [isInitialized]);

  React.useEffect(() => {
    if (!initRetryExhausted) return;

    const loadingElement = document.getElementById('initial-loading');
    if (loadingElement) {
      loadingElement.classList.add('fade-out');
      setTimeout(() => {
        loadingElement.remove();
      }, 300);
    }
  }, [initRetryExhausted]);

  // Startup recovery: poll until providers AND agents are loaded.
  // loadProviders/loadAgents resolve normally even on failure (errors swallowed),
  // so a reactive effect can't detect failure — we need an interval.
  // A mounted project runtime has no provider/agent config contract yet
  // (501 capability_unavailable is permanent), so the loop is meaningless
  // there and would only keep firing failing requests.
  React.useEffect(() => {
    if (isVSCodeRuntime || !isConnected || isProjectRuntimeActive()) return;
    if (providersCount > 0 && agentsCount > 0) return;

    let active = true;
    let retries = 0;
    const MAX_RETRIES = 15;
    const attempt = async () => {
      const state = useConfigStore.getState();
      if (state.providers.length > 0 && state.agents.length > 0) return;
      try {
        if (state.providers.length === 0) await loadProviders({ source: 'startupRecovery' });
        if (useConfigStore.getState().agents.length === 0) await loadAgents({ source: 'startupRecovery' });
      } catch { /* retry next interval */ }
    };

    void attempt();
    const id = setInterval(() => {
      if (!active) return;
      if (++retries >= MAX_RETRIES) { clearInterval(id); return; }
      void attempt();
    }, 2000);
    return () => { active = false; clearInterval(id); };
  }, [isConnected, isVSCodeRuntime, loadAgents, loadProviders, providersCount, agentsCount]);

  React.useEffect(() => {
    if (isSwitchingDirectory) {
      return;
    }

    // VS Code runtime loads sessions via VSCodeLayout bootstrap to avoid startup races.
    if (isVSCodeRuntime) {
      return;
    }

    if (!isConnected) {
      return;
    }
    if (activeProjectId) {
      return;
    }
    opencodeClient.setDirectory(currentDirectory);

    // Session loading is handled by the sync system's bootstrap — no manual loadSessions needed.
  }, [activeProjectId, currentDirectory, isSwitchingDirectory, isConnected, isVSCodeRuntime]);

  React.useEffect(() => {
    if (!embeddedSessionChat || typeof window === 'undefined') {
      return;
    }

    const applyVisibility = (payload?: EmbeddedVisibilityPayload) => {
      const nextVisible = payload?.visible === true;
      setIsEmbeddedVisible(nextVisible);
    };

    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) {
        return;
      }

      const data = event.data as { type?: unknown; payload?: EmbeddedVisibilityPayload };
      if (data?.type !== 'openchamber:embedded-visibility') {
        return;
      }

      applyVisibility(data.payload);
    };

    const scopedWindow = window as unknown as {
      __openchamberSetEmbeddedVisibility?: (payload?: EmbeddedVisibilityPayload) => void;
    };

    scopedWindow.__openchamberSetEmbeddedVisibility = applyVisibility;
    window.addEventListener('message', handleMessage);

    return () => {
      window.removeEventListener('message', handleMessage);
      if (scopedWindow.__openchamberSetEmbeddedVisibility === applyVisibility) {
        delete scopedWindow.__openchamberSetEmbeddedVisibility;
      }
    };
  }, [embeddedSessionChat]);

  React.useEffect(() => {
    if (!embeddedSessionChat?.directory || embeddedSessionChat.projectId || isVSCodeRuntime) {
      return;
    }

    if (currentDirectory === embeddedSessionChat.directory) {
      return;
    }

    setDirectory(embeddedSessionChat.directory, { showOverlay: false });
  }, [currentDirectory, embeddedSessionChat, isVSCodeRuntime, setDirectory]);

  React.useEffect(() => {
    if (!embeddedSessionChat || typeof window === 'undefined') {
      return;
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.storageArea !== window.localStorage) {
        return;
      }

      if (event.key !== 'ui-store') {
        return;
      }

      void useUIStore.persist.rehydrate();
    };

    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener('storage', handleStorage);
    };
  }, [embeddedSessionChat]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string; directory?: string; projectId?: string }>).detail;
      const sessionId = typeof detail?.sessionId === 'string' ? detail.sessionId.trim() : '';
      if (!sessionId) return;
      const directory = typeof detail?.directory === 'string' && detail.directory.trim().length > 0
        ? detail.directory.trim()
        : null;
      const projectId = typeof detail?.projectId === 'string' && detail.projectId.trim().length > 0
        ? detail.projectId.trim()
        : null;
      useUIStore.getState().setActiveMainTab('chat');
      void useSessionUIStore.getState().setCurrentSession(sessionId, directory, projectId);
    };

    window.addEventListener('openchamber:open-session', handler as EventListener);
    return () => window.removeEventListener('openchamber:open-session', handler as EventListener);
  }, []);

  // Open a draft Mini Chat window from the native File menu / tray. Uses a
  // dedicated single-fire event (not the menu-action channel) because draft
  // mini-chat windows are NOT deduplicated — a double dispatch would open two.
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const onOpenMiniChat = () => {
      const sessionState = useSessionUIStore.getState();
      const currentDir = sessionState.currentProjectId
        ? sessionState.currentSessionDirectory ?? ''
        : useDirectoryStore.getState().currentDirectory;
      const { activeProjectId, projects } = useProjectsStore.getState();
      const activeProject = sessionState.currentProjectId
        ? null
        : projects.find((p) => p.id === activeProjectId) ?? null;
      void invokeDesktop('desktop_open_draft_mini_chat_window', {
        directory: currentDir || activeProject?.path || '',
        projectId: activeProject?.id ?? null,
        workspaceId: sessionState.currentProjectId ?? null,
        ...getDesktopRuntimeEndpointArgs(),
      }).catch((error) => {
        // Remote-origin windows are not allowed to open Mini Chat windows;
        // the main process rejects the command there.
        console.warn('[app] failed to open draft mini chat window', error);
      });
    };
    window.addEventListener('openchamber:open-mini-chat', onOpenMiniChat);
    return () => window.removeEventListener('openchamber:open-mini-chat', onOpenMiniChat);
  }, []);

  // When the window regains focus, mark the currently-selected session as seen.
  // Turn-completes that arrive while the app is backgrounded are intentionally
  // left unseen (see isViewedInCurrentSession); coming back to the window is the
  // signal that the user has now looked at it, so the marker clears.
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const onFocus = () => {
      const current = useSessionUIStore.getState();
      if (current.currentSessionId) markSessionViewed(current.currentSessionId, current.currentProjectId);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ directory?: string; projectId?: string; workspaceId?: string }>).detail;
      const directory = typeof detail?.directory === 'string' && detail.directory.trim().length > 0
        ? detail.directory.trim()
        : null;
      const projectId = typeof detail?.projectId === 'string' && detail.projectId.trim().length > 0
        ? detail.projectId.trim()
        : null;
      // Legacy senders (pre-rename desktop builds) dispatch `workspaceId`;
      // prefer the current field and fall back so drafts never open blind.
      const legacyProjectId = typeof detail?.workspaceId === 'string' && detail.workspaceId.trim().length > 0
        ? detail.workspaceId.trim()
        : null;
      useUIStore.getState().setActiveMainTab('chat');
      useUIStore.getState().setSessionSwitcherOpen(false);
      useSessionUIStore.getState().openNewSessionDraft({
        projectId: projectId ?? legacyProjectId,
        selectedProjectId: projectId,
        directoryOverride: directory,
        preserveDirectoryOverride: Boolean(directory),
      });
    };

    window.addEventListener('openchamber:open-draft-session', handler as EventListener);
    return () => window.removeEventListener('openchamber:open-draft-session', handler as EventListener);
  }, []);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!isInitialized || isSwitchingDirectory) return;
    if (appReadyDispatchedRef.current) return;
    appReadyDispatchedRef.current = true;
    (window as unknown as { __openchamberAppReady?: boolean }).__openchamberAppReady = true;
    window.dispatchEvent(new Event('openchamber:app-ready'));
  }, [isInitialized, isSwitchingDirectory]);

  // useEventStream replaced by SyncProvider + SyncBridge

  // Session attention now handled by notification-store via SSE events (session.idle/session.error)

  usePushVisibilityBeacon({ enabled: embeddedBackgroundWorkEnabled });
  useWebNotificationStream({ enabled: embeddedBackgroundWorkEnabled });
  usePwaInstallPrompt();

  useWindowTitle();

  useRouter();

  const handleToggleMemoryDebug = React.useCallback(() => {
    setShowMemoryDebug(prev => !prev);
  }, []);

  useMenuActions(handleToggleMemoryDebug);

  useTraySync();

  useSessionStatusBootstrap({ enabled: embeddedBackgroundWorkEnabled });

  React.useEffect(() => {
    if (embeddedSessionChat) {
      return;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      const isDebugShortcut = hasModifier(e)
        && e.shiftKey
        && !e.altKey
        && (e.code === 'KeyD' || e.key.toLowerCase() === 'd');

      if (isDebugShortcut) {
        e.preventDefault();
        setShowMemoryDebug(prev => !prev);
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [embeddedSessionChat]);

  React.useEffect(() => {
    if (embeddedSessionChat) {
      return;
    }

    if (error) {

      setTimeout(() => clearError(), 5000);
    }
  }, [clearError, embeddedSessionChat, error]);

  // Poll for the injected boot outcome until it becomes available (desktop only).
  // The Rust backend sets window.__OPENCHAMBER_DESKTOP_BOOT_OUTCOME__ once the
  // sidecar reaches a stable state. We poll with exponential backoff to handle
  // potential race conditions during startup and config writes.
  React.useEffect(() => {
    if (!isDesktopRuntime || bootInjectionStatus !== 'not-injected') {
      return;
    }

    let cancelled = false;
    let attempts = 0;
    const BASE_INTERVAL = 200;
    const MAX_INTERVAL = 2000;
    const MAX_ATTEMPTS = 50; // 10 seconds total (200ms * 50 with exponential backoff cap)

    const pollWithBackoff = () => {
      if (cancelled) return;

      attempts++;
      const status = getBootInjectionStatus();

      if (status !== 'not-injected') {
        cancelled = true;
        setBootInjectionStatus(status);

        if (status === 'valid') {
          const outcome = getInjectedBootOutcome();
          if (outcome) {
            setBootView(resolveDesktopBootView({ isDesktopShell: true, bootOutcome: outcome }));
          }
        }
        // If status is 'malformed', we keep the splash visible with error text
        // handled by the separate useEffect below
        return;
      }

      // Exponential backoff with cap
      const nextInterval = Math.min(BASE_INTERVAL * Math.pow(1.1, attempts), MAX_INTERVAL);

      if (attempts >= MAX_ATTEMPTS) {
        // Max attempts reached - keep polling but show error
        const loadingElement = document.getElementById('initial-loading');
        if (loadingElement && !loadingElement.textContent?.includes('taking longer')) {
          loadingElement.textContent = 'Desktop startup is taking longer than expected...';
        }
      }

      window.setTimeout(pollWithBackoff, nextInterval);
    };

    // Start polling
    window.setTimeout(pollWithBackoff, BASE_INTERVAL);

    return () => {
      cancelled = true;
    };
  }, [isDesktopRuntime, bootInjectionStatus]);

  const handleDesktopBootDismiss = React.useCallback(async () => {
    if (shouldRestartDesktopBootFlow({
      isDesktopShell: isDesktopShell(),
      isDesktopLocalOriginActive: isDesktopLocalOriginActive(),
    })) {
      await restartDesktopApp();
      return;
    }

    window.location.reload();
  }, []);

  const handleManualInitRetry = React.useCallback(async () => {
    if (manualInitRetrying) return;

    setInitRetryExhausted(false);
    setManualInitRetrying(true);
    try {
      await useConfigStore.getState().initializeApp();
    } finally {
      setManualInitRetrying(false);
    }

    if (!useConfigStore.getState().isInitialized) {
      setInitRetryEpoch((value) => value + 1);
    }
  }, [manualInitRetrying]);

  // Map boot outcome kind to recovery variant
  const mapBootViewToRecoveryVariant = (view: DesktopBootView): RecoveryVariant | undefined => {
    if (view.screen === 'recovery') {
      return view.variant;
    }
    return undefined;
  };

  // Desktop boot view routing.
  // When the boot outcome resolves to a non-main screen (chooser, recovery),
  // render OnboardingScreen with appropriate mode/variant.
  if (isDesktopRuntime && bootView && bootView.screen !== 'main') {
    // First-launch chooser
    if (bootView.screen === 'chooser') {
      return (
        <ErrorBoundary>
          <div className="h-full text-foreground bg-background">
            <React.Suspense fallback={<div className="h-full" />}>
              <OnboardingScreen
                mode="first-launch"
                localAvailable={bootView.localAvailable !== false}
                onCliAvailable={handleDesktopBootDismiss}
                onChooseRemote={() => {
                  // Switch to remote tab - handled internally by OnboardingScreen
                }}
              />
            </React.Suspense>
          </div>
        </ErrorBoundary>
      );
    }

    // Recovery screens
    const recoveryVariant = mapBootViewToRecoveryVariant(bootView);
    const hostUrl = bootView.screen === 'recovery' && 'url' in bootView ? bootView.url : undefined;

    return (
      <ErrorBoundary>
        <div className="h-full text-foreground bg-background">
          <React.Suspense fallback={<div className="h-full" />}>
            <OnboardingScreen
              mode="recovery"
              recoveryVariant={recoveryVariant}
              recoveryHostUrl={hostUrl}
              recoveryHostLabel={undefined}
              localAvailable={bootView.localAvailable !== false}
              onCliAvailable={handleDesktopBootDismiss}
            />
          </React.Suspense>
        </div>
      </ErrorBoundary>
    );
  }

  if (embeddedSessionChat) {
    return (
      <ErrorBoundary>
        <ProjectRuntimeProvider projectId={embeddedSessionChat.projectId}>
          {embeddedSessionChat.projectId ? <ProjectCatalogSessionIndexEffects /> : null}
          <EmbeddedSessionChatRuntime
            embeddedSessionChat={embeddedSessionChat}
            isVSCodeRuntime={isVSCodeRuntime}
            embeddedBackgroundWorkEnabled={embeddedBackgroundWorkEnabled}
            runtimeEndpointEpoch={runtimeEndpointEpoch}
            apis={apis}
          />
        </ProjectRuntimeProvider>
      </ErrorBoundary>
    );
  }

  if (isMcpOAuthCallback) {
    return (
      <ErrorBoundary>
        <McpOAuthCallbackPage />
      </ErrorBoundary>
    );
  }

  if (initRetryExhausted && !isInitialized && !isVSCodeRuntime && !embeddedSessionChat) {
    return (
      <ErrorBoundary>
        <StartupInitializationRecovery
          onRetry={() => { void handleManualInitRetry(); }}
          isRetrying={manualInitRetrying}
        />
      </ErrorBoundary>
    );
  }

  // Always mount the full provider tree to avoid remounts when isInitialized
  // flips from false → true. FireworksProvider is a lightweight shell; its
  // heavy children are only activated when actually needed.
  const isBootShell = !isInitialized && !isDesktopRuntime;

  return (
    <ErrorBoundary>
      <ProjectRuntimeProvider projectId={resolvedProjectId}>
        <ProjectCatalogSessionIndexEffects />
        <ProjectSyncMount runtimeEndpointEpoch={runtimeEndpointEpoch}>
          <RuntimeAPIProvider apis={apis}>
            <FireworksProvider>
                <TooltipProvider delayDuration={300} skipDelayDuration={150}>
                  <div className={isDesktopRuntime ? 'h-full text-foreground bg-transparent' : 'h-full text-foreground bg-background'}>
                    <SyncAppEffects embeddedBackgroundWorkEnabled={embeddedBackgroundWorkEnabled} includeProjectState={false} />
                    <OpenCodeUpdateToast />
                    <MainLayout />
                    <Toaster />
                    {!isBootShell && (
                      <>
                        <ConfigUpdateOverlay />
                        <AboutDialogWrapper />
                        {showMemoryDebug && (
                          <MemoryDebugPanel onClose={() => setShowMemoryDebug(false)} />
                        )}
                      </>
                    )}
                  </div>
                </TooltipProvider>
            </FireworksProvider>
          </RuntimeAPIProvider>
        </ProjectSyncMount>
      </ProjectRuntimeProvider>
    </ErrorBoundary>
  );
}

export default App;
