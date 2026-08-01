/**
 * useOnboardingNavigation
 *
 * Keyboard navigation hook for the Typeform-style onboarding flow.
 * Handles Enter to advance, Up/Down arrows for navigation,
 * and step validation logic.
 */

import { useEffect, useCallback } from 'react';
import { useOnboarding } from '../OnboardingContext';

const CONTINUE_PRESS_EVENT = 'onboarding:continue-press';
const KEYBOARD_ACTION_DELAY_MS = 70;

interface UseOnboardingNavigationOptions {
  /** Whether the current step's input is complete and Enter should advance */
  canAdvance?: boolean;
  /** Custom handler for Enter key (overrides default advance behavior) */
  onEnter?: () => void;
  /** Whether keyboard navigation is enabled (default: true) */
  enabled?: boolean;
  /** Whether Enter should be handled even when a focused interactive element is the target. */
  allowEnterFromInteractive?: boolean;
}

export function useOnboardingNavigation({
  canAdvance = true,
  onEnter,
  enabled = true,
  allowEnterFromInteractive = true,
}: UseOnboardingNavigationOptions = {}) {
  const { goForward, goBack, currentStep, totalSteps } = useOnboarding();

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!enabled) return;

    // Detect interactive targets so Enter can be scoped per-screen.
    const target = e.target as HTMLElement;
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

    if (e.repeat) return;

    switch (e.key) {
      case 'Enter':
        if (!allowEnterFromInteractive && isInteractiveTarget) {
          return;
        }
        if (canAdvance) {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent(CONTINUE_PRESS_EVENT));
          window.setTimeout(() => {
            if (onEnter) {
              onEnter();
            } else {
              goForward();
            }
          }, KEYBOARD_ACTION_DELAY_MS);
        }
        break;

      case 'ArrowUp':
        // Don't handle arrow keys when in interactive fields.
        if (isInteractiveTarget) return;
        e.preventDefault();
        goBack();
        break;

      case 'ArrowDown':
        // Don't handle arrow keys when in interactive fields.
        if (isInteractiveTarget) return;
        if (canAdvance) {
          e.preventDefault();
          goForward();
        }
        break;

      default:
        break;
    }
  }, [enabled, canAdvance, onEnter, goForward, goBack, allowEnterFromInteractive]);

  useEffect(() => {
    if (!enabled) return;

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [enabled, handleKeyDown]);

  return {
    goForward,
    goBack,
    currentStep,
    totalSteps,
    canAdvance,
  };
}
