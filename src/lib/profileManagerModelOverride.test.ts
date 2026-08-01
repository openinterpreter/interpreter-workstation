import { describe, expect, test } from 'bun:test';

import type { ModelConfig } from '../../shared/types/model';
import { normalizeModelOverrideConfig } from './profileManagerModelOverrides';

describe('normalizeModelOverrideConfig', () => {
  test('uses the fast hosted default when requested', () => {
    const config: ModelConfig = {
      provider: 'hosted',
      modelId: '',
    };

    expect(normalizeModelOverrideConfig(config, 'fast')).toEqual({
      provider: 'hosted',
      modelId: 'interpreter-fast',
    });
  });

  test('fills local override defaults from runtime-derived base URL', () => {
    const config: ModelConfig = {
      provider: 'local',
      modelId: '',
      baseURL: '',
    };

    expect(normalizeModelOverrideConfig(config)).toEqual({
      provider: 'local',
      modelId: 'qwen3.5:4b',
      baseURL: 'http://localhost:11434/v1',
    });
  });

  test('fills lmstudio local override defaults', () => {
    const config: ModelConfig = {
      provider: 'local',
      modelId: '',
      baseURL: 'http://localhost:1234/v1',
    };

    expect(normalizeModelOverrideConfig(config)).toEqual({
      provider: 'local',
      modelId: 'qwen/qwen3.5-4b',
      baseURL: 'http://localhost:1234/v1',
    });
  });

  test('fills api override defaults', () => {
    const config: ModelConfig = {
      provider: 'api',
      modelId: 'openai/gpt-5.4-mini',
    };

    expect(normalizeModelOverrideConfig(config)).toEqual({
      provider: 'api',
      modelId: 'openai/gpt-5.4-mini',
      apiFormat: 'openai',
      baseURL: 'https://api.openai.com/v1',
    });
  });

  test('preserves anthropic api overrides', () => {
    const config: ModelConfig = {
      provider: 'api',
      modelId: 'claude-3-7-sonnet',
      apiFormat: 'anthropic',
    };

    expect(normalizeModelOverrideConfig(config)).toEqual({
      provider: 'api',
      modelId: 'claude-3-7-sonnet',
      apiFormat: 'anthropic',
      baseURL: 'https://api.anthropic.com/v1',
    });
  });
});
