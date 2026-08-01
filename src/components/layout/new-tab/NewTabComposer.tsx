import React, { useState, useEffect, useCallback, useRef, useImperativeHandle } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  ArrowUp,
} from 'lucide-react';
import { useLayoutActions } from '../../../hooks/useLayout';
import { getProfiles, setDefaultProfile } from '../../../api';
import { profiles as profilesIpc, workspace as workspaceIpc } from '../../../ipc';
import { Tooltip, TooltipTrigger, TooltipContent } from '../../ui/tooltip';
import { Popover, PopoverTrigger, PopoverContent } from '../../ui/popover';
import { BaseTiptapComposer, BaseTiptapComposerRef, COMPOSER_PROFILE_SHORTCUT_EVENT, type ComposerProfileShortcutDetail } from '../../../../agent/components/composer/BaseTiptapComposer';
import { ModelSelectorPopoverPanel } from '../../ModelSelectorPopoverPanel';
import { UsageRemainingBadge } from '../../ModelSignalBadges';
import { GhostElement } from '../../ui/ghost-element';
import type { Profile } from '../../../../shared/types/profile';
import { getTerminalAgentFromProfile, isTerminalProfile, profileToModelConfig } from '../../../../shared/types/profile';
import { useInterpreterTokenUsage } from '../../../hooks/useInterpreterTokenUsage';
import { LOW_USAGE_PERCENT_THRESHOLD, formatRemainingPercentLabel } from '../../../utils/modelCostSignals';
import { flashFeedbackButton } from '../../../utils/feedback';
import { trackModelChanged, trackModelSwitched } from '../../../utils/telemetry';
import { setActiveProfile } from '../../../utils/telemetryContext';
import { MAIN_COMPOSER_SEND_BUTTON_ID } from '../../../../shared/element-ids';
import {
  AGENT_SEED_COMPOSER_EVENT,
  consumePendingAgentComposerSeed,
  peekPendingAgentComposerSeed,
  type AgentSeedComposerDetail,
} from '../../../../shared/agentEvents';

const NEW_TAB_SHORTCUT_SCOPE = 'new-tab';

