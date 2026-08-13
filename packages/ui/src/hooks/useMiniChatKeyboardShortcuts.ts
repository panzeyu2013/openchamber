import React from 'react';
import { focusChatInput } from '@/components/chat/composer/editor/dom';
import { canUseElectronDesktopIPC, getDesktopRuntimeEndpointArgs, invokeDesktop } from '@/lib/desktop';
import { eventMatchesShortcut, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { useConfigStore } from '@/stores/useConfigStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSelectionStore } from '@/sync/selection-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useActiveProjectId } from '@/projects/useActiveProject';
import { useEffectiveDirectory } from './useEffectiveDirectory';

export const useMiniChatKeyboardShortcuts = () => {
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const activeProject = useProjectsStore((state) => state.getActiveProject());
  const openNewSessionDraft = useSessionUIStore((state) => state.openNewSessionDraft);
  const activeProjectId = useActiveProjectId();
  const effectiveDirectory = useEffectiveDirectory();
  const miniChatDirectory = effectiveDirectory || '';
  const miniChatProject = activeProjectId ? null : activeProject;

  React.useEffect(() => {
    const combo = (actionId: string) => getEffectiveShortcutCombo(actionId, shortcutOverrides);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (eventMatchesShortcut(event, combo('focus_input'))) {
        event.preventDefault();
        focusChatInput();
        return;
      }

      if (canUseElectronDesktopIPC() && eventMatchesShortcut(event, combo('new_mini_chat'))) {
        event.preventDefault();
        void invokeDesktop('desktop_open_draft_mini_chat_window', {
          directory: miniChatDirectory,
          projectId: miniChatProject?.id ?? null,
          workspaceId: activeProjectId ?? null,
          ...getDesktopRuntimeEndpointArgs(),
        })?.catch((error) => {
          console.warn('[mini-chat-shortcuts] failed to open draft mini chat window', error);
        });
        return;
      }

      if (eventMatchesShortcut(event, combo('new_chat'))) {
        event.preventDefault();
        openNewSessionDraft({
          selectedProjectId: miniChatProject?.id ?? null,
          directoryOverride: miniChatDirectory || null,
          preserveDirectoryOverride: Boolean(miniChatDirectory),
        });
        focusChatInput();
        return;
      }

      if (eventMatchesShortcut(event, combo('open_model_selector'))) {
        event.preventDefault();
        const { isModelSelectorOpen, setModelSelectorOpen } = useUIStore.getState();
        setModelSelectorOpen(!isModelSelectorOpen);
        return;
      }

      if (eventMatchesShortcut(event, combo('cycle_thinking_variant'))) {
        const configState = useConfigStore.getState();
        const variants = configState.getCurrentModelVariants();
        if (variants.length === 0) {
          return;
        }

        event.preventDefault();
        configState.cycleCurrentVariant();

        const nextVariant = useConfigStore.getState().currentVariant;
        const sessionId = useSessionUIStore.getState().currentSessionId;
        const agentName = useConfigStore.getState().currentAgentName;
        const providerId = useConfigStore.getState().currentProviderId;
        const modelId = useConfigStore.getState().currentModelId;

        if (sessionId && agentName && providerId && modelId) {
          useSelectionStore.getState().saveAgentModelVariantForSession(sessionId, agentName, providerId, modelId, nextVariant);
        }
        return;
      }

      const cyclesForward = eventMatchesShortcut(event, combo('cycle_favorite_model_forward'));
      const cyclesBackward = eventMatchesShortcut(event, combo('cycle_favorite_model_backward'));
      if (cyclesForward || cyclesBackward) {
        const { favoriteModels, addRecentModel } = useUIStore.getState();
        if (favoriteModels.length === 0) {
          return;
        }

        event.preventDefault();
        const { currentProviderId, currentModelId, setProvider, setModel } = useConfigStore.getState();
        const currentIndex = favoriteModels.findIndex((favorite) => favorite.providerID === currentProviderId && favorite.modelID === currentModelId);
        const delta = cyclesForward ? 1 : -1;
        const next = favoriteModels[(currentIndex + delta + favoriteModels.length) % favoriteModels.length];

        setProvider(next.providerID);
        setModel(next.modelID);
        addRecentModel(next.providerID, next.modelID);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeProjectId, miniChatDirectory, miniChatProject?.id, openNewSessionDraft, shortcutOverrides]);
};
