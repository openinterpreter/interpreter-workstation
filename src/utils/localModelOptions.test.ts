import { describe, expect, test } from 'bun:test';
import { buildLocalModelOptions, inferLocalRuntime } from './localModelOptions';

describe('inferLocalRuntime', () => {
  test('defaults to ollama when no base URL is configured', () => {
    expect(inferLocalRuntime(undefined)).toBe('ollama');
    expect(inferLocalRuntime('')).toBe('ollama');
  });

  test('detects lmstudio from the configured port', () => {
    expect(inferLocalRuntime('http://localhost:1234/v1')).toBe('lmstudio');
  });
});

describe('buildLocalModelOptions', () => {
  test('prefers tool-capable ollama models when metadata is available', () => {
    expect(
      buildLocalModelOptions(
        'ollama',
        {
          running: true,
          ollamaModels: [
            {
              id: 'vision-ai:latest',
              displayName: 'Vision AI',
              toolUseSupport: 'unsupported',
            },
            {
              id: 'qwen3.5:4b',
              displayName: 'Qwen 3.5',
              paramsString: '4B',
              toolUseSupport: 'supported',
            },
          ],
        },
        null,
      ),
    ).toEqual([
      {
        id: 'qwen3.5:4b',
        name: 'qwen3.5 (4B)',
      },
    ]);
  });

  test('prefers tool-capable lmstudio models when metadata is available', () => {
    expect(
      buildLocalModelOptions(
        'lmstudio',
        { running: false },
        {
          running: true,
          lmStudioModels: [
            {
              id: 'qwen/qwen3.5-4b',
              displayName: 'Qwen 3.5',
              paramsString: '4B',
              toolUseSupport: 'supported',
            },
            {
              id: 'vision-ai',
              displayName: 'Vision AI',
              toolUseSupport: 'unsupported',
            },
          ],
        },
      ),
    ).toEqual([
      {
        id: 'qwen/qwen3.5-4b',
        name: 'Qwen 3.5 (4B)',
      },
    ]);
  });

  test('does not select lmstudio models when tool metadata is unknown', () => {
    expect(
      buildLocalModelOptions(
        'lmstudio',
        { running: false },
        {
          running: true,
          lmStudioModels: [
            {
              id: 'qwen/qwen3.5-4b',
              displayName: 'Qwen 3.5',
              paramsString: '4B',
              toolUseSupport: 'unknown',
            },
          ],
        },
      ),
    ).toEqual([]);
  });

  test('falls back to recommended and installed models when tool metadata is unavailable', () => {
    expect(
      buildLocalModelOptions(
        'ollama',
        {
          running: true,
          models: ['llama3.1:8b', 'qwen3.5:4b', '  '],
        },
        null,
      ),
    ).toEqual([
      { id: 'qwen3.5:4b', name: 'Qwen3.5 4B (recommended default)' },
      { id: 'qwen3.5:0.8b', name: 'Qwen3.5 0.8B' },
      { id: 'qwen3.5:9b', name: 'Qwen3.5 9B' },
      { id: 'llama3.1:8b', name: 'llama3.1:8b (installed)' },
    ]);
  });

  test('uses lmstudio installed model IDs when lmstudio metadata is unavailable', () => {
    expect(
      buildLocalModelOptions(
        'lmstudio',
        { running: false },
        {
          running: true,
          models: ['custom-model'],
        },
      ),
    ).toEqual([
      { id: 'qwen/qwen3.5-4b', name: 'Qwen3.5 4B (recommended default)' },
      { id: 'qwen/qwen3.5-0.8b', name: 'Qwen3.5 0.8B' },
      { id: 'qwen/qwen3.5-9b', name: 'Qwen3.5 9B' },
      { id: 'custom-model', name: 'custom-model (installed)' },
    ]);
  });
});
