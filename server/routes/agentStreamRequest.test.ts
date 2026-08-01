import { describe, expect, test } from 'bun:test';

import {
  normalizeStreamRequestBody,
  selectRequestedRuntimeModel,
} from './agentStreamRequest';

describe('agent stream request normalization', () => {
  test('profile-backed requests preserve explicit runtime overrides', () => {
    const request = normalizeStreamRequestBody({
      message: 'hello',
      profileId: 'custom:profile-a',
      model: 'stale-model',
      codexProfileId: 'custom-openai',
      customEndpoint: 'https://api.example.com/v1',
      customApiKey: 'secret',
      attachments: [],
      reasoningEffort: 'high',
    });

    expect(request).toEqual({
      agentId: undefined,
      callerToken: undefined,
      message: 'hello',
      threadId: undefined,
      workspacePath: undefined,
      reasoningEffort: 'high',
      attachments: [],
      skills: [],
      selection: 'stored-profile',
      profileId: 'custom:profile-a',
      model: 'stale-model',
      codexProfileId: 'custom-openai',
      customEndpoint: 'https://api.example.com/v1',
      customApiKey: 'secret',
    });
  });

  test('explicit requests preserve runtime selection fields', () => {
    const request = normalizeStreamRequestBody({
      message: 'hello',
      model: 'gpt-5.4',
      codexProfileId: 'custom-openai',
      customEndpoint: 'https://api.example.com/v1',
      customApiKey: 'secret',
      attachments: [],
      reasoningEffort: 'low',
    });

    expect(request).toEqual({
      agentId: undefined,
      callerToken: undefined,
      message: 'hello',
      threadId: undefined,
      workspacePath: undefined,
      reasoningEffort: 'low',
      attachments: [],
      skills: [],
      selection: 'explicit',
      model: 'gpt-5.4',
      codexProfileId: 'custom-openai',
      customEndpoint: 'https://api.example.com/v1',
      customApiKey: 'secret',
    });
  });

  test('profile-backed requests use explicit model overrides when present', () => {
    const request = normalizeStreamRequestBody({
      profileId: 'custom:profile-a',
      model: 'active-thread-model',
    });

    expect(selectRequestedRuntimeModel(request, 'profile-model')).toBe(
      'active-thread-model',
    );
  });

  test('profile-backed requests fall back to the stored profile model', () => {
    const request = normalizeStreamRequestBody({
      profileId: 'custom:profile-a',
    });

    expect(selectRequestedRuntimeModel(request, 'profile-model')).toBe(
      'profile-model',
    );
  });

  test('explicit requests fall back to resolved codex profile model', () => {
    const request = normalizeStreamRequestBody({
      codexProfileId: 'interpreter',
    });

    expect(selectRequestedRuntimeModel(request, 'preset-default-model')).toBe(
      'preset-default-model',
    );
  });
});
