import { describe, test, expect } from 'bun:test';
import { OPENROUTER_MODEL_OPTIONS } from '../shared/generated/modelCatalog';
import { migrateConfig, CURRENT_CONFIG_VERSION, OPENROUTER_MODEL_REGEX, isValidHostedModelId } from './configMigrations';
import type { AppConfig } from './configStore';
import { CUSTOM_PRESETS, buildProfileFromPreset } from '../src/lib/codex/profiles';

function makeV0Config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    agents: {},
    profiles: [],
    ...overrides,
  } as AppConfig;
}

describe('migrateConfig', () => {
  test('should return false when config is already at current version', () => {
    const config = makeV0Config({ configVersion: CURRENT_CONFIG_VERSION });
    expect(migrateConfig(config)).toBe(false);
  });

  test('should return true when migration is applied', () => {
    const config = makeV0Config();
    expect(migrateConfig(config)).toBe(true);
  });

  test('should set configVersion to CURRENT_CONFIG_VERSION after migration', () => {
    const config = makeV0Config();
    migrateConfig(config);
    expect(config.configVersion).toBe(CURRENT_CONFIG_VERSION);
  });

  test('should handle missing profiles array gracefully', () => {
    const config = makeV0Config({ profiles: undefined });
    expect(() => migrateConfig(config)).not.toThrow();
    expect(config.configVersion).toBe(CURRENT_CONFIG_VERSION);
  });

  test('should fix stale modelId on profile', () => {
    const config = makeV0Config({
      profiles: [
        { id: 'test', name: 'Test', modelId: 'gpt-5-mini', provider: 'openai', isBuiltin: false },
      ] as any,
    });
    migrateConfig(config);
    expect(config.profiles![0].modelId).toBe('gpt-5.1-codex-mini');
  });

  test('should fix stale modelId in fastModel', () => {
    const config = makeV0Config({
      profiles: [
        {
          id: 'test', name: 'Test', modelId: 'gpt-4o', provider: 'openai', isBuiltin: false,
          fastModel: { provider: 'openai', modelId: 'gpt-5-mini' },
        },
      ] as any,
    });
    migrateConfig(config);
    expect(config.profiles![0].fastModel!.modelId).toBe('gpt-5.1-codex-mini');
  });

  test('should fix stale modelId in visionModel', () => {
    const config = makeV0Config({
      profiles: [
        {
          id: 'test', name: 'Test', modelId: 'gpt-4o', provider: 'openai', isBuiltin: false,
          visionModel: { provider: 'openai', modelId: 'gpt-5-mini' },
        },
      ] as any,
    });
    migrateConfig(config);
    expect(config.profiles![0].visionModel!.modelId).toBe('gpt-5.1-codex-mini');
  });

  test('should not modify profiles with non-stale model IDs', () => {
    const config = makeV0Config({
      profiles: [
        { id: 'test', name: 'Test', modelId: 'gpt-4o', provider: 'openai', isBuiltin: false },
      ] as any,
    });
    migrateConfig(config);
    expect(config.profiles![0].modelId).toBe('gpt-4o');
  });

  test('should normalize GPT-5.3-Codex IDs for v9 configs in v10 migration', () => {
    const config = makeV0Config({
      configVersion: 9,
      profiles: [
        {
          id: 'oauth-profile',
          name: 'OpenAI OAuth',
          modelId: 'GPT-5.3-Codex',
          provider: 'openai-oauth',
          isBuiltin: false,
          fastModel: { provider: 'openai-oauth', modelId: 'GPT-5.3-Codex' },
          visionModel: { provider: 'openai-oauth', modelId: 'GPT-5.3-Codex' },
        },
      ] as any,
    });

    migrateConfig(config);

    expect(config.profiles![0].modelId).toBe('gpt-5.3-codex');
    expect(config.profiles![0].fastModel!.modelId).toBe('gpt-5.3-codex');
    expect(config.profiles![0].visionModel!.modelId).toBe('gpt-5.3-codex');
  });

  test('should fix multiple profiles in one pass', () => {
    const config = makeV0Config({
      profiles: [
        { id: 'a', name: 'A', modelId: 'gpt-5-mini', provider: 'openai', isBuiltin: false },
        { id: 'b', name: 'B', modelId: 'gpt-5-mini', provider: 'openai', isBuiltin: true },
        { id: 'c', name: 'C', modelId: 'gpt-4o', provider: 'openai', isBuiltin: false },
      ] as any,
    });
    migrateConfig(config);
    expect(config.profiles![0].modelId).toBe('gpt-5.1-codex-mini');
    expect(config.profiles![1].modelId).toBe('gpt-5.1-codex-mini');
    expect(config.profiles![2].modelId).toBe('gpt-4o');
  });

  test('should treat missing configVersion as version 0', () => {
    const config = makeV0Config();
    delete (config as any).configVersion;
    const result = migrateConfig(config);
    expect(result).toBe(true);
    expect(config.configVersion).toBe(CURRENT_CONFIG_VERSION);
  });

  test('should repair hosted OpenRouter model IDs through v7 then v9 to interpreter aliases', () => {
    const config = makeV0Config({
      configVersion: 6,
      profiles: [
        {
          id: 'hosted',
          name: 'Hosted',
          provider: 'hosted',
          modelId: 'anthropic/claude-sonnet-4.6',
          isBuiltin: false,
          fastModel: { provider: 'hosted', modelId: 'openai/gpt-oss-120b' },
          visionModel: { provider: 'hosted', modelId: 'openai/gpt-5.2' },
        },
      ] as any,
    });

    migrateConfig(config);

    expect(config.profiles![0].modelId).toBe('interpreter-smart');
    expect(config.profiles![0].fastModel!.modelId).toBe('openai/gpt-oss-120b');
    expect(config.profiles![0].visionModel!.modelId).toBe('interpreter-smart');
  });

  test('should force unknown hosted models back to interpreter-smart defaults via v7+v9', () => {
    const config = makeV0Config({
      configVersion: 6,
      profiles: [
        {
          id: 'hosted',
          name: 'Hosted',
          provider: 'hosted',
          modelId: 'some-removed-model',
          isBuiltin: false,
          fastModel: { provider: 'hosted', modelId: 'broken-fast-id' },
          visionModel: { provider: 'hosted', modelId: 'broken-vision-id' },
        },
      ] as any,
    });

    migrateConfig(config);

    expect(config.profiles![0].modelId).toBe('interpreter-smart');
    expect(config.profiles![0].fastModel!.modelId).toBe('interpreter-fast');
    expect(config.profiles![0].visionModel!.modelId).toBe('interpreter-smart');
  });

  test('should synchronize hosted profile names when migration rewrites to interpreter aliases', () => {
    const config = makeV0Config({
      configVersion: 6,
      profiles: [
        {
          id: 'hosted',
          name: 'GPT-5.4-mini',
          provider: 'hosted',
          modelId: 'some-removed-model',
          isBuiltin: false,
        },
      ] as any,
    });

    migrateConfig(config);

    expect(config.profiles![0].modelId).toBe('interpreter-smart');
    expect(config.profiles![0].name).toBe('Interpreter Smart');
  });

  test('should repair anthropic API sub-models that were incorrectly migrated to GPT IDs', () => {
    const config = makeV0Config({
      configVersion: 6,
      profiles: [
        {
          id: 'api-profile',
          name: 'API Profile',
          provider: 'openai',
          modelId: 'gpt-4o',
          isBuiltin: false,
          fastModel: { provider: 'api', apiFormat: 'anthropic', modelId: 'openai/gpt-5.2' },
          visionModel: { provider: 'api', apiFormat: 'anthropic', modelId: 'gpt-5-mini' },
        },
      ] as any,
    });

    migrateConfig(config);

    expect(config.profiles![0].modelId).toBe('gpt-4o');
    expect(config.profiles![0].fastModel!.modelId).toBe('claude-sonnet-4-5-20250929');
    expect(config.profiles![0].visionModel!.modelId).toBe('claude-haiku-4-5');
  });

  test('should not rewrite non-hosted profiles in v7 migration', () => {
    const config = makeV0Config({
      configVersion: 6,
      profiles: [
        { id: 'openai-oauth', name: 'OAuth', provider: 'openai-oauth', modelId: 'gpt-5.2-codex', isBuiltin: false },
      ] as any,
    });

    migrateConfig(config);

    expect(config.profiles![0].modelId).toBe('gpt-5.2-codex');
  });

  test('should preserve local profiles in v8 migration', () => {
    const config = makeV0Config({
      configVersion: 7,
      profiles: [
        { id: 'hosted-1', name: 'Smart', provider: 'hosted', modelId: 'claude-sonnet-4-5-20250929', isBuiltin: false },
        { id: 'local-tinyllama', name: 'Local', provider: 'local', modelId: 'tinyllama:latest', isBuiltin: false },
        { id: 'local-deepseek', name: 'DeepSeek', provider: 'local', modelId: 'deepseek-r1:8b', isBuiltin: false },
        { id: 'local-qwen', name: 'Qwen', provider: 'local', modelId: 'qwen3:8b', isBuiltin: false },
      ] as any,
    });

    migrateConfig(config);

    expect(config.profiles).toHaveLength(4);
    expect(config.profiles![0].id).toBe('hosted-1');
    expect(config.profiles![1].id).toBe('local-tinyllama');
  });

  test('should preserve defaultProfileId in v8 migration', () => {
    const config = makeV0Config({
      configVersion: 7,
      defaultProfileId: 'local-tinyllama',
      profiles: [
        { id: 'hosted-1', name: 'Smart', provider: 'hosted', modelId: 'claude-sonnet-4-5-20250929', isBuiltin: false },
        { id: 'local-tinyllama', name: 'Local', provider: 'local', modelId: 'tinyllama:latest', isBuiltin: false },
      ] as any,
    });

    migrateConfig(config);

    expect(config.profiles).toHaveLength(2);
    expect(config.defaultProfileId).toBe('local-tinyllama');
  });

  test('should keep tool-capable local profiles in v8 migration', () => {
    const config = makeV0Config({
      configVersion: 7,
      profiles: [
        { id: 'local-qwen', name: 'Qwen', provider: 'local', modelId: 'qwen3:8b', isBuiltin: false },
        { id: 'local-mistral', name: 'Mistral', provider: 'local', modelId: 'mistral-nemo:12b', isBuiltin: false },
        { id: 'local-llama', name: 'Llama', provider: 'local', modelId: 'llama3.1:8b', isBuiltin: false },
      ] as any,
    });

    migrateConfig(config);

    expect(config.profiles).toHaveLength(3);
  });

  test('should not touch non-local profiles in v8 migration', () => {
    const config = makeV0Config({
      configVersion: 7,
      profiles: [
        { id: 'api-custom', name: 'Custom API', provider: 'api', modelId: 'some-random-model', isBuiltin: false },
        { id: 'hosted-1', name: 'Hosted', provider: 'hosted', modelId: 'claude-sonnet-4-5-20250929', isBuiltin: false },
      ] as any,
    });

    migrateConfig(config);

    expect(config.profiles).toHaveLength(2);
  });

  test('should migrate all hosted profiles to interpreter-smart in v9 migration', () => {
    const config = makeV0Config({
      configVersion: 8,
      profiles: [
        { id: 'a', name: 'Sonnet', provider: 'hosted', modelId: 'claude-sonnet-4-5-20250929', isBuiltin: false },
        { id: 'b', name: 'Opus', provider: 'hosted', modelId: 'claude-opus-4-6', isBuiltin: false },
        { id: 'c', name: 'Haiku', provider: 'hosted', modelId: 'claude-haiku-4-5', isBuiltin: false },
        { id: 'd', name: 'GPT', provider: 'hosted', modelId: 'gpt-4o', isBuiltin: false },
      ] as any,
    });

    migrateConfig(config);

    for (const profile of config.profiles!) {
      expect(profile.modelId).toBe('interpreter-smart');
    }
  });

  test('should migrate hosted fastModel to interpreter-fast in v9 migration', () => {
    const config = makeV0Config({
      configVersion: 8,
      profiles: [
        {
          id: 'hosted-1',
          name: 'Smart',
          provider: 'hosted',
          modelId: 'claude-sonnet-4-5-20250929',
          isBuiltin: false,
          fastModel: { provider: 'hosted', modelId: 'groq/openai/gpt-oss-120b' },
          visionModel: { provider: 'hosted', modelId: 'claude-sonnet-4-5-20250929' },
        },
      ] as any,
    });

    migrateConfig(config);

    expect(config.profiles![0].modelId).toBe('interpreter-smart');
    expect(config.profiles![0].fastModel!.modelId).toBe('interpreter-fast');
    expect(config.profiles![0].visionModel!.modelId).toBe('interpreter-smart');
  });

  test('should not touch non-hosted profiles in v9 migration', () => {
    const config = makeV0Config({
      configVersion: 8,
      profiles: [
        { id: 'oauth', name: 'OAuth', provider: 'openai-oauth', modelId: 'gpt-5.2-codex', isBuiltin: false },
        { id: 'api', name: 'API', provider: 'api', modelId: 'claude-sonnet-4-6', isBuiltin: false },
        { id: 'local', name: 'Local', provider: 'local', modelId: 'qwen3:8b', isBuiltin: false },
      ] as any,
    });

    migrateConfig(config);

    expect(config.profiles![0].modelId).toBe('gpt-5.2-codex');
    expect(config.profiles![1].modelId).toBe('claude-sonnet-4-6');
    expect(config.profiles![2].modelId).toBe('qwen3:8b');
  });

  test('should add baseURL and codexProfileId to Ollama profiles missing them in v9 migration', () => {
    const config = makeV0Config({
      configVersion: 8,
      profiles: [
        {
          id: 'onboarding:ollama-qwen3-8b',
          name: 'Qwen3 8B (Local)',
          provider: 'local',
          providerId: 'builtin:local',
          modelId: 'qwen3:8b',
          isBuiltin: false,
        },
      ] as any,
    });

    migrateConfig(config);

    expect(config.profiles![0].baseURL).toBe('http://localhost:11434/v1');
    expect(config.profiles![0].codexProfileId).toBe('ollama');
  });

  test('should add baseURL and codexProfileId to LM Studio profiles missing them in v9 migration', () => {
    const config = makeV0Config({
      configVersion: 8,
      profiles: [
        {
          id: 'onboarding:lmstudio-qwen3-8b',
          name: 'Qwen3 8B (LM Studio)',
          provider: 'local',
          providerId: 'builtin:local',
          modelId: 'qwen3:8b',
          isBuiltin: false,
        },
      ] as any,
    });

    migrateConfig(config);

    expect(config.profiles![0].baseURL).toBe('http://localhost:1234/v1');
    expect(config.profiles![0].codexProfileId).toBe('lmstudio');
  });

  test('should not overwrite existing baseURL on local profiles in v9 migration', () => {
    const config = makeV0Config({
      configVersion: 8,
      profiles: [
        {
          id: 'onboarding:lmstudio-qwen3-8b',
          name: 'Qwen3 8B (LM Studio)',
          provider: 'local',
          providerId: 'builtin:local',
          modelId: 'qwen3:8b',
          baseURL: 'http://custom-host:1234/v1',
          codexProfileId: 'lmstudio',
          isBuiltin: false,
        },
      ] as any,
    });

    migrateConfig(config);

    expect(config.profiles![0].baseURL).toBe('http://custom-host:1234/v1');
    expect(config.profiles![0].codexProfileId).toBe('lmstudio');
  });

  test('should not add baseURL/codexProfileId to non-local profiles in v9 migration', () => {
    const config = makeV0Config({
      configVersion: 8,
      profiles: [
        { id: 'hosted-1', name: 'Smart', provider: 'hosted', modelId: 'claude-sonnet-4-5-20250929', isBuiltin: false },
        { id: 'api-1', name: 'API', provider: 'api', modelId: 'gpt-4o', isBuiltin: false },
      ] as any,
    });

    migrateConfig(config);

    expect(config.profiles![0].baseURL).toBeUndefined();
    expect(config.profiles![0].codexProfileId).toBeUndefined();
    expect(config.profiles![1].baseURL).toBeUndefined();
    expect(config.profiles![1].codexProfileId).toBeUndefined();
  });

  test('should preserve valid OpenRouter model IDs on hosted profiles in v9 migration', () => {
    const config = makeV0Config({
      configVersion: 8,
      profiles: [
        { id: 'a', name: 'OR Opus', provider: 'hosted', modelId: 'anthropic/claude-opus-4.6', isBuiltin: false },
        { id: 'b', name: 'OR Sonnet', provider: 'hosted', modelId: 'openai/gpt-5.3-codex', isBuiltin: false },
        { id: 'c', name: 'OR Terminus', provider: 'hosted', modelId: 'deepseek/deepseek-v3.1-terminus', isBuiltin: false },
      ] as any,
    });

    migrateConfig(config);

    expect(config.profiles![0].modelId).toBe('anthropic/claude-opus-4.6');
    expect(config.profiles![1].modelId).toBe('openai/gpt-5.3-codex');
    expect(config.profiles![2].modelId).toBe('deepseek/deepseek-v3.1-terminus');
  });

  test('should preserve OpenRouter model IDs on hosted fastModel/visionModel in v9 migration', () => {
    const config = makeV0Config({
      configVersion: 8,
      profiles: [
        {
          id: 'hosted-or',
          name: 'OR Mixed',
          provider: 'hosted',
          modelId: 'anthropic/claude-opus-4.6',
          isBuiltin: false,
          fastModel: { provider: 'hosted', modelId: 'anthropic/claude-haiku-4.5' },
          visionModel: { provider: 'hosted', modelId: 'google/gemini-3.1-pro-preview' },
        },
      ] as any,
    });

    migrateConfig(config);

    expect(config.profiles![0].modelId).toBe('anthropic/claude-opus-4.6');
    expect(config.profiles![0].fastModel!.modelId).toBe('anthropic/claude-haiku-4.5');
    expect(config.profiles![0].visionModel!.modelId).toBe('google/gemini-3.1-pro-preview');
  });

  test('should reset bare model IDs but preserve interpreter and OpenRouter IDs in v9 migration', () => {
    const config = makeV0Config({
      configVersion: 8,
      profiles: [
        { id: 'a', name: 'Bare', provider: 'hosted', modelId: 'claude-sonnet-4-5-20250929', isBuiltin: false },
        { id: 'b', name: 'Interp', provider: 'hosted', modelId: 'interpreter-smart', isBuiltin: false },
        { id: 'c', name: 'OR', provider: 'hosted', modelId: 'anthropic/claude-sonnet-4.6', isBuiltin: false },
      ] as any,
    });

    migrateConfig(config);

    expect(config.profiles![0].modelId).toBe('interpreter-smart');
    expect(config.profiles![1].modelId).toBe('interpreter-smart');
    expect(config.profiles![2].modelId).toBe('anthropic/claude-sonnet-4.6');
    expect(config.lastMigrationVersion).toBe(CURRENT_CONFIG_VERSION);
    expect(config.lastMigrationUnsupportedProfiles).toEqual([
      {
        profileId: 'a',
        profileName: 'Bare',
        field: 'modelId',
        previousModelId: 'claude-sonnet-4-5-20250929',
      },
    ]);
  });

  test('should record all unsupported hosted submodel replacements in migration report', () => {
    const config = makeV0Config({
      configVersion: 8,
      profiles: [
        {
          id: 'mixed',
          name: 'Mixed Hosted',
          provider: 'hosted',
          modelId: 'gpt-4o',
          isBuiltin: false,
          fastModel: { provider: 'hosted', modelId: 'claude-opus-4-6' },
          visionModel: { provider: 'hosted', modelId: 'gpt-5.2' },
        },
      ] as any,
    });

    migrateConfig(config);

    expect(config.lastMigrationUnsupportedProfiles).toEqual([
      {
        profileId: 'mixed',
        profileName: 'Mixed Hosted',
        field: 'modelId',
        previousModelId: 'gpt-4o',
      },
      {
        profileId: 'mixed',
        profileName: 'Mixed Hosted',
        field: 'fastModel',
        previousModelId: 'claude-opus-4-6',
      },
      {
        profileId: 'mixed',
        profileName: 'Mixed Hosted',
        field: 'visionModel',
        previousModelId: 'gpt-5.2',
      },
    ]);
  });

  test('should not overwrite non-hosted fastModel/visionModel in v9 migration', () => {
    const config = makeV0Config({
      configVersion: 8,
      profiles: [
        {
          id: 'hosted-mixed',
          name: 'Mixed',
          provider: 'hosted',
          modelId: 'claude-opus-4-6',
          isBuiltin: false,
          fastModel: { provider: 'api', apiFormat: 'anthropic', modelId: 'claude-haiku-4-5' },
          visionModel: { provider: 'api', apiFormat: 'openai', modelId: 'gpt-4o' },
        },
      ] as any,
    });

    migrateConfig(config);

    expect(config.profiles![0].modelId).toBe('interpreter-smart');
    expect(config.profiles![0].fastModel!.modelId).toBe('claude-haiku-4-5');
    expect(config.profiles![0].visionModel!.modelId).toBe('gpt-4o');
  });

  // =========================================================================
  // v9: Fast-intent hosted profiles get interpreter-fast fallback
  // =========================================================================

  test('should fall back to interpreter-fast for fast-intent hosted profiles with invalid modelId in v9', () => {
    const config = makeV0Config({
      configVersion: 8,
      profiles: [
        { id: 'auto:hosted-fast', name: 'Hosted Fast', provider: 'hosted', modelId: 'groq/openai/gpt-oss-120b', isBuiltin: false },
        { id: 'auto:hosted-smart', name: 'Hosted Smart', provider: 'hosted', modelId: 'claude-sonnet-4-5-20250929', isBuiltin: false },
      ] as any,
    });

    migrateConfig(config);

    expect(config.profiles![0].modelId).toBe('interpreter-fast');
    expect(config.profiles![1].modelId).toBe('interpreter-smart');
  });

  test('should record fast-intent fallback in unsupported profiles migration report', () => {
    const config = makeV0Config({
      configVersion: 8,
      profiles: [
        { id: 'auto:hosted-fast', name: 'Hosted Fast', provider: 'hosted', modelId: 'groq/openai/gpt-oss-120b', isBuiltin: false },
      ] as any,
    });

    migrateConfig(config);

    expect(config.lastMigrationUnsupportedProfiles).toEqual([
      {
        profileId: 'auto:hosted-fast',
        profileName: 'Hosted Fast',
        field: 'modelId',
        previousModelId: 'groq/openai/gpt-oss-120b',
      },
    ]);
    expect(config.profiles![0].modelId).toBe('interpreter-fast');
  });

  // =========================================================================
  // v9: Remove ACP profiles
  // =========================================================================

  test('should remove ACP profiles in v9 migration', () => {
    const config = makeV0Config({
      configVersion: 8,
      profiles: [
        { id: 'hosted-1', name: 'Smart', provider: 'hosted', modelId: 'interpreter-smart', isBuiltin: false },
        { id: 'acp-gemini', name: 'Gemini CLI', provider: 'acp', modelId: 'gemini-pro', isBuiltin: false },
      ] as any,
    });

    migrateConfig(config);

    expect(config.profiles).toHaveLength(1);
    expect(config.profiles![0].id).toBe('hosted-1');
  });

  test('should update defaultProfileId when it pointed to a removed ACP profile', () => {
    const config = makeV0Config({
      configVersion: 8,
      defaultProfileId: 'acp-gemini',
      profiles: [
        { id: 'hosted-1', name: 'Smart', provider: 'hosted', modelId: 'interpreter-smart', isBuiltin: false },
        { id: 'acp-gemini', name: 'Gemini CLI', provider: 'acp', modelId: 'gemini-pro', isBuiltin: false },
      ] as any,
    });

    migrateConfig(config);

    expect(config.profiles).toHaveLength(1);
    expect(config.defaultProfileId).toBe('hosted-1');
  });

  // =========================================================================
  // v9: Remove claude-oauth profiles
  // =========================================================================

  test('should remove claude-oauth profiles in v9 migration', () => {
    const config = makeV0Config({
      configVersion: 8,
      profiles: [
        { id: 'hosted-1', name: 'Smart', provider: 'hosted', modelId: 'interpreter-smart', isBuiltin: false },
        { id: 'claude-pro', name: 'Claude Pro', provider: 'claude-oauth', modelId: 'claude-sonnet-4', isBuiltin: false },
      ] as any,
    });

    migrateConfig(config);

    expect(config.profiles).toHaveLength(1);
    expect(config.profiles![0].id).toBe('hosted-1');
  });

  // =========================================================================
  // v9: Record deprecated profiles in migration report
  // =========================================================================

  test('should record removed ACP and claude-oauth profiles in deprecated report', () => {
    const config = makeV0Config({
      configVersion: 8,
      profiles: [
        { id: 'acp-gemini', name: 'Gemini CLI', provider: 'acp', modelId: 'gemini-pro', isBuiltin: false },
        { id: 'claude-pro', name: 'Claude Pro', provider: 'claude-oauth', modelId: 'claude-sonnet-4', isBuiltin: false },
      ] as any,
    });

    migrateConfig(config);

    expect(config.lastMigrationDeprecatedProfiles).toEqual([
      { profileId: 'acp-gemini', profileName: 'Gemini CLI', provider: 'acp', reason: expect.stringContaining('no longer supported') },
      { profileId: 'claude-pro', profileName: 'Claude Pro', provider: 'claude-oauth', reason: expect.stringContaining('no longer supported') },
    ]);
  });

  test('should remove stale provider entries for removed provider types', () => {
    const config = makeV0Config({
      configVersion: 8,
      profiles: [] as any,
      providers: {
        'builtin:hosted': { id: 'builtin:hosted', name: 'Hosted', type: 'hosted', createdAt: 0, updatedAt: 0 },
        'builtin:claude-oauth': { id: 'builtin:claude-oauth', name: 'Claude (OAuth)', type: 'claude-oauth', createdAt: 0, updatedAt: 0 },
        'builtin:openai-oauth': { id: 'builtin:openai-oauth', name: 'OpenAI (OAuth)', type: 'openai-oauth', createdAt: 0, updatedAt: 0 },
      },
    });

    migrateConfig(config);

    expect(config.providers!['builtin:hosted']).toBeDefined();
    expect(config.providers!['builtin:openai-oauth']).toBeDefined();
    expect(config.providers!['builtin:claude-oauth']).toBeUndefined();
  });

  // =========================================================================
  // v9: Remove anthropic API format profiles
  // =========================================================================

  test('should remove anthropic API format profiles and record them as deprecated', () => {
    const config = makeV0Config({
      configVersion: 8,
      profiles: [
        { id: 'anth-direct', name: 'Anthropic Direct', provider: 'api', apiFormat: 'anthropic', modelId: 'claude-sonnet-4', isBuiltin: false },
      ] as any,
    });

    migrateConfig(config);

    expect(config.profiles).toHaveLength(0);
    expect(config.lastMigrationDeprecatedProfiles).toContainEqual(
      expect.objectContaining({ profileId: 'anth-direct', provider: 'api' }),
    );
  });

  test('should reset defaultProfileId when anthropic API profile was the default', () => {
    const config = makeV0Config({
      configVersion: 8,
      defaultProfileId: 'anth',
      profiles: [
        { id: 'anth', name: 'Anthropic', provider: 'api', apiFormat: 'anthropic', modelId: 'claude-sonnet-4', isBuiltin: false },
        { id: 'oi-api', name: 'OpenAI', provider: 'api', apiFormat: 'openai', modelId: 'gpt-4o', isBuiltin: false },
      ] as any,
    });

    migrateConfig(config);

    expect(config.profiles).toHaveLength(1);
    expect(config.profiles![0].id).toBe('oi-api');
    expect(config.defaultProfileId).toBe('oi-api');
  });

  // =========================================================================
  // v9: Migrate known API presets to Responses API
  // =========================================================================

  test('should set useResponsesApi on api profiles with openai preset in v9 migration', () => {
    const config = makeV0Config({
      configVersion: 8,
      profiles: [
        { id: 'oi-api', name: 'OpenAI API', provider: 'api', apiFormat: 'openai', modelId: 'gpt-4o', isBuiltin: false, providerId: 'prov-oi' },
      ] as any,
      providers: {
        'prov-oi': { id: 'prov-oi', name: 'OpenAI', type: 'api', api: { preset: 'openai' }, createdAt: 0, updatedAt: 0 },
      },
    });

    migrateConfig(config);

    expect(config.profiles![0].useResponsesApi).toBe(true);
  });

  test('should set useResponsesApi on api profiles with groq preset in v9 migration', () => {
    const config = makeV0Config({
      configVersion: 8,
      profiles: [
        { id: 'groq-api', name: 'Groq', provider: 'api', apiFormat: 'openai', modelId: 'llama-3.3-70b', isBuiltin: false, providerId: 'prov-groq' },
      ] as any,
      providers: {
        'prov-groq': { id: 'prov-groq', name: 'Groq', type: 'api', api: { preset: 'groq' }, createdAt: 0, updatedAt: 0 },
      },
    });

    migrateConfig(config);

    expect(config.profiles![0].useResponsesApi).toBe(true);
  });

  test('should set useResponsesApi on api profiles with openrouter preset in v9 migration', () => {
    const config = makeV0Config({
      configVersion: 8,
      profiles: [
        { id: 'or-api', name: 'OpenRouter', provider: 'api', apiFormat: 'openai', modelId: 'anthropic/claude-opus-4.6', isBuiltin: false, providerId: 'prov-or' },
      ] as any,
      providers: {
        'prov-or': { id: 'prov-or', name: 'OpenRouter', type: 'api', api: { preset: 'openrouter' }, createdAt: 0, updatedAt: 0 },
      },
    });

    migrateConfig(config);

    expect(config.profiles![0].useResponsesApi).toBe(true);
  });

  test('should set useResponsesApi on api profiles matching known baseURL without provider', () => {
    const config = makeV0Config({
      configVersion: 8,
      profiles: [
        { id: 'oi-inline', name: 'OpenAI Inline', provider: 'api', apiFormat: 'openai', modelId: 'gpt-4o', isBuiltin: false, baseURL: 'https://api.openai.com/v1' },
        { id: 'groq-inline', name: 'Groq Inline', provider: 'api', apiFormat: 'openai', modelId: 'llama-70b', isBuiltin: false, baseURL: 'https://api.groq.com/openai/v1' },
        { id: 'or-inline', name: 'OR Inline', provider: 'api', apiFormat: 'openai', modelId: 'anthropic/claude-opus', isBuiltin: false, baseURL: 'https://openrouter.ai/api/v1' },
      ] as any,
    });

    migrateConfig(config);

    expect(config.profiles![0].useResponsesApi).toBe(true);
    expect(config.profiles![1].useResponsesApi).toBe(true);
    expect(config.profiles![2].useResponsesApi).toBe(true);
  });

  test('should set useResponsesApi on api profiles with no preset and custom baseURL', () => {
    const config = makeV0Config({
      configVersion: 8,
      profiles: [
        { id: 'custom-api', name: 'Custom Endpoint', provider: 'api', apiFormat: 'openai', modelId: 'my-model', isBuiltin: false, providerId: 'prov-custom' },
      ] as any,
      providers: {
        'prov-custom': { id: 'prov-custom', name: 'Custom', type: 'api', api: {}, createdAt: 0, updatedAt: 0 },
      },
    });

    migrateConfig(config);

    expect(config.profiles![0].useResponsesApi).toBe(true);
  });

  test('should set useResponsesApi on api profiles with unknown baseURL and no provider', () => {
    const config = makeV0Config({
      configVersion: 8,
      profiles: [
        { id: 'custom-inline', name: 'Custom', provider: 'api', apiFormat: 'openai', modelId: 'my-model', isBuiltin: false, baseURL: 'https://my-llm-proxy.internal.co/v1' },
      ] as any,
    });

    migrateConfig(config);

    expect(config.profiles![0].useResponsesApi).toBe(true);
  });

  // =========================================================================
  // v9: Mixed config - all deprecated types in single pass
  // =========================================================================

  test('should handle mixed config with hosted, api, acp, and claude-oauth in single v9 pass', () => {
    const config = makeV0Config({
      configVersion: 8,
      defaultProfileId: 'hosted-1',
      profiles: [
        { id: 'hosted-1', name: 'Smart', provider: 'hosted', modelId: 'claude-sonnet-4-5-20250929', isBuiltin: false },
        { id: 'oi-api', name: 'OpenAI', provider: 'api', apiFormat: 'openai', modelId: 'gpt-4o', isBuiltin: false, providerId: 'prov-oi' },
        { id: 'anth-api', name: 'Anthropic', provider: 'api', apiFormat: 'anthropic', modelId: 'claude-sonnet-4', isBuiltin: false },
        { id: 'acp-1', name: 'Gemini', provider: 'acp', modelId: 'gemini-pro', isBuiltin: false },
        { id: 'claude-oauth-1', name: 'Claude Pro', provider: 'claude-oauth', modelId: 'claude-sonnet-4', isBuiltin: false },
        { id: 'local-1', name: 'Qwen', provider: 'local', modelId: 'qwen3:8b', isBuiltin: false },
      ] as any,
      providers: {
        'prov-oi': { id: 'prov-oi', name: 'OpenAI', type: 'api', api: { preset: 'openai' }, createdAt: 0, updatedAt: 0 },
      },
    });

    migrateConfig(config);

    // ACP, claude-oauth, and anthropic API removed
    expect(config.profiles!.map((p: any) => p.id)).toEqual(['hosted-1', 'oi-api', 'local-1']);
    // Hosted migrated to interpreter-smart
    expect(config.profiles![0].modelId).toBe('interpreter-smart');
    // OpenAI API got useResponsesApi
    expect(config.profiles![1].useResponsesApi).toBe(true);
    // defaultProfileId still valid
    expect(config.defaultProfileId).toBe('hosted-1');
    // Deprecated profiles recorded (acp + claude-oauth + anthropic api = 3)
    expect(config.lastMigrationDeprecatedProfiles).toHaveLength(3);
  });

  test('should not overwrite useResponsesApi if already set to true', () => {
    const config = makeV0Config({
      configVersion: 8,
      profiles: [
        { id: 'oi-api', name: 'OpenAI', provider: 'api', apiFormat: 'openai', modelId: 'gpt-4o', isBuiltin: false, providerId: 'prov-oi', useResponsesApi: true },
      ] as any,
      providers: {
        'prov-oi': { id: 'prov-oi', name: 'OpenAI', type: 'api', api: { preset: 'openai' }, createdAt: 0, updatedAt: 0 },
      },
    });

    migrateConfig(config);

    expect(config.profiles![0].useResponsesApi).toBe(true);
  });

  test('should canonicalize supported Responses API endpoints in v11 migration', () => {
    const config = makeV0Config({
      configVersion: 10,
      profiles: [
        {
          id: 'api-openai',
          name: 'OpenAI API',
          provider: 'api',
          modelId: 'gpt-5.4',
          baseURL: 'https://api.openai.com/v1',
          isBuiltin: false,
        },
        {
          id: 'api-openrouter',
          name: 'OpenRouter',
          provider: 'api',
          modelId: 'openai/gpt-5.4',
          baseURL: 'https://openrouter.ai/api/v1',
          codexProfileId: 'custom',
          isBuiltin: false,
        },
        {
          id: 'api-nvidia',
          name: 'NVIDIA',
          provider: 'api',
          modelId: 'openai/gpt-oss-120b',
          baseURL: 'https://integrate.api.nvidia.com/v1',
          codexProfileId: 'custom',
          isBuiltin: false,
        },
        {
          id: 'api-groq',
          name: 'Groq',
          provider: 'api',
          modelId: 'openai/gpt-oss-120b',
          baseURL: 'https://api.groq.com/openai/v1',
          isBuiltin: false,
        },
        {
          id: 'api-xai',
          name: 'xAI',
          provider: 'api',
          modelId: 'grok-code-fast-1',
          baseURL: 'https://api.x.ai/v1',
          isBuiltin: false,
        },
        {
          id: 'api-fireworks',
          name: 'Fireworks',
          provider: 'api',
          modelId: 'accounts/fireworks/models/llama-v3p1-8b-instruct',
          baseURL: 'https://api.fireworks.ai/inference/v1',
          isBuiltin: false,
        },
      ] as any,
    });

    migrateConfig(config);

    expect(config.profiles?.map((profile) => profile.codexProfileId)).toEqual([
      'openai-api',
      'openrouter',
      'nvidia',
      'groq',
      'xai',
      'fireworks',
    ]);
  });

  test('should preserve explicit non-custom codexProfileId in v11 migration', () => {
    const config = makeV0Config({
      configVersion: 10,
      profiles: [
        {
          id: 'api-1',
          name: 'Pinned xAI',
          provider: 'api',
          modelId: 'grok-code-fast-1',
          baseURL: 'https://api.openai.com/v1',
          codexProfileId: 'xai',
          isBuiltin: false,
        },
      ] as any,
    });

    migrateConfig(config);

    expect(config.profiles?.[0].codexProfileId).toBe('xai');
  });

  test('should keep unsupported custom API endpoints as custom in v11 migration', () => {
    const config = makeV0Config({
      configVersion: 10,
      profiles: [
        {
          id: 'api-1',
          name: 'My Proxy',
          provider: 'api',
          modelId: 'deepseek-chat',
          baseURL: 'https://proxy.example.com/v1',
          isBuiltin: false,
        },
      ] as any,
    });

    migrateConfig(config);

    expect(config.profiles?.[0].codexProfileId).toBe('custom');
  });
});

