import type { Profile } from './types/profile';
import { PROVIDER_MODEL_DEFAULTS } from './types/modelDefaults';

export function buildTestBootstrapProfile(): Profile {
  return {
    id: 'test-default-profile',
    name: 'Test Default',
    isBuiltin: false,
    provider: 'hosted',
    modelId: PROVIDER_MODEL_DEFAULTS.hosted.main,
  };
}
