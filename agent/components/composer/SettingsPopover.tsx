import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
import { AgentModelConfig } from '../../../shared/types/model';
import type { Profile } from '../../../shared/types/profile';
import {
  getTerminalAgentFromProfile,
  isTerminalProfile,
  modelConfigMatchesProfile,
  profileToModelConfig,
} from '../../../shared/types/profile';
import { getProfiles, setDefaultProfile } from '../../../src/api';
import { profiles as profilesIpc, providers as providersIpc, workspace as workspaceIpc } from '../../../src/ipc';
import { Tooltip, TooltipTrigger, TooltipContent } from '../../../src/components/ui/tooltip';
import { Popover, PopoverTrigger, PopoverContent } from '../../../src/components/ui/popover';
import { ModelSelectorPopoverPanel } from '../../../src/components/ModelSelectorPopoverPanel';
import { ReasoningEffortControl } from '../../../src/components/ReasoningEffortControl';
import { UsageRemainingBadge } from '../../../src/components/ModelSignalBadges';
import { AGENT_SETTINGS_BUTTON_ID, SETTINGS_POPOVER_CLOSE_BUTTON_ID, SETTINGS_POPOVER_ID } from '../../../shared/element-ids';
import { useLayout } from '../../../src/hooks/useLayout';
import { useInterpreterTokenUsage } from '../../../src/hooks/useInterpreterTokenUsage';
import { LOW_USAGE_PERCENT_THRESHOLD, formatRemainingPercentLabel } from '../../../src/utils/modelCostSignals';
import { COMPOSER_PROFILE_SHORTCUT_EVENT, type ComposerProfileShortcutDetail } from './BaseTiptapComposer';
import { useCommandOverlay } from '../../../src/contexts/CommandOverlayContext';
import { ProfileShortcutWheel } from '../../../src/components/ProfileShortcutWheel';
import type {
  OpenRouterModelCatalogResult,
  SupportedOpenAIOAuthModel,
} from '../../../shared/types/provider';
import {
  getReasoningCapabilityForModelConfig,
  resolveReasoningEffort,
} from '../../../src/lib/reasoningCapabilities';
import {
  buildProfileFromPreset,
  getCustomPreset,
  getProfile as getRuntimeProfile,
  isCustomPreset,
  isProfileId,
} from '../../../src/lib/codex/profiles';
import { inferProfileIdFromEndpoint } from '../../../src/lib/codex/profile-options';
import {
  getStoredDefaultReasoningEffort,
  setStoredDefaultReasoningEffort,
} from '../../../src/utils/reasoningPreference';
import { shouldReplaceEditorAgentTabWithTerminalProfile } from '../../../src/components/layout/editorAgentState';
import { ComposerSecondaryButton } from './ComposerSecondaryButton';

interface SettingsPopoverProps {
  agentId: string;
  modelConfig: AgentModelConfig;
  onTerminalProfileSelect?: (profile: Profile) => void;
  messageCount?: number;
  hasCodexThread?: boolean;
  isStreaming?: boolean;
  workspacePath?: string;
  isSidebar?: boolean;
}

function resolveSelectedProfile(
  profiles: Profile[],
  modelConfig: AgentModelConfig,
): Profile | undefined {
  if (modelConfig.profileId) {
    return profiles.find((profile) => profile.id === modelConfig.profileId);
  }

  return profiles.find((profile) => modelConfigMatchesProfile(modelConfig, profile));
}

function resolveRuntimeModelProviderFromExplicitSelection(options: {
  codexProfileId: string;
  baseURL?: string;
  apiKey?: string;
  modelId?: string;
}): string | null {
  if (!isProfileId(options.codexProfileId)) {
    return null;
  }

  const preset = isCustomPreset(options.codexProfileId)
    ? getCustomPreset(options.codexProfileId)
    : undefined;

  return preset
    ? buildProfileFromPreset(preset, {
        baseUrl: options.baseURL,
        apiKey: options.apiKey,
        model: options.modelId,
      }).modelProvider
    : getRuntimeProfile(options.codexProfileId).modelProvider;
}