describe('OPENROUTER_MODEL_REGEX', () => {
  test('should match standard provider/model IDs', () => {
    expect(OPENROUTER_MODEL_REGEX.test('anthropic/claude-opus-4.6')).toBe(true);
    expect(OPENROUTER_MODEL_REGEX.test('openai/gpt-5.3-codex')).toBe(true);
    expect(OPENROUTER_MODEL_REGEX.test('google/gemini-pro-1.5')).toBe(true);
    expect(OPENROUTER_MODEL_REGEX.test('meta-llama/llama-3.3-70b')).toBe(true);
    expect(OPENROUTER_MODEL_REGEX.test('deepseek/deepseek-v3.1-terminus')).toBe(true);
  });

  test('should match IDs with colon suffixes', () => {
    expect(OPENROUTER_MODEL_REGEX.test('stepfun/step-3.5-flash:free')).toBe(true);
    expect(OPENROUTER_MODEL_REGEX.test('deepseek/deepseek-v3.1-terminus:exacto')).toBe(true);
    expect(OPENROUTER_MODEL_REGEX.test('qwen/qwen3-max:thinking')).toBe(true);
    expect(OPENROUTER_MODEL_REGEX.test('nvidia/nemotron-3-nano-30b-a3b:extended')).toBe(true);
  });

  test('should reject bare model IDs without provider slash', () => {
    expect(OPENROUTER_MODEL_REGEX.test('claude-sonnet-4-5-20250929')).toBe(false);
    expect(OPENROUTER_MODEL_REGEX.test('gpt-4o')).toBe(false);
    expect(OPENROUTER_MODEL_REGEX.test('interpreter-smart')).toBe(false);
    expect(OPENROUTER_MODEL_REGEX.test('interpreter-fast')).toBe(false);
  });

  test('should reject IDs with uppercase characters', () => {
    expect(OPENROUTER_MODEL_REGEX.test('Anthropic/claude-opus-4.6')).toBe(false);
    expect(OPENROUTER_MODEL_REGEX.test('openai/GPT-5')).toBe(false);
  });

  test('should reject IDs with multiple slashes', () => {
    expect(OPENROUTER_MODEL_REGEX.test('groq/openai/gpt-oss-120b')).toBe(false);
  });

  test('should reject empty or malformed IDs', () => {
    expect(OPENROUTER_MODEL_REGEX.test('')).toBe(false);
    expect(OPENROUTER_MODEL_REGEX.test('/')).toBe(false);
    expect(OPENROUTER_MODEL_REGEX.test('/model')).toBe(false);
    expect(OPENROUTER_MODEL_REGEX.test('provider/')).toBe(false);
    expect(OPENROUTER_MODEL_REGEX.test('provider/model:123')).toBe(false);
  });
});

