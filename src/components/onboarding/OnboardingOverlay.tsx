/**
 * OnboardingOverlay
 *
 * Full-screen overlay at z-50 that orchestrates the entire onboarding flow.
 * Renders the correct screen based on the current step from OnboardingContext,
 * animates transitions between screens using AnimatePresence, and includes
 * the ProgressBar and NavigationFooter.
 *
 * Wrapped in OnboardingProvider to supply context to all child components.
 */

import { useState, useEffect, useCallback, useMemo, useRef, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { Table2, FileDown, FileEdit, FileText } from 'lucide-react';

import { OnboardingProvider, useOnboarding } from './OnboardingContext';
import type { OnboardingBucket } from './OnboardingContext';
import { useEnvironmentDetection } from './hooks/useEnvironmentDetection';
import { useOnboardingNavigation } from './hooks/useOnboardingNavigation';
import { NavigationFooter } from './components/NavigationFooter';
import { ONBOARDING_TOUR_VIDEO_URLS } from './tourVideos';
import {
  ENABLED_ONBOARDING_STEP_INDICES,
  getOnboardingStepId,
  getOnboardingStepTelemetryName,
  ONBOARDING_STEP_INDEX,
  ONBOARDING_STEPS_WITHOUT_BUCKET_INDICES,
  resolveNextIncompleteOnboardingStepIndex,
  TOTAL_ONBOARDING_STEPS,
} from './onboardingSteps';

// Screens
import { NameScreen } from './screens/NameScreen';
import { PrivacyScreen } from './screens/PrivacyScreen';
import { BucketScreen } from './screens/BucketScreen';
import { FeatureCardSlide } from './screens/FeatureCardSlide';
import { ToolAddonsScreen } from './screens/ToolAddonsScreen';
import { ModelPackReviewScreen } from './screens/ModelPackReviewScreen';
import { InterpreterCreditsLoadedScreen } from './screens/InterpreterCreditsLoadedScreen';
import { ModelSetupScreen, type ModelPackReviewState } from './screens/ModelSetupScreen';
import { StayConnectedScreen } from './screens/StayConnectedScreen';
import { FeedbackScreen } from './screens/FeedbackScreen';
import { WorkspaceChoiceScreen } from './screens/WorkspaceChoiceScreen';
import { AiSetupScreen } from './screens/AiSetupScreen';
import { OverlayFirstUseScreen } from './screens/OverlayFirstUseScreen';
import { OverlayPermissionsScreen } from './screens/OverlayPermissionsScreen';
import { useInterpreterTokenUsage } from '../../hooks/useInterpreterTokenUsage';
import type { ProfilesResponse } from '../../api';
import type { UsageBreakdownSummaryResponse } from '../../../shared/types/usageBreakdown';
import { INTERPRETER_STARTER_CREDITS } from '../../../shared/constants/interpreter-plans';
import {
  buildOnboardingImportedToolSummary,
  buildOnboardingInterviewResult,
  type OnboardingInterviewAnswers,
} from '../../../shared/types/onboardingState';

// API / IPC
import { getOnboardingState, setOnboardingState, setUserName, getUserName, getProfiles } from '../../api';
import {
  telemetry as telemetryIpc,
  userEmail as userEmailIpc,
  newsletter as newsletterIpc,
  theme as themeIpc,
  showContextMenu,
  type ContextMenuItem,
} from '../../ipc';
import { useAuth } from '../../contexts/AuthContext';
import { distributionProductConfig, hasNewsletter } from '../../../shared/productConfig';

// ============================================================================
// Constants
// ============================================================================

const TOTAL_STEPS = TOTAL_ONBOARDING_STEPS;

const STEP_NAME = ONBOARDING_STEP_INDEX.name;
const STEP_PRIVACY = ONBOARDING_STEP_INDEX.privacy;
const STEP_BUCKET = ONBOARDING_STEP_INDEX.bucket;
const STEP_FEATURE_1 = ONBOARDING_STEP_INDEX['feature-1'];
const STEP_FEATURE_2 = ONBOARDING_STEP_INDEX['feature-2'];
const STEP_FEATURE_3 = ONBOARDING_STEP_INDEX['feature-3'];
const STEP_FEATURE_4 = ONBOARDING_STEP_INDEX['feature-4'];
const STEP_TOOL_ADDONS = ONBOARDING_STEP_INDEX['tool-addons'];
const STEP_OVERLAY_FIRST_USE = ONBOARDING_STEP_INDEX['overlay-first-use'];
const STEP_OVERLAY_PERMISSIONS = ONBOARDING_STEP_INDEX['overlay-permissions'];
const STEP_MODEL_SETUP = ONBOARDING_STEP_INDEX['model-setup'];
const STEP_MODEL_REVIEW = ONBOARDING_STEP_INDEX['model-review'];
const STEP_MODEL_CREDITS = ONBOARDING_STEP_INDEX['model-credits'];
const STEP_STAY_CONNECTED = ONBOARDING_STEP_INDEX['stay-connected'];
const STEP_WORKSPACE_CHOICE = ONBOARDING_STEP_INDEX['workspace-choice'];
const STEP_AI_SETUP = ONBOARDING_STEP_INDEX['ai-setup'];
const STEP_FEEDBACK = ONBOARDING_STEP_INDEX.feedback;

const ENABLED_STEPS = ENABLED_ONBOARDING_STEP_INDICES;
const STEPS_WITHOUT_BUCKET = ONBOARDING_STEPS_WITHOUT_BUCKET_INDICES;
const ONBOARDING_PROFILE_LOAD_TIMEOUT_MS = 1500;
const ONBOARDING_PROFILE_LOAD_MAX_ATTEMPTS = 3;

function hasNoChargedTokens(payload: UsageBreakdownSummaryResponse | null): boolean {
  return payload?.data?.totalChargedTokens === 0;
}

function withInterpreterCreditsStep(steps: number[], includeCreditsStep: boolean): number[] {
  if (includeCreditsStep) {
    return steps;
  }
  return steps.filter((step) => step !== STEP_MODEL_CREDITS);
}

function stepIdsForIndices(stepIndices: number[]): string[] {
  const stepIds: string[] = [];
  for (const stepIndex of stepIndices) {
    const stepId = getOnboardingStepId(stepIndex);
    if (stepId !== null) {
      stepIds.push(stepId);
    }
  }
  return stepIds;
}

// ============================================================================
// Helpers
// ============================================================================

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type LoadProfilesFn = () => Promise<ProfilesResponse>;

interface OnboardingCompletionGateOptions {
  timeoutMs?: number;
  maxAttempts?: number;
}

export type OnboardingCompletionGateResult =
  | { kind: 'allow-completion' }
  | { kind: 'require-model-setup'; reason: 'missing-profile' | 'profiles-unavailable' };

async function loadProfilesWithTimeout(
  loadProfiles: LoadProfilesFn,
  timeoutMs: number,
): Promise<ProfilesResponse> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      loadProfiles(),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error('Timed out while loading onboarding profiles.'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

export async function evaluateOnboardingCompletionGate(
  loadProfiles: LoadProfilesFn,
  options: OnboardingCompletionGateOptions = {},
): Promise<OnboardingCompletionGateResult> {
  const timeoutMs = options.timeoutMs ?? ONBOARDING_PROFILE_LOAD_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? ONBOARDING_PROFILE_LOAD_MAX_ATTEMPTS;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const { profiles } = await loadProfilesWithTimeout(loadProfiles, timeoutMs);
      return profiles.length > 0
        ? { kind: 'allow-completion' }
        : { kind: 'require-model-setup', reason: 'missing-profile' };
    } catch {
      continue;
    }
  }

  return { kind: 'require-model-setup', reason: 'profiles-unavailable' };
}

