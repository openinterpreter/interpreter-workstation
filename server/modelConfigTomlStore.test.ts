import { describe, expect, test } from 'bun:test';

import type { Profile } from '../shared/types/profile';
import { API_PROVIDER_MODEL_DEFAULTS } from '../shared/types/modelDefaults';
import {
  createDefaultModelConfigState,
  createHostedFallbackModelConfigState,
  recoverLoadedModelConfigState,
} from './modelConfigTomlStore';

function buildState(profiles: Profile[]) {
  const baseState = createDefaultModelConfigState();
  return {
    ...baseState,
    profiles,
  };
}

describe('modelConfigTomlStore recovery', () => {
  test('creates hosted fallback model state from the shared onboarding pack defaults', () => {
    const state = createHostedFallbackModelConfigState();

    expect(state.defaultProfileId).toBe('onboarding:interpreter-smart');
    expect(state.fastProfileId).toBe('onboarding:interpreter-fast');
    expect(state.profiles.map((profile) => profile.id)).toEqual([
      'onboarding:interpreter-smart',
      'onboarding:interpreter-fast',
    ]);
  });

  test('recovers known API profiles from matching environment keys', () => {
    const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
    const originalOpenRouterApiKey = process.env.OPENROUTER_API_KEY;
    const originalGroqApiKey = process.env.GROQ_API_KEY;
    const originalDeepSeekApiKey = process.env.DEEPSEEK_API_KEY;

    process.env.OPENAI_API_KEY = 'sk-openai-env';
    process.env.OPENROUTER_API_KEY = 'sk-openrouter-env';
    process.env.GROQ_API_KEY = 'sk-groq-env';
    process.env.DEEPSEEK_API_KEY = 'sk-deepseek-env';

    try {
      const state = buildState([
        {
          id: 'custom:openai-api',
          name: 'OpenAI API',
          provider: 'api',
          modelId: 'gpt-5.4',
          baseURL: 'https://api.openai.com/v1',
          isBuiltin: false,
        },
        {
          id: 'custom:openrouter-api',
          name: 'OpenRouter API',
          provider: 'api',
          modelId: 'openai/gpt-5.4',
          baseURL: 'https://openrouter.ai/api/v1',
          isBuiltin: false,
        },
        {
          id: 'custom:groq-api',
          name: 'Groq API',
          provider: 'api',
          modelId: 'llama-3.3-70b-versatile',
          baseURL: 'https://api.groq.com/openai/v1',
          isBuiltin: false,
        },
        {
          id: 'custom:deepseek-api',
          name: 'DeepSeek API',
          provider: 'api',
          modelId: 'deepseek-v4-flash',
          baseURL: 'https://api.deepseek.com',
          isBuiltin: false,
        },
      ]);
      const issues: string[] = [];

      const modified = recoverLoadedModelConfigState(state, issues);

      expect(modified).toBe(true);
      expect(state.profiles).toEqual([
        expect.objectContaining({
          id: 'custom:openai-api',
          environmentKey: 'OPENAI_API_KEY',
          codexProfileId: 'openai-api',
        }),
        expect.objectContaining({
          id: 'custom:openrouter-api',
          environmentKey: 'OPENROUTER_API_KEY',
          codexProfileId: 'openrouter',
        }),
        expect.objectContaining({
          id: 'custom:groq-api',
          environmentKey: 'GROQ_API_KEY',
          codexProfileId: 'groq',
        }),
        expect.objectContaining({
          id: 'custom:deepseek-api',
          environmentKey: 'DEEPSEEK_API_KEY',
          codexProfileId: 'deepseek',
          wireApi: 'chat',
        }),
      ]);
      expect(state.profiles.every(profile => profile.apiKey === undefined)).toBe(true);
      expect(issues).toContain('Repaired profile "OpenAI API" from the saved configuration.');
      expect(issues).toContain('Repaired profile "OpenRouter API" from the saved configuration.');
      expect(issues).toContain('Repaired profile "Groq API" from the saved configuration.');
      expect(issues).toContain('Repaired profile "DeepSeek API" from the saved configuration.');
    } finally {
      if (originalOpenAiApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalOpenAiApiKey;
      }
      if (originalOpenRouterApiKey === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = originalOpenRouterApiKey;
      }
      if (originalGroqApiKey === undefined) {
        delete process.env.GROQ_API_KEY;
      } else {
        process.env.GROQ_API_KEY = originalGroqApiKey;
      }
      if (originalDeepSeekApiKey === undefined) {
        delete process.env.DEEPSEEK_API_KEY;
      } else {
        process.env.DEEPSEEK_API_KEY = originalDeepSeekApiKey;
      }
    }
  });

  test('preserves future OIX API model ids instead of repairing them to a stale fallback', () => {
    const state = buildState([
      {
        id: 'onboarding:openai-gpt-5-6-sol',
        name: 'GPT-5.6-Sol',
        provider: 'api',
        modelId: 'gpt-5.6-sol',
        baseURL: 'https://api.openai.com/v1',
        environmentKey: 'OPENAI_API_KEY',
        apiFormat: 'openai',
        codexProfileId: 'openai',
        wireApi: 'responses',
        useResponsesApi: true,
        isBuiltin: false,
      },
    ]);
    const issues: string[] = [];

    const modified = recoverLoadedModelConfigState(state, issues);

    expect(modified).toBe(false);
    expect(state.profiles[0]?.modelId).toBe('gpt-5.6-sol');
    expect(state.profiles[0]?.environmentKey).toBe('OPENAI_API_KEY');
    expect(state.profiles[0]?.apiKey).toBeUndefined();
    expect(issues).toEqual([]);
  });

  test('repairs stale DeepSeek API profiles that were saved as custom Responses endpoints', () => {
    const state = buildState([
      {
        id: 'custom:deepseek-api',
        name: 'DeepSeek API',
        provider: 'api',
        modelId: 'deepseek-v4-flash',
        baseURL: 'https://api.deepseek.com',
        apiKey: 'sk-deepseek',
        apiFormat: 'openai',
        codexProfileId: 'custom',
        wireApi: 'responses',
        useResponsesApi: true,
        isBuiltin: false,
      },
    ]);
    const issues: string[] = [];

    const modified = recoverLoadedModelConfigState(state, issues);

    expect(modified).toBe(true);
    expect(state.profiles).toEqual([
      {
        id: 'custom:deepseek-api',
        name: 'DeepSeek API',
        provider: 'api',
        modelId: 'deepseek-v4-flash',
        baseURL: 'https://api.deepseek.com',
        apiKey: 'sk-deepseek',
        apiFormat: 'openai',
        codexProfileId: 'deepseek',
        wireApi: 'chat',
        isBuiltin: false,
        useResponsesApi: false,
      },
    ]);
    expect(issues).toContain('Repaired profile "DeepSeek API" from the saved configuration.');
  });

  test('repairs API profiles when base URL and API key are still present', () => {
    const state = buildState([
      {
        id: 'custom:broken-api',
        name: 'Broken API',
        provider: 'api',
        providerId: 'custom:missing-provider',
        modelId: '',
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        isBuiltin: false,
      },
    ]);
    const issues: string[] = [];

    const modified = recoverLoadedModelConfigState(state, issues);

    expect(modified).toBe(true);
    expect(state.profiles).toEqual([
      {
        id: 'custom:broken-api',
        name: 'Broken API',
        provider: 'api',
        modelId: API_PROVIDER_MODEL_DEFAULTS.openai,
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        apiFormat: 'openai',
        codexProfileId: 'openai-api',
        wireApi: 'responses',
        isBuiltin: false,
        useResponsesApi: true,
      },
    ]);
    expect(state.defaultProfileId).toBe('custom:broken-api');
    expect(state.fastProfileId).toBe('custom:broken-api');
    expect(issues).toContain('Repaired profile "Broken API" from the saved configuration.');
  });

  test('keeps custom API profiles without API keys so they remain editable', () => {
    const state = buildState([
      {
        id: 'custom:unrecoverable-api',
        name: 'Unrecoverable API',
        provider: 'api',
        modelId: 'custom-model',
        baseURL: 'https://example.com/v1',
        isBuiltin: false,
      },
    ]);
    const issues: string[] = [];

    const modified = recoverLoadedModelConfigState(state, issues);

    expect(modified).toBe(false);
    expect(state.profiles).toEqual([
      {
        id: 'custom:unrecoverable-api',
        name: 'Unrecoverable API',
        provider: 'api',
        modelId: 'custom-model',
        baseURL: 'https://example.com/v1',
        isBuiltin: false,
      },
    ]);
    expect(state.defaultProfileId).toBeNull();
    expect(state.fastProfileId).toBeNull();
    expect(issues).toEqual([]);
  });

  test('removes known API profiles without saved or environment keys', () => {
    const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      const state = buildState([
        {
          id: 'custom:unrecoverable-openai-api',
          name: 'Unrecoverable OpenAI API',
          provider: 'api',
          modelId: 'gpt-5.4',
          baseURL: 'https://api.openai.com/v1',
          isBuiltin: false,
        },
        {
          id: 'custom:editable-custom-api',
          name: 'Editable Custom API',
          provider: 'api',
          modelId: 'custom-model',
          baseURL: 'https://example.com/v1',
          isBuiltin: false,
        },
      ]);
      const issues: string[] = [];

      const modified = recoverLoadedModelConfigState(state, issues);

      expect(modified).toBe(true);
      expect(state.profiles).toEqual([
        {
          id: 'custom:editable-custom-api',
          name: 'Editable Custom API',
          provider: 'api',
          modelId: 'custom-model',
          baseURL: 'https://example.com/v1',
          isBuiltin: false,
        },
      ]);
      expect(issues).toContain('Removed profile "Unrecoverable OpenAI API" because it could not be repaired from the saved configuration.');
    } finally {
      if (originalOpenAiApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalOpenAiApiKey;
      }
    }
  });

  test('removes invalid hosted profiles and drops invalid hosted nested overrides', () => {
    const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      const state = buildState([
        {
          id: 'custom:fast-hosted',
          name: 'Fast Hosted',
          provider: 'hosted',
          providerId: 'custom:missing-provider',
          modelId: 'not-a-real-model',
          isBuiltin: false,
          fastModel: {
            provider: 'hosted',
            providerId: 'custom:missing-provider',
            modelId: 'bad-fast-model',
          },
          visionModel: {
            provider: 'api',
            modelId: 'gpt-5.4',
            baseURL: 'https://api.openai.com/v1',
          },
        },
        {
          id: 'custom:valid-openai-oauth',
          name: 'OpenAI OAuth',
          provider: 'openai-oauth',
          providerId: 'builtin:openai-oauth',
          modelId: 'gpt-5.4-mini',
          isBuiltin: false,
        },
      ]);

      state.defaultProfileId = 'custom:fast-hosted';
      state.fastProfileId = 'custom:fast-hosted';

      const issues: string[] = [];

      const modified = recoverLoadedModelConfigState(state, issues);

      expect(modified).toBe(true);
      expect(state.profiles).toEqual([
        {
          id: 'custom:valid-openai-oauth',
          name: 'OpenAI OAuth',
          provider: 'openai-oauth',
          providerId: 'builtin:openai-oauth',
          modelId: 'gpt-5.4-mini',
          isBuiltin: false,
        },
      ]);
      expect(state.defaultProfileId).toBe('custom:valid-openai-oauth');
      expect(state.fastProfileId).toBe('custom:valid-openai-oauth');
      expect(issues).toContain('Removed profile "Fast Hosted" because it could not be repaired from the saved configuration.');
      expect(issues).toContain('Restored the default profile selection.');
      expect(issues).toContain('Restored the fast profile selection.');
    } finally {
      if (originalOpenAiApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalOpenAiApiKey;
      }
    }
  });

  test('restores hosted fallback profiles when all saved profiles are invalid hosted entries', () => {
    const state = buildState([
      {
        id: 'custom:broken-hosted-a',
        name: 'Broken Hosted A',
        provider: 'hosted',
        modelId: 'not-a-real-model',
        isBuiltin: false,
      },
      {
        id: 'custom:broken-hosted-b',
        name: 'Broken Hosted B',
        provider: 'hosted',
        modelId: 'also-not-real',
        isBuiltin: false,
      },
    ]);
    const issues: string[] = [];

    const modified = recoverLoadedModelConfigState(state, issues);

    expect(modified).toBe(true);
    expect(state.profiles).toMatchObject([
      {
        id: 'onboarding:interpreter-smart',
        name: 'Interpreter Smart',
        provider: 'hosted',
        modelId: 'interpreter-smart',
      },
      {
        id: 'onboarding:interpreter-fast',
        name: 'Interpreter Fast',
        provider: 'hosted',
        modelId: 'interpreter-fast',
      },
    ]);
    expect(issues).toContain('Removed profile "Broken Hosted A" because it could not be repaired from the saved configuration.');
    expect(issues).toContain('Removed profile "Broken Hosted B" because it could not be repaired from the saved configuration.');
    expect(issues).toContain('Restored Interpreter hosted fallback profiles so the app remains usable.');
  });

  test('repairs malformed local baseURL values to the default local URL', () => {
    const malformedBaseUrls = ['', 123, { foo: 'bar' }, 'not-a-url'];

    for (const malformedBaseURL of malformedBaseUrls) {
      const state = buildState([
        {
          id: `custom:local-${String(malformedBaseURL)}`,
          name: 'Broken Local',
          provider: 'local',
          modelId: 'qwen3.5:4b',
          baseURL: malformedBaseURL as unknown as string,
          isBuiltin: false,
        },
      ]);
      const issues: string[] = [];

      const modified = recoverLoadedModelConfigState(state, issues);

      expect(modified).toBe(true);
      expect(state.profiles[0]).toMatchObject({
        provider: 'local',
        providerId: 'builtin:local',
        modelId: 'qwen3.5:4b',
        baseURL: 'http://localhost:11434/v1',
      });
      expect(issues).toContain('Repaired profile "Broken Local" from the saved configuration.');
    }
  });

  test('repairs legacy local baseURL values without /v1', () => {
    const state = buildState([
      {
        id: 'custom:legacy-local',
        name: 'Legacy Local',
        provider: 'local',
        modelId: 'qwen2.5:7b',
        baseURL: 'http://localhost:11434',
        codexProfileId: 'ollama',
        isBuiltin: false,
        fastModel: {
          provider: 'local',
          modelId: 'qwen2.5:3b',
          baseURL: 'http://localhost:11434',
        },
      },
      {
        id: 'custom:legacy-lmstudio',
        name: 'Legacy LM Studio',
        provider: 'local',
        modelId: 'qwen/qwen3.5-4b',
        baseURL: 'http://localhost:1234',
        codexProfileId: 'lmstudio',
        isBuiltin: false,
        visionModel: {
          provider: 'local',
          modelId: 'qwen/qwen3.5-vl-4b',
          baseURL: 'http://localhost:1234',
        },
      },
    ]);
    const issues: string[] = [];

    const modified = recoverLoadedModelConfigState(state, issues);

    expect(modified).toBe(true);
    expect(state.profiles).toEqual([
      expect.objectContaining({
        id: 'custom:legacy-local',
        baseURL: 'http://localhost:11434/v1',
        codexProfileId: 'ollama',
        fastModel: expect.objectContaining({
          baseURL: 'http://localhost:11434/v1',
        }),
      }),
      expect.objectContaining({
        id: 'custom:legacy-lmstudio',
        baseURL: 'http://localhost:1234/v1',
        codexProfileId: 'lmstudio',
        visionModel: expect.objectContaining({
          baseURL: 'http://localhost:1234/v1',
        }),
      }),
    ]);
    expect(issues).toContain('Repaired profile "Legacy Local" from the saved configuration.');
    expect(issues).toContain('Repaired profile "Legacy LM Studio" from the saved configuration.');
  });

  test('removes API profiles with malformed baseURL values', () => {
    const malformedBaseUrls = ['', 123, { foo: 'bar' }, 'not-a-url'];

    for (const malformedBaseURL of malformedBaseUrls) {
      const state = buildState([
        {
          id: `custom:api-${String(malformedBaseURL)}`,
          name: 'Broken API URL',
          provider: 'api',
          modelId: 'gpt-5.4',
          baseURL: malformedBaseURL as unknown as string,
          apiKey: 'sk-test',
          isBuiltin: false,
        },
      ]);
      const issues: string[] = [];

      const modified = recoverLoadedModelConfigState(state, issues);

      expect(modified).toBe(true);
      expect(state.profiles).toMatchObject([
        {
          id: 'onboarding:interpreter-smart',
          name: 'Interpreter Smart',
          provider: 'hosted',
          modelId: 'interpreter-smart',
        },
        {
          id: 'onboarding:interpreter-fast',
          name: 'Interpreter Fast',
          provider: 'hosted',
          modelId: 'interpreter-fast',
        },
      ]);
      expect(issues).toContain('Removed profile "Broken API URL" because it could not be repaired from the saved configuration.');
      expect(issues).toContain('Restored Interpreter hosted fallback profiles so the app remains usable.');
    }
  });

});