function normalizeSeedPromptText(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

// Profile selector button for the new tab composer -- mirrors SettingsPopover
export function NewTabProfileSelector() {
  const { t } = useTranslation();
  const { openAgentTab, openSettings } = useLayoutActions();
  const [defaultProfileId, setDefaultProfileIdState] = useState<string | null>(null);
  const [profileName, setProfileName] = useState<string>(t('newTab.model'));
  const [isOpen, setIsOpen] = useState(false);
  const [isHostedDefaultProfile, setIsHostedDefaultProfile] = useState(false);
  const allProfilesRef = useRef<Profile[]>([]);
  const { percentRemaining } = useInterpreterTokenUsage();
  const lowUsageLabel = percentRemaining !== null && percentRemaining < LOW_USAGE_PERCENT_THRESHOLD
    ? t('newTab.usageLeft', { amount: formatRemainingPercentLabel(percentRemaining) })
    : null;

  const refreshProfileSelection = useCallback(async () => {
    let data: Awaited<ReturnType<typeof getProfiles>> | null = null;
    try {
      data = await getProfiles();
    } catch {
      setDefaultProfileIdState(null);
      setIsHostedDefaultProfile(false);
    }

    if (data) {
      allProfilesRef.current = data.profiles;
      setDefaultProfileIdState(data.defaultProfileId);
      const defaultProfile = data.profiles.find((p: Profile) => p.id === data.defaultProfileId) || data.profiles[0];
      if (defaultProfile) {
        setProfileName(defaultProfile.name);
        setIsHostedDefaultProfile(defaultProfile.provider === 'hosted');
        setActiveProfile({
          profileId: defaultProfile.id,
          model: defaultProfile.name,
          provider: defaultProfile.provider,
        });
        return;
      }
    }

    setProfileName(t('newTab.model'));
  }, [t]);

  useEffect(() => {
    void refreshProfileSelection();
    const unsubscribe = profilesIpc.onChanged(() => {
      void refreshProfileSelection();
    });
    return unsubscribe;
  }, [refreshProfileSelection]);

  useEffect(() => {
    const handler = (event: Event) => {
      const { detail } = event as CustomEvent<ComposerProfileShortcutDetail>;
      if (!detail || detail.scope !== NEW_TAB_SHORTCUT_SCOPE) return;
      const profile = allProfilesRef.current[detail.slot - 1];
      if (!profile || isTerminalProfile(profile)) return;
      void setDefaultProfile(profile.id);
      setDefaultProfileIdState(profile.id);
      setProfileName(profile.name);
      setIsHostedDefaultProfile(profile.provider === 'hosted');
    };
    window.addEventListener(COMPOSER_PROFILE_SHORTCUT_EVENT, handler);
    return () => window.removeEventListener(COMPOSER_PROFILE_SHORTCUT_EVENT, handler);
  }, []);

  const handleProfileSelect = async (profile: Profile, shouldClose: boolean) => {
    if (isTerminalProfile(profile)) {
      const terminalAgentId = getTerminalAgentFromProfile(profile);
      if (!terminalAgentId) return;
      const { workspace } = await workspaceIpc.get();

      openAgentTab(
        `terminal-${Date.now()}`,
        profile.name,
        {
          terminalAgent: terminalAgentId,
          modelConfig: profileToModelConfig(profile),
          cwd: workspace ?? undefined,
        },
        'sidebar',
      );
      if (shouldClose) setIsOpen(false);
      return;
    }

    const previousProfileId = defaultProfileId;
    await setDefaultProfile(profile.id);
    setDefaultProfileIdState(profile.id);
    setProfileName(profile.name);
    setIsHostedDefaultProfile(profile.provider === 'hosted');
    trackModelChanged({ profileId: profile.id, model: profile.name });
    trackModelSwitched({
      fromProfileId: previousProfileId,
      toProfileId: profile.id,
      toModel: profile.name,
      surface: 'composer',
    });
    setActiveProfile({ profileId: profile.id, model: profile.name, provider: profile.provider });
    if (shouldClose) setIsOpen(false);
  };

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
            <button
              type="button"
              data-help-title={t('help.composer.changeModel.title')}
              data-help-description={t('help.composer.changeModel.description')}
              className={`flex min-w-0 max-w-[11rem] items-center gap-1 px-2.5 py-1.5 rounded-full text-ui-sm leading-5 font-medium transition-[background-color,color] duration-150 ${
                isOpen
                  ? 'bg-black/[0.03] text-foreground dark:bg-white/[0.06]'
                  : 'text-muted-foreground hover:bg-black/[0.025] hover:text-foreground dark:hover:bg-white/[0.05]'
              }`}
            >
              {isHostedDefaultProfile && lowUsageLabel ? <UsageRemainingBadge label={lowUsageLabel} /> : null}
              <span className={`block min-w-0 max-w-[8rem] truncate leading-5 ${isOpen ? '' : 'text-muted-foreground'}`}>{profileName}</span>
              <ChevronDown className={`size-3.5 ${isOpen ? 'rotate-180 text-foreground' : 'text-muted-foreground'}`} />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">{t('help.composer.changeModel.title')}</TooltipContent>
      </Tooltip>

      <PopoverContent
        sideOffset={4}
        className="w-[min(19.5rem,calc(100vw-2rem))] overflow-hidden rounded-[14px] p-0 shadow-[0_16px_40px_-28px_var(--shadow-color)]"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <ModelSelectorPopoverPanel
          selectedProfileId={defaultProfileId || undefined}
          onProfileSelect={handleProfileSelect}
          onNavigateToSettings={handleNavigateToSettings}
        />
      </PopoverContent>
    </Popover>
  );
}

// Ghost state for the composer send animation
interface ComposerGhostState {
  startRect: DOMRect;
  text: string;
}