// ============================================================================
// Feature card definitions per bucket
// ============================================================================

interface FeatureCardDef {
  title: string;
  description: string;
  experimental?: boolean;
  placeholderIcon: React.ReactNode;
  placeholderColor: string;
  videoUrl?: string;
}

const DEVELOPER_FEATURES: FeatureCardDef[] = [
  {
    title: 'onboarding.features.markdown.title',
    description: 'onboarding.features.markdown.description',
    placeholderIcon: <FileText className="size-12 opacity-30" />,
    placeholderColor: 'bg-blue-500/10',
    videoUrl: ONBOARDING_TOUR_VIDEO_URLS[3],
  },
  {
    title: 'onboarding.features.pdf.title',
    description: 'onboarding.features.pdf.description',
    placeholderIcon: <FileDown className="size-12 opacity-30" />,
    placeholderColor: 'bg-red-500/10',
    videoUrl: ONBOARDING_TOUR_VIDEO_URLS[1],
  },
  {
    title: 'onboarding.features.spreadsheets.title',
    description: 'onboarding.features.spreadsheets.description',
    placeholderIcon: <Table2 className="size-12 opacity-30" />,
    placeholderColor: 'bg-green-500/10',
    videoUrl: ONBOARDING_TOUR_VIDEO_URLS[0],
  },
  {
    title: 'onboarding.features.word.title',
    description: 'onboarding.features.word.description',
    placeholderIcon: <FileEdit className="size-12 opacity-30" />,
    placeholderColor: 'bg-indigo-500/10',
    videoUrl: ONBOARDING_TOUR_VIDEO_URLS[2],
  },
];

