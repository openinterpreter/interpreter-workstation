import { beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  createOpenRouterModelCatalogService,
  normalizeOpenRouterModel,
  OPENROUTER_MODEL_CACHE_TTL_MS,
} from './openRouterModelCatalog';
import {
  GENERIC_REASONING_DEFAULT_EFFORT,
  GENERIC_REASONING_EFFORTS,
} from '../../shared/types/reasoning';

describe('normalizeOpenRouterModel', () => {
  test('extracts provider and context length from an OpenRouter model', () => {
    expect(
      normalizeOpenRouterModel({
        id: 'anthropic/claude-3.7-sonnet',
        name: 'Claude 3.7 Sonnet',
        description: 'Reasoning model',
        context_length: 200_000,
        supported_parameters: ['tools', 'reasoning'],
      }),
    ).toEqual({
      id: 'anthropic/claude-3.7-sonnet',
      name: 'Claude 3.7 Sonnet',
      provider: 'anthropic',
      description: 'Reasoning model',
      contextLength: 200_000,
      supportedReasoningEfforts: GENERIC_REASONING_EFFORTS,
      defaultReasoningEffort: GENERIC_REASONING_DEFAULT_EFFORT,
    });
  });

  test('falls back to the raw id when name is missing', () => {
    expect(
      normalizeOpenRouterModel({
        id: 'openai/gpt-5.4',
        description: 'Frontier model',
      }),
    ).toEqual({
      id: 'openai/gpt-5.4',
      name: 'openai/gpt-5.4',
      provider: 'openai',
      description: 'Frontier model',
      contextLength: undefined,
      supportedReasoningEfforts: undefined,
      defaultReasoningEffort: undefined,
    });
  });
});

describe('createOpenRouterModelCatalogService', () => {
  const now = 1_700_000_000_000;

  const remoteModels = [
    {
      id: 'openai/gpt-5.4',
      name: 'GPT-5.4',
      description: 'Latest OpenAI reasoning model',
      context_length: 400_000,
      supported_parameters: ['tools', 'reasoning'],
    },
  ];

  let readCache: ReturnType<typeof mock>;
  let writeCache: ReturnType<typeof mock>;
  let fetchRemoteModels: ReturnType<typeof mock>;

  beforeEach(() => {
    readCache = mock(async () => null);
    writeCache = mock(async () => {});
    fetchRemoteModels = mock(async () => remoteModels);
  });

  test('fetches and caches when no cache exists', async () => {
    const service = createOpenRouterModelCatalogService({
      now: () => now,
      readCache,
      writeCache,
      fetchRemoteModels,
    });

    const result = await service.listModels();

    expect(result).toEqual({
      models: [
        {
          id: 'openai/gpt-5.4',
          name: 'GPT-5.4',
          provider: 'openai',
          description: 'Latest OpenAI reasoning model',
          contextLength: 400_000,
          supportedReasoningEfforts: GENERIC_REASONING_EFFORTS,
          defaultReasoningEffort: GENERIC_REASONING_DEFAULT_EFFORT,
        },
      ],
      fetchedAt: now,
      stale: false,
    });
    expect(fetchRemoteModels).toHaveBeenCalledTimes(1);
    expect(writeCache).toHaveBeenCalledWith({
      fetchedAt: now,
      models: result.models,
    });
  });

  test('returns a fresh cache without fetching again', async () => {
    readCache.mockImplementation(async () => ({
      fetchedAt: now - 1_000,
      models: [
        {
          id: 'google/gemini-2.5-pro',
          name: 'Gemini 2.5 Pro',
          provider: 'google',
          description: 'Cached model',
          contextLength: 1_000_000,
          supportedReasoningEfforts: undefined,
          defaultReasoningEffort: undefined,
        },
      ],
    }));

    const service = createOpenRouterModelCatalogService({
      now: () => now,
      readCache,
      writeCache,
      fetchRemoteModels,
    });

    const result = await service.listModels();

    expect(result).toEqual({
      models: [
        {
          id: 'google/gemini-2.5-pro',
          name: 'Gemini 2.5 Pro',
          provider: 'google',
          description: 'Cached model',
          contextLength: 1_000_000,
        },
      ],
      fetchedAt: now - 1_000,
      stale: false,
    });
    expect(fetchRemoteModels).not.toHaveBeenCalled();
    expect(writeCache).not.toHaveBeenCalled();
  });

  test('returns stale cache immediately and refreshes in the background', async () => {
    readCache.mockImplementation(async () => ({
      fetchedAt: now - OPENROUTER_MODEL_CACHE_TTL_MS - 1,
      models: [
        {
          id: 'anthropic/claude-sonnet-4.6',
          name: 'Claude Sonnet 4.6',
          provider: 'anthropic',
          description: 'Cached stale model',
          contextLength: 200_000,
          supportedReasoningEfforts: undefined,
          defaultReasoningEffort: undefined,
        },
      ],
    }));

    const service = createOpenRouterModelCatalogService({
      now: () => now,
      readCache,
      writeCache,
      fetchRemoteModels,
    });

    const result = await service.listModels();

    expect(result).toEqual({
      models: [
        {
          id: 'anthropic/claude-sonnet-4.6',
          name: 'Claude Sonnet 4.6',
          provider: 'anthropic',
          description: 'Cached stale model',
          contextLength: 200_000,
        },
      ],
      fetchedAt: now - OPENROUTER_MODEL_CACHE_TTL_MS - 1,
      stale: true,
    });

    await Promise.resolve();

    expect(fetchRemoteModels).toHaveBeenCalledTimes(1);
    expect(writeCache).toHaveBeenCalledWith({
      fetchedAt: now,
      models: [
        {
          id: 'openai/gpt-5.4',
          name: 'GPT-5.4',
          provider: 'openai',
          description: 'Latest OpenAI reasoning model',
          contextLength: 400_000,
          supportedReasoningEfforts: GENERIC_REASONING_EFFORTS,
          defaultReasoningEffort: GENERIC_REASONING_DEFAULT_EFFORT,
        },
      ],
    });
  });

  test('forceRefresh bypasses a fresh cache', async () => {
    readCache.mockImplementation(async () => ({
      fetchedAt: now,
      models: [
        {
          id: 'meta-llama/llama-4-maverick',
          name: 'Llama 4 Maverick',
          provider: 'meta-llama',
          description: 'Cached model',
          contextLength: 128_000,
          supportedReasoningEfforts: undefined,
          defaultReasoningEffort: undefined,
        },
      ],
    }));

    const service = createOpenRouterModelCatalogService({
      now: () => now,
      readCache,
      writeCache,
      fetchRemoteModels,
    });

    const result = await service.listModels({ forceRefresh: true });

    expect(fetchRemoteModels).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      models: [
        {
          id: 'openai/gpt-5.4',
          name: 'GPT-5.4',
          provider: 'openai',
          description: 'Latest OpenAI reasoning model',
          contextLength: 400_000,
          supportedReasoningEfforts: GENERIC_REASONING_EFFORTS,
          defaultReasoningEffort: GENERIC_REASONING_DEFAULT_EFFORT,
        },
      ],
      fetchedAt: now,
      stale: false,
    });
  });
});