// =========================================================================
// Codex preset / provider collision tests
// =========================================================================

// NOTE(victor): codex-rs built-in provider IDs from built_in_model_providers()
// in codex-rs/core/src/model_provider_info.rs. Our preset IDs must NOT collide
// with these because configValueWrite cannot override built-in providers in the
// running codex process's in-memory registry.
const CODEX_BUILTIN_PROVIDER_IDS = new Set(['openai', 'ollama', 'lmstudio']);

describe('CUSTOM_PRESETS provider ID collision', () => {
  test('cloud API preset IDs should not collide with codex-rs built-in provider names', () => {
    const cloudPresets = CUSTOM_PRESETS.filter((p) => p.requiresApiKey);
    for (const preset of cloudPresets) {
      expect(CODEX_BUILTIN_PROVIDER_IDS.has(preset.id)).toBe(false);
    }
  });

  test('OpenAI API preset should exist and map to a non-colliding modelProvider', () => {
    const preset = CUSTOM_PRESETS.find((p) => p.defaultBaseUrl.includes('api.openai.com'));
    expect(preset).toBeDefined();
    const profile = buildProfileFromPreset(preset!, { apiKey: 'sk-test', model: 'gpt-5.2' });
    expect(CODEX_BUILTIN_PROVIDER_IDS.has(profile.modelProvider!)).toBe(false);
    expect(profile.providerConfig?.base_url).toBe('https://api.openai.com/v1');
    expect(profile.providerConfig?.experimental_bearer_token).toBe('sk-test');
    expect(profile.providerConfig?.http_headers?.Authorization).toBe('Bearer sk-test');
    expect(profile.providerConfig?.requires_openai_auth).toBe(false);
  });

  test('Groq preset should exist and map to a non-colliding modelProvider', () => {
    const preset = CUSTOM_PRESETS.find((p) => p.defaultBaseUrl.includes('api.groq.com'));
    expect(preset).toBeDefined();
    const profile = buildProfileFromPreset(preset!, { apiKey: 'gsk-test', model: 'llama-3.3-70b' });
    expect(CODEX_BUILTIN_PROVIDER_IDS.has(profile.modelProvider!)).toBe(false);
    expect(profile.providerConfig?.base_url).toBe('https://api.groq.com/openai/v1');
    expect(profile.providerConfig?.experimental_bearer_token).toBe('gsk-test');
    expect(profile.providerConfig?.http_headers?.Authorization).toBe('Bearer gsk-test');
  });

  test('each cloud preset should produce a unique modelProvider', () => {
    const cloudPresets = CUSTOM_PRESETS.filter((p) => p.requiresApiKey);
    const providers = cloudPresets.map((p) => buildProfileFromPreset(p, { apiKey: 'test' }).modelProvider);
    const unique = new Set(providers);
    expect(unique.size).toBe(providers.length);
  });
});

describe('isValidHostedModelId', () => {
  test('should accept interpreter aliases', () => {
    expect(isValidHostedModelId('interpreter-smart')).toBe(true);
    expect(isValidHostedModelId('interpreter-fast')).toBe(true);
  });

  test('should accept valid OpenRouter model IDs', () => {
    const sampleIds = OPENROUTER_MODEL_OPTIONS.slice(0, 3).map((option) => option.id);
    expect(sampleIds).toHaveLength(3);
    for (const modelId of sampleIds) {
      expect(isValidHostedModelId(modelId)).toBe(true);
    }
  });

  test('should reject bare model IDs', () => {
    expect(isValidHostedModelId('claude-sonnet-4-5-20250929')).toBe(false);
    expect(isValidHostedModelId('claude-opus-4-6')).toBe(false);
    expect(isValidHostedModelId('gpt-4o')).toBe(false);
    expect(isValidHostedModelId('some-removed-model')).toBe(false);
  });
});
