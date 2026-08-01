import { describe, expect, test } from 'bun:test';
import { formatAddModelsLabel } from './onboardingModelReviewLabel';

describe('formatAddModelsLabel', () => {
  test('returns singular label for one selected model', () => {
    expect(formatAddModelsLabel(1)).toBe('Add 1 model');
  });

  test('returns plural label for zero selected models', () => {
    expect(formatAddModelsLabel(0)).toBe('Add 0 models');
  });

  test('returns plural label for many selected models', () => {
    expect(formatAddModelsLabel(4)).toBe('Add 4 models');
  });
});
