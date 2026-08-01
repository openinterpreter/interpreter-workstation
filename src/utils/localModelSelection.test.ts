import { describe, expect, test } from 'bun:test';
import { pickLocalModelId } from './localModelSelection';

describe('pickLocalModelId', () => {
  test('returns first installed model when available', () => {
    expect(pickLocalModelId(['llama3.1:8b', 'qwen3.5:4b'], 'qwen3.5:4b')).toBe('llama3.1:8b');
  });

  test('skips empty installed model IDs', () => {
    expect(pickLocalModelId([' ', '', 'mistral:7b'], 'qwen3.5:4b')).toBe('mistral:7b');
  });

  test('returns fallback model when no installed model is available', () => {
    expect(pickLocalModelId([], 'qwen3.5:4b')).toBe('qwen3.5:4b');
    expect(pickLocalModelId(undefined, 'qwen3.5:4b')).toBe('qwen3.5:4b');
  });
});
