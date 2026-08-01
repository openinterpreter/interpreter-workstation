import { describe, expect, test } from 'bun:test';
import {
  buildLmStudioPack,
  buildOllamaPack,
  resolveOnboardingReviewDefaultProfileId,
} from './ModelSetupScreen';

describe('buildOllamaPack', () => {
  test('returns no selectable profiles when installed models are not tool-capable', () => {
    const pack = buildOllamaPack([
      { id: 'llama3.2:3b', displayName: 'llama3.2:3b', toolUseSupport: 'unsupported' },
    ], { includeRecommendedFallback: false });

    expect(pack.defaultProfileId).toBe('');
    expect(pack.profiles).toEqual([]);
  });

  test('only keeps tool-capable installed models', () => {
    const pack = buildOllamaPack([
      { id: 'llama3.2:3b', displayName: 'llama3.2:3b', toolUseSupport: 'unsupported' },
      { id: 'qwen3.5:4b', displayName: 'qwen3.5:4b', toolUseSupport: 'supported' },
    ]);

    expect(pack.defaultProfileId).toBe('onboarding:ollama-qwen3-5-4b');
    expect(pack.profiles.map((profile) => profile.modelId)).toEqual(['qwen3.5:4b']);
  });

  test('falls back to recommended IDs when runtime is unreachable', () => {
    const pack = buildOllamaPack(undefined, { includeRecommendedFallback: true });

    expect(pack.defaultProfileId).toBe('onboarding:ollama-qwen3-5-4b');
    expect(pack.profiles[0]?.modelId).toBe('qwen3.5:4b');
  });
});

describe('buildLmStudioPack', () => {
  test('returns no selectable profiles when installed models are not tool-capable', () => {
    const pack = buildLmStudioPack([
      { id: 'meta/llama-3.2-3b', displayName: 'Llama 3.2 3B', toolUseSupport: 'unsupported' },
    ], [], { includeRecommendedFallback: false });

    expect(pack.defaultProfileId).toBe('');
    expect(pack.profiles).toEqual([]);
  });

  test('only keeps tool-capable installed models', () => {
    const pack = buildLmStudioPack([
      { id: 'meta/llama-3.2-3b', displayName: 'Llama 3.2 3B', toolUseSupport: 'unsupported' },
      { id: 'qwen/qwen3.5-4b', displayName: 'Qwen 3.5 4B', toolUseSupport: 'supported' },
    ], [], { includeRecommendedFallback: false });

    expect(pack.defaultProfileId).toBe('onboarding:lmstudio-qwen-qwen3-5-4b');
    expect(pack.profiles.map((profile) => profile.modelId)).toEqual(['qwen/qwen3.5-4b']);
  });

  test('excludes installed LM Studio models when tool metadata is unknown', () => {
    const pack = buildLmStudioPack([
      { id: 'qwen/qwen3.5-4b', displayName: 'Qwen 3.5 4B', toolUseSupport: 'unknown' },
    ], [], { includeRecommendedFallback: false });

    expect(pack.defaultProfileId).toBe('');
    expect(pack.profiles.map((profile) => profile.modelId)).toEqual([]);
  });

  test('falls back to recommended IDs when runtime does not report models', () => {
    const pack = buildLmStudioPack(undefined, [], { includeRecommendedFallback: true });
    expect(pack.defaultProfileId).toBe('onboarding:lmstudio-qwen-qwen3-5-4b');
    expect(pack.profiles[0]?.modelId).toBe('qwen/qwen3.5-4b');
  });
});

describe('resolveOnboardingReviewDefaultProfileId', () => {
  test('uses explicit setup model mentions when opening a review pack', () => {
    expect(resolveOnboardingReviewDefaultProfileId(
      'I mostly use GPT-5.4 mini.',
      [
        {
          id: 'onboarding:openai-gpt-5-4-nano',
          name: 'GPT 5.4 Nano',
          modelId: 'gpt-5.4-nano',
        },
        {
          id: 'onboarding:openai-gpt-5-4-mini',
          name: 'GPT 5.4 Mini',
          modelId: 'gpt-5.4-mini',
        },
      ],
      'onboarding:openai-gpt-5-4-nano',
    )).toBe('onboarding:openai-gpt-5-4-mini');
  });

  test('keeps the pack default when setup text does not name a selectable model', () => {
    expect(resolveOnboardingReviewDefaultProfileId(
      'I use OpenAI and Ollama.',
      [
        {
          id: 'onboarding:openai-gpt-5-4-nano',
          name: 'GPT 5.4 Nano',
          modelId: 'gpt-5.4-nano',
        },
        {
          id: 'onboarding:openai-gpt-5-4-mini',
          name: 'GPT 5.4 Mini',
          modelId: 'gpt-5.4-mini',
        },
      ],
      'onboarding:openai-gpt-5-4-nano',
    )).toBe('onboarding:openai-gpt-5-4-nano');
  });
});
