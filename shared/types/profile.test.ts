import { describe, test, expect } from 'bun:test';
import {
  isBuiltinProfile,
  getBuiltinProfileDefaults,
  mergeProfiles,
  modelConfigMatchesProfile,
  findMatchingProfile,
  buildProviderChange,
  BUILTIN_PROFILE_IDS,
  profileToModelConfig,
  type Profile,
} from './profile';

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 'test-profile',
    name: 'Test',
    modelId: 'test-model',
    isBuiltin: false,
    provider: 'hosted',
    ...overrides,
  };
}

describe('isBuiltinProfile', () => {
  test('returns false for builtin:smart when no builtins are defined', () => {
    expect(isBuiltinProfile('builtin:smart')).toBe(false);
  });

  test('returns false for builtin:fast when no builtins are defined', () => {
    expect(isBuiltinProfile('builtin:fast')).toBe(false);
  });

  test('returns false for builtin:anything', () => {
    expect(isBuiltinProfile('builtin:anything')).toBe(false);
  });

  test('returns false for custom-profile', () => {
    expect(isBuiltinProfile('custom-profile')).toBe(false);
  });

  test('returns false for empty string', () => {
    expect(isBuiltinProfile('')).toBe(false);
  });
});

describe('getBuiltinProfileDefaults', () => {
  test('returns undefined for builtin:smart', () => {
    const result = getBuiltinProfileDefaults(BUILTIN_PROFILE_IDS.SMART);

    expect(result).toBeUndefined();
  });

  test('returns undefined for builtin:fast', () => {
    const result = getBuiltinProfileDefaults(BUILTIN_PROFILE_IDS.FAST);

    expect(result).toBeUndefined();
  });

  test('returns undefined for unknown ID', () => {
    expect(getBuiltinProfileDefaults('nonexistent')).toBeUndefined();
  });
});

describe('mergeProfiles', () => {
  test('returns only custom profiles', () => {
    const custom = makeProfile({ id: 'custom-1', name: 'Custom' });

    const result = mergeProfiles([custom]);

    expect(result.length).toBe(1);
    expect(result[0].id).toBe('custom-1');
  });

  test('returns empty array when customs is empty', () => {
    const result = mergeProfiles([]);

    expect(result).toEqual([]);
  });
});

describe('modelConfigMatchesProfile', () => {
  test('matches identical config', () => {
    const profile = makeProfile();
    const config = {
      provider: profile.provider,
      modelId: profile.modelId,
    };

    expect(modelConfigMatchesProfile(config, profile)).toBe(true);
  });

  test('returns false for different provider', () => {
    const profile = makeProfile({ provider: 'hosted' });

    expect(
      modelConfigMatchesProfile({ provider: 'local', modelId: profile.modelId }, profile)
    ).toBe(false);
  });

  test('returns false for different modelId', () => {
    const profile = makeProfile();

    expect(
      modelConfigMatchesProfile({ provider: profile.provider, modelId: 'other-model' }, profile)
    ).toBe(false);
  });

  test('treats undefined apiKey same as empty string', () => {
    const profile = makeProfile({ apiKey: undefined });
    const config = {
      provider: profile.provider,
      modelId: profile.modelId,
      apiKey: '',
    };

    expect(modelConfigMatchesProfile(config, profile)).toBe(true);
  });

  test('treats undefined baseURL same as empty string', () => {
    const profile = makeProfile({ baseURL: undefined });
    const config = {
      provider: profile.provider,
      modelId: profile.modelId,
      baseURL: '',
    };

    expect(modelConfigMatchesProfile(config, profile)).toBe(true);
  });

  test('returns false when one has providerConfig and other does not', () => {
    const profile = makeProfile({ providerConfig: { id: 'claude-code', command: 'claude' } });
    const config = {
      provider: profile.provider,
      modelId: profile.modelId,
    };

    expect(modelConfigMatchesProfile(config, profile)).toBe(false);
  });

  test('compares providerConfig via JSON stringify', () => {
    const profile = makeProfile({
      provider: 'terminal',
      providerConfig: { id: 'claude-code', command: 'claude' },
    });
    const config = {
      provider: 'terminal' as const,
      modelId: profile.modelId,
      providerConfig: { id: 'claude-code', command: 'claude' },
    };

    expect(modelConfigMatchesProfile(config, profile)).toBe(true);
  });
});

