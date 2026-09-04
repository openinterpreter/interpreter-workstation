import { describe, expect, test } from 'bun:test';
import { getReasoningCapabilityForModelConfig, resolveReasoningEffort } from './reasoningCapabilities';

describe('getReasoningCapabilityForModelConfig', () => {
  test('uses exact reasoning metadata for OpenAI OAuth models', () => {
    const capability = getReasoningCapabilityForModelConfig(
      { provider: 'openai-oauth', modelId: 'gpt-5.4' },
      {
        openAiOAuthModels: [
          {
            id: 'gpt-5.4',
            name: 'GPT-5.4',
            isDefault: true,
            supportedReasoningEfforts: ['low', 'medium', 'high'],
            defaultReasoningEffort: 'medium',
          },
        ],
      },
    );

    expect(capability).toEqual({
      supportedEfforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
      source: 'exact',
    });
  });

  test('hides reasoning for interpreter aliases without capability metadata', () => {
    const capability = getReasoningCapabilityForModelConfig({
      provider: 'hosted',
      modelId: 'interpreter-smart',
    });

    expect(capability).toBeNull();
  });

  test('uses OpenRouter catalog metadata for hosted OpenRouter models', () => {
    const capability = getReasoningCapabilityForModelConfig(
      { provider: 'hosted', modelId: 'openai/gpt-5.4' },
      {
        openRouterCatalog: {
          fetchedAt: Date.now(),
          stale: false,
          models: [
            {
              id: 'openai/gpt-5.4',
              name: 'GPT-5.4',
              provider: 'openai',
              supportedReasoningEfforts: ['low', 'medium', 'high'],
              defaultReasoningEffort: 'medium',
            },
          ],
        },
      },
    );

    expect(capability).toEqual({
      supportedEfforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
      source: 'generic',
    });
  });

  test('uses doc-backed capability metadata for known OpenAI API models', () => {
    const capability = getReasoningCapabilityForModelConfig({
      provider: 'api',
      baseURL: 'https://api.openai.com/v1',
      modelId: 'gpt-5.4',
    });

    expect(capability).toEqual({
      supportedEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
      defaultEffort: 'none',
      source: 'generic',
    });
  });

  test('supports literal max reasoning for GPT-5.6 Luna over the OpenAI API', () => {
    const capability = getReasoningCapabilityForModelConfig({
      provider: 'api',
      baseURL: 'https://api.openai.com/v1',
      modelId: 'gpt-5.6-luna',
    });

    expect(capability).toEqual({
      supportedEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'medium',
      source: 'generic',
    });
    expect(resolveReasoningEffort(capability, 'max')).toBe('max');
  });

  test('uses OpenRouter catalog metadata for OpenRouter API profiles', () => {
    const capability = getReasoningCapabilityForModelConfig(
      {
        provider: 'api',
        baseURL: 'https://openrouter.ai/api/v1',
        modelId: 'openai/gpt-5.4',
      },
      {
        openRouterCatalog: {
          fetchedAt: Date.now(),
          stale: false,
          models: [
            {
              id: 'openai/gpt-5.4',
              name: 'GPT-5.4',
              provider: 'openai',
              supportedReasoningEfforts: ['low', 'medium', 'high'],
              defaultReasoningEffort: 'medium',
            },
          ],
        },
      },
    );

    expect(capability).toEqual({
      supportedEfforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
      source: 'generic',
    });
  });

  test('exposes a user-selectable reasoning control for unknown OpenAI-compatible API models', () => {
    const capability = getReasoningCapabilityForModelConfig({
      provider: 'api',
      baseURL: 'https://proxy.example.com/v1',
      apiFormat: 'openai',
      modelId: 'gpt-6-ultra-proxy',
    });

    expect(capability).toEqual({
      supportedEfforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      source: 'generic',
    });
  });
});

describe('resolveReasoningEffort', () => {
  test('keeps a supported selected effort', () => {
    expect(
      resolveReasoningEffort(
        { supportedEfforts: ['low', 'medium', 'high'], defaultEffort: 'medium', source: 'exact' },
        'high',
      ),
    ).toBe('high');
  });

  test('falls back to the capability default when the current effort is invalid', () => {
    expect(
      resolveReasoningEffort(
        { supportedEfforts: ['low', 'medium', 'high'], defaultEffort: 'medium', source: 'exact' },
        'xhigh',
      ),
    ).toBe('medium');
  });
});
