import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, MousePointer2, PanelTop, SquareDashedMousePointer } from 'lucide-react';

import { OnboardingHeading, OnboardingScreenShell, OnboardingSection } from '../components/OnboardingScreenShell';
import { useOnboarding } from '../OnboardingContext';

interface OverlayFirstUseScreenProps {
  onNext: () => void;
}

const OVERLAY_STEPS = [
  {
    icon: SquareDashedMousePointer,
    titleKey: 'onboarding.overlayFirstUse.stepSelectTitle',
    descriptionKey: 'onboarding.overlayFirstUse.stepSelectDescription',
  },
  {
    icon: MousePointer2,
    titleKey: 'onboarding.overlayFirstUse.stepAskTitle',
    descriptionKey: 'onboarding.overlayFirstUse.stepAskDescription',
  },
  {
    icon: PanelTop,
    titleKey: 'onboarding.overlayFirstUse.stepReviewTitle',
    descriptionKey: 'onboarding.overlayFirstUse.stepReviewDescription',
  },
] as const;

export function OverlayFirstUseScreen({ onNext }: OverlayFirstUseScreenProps) {
  const { t } = useTranslation();
  const { currentStep, setFooterConfig } = useOnboarding();
  const stepRef = useRef(currentStep);

  const handleContinue = useCallback(() => {
    onNext();
  }, [onNext]);

  useEffect(() => {
    setFooterConfig({
      step: stepRef.current,
      continueLabel: t('onboarding.overlayFirstUse.continue'),
      continueAction: handleContinue,
    });
  }, [handleContinue, setFooterConfig, t]);

  return (
    <OnboardingScreenShell size="medium" align="top">
      <div className="space-y-5">
        <OnboardingHeading
          title={t('onboarding.overlayFirstUse.title')}
          description={t('onboarding.overlayFirstUse.description')}
          align="left"
        />

        <div className="grid gap-3">
          {OVERLAY_STEPS.map((item) => {
            const Icon = item.icon;
            return (
              <OnboardingSection key={item.titleKey} tone="muted" padding="md">
                <div className="flex gap-4">
                  <div
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px]"
                    style={{
                      border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border) 58%, transparent)',
                      backgroundColor: 'color-mix(in srgb, var(--oa-bg-app) 70%, var(--oa-bg-subtle) 30%)',
                    }}
                  >
                    <Icon className="h-4 w-4 text-[var(--oa-text-muted)]" aria-hidden="true" />
                  </div>
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2">
                      <Check className="h-3.5 w-3.5 shrink-0 text-[var(--oa-text-faint)]" aria-hidden="true" />
                      <h2 className="text-ui-base font-medium leading-5 text-[var(--oa-text-strong)]">
                        {t(item.titleKey)}
                      </h2>
                    </div>
                    <p className="text-ui-sm leading-6 text-[var(--oa-text-muted)]">
                      {t(item.descriptionKey)}
                    </p>
                  </div>
                </div>
              </OnboardingSection>
            );
          })}
        </div>
      </div>
    </OnboardingScreenShell>
  );
}