describe('findMatchingProfile', () => {
  test('fast path: finds by profileId', () => {
    const profiles = [makeProfile({ id: 'p1' }), makeProfile({ id: 'p2', modelId: 'other' })];

    const result = findMatchingProfile(profiles, {
      profileId: 'p2',
      provider: 'hosted',
      modelId: 'irrelevant',
    });

    expect(result).toBeDefined();
    expect(result!.id).toBe('p2');
  });

  test('fallback: matches by fields when no profileId', () => {
    const profile = makeProfile({ id: 'p1' });
    const profiles = [profile];

    const result = findMatchingProfile(profiles, {
      provider: profile.provider,
      modelId: profile.modelId,
    });

    expect(result).toBeDefined();
    expect(result!.id).toBe('p1');
  });

  test('returns undefined when nothing matches and no same-provider fallback', () => {
    const profiles = [makeProfile({ id: 'p1', provider: 'local' })];

    const result = findMatchingProfile(profiles, {
      provider: 'api',
      modelId: 'no-match',
    });

    expect(result).toBeUndefined();
  });

  test('should_fallback_to_same_provider_profile_when_modelId_stale_and_no_profileId', () => {
    const profile = makeProfile({
      id: 'auto:hosted-smart',
      provider: 'hosted',
      modelId: 'interpreter-smart',
    });

    const result = findMatchingProfile([profile], {
      provider: 'hosted',
      modelId: 'claude-sonnet-4-5-20250929',
    });

    expect(result).toBeDefined();
    expect(result!.id).toBe('auto:hosted-smart');
  });

  test('should_fallback_to_same_provider_when_profileId_points_to_deleted_profile', () => {
    const profile = makeProfile({
      id: 'auto:hosted-smart',
      provider: 'hosted',
      modelId: 'interpreter-smart',
    });

    const result = findMatchingProfile([profile], {
      profileId: 'deleted-profile-id',
      provider: 'hosted',
      modelId: 'claude-sonnet-4-5-20250929',
    });

    expect(result).toBeDefined();
    expect(result!.id).toBe('auto:hosted-smart');
  });

  test('should_fallback_to_hosted_when_getDefaultModelConfig_used', () => {
    const profile = makeProfile({
      id: 'auto:hosted-smart',
      provider: 'hosted',
      modelId: 'interpreter-smart',
    });

    const result = findMatchingProfile([profile], {
      provider: 'hosted' as const,
      modelId: 'claude-sonnet-4-5-20250929',
    });

    expect(result).toBeDefined();
    expect(result!.id).toBe('auto:hosted-smart');
  });

  test('should_prefer_profileId_match_over_provider_fallback', () => {
    const smart = makeProfile({ id: 'hosted-smart', provider: 'hosted', modelId: 'interpreter-smart' });
    const fast = makeProfile({ id: 'hosted-fast', provider: 'hosted', modelId: 'interpreter-fast' });

    const result = findMatchingProfile([smart, fast], {
      profileId: 'hosted-fast',
      provider: 'hosted',
      modelId: 'old-model',
    });

    expect(result!.id).toBe('hosted-fast');
  });

  test('should_prefer_field_match_over_provider_fallback', () => {
    const exact = makeProfile({ id: 'exact', provider: 'api', modelId: 'gpt-4o', apiKey: 'sk-test' });
    const other = makeProfile({ id: 'other', provider: 'api', modelId: 'gpt-3.5' });

    const result = findMatchingProfile([exact, other], {
      provider: 'api',
      modelId: 'gpt-4o',
      apiKey: 'sk-test',
    });

    expect(result!.id).toBe('exact');
  });

  test('should_not_provider_fallback_across_different_providers', () => {
    const profile = makeProfile({ id: 'api-profile', provider: 'api', modelId: 'gpt-4o' });

    const result = findMatchingProfile([profile], {
      provider: 'hosted',
      modelId: 'interpreter-smart',
    });

    expect(result).toBeUndefined();
  });
});

