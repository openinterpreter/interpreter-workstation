import type { OnboardingState } from '../../shared/types/onboardingState';

export function shouldShowOnboarding(state: Pick<OnboardingState, 'completed'>): boolean {
  return !state.completed;
}
