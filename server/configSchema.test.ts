import { describe, test, expect } from 'bun:test';
import { z } from 'zod';
import { AppConfigSchema } from './configSchema';

describe('operator-scoped Computer Use discovery grants', () => {
  const threadId = '01a0d435-bb2b-7047-afe7-0a639be8e5d4';
  test('accepts only exact-thread list_apps entries within the bound', () => {
    expect(AppConfigSchema.safeParse({ agents: {}, nativeCuaDiscoveryGrants: [{ threadId, toolName: 'list_apps' }] }).success).toBe(true);
    for (const entry of [
      { threadId: '*', toolName: 'list_apps' },
      { threadId, toolName: 'click' },
      { threadId, toolName: 'list_apps', extra: true },
    ]) expect(AppConfigSchema.safeParse({ agents: {}, nativeCuaDiscoveryGrants: [entry] }).success).toBe(false);
    expect(AppConfigSchema.safeParse({ agents: {}, nativeCuaDiscoveryGrants: Array(33).fill({ threadId, toolName: 'list_apps' }) }).success).toBe(false);
  });
});

const VALID_PROVIDER_TYPES = [
  'hosted',
  'openai-oauth',
  'api',
  'local',
  'agent',
  'terminal',
] as const;

const ModelProviderSchema = z.enum([...VALID_PROVIDER_TYPES]);
const ProviderTypeSchema = z.enum([...VALID_PROVIDER_TYPES]);

describe('configSchema provider validation (#591, #590)', () => {
  test('openai-oauth should be a valid model provider', () => {
    const result = ModelProviderSchema.safeParse('openai-oauth');
    expect(result.success).toBe(true);
  });

  test('openai-oauth should be a valid provider type', () => {
    const result = ProviderTypeSchema.safeParse('openai-oauth');
    expect(result.success).toBe(true);
  });

  test('unknown provider strings should be rejected', () => {
    const result = ModelProviderSchema.safeParse('openai-oauth-v2');
    expect(result.success).toBe(false);
  });

  for (const provider of VALID_PROVIDER_TYPES) {
    test(`${provider} should be accepted by ModelProviderSchema`, () => {
      expect(ModelProviderSchema.safeParse(provider).success).toBe(true);
    });

    test(`${provider} should be accepted by ProviderTypeSchema`, () => {
      expect(ProviderTypeSchema.safeParse(provider).success).toBe(true);
    });
  }
});

describe('programmatic task profile validation (#591)', () => {
  const ProgrammaticProfileSchema = z.object({
    provider: ModelProviderSchema,
    modelId: z.string(),
    id: z.string().optional(),
    name: z.string().optional(),
    apiFormat: z.enum(['openai', 'anthropic']).optional(),
  });

  test('openai-oauth profile should validate', () => {
    const result = ProgrammaticProfileSchema.safeParse({
      provider: 'openai-oauth',
      modelId: 'gpt-4o',
    });
    expect(result.success).toBe(true);
  });

  test('profile with unknown provider should fail validation', () => {
    const result = ProgrammaticProfileSchema.safeParse({
      provider: 'unknown-provider',
      modelId: 'some-model',
    });
    expect(result.success).toBe(false);
  });

  test('hosted profile should validate', () => {
    const result = ProgrammaticProfileSchema.safeParse({
      provider: 'hosted',
      modelId: 'interpreter-smart',
    });
    expect(result.success).toBe(true);
  });
});