describe('profileToModelConfig', () => {
  test('does not persist profile reasoning effort into agent config', () => {
    const profile = makeProfile({ reasoningEffort: 'high' });

    expect(profileToModelConfig(profile).reasoningEffort).toBeUndefined();
  });

  test('allows an explicit reasoning override when deriving the config', () => {
    const profile = makeProfile({ reasoningEffort: 'medium' });

    expect(
      profileToModelConfig(profile, { reasoningEffort: 'low' }).reasoningEffort,
    ).toBe('low');
  });

  test('defaults API profiles to Responses unless Chat Completions is explicit', () => {
    expect(profileToModelConfig(makeProfile({ provider: 'api' })).wireApi).toBe('responses');
    expect(profileToModelConfig(makeProfile({ provider: 'api', wireApi: 'chat' })).wireApi).toBe('chat');
  });

  test('preserves environment-backed credentials for runtime resolution', () => {
    const modelConfig = profileToModelConfig(makeProfile({
      provider: 'api',
      environmentKey: 'OPENAI_API_KEY',
    }));

    expect(modelConfig.environmentKey).toBe('OPENAI_API_KEY');
    expect(modelConfig.apiKey).toBeUndefined();
  });

  test('defaults DeepSeek API profiles to Chat Completions', () => {
    expect(profileToModelConfig(makeProfile({
      provider: 'api',
      codexProfileId: 'deepseek',
      baseURL: 'https://api.deepseek.com',
    })).wireApi).toBe('chat');
  });

  test('forces DeepSeek API base URLs to Chat Completions even when saved as custom Responses profiles', () => {
    const modelConfig = profileToModelConfig(makeProfile({
      provider: 'api',
      codexProfileId: 'custom',
      baseURL: 'https://api.deepseek.com',
      wireApi: 'responses',
      useResponsesApi: true,
    }));

    expect(modelConfig.wireApi).toBe('chat');
    expect(modelConfig.useResponsesApi).toBe(false);
  });

  test('honors an explicit wireApi override on local profiles', () => {
    expect(profileToModelConfig(makeProfile({ provider: 'local', wireApi: 'chat' })).wireApi).toBe('chat');
    expect(profileToModelConfig(makeProfile({ provider: 'local', wireApi: 'responses' })).wireApi).toBe('responses');
  });

  test('leaves local wireApi unset so the runtime applies the preset default', () => {
    expect(profileToModelConfig(makeProfile({ provider: 'local' })).wireApi).toBeUndefined();
  });

  test('keeps non-local, non-API profiles on Responses', () => {
    expect(profileToModelConfig(makeProfile({ provider: 'hosted', wireApi: 'chat' })).wireApi).toBe('responses');
  });

  test('preserves the OIX harness override', () => {
    expect(profileToModelConfig(makeProfile({ harness: 'kimi-cli' })).harness).toBe('kimi-cli');
    expect(profileToModelConfig(makeProfile({ harness: null })).harness).toBeNull();
    expect(profileToModelConfig(makeProfile()).harness).toBeUndefined();
  });
});

describe('buildProviderChange', () => {
  test('clears stale reasoning effort when provider fields change', () => {
    expect(buildProviderChange({ provider: 'api' })).toEqual({
      codexProfileId: undefined,
      harness: undefined,
      apiKey: undefined,
      baseURL: undefined,
      apiFormat: undefined,
      wireApi: undefined,
      providerId: undefined,
      providerConfig: undefined,
      reasoningEffort: undefined,
      provider: 'api',
    });
  });
});

describe('buildProviderChange', () => {
  test('should_clear_all_optional_fields_by_default', () => {
    const change = buildProviderChange({ provider: 'hosted' });
    expect(change.codexProfileId).toBeUndefined();
    expect(change.harness).toBeUndefined();
    expect(change.apiKey).toBeUndefined();
    expect(change.baseURL).toBeUndefined();
    expect(change.apiFormat).toBeUndefined();
    expect(change.wireApi).toBeUndefined();
    expect(change.providerId).toBeUndefined();
    expect(change.providerConfig).toBeUndefined();
    expect(change.reasoningEffort).toBeUndefined();
  });

  test('should_preserve_explicitly_set_fields', () => {
    const change = buildProviderChange({
      provider: 'api',
      codexProfileId: 'custom',
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      apiFormat: 'openai',
      wireApi: 'chat',
    });
    expect(change.codexProfileId).toBe('custom');
    expect(change.baseURL).toBe('https://api.openai.com/v1');
    expect(change.apiKey).toBe('sk-test');
    expect(change.apiFormat).toBe('openai');
    expect(change.wireApi).toBe('chat');
    expect(change.providerConfig).toBeUndefined();
    expect(change.providerId).toBeUndefined();
  });

  test('should_set_codexProfileId_for_local_ollama', () => {
    const change = buildProviderChange({
      provider: 'local',
      codexProfileId: 'ollama',
      baseURL: 'http://localhost:11434/v1',
    });
    expect(change.codexProfileId).toBe('ollama');
    expect(change.apiKey).toBeUndefined();
    expect(change.providerConfig).toBeUndefined();
  });

  test('should_clear_codexProfileId_when_switching_to_hosted', () => {
    const change = buildProviderChange({
      provider: 'hosted',
      providerId: 'builtin:hosted',
      modelId: 'interpreter-smart',
    });
    expect(change.codexProfileId).toBeUndefined();
    expect(change.apiKey).toBeUndefined();
    expect(change.baseURL).toBeUndefined();
  });

  test('should_clear_codexProfileId_for_terminal', () => {
    const change = buildProviderChange({
      provider: 'terminal',
      providerConfig: { id: 'claude-code', command: 'claude' } as any,
    });
    expect(change.codexProfileId).toBeUndefined();
    expect(change.apiKey).toBeUndefined();
    expect(change.baseURL).toBeUndefined();
  });

  test('should_include_provider_field_in_output', () => {
    const change = buildProviderChange({ provider: 'api' });
    expect(change.provider).toBe('api');
  });
});
