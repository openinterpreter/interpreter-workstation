/**
 * FeedbackScreen (Screen 11 - Final Screen)
 *
 * Final onboarding screen with thank-you copy.
 * The feedback affordance is rendered globally as a lower-left onboarding toast.
 * The "Start" action is exposed via footerConfig so it appears as the Continue
 * button in the NavigationFooter.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { motion, useReducedMotion } from 'motion/react';
import { Bug } from 'lucide-react';
import { cn } from '@/lib/utils';
import { FEEDBACK_BUTTON_FLASH_EVENT, flashFeedbackButton } from '../../../utils/feedback';
import { Button } from '../../ui/button';
import { SIDEBAR_FOOTER_SECONDARY_BUTTON_CLASSNAME } from '../../sidebarFooterButtonStyles';
import { OnboardingHeading, OnboardingScreenShell } from '../components/OnboardingScreenShell';
import { useOnboarding } from '../OnboardingContext';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FeedbackScreenProps {
  /** Called when the user clicks "Start" to complete onboarding. */
  onComplete: () => void | Promise<boolean | void>;
  /** User name collected earlier in onboarding. */
  name: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function FeedbackScreen({ onComplete, name }: FeedbackScreenProps) {
  const { t } = useTranslation();
  const { currentStep, setFooterConfig } = useOnboarding();
  const stepRef = useRef(currentStep);
  const reducedMotion = useReducedMotion();
  const [showMockPulse, setShowMockPulse] = useState(false);

  const handleGetStarted = useCallback(async () => {
    const completionResult = await onComplete();
    if (completionResult === false) {
      return;
    }
  }, [onComplete]);

  useEffect(() => {
    const handleFlash = () => {
      setShowMockPulse(false);
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          setShowMockPulse(true);
        });
      });
    };

    window.addEventListener(FEEDBACK_BUTTON_FLASH_EVENT, handleFlash);
    return () => {
      window.removeEventListener(FEEDBACK_BUTTON_FLASH_EVENT, handleFlash);
    };
  }, []);

  useEffect(() => {
    const initialDelayMs = reducedMotion ? 240 : 820;
    const repeatDelayMs = reducedMotion ? 3600 : 4200;
    const initialTimer = window.setTimeout(() => {
      flashFeedbackButton();
    }, initialDelayMs);
    const repeatTimer = window.setInterval(() => {
      flashFeedbackButton();
    }, repeatDelayMs);

    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(repeatTimer);
    };
  }, [reducedMotion]);

  // Expose "Start" as the footer Continue button
  useEffect(() => {
    setFooterConfig({
      step: stepRef.current,
      continueLabel: t('onboarding.nav.start', 'Start'),
      continueAction: () => { void handleGetStarted(); },
    });
  }, [handleGetStarted, setFooterConfig, t]);

  return (
    <OnboardingScreenShell size="medium">
      <div className="space-y-6 text-center">
        <OnboardingHeading
          title={t('onboarding.feedback.title')}
          className="space-y-4"
        />

        <motion.div
          className="flex justify-center"
          initial={reducedMotion ? { opacity: 1, y: 0 } : { opacity: 0, y: -22, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={reducedMotion ? { duration: 0 } : { duration: 0.48, delay: 0.12, ease: [0.22, 1, 0.36, 1] }}
        >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn(
              SIDEBAR_FOOTER_SECONDARY_BUTTON_CLASSNAME,
              'pointer-events-none min-w-[108px] rounded-[12px] px-3',
              showMockPulse && 'feedback-button-onboarding-pulse',
            )}
            onAnimationEnd={() => setShowMockPulse(false)}
            style={{
              boxShadow: '0 22px 42px -28px oklch(from var(--foreground) l c h / 0.28)',
            }}
          >
            <Bug />
            {t('feedback.button')}
          </Button>
        </motion.div>

        <div className="mx-auto max-w-[42rem] space-y-3 text-center text-[15px] leading-7 text-[var(--oa-text-muted)]">
          <p>
            <Trans
              i18nKey="onboarding.feedback.descriptionIntro"
              components={{
                strong: <strong className="font-semibold text-[var(--oa-text-strong)]" />,
              }}
            />
          </p>
          <p>{t('onboarding.feedback.descriptionResponseTime')}</p>
        </div>

        <p className="mx-auto max-w-[28rem] pt-3 text-[15px] leading-7 text-[var(--oa-text-muted)]">
          {t('onboarding.feedback.thanks', { name })}
        </p>
      </div>
    </OnboardingScreenShell>
  );
}
