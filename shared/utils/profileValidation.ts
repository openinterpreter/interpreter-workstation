import type { Profile } from '../types/profile';
import type { EnvApiKeysResult } from '../types/provider';
import { getApiEnvKeyTypeForBaseURL } from '../types/provider';

export type MissingProfileField = 'name' | 'provider' | 'modelId' | 'baseURL' | 'apiKey' | 'command';

function hasResolvedApiKey(profile: Profile, envApiKeys: EnvApiKeysResult | null): boolean {
  if (profile.apiKey?.trim()) {
    return true;
  }
  if (profile.environmentKey?.trim()) {
    return true;
  }

  if (profile.provider === 'api' && profile.codexProfileId === 'custom') {
    return false;
  }

  const envKeyType = getApiEnvKeyTypeForBaseURL(profile.baseURL);
  return Boolean(envKeyType && envApiKeys?.[envKeyType].found);
}

export function getMissingProfileFields(profile: Profile, envApiKeys: EnvApiKeysResult | null = null): MissingProfileField[] {
  const missing = new Set<MissingProfileField>();

  if (!profile.isBuiltin && !profile.name.trim()) {
    missing.add('name');
  }

  if (!profile.provider) {
    missing.add('provider');
    return [...missing];
  }

  switch (profile.provider) {
    case 'hosted':
    case 'local':
    case 'openai-oauth':
    case 'agent':
      if (!profile.modelId?.trim()) {
        missing.add('modelId');
      }
      break;
    case 'terminal': {
      const command = typeof profile.providerConfig === 'object' && profile.providerConfig && 'command' in profile.providerConfig
        ? profile.providerConfig.command
        : undefined;
      if (!command?.trim()) {
        missing.add('command');
      }
      break;
    }
    case 'api':
      if (!profile.modelId?.trim()) {
        missing.add('modelId');
      }
      if (!profile.baseURL?.trim()) {
        missing.add('baseURL');
      }
      if (!hasResolvedApiKey(profile, envApiKeys)) {
        missing.add('apiKey');
      }
      break;
  }

  return [...missing];
}
