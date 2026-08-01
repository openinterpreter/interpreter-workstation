import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { OnboardingProvider, useOnboarding } from '../OnboardingContext';

const i18nMocks = vi.hoisted(() => {
  const labels: Record<string, string> = {
    'onboarding.overlayFirstUse.title': 'Start with the overlay',
    'onboarding.overlayFirstUse.description': 'Interpreter works best when it can see the exact app, page, or selection you want help with.',
    'onboarding.overlayFirstUse.stepSelectTitle': 'Select the current target',
    'onboarding.overlayFirstUse.stepSelectDescription': 'Use a screen region, selected text, a browser tab, or the active app as the starting context.',
    'onboarding.overlayFirstUse.stepAskTitle': 'Ask for the outcome',
    'onboarding.overlayFirstUse.stepAskDescription': 'Describe the result you want in normal language.',
    'onboarding.overlayFirstUse.stepReviewTitle': 'Review actions before they run',
    'onboarding.overlayFirstUse.stepReviewDescription': 'Computer actions stay visible and reviewable.',
    'onboarding.overlayFirstUse.continue': 'Set up AI',
  };

  return {
    t: (key: string) => labels[key] ?? key,
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: i18nMocks.t,
  }),
}));

import { OverlayFirstUseScreen } from './OverlayFirstUseScreen';

function ContinueHarness() {
  const { footerConfig } = useOnboarding();

  return (
    <button
      type="button"
      disabled={!footerConfig?.continueAction || footerConfig.continueDisabled || footerConfig.continueLoading}
      onClick={() => footerConfig?.continueAction?.()}
    >
      {footerConfig?.continueLabel ?? 'Continue'}
    </button>
  );
}

describe('OverlayFirstUseScreen', () => {
  test('renders the overlay-first workflow and advances through footer config', async () => {
    const onNext = vi.fn();

    render(
      <OnboardingProvider totalSteps={22}>
        <OverlayFirstUseScreen onNext={onNext} />
        <ContinueHarness />
      </OnboardingProvider>,
    );

    expect(screen.getByRole('heading', { name: 'Start with the overlay' })).toBeInTheDocument();
    expect(screen.getByText('Select the current target')).toBeInTheDocument();
    expect(screen.getByText('Ask for the outcome')).toBeInTheDocument();
    expect(screen.getByText('Review actions before they run')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Set up AI' }));

    await waitFor(() => {
      expect(onNext).toHaveBeenCalledTimes(1);
    });
  });
});
