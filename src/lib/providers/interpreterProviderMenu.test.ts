import { describe, expect, test } from 'bun:test';

import type { Profile } from '../../../shared/types/profile';
import type { v2 } from '../../../server/handlers/codex-generated-types';
import {
  buildProviderMenuEntries,
  profileToOixProviderId,
} from './interpreterProviderMenu';

function profile(overrides: Partial<Profile>): Profile {
  return {
    id: 'profile-1',
    name: 'Profile',
    provider: 'api',
    modelId: 'model-1',
    isBuiltin: false,
    ...overrides,
  };
}

describe('profileToOixProviderId', () => {
  test('maps app profile lanes to OIX provider ids', () => {
    expect(profileToOixProviderId(profile({
      provider: 'openai-oauth',
    }))).toBe('openai');
    expect(profileToOixProviderId(profile({
      provider: 'api',
      codexProfileId: 'openai-api',
    }))).toBe('openai');
    expect(profileToOixProviderId(profile({
      provider: 'api',
      codexProfileId: 'openrouter',
    }))).toBe('openrouter');
    expect(profileToOixProviderId(profile({
      provider: 'local',
      codexProfileId: 'lmstudio',
    }))).toBe('lmstudio');
  });

  test('does not invent runtime providers for app-owned lanes', () => {
    expect(profileToOixProviderId(profile({ provider: 'hosted' }))).toBeUndefined();
    expect(profileToOixProviderId(profile({ provider: 'terminal' }))).toBeUndefined();
  });
});

describe('buildProviderMenuEntries', () => {
  test('presents both OpenAI auth experiences over the unified OIX provider', () => {
    const provider: v2.InterpreterProvider = {
      id: 'openai',
      name: 'OpenAI',
      description: 'OpenAI models',
      isCurrent: true,
      configured: true,
      isDefault: true,
    };

    const openAiEntries = buildProviderMenuEntries([provider])
      .filter((entry) => entry.oixProviderId === 'openai');
    expect(openAiEntries).toHaveLength(2);
    expect(openAiEntries.map((entry) => entry.appProviderType).sort())
      .toEqual(['api', 'openai-oauth']);
  });

  test('passes unknown OIX providers through without a Workstation allowlist', () => {
    const provider: v2.InterpreterProvider = {
      id: 'future-provider',
      name: 'Future Provider',
      description: 'Added by a newer OIX release',
      isCurrent: false,
      configured: true,
      isDefault: false,
      baseUrl: 'https://future.example/v1',
      wireApi: 'chat',
      envKey: 'FUTURE_API_KEY',
    };

    const entry = buildProviderMenuEntries([provider])
      .find((candidate) => candidate.oixProviderId === provider.id);
    expect(entry).toMatchObject({
      appProviderType: 'api',
      displayName: 'Future Provider',
      baseUrl: 'https://future.example/v1',
      wireApi: 'chat',
      envKey: 'FUTURE_API_KEY',
    });
    expect(entry?.isDocumentedFallback).not.toBe(true);
  });
});
