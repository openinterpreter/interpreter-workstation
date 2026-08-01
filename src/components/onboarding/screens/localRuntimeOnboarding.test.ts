import { describe, expect, test } from 'bun:test';

import type { Profile } from '../../../../shared/types/profile';
import type { LmStudioStatus, OllamaStatus } from '../../../../shared/types/provider';
import {
  buildLocalPackReviewPlan,
  isLocalProfileInstalled,
  resolvePersistedLocalProfiles,
} from './localRuntimeOnboarding';

function makeLocalProfile(
  id: string,
  modelId: string,
  codexProfileId: 'ollama' | 'lmstudio',
): Profile {
  return {
    id,
    name: modelId,
    modelId,
    isBuiltin: false,
    provider: 'local',
    providerId: 'builtin:local',
    codexProfileId,
  };
}

describe('buildLocalPackReviewPlan', () => {
  test('uses installed tool-capable Ollama models when they are available', () => {
    const status: OllamaStatus = {
      running: true,
      models: ['qwen3.5:0.8b'],
      totalChatModels: 2,
      ollamaModels: [
        { id: 'qwen3.5:0.8b', displayName: 'qwen3.5:0.8b', toolUseSupport: 'supported' },
        { id: 'tinyllama:latest', displayName: 'tinyllama:latest', toolUseSupport: 'unsupported' },
      ],
    };

    const plan = buildLocalPackReviewPlan('ollama', status);

    expect(plan.requiresInstall).toBe(false);
    expect(plan.profiles.map((profile) => profile.modelId)).toEqual(['qwen3.5:0.8b']);
    expect(plan.defaultProfileId).toBe('onboarding:ollama-qwen3-5-0-8b');
  });

  test('offers install candidates when Ollama is running without tool-capable models', () => {
    const status: OllamaStatus = {
      running: true,
      models: [],
      totalChatModels: 1,
      ollamaModels: [
        { id: 'tinyllama:latest', displayName: 'tinyllama:latest', toolUseSupport: 'unsupported' },
      ],
    };

    const plan = buildLocalPackReviewPlan('ollama', status);

    expect(plan.requiresInstall).toBe(true);
    expect(plan.profiles.map((profile) => profile.modelId)).toEqual([
      'qwen3.5:4b',
      'qwen3.5:0.8b',
      'qwen3.5:9b',
    ]);
    expect(plan.defaultProfileId).toBe('onboarding:ollama-qwen3-5-4b');
  });

  test('does not select Ollama cloud models when tool support is unknown', () => {
    const status: OllamaStatus = {
      running: true,
      models: ['kimi-k2.6:cloud'],
      totalChatModels: 1,
      ollamaModels: [
        { id: 'kimi-k2.6:cloud', displayName: 'kimi-k2.6:cloud', toolUseSupport: 'unknown' },
      ],
    };

    const plan = buildLocalPackReviewPlan('ollama', status);

    expect(plan.requiresInstall).toBe(true);
    expect(plan.profiles.map((profile) => profile.modelId)).toEqual([
      'qwen3.5:4b',
      'qwen3.5:0.8b',
      'qwen3.5:9b',
    ]);
    expect(plan.defaultProfileId).toBe('onboarding:ollama-qwen3-5-4b');
  });

  test('keeps verified Ollama models when unverified cloud models are also installed', () => {
    const status: OllamaStatus = {
      running: true,
      models: ['kimi-k2.6:cloud', 'qwen3.5:4b'],
      totalChatModels: 2,
      ollamaModels: [
        { id: 'kimi-k2.6:cloud', displayName: 'kimi-k2.6:cloud', toolUseSupport: 'unknown' },
        { id: 'qwen3.5:4b', displayName: 'qwen3.5:4b', toolUseSupport: 'supported' },
      ],
    };

    const plan = buildLocalPackReviewPlan('ollama', status);

    expect(plan.requiresInstall).toBe(false);
    expect(plan.profiles.map((profile) => profile.modelId)).toEqual(['qwen3.5:4b']);
    expect(plan.defaultProfileId).toBe('onboarding:ollama-qwen3-5-4b');
  });

  test('offers install candidates when LM Studio is running without tool-capable models', () => {
    const status: LmStudioStatus = {
      running: true,
      models: [],
      totalChatModels: 1,
      inferenceAvailable: true,
      lmStudioModels: [
        { id: 'meta/llama-3.2-3b', displayName: 'Llama 3.2 3B', toolUseSupport: 'unsupported' },
      ],
    };

    const plan = buildLocalPackReviewPlan('lmstudio', status);

    expect(plan.requiresInstall).toBe(true);
    expect(plan.profiles.map((profile) => profile.modelId)).toEqual([
      'qwen/qwen3.5-4b',
      'qwen/qwen3.5-0.8b',
      'qwen/qwen3.5-9b',
    ]);
    expect(plan.defaultProfileId).toBe('onboarding:lmstudio-qwen-qwen3-5-4b');
  });

  test('requires explicit LM Studio tool metadata before selecting detected models', () => {
    const status: LmStudioStatus = {
      running: true,
      models: ['qwen/qwen3.5-4b'],
      totalChatModels: 1,
      inferenceAvailable: true,
      lmStudioModels: [
        { id: 'qwen/qwen3.5-4b', displayName: 'Qwen 3.5 4B', toolUseSupport: 'unknown' },
      ],
    };

    const plan = buildLocalPackReviewPlan('lmstudio', status);

    expect(plan.requiresInstall).toBe(true);
    expect(plan.profiles.map((profile) => profile.modelId)).toEqual([
      'qwen/qwen3.5-4b',
      'qwen/qwen3.5-0.8b',
      'qwen/qwen3.5-9b',
    ]);
    expect(plan.defaultProfileId).toBe('onboarding:lmstudio-qwen-qwen3-5-4b');
  });
});

describe('local onboarding installed-model matching', () => {
  test('treats LM Studio recommended aliases as installed when a matching variant exists', () => {
    expect(
      isLocalProfileInstalled('lmstudio', ['qwen3.5-4b'], 'qwen/qwen3.5-4b'),
    ).toBe(true);
  });

  test('maps selected onboarding profiles to the installed runtime profiles before persisting', () => {
    const selectedProfiles = [
      makeLocalProfile('onboarding:lmstudio-qwen-qwen3-5-4b', 'qwen/qwen3.5-4b', 'lmstudio'),
    ];
    const installedProfiles = [
      makeLocalProfile('onboarding:lmstudio-qwen3-5-4b', 'qwen3.5-4b', 'lmstudio'),
    ];

    const persistedProfiles = resolvePersistedLocalProfiles(
      'lmstudio',
      selectedProfiles,
      installedProfiles,
    );

    expect(persistedProfiles.map((profile) => profile.modelId)).toEqual(['qwen3.5-4b']);
    expect(persistedProfiles.map((profile) => profile.id)).toEqual(['onboarding:lmstudio-qwen3-5-4b']);
  });
});
