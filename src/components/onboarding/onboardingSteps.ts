export interface OnboardingStepDefinition {
  id: string;
  telemetryName: string;
  enabled: boolean;
  includeWhenBucketDetected: boolean;
}

export const ONBOARDING_STEPS = [
  { id: 'name', telemetryName: 'name', enabled: true, includeWhenBucketDetected: true },
  { id: 'privacy', telemetryName: 'privacy', enabled: true, includeWhenBucketDetected: true },
  { id: 'bucket', telemetryName: 'bucket', enabled: true, includeWhenBucketDetected: false },
  { id: 'feature-1', telemetryName: 'feature_1', enabled: true, includeWhenBucketDetected: true },
  { id: 'feature-2', telemetryName: 'feature_2', enabled: true, includeWhenBucketDetected: true },
  { id: 'feature-3', telemetryName: 'feature_3', enabled: true, includeWhenBucketDetected: true },
  { id: 'feature-4', telemetryName: 'feature_4', enabled: false, includeWhenBucketDetected: true },
  { id: 'feature-anatomy', telemetryName: 'feature_anatomy', enabled: false, includeWhenBucketDetected: true },
  { id: 'feature-markdown', telemetryName: 'feature_markdown', enabled: false, includeWhenBucketDetected: true },
  { id: 'tools-card', telemetryName: 'tools_card', enabled: false, includeWhenBucketDetected: true },
  { id: 'tool-setup', telemetryName: 'tool_setup', enabled: false, includeWhenBucketDetected: true },
  { id: 'overlay-first-use', telemetryName: 'overlay_first_use', enabled: true, includeWhenBucketDetected: true },
  { id: 'overlay-permissions', telemetryName: 'overlay_permissions', enabled: true, includeWhenBucketDetected: true },
  { id: 'tool-addons', telemetryName: 'tool_addons', enabled: true, includeWhenBucketDetected: true },
  { id: 'models-card', telemetryName: 'models_card', enabled: false, includeWhenBucketDetected: true },
  { id: 'ai-setup', telemetryName: 'ai_setup', enabled: true, includeWhenBucketDetected: true },
  { id: 'model-setup', telemetryName: 'model_setup', enabled: true, includeWhenBucketDetected: true },
  { id: 'model-review', telemetryName: 'model_review', enabled: true, includeWhenBucketDetected: true },
  { id: 'model-credits', telemetryName: 'model_credits', enabled: true, includeWhenBucketDetected: true },
  { id: 'stay-connected', telemetryName: 'stay_connected', enabled: true, includeWhenBucketDetected: true },
  { id: 'workspace-choice', telemetryName: 'workspace_choice', enabled: true, includeWhenBucketDetected: true },
  { id: 'feedback', telemetryName: 'feedback', enabled: true, includeWhenBucketDetected: true },
] as const satisfies readonly OnboardingStepDefinition[];

export type OnboardingStepId = typeof ONBOARDING_STEPS[number]['id'];

export const TOTAL_ONBOARDING_STEPS = ONBOARDING_STEPS.length;

export const ONBOARDING_STEP_INDEX = Object.fromEntries(
  ONBOARDING_STEPS.map((step, index) => [step.id, index]),
) as Record<OnboardingStepId, number>;

export const ENABLED_ONBOARDING_STEP_INDICES = ONBOARDING_STEPS
  .map((step, index) => (step.enabled ? index : null))
  .filter((index): index is number => index !== null);

export const ONBOARDING_STEPS_WITHOUT_BUCKET_INDICES = ONBOARDING_STEPS
  .map((step, index) => (step.enabled && step.includeWhenBucketDetected ? index : null))
  .filter((index): index is number => index !== null);

export function getOnboardingStepTelemetryName(stepIndex: number): string {
  return ONBOARDING_STEPS[stepIndex]?.telemetryName ?? `step_${stepIndex}`;
}

export function getOnboardingStepId(stepIndex: number): OnboardingStepId | null {
  return ONBOARDING_STEPS[stepIndex]?.id ?? null;
}

export function resolveNextIncompleteOnboardingStepIndex(
  activeStepIndices: readonly number[],
  completedStepIds: readonly string[],
): number | null {
  if (activeStepIndices.length === 0 || completedStepIds.length === 0) {
    return null;
  }

  const completed = new Set(completedStepIds);
  for (const stepIndex of activeStepIndices) {
    const stepId = getOnboardingStepId(stepIndex);
    if (stepId && !completed.has(stepId)) {
      return stepIndex;
    }
  }

  return activeStepIndices[activeStepIndices.length - 1] ?? null;
}