function resolveRuntimeModelProviderFromModelConfig(
  modelConfig: AgentModelConfig,
): string | null {
  if (modelConfig.codexProfileId) {
    return resolveRuntimeModelProviderFromExplicitSelection({
      codexProfileId: modelConfig.codexProfileId,
      baseURL: modelConfig.baseURL,
      apiKey: modelConfig.apiKey,
      modelId: modelConfig.modelId,
    });
  }

  if (modelConfig.provider === 'hosted') {
    return getRuntimeProfile('interpreter').modelProvider;
  }

  if (modelConfig.provider === 'openai-oauth') {
    return getRuntimeProfile('default').modelProvider;
  }

  if (modelConfig.provider === 'local' || modelConfig.provider === 'api') {
    const preset = getCustomPreset(inferProfileIdFromEndpoint(modelConfig.baseURL || ''));
    if (!preset) {
      return null;
    }

    return buildProfileFromPreset(preset, {
      baseUrl: modelConfig.baseURL,
      apiKey: modelConfig.apiKey,
      model: modelConfig.modelId,
    }).modelProvider;
  }

  return null;
}

function resolveRuntimeModelProviderFromProfile(profile: Profile): string | null {
  if (profile.codexProfileId) {
    return resolveRuntimeModelProviderFromExplicitSelection({
      codexProfileId: profile.codexProfileId,
      baseURL: profile.baseURL,
      apiKey: profile.apiKey,
      modelId: profile.modelId,
    });
  }

  if (profile.provider === 'hosted') {
    return getRuntimeProfile('interpreter').modelProvider;
  }

  if (profile.provider === 'openai-oauth') {
    return getRuntimeProfile('default').modelProvider;
  }

  if (profile.provider === 'local' || profile.provider === 'api') {
    const preset = getCustomPreset(inferProfileIdFromEndpoint(profile.baseURL || ''));
    if (!preset) {
      return null;
    }

    return buildProfileFromPreset(preset, {
      baseUrl: profile.baseURL,
      apiKey: profile.apiKey,
      model: profile.modelId,
    }).modelProvider;
  }

  return null;
}

function shouldOpenNewChatTabForProfileSwitch(params: {
  currentModelConfig: AgentModelConfig;
  nextProfile: Profile;
  hasConversationToPreserve: boolean;
}): boolean {
  if (!params.hasConversationToPreserve || isTerminalProfile(params.nextProfile)) {
    return false;
  }

  const currentProvider = resolveRuntimeModelProviderFromModelConfig(
    params.currentModelConfig,
  );
  const nextProvider = resolveRuntimeModelProviderFromProfile(params.nextProfile);

  if (!currentProvider || !nextProvider) {
    return false;
  }

  return currentProvider !== nextProvider;
}

