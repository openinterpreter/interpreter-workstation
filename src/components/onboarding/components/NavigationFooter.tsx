/**
 * NavigationFooter
 *
 * Horizontal bar pinned to the bottom of the onboarding window.
 * Back button on the lower-left, Continue on the lower-right.
 * Screens can override the Continue button via footerConfig in context.
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Button } from '../../ui/button';
import { Tooltip, TooltipTrigger, TooltipContent } from '../../ui/tooltip';
import { useOnboarding } from '../OnboardingContext';
import { ProgressBar } from './ProgressBar';
import { cn } from '@/lib/utils';
import { ONBOARDING_CONTINUE_BUTTON_ID } from '../../../../shared/element-ids';
import { ONBOARDING_STEP_INDEX } from '../onboardingSteps';

const STEP_MODEL_SETUP = ONBOARDING_STEP_INDEX['model-setup'];
const CONTINUE_PRESS_EVENT = 'onboarding:continue-press';
const KEYBOARD_PRESS_MS = 110;
const KEYBOARD_ACTION_DELAY_MS = 70;
const FIRST_SCREEN_FADE_MS = 150;

export function NavigationFooter() {
  const { t } = useTranslation();
  const { goForward, goBack, currentStep, _activeStepIndex, totalSteps, footerConfig } = useOnboarding();
  const activeFooterConfig = footerConfig?.step === currentStep ? footerConfig : null;
  const [isKeyboardPressing, setIsKeyboardPressing] = useState(false);
  const [isFirstContinueFading, setIsFirstContinueFading] = useState(false);
  const pressTimeoutRef = useRef<number | null>(null);
  const firstFadeTimeoutRef = useRef<number | null>(null);

  const isFirst = _activeStepIndex === 0;
  const isLast = _activeStepIndex === totalSteps - 1;
  const isModelSetup = currentStep === STEP_MODEL_SETUP;
  const hasFooterConfig = !!activeFooterConfig?.continueAction;
  const hideContinue = !!activeFooterConfig?.hideContinue;
  const continueHotkeyEnabled = activeFooterConfig?.continueHotkeyEnabled ?? true;
  const disabledTooltipLabel = (isModelSetup && !hasFooterConfig)
    ? t('onboarding.modelSetup.pickProviderToContinue', 'Pick a provider to continue')
    : activeFooterConfig?.continueDisabledTooltip;
  const showDisabledTooltip = !!disabledTooltipLabel;
  const showContinue = !hideContinue && (hasFooterConfig || (!isLast && !isModelSetup));
  const continueAction = activeFooterConfig?.continueAction ?? goForward;
  const continueDisabled = hasFooterConfig ? !!(activeFooterConfig!.continueDisabled || activeFooterConfig!.continueLoading) : false;
  const showEnterHint = showContinue && !continueDisabled && continueHotkeyEnabled;
  const isCenteredContinue = activeFooterConfig?.continuePlacement === 'center' && isFirst;
  const showFooterProgress = totalSteps > 1 && !isFirst;
  const defaultContinueLabel = isFirst ? 'Start' : t('onboarding.nav.continue', 'Continue');
  const reserveContinueLabel = t('onboarding.nav.continue', 'Continue');

  useEffect(() => {
    return () => {
      if (pressTimeoutRef.current) {
        window.clearTimeout(pressTimeoutRef.current);
      }
      if (firstFadeTimeoutRef.current) {
        window.clearTimeout(firstFadeTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setIsFirstContinueFading(false);
  }, [_activeStepIndex]);

  useEffect(() => {
    const handleContinuePress = () => {
      setIsKeyboardPressing(true);
      if (pressTimeoutRef.current) {
        window.clearTimeout(pressTimeoutRef.current);
      }
      pressTimeoutRef.current = window.setTimeout(() => {
        setIsKeyboardPressing(false);
        pressTimeoutRef.current = null;
      }, KEYBOARD_PRESS_MS);
    };

    window.addEventListener(CONTINUE_PRESS_EVENT, handleContinuePress);
    return () => window.removeEventListener(CONTINUE_PRESS_EVENT, handleContinuePress);
  }, [isCenteredContinue]);

  const handleContinueClick = () => {
    if (continueDisabled) return;

    if (isCenteredContinue) {
      setIsFirstContinueFading(true);
      if (firstFadeTimeoutRef.current) {
        window.clearTimeout(firstFadeTimeoutRef.current);
      }
      firstFadeTimeoutRef.current = window.setTimeout(() => {
        continueAction();
        firstFadeTimeoutRef.current = null;
      }, FIRST_SCREEN_FADE_MS);
      return;
    }

    continueAction();
  };

  useEffect(() => {
    if (!hasFooterConfig || !showContinue || continueDisabled || !continueHotkeyEnabled) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.repeat) return;

      const target = event.target as HTMLElement | null;
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

      event.preventDefault();

      if (isCenteredContinue) {
        setIsFirstContinueFading(true);
        if (firstFadeTimeoutRef.current) {
          window.clearTimeout(firstFadeTimeoutRef.current);
        }
        firstFadeTimeoutRef.current = window.setTimeout(() => {
          continueAction();
          firstFadeTimeoutRef.current = null;
        }, FIRST_SCREEN_FADE_MS);
        return;
      }

      window.dispatchEvent(new CustomEvent(CONTINUE_PRESS_EVENT));
      window.setTimeout(() => {
        continueAction();
      }, KEYBOARD_ACTION_DELAY_MS);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [continueAction, continueDisabled, continueHotkeyEnabled, hasFooterConfig, isCenteredContinue, showContinue]);

  return (
    <div className="w-full flex-shrink-0">
      {isCenteredContinue ? (
        <div className="mx-auto flex min-h-[68px] w-full max-w-[920px] items-center justify-center gap-4 px-4 py-4">
          <div className="flex flex-col items-center gap-2.5">
            {showDisabledTooltip ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0} className="inline-flex">
                    <Button
                      variant="default"
                      size="default"
                      className="pointer-events-none rounded-full px-5 shadow-none"
                      disabled
                      aria-label={t('onboarding.nav.nextStep')}
                    >
                      {defaultContinueLabel}
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {disabledTooltipLabel}
                </TooltipContent>
              </Tooltip>
            ) : showContinue ? (
              <Button
                onClick={handleContinueClick}
                variant="default"
                size="default"
                data-testid={ONBOARDING_CONTINUE_BUTTON_ID}
                className={cn(
                  'rounded-full px-5 shadow-none transition-opacity duration-[150ms] ease-out hover:opacity-100',
                  isFirstContinueFading && 'opacity-0',
                )}
                disabled={continueDisabled}
                aria-label={t('onboarding.nav.nextStep')}
              >
                {hasFooterConfig && activeFooterConfig!.continueLoading && <Loader2 className="size-3.5 animate-spin" />}
                {hasFooterConfig && activeFooterConfig!.continueLabel
                  ? activeFooterConfig!.continueLabel
                  : defaultContinueLabel}
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <div
          className="mx-auto grid min-h-[68px] w-full max-w-[920px] grid-cols-[1fr_auto_1fr] items-center gap-4 px-4 py-4"
        >
          <div className="justify-self-start">
            <div
              className={cn(
                'transition-opacity duration-200 ease-out',
                isFirst ? 'pointer-events-none opacity-0' : 'opacity-100',
              )}
            >
              <Button
                onClick={goBack}
                variant="outline"
                size="default"
                className="rounded-full px-3.5 text-muted-foreground shadow-none"
                aria-label={t('onboarding.nav.previousStep')}
                disabled={isFirst}
                tabIndex={isFirst ? -1 : 0}
                aria-hidden={isFirst}
              >
                {t('onboarding.nav.back', 'Back')}
              </Button>
            </div>
          </div>

          <div className="justify-self-center">
            <div
              className={cn(
                'transition-opacity duration-200 ease-out',
                showFooterProgress ? 'opacity-100' : 'pointer-events-none opacity-0',
              )}
              aria-hidden={!showFooterProgress}
            >
              <ProgressBar activeIndex={_activeStepIndex} total={totalSteps} />
            </div>
          </div>

          <div className="flex items-center justify-self-end gap-3.5">
            <span
              className={cn(
                'text-ui-xs text-muted-foreground transition-opacity duration-200 ease-out',
                showEnterHint ? 'opacity-100' : 'pointer-events-none opacity-0',
              )}
              aria-hidden={!showEnterHint}
            >
              {t('onboarding.common.pressEnter')}
            </span>
            <div
              className={cn(
                'transition-opacity duration-200 ease-out',
                showContinue || showDisabledTooltip ? 'opacity-100' : 'pointer-events-none opacity-0',
              )}
            >
              {showDisabledTooltip ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span tabIndex={0} className="inline-flex">
                      <Button
                        variant="default"
                        size="default"
                        className="pointer-events-none rounded-full px-5 shadow-none"
                        disabled
                        aria-label={t('onboarding.nav.nextStep')}
                      >
                        {reserveContinueLabel}
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    {disabledTooltipLabel}
                  </TooltipContent>
                </Tooltip>
              ) : (
                <Button
                  onClick={handleContinueClick}
                  variant="default"
                  size="default"
                  data-testid={ONBOARDING_CONTINUE_BUTTON_ID}
                  className={cn(
                    'transform-gpu rounded-full px-5 shadow-none hover:opacity-100',
                    isKeyboardPressing && 'scale-[0.965]',
                  )}
                  disabled={!showContinue || continueDisabled}
                  aria-label={t('onboarding.nav.nextStep')}
                  tabIndex={showContinue ? 0 : -1}
                  aria-hidden={!showContinue}
                >
                  {hasFooterConfig && activeFooterConfig!.continueLoading && <Loader2 className="size-3.5 animate-spin" />}
                  {hasFooterConfig && activeFooterConfig!.continueLabel
                    ? activeFooterConfig!.continueLabel
                    : reserveContinueLabel}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
