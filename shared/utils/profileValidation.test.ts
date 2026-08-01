import { describe, expect, test } from 'bun:test';

import type { Profile } from '../types/profile';
import { getMissingProfileFields } from './profileValidation';

const emptyEnvKeys = {
  openai: { found: false },
  anthropic: { found: false },
  openrouter: { found: false },
  groq: { found: false },
  deepseek: { found: false },
};

function buildProfile(overrides: Partial<Profile>): Profile {
  return {
    id: 'custom:test',
    name: 'Test Profile',
    provider: 'api',
    modelId: 'gpt-5.4',
    baseURL: 'https://api.openai.com/v1',
    isBuiltin: false,
    ...overrides,
  };
}

describe('getMissingProfileFields', () => {
  test('requires an API key for env-backed API profiles when no env key exists', () => {
    const profile = buildProfile({ apiKey: undefined });

    expect(getMissingProfileFields(profile, emptyEnvKeys)).toEqual(['apiKey']);
  });

  test('accepts a matching env key for env-backed API profiles', () => {
    const profile = buildProfile({ apiKey: undefined });

    expect(getMissingProfileFields(profile, {
      ...emptyEnvKeys,
      openai: { found: true },
    })).toEqual([]);
  });

  test('requires an explicit API key for custom API profiles even when the base URL matches an env key', () => {
    const profile = buildProfile({ apiKey: undefined, codexProfileId: 'custom' });

    expect(getMissingProfileFields(profile, {
      ...emptyEnvKeys,
      openai: { found: true },
    })).toEqual(['apiKey']);
  });

  test('accepts a DeepSeek env key for DeepSeek API profiles', () => {
    const profile = buildProfile({
      apiKey: undefined,
      baseURL: 'https://api.deepseek.com',
      codexProfileId: 'deepseek',
      modelId: 'deepseek-v4-flash',
      wireApi: 'chat',
    });

    expect(getMissingProfileFields(profile, {
      ...emptyEnvKeys,
      deepseek: { found: true },
    })).toEqual([]);
  });

  test('accepts an OIX-reported environment key without exposing its value', () => {
    const profile = buildProfile({
      apiKey: undefined,
      baseURL: 'https://api.anthropic.com',
      codexProfileId: 'anthropic',
      environmentKey: 'ANTHROPIC_API_KEY',
      modelId: 'claude-sonnet-4-5',
      wireApi: 'chat',
    });

    expect(getMissingProfileFields(profile, emptyEnvKeys)).toEqual([]);
  });

  test('reports all missing API fields for an incomplete API profile', () => {
    const profile = buildProfile({ modelId: '', baseURL: '', apiKey: undefined });

    expect(getMissingProfileFields(profile, emptyEnvKeys)).toEqual(['modelId', 'baseURL', 'apiKey']);
  });

});
