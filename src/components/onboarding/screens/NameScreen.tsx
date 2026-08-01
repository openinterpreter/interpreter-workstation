import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '../../ui/tooltip';
import { Button } from '../../ui/button';
import { OnboardingInput } from '../components/OnboardingInput';
import { OnboardingHeading, OnboardingScreenShell } from '../components/OnboardingScreenShell';
import { useOnboarding } from '../OnboardingContext';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface NameScreenProps {
  /** Called when the user submits their name. Should persist the name. */
  onNext: (name: string) => void | Promise<void>;
  /** Pre-populated name value (e.g. from previous session). */
  initialName?: string;
}

const BASE_NAME_GAP_PX = 20;
const GOLDEN_RATIO = 1.618;
const INPUT_TO_START_GAP_PX = Math.round(BASE_NAME_GAP_PX * GOLDEN_RATIO);
const START_BUTTON_TOP_OFFSET_PX = 40 + INPUT_TO_START_GAP_PX;

// ---------------------------------------------------------------------------
// NameScreen (Screen 1)
// ---------------------------------------------------------------------------

export function NameScreen({ onNext, initialName = '' }: NameScreenProps) {
  const { t } = useTranslation();
  const { currentStep, setFooterConfig } = useOnboarding();
  const stepRef = useRef(currentStep);
  const [name, setName] = useState(initialName);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const commitName = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed || isSubmitting) return;
    setIsSubmitting(true);
    let submitError: unknown;
    try {
      await onNext(trimmed);
    } catch (error) {
      submitError = error;
    }
    setIsSubmitting(false);
    if (submitError) throw submitError;
  }, [isSubmitting, name, onNext]);

  useEffect(() => {
    setFooterConfig({
      step: stepRef.current,
      hideContinue: true,
    });
  }, [setFooterConfig]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || isSubmitting) return;
    await commitName();
  };

  return (
    <OnboardingScreenShell size="wide" className="h-full py-0" contentClassName="h-full max-w-[920px]">
      <form onSubmit={handleSubmit} className="relative mx-auto h-full w-full">
        <div className="absolute left-1/2 top-1/2 flex w-full max-w-[360px] -translate-x-1/2 -translate-y-1/2 flex-col items-center text-center">
          <OnboardingHeading
            title={t('onboarding.name.title')}
          />

          <div className="relative mt-5 w-full">
            <OnboardingInput
              type="text"
              name="name"
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('onboarding.name.placeholder')}
              className="pr-10"
            />
            <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="pointer-events-auto inline-flex size-8 items-center justify-center rounded-full text-[var(--oa-text-muted)] transition-colors"
                    aria-label={t('onboarding.name.storedOnDevice')}
                    tabIndex={-1}
                  >
                    <Info className="size-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left">
                  {t('onboarding.name.storedOnDevice')}
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
        </div>

        <div
          className="absolute left-1/2 flex -translate-x-1/2 flex-col items-center gap-3"
          style={{ top: `calc(50% + ${START_BUTTON_TOP_OFFSET_PX}px)` }}
        >
          <Button
            type="submit"
            variant="default"
            size="default"
            className="rounded-full px-5 shadow-none"
            disabled={!name.trim() || isSubmitting}
          >
            {t('onboarding.nav.start', 'Start')}
          </Button>

          <p
            className={`min-h-[16px] text-center text-ui-xs text-[var(--oa-text-muted)] transition-opacity duration-150 ${isSubmitting ? 'opacity-100' : 'opacity-0'}`}
            aria-live="polite"
          >
            {isSubmitting ? t('onboarding.name.saving') : '\u00A0'}
          </p>
        </div>
      </form>
    </OnboardingScreenShell>
  );
}