const NON_DEVELOPER_FEATURES: FeatureCardDef[] = [
  {
    title: 'onboarding.features.markdown.title',
    description: 'onboarding.features.markdown.description',
    placeholderIcon: <FileText className="size-12 opacity-30" />,
    placeholderColor: 'bg-blue-500/10',
    videoUrl: ONBOARDING_TOUR_VIDEO_URLS[3],
  },
  {
    title: 'onboarding.features.pdf.title',
    description: 'onboarding.features.pdf.description',
    placeholderIcon: <FileDown className="size-12 opacity-30" />,
    placeholderColor: 'bg-red-500/10',
    videoUrl: ONBOARDING_TOUR_VIDEO_URLS[1],
  },
  {
    title: 'onboarding.features.spreadsheets.title',
    description: 'onboarding.features.spreadsheets.description',
    placeholderIcon: <Table2 className="size-12 opacity-30" />,
    placeholderColor: 'bg-green-500/10',
    videoUrl: ONBOARDING_TOUR_VIDEO_URLS[0],
  },
  {
    title: 'onboarding.features.notes.title',
    description: 'onboarding.features.notes.description',
    placeholderIcon: <FileText className="size-12 opacity-30" />,
    placeholderColor: 'bg-blue-500/10',
    videoUrl: ONBOARDING_TOUR_VIDEO_URLS[3],
  },
];

// ============================================================================
// Transition variants
//
// Transitions are embedded in each variant so that exit animations work
// correctly in motion v12's AnimatePresence.
// ============================================================================

const SLIDE_DURATION = 0.35;
const SLIDE_EASE: [number, number, number, number] = [0.4, 0, 0.2, 1];

const SCREEN_VARIANTS = {
  enter: (navigationDirection: 'forward' | 'backward') => ({
    x: navigationDirection === 'forward' ? '100%' : '-100%',
  }),
  center: {
    x: 0,
    transition: { x: { type: 'tween' as const, duration: SLIDE_DURATION, ease: SLIDE_EASE } },
  },
  exit: (navigationDirection: 'forward' | 'backward') => ({
    x: navigationDirection === 'forward' ? '-100%' : '100%',
    transition: { x: { type: 'tween' as const, duration: SLIDE_DURATION, ease: SLIDE_EASE } },
  }),
};

// ============================================================================
// Inner overlay content (needs to be inside OnboardingProvider)
// ============================================================================

interface OnboardingOverlayContentProps {
  onComplete: () => void;
}

type ThemeOption = 'light' | 'dark' | 'system';

