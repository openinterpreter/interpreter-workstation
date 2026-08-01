import { describe, expect, test } from 'bun:test';
import {
  buildApiModelFieldConfig,
  getApiEndpointKind,
  normalizeApiModelOptions,
} from './apiProviderModelOptions';

describe('getApiEndpointKind', () => {
  test('recognizes OpenRouter by hostname', () => {
    expect(getApiEndpointKind('https://openrouter.ai/api/v1')).toBe('openrouter');
    expect(getApiEndpointKind('https://openrouter.ai/api/v1/models?supported_parameters=tools')).toBe('openrouter');
  });

  test('recognizes Groq by hostname', () => {
    expect(getApiEndpointKind('https://api.groq.com/openai/v1')).toBe('groq');
  });

  test('recognizes OpenAI by hostname', () => {
    expect(getApiEndpointKind('https://api.openai.com/v1')).toBe('openai');
  });

  test('recognizes DeepSeek by hostname', () => {
    expect(getApiEndpointKind('https://api.deepseek.com')).toBe('deepseek');
    expect(getApiEndpointKind('https://api.deepseek.com/v1')).toBe('deepseek');
  });

  test('treats other or invalid endpoints as custom', () => {
    expect(getApiEndpointKind('https://integrate.api.nvidia.com/v1')).toBe('custom');
    expect(getApiEndpointKind('not a url')).toBe('custom');
    expect(getApiEndpointKind(undefined)).toBe('custom');
  });
});

describe('normalizeApiModelOptions', () => {
  test('deduplicates and normalizes model ids and names', () => {
    expect(normalizeApiModelOptions([
      { id: ' openai/gpt-5.4 ', name: ' GPT-5.4 ' },
      { id: 'openai/gpt-5.4', name: 'ignored duplicate' },
      { id: 'anthropic/claude-sonnet-4.6', name: '' },
    ])).toEqual([
      { id: 'openai/gpt-5.4', name: 'ignored duplicate' },
      { id: 'anthropic/claude-sonnet-4.6', name: 'anthropic/claude-sonnet-4.6' },
    ]);
  });
});

describe('buildApiModelFieldConfig', () => {
  test('returns an OpenRouter dropdown config backed by catalog models', () => {
    const config = buildApiModelFieldConfig(
      'https://openrouter.ai/api/v1',
      [
        { id: 'openai/gpt-5.4', name: 'GPT-5.4', provider: 'openai' },
        { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6', provider: 'anthropic' },
      ],
      [],
    );

    expect(config).toEqual({
      kind: 'select',
      provider: 'openrouter',
      description: 'Select an OpenRouter model from the list.',
      options: [
        { id: 'openai/gpt-5.4', name: 'GPT-5.4' },
        { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
      ],
      defaultModelId: 'openai/gpt-5.4',
    });
  });

  test('uses the shared OpenRouter default when the catalog includes it', () => {
    const config = buildApiModelFieldConfig(
      'https://openrouter.ai/api/v1',
      [
        { id: 'openai/gpt-5.4', name: 'GPT-5.4', provider: 'openai' },
        { id: 'anthropic/claude-opus-4.6', name: 'Claude Opus 4.6', provider: 'anthropic' },
      ],
      [],
    );
    if (config.kind !== 'select') {
      throw new Error('Expected select config');
    }

    expect(config.defaultModelId).toBe('anthropic/claude-opus-4.6');
  });

  test('returns a Groq dropdown config from the provided app-server models', () => {
    const config = buildApiModelFieldConfig('https://api.groq.com/openai/v1', [], [
      { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B Versatile' },
      { id: 'mixtral-8x7b', name: 'Mixtral 8x7B' },
    ]);
    expect(config.kind).toBe('select');
    if (config.kind !== 'select') {
      throw new Error('Expected select config');
    }

    expect(config.provider).toBe('groq');
    expect(config.description).toBe('Select a Groq tool-calling model from the list.');
    expect(config.defaultModelId).toBe('llama-3.3-70b-versatile');
    expect(config.options).toEqual([
      { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B Versatile' },
      { id: 'mixtral-8x7b', name: 'Mixtral 8x7B' },
    ]);
  });

  test('falls back to the first provided Groq model when the preferred default is absent', () => {
    const config = buildApiModelFieldConfig('https://api.groq.com/openai/v1', [], [
      { id: 'mixtral-8x7b', name: 'Mixtral 8x7B' },
    ]);
    if (config.kind !== 'select') {
      throw new Error('Expected select config');
    }
    expect(config.defaultModelId).toBe('mixtral-8x7b');
  });

  test('returns an OpenAI dropdown filtered to custom-tool-capable provided models', () => {
    const config = buildApiModelFieldConfig('https://api.openai.com/v1', [], [
      { id: 'gpt-5.4-nano', name: 'GPT-5.4 nano' },
      { id: 'gpt-5.4', name: 'GPT-5.4' },
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'o4-mini', name: 'o4-mini' },
    ]);
    expect(config.kind).toBe('select');
    if (config.kind !== 'select') {
      throw new Error('Expected select config');
    }

    expect(config.provider).toBe('openai');
    expect(config.description).toBe('Select an OpenAI model that supports custom/freeform agent tools.');
    expect(config.defaultModelId).toBe('gpt-5.4-nano');
    expect(config.options.some((option) => option.id === 'gpt-5.4-nano')).toBe(true);
    expect(config.options.some((option) => option.id === 'gpt-5.4')).toBe(true);
    expect(config.options.some((option) => option.id === 'gpt-4o')).toBe(false);
    expect(config.options.some((option) => option.id === 'o4-mini')).toBe(false);
  });

  test('returns a DeepSeek dropdown config from the provided app-server models', () => {
    const config = buildApiModelFieldConfig('https://api.deepseek.com', [], [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
    ]);
    expect(config.kind).toBe('select');
    if (config.kind !== 'select') {
      throw new Error('Expected select config');
    }

    expect(config.provider).toBe('deepseek');
    expect(config.description).toBe('Select a DeepSeek Chat Completions model from the list.');
    expect(config.defaultModelId).toBe('deepseek-v4-flash');
    expect(config.options).toEqual([
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
    ]);
  });

  test('keeps freeform input for custom endpoints', () => {
    expect(buildApiModelFieldConfig('https://integrate.api.nvidia.com/v1', [], [])).toEqual({
      kind: 'freeform',
      provider: 'custom',
      description: 'Enter the exact model ID from your API provider.',
    });
  });
});
