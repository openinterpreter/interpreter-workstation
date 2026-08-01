import { describe, expect, test } from 'bun:test';

import { createDefaultOnboardingState } from '../../shared/types/onboardingState';
import { shouldShowOnboarding } from './onboardingGate';

describe('shouldShowOnboarding', () => {
  test('shows onboarding until explicit onboarding state is complete', () => {
    expect(shouldShowOnboarding(createDefaultOnboardingState())).toBe(true);
  });

  test('hides onboarding only when explicit onboarding state is complete', () => {
    expect(shouldShowOnboarding({
      ...createDefaultOnboardingState(),
      completed: true,
    })).toBe(false);
  });
});
