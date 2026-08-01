import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, X } from 'lucide-react';
import { openExternal } from '../../../ipc';
import { ChoiceButton } from '../components/ChoiceButton';
import { OnboardingModal } from '../components/OnboardingModal';
import { OnboardingHeading, OnboardingScreenShell } from '../components/OnboardingScreenShell';
import { useOnboarding } from '../OnboardingContext';

const PRIVACY_MODAL_STYLE = {
  border: 'var(--border-width) solid var(--oa-border)',
  backgroundColor: 'color-mix(in oklch, var(--oa-bg-input) 98%, var(--oa-bg-app) 2%)',
  boxShadow: '0 24px 64px rgba(0, 0, 0, 0.14)',
};

export interface PrivacyScreenProps {
  /** Called when the user makes a choice. `true` = opted in to telemetry. */
  onNext: (telemetryEnabled: boolean) => void | Promise<void>;
}

export function PrivacyScreen({ onNext }: PrivacyScreenProps) {
  "use no memo";

  const { t } = useTranslation();
  const { currentStep, setFooterConfig } = useOnboarding();
  const stepRef = useRef(currentStep);
  const [selectedOption, setSelectedOption] = useState<'private' | 'share' | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  const blurActiveChoice = useCallback(() => {
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement) {
      activeElement.blur();
    }
  }, []);

  const handleSelectAndContinue = useCallback(async (option: 'private' | 'share') => {
    if (isSubmitting || showDetails) return;
    blurActiveChoice();
    setSelectedOption(option);
    setIsSubmitting(true);
    try {
      await onNext(option === 'share');
    } finally {
      setIsSubmitting(false);
    }
  }, [blurActiveChoice, isSubmitting, onNext, showDetails]);

  // Keyboard shortcuts: A = private, B = share
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (isSubmitting || showDetails) return;

      const target = e.target as HTMLElement | null;
      const tagName = target?.tagName ?? '';
      const isInteractiveTarget =
        !!target &&
        (
          target.isContentEditable ||
          tagName === 'INPUT' ||
          tagName === 'TEXTAREA' ||
          tagName === 'SELECT' ||
          tagName === 'BUTTON' ||
          tagName === 'A'
        );

      if (isInteractiveTarget) return;

      if (e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        void handleSelectAndContinue('private');
      } else if (e.key === 'b' || e.key === 'B') {
        e.preventDefault();
        void handleSelectAndContinue('share');
      }
    },
    [handleSelectAndContinue, isSubmitting, showDetails],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const handleContinue = useCallback(async () => {
    if (!selectedOption || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onNext(selectedOption === 'share');
    } finally {
      setIsSubmitting(false);
    }
  }, [isSubmitting, onNext, selectedOption]);

  useEffect(() => {
    setFooterConfig({
      step: stepRef.current,
      continueAction: () => { void handleContinue(); },
      continueDisabled: !selectedOption || isSubmitting,
      continueDisabledTooltip: !selectedOption ? 'Pick a privacy setting to continue' : undefined,
    });
  }, [handleContinue, isSubmitting, selectedOption, setFooterConfig]);

  return (
    <OnboardingScreenShell size="form">
      <div className="space-y-5">
        <OnboardingHeading
          title={t('onboarding.privacy.title')}
          description={t('onboarding.privacy.description')}
        />

        <div className="space-y-3">
          <ChoiceButton
            letterKey="A"
            label={t('onboarding.privacy.keepPrivateLabel')}
            description={t('onboarding.privacy.keepPrivateDescription')}
            isSelected={selectedOption === 'private'}
            tone="outline"
            keyboardEnabled={false}
            onClick={() => void handleSelectAndContinue('private')}
            disabled={isSubmitting}
          />
          <ChoiceButton
            letterKey="B"
            label={t('onboarding.privacy.helpImproveLabel')}
            description={t('onboarding.privacy.helpImproveDescription')}
            isSelected={selectedOption === 'share'}
            tone="outline"
            keyboardEnabled={false}
            onClick={() => void handleSelectAndContinue('share')}
            disabled={isSubmitting}
          />
        </div>

        <p className="text-center text-ui-sm leading-6 text-[var(--oa-text-muted)] text-pretty">
          {t('onboarding.privacy.providerNote')}
        </p>

        <div className="space-y-3 text-center">
          <button
            type="button"
            onClick={() => setShowDetails(!showDetails)}
            className="inline-flex items-center rounded-full px-3 py-1.5 text-ui-sm text-[var(--oa-text-muted)] transition-[background-color,color] duration-[180ms] ease-[cubic-bezier(0.22,1,0.36,1)] hover:bg-[color-mix(in_oklch,var(--oa-bg-subtle)_72%,transparent)] hover:text-[var(--oa-text-strong)]"
          >
            {t('onboarding.privacy.whatCollected')}
          </button>
        </div>
      </div>

      <OnboardingModal
        open={showDetails}
        onClose={() => setShowDetails(false)}
        panelClassName="max-w-md space-y-4 rounded-[24px] p-6"
        panelStyle={PRIVACY_MODAL_STYLE}
      >
        <div>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-lg font-medium text-[var(--oa-text-strong)]">
                  {t('onboarding.privacy.whatCollected')}
                </h3>
                <p className="mt-1 text-sm text-[var(--oa-text-muted)]">
                  {t('onboarding.privacy.changeAnytime')}
                </p>
              </div>

              <button
                type="button"
                onClick={() => setShowDetails(false)}
                className="rounded-full p-1 text-[var(--oa-text-muted)] transition-colors hover:bg-[color-mix(in_oklch,var(--oa-bg-subtle)_72%,transparent)] hover:text-[var(--oa-text-strong)]"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="space-y-4 text-left text-sm">
              <div>
                <div className="mb-1.5 text-[13px] font-medium text-[var(--oa-text-strong)]">
                  {t('onboarding.privacy.collectedHeader')}
                </div>
                <ul className="list-inside list-disc space-y-1 text-[13px] leading-5 text-[var(--oa-text-muted)]">
                  <li>{t('onboarding.privacy.collectedFeatures')}</li>
                  <li>{t('onboarding.privacy.collectedDuration')}</li>
                  <li>{t('onboarding.privacy.collectedCrash')}</li>
                  <li>{t('onboarding.privacy.collectedSystem')}</li>
                </ul>
              </div>
              <div>
                <div className="mb-1.5 text-[13px] font-medium text-[var(--oa-text-strong)]">
                  {t('onboarding.privacy.neverHeader')}
                </div>
                <ul className="list-inside list-disc space-y-1 text-[13px] leading-5 text-[var(--oa-text-muted)]">
                  <li>{t('onboarding.privacy.neverDocuments')}</li>
                  <li>{t('onboarding.privacy.neverPrompts')}</li>
                  <li>{t('onboarding.privacy.neverPii')}</li>
                </ul>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 pt-2">
              <button
                type="button"
                onClick={() => setShowDetails(false)}
                className="inline-flex items-center rounded-full border-solid px-4 py-2 text-[13px] text-[var(--oa-text-muted)] shadow-none transition-[background-color,border-color,color] duration-[180ms] ease-[cubic-bezier(0.22,1,0.36,1)] [border-width:var(--border-width)] hover:border-[var(--oa-border)] hover:bg-[var(--oa-bg-input)] hover:text-[var(--oa-text-strong)]"
                style={{ borderColor: 'var(--oa-border)' }}
              >
                Close
              </button>

              <button
                type="button"
                onClick={() => openExternal('https://www.openinterpreter.com/legal/privacy')}
                className="inline-flex items-center gap-1 rounded-full border-solid border-black bg-black px-4 py-2 text-[13px] text-white shadow-none transition-[opacity,transform] duration-[180ms] ease-[cubic-bezier(0.22,1,0.36,1)] hover:opacity-95 dark:border-white dark:bg-white dark:text-black"
                style={{ borderWidth: 'var(--border-width)' }}
              >
                {t('onboarding.privacy.readPolicy')}
                <ExternalLink className="size-3" />
              </button>
            </div>
        </div>
      </OnboardingModal>
    </OnboardingScreenShell>
  );
}
