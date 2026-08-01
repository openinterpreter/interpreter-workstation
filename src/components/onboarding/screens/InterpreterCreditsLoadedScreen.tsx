import { useEffect, useMemo, useRef, useState } from 'react';
import { OnboardingHeading, OnboardingScreenShell } from '../components/OnboardingScreenShell';
import { useOnboarding } from '../OnboardingContext';
import { useInterpreterTokenUsage } from '../../../hooks/useInterpreterTokenUsage';
import { INTERPRETER_STARTER_CREDITS } from '../../../../shared/constants/interpreter-plans';

interface InterpreterCreditsLoadedScreenProps {
  onNext: () => void;
}

const CREDIT_CHARGE_START_DELAY_MS = 360;
const CREDIT_CHARGE_ANIMATION_MS = 2200;

function resolveCreditsLoaded(totalCredits: number | null): number {
  if (typeof totalCredits !== 'number' || !Number.isFinite(totalCredits)) {
    return INTERPRETER_STARTER_CREDITS;
  }
  return Math.max(INTERPRETER_STARTER_CREDITS, Math.round(totalCredits));
}

export function InterpreterCreditsLoadedScreen({ onNext }: InterpreterCreditsLoadedScreenProps) {
  const { currentStep, setFooterConfig } = useOnboarding();
  const { totalCredits } = useInterpreterTokenUsage();
  const [animatedCredits, setAnimatedCredits] = useState(0);
  const animatedCreditsTargetRef = useRef<number | null>(null);
  const creditsLoaded = useMemo(
    () => resolveCreditsLoaded(totalCredits),
    [totalCredits],
  );

  useEffect(() => {
    setFooterConfig({
      step: currentStep,
      continueLabel: 'Continue',
      continueAction: onNext,
      continueDisabled: false,
      continueLoading: false,
    });
    return () => setFooterConfig(null);
  }, [currentStep, onNext, setFooterConfig]);

  useEffect(() => {
    if (animatedCreditsTargetRef.current === creditsLoaded) {
      return;
    }
    animatedCreditsTargetRef.current = creditsLoaded;
    setAnimatedCredits(0);

    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setAnimatedCredits(creditsLoaded);
      return;
    }

    let rafId = 0;
    let timeoutId = 0;

    timeoutId = window.setTimeout(() => {
      const startedAt = performance.now();

      const animate = (now: number) => {
        const progress = Math.min((now - startedAt) / CREDIT_CHARGE_ANIMATION_MS, 1);
        const eased = 0.5 - (Math.cos(progress * Math.PI) / 2);
        setAnimatedCredits(Math.round(creditsLoaded * eased));
        if (progress < 1) {
          rafId = requestAnimationFrame(animate);
        }
      };

      rafId = requestAnimationFrame(animate);
    }, CREDIT_CHARGE_START_DELAY_MS);

    return () => {
      window.clearTimeout(timeoutId);
      cancelAnimationFrame(rafId);
    };
  }, [creditsLoaded]);

  const progressPercent = creditsLoaded > 0
    ? Math.min(Math.max(animatedCredits / creditsLoaded, 0), 1) * 100
    : 0;

  return (
    <OnboardingScreenShell
      size="medium"
      align="center"
      className="py-0 sm:py-0 lg:py-0"
      contentClassName="max-w-[640px]"
    >
      <div className="flex w-full flex-col items-center space-y-4 py-6">
        <OnboardingHeading
          title="Interpreter usage ready"
          description="Your account now includes Interpreter-managed usage."
          className="space-y-1.5 pb-1.5"
          descriptionClassName="max-w-[30rem] text-ui-sm leading-5"
        />

        <div
          className="w-full max-w-[560px] space-y-3.5 rounded-[18px] px-4 py-4"
          style={{
            border: 'var(--border-width) solid color-mix(in oklch, var(--oa-border) 60%, transparent)',
            backgroundColor: 'color-mix(in oklch, var(--oa-bg-app) 96%, var(--oa-bg-subtle) 4%)',
          }}
        >
          <div className="space-y-1">
            <p className="text-ui-sm text-[var(--oa-text-strong)]">
              Usage enabled
            </p>
            <p className="text-ui-xs leading-5 text-[var(--oa-text-muted)]">
              You&apos;re on the free tier. You can check your remaining usage in Settings anytime.
            </p>
          </div>
          <div
            className="h-1.5 overflow-hidden rounded-full"
            style={{
              border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border) 48%, transparent)',
              backgroundColor: 'color-mix(in srgb, var(--oa-primary) 10%, transparent)',
            }}
          >
            <div
              className="h-full rounded-full"
              style={{
                width: `${progressPercent}%`,
                background: 'linear-gradient(90deg, color-mix(in srgb, var(--oa-primary) 68%, transparent), var(--oa-primary))',
                boxShadow: '0 0 16px -10px color-mix(in srgb, var(--oa-primary) 42%, transparent)',
              }}
            />
          </div>
          <p className="text-ui-xs text-[var(--oa-text-muted)]">
            Ready to use Interpreter-managed models
          </p>
        </div>
      </div>
    </OnboardingScreenShell>
  );
}