export function SettingsPopover({
  agentId,
  modelConfig,
  onTerminalProfileSelect,
  messageCount: _messageCount = 0,
  hasCodexThread: _hasCodexThread = false,
  isStreaming: _isStreaming = false,
  workspacePath,
  isSidebar = false,
}: SettingsPopoverProps) {
  "use no memo";

  const { t } = useTranslation();
  const { openAgentTab, openSettings, updateTab, updateTabModelConfig } = useLayout();
  const { isCommandHeld } = useCommandOverlay();
  const [isOpen, setIsOpen] = useState(false);
  const [allProfiles, setAllProfiles] = useState<Profile[]>([]);
  const [isShortcutWheelVisible, setIsShortcutWheelVisible] = useState(false);
  const [openAiOAuthModels, setOpenAiOAuthModels] = useState<SupportedOpenAIOAuthModel[]>([]);
  const [openRouterCatalog, setOpenRouterCatalog] = useState<OpenRouterModelCatalogResult | null>(null);
  const [hasLoadedOpenAiOAuthModels, setHasLoadedOpenAiOAuthModels] = useState(false);
  const [hasLoadedOpenRouterCatalog, setHasLoadedOpenRouterCatalog] = useState(false);
  const { percentRemaining } = useInterpreterTokenUsage();
  const showShortcutPreview = isCommandHeld && !isOpen;
  const newChatActionLabel = 'New Chat';

  const loadProfileInfo = useCallback(async () => {
    try {
      const data = await getProfiles();
      setAllProfiles(data.profiles);
    } catch {
      setAllProfiles([]);
    }
  }, []);

  useEffect(() => {
    void loadProfileInfo();
  }, [loadProfileInfo]);

  useEffect(() => {
    if (!isOpen) return;
    void loadProfileInfo();
  }, [isOpen, loadProfileInfo]);

  // NOTE(victor): PROFILE SYNC -- idle tabs (messageCount === 0, no codex thread) auto-sync
  // to the server default profile when it changes. Tabs WITH messages intentionally DO NOT sync
  // because changing profile mid-conversation would alter the model. To change an active
  // conversation's profile, the user must do it explicitly via the popover.
  // Cross-provider picks open a new tab; same-provider picks stay in the current chat.
  const shouldSyncDefaultProfile = _messageCount === 0 && !_hasCodexThread;
  useEffect(() => {
    const unsubscribe = profilesIpc.onChanged(async () => {
      try {
        const data = await getProfiles();
        setAllProfiles(data.profiles);
        if (shouldSyncDefaultProfile) {
          const dp = data.profiles.find((p: Profile) => p.id === data.defaultProfileId);
          if (dp && !isTerminalProfile(dp)) {
            const nextModelConfig = profileToModelConfig(dp);
            const preferredReasoningEffort = modelConfig.reasoningEffort ?? getStoredDefaultReasoningEffort();
            updateTabModelConfig(agentId, profileToModelConfig(dp, {
              reasoningEffort: resolveReasoningEffort(
                getReasoningCapabilityForModelConfig(nextModelConfig, {
                  openAiOAuthModels,
                  openRouterCatalog,
                }),
                preferredReasoningEffort,
              ) ?? preferredReasoningEffort,
            }));
          }
        }
      } catch {
        setAllProfiles([]);
      }
    });
    return unsubscribe;
  }, [
    agentId,
    modelConfig.reasoningEffort,
    openAiOAuthModels,
    openRouterCatalog,
    shouldSyncDefaultProfile,
    updateTabModelConfig,
  ]);

  useEffect(() => {
    let cancelled = false;

    void providersIpc.listOpenAIOAuthModels()
      .then(({ models }) => {
        if (!cancelled) {
          setOpenAiOAuthModels(models);
          setHasLoadedOpenAiOAuthModels(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setOpenAiOAuthModels([]);
          setHasLoadedOpenAiOAuthModels(true);
        }
      });

    void providersIpc.listOpenRouterModels()
      .then((catalog) => {
        if (!cancelled) {
          setOpenRouterCatalog(catalog);
          setHasLoadedOpenRouterCatalog(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setOpenRouterCatalog(null);
          setHasLoadedOpenRouterCatalog(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const matchingProfile = useMemo(
    () => resolveSelectedProfile(allProfiles, modelConfig),
    [allProfiles, modelConfig],
  );
  const selectedProfileId = matchingProfile?.id ?? modelConfig.profileId ?? null;
  const currentProfileLabel = matchingProfile?.name ?? (allProfiles.length > 0 ? 'Custom Agent' : 'Profile');
  const lowUsageLabel = useMemo(() => {
    if (percentRemaining === null || percentRemaining >= LOW_USAGE_PERCENT_THRESHOLD) return null;
    return `${formatRemainingPercentLabel(percentRemaining)} left`;
  }, [percentRemaining]);
  const showLowUsagePill = (matchingProfile?.provider === 'hosted' || modelConfig.provider === 'hosted')
    && !!lowUsageLabel;
  const reasoningCapability = useMemo(
    () => getReasoningCapabilityForModelConfig(modelConfig, {
      openAiOAuthModels,
      openRouterCatalog,
    }),
    [modelConfig, openAiOAuthModels, openRouterCatalog],
  );
  const displayedReasoningEffort = useMemo(
    () => resolveReasoningEffort(reasoningCapability, modelConfig.reasoningEffort),
    [modelConfig.reasoningEffort, reasoningCapability],
  );
  const reasoningCapabilityPending = useMemo(() => {
    if (modelConfig.provider === 'openai-oauth') {
      return !hasLoadedOpenAiOAuthModels;
    }
    if (modelConfig.provider === 'hosted') {
      return modelConfig.modelId !== 'interpreter-smart'
        && modelConfig.modelId !== 'interpreter-fast'
        && !hasLoadedOpenRouterCatalog;
    }
    if (modelConfig.provider === 'api') {
      return !!modelConfig.baseURL?.includes('openrouter.ai') && !hasLoadedOpenRouterCatalog;
    }
    return false;
  }, [
    hasLoadedOpenAiOAuthModels,
    hasLoadedOpenRouterCatalog,
    modelConfig.baseURL,
    modelConfig.modelId,
    modelConfig.provider,
  ]);
  const shouldReplaceCurrentTabWithTerminalProfile = shouldReplaceEditorAgentTabWithTerminalProfile({
    isSidebar,
    hasConversationThread: _hasCodexThread,
    messageCount: _messageCount,
    isStreaming: _isStreaming,
  });
  const hasConversationToPreserve = _messageCount > 0 || _hasCodexThread;
  const openTerminalTabFromProfile = useCallback(async (profile: Profile) => {
    const terminalAgentId = getTerminalAgentFromProfile(profile);
    if (!terminalAgentId) return;
    const { workspace } = await workspaceIpc.get();
    const resolvedWorkspacePath = workspacePath ?? workspace ?? undefined;

    openAgentTab(
      `terminal-${Date.now()}`,
      profile.name,
      {
        terminalAgent: terminalAgentId,
        modelConfig: profileToModelConfig(profile),
        cwd: resolvedWorkspacePath,
      },
      isSidebar ? 'sidebar' : undefined,
    );
  }, [isSidebar, openAgentTab, workspacePath]);
  const replaceCurrentTabWithTerminalFromProfile = useCallback(async (profile: Profile) => {
    const terminalAgentId = getTerminalAgentFromProfile(profile);
    if (!terminalAgentId) return;
    const { workspace } = await workspaceIpc.get();
    const resolvedWorkspacePath = workspacePath ?? workspace ?? undefined;

    updateTab(agentId, () => ({
      id: agentId,
      type: 'terminal',
      label: profile.name,
      agentTabId: `terminal-${Date.now()}`,
      terminalAgent: terminalAgentId,
      modelConfig: profileToModelConfig(profile),
      cwd: resolvedWorkspacePath,
    }));
  }, [agentId, updateTab, workspacePath]);
  const getCompactActionLabel = useCallback((profile: Profile) => {
    if (profile.id === selectedProfileId) {
      return null;
    }

    if (isTerminalProfile(profile)) {
      return shouldReplaceCurrentTabWithTerminalProfile ? null : newChatActionLabel;
    }

    return shouldOpenNewChatTabForProfileSwitch({
      currentModelConfig: modelConfig,
      nextProfile: profile,
      hasConversationToPreserve,
    })
      ? newChatActionLabel
      : null;
  }, [
    hasConversationToPreserve,
    modelConfig,
    newChatActionLabel,
    selectedProfileId,
    shouldReplaceCurrentTabWithTerminalProfile,
  ]);
  const handleProfileSelect = useCallback(async (profile: Profile, shouldClose: boolean) => {
    setAllProfiles((previous) => {
      const existingIndex = previous.findIndex((candidate) => candidate.id === profile.id);
      if (existingIndex === -1) {
        return [...previous, profile];
      }

      const next = [...previous];
      next[existingIndex] = profile;
      return next;
    });

    const persistedReasoningEffort = getStoredDefaultReasoningEffort();
    const nextProfileModelConfig = profileToModelConfig(profile);
    const preferredReasoningEffort = modelConfig.reasoningEffort ?? persistedReasoningEffort;
    const nextModelConfig = {
      ...nextProfileModelConfig,
      reasoningEffort: resolveReasoningEffort(
        getReasoningCapabilityForModelConfig(nextProfileModelConfig, {
          openAiOAuthModels,
          openRouterCatalog,
        }),
        preferredReasoningEffort,
      ) ?? preferredReasoningEffort,
    };
    const shouldOpenNewChatTab = shouldOpenNewChatTabForProfileSwitch({
      currentModelConfig: modelConfig,
      nextProfile: profile,
      hasConversationToPreserve,
    });
    const isSameRuntimeSelection =
      profile.id === modelConfig.profileId
      && modelConfigMatchesProfile(modelConfig, profile)
      && (modelConfig.reasoningEffort ?? null) === (nextModelConfig.reasoningEffort ?? null);

    if (isSameRuntimeSelection) {
      if (shouldClose) {
        setIsOpen(false);
      }
      return;
    }

    if (isTerminalProfile(profile)) {
      if (onTerminalProfileSelect) {
        onTerminalProfileSelect(profile);
      } else if (shouldReplaceCurrentTabWithTerminalProfile) {
        await replaceCurrentTabWithTerminalFromProfile(profile);
      } else {
        await openTerminalTabFromProfile(profile);
      }
      if (shouldClose) {
        setIsOpen(false);
      }
      return;
    }

    if (shouldOpenNewChatTab) {
      openAgentTab(
        `agent-${Date.now()}`,
        profile.name,
        {
          modelConfig: nextModelConfig,
          workspacePath,
        },
        isSidebar ? 'sidebar' : undefined,
      );
      await setDefaultProfile(profile.id);
      if (shouldClose) {
        setIsOpen(false);
      }
      return;
    }

    updateTabModelConfig(agentId, nextModelConfig);
    await setDefaultProfile(profile.id);
    if (shouldClose) {
      setIsOpen(false);
    }
  }, [
    agentId,
    hasConversationToPreserve,
    isSidebar,
    modelConfig,
    onTerminalProfileSelect,
    openAgentTab,
    openAiOAuthModels,
    openRouterCatalog,
    openTerminalTabFromProfile,
    replaceCurrentTabWithTerminalFromProfile,
    shouldReplaceCurrentTabWithTerminalProfile,
    updateTabModelConfig,
    workspacePath,
  ]);

  useEffect(() => {
    if (modelConfig.reasoningEffort === undefined) {
      return;
    }
    if (reasoningCapabilityPending) {
      return;
    }
    if (displayedReasoningEffort === modelConfig.reasoningEffort) {
      return;
    }
    updateTabModelConfig(agentId, {
      ...modelConfig,
      reasoningEffort: displayedReasoningEffort,
    });
  }, [
    agentId,
    modelConfig,
    modelConfig.reasoningEffort,
    displayedReasoningEffort,
    reasoningCapabilityPending,
    updateTabModelConfig,
  ]);

  const handleReasoningEffortChange = useCallback((reasoningEffort: NonNullable<AgentModelConfig['reasoningEffort']>) => {
    setStoredDefaultReasoningEffort(reasoningEffort);
    updateTabModelConfig(agentId, {
      ...modelConfig,
      reasoningEffort,
    });
  }, [agentId, modelConfig, updateTabModelConfig]);

  useEffect(() => {
    const handleProfileShortcut = (event: Event) => {
      const detail = (event as CustomEvent<ComposerProfileShortcutDetail>).detail;
      if (!detail || detail.scope !== agentId) return;
      const profile = allProfiles[detail.slot - 1];
      if (!profile) return;

      void handleProfileSelect(profile, false);
    };

    window.addEventListener(COMPOSER_PROFILE_SHORTCUT_EVENT, handleProfileShortcut as EventListener);
    return () => {
      window.removeEventListener(COMPOSER_PROFILE_SHORTCUT_EVENT, handleProfileShortcut as EventListener);
    };
  }, [agentId, allProfiles, handleProfileSelect]);

  const handleNavigateToSettings = useCallback(() => {
    setIsOpen(false);
    openSettings(undefined, 'profiles');
    window.dispatchEvent(new CustomEvent('settings:blink-profiles'));
  }, [openSettings]);

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <ComposerSecondaryButton
              type="button"
              data-testid={isOpen ? SETTINGS_POPOVER_CLOSE_BUTTON_ID : AGENT_SETTINGS_BUTTON_ID}
              aria-expanded={isOpen}
              data-help-title={t('help.composer.changeModel.title')}
              data-help-description={t('help.composer.changeModel.description')}
              className="gap-1"
              style={{
                opacity: isShortcutWheelVisible ? 0.5 : 1,
                transition: 'opacity 280ms cubic-bezier(0.2, 0.72, 0.25, 1)',
              }}
            >
              {showLowUsagePill ? <UsageRemainingBadge label={lowUsageLabel ?? ''} /> : null}
              <ProfileShortcutWheel
                profiles={allProfiles}
                selectedProfileId={selectedProfileId}
                fallbackLabel={currentProfileLabel}
                isCommandHeld={showShortcutPreview}
                onPreviewVisibilityChange={setIsShortcutWheelVisible}
                className="shrink-0"
              />
              <ChevronDown className={`size-3.5 shrink-0 transition-transform duration-150 ${isOpen ? 'rotate-180' : ''}`} />
            </ComposerSecondaryButton>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">{t('help.composer.changeModel.title')}</TooltipContent>
      </Tooltip>

      <PopoverContent
        data-testid={SETTINGS_POPOVER_ID}
        side="top"
        sideOffset={4}
        className="flex max-h-[calc(100dvh-var(--unit-height)-0.75rem)] w-[min(19.5rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-[14px] p-0 shadow-[0_16px_40px_-28px_var(--shadow-color)]"
        style={{
          maxHeight: 'min(calc(100dvh - var(--unit-height) - 0.75rem), var(--radix-popover-content-available-height))',
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <ModelSelectorPopoverPanel
          selectedProfileId={selectedProfileId ?? undefined}
          onProfileSelect={handleProfileSelect}
          getCompactActionLabel={getCompactActionLabel}
          onNavigateToSettings={handleNavigateToSettings}
          onClose={() => setIsOpen(false)}
        >
          {reasoningCapability && displayedReasoningEffort ? (
            <div
              className="mt-2 border-t px-2.5 pb-2.5 pt-2.5"
              style={{ borderTop: 'var(--border-width) solid var(--border)' }}
            >
              <ReasoningEffortControl
                supportedEfforts={reasoningCapability.supportedEfforts}
                value={displayedReasoningEffort}
                onChange={handleReasoningEffortChange}
                className="px-1"
              />
            </div>
          ) : null}
        </ModelSelectorPopoverPanel>
      </PopoverContent>
    </Popover>
  );
}
