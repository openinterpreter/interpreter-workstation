import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Footprints, MessageSquare, Settings, Palette, Wrench, Plug, AudioLines, Volume2, Monitor, Globe, Shield } from 'lucide-react';
import { getRuntimeSystemInfo } from '@/ipc';
import { resetOnboardingState, resetRuntimeConfigFiles } from '../api';
import { isInterpreterOverlaySupportedPlatform } from '../../shared/constants/interpreter-overlay-platform';
import type { Profile } from '../../shared/types/profile';
import { APP_VERSION } from '../../shared/version';
import {
  GLOBAL_SETTINGS_VIEW_ID,
  SETTINGS_ERROR_CONTAINER_ID,
  SETTINGS_TAB_ID,
} from '../../shared/element-ids';
import { useSpatialNavigation } from '../hooks/useSpatialNavigation';

// Section content components
import { AccountSectionContent } from "./settings/AccountSection";
import { PlanSectionContent } from "./settings/PlanSection";
import { ProfilesSectionContent } from "./settings/ProfilesSection";
import { ToolsSectionContent } from "./settings/ToolsSection";
import { InboxSectionContent } from "./settings/InboxSection";
import { StyleSectionContent } from "./settings/StyleSection";
import { TelemetrySectionContent } from "./settings/TelemetrySection";
import { SettingsPane, SettingsSection } from "./settings/SettingsSection";
import { NativeToolsSection } from "./settings/NativeToolsSection";
import { EditorSectionContent } from './settings/EditorSection';
import { ExtensionsSectionContent } from './settings/ExtensionsSection';
import { LanguageSectionContent } from './settings/LanguageSection';
import { TextToSpeechSectionContent } from './settings/TextToSpeechSection';
import { SoundsSectionContent } from './settings/SoundsSection';
import { SpeechToTextSectionContent, VoiceModesOverviewCard } from './settings/SpeechToTextSection';
import { McpSettingsSectionContent } from './settings/McpSettingsSection';
import { Button } from './ui/button';
import { buildVerticalEdgeMask } from './ui/ProgressiveBlurOverlay';
import { AppBehaviorSectionContent } from './settings/AppBehaviorSection';
import { CustomInstructionsSectionContent } from './settings/CustomInstructionsSection';
import { OverlaySectionContent, OverlaySectionIntroContent } from './settings/OverlaySection';
import { BrowserSectionContent } from './settings/BrowserSection';
import { useLayoutActions } from '../hooks/useLayout';
import {
  SETTINGS_SECTION_TO_TAB,
  SETTINGS_TABS,
  type SettingsTabId,
} from '../../shared/settingsCatalog';
import {
  trackSettingsSectionOpened,
  trackSettingsSectionClosed,
} from '../utils/telemetry';

interface GlobalSettingsProps {
  onProfileUpdate?: (profile: Profile) => void;
  initialSection?: string;
}

interface SettingsFocusSectionDetail {
  sectionId: string;
  blink?: boolean;
}

const TAB_INFO: Record<SettingsTabId, { icon: any }> = {
  general: { icon: Settings },
  models: { icon: MessageSquare },
  permissions: { icon: Shield },
  tools: { icon: Wrench },
  browser: { icon: Globe },
  extensions: { icon: Plug },
  textToSpeech: { icon: AudioLines },
  sounds: { icon: Volume2 },
  overlay: { icon: Monitor },
  inbox: { icon: Footprints },
  style: { icon: Palette },
};

const TAB_KEYS = SETTINGS_TABS.map((tab) => tab.id);
const SETTINGS_CONTENT_WIDTH = "720px";
const SETTINGS_HEADER_INSET = "3.75rem";
const SETTINGS_HEADER_FADE_TAIL = "32px";
const SETTINGS_FOCUS_SECTION_EVENT = 'settings:focus-section';
const SETTINGS_SECTION_BLINK_MS = 1500;

