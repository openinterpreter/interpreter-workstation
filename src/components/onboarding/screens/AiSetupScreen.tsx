import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Mic } from 'lucide-react';

import { interpreterOverlay } from '@/ipc';
import {
  parseOnboardingInterviewDraft,
  type OnboardingInterviewAnswers,
} from '../../../../shared/types/onboardingState';
import { getOnboardingState } from '../../../api';
import { Button } from '../../ui/button';
import { Textarea } from '../../ui/textarea';
import { OnboardingHeading, OnboardingScreenShell } from '../components/OnboardingScreenShell';
import { useOnboarding } from '../OnboardingContext';

interface AiSetupScreenProps {
  onComplete: (answers: OnboardingInterviewAnswers) => void | Promise<void>;
}

const OVERLAY_NOT_READY_ERROR = 'Interpreter Overlay is not ready.';
const OVERLAY_READY_RETRY_ATTEMPTS = 50;
const OVERLAY_READY_RETRY_DELAY_MS = 100;

function waitForOverlayRetry(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, OVERLAY_READY_RETRY_DELAY_MS);
  });
}

async function startOnboardingVoiceInterview(): Promise<string | null> {
  for (let attempt = 0; attempt < OVERLAY_READY_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const result = await interpreterOverlay.startWindowVoiceMode({
        sessionKind: 'onboarding_voice_interview',
      });
      if (result.success) return null;
      if (result.error !== OVERLAY_NOT_READY_ERROR) {
        return result.error || 'Unable to start the voice interview.';
      }
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }

    await waitForOverlayRetry();
  }

  return OVERLAY_NOT_READY_ERROR;
}

export function AiSetupScreen({ onComplete }: AiSetupScreenProps) {
  const { t } = useTranslation();
  const { currentStep, setFooterConfig } = useOnboarding();
  const stepRef = useRef(currentStep);
  const [modelsUsed, setModelsUsed] = useState('');
  const [aiUseToday, setAiUseToday] = useState('');
  const [currentSetup, setCurrentSetup] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isVoiceInterviewStarting, setIsVoiceInterviewStarting] = useState(false);
  const [voiceInterviewActive, setVoiceInterviewActive] = useState(false);
  const [voiceInterviewError, setVoiceInterviewError] = useState<string | null>(null);
  const isSavingRef = useRef(false);
  const hasEditedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    getOnboardingState()
      .then(({ state }) => {
        if (cancelled || hasEditedRef.current || !state.interviewDraft.trim()) return;
        const answers = parseOnboardingInterviewDraft(state.interviewDraft);
        setModelsUsed(answers.modelsUsed);
        setAiUseToday(answers.aiUseToday);
        setCurrentSetup(answers.currentSetup);
      })
      .catch((error) => {
        console.error('[Onboarding] Failed to load AI setup draft:', error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return interpreterOverlay.onOnboardingVoiceInterviewCompleted((answers) => {
      hasEditedRef.current = true;
      setModelsUsed(answers.modelsUsed);
      setAiUseToday(answers.aiUseToday);
      setCurrentSetup(answers.currentSetup);
      setVoiceInterviewActive(false);
      setVoiceInterviewError(null);
    });
  }, []);

  const handleModelsUsedChange = (value: string) => {
    hasEditedRef.current = true;
    setModelsUsed(value);
  };

  const handleAiUseTodayChange = (value: string) => {
    hasEditedRef.current = true;
    setAiUseToday(value);
  };

  const handleCurrentSetupChange = (value: string) => {
    hasEditedRef.current = true;
    setCurrentSetup(value);
  };

  const handleStartVoiceInterview = useCallback(async () => {
    if (isVoiceInterviewStarting || voiceInterviewActive) return;
    setIsVoiceInterviewStarting(true);
    setVoiceInterviewError(null);
    const startError = await startOnboardingVoiceInterview();
    setIsVoiceInterviewStarting(false);
    if (startError) {
      setVoiceInterviewError(startError);
    } else {
      setVoiceInterviewActive(true);
    }
  }, [isVoiceInterviewStarting, voiceInterviewActive]);

  const handleContinue = useCallback(async () => {
    if (isSavingRef.current) return;
    isSavingRef.current = true;
    setIsSaving(true);
    let submitError: unknown;
    try {
      await onComplete({ modelsUsed, aiUseToday, currentSetup });
    } catch (error) {
      submitError = error;
    }
    isSavingRef.current = false;
    setIsSaving(false);
    if (submitError) throw submitError;
  }, [aiUseToday, currentSetup, modelsUsed, onComplete]);

  useEffect(() => {
    setFooterConfig({
      step: stepRef.current,
      continueLabel: t('onboarding.nav.continue'),
      continueAction: () => { void handleContinue(); },
      continueLoading: isSaving,
    });
  }, [handleContinue, isSaving, setFooterConfig, t]);

  return (
    <OnboardingScreenShell size="medium" align="top">
      <div className="space-y-5">
        <OnboardingHeading
          title={t('onboarding.aiSetup.title')}
          description={t('onboarding.aiSetup.description')}
          align="left"
        />

        <div className="space-y-4">
          <div className="space-y-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => { void handleStartVoiceInterview(); }}
              disabled={isVoiceInterviewStarting || voiceInterviewActive}
            >
              {isVoiceInterviewStarting ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Mic className="size-3.5" />
              )}
              {voiceInterviewActive
                ? t('onboarding.aiSetup.voiceButtonActive')
                : t('onboarding.aiSetup.voiceButton')}
            </Button>
            {voiceInterviewError && (
              <p className="text-ui-xs text-[var(--oa-danger)]">
                {voiceInterviewError}
              </p>
            )}
          </div>

          <label className="block space-y-2">
            <span className="text-ui-sm font-medium text-[var(--oa-text-strong)]">
              {t('onboarding.aiSetup.modelsLabel')}
            </span>
            <Textarea
              value={modelsUsed}
              onChange={(event) => handleModelsUsedChange(event.target.value)}
              placeholder={t('onboarding.aiSetup.modelsPlaceholder')}
              rows={3}
              className="min-h-[88px]"
            />
          </label>

          <label className="block space-y-2">
            <span className="text-ui-sm font-medium text-[var(--oa-text-strong)]">
              {t('onboarding.aiSetup.useLabel')}
            </span>
            <Textarea
              value={aiUseToday}
              onChange={(event) => handleAiUseTodayChange(event.target.value)}
              placeholder={t('onboarding.aiSetup.usePlaceholder')}
              rows={3}
              className="min-h-[88px]"
            />
          </label>

          <label className="block space-y-2">
            <span className="text-ui-sm font-medium text-[var(--oa-text-strong)]">
              {t('onboarding.aiSetup.setupLabel')}
            </span>
            <Textarea
              value={currentSetup}
              onChange={(event) => handleCurrentSetupChange(event.target.value)}
              placeholder={t('onboarding.aiSetup.setupPlaceholder')}
              rows={3}
              className="min-h-[88px]"
            />
          </label>
        </div>
      </div>
    </OnboardingScreenShell>
  );
}
