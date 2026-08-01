import type { OnboardingInterviewAnswers } from '../../../shared/types/onboardingState';

export function parseOnboardingVoiceInterviewToolArguments(
  argumentsJson: string,
): OnboardingInterviewAnswers {
  const parsed = JSON.parse(argumentsJson || '{}') as Record<string, unknown>;
  const { modelsUsed, aiUseToday, currentSetup } = parsed;
  if (
    typeof modelsUsed !== 'string'
    || typeof aiUseToday !== 'string'
    || typeof currentSetup !== 'string'
  ) {
    throw new Error('complete_onboarding_voice_interview requires string modelsUsed, aiUseToday, and currentSetup.');
  }
  return { modelsUsed, aiUseToday, currentSetup };
}
