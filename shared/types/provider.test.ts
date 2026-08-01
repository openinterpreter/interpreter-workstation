import { describe, test, expect } from 'bun:test';
import {
  findSupportedResponsesApiBaseUrlOption,
  getApiEnvKeyTypeForBaseURL,
  getApiPresetBaseURL,
  getApiPresetFormat,
  getDefaultResponsesApiBaseURL,
  getLocalModelProviderRuntime,
  getUnsupportedResponsesApiBaseUrlMessage,
  getProviderApiFormat,
  getProviderBaseURL,
  getSupportedResponsesApiBaseUrlOption,
  isBuiltinProvider,
  localRuntimeModelIdsMatch,
  resolveLocalRuntimeModelId,
} from './provider';
import type { Provider } from './provider';

function makeProvider(overrides: Partial<Provider>): Provider {
  return {
    id: 'test',
    name: 'Test',
    type: 'api',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('getApiPresetBaseURL', () => {
  test('anthropic => https://api.anthropic.com/v1', () => {
    expect(getApiPresetBaseURL('anthropic')).toBe('https://api.anthropic.com/v1');
  });

  test('openai => https://api.openai.com/v1', () => {
    expect(getApiPresetBaseURL('openai')).toBe('https://api.openai.com/v1');
  });

  test('groq => https://api.groq.com/openai/v1', () => {
    expect(getApiPresetBaseURL('groq')).toBe('https://api.groq.com/openai/v1');
  });

  test('openrouter => https://openrouter.ai/api/v1', () => {
    expect(getApiPresetBaseURL('openrouter')).toBe('https://openrouter.ai/api/v1');
  });

  test('deepseek => https://api.deepseek.com', () => {
    expect(getApiPresetBaseURL('deepseek')).toBe('https://api.deepseek.com');
  });
});

describe('getApiPresetFormat', () => {
  test('anthropic => anthropic', () => {
    expect(getApiPresetFormat('anthropic')).toBe('anthropic');
  });

  test('openai => openai', () => {
    expect(getApiPresetFormat('openai')).toBe('openai');
  });

  test('groq => openai', () => {
    expect(getApiPresetFormat('groq')).toBe('openai');
  });

  test('openrouter => openai', () => {
    expect(getApiPresetFormat('openrouter')).toBe('openai');
  });

  test('deepseek => openai', () => {
    expect(getApiPresetFormat('deepseek')).toBe('openai');
  });
});

describe('getDefaultResponsesApiBaseURL', () => {
  test('defaults the responses API base URL to OpenAI', () => {
    expect(getDefaultResponsesApiBaseURL()).toBe('https://api.openai.com/v1');
  });
});

describe('supported responses API base URLs', () => {
  test('treats Ollama Cloud as a supported responses endpoint', () => {
    expect(getSupportedResponsesApiBaseUrlOption('ollama-cloud')).toEqual({
      id: 'ollama-cloud',
      label: 'Ollama Cloud',
      baseURL: 'https://ollama.com/v1',
    });
    expect(findSupportedResponsesApiBaseUrlOption('https://ollama.com/v1/')).toEqual({
      id: 'ollama-cloud',
      label: 'Ollama Cloud',
      baseURL: 'https://ollama.com/v1',
    });
  });

  test('does not treat NVIDIA as a verified responses endpoint', () => {
    expect(getSupportedResponsesApiBaseUrlOption('nvidia')).toBeUndefined();
    expect(findSupportedResponsesApiBaseUrlOption('https://integrate.api.nvidia.com/v1/')).toBeUndefined();
  });

  test('does not treat DeepSeek as a verified responses endpoint', () => {
    expect(getSupportedResponsesApiBaseUrlOption('deepseek')).toBeUndefined();
    expect(findSupportedResponsesApiBaseUrlOption('https://api.deepseek.com/')).toBeUndefined();
  });

  test('returns NVIDIA-specific guidance for the reported hosted NIM endpoint', () => {
    expect(getUnsupportedResponsesApiBaseUrlMessage('https://integrate.api.nvidia.com')).toContain('NVIDIA');
    expect(getUnsupportedResponsesApiBaseUrlMessage('https://integrate.api.nvidia.com/v1/')).toContain('NVIDIA');
  });

  test('keeps generic guidance for non-NVIDIA unsupported endpoints', () => {
    expect(getUnsupportedResponsesApiBaseUrlMessage('https://api.example.com/v1')).toBe(
      'This base URL does not support the OpenAI Responses API (/responses). Use Interpreter-hosted models or OpenRouter instead.',
    );
  });

  test('maps env-backed API endpoints to env key types', () => {
    expect(getApiEnvKeyTypeForBaseURL('https://api.openai.com/v1')).toBe('openai');
    expect(getApiEnvKeyTypeForBaseURL('https://openrouter.ai/api/v1')).toBe('openrouter');
    expect(getApiEnvKeyTypeForBaseURL('https://api.groq.com/openai/v1')).toBe('groq');
    expect(getApiEnvKeyTypeForBaseURL('https://api.deepseek.com')).toBe('deepseek');
    expect(getApiEnvKeyTypeForBaseURL('https://api.deepseek.com/v1')).toBe('deepseek');
    expect(getApiEnvKeyTypeForBaseURL('https://example.com/v1')).toBeNull();
  });

});

describe('getLocalModelProviderRuntime', () => {
  test('recognizes exact and generated local provider IDs', () => {
    expect(getLocalModelProviderRuntime('ollama')).toBe('ollama');
    expect(getLocalModelProviderRuntime('ollama-62be5c93')).toBe('ollama');
    expect(getLocalModelProviderRuntime('lmstudio')).toBe('lmstudio');
    expect(getLocalModelProviderRuntime('lmstudio-5a96e840')).toBe('lmstudio');
  });

  test('does not classify cloud or malformed provider IDs as local', () => {
    expect(getLocalModelProviderRuntime('ollama-cloud')).toBeNull();
    expect(getLocalModelProviderRuntime('ollama-')).toBeNull();
    expect(getLocalModelProviderRuntime('ollama-local')).toBeNull();
    expect(getLocalModelProviderRuntime('lmstudio-cloud')).toBeNull();
    expect(getLocalModelProviderRuntime('openrouter')).toBeNull();
  });
});

describe('resolveLocalRuntimeModelId', () => {
  test('resolves provider-facing model IDs for known Qwen local runtime aliases', () => {
    expect(resolveLocalRuntimeModelId('qwen3.5-0.8b', 'ollama')).toBe('qwen3.5:0.8b');
    expect(resolveLocalRuntimeModelId('qwen/qwen3.5-9b', 'ollama')).toBe('qwen3.5:9b');
    expect(resolveLocalRuntimeModelId('qwen3.5:4b', 'lmstudio')).toBe('qwen/qwen3.5-4b');
  });

  test('keeps unknown local model IDs trimmed for the selected runtime', () => {
    expect(resolveLocalRuntimeModelId(' custom-local-model ', 'ollama')).toBe('custom-local-model');
  });
});

describe('localRuntimeModelIdsMatch', () => {
  test('matches LM Studio recommended IDs to installed repository variants', () => {
    expect(localRuntimeModelIdsMatch('qwen3.5-4b', 'qwen/qwen3.5-4b')).toBe(true);
    expect(localRuntimeModelIdsMatch('unsloth/qwen3.5-9b', 'qwen/qwen3.5-9b')).toBe(true);
  });

  test('does not match unrelated model IDs', () => {
    expect(localRuntimeModelIdsMatch('custom-a', 'custom-b')).toBe(false);
  });
});

describe('getProviderApiFormat', () => {
  test('non-api type returns openai', () => {
    const provider = makeProvider({ type: 'hosted' });
    expect(getProviderApiFormat(provider)).toBe('openai');
  });

  test('explicit format overrides preset', () => {
    const provider = makeProvider({
      api: { preset: 'anthropic', format: 'openai' },
    });
    expect(getProviderApiFormat(provider)).toBe('openai');
  });

  test('infers from preset when no explicit format', () => {
    const provider = makeProvider({
      api: { preset: 'anthropic' },
    });
    expect(getProviderApiFormat(provider)).toBe('anthropic');
  });

  test('defaults to openai when no format or preset', () => {
    const provider = makeProvider({ api: {} });
    expect(getProviderApiFormat(provider)).toBe('openai');
  });
});

describe('getProviderBaseURL', () => {
  test('explicit baseURL wins', () => {
    const provider = makeProvider({
      baseURL: 'https://custom.example.com',
      api: { preset: 'openai' },
    });
    expect(getProviderBaseURL(provider)).toBe('https://custom.example.com');
  });

  test('falls back to preset URL', () => {
    const provider = makeProvider({
      api: { preset: 'groq' },
    });
    expect(getProviderBaseURL(provider)).toBe('https://api.groq.com/openai/v1');
  });

  test('local type returns Ollama URL', () => {
    const provider = makeProvider({ type: 'local' });
    expect(getProviderBaseURL(provider)).toBe('http://localhost:11434/v1');
  });

  test('returns undefined when no URL source', () => {
    const provider = makeProvider({ type: 'hosted' });
    expect(getProviderBaseURL(provider)).toBeUndefined();
  });
});

describe('isBuiltinProvider', () => {
  test('builtin:hosted => true', () => {
    expect(isBuiltinProvider('builtin:hosted')).toBe(true);
  });

  test('custom-id => false', () => {
    expect(isBuiltinProvider('custom-id')).toBe(false);
  });
});
