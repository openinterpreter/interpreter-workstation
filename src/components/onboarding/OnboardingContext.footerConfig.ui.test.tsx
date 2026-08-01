import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { ONBOARDING_CONTINUE_BUTTON_ID } from '../../../shared/element-ids';
import { evaluateOnboardingCompletionGate } from './OnboardingOverlay';
import { OnboardingProvider, useOnboarding } from './OnboardingContext';
import { ONBOARDING_STEP_INDEX, TOTAL_ONBOARDING_STEPS } from './onboardingSteps';
import { NavigationFooter } from './components/NavigationFooter';

const STEP_FEEDBACK = ONBOARDING_STEP_INDEX.feedback;
const STEP_AI_SETUP = ONBOARDING_STEP_INDEX['ai-setup'];
const STEP_TOOL_ADDONS = ONBOARDING_STEP_INDEX['tool-addons'];
const STEP_MODEL_SETUP = ONBOARDING_STEP_INDEX['model-setup'];

function FooterConfigHarness() {
  const { goToStep, setFooterConfig } = useOnboarding();

  return (
    <div>
      <button type="button" onClick={() => goToStep(STEP_FEEDBACK)}>
        goto-feedback
      </button>
      <button type="button" onClick={() => goToStep(STEP_TOOL_ADDONS)}>
        goto-tool-addons
      </button>
      <button type="button" onClick={() => goToStep(STEP_MODEL_SETUP)}>
        goto-model-setup
      </button>
      <button
        type="button"
        onClick={() => setFooterConfig({ step: STEP_FEEDBACK, continueLabel: 'Start', continueAction: () => {} })}
      >
        set-feedback-footer
      </button>
      <button
        type="button"
        onClick={() => setFooterConfig({ step: STEP_AI_SETUP, continueLabel: 'Continue', continueAction: () => {} })}
      >
        set-stale-footer
      </button>
    </div>
  );
}

describe('OnboardingContext footer config ownership', () => {
  test('keeps Tools navigable and only reserves the disabled default footer for model setup', async () => {
    const user = userEvent.setup();

    render(
      <OnboardingProvider totalSteps={TOTAL_ONBOARDING_STEPS}>
        <FooterConfigHarness />
        <NavigationFooter />
      </OnboardingProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'goto-tool-addons' }));

    expect(screen.getByRole('button', { name: 'Next step' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'goto-model-setup' }));

    expect(screen.getByRole('button', { name: 'Next step' })).toBeDisabled();
  });

  test('ignores stale step footer config updates so final-step continue stays visible', async () => {
    const user = userEvent.setup();

    render(
      <OnboardingProvider totalSteps={TOTAL_ONBOARDING_STEPS}>
        <FooterConfigHarness />
        <NavigationFooter />
      </OnboardingProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'goto-feedback' }));
    await user.click(screen.getByRole('button', { name: 'set-feedback-footer' }));

    const continueButton = screen.getByTestId(ONBOARDING_CONTINUE_BUTTON_ID);
    expect(continueButton).toBeVisible();
    expect(continueButton).toHaveTextContent('Start');

    await user.click(screen.getByRole('button', { name: 'set-stale-footer' }));

    expect(screen.getByTestId(ONBOARDING_CONTINUE_BUTTON_ID)).toBeVisible();
    expect(screen.getByTestId(ONBOARDING_CONTINUE_BUTTON_ID)).toHaveTextContent('Start');
  });
});

describe('evaluateOnboardingCompletionGate', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('requires model setup when profile loading times out across all retries', async () => {
    vi.useFakeTimers();
    const loadProfiles = vi.fn<() => Promise<never>>(() => new Promise(() => {}));

    const resultPromise = evaluateOnboardingCompletionGate(loadProfiles, { maxAttempts: 3, timeoutMs: 5 });

    await vi.advanceTimersByTimeAsync(15);

    await expect(resultPromise).resolves.toEqual({
      kind: 'require-model-setup',
      reason: 'profiles-unavailable',
    });
    expect(loadProfiles).toHaveBeenCalledTimes(3);
  });

  test('allows completion when a retry loads at least one profile', async () => {
    vi.useFakeTimers();
    const loadProfiles = vi.fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce({
        profiles: [{ id: 'profile-1' }],
        defaultProfileId: 'profile-1',
        fastProfileId: null,
      });

    const resultPromise = evaluateOnboardingCompletionGate(loadProfiles, { maxAttempts: 2, timeoutMs: 5 });

    await vi.advanceTimersByTimeAsync(5);

    await expect(resultPromise).resolves.toEqual({ kind: 'allow-completion' });
    expect(loadProfiles).toHaveBeenCalledTimes(2);
  });

  test('requires model setup when profile loading succeeds but no profiles exist', async () => {
    await expect(
      evaluateOnboardingCompletionGate(async () => ({
        profiles: [],
        defaultProfileId: null,
        fastProfileId: null,
      })),
    ).resolves.toEqual({
      kind: 'require-model-setup',
      reason: 'missing-profile',
    });
  });
});