// Composer for the empty agent state surface
export const NewTabComposer = React.forwardRef<BaseTiptapComposerRef, {
  agentId?: string;
  onSend: (text: string) => void;
  showFirstStartupNudge?: boolean;
  placeholderOverride?: string | null;
}>(
function NewTabComposerInner({ agentId, onSend, showFirstStartupNudge, placeholderOverride }, forwardedRef) {
  const { t } = useTranslation();
  const composerRef = useRef<BaseTiptapComposerRef>(null);
  const composerContainerRef = useRef<HTMLDivElement>(null);
  const [ghost, setGhost] = useState<ComposerGhostState | null>(null);
  const [showSendButtonPulse, setShowSendButtonPulse] = useState(false);

  // Forward ref so parent can call setContent/focus on this composer
  useImperativeHandle(forwardedRef, () => ({
    focus: () => composerRef.current?.focus(),
    insertText: (text: string) => composerRef.current?.insertText(text),
    setContent: (text: string) => composerRef.current?.setContent(text),
    setPreviewText: (text: string | null) => composerRef.current?.setPreviewText(text),
    setContentWithTokenFlash: (text: string, ranges: Array<{ start: number; end: number }>) =>
      composerRef.current?.setContentWithTokenFlash(text, ranges),
    getContent: () => composerRef.current?.getContent() ?? '',
    getSubmission: () => composerRef.current?.getSubmission() ?? { text: '', attachments: [] },
    clearContent: () => composerRef.current?.clearContent(),
  }));

  useEffect(() => {
    if (!agentId) {
      return;
    }

    let retryTimerId: number | null = null;

    const applySeedComposerDetail = (detail: AgentSeedComposerDetail): boolean => {
      if (!detail || detail.agentId !== agentId || !detail.prompt.trim()) {
        return false;
      }
      if (detail.autoSend) {
        consumePendingAgentComposerSeed(detail.agentId);
        onSend(detail.prompt);
        return true;
      }
      if (!composerRef.current) {
        return false;
      }
      composerRef.current.setContent(detail.prompt);
      const appliedPrompt = normalizeSeedPromptText(composerRef.current.getContent());
      if (appliedPrompt !== normalizeSeedPromptText(detail.prompt)) {
        return false;
      }
      consumePendingAgentComposerSeed(detail.agentId);
      composerRef.current.focus();
      return true;
    };

    const schedulePendingSeedRetry = () => {
      if (retryTimerId !== null) {
        return;
      }
      retryTimerId = window.setTimeout(() => {
        retryTimerId = null;
        const pendingSeed = peekPendingAgentComposerSeed(agentId);
        if (!pendingSeed) {
          return;
        }
        if (!applySeedComposerDetail(pendingSeed)) {
          schedulePendingSeedRetry();
        }
      }, 50);
    };

    const handleSeedComposer = (event: Event) => {
      const detail = (event as CustomEvent<AgentSeedComposerDetail>).detail;
      if (!applySeedComposerDetail(detail)) {
        schedulePendingSeedRetry();
      }
    };

    window.addEventListener(AGENT_SEED_COMPOSER_EVENT, handleSeedComposer as EventListener);
    const pendingSeed = peekPendingAgentComposerSeed(agentId);
    if (pendingSeed && !applySeedComposerDetail(pendingSeed)) {
      schedulePendingSeedRetry();
    }
    return () => {
      if (retryTimerId !== null) {
        window.clearTimeout(retryTimerId);
      }
      window.removeEventListener(AGENT_SEED_COMPOSER_EVENT, handleSeedComposer as EventListener);
    };
  }, [agentId, onSend]);

  // Auto-type nudge on first startup
  useEffect(() => {
    if (!showFirstStartupNudge) return;
    const text = t('newTab.firstPromptNudge');
    let i = 0;
    let feedbackPulseTimeout: ReturnType<typeof setTimeout> | null = null;
    const interval = setInterval(() => {
      if (i < text.length) {
        composerRef.current?.setContent(text.slice(0, i + 1));
        i += 1;
      } else {
        clearInterval(interval);
        setShowSendButtonPulse(true);
        feedbackPulseTimeout = setTimeout(() => {
          flashFeedbackButton();
        }, 20_000);
      }
    }, 40);
    return () => {
      clearInterval(interval);
      if (feedbackPulseTimeout) {
        clearTimeout(feedbackPulseTimeout);
      }
    };
  }, [showFirstStartupNudge]);

  const handleSend = useCallback((text: string) => {
    console.log('[NewTabComposer] handleSend called', { textLen: text.length, hasText: !!text.trim() });
    if (!text.trim()) {
      console.log('[NewTabComposer] handleSend aborted: empty text');
      return;
    }

    // Start ghost animation from the composer to the sidebar composer area
    if (composerContainerRef.current) {
      const rect = composerContainerRef.current.getBoundingClientRect();
      setGhost({ startRect: rect, text });
      console.log('[NewTabComposer] Ghost animation started');
    }

    setShowSendButtonPulse(false);
    console.log('[NewTabComposer] Calling onSend callback');
    onSend(text);
    console.log('[NewTabComposer] onSend callback returned, clearing content');
    composerRef.current?.clearContent();
  }, [onSend]);

  return (
    <>
      <div
        ref={composerContainerRef}
        data-morph-composer-source="true"
        className="new-tab-composer-wrapper w-full rounded-[var(--control-radius-lg)] overflow-hidden"
        style={{
          background: 'var(--oa-composer-surface, var(--oa-bg-input, var(--background)))',
          border: 'var(--border-width) solid var(--oa-composer-border, var(--oa-border, var(--border)))',
          boxShadow: 'var(--oa-composer-shadow, 0 1px 2px rgba(15, 23, 42, 0.04), 0 8px 22px rgba(15, 23, 42, 0.04))',
        }}
      >
        <BaseTiptapComposer
          ref={composerRef}
          placeholder={placeholderOverride ?? undefined}
          onSend={handleSend}
          autoFocus={false}
          isMainComposer={true}
          agentId={agentId}
          profileShortcutScope={NEW_TAB_SHORTCUT_SCOPE}
          noPadding={true}
          className="flex flex-col"
          editable={true}
          showControls={true}
          hideControlsOnBlur={false}
          highlightToolKeywords={true}
          settingsContent={<NewTabProfileSelector />}
          renderSendButton={({ disabled: sendDisabled, onSend: triggerSend }) => (
            <span
              className={[
                'inline-flex rounded-full p-1',
                showSendButtonPulse && !sendDisabled && 'onboarding-feedback-button-shell feedback-button-onboarding-pulse-twice',
              ].filter(Boolean).join(' ')}
              onAnimationEnd={() => setShowSendButtonPulse(false)}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    disabled={sendDisabled}
                    data-testid={MAIN_COMPOSER_SEND_BUTTON_ID}
                    data-help-title={t('help.composer.send.title')}
                    data-help-description={t('help.newTab.send.description')}
                    className={[
                      'composer-send-button size-7 p-1.5 rounded-control bg-[var(--brand-accent)] text-[var(--brand-accent-foreground)] hover:opacity-80',
                      sendDisabled && 'opacity-50 cursor-not-allowed',
                    ].filter(Boolean).join(' ')}
                    onClick={triggerSend}
                  >
                    <ArrowUp className="size-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <span className="flex items-center gap-1.5">
                    <span>{t('help.composer.send.title')}</span>
                    <span className="opacity-60">{t('common.enter')}</span>
                  </span>
                </TooltipContent>
              </Tooltip>
            </span>
          )}
        />
      </div>

      {/* Ghost animation - flies from composer to upper right (sidebar area) */}
      {ghost && (
        <GhostElement
          startRect={ghost.startRect}
          endX={window.innerWidth - 200}
          endY={40}
          onComplete={() => setGhost(null)}
          className="rounded-[var(--control-radius-lg)] bg-background overflow-hidden"
          style={{ border: 'var(--border-width) solid var(--border)' }}
        >
          <div className="px-4 py-3 text-ui-sm text-foreground truncate max-w-[300px]">
            {ghost.text}
          </div>
        </GhostElement>
      )}
    </>
  );
});