export function GlobalSettings({
  onProfileUpdate,
  initialSection,
}: GlobalSettingsProps) {
  "use no memo";

  const { t } = useTranslation();
  const { openSeededAgentTab } = useLayoutActions();
  const overlaySupported = isInterpreterOverlaySupportedPlatform(getRuntimeSystemInfo().platform);
  const overlayVisible = overlaySupported;
  const getInitialTab = (): SettingsTabId => {
    if (initialSection && SETTINGS_SECTION_TO_TAB[initialSection]) {
      if (SETTINGS_SECTION_TO_TAB[initialSection] === 'overlay' && !overlayVisible) {
        return 'general';
      }
      return SETTINGS_SECTION_TO_TAB[initialSection];
    }
    return "general";
  };

  const [activeTab, setActiveTab] =
    useState<SettingsTabId>(getInitialTab);

  // Track time-spent per settings tab: emit opened on enter, closed with
  // duration on tab switch or unmount.
  const sectionOpenedAtRef = useRef<{ tabId: SettingsTabId; at: number } | null>(null);
  useEffect(() => {
    const opened = { tabId: activeTab, at: Date.now() };
    trackSettingsSectionOpened({
      tabId: activeTab,
      sectionId: initialSection,
      source: sectionOpenedAtRef.current ? 'tab_switch' : 'initial',
    });
    const previous = sectionOpenedAtRef.current;
    sectionOpenedAtRef.current = opened;
    return () => {
      if (previous && previous.tabId !== opened.tabId) {
        // already emitted close when we switched to `opened`; nothing to do.
      }
      if (sectionOpenedAtRef.current?.tabId === activeTab) {
        trackSettingsSectionClosed({
          tabId: activeTab,
          sectionId: initialSection,
          durationMs: Date.now() - opened.at,
        });
      }
    };
  }, [activeTab, initialSection]);
  const [blinkProfiles, setBlinkProfiles] = useState(false);
  const [blinkSectionId, setBlinkSectionId] = useState<string | null>(null);
  const [openProfileId, setOpenProfileId] = useState<string | null>(null);
  const { containerRef } = useSpatialNavigation();
  const contentScrollRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const blinkSectionTimeoutRef = useRef<number | null>(null);
  const visibleTabKeys = TAB_KEYS.filter((key) => overlayVisible || key !== 'overlay');

  const scrollToSection = useCallback((sectionId: string) => {
    const container = contentScrollRef.current;
    if (!container) {
      return;
    }

    const target = container.querySelector<HTMLElement>(`[data-settings-section="${sectionId}"]`);
    if (!target) {
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const top = targetRect.top - containerRect.top + container.scrollTop - 12;
    container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }, []);

  const focusSection = useCallback((sectionId: string, options?: { blink?: boolean }) => {
    const nextTab = SETTINGS_SECTION_TO_TAB[sectionId];
    if (nextTab) {
      setActiveTab(nextTab === 'overlay' && !overlayVisible ? 'general' : nextTab);
    }

    const scrollSection = () => {
      window.requestAnimationFrame(() => {
        scrollToSection(sectionId);
      });
    };
    scrollSection();

    if (!options?.blink) {
      return;
    }

    if (blinkSectionTimeoutRef.current != null) {
      window.clearTimeout(blinkSectionTimeoutRef.current);
    }

    setBlinkSectionId(null);
    window.requestAnimationFrame(() => {
      setBlinkSectionId(sectionId);
    });
    blinkSectionTimeoutRef.current = window.setTimeout(() => {
      setBlinkSectionId((current) => (current === sectionId ? null : current));
      blinkSectionTimeoutRef.current = null;
    }, SETTINGS_SECTION_BLINK_MS);
  }, [overlayVisible, scrollToSection]);

  // Navigate to section when initialSection changes
  useEffect(() => {
    if (initialSection && SETTINGS_SECTION_TO_TAB[initialSection]) {
      focusSection(initialSection);
    }
  }, [focusSection, initialSection]);

  useEffect(() => {
    if (!overlayVisible && activeTab === 'overlay') {
      setActiveTab('general');
    }
  }, [activeTab, overlayVisible]);

  useEffect(() => {
    return () => {
      if (blinkSectionTimeoutRef.current != null) {
        window.clearTimeout(blinkSectionTimeoutRef.current);
      }
    };
  }, []);

  // Listen for blink-profiles event
  useEffect(() => {
    const handleBlinkProfiles = () => {
      setActiveTab("models");
      setBlinkProfiles(true);
      setTimeout(() => setBlinkProfiles(false), 1500);
    };
    window.addEventListener("settings:blink-profiles", handleBlinkProfiles);
    return () =>
      window.removeEventListener(
        "settings:blink-profiles",
        handleBlinkProfiles,
      );
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<SettingsFocusSectionDetail>).detail;
      if (!detail?.sectionId || !SETTINGS_SECTION_TO_TAB[detail.sectionId]) {
        return;
      }
      focusSection(detail.sectionId, { blink: detail.blink === true });
    };

    window.addEventListener(SETTINGS_FOCUS_SECTION_EVENT, handler);
    return () => window.removeEventListener(SETTINGS_FOCUS_SECTION_EVENT, handler);
  }, [focusSection]);

  // Listen for navigate-to-tools event
  useEffect(() => {
    const handleNavigateToTools = () => setActiveTab("tools");
    window.addEventListener(
      "settings:navigate-to-tools",
      handleNavigateToTools,
    );
    return () =>
      window.removeEventListener(
        "settings:navigate-to-tools",
        handleNavigateToTools,
      );
  }, []);

  // Listen for open-profile event
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setActiveTab("models");
      setOpenProfileId(detail.profileId);
    };
    window.addEventListener("settings:open-profile", handler);
    return () => window.removeEventListener("settings:open-profile", handler);
  }, []);

  // Reset & restart onboarding
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showRuntimeConfigResetConfirm, setShowRuntimeConfigResetConfirm] = useState(false);
  const [isResettingRuntimeConfigFiles, setIsResettingRuntimeConfigFiles] = useState(false);
  const [runtimeConfigResetSuccess, setRuntimeConfigResetSuccess] = useState(false);
  const [runtimeConfigResetError, setRuntimeConfigResetError] = useState<string | null>(null);
  const handleResetAndRestart = useCallback(async () => {
    await resetOnboardingState();
    // Tell App.tsx to re-enter onboarding immediately
    window.dispatchEvent(new Event("settings:restart-onboarding"));
  }, []);

  const handleResetRuntimeConfigFiles = useCallback(async () => {
    setIsResettingRuntimeConfigFiles(true);
    setRuntimeConfigResetSuccess(false);
    setRuntimeConfigResetError(null);

    try {
      const result = await resetRuntimeConfigFiles();
      if (!result.success) {
        const failure = result.files.find((entry) => entry.error);
        throw new Error(
          failure?.error || t('settings.general.resetRuntimeConfigsGenericError')
        );
      }

      setRuntimeConfigResetSuccess(true);
      setShowRuntimeConfigResetConfirm(false);
    } catch (error) {
      setRuntimeConfigResetError(error instanceof Error ? error.message : t('settings.general.resetRuntimeConfigsGenericError'));
    } finally {
      setIsResettingRuntimeConfigFiles(false);
    }
  }, [t]);

  const tabCatalogById = Object.fromEntries(SETTINGS_TABS.map((tab) => [tab.id, tab])) as Record<SettingsTabId, (typeof SETTINGS_TABS)[number]>;
  const currentPageTitle = t(tabCatalogById[activeTab].titleKey);
  const settingsViewportMask = buildVerticalEdgeMask({
    topFade: SETTINGS_HEADER_FADE_TAIL,
    bottomFade: "0px",
  });
  const navButtonBaseClassName =
    "relative flex w-full items-center gap-3 rounded-[10px] px-3 py-2 text-left text-[13px] leading-5 transition-[background-color,color,opacity] duration-150";
  const handleAskAgent = useCallback(() => {
    openSeededAgentTab('What settings can you change in this app?');
  }, [openSeededAgentTab]);

  return (
    <div
      ref={containerRef}
      className="h-full overflow-hidden bg-transparent"
      style={{
        backgroundColor: "transparent",
      }}
      data-testid={GLOBAL_SETTINGS_VIEW_ID}
    >
      <div className="hidden" data-testid={SETTINGS_ERROR_CONTAINER_ID} />

      <div className="mx-auto flex h-full min-h-0 w-full max-w-[1020px] gap-6 px-5 pt-5 max-[1100px]:gap-5 max-[1100px]:px-4 max-[900px]:gap-3.5 max-[900px]:px-3">
        <aside className="sticky top-0 self-start w-[180px] shrink-0 pt-1 max-[1100px]:w-[166px] max-[900px]:w-[150px]">
          <nav className="space-y-1.5">
            {visibleTabKeys.map((key) => {
              const { icon: Icon } = TAB_INFO[key];
              const isActive = activeTab === key;
              const tabCatalog = tabCatalogById[key];

              return (
                <button
                  key={key}
                  ref={(el) => {
                    tabRefs.current[key] = el;
                  }}
                  type="button"
                  onClick={() => setActiveTab(key)}
                  data-testid={SETTINGS_TAB_ID(key)}
                  data-help-title={t(tabCatalog.titleKey)}
                  data-help-description={t(tabCatalog.descriptionKey)}
                  className={[
                    navButtonBaseClassName,
                    isActive
                      ? "font-medium text-foreground hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                      : "text-muted-foreground hover:bg-black/[0.03] hover:text-foreground dark:hover:bg-white/[0.04]",
                  ].join(" ")}
                >
                  <Icon className="size-4 shrink-0" />
                  <span className="min-w-0 truncate">
                    {t(tabCatalog.titleKey)}
                  </span>
                </button>
              );
            })}
          </nav>
          <div className="mt-4">
            <Button
              type="button"
              variant="default"
              className="w-full justify-center"
              onClick={handleAskAgent}
            >
              Ask Agent
            </Button>
          </div>
        </aside>

        <section className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <header
            className="pointer-events-none absolute inset-x-0 top-0 z-20 pb-4 pt-1"
            style={{
              borderColor: "transparent",
            }}
          >
            <div className="mx-auto w-full px-5 sm:px-6" style={{ maxWidth: SETTINGS_CONTENT_WIDTH }}>
              <h1 className="text-[18px] font-medium tracking-[-0.01em] text-foreground">
                {currentPageTitle}
              </h1>
            </div>
          </header>

          <div
            ref={contentScrollRef}
            className="min-h-0 flex-1 overflow-y-auto pr-1 max-[900px]:pr-0"
            style={{
              paddingTop: SETTINGS_HEADER_INSET,
              maskImage: settingsViewportMask,
              WebkitMaskImage: settingsViewportMask,
              willChange: "transform",
            }}
          >
            <div
              className="mx-auto w-full pb-12 pt-1.5 max-[1100px]:pt-1"
              style={{ maxWidth: SETTINGS_CONTENT_WIDTH }}
            >
              <div className="space-y-0">
                {activeTab === "general" && (
                  <>
                  <div className="space-y-4">
                    <SettingsSection
                      title={t("settings.general.preferencesSection")}
                    >
                      {typeof window !== 'undefined' && !!window.electron && (
                        <AppBehaviorSectionContent />
                      )}
                      <LanguageSectionContent />
                      <EditorSectionContent />
                    </SettingsSection>

                    <SettingsSection title={t("settings.general.accountSection")}>
                      <AccountSectionContent />
                    </SettingsSection>

                    <SettingsSection
                      title={t("settings.general.subscriptionSection")}
                    >
                      <PlanSectionContent />
                    </SettingsSection>

                    <SettingsSection
                      title={t("settings.general.customInstructionsSection")}
                      description={t(
                        "settings.general.customInstructionsDescription",
                      )}
                    >
                      <CustomInstructionsSectionContent />
                    </SettingsSection>

                    <SettingsSection
                      title={t("settings.general.privacySection")}
                      sectionId="privacy"
                    >
                      <div data-settings-section="telemetry">
                        <TelemetrySectionContent />
                      </div>
                    </SettingsSection>

                    <SettingsSection
                      className="bg-[color-mix(in_srgb,var(--oa-bg-app,var(--background))_94%,var(--oa-bg-subtle,var(--muted))_6%)]"
                      contentClassName="px-5 py-0 sm:px-6"
                    >
                      <div className="py-2">
                        {!showResetConfirm ? (
                          <Button
                            onClick={() => setShowResetConfirm(true)}
                            variant="ghost"
                            className="justify-start px-0 text-sm text-destructive hover:bg-transparent hover:text-destructive"
                          >
                            {t("settings.general.resetOnboarding")}
                          </Button>
                        ) : (
                          <div className="flex items-center gap-4 max-[560px]:flex-col max-[560px]:items-start">
                            <div className="flex shrink-0 items-center gap-3">
                              <Button
                                onClick={handleResetAndRestart}
                                variant="destructive"
                                size="sm"
                              >
                                {t("common.confirm")}
                              </Button>
                              <Button
                                onClick={() => setShowResetConfirm(false)}
                                variant="outline"
                                size="sm"
                              >
                                {t("common.cancel")}
                              </Button>
                            </div>
                            <p className="min-w-0 flex-1 text-sm text-destructive text-pretty">
                              {t("settings.general.resetConfirmMessage")}
                            </p>
                          </div>
                        )}

                        <div className="mt-3 border-t border-border/60 pt-3">
                          {!showRuntimeConfigResetConfirm ? (
                            <Button
                              onClick={() => {
                                setRuntimeConfigResetSuccess(false);
                                setRuntimeConfigResetError(null);
                                setShowRuntimeConfigResetConfirm(true);
                              }}
                              variant="ghost"
                              className="justify-start px-0 text-sm text-destructive hover:bg-transparent hover:text-destructive"
                            >
                              {t('settings.general.resetRuntimeConfigs')}
                            </Button>
                          ) : (
                            <div className="flex items-center gap-4 max-[560px]:flex-col max-[560px]:items-start">
                              <div className="flex shrink-0 items-center gap-3">
                                <Button
                                  onClick={handleResetRuntimeConfigFiles}
                                  variant="destructive"
                                  size="sm"
                                  disabled={isResettingRuntimeConfigFiles}
                                >
                                  {isResettingRuntimeConfigFiles ? t('common.loading') : t("common.confirm")}
                                </Button>
                                <Button
                                  onClick={() => {
                                    setShowRuntimeConfigResetConfirm(false);
                                    setRuntimeConfigResetError(null);
                                  }}
                                  variant="outline"
                                  size="sm"
                                  disabled={isResettingRuntimeConfigFiles}
                                >
                                  {t("common.cancel")}
                                </Button>
                              </div>
                              <p className="min-w-0 flex-1 text-sm text-destructive text-pretty">
                                {t('settings.general.resetRuntimeConfigsConfirmMessage')}
                              </p>
                            </div>
                          )}

                          {runtimeConfigResetSuccess && (
                            <p className="mt-2 text-sm text-muted-foreground">
                              {t('settings.general.resetRuntimeConfigsSuccess')}
                            </p>
                          )}

                          {runtimeConfigResetError && (
                            <p className="mt-2 text-sm text-destructive text-pretty">
                              {runtimeConfigResetError}
                            </p>
                          )}
                        </div>
                      </div>
                    </SettingsSection>
                  </div>

                  <div className="mt-10 flex justify-center pb-2">
                    <span className="text-ui-sm text-muted-foreground">
                      {t("settings.general.versionLabel", { version: APP_VERSION })}
                    </span>
                  </div>
                  </>
                )}

                {activeTab === "models" && (
                  <ProfilesSectionContent
                    onProfileUpdate={onProfileUpdate}
                    selectedProfileId={openProfileId}
                    listClassName={blinkProfiles ? "animate-blink-border" : ""}
                  />
                )}

                {activeTab === "tools" && (
                  <SettingsPane>
                    <SettingsSection
                      title={t("settings.tabs.tools")}
                      contentClassName="px-5 py-5 sm:px-6"
                    >
                      <ToolsSectionContent />
                    </SettingsSection>
                  </SettingsPane>
                )}

                {activeTab === "permissions" && (
                  <SettingsPane>
                    <SettingsSection
                      title="MCP Permissions"
                      sectionId="mcpPermissions"
                    >
                      <McpSettingsSectionContent />
                    </SettingsSection>

                    <SettingsSection
                      title="Runtime Permissions"
                      sectionId="runtimePermissions"
                      className={blinkSectionId === 'runtimePermissions' ? 'animate-blink-border' : undefined}
                    >
                      <NativeToolsSection />
                    </SettingsSection>
                  </SettingsPane>
                )}

                {activeTab === "browser" && <BrowserSectionContent />}

                {activeTab === "extensions" && <ExtensionsSectionContent />}

                {activeTab === "inbox" && <InboxSectionContent />}

                {activeTab === "textToSpeech" && (
                  <SettingsPane>
                    <VoiceModesOverviewCard />

                    <SettingsSection title={t('settings.stt.title')}>
                      <SpeechToTextSectionContent />
                    </SettingsSection>

                    <SettingsSection title={t('settings.tts.title')}>
                      <TextToSpeechSectionContent />
                    </SettingsSection>
                  </SettingsPane>
                )}

                {activeTab === "sounds" && (
                  <SettingsPane>
                    <SettingsSection title={t('settings.tabs.sounds')}>
                      <SoundsSectionContent />
                    </SettingsSection>
                  </SettingsPane>
                )}

                {activeTab === "overlay" && (
                  <SettingsPane>
                    <SettingsSection>
                      <OverlaySectionIntroContent />
                    </SettingsSection>
                    <SettingsSection title={t('settings.tabs.overlay')}>
                      <OverlaySectionContent />
                    </SettingsSection>
                  </SettingsPane>
                )}

                {activeTab === "style" && <StyleSectionContent />}
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