function OnboardingOverlayContent({ onComplete }: OnboardingOverlayContentProps) {
  "use no memo";

  const { t } = useTranslation();
  const {
    currentStep,
    direction,
    goToStep,
    goForward,
    updateUserChoices,
    completeOnboarding,
    detectionResults,
    isDetectionComplete,
    setActiveSteps,
    userChoices,
  } = useOnboarding();
  const { user, session } = useAuth();
  const { totalCredits } = useInterpreterTokenUsage();
  const [showInterpreterCreditsStep, setShowInterpreterCreditsStep] = useState(false);
  const restoredStepFromProgressRef = useRef(false);

  // Track every onboarding step transition
  useEffect(() => {
    const stepName = getOnboardingStepTelemetryName(currentStep);
    telemetryIpc.track('onboarding_step_viewed', { step: stepName, stepIndex: currentStep }, undefined).catch(() => {});
  }, [currentStep]);

  // Kick off silent environment detection
  useEnvironmentDetection();

  // Derive the bucket (from detection or user choice)
  const bucket: OnboardingBucket = useMemo(() => {
    if (userChoices.bucket) return userChoices.bucket;
    if (detectionResults?.bucket) return detectionResults.bucket;
    return 'non-developer';
  }, [userChoices.bucket, detectionResults?.bucket]);

  // Feature cards for the current bucket
  const featureCards = useMemo(
    () => (bucket === 'non-developer' ? NON_DEVELOPER_FEATURES : DEVELOPER_FEATURES),
    [bucket],
  );

  const activeStepIndices = useMemo(() => {
    const steps = isDetectionComplete && detectionResults?.isConfident
      ? STEPS_WITHOUT_BUCKET
      : ENABLED_STEPS;
    return withInterpreterCreditsStep(steps, showInterpreterCreditsStep);
  }, [detectionResults?.isConfident, isDetectionComplete, showInterpreterCreditsStep]);

  useEffect(() => {
    setActiveSteps(activeStepIndices);
  }, [activeStepIndices, setActiveSteps]);

  useEffect(() => {
    if (restoredStepFromProgressRef.current || !isDetectionComplete) return;
    restoredStepFromProgressRef.current = true;
    getOnboardingState()
      .then(({ state }) => {
        const resumedStep = resolveNextIncompleteOnboardingStepIndex(
          activeStepIndices,
          state.completedStepIds,
        );
        if (resumedStep === null || resumedStep === currentStep) {
          return;
        }
        goToStep(resumedStep);
      })
      .catch((error) => {
        console.error('[Onboarding] Failed to restore onboarding progress:', error);
      });
  }, [activeStepIndices, currentStep, goToStep, isDetectionComplete]);

  useEffect(() => {
    if (!isDetectionComplete || !detectionResults) return;
    if (detectionResults.isConfident) {
      updateUserChoices({ bucket: detectionResults.bucket });
    }
  }, [detectionResults, isDetectionComplete, updateUserChoices]);

  useEffect(() => {
    if (!isDetectionComplete || !detectionResults) return;

    const importedToolSummary = buildOnboardingImportedToolSummary({
      detectedProviders: detectionResults.detectedProviders,
      detectedTools: detectionResults.detectedTools,
      detectedConfigDirs: detectionResults.detectedConfigDirs,
      detectedApps: detectionResults.detectedApps,
      generatedAt: new Date().toISOString(),
    });

    getOnboardingState()
      .then(({ state }) => {
        if (
          state.importedToolSummary.summary === importedToolSummary.summary &&
          state.importedToolSummary.sources.join('\n') === importedToolSummary.sources.join('\n')
        ) {
          return;
        }
        return setOnboardingState({
          ...state,
          importedToolSummary,
        });
      })
      .catch((error) => {
        console.error('[Onboarding] Failed to persist imported tool summary:', error);
      });
  }, [detectionResults, isDetectionComplete]);

  useEffect(() => {
    const currentStepPosition = activeStepIndices.indexOf(currentStep);
    if (currentStepPosition <= 0) return;

    const completedStepIds = stepIdsForIndices(activeStepIndices.slice(0, currentStepPosition));
    if (completedStepIds.length === 0) return;

    getOnboardingState()
      .then(({ state }) => {
        const nextCompletedStepIds = Array.from(new Set([
          ...state.completedStepIds,
          ...completedStepIds,
        ]));
        if (nextCompletedStepIds.length === state.completedStepIds.length) {
          return;
        }
        return setOnboardingState({
          ...state,
          completedStepIds: nextCompletedStepIds,
        });
      })
      .catch((error) => {
        console.error('[Onboarding] Failed to persist onboarding progress:', error);
      });
  }, [activeStepIndices, currentStep]);

  // Load initial name for pre-population
  const [initialName, setInitialName] = useState<string>('');
  const [modelPackReviewState, setModelPackReviewState] = useState<ModelPackReviewState | null>(null);
  useEffect(() => {
    getUserName()
      .then((data) => {
        if (data.userName) setInitialName(data.userName);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (currentStep === STEP_MODEL_REVIEW && !modelPackReviewState) {
      goToStep(STEP_MODEL_SETUP);
    }
  }, [currentStep, goToStep, modelPackReviewState]);

  // Right-click anywhere during onboarding to quickly change app theme.
  const handleOverlayContextMenu = useCallback(async (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();

    let activeTheme: ThemeOption = 'system';
    try {
      const response = await themeIpc.get();
      activeTheme = response.theme;
    } catch (error) {
      console.error('[Onboarding] Failed to load theme for context menu:', error);
    }

    const items: ContextMenuItem[] = [
      {
        label: t('onboarding.theme.label'),
        action: 'theme',
        submenu: [
          { label: activeTheme === 'light' ? t('onboarding.theme.lightCurrent') : t('onboarding.theme.light'), action: 'theme-light' },
          { label: activeTheme === 'dark' ? t('onboarding.theme.darkCurrent') : t('onboarding.theme.dark'), action: 'theme-dark' },
          { label: activeTheme === 'system' ? t('onboarding.theme.systemCurrent') : t('onboarding.theme.system'), action: 'theme-system' },
        ],
      },
    ];

    const action = await showContextMenu(items, 'onboarding_theme');
    if (!action || !action.startsWith('theme-')) {
      return;
    }

    const nextTheme = action.replace('theme-', '') as ThemeOption;
    if (!['light', 'dark', 'system'].includes(nextTheme)) {
      return;
    }

    try {
      await themeIpc.set(nextTheme);
    } catch (error) {
      console.error('[Onboarding] Failed to set theme from context menu:', error);
    }
  }, [t]);

  // ---- Screen callbacks ----

  const handleNameSubmit = useCallback(
    async (name: string) => {
      await setUserName(name);
      updateUserChoices({ name });
      goForward();
    },
    [updateUserChoices, goForward],
  );

  // Privacy + Bucket callbacks include a 300ms delay so the user sees their
  // selection state before the slide transitions away.
  const handlePrivacySelect = useCallback(
    async (telemetryEnabled: boolean) => {
      await telemetryIpc.set(telemetryEnabled);
      updateUserChoices({ telemetryEnabled });
      telemetryIpc.trackOnboarding('privacy_completed', { telemetryEnabled }).catch(() => {});
      await delay(300);
      goForward();
    },
    [updateUserChoices, goForward],
  );

  const handleBucketSelect = useCallback(
    async (selectedBucket: OnboardingBucket) => {
      updateUserChoices({ bucket: selectedBucket });
      telemetryIpc.track('onboarding_bucket_selected', { bucket: selectedBucket }, undefined).catch(() => {});
      await delay(300);
      goForward();
    },
    [updateUserChoices, goForward],
  );

  const handleEmailSubmit = useCallback(
    (email: string) => {
      updateUserChoices({ email });
      userEmailIpc.set(email).catch(() => {});
    },
    [updateUserChoices],
  );

  const handleNewsletterSubscribe = useCallback(async (email: string): Promise<void> => {
    await newsletterIpc.subscribe(email);
  }, []);

  const handleOnboardingComplete = useCallback(async (): Promise<boolean> => {
    const completionGate = await evaluateOnboardingCompletionGate(getProfiles);
    if (completionGate.kind === 'require-model-setup') {
      goToStep(STEP_MODEL_SETUP);
      return false;
    }

    telemetryIpc.trackOnboarding('onboarding_completed', {}).catch(() => {});
    const { state } = await getOnboardingState();
    await setOnboardingState({
      ...state,
      completed: true,
      completedStepIds: stepIdsForIndices(activeStepIndices),
    });
    completeOnboarding();
    onComplete();
    return true;
  }, [activeStepIndices, completeOnboarding, goToStep, onComplete]);

  const handleWorkspaceChoiceFinish = useCallback(() => {
    goToStep(STEP_FEEDBACK);
  }, [goToStep]);

  const handleAiSetupComplete = useCallback(async (answers: OnboardingInterviewAnswers) => {
    const { interviewDraft, interviewResult } = buildOnboardingInterviewResult(
      answers,
      new Date().toISOString(),
    );
    const { state } = await getOnboardingState();
    await setOnboardingState({
      ...state,
      interviewDraft,
      interviewResult,
    });
    goToStep(STEP_MODEL_SETUP);
  }, [goToStep]);

  const handleSkipFeatureOverview = useCallback(() => {
    const stepName = getOnboardingStepTelemetryName(currentStep);
    telemetryIpc.track('onboarding_tour_skipped', { skippedAt: stepName, stepIndex: currentStep }, undefined).catch(() => {});
    goToStep(STEP_TOOL_ADDONS);
  }, [currentStep, goToStep]);

  const handleOpenModelPackReview = useCallback((nextReviewState: ModelPackReviewState) => {
    setShowInterpreterCreditsStep(false);
    setModelPackReviewState(nextReviewState);
    goToStep(STEP_MODEL_REVIEW);
  }, [goToStep]);

  const resolveInterpreterCreditsIntroEligibility = useCallback(async (): Promise<boolean> => {
    const billingApiBaseUrl = distributionProductConfig.billingApiBaseUrl.trim().replace(/\/+$/, '');
    if (!billingApiBaseUrl) {
      return false;
    }
    if (!user?.id || !session?.access_token) {
      return false;
    }
    if (typeof totalCredits !== 'number' || !Number.isFinite(totalCredits)) {
      return false;
    }
    if (Math.round(totalCredits) !== INTERPRETER_STARTER_CREDITS) {
      return false;
    }

    try {
      const response = await fetch(`${billingApiBaseUrl}/v0/stripe/usage_breakdown_summary`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': session.access_token,
        },
        body: JSON.stringify({ userId: user.id }),
      });

      let payload: UsageBreakdownSummaryResponse | null = null;
      try {
        payload = await response.json() as UsageBreakdownSummaryResponse;
      } catch (parseError) {
        console.error('[Onboarding] Failed to parse usage breakdown response:', parseError);
      }

      if (!response.ok) {
        console.error('[Onboarding] Failed to load usage breakdown for credits intro eligibility:', {
          status: response.status,
          payload,
        });
        return false;
      }

      return hasNoChargedTokens(payload);
    } catch (error) {
      console.error('[Onboarding] Failed to determine usage breakdown credits intro eligibility:', error);
      return false;
    }
  }, [session, totalCredits, user]);

  const handleModelPackReviewComplete = useCallback(async (packId: ModelPackReviewState['packId']) => {
    if (packId === 'hosted') {
      const canShowInterpreterCreditsIntro = await resolveInterpreterCreditsIntroEligibility();
      if (canShowInterpreterCreditsIntro) {
        setShowInterpreterCreditsStep(true);
        setModelPackReviewState(null);
        goToStep(STEP_MODEL_CREDITS);
        return;
      }
    }
    setShowInterpreterCreditsStep(false);
    setModelPackReviewState(null);
    goForward();
  }, [goForward, goToStep, resolveInterpreterCreditsIntroEligibility]);

  const handleInterpreterCreditsContinue = useCallback(() => {
    goForward();
  }, [goForward]);

  // Centralized Enter handling for simple "advance" slides.
  const handleGlobalEnterAdvance = useCallback(() => {
    switch (currentStep) {
      case STEP_FEATURE_1:
      case STEP_FEATURE_2:
      case STEP_FEATURE_3:
      case STEP_FEATURE_4:
      case STEP_TOOL_ADDONS:
      case STEP_OVERLAY_FIRST_USE:
        goForward();
        return;
      case STEP_FEEDBACK:
        void handleOnboardingComplete();
        return;
      default:
        return;
    }
  }, [currentStep, goForward, handleOnboardingComplete]);

  useOnboardingNavigation({
    enabled: [
      STEP_FEATURE_1,
      STEP_FEATURE_2,
      STEP_FEATURE_3,
      STEP_FEATURE_4,
      STEP_TOOL_ADDONS,
      STEP_OVERLAY_FIRST_USE,
    ].includes(currentStep),
    canAdvance: true,
    onEnter: handleGlobalEnterAdvance,
    allowEnterFromInteractive: false,
  });

  // ---- Render correct screen ----

  const renderScreen = (stepToRender: number) => {
    switch (stepToRender) {
      case STEP_NAME:
        return <NameScreen onNext={handleNameSubmit} initialName={initialName} />;
      case STEP_PRIVACY:
        return <PrivacyScreen onNext={handlePrivacySelect} />;
      case STEP_BUCKET:
        return <BucketScreen onNext={handleBucketSelect} />;

      // Individual feature card slides
      case STEP_FEATURE_1:
        return (
          <FeatureCardSlide
            {...featureCards[0]}
            title={t(featureCards[0].title)}
            description={t(featureCards[0].description)}
            onNext={goForward}
            onSkipTour={handleSkipFeatureOverview}
          />
        );
      case STEP_FEATURE_2:
        return (
          <FeatureCardSlide
            {...featureCards[1]}
            title={t(featureCards[1].title)}
            description={t(featureCards[1].description)}
            onNext={goForward}
            onSkipTour={handleSkipFeatureOverview}
          />
        );
      case STEP_FEATURE_3:
        return (
          <FeatureCardSlide
            {...featureCards[2]}
            title={t(featureCards[2].title)}
            description={t(featureCards[2].description)}
            onNext={goForward}
            onSkipTour={handleSkipFeatureOverview}
          />
        );
      case STEP_FEATURE_4:
        return (
          <FeatureCardSlide
            {...featureCards[3]}
            title={t(featureCards[3].title)}
            description={t(featureCards[3].description)}
            onNext={goForward}
            onSkipTour={handleSkipFeatureOverview}
          />
        );
      case STEP_TOOL_ADDONS:
        return (
          <ToolAddonsScreen
            onNext={goForward}
            bucket={bucket}
          />
        );
      case STEP_OVERLAY_FIRST_USE:
        return <OverlayFirstUseScreen onNext={goForward} />;
      case STEP_OVERLAY_PERMISSIONS:
        return <OverlayPermissionsScreen onNext={goForward} />;
      case STEP_MODEL_SETUP:
        return <ModelSetupScreen onOpenPackReview={handleOpenModelPackReview} />;
      case STEP_MODEL_REVIEW:
        return (
          <ModelPackReviewScreen
            reviewState={modelPackReviewState}
            onReviewComplete={handleModelPackReviewComplete}
          />
        );
      case STEP_MODEL_CREDITS:
        return (
          <InterpreterCreditsLoadedScreen
            onNext={handleInterpreterCreditsContinue}
          />
        );
      case STEP_STAY_CONNECTED:
        return (
          <StayConnectedScreen
            authenticatedEmail={user?.email ?? undefined}
            onEmailSubmit={handleEmailSubmit}
            onNewsletterSubscribe={hasNewsletter() ? handleNewsletterSubscribe : undefined}
            onNext={goForward}
          />
        );
      case STEP_WORKSPACE_CHOICE:
        return <WorkspaceChoiceScreen onFinish={handleWorkspaceChoiceFinish} />;
      case STEP_AI_SETUP:
        return <AiSetupScreen onComplete={handleAiSetupComplete} />;
      case STEP_FEEDBACK:
        return (
          <FeedbackScreen
            onComplete={handleOnboardingComplete}
            name={userChoices.name}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 overflow-hidden"
      style={{
        backgroundColor: 'color-mix(in srgb, var(--oa-bg-app) 92%, transparent)',
      }}
      onContextMenu={handleOverlayContextMenu}
    >
      <div
        className="pointer-events-auto flex h-full w-full items-center justify-center overflow-hidden px-5 pb-5 sm:px-6 sm:pb-6 lg:px-8"
        style={{ paddingTop: 'calc(var(--unit-height) + 10px)' }}
      >
        <div
          className="flex h-full w-full max-w-[920px] min-h-0 flex-col overflow-hidden rounded-[28px]"
          style={{
            height: 'min(640px, calc(100vh - var(--unit-height) - 30px))',
            border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border) 82%, transparent)',
            backgroundColor: 'color-mix(in srgb, var(--oa-bg-app) 94%, transparent)',
            boxShadow: '0 18px 48px -30px var(--shadow-color)',
          }}
        >
          <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="relative flex-1 min-h-0 overflow-hidden">
              <MotionConfig reducedMotion="never">
                <AnimatePresence initial={false} custom={direction}>
                  <motion.div
                    key={currentStep}
                    custom={direction}
                    variants={SCREEN_VARIANTS}
                    initial="enter"
                    animate="center"
                    exit="exit"
                    className="absolute inset-0 h-full w-full overflow-hidden"
                  >
                    <div className="h-full w-full overflow-y-auto">
                      {renderScreen(currentStep)}
                    </div>
                  </motion.div>
                </AnimatePresence>
              </MotionConfig>
            </div>

            <NavigationFooter />
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Public component (wraps content in OnboardingProvider)
// ============================================================================

interface OnboardingOverlayProps {
  /** Called when onboarding is complete and the overlay should begin its exit */
  onComplete: () => void;
}

export function OnboardingOverlay({ onComplete }: OnboardingOverlayProps) {
  return (
    <OnboardingProvider totalSteps={TOTAL_STEPS}>
      <OnboardingOverlayContent onComplete={onComplete} />
    </OnboardingProvider>
  );
}
