/**
 * StayConnectedScreen (Screen 10)
 *
 * Collects user email for the mailing list and shows social links
 * (X, YouTube). Pre-fills email if the user is already
 * authenticated via Interpreter auth.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { openExternal } from '../../../ipc';
import { Button } from '../../ui/button';
import { OnboardingInput } from '../components/OnboardingInput';
import { OnboardingHeading, OnboardingScreenShell } from '../components/OnboardingScreenShell';
import { useOnboarding } from '../OnboardingContext';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StayConnectedScreenProps {
  /** Pre-filled email from auth (if any). */
  authenticatedEmail?: string;
  /** Callback to persist the email. Calls userEmail.set(email) via IPC. */
  onEmailSubmit?: (email: string) => void;
  /** Callback to subscribe to the newsletter. Calls newsletter.subscribe(email) via IPC. */
  onNewsletterSubscribe?: (email: string) => Promise<void> | void;
  /** Advance to the next screen. */
  onNext: () => void;
}

type SubscribeState = 'idle' | 'submitting' | 'success' | 'error';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------
// Social link helpers
// ---------------------------------------------------------------------------

const TWITTER_URL = 'https://x.com/OpenInterpreter';
const YOUTUBE_URL = 'https://www.youtube.com/@OpenInterpreter';

function XIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function YouTubeIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function StayConnectedScreen({
  authenticatedEmail,
  onEmailSubmit,
  onNewsletterSubscribe,
  onNext,
}: StayConnectedScreenProps) {
  "use no memo";

  const { t } = useTranslation();
  const { currentStep, setFooterConfig } = useOnboarding();
  const stepRef = useRef(currentStep);
  const [email, setEmail] = useState(authenticatedEmail ?? '');
  const [subscribeState, setSubscribeState] = useState<SubscribeState>('idle');
  const [statusMessageKey, setStatusMessageKey] = useState<string | null>(null);
  const trimmedEmail = email.trim();
  const isValidEmail = emailPattern.test(trimmedEmail);
  const newsletterEnabled = Boolean(onNewsletterSubscribe);
  const isEnterContinueEnabled = !newsletterEnabled || subscribeState === 'success' || trimmedEmail.length === 0;
  const isSubscribeDisabled = !isValidEmail || subscribeState === 'submitting' || subscribeState === 'success';

  // If the authenticated email arrives after mount, set it.
  useEffect(() => {
    if (authenticatedEmail && !email) {
      setEmail(authenticatedEmail);
    }
  }, [authenticatedEmail]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleEmailChange = useCallback((value: string) => {
    setEmail(value);
    setStatusMessageKey(null);
    if (subscribeState !== 'idle') {
      setSubscribeState('idle');
    }
  }, [subscribeState]);

  const handleContinue = useCallback(() => {
    if (isValidEmail) {
      onEmailSubmit?.(trimmedEmail);
    }
    onNext();
  }, [isValidEmail, onEmailSubmit, onNext, trimmedEmail]);

  const handleSubscribe = useCallback(async () => {
    if (!onNewsletterSubscribe) {
      return;
    }
    if (!isValidEmail) {
      setSubscribeState('error');
      setStatusMessageKey('onboarding.stayConnected.invalidEmail');
      return;
    }

    setSubscribeState('submitting');
    setStatusMessageKey(null);

    try {
      await onNewsletterSubscribe(trimmedEmail);
      setSubscribeState('success');
      setStatusMessageKey('onboarding.stayConnected.subscribeSuccess');
      onEmailSubmit?.(trimmedEmail);
    } catch {
      setSubscribeState('error');
      setStatusMessageKey('onboarding.stayConnected.subscribeFailed');
    }
  }, [isValidEmail, onEmailSubmit, onNewsletterSubscribe, trimmedEmail]);

  const handleInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (subscribeState === 'submitting') return;
    if (isEnterContinueEnabled) {
      handleContinue();
      return;
    }
    void handleSubscribe();
  }, [handleContinue, handleSubscribe, isEnterContinueEnabled, subscribeState]);

  const handleSubscribeButtonKeyDown = useCallback((e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (subscribeState === 'submitting') return;
    if (subscribeState === 'success' || trimmedEmail.length === 0) {
      handleContinue();
      return;
    }
    void handleSubscribe();
  }, [handleContinue, handleSubscribe, subscribeState, trimmedEmail.length]);

  useEffect(() => {
    if (isEnterContinueEnabled || subscribeState === 'submitting') return;

    const handleWindowKeyDown = (event: KeyboardEvent) => {
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
      void handleSubscribe();
    };

    window.addEventListener('keydown', handleWindowKeyDown);
    return () => window.removeEventListener('keydown', handleWindowKeyDown);
  }, [handleSubscribe, isEnterContinueEnabled, subscribeState]);

  // Set footer config for the Continue button label
  useEffect(() => {
    setFooterConfig({
      step: stepRef.current,
      continueLabel: !newsletterEnabled || subscribeState === 'success'
        ? t('onboarding.nav.continue', 'Continue')
        : t('onboarding.stayConnected.continueWithoutSubscribing', 'Continue without subscribing'),
      continueAction: handleContinue,
      continueHotkeyEnabled: isEnterContinueEnabled,
    });
  }, [handleContinue, isEnterContinueEnabled, newsletterEnabled, setFooterConfig, subscribeState, t]);

  return (
    <OnboardingScreenShell size="form" contentClassName="max-w-[520px]">
      <div className="space-y-5">
        <OnboardingHeading
          title={t('onboarding.stayConnected.title')}
          description={t('onboarding.stayConnected.description')}
          className="space-y-2"
          descriptionClassName="max-w-[28rem]"
        />

        {newsletterEnabled ? <div className="flex items-center gap-2.5">
          <div className="min-w-0 flex-1">
            <OnboardingInput
              type="email"
              value={email}
              onChange={(e) => handleEmailChange(e.target.value)}
              onKeyDown={handleInputKeyDown}
              placeholder={t('onboarding.stayConnected.emailPlaceholder')}
              autoComplete="off"
            />
          </div>
          <Button
            type="button"
            onClick={() => void handleSubscribe()}
            onKeyDown={handleSubscribeButtonKeyDown}
            disabled={isSubscribeDisabled}
            variant="outline"
            size="default"
            className="shrink-0 rounded-full px-4 text-muted-foreground shadow-none"
          >
            {subscribeState === 'submitting' ? t('onboarding.stayConnected.subscribing') : (
              subscribeState === 'success' ? (
                <span className="inline-flex items-center gap-1.5">
                  <Check className="size-4" aria-hidden="true" />
                  {t('onboarding.stayConnected.subscribed')}
                </span>
              ) : (
                t('onboarding.stayConnected.subscribe')
              )
            )}
          </Button>
        </div> : null}

        {newsletterEnabled ? <p
          className={`min-h-[20px] text-ui-sm ${
            subscribeState === 'error'
              ? 'text-destructive'
              : subscribeState === 'success'
                ? 'text-[var(--oa-text-strong)]'
                : 'text-[var(--oa-text-muted)]'
          }`}
          aria-live="polite"
        >
          {statusMessageKey ? t(statusMessageKey) : '\u00A0'}
        </p> : null}

        <div>
          <div className="grid grid-cols-2 gap-2.5">
            <Button
              onClick={() => openExternal(TWITTER_URL)}
              variant="outline"
              size="default"
              className="w-full justify-center gap-2 rounded-full px-3.5 text-muted-foreground shadow-none"
            >
              <XIcon className="size-4 shrink-0 text-[var(--oa-text)]" />
              <span>{t('onboarding.stayConnected.followOnX')}</span>
            </Button>

            <Button
              onClick={() => openExternal(YOUTUBE_URL)}
              variant="outline"
              size="default"
              className="w-full justify-center gap-2 rounded-full px-3.5 text-muted-foreground shadow-none"
            >
              <YouTubeIcon className="size-4 shrink-0 text-[var(--oa-text)]" />
              <span>{t('onboarding.stayConnected.subscribeOnYoutube')}</span>
            </Button>
          </div>
        </div>

      </div>
    </OnboardingScreenShell>
  );
}
