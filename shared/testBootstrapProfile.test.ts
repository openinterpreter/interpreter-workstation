import { describe, expect, test } from 'bun:test';

import { PROVIDER_MODEL_DEFAULTS } from './types/modelDefaults';
import { isValidHostedModelId } from './utils/modelIdValidation';
import { buildTestBootstrapProfile } from './testBootstrapProfile';

describe('buildTestBootstrapProfile', () => {
  test('uses the current hosted default model id', () => {
    const profile = buildTestBootstrapProfile();

    expect(profile.id).toBe('test-default-profile');
    expect(profile.name).toBe('Test Default');
    expect(profile.provider).toBe('hosted');
    expect(profile.modelId).toBe(PROVIDER_MODEL_DEFAULTS.hosted.main);
    expect(isValidHostedModelId(profile.modelId)).toBe(true);
  });
});
