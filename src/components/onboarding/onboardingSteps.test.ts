import { describe, expect, test } from 'bun:test';

import {
  ENABLED_ONBOARDING_STEP_INDICES,
  getOnboardingStepId,
  getOnboardingStepTelemetryName,
  ONBOARDING_STEP_INDEX,
  ONBOARDING_STEPS,
  ONBOARDING_STEPS_WITHOUT_BUCKET_INDICES,
  resolveNextIncompleteOnboardingStepIndex,
  TOTAL_ONBOARDING_STEPS,
} from './onboardingSteps';

describe('onboarding step registry', () => {
  test('keeps one ordered source of truth for step indices', () => {
    expect(TOTAL_ONBOARDING_STEPS).toBe(22);
    expect(ONBOARDING_STEP_INDEX.name).toBe(0);
    expect(ONBOARDING_STEP_INDEX.bucket).toBe(2);
    expect(ONBOARDING_STEP_INDEX['overlay-first-use']).toBe(11);
    expect(ONBOARDING_STEP_INDEX['overlay-permissions']).toBe(12);
    expect(ONBOARDING_STEP_INDEX['tool-addons']).toBe(13);
    expect(ONBOARDING_STEP_INDEX['ai-setup']).toBe(15);
    expect(ONBOARDING_STEP_INDEX['model-setup']).toBe(16);
    expect(ONBOARDING_STEP_INDEX.feedback).toBe(21);
  });

  test('derives the active flow from enabled step definitions', () => {
    const activeStepIds = ENABLED_ONBOARDING_STEP_INDICES.map((index) => ONBOARDING_STEPS[index].id);

    expect(activeStepIds).toEqual([
      'name',
      'privacy',
      'bucket',
      'feature-1',
      'feature-2',
      'feature-3',
      'overlay-first-use',
      'overlay-permissions',
      'tool-addons',
      'ai-setup',
      'model-setup',
      'model-review',
      'model-credits',
      'stay-connected',
      'workspace-choice',
      'feedback',
    ]);
  });

  test('derives the confident-detection flow without the bucket picker', () => {
    const stepIds = ONBOARDING_STEPS_WITHOUT_BUCKET_INDICES.map((index) => ONBOARDING_STEPS[index].id);

    expect(stepIds).not.toContain('bucket');
    expect(stepIds).toEqual(ENABLED_ONBOARDING_STEP_INDICES
      .map((index) => ONBOARDING_STEPS[index].id)
      .filter((id) => id !== 'bucket'));
  });

  test('uses registry telemetry names and keeps unknown indices explicit', () => {
    expect(getOnboardingStepTelemetryName(ONBOARDING_STEP_INDEX['stay-connected'])).toBe('stay_connected');
    expect(getOnboardingStepTelemetryName(123)).toBe('step_123');
  });

  test('maps indices back to durable step ids', () => {
    expect(getOnboardingStepId(ONBOARDING_STEP_INDEX['model-setup'])).toBe('model-setup');
    expect(getOnboardingStepId(123)).toBeNull();
  });

  test('resolves the next incomplete active step from durable completed ids', () => {
    expect(resolveNextIncompleteOnboardingStepIndex(
      ENABLED_ONBOARDING_STEP_INDICES,
      ['name', 'privacy', 'bucket'],
    )).toBe(ONBOARDING_STEP_INDEX['feature-1']);

    expect(resolveNextIncompleteOnboardingStepIndex(
      ENABLED_ONBOARDING_STEP_INDICES,
      ENABLED_ONBOARDING_STEP_INDICES
        .map((index) => ONBOARDING_STEPS[index].id)
        .filter((id) => id !== 'ai-setup'),
    )).toBe(ONBOARDING_STEP_INDEX['ai-setup']);
  });
});
