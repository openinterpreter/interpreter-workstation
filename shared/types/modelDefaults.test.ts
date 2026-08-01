import { describe, expect, test } from 'bun:test';
import {
  API_PROVIDER_MODEL_DEFAULTS,
  buildOpenAIOAuthOnboardingPack,
  getDefaultApiProviderModelId,
  getDefaultOpenAIOAuthModelId,
  getHostedOnboardingFastProfileId,
  getOpenAIOAuthInitialSelectedProfileIds,
  inferPreferredProfileIdFromOnboardingText,
  inferPreferredModelPackIdsFromOnboardingText,
  LOCAL_MODEL_DEFAULTS,
  ONBOARDING_MODEL_PACKS,
  ONBOARDING_OPTIONAL_MODEL_PACK_ORDER,
} from './modelDefaults';

describe('ONBOARDING_MODEL_PACKS', () => {
  test('builds the OpenAI OAuth onboarding pack from supported models in server order', () => {
    const pack = buildOpenAIOAuthOnboardingPack([
      { id: 'gpt-5.2', name: 'GPT 5.2', isDefault: false },
      { id: 'gpt-5.4', name: 'GPT 5.4', isDefault: true },
      { id: 'gpt-5.3-codex', name: 'GPT 5.3 Codex', isDefault: false },
    ]);

    expect(pack.profiles.map(profile => profile.name)).toEqual([
      'GPT 5.2',
      'GPT 5.4',
      'GPT 5.3 Codex',
    ]);
    expect(pack.defaultProfileId).toBe('onboarding:openai-gpt-5-4');
  });

  test('uses isDefault model as the default profile', () => {
    const pack = buildOpenAIOAuthOnboardingPack([
      { id: 'gpt-5.3-codex', name: 'GPT 5.3 Codex', isDefault: true },
      { id: 'gpt-5.2', name: 'GPT 5.2', isDefault: false },
    ]);

    expect(pack.defaultProfileId).toBe('onboarding:openai-gpt-5-3-codex');
  });

  test('resolves the default OpenAI OAuth model from the supported list', () => {
    expect(getDefaultOpenAIOAuthModelId([
      { id: 'gpt-5.3-codex', name: 'GPT 5.3 Codex', isDefault: true },
      { id: 'gpt-5.2', name: 'GPT 5.2', isDefault: false },
    ])).toBe('gpt-5.3-codex');
  });

  test('always includes the actual default OpenAI OAuth profile in the initial selection', () => {
    const pack = buildOpenAIOAuthOnboardingPack([
      { id: 'gpt-5.3-codex', name: 'GPT 5.3 Codex', isDefault: true },
      { id: 'gpt-5.2', name: 'GPT 5.2', isDefault: false },
      { id: 'gpt-5.1', name: 'GPT 5.1', isDefault: false },
      { id: 'gpt-5.0', name: 'GPT 5.0', isDefault: false },
    ]);

    expect(getOpenAIOAuthInitialSelectedProfileIds(pack)).toContain(pack.defaultProfileId);
  });

  test('prefers isDefault over first model in list', () => {
    expect(getDefaultOpenAIOAuthModelId([
      { id: 'gpt-5.4', name: 'GPT 5.4', isDefault: false },
      { id: 'gpt-5.3-codex', name: 'GPT 5.3 Codex', isDefault: true },
    ])).toBe('gpt-5.3-codex');
  });

  test('falls back to first model when no model has isDefault', () => {
    expect(getDefaultOpenAIOAuthModelId([
      { id: 'gpt-5.4', name: 'GPT 5.4', isDefault: false },
      { id: 'gpt-5.3-codex', name: 'GPT 5.3 Codex', isDefault: false },
    ])).toBe('gpt-5.4');
  });

  test('includes the Interpreter hosted model pack with Smart/Fast', () => {
    const pack = ONBOARDING_MODEL_PACKS.hosted;
    expect(pack.profiles.length).toBe(2);
    expect(pack.profiles.map(profile => profile.name)).toEqual(['Interpreter Smart', 'Interpreter Fast']);
    expect(pack.profiles[0].helpDescription).toContain('smartest model');
    expect(pack.profiles[1].helpDescription).toContain('fastest model');
    expect(getHostedOnboardingFastProfileId(pack)).toBe('onboarding:interpreter-fast');
  });

  test('keeps local and API preferred defaults in one shared source', () => {
    expect(ONBOARDING_OPTIONAL_MODEL_PACK_ORDER).toEqual([
      'api:openai',
      'api:anthropic',
      'local:ollama',
      'local:lmstudio',
      'api:openrouter',
      'api:groq',
      'api:deepseek',
    ]);
    expect(LOCAL_MODEL_DEFAULTS).toEqual({
      ollama: 'qwen3.5:4b',
      lmstudio: 'qwen/qwen3.5-4b',
    });
    expect(API_PROVIDER_MODEL_DEFAULTS).toMatchObject({
      openai: 'gpt-5.4-nano',
      groq: 'llama-3.3-70b-versatile',
      openrouter: 'anthropic/claude-opus-4.6',
      deepseek: 'deepseek-v4-flash',
    });
  });

  test('selects a provider preferred model when available and first model otherwise', () => {
    expect(getDefaultApiProviderModelId('groq', [
      { id: 'mixtral-8x7b' },
      { id: 'llama-3.3-70b-versatile' },
    ])).toBe('llama-3.3-70b-versatile');

    expect(getDefaultApiProviderModelId('deepseek', [
      { id: 'deepseek-reasoner' },
    ])).toBe('deepseek-reasoner');

    expect(getDefaultApiProviderModelId('openai', [])).toBeNull();
  });

  test('maps onboarding AI setup answers to supported model setup packs in stable order', () => {
    expect(inferPreferredModelPackIdsFromOnboardingText(
      'I use GPT-5 for planning, local Ollama for private files, LM Studio for experiments, and DeepSeek sometimes.',
    )).toEqual([
      'api:openai',
      'local:ollama',
      'local:lmstudio',
      'api:deepseek',
    ]);
  });

  test('maps Anthropic mentions without treating generic ChatGPT web usage as an API pack', () => {
    expect(inferPreferredModelPackIdsFromOnboardingText(
      'Claude desktop and ChatGPT web, no local model server.',
    )).toEqual(['api:anthropic']);
  });

  test('maps explicit onboarding model mentions to matching review profiles', () => {
    expect(inferPreferredProfileIdFromOnboardingText(
      'I usually use GPT-5.4 mini for fast tasks.',
      [
        { id: 'default', name: 'GPT 5.4 Nano', modelId: 'gpt-5.4-nano' },
        { id: 'preferred', name: 'GPT 5.4 Mini', modelId: 'gpt-5.4-mini' },
      ],
      'default',
    )).toBe('preferred');
  });

  test('matches explicit slash-scoped local model IDs by their leaf name', () => {
    expect(inferPreferredProfileIdFromOnboardingText(
      'LM Studio has qwen3.5-4b installed.',
      [
        { id: 'llama', name: 'Llama 3.2 3B', modelId: 'meta/llama-3.2-3b' },
        { id: 'qwen', name: 'Qwen 3.5 4B', modelId: 'qwen/qwen3.5-4b' },
      ],
      'llama',
    )).toBe('qwen');
  });

  test('keeps the existing review default for provider-only preferences', () => {
    expect(inferPreferredProfileIdFromOnboardingText(
      'I have an OpenAI API key and use local models too.',
      [
        { id: 'nano', name: 'GPT 5.4 Nano', modelId: 'gpt-5.4-nano' },
        { id: 'mini', name: 'GPT 5.4 Mini', modelId: 'gpt-5.4-mini' },
      ],
      'nano',
    )).toBe('nano');
  });

  test('prefers the most specific model mention when model names overlap', () => {
    expect(inferPreferredProfileIdFromOnboardingText(
      'Please use GPT-5.4 Mini.',
      [
        { id: 'base', name: 'GPT 5.4', modelId: 'gpt-5.4' },
        { id: 'mini', name: 'GPT 5.4 Mini', modelId: 'gpt-5.4-mini' },
      ],
      'base',
    )).toBe('mini');
  });
});
