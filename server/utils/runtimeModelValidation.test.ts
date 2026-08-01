import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';

import { OPENROUTER_MODEL_OPTIONS } from '../../shared/generated/modelCatalog';
import { validateRuntimeModelId } from './runtimeModelValidation';

describe('validateRuntimeModelId', () => {
  test('accepts interpreter aliases for interpreter provider', () => {
    assert.equal(validateRuntimeModelId('interpreter', 'interpreter-smart'), null);
    assert.equal(validateRuntimeModelId('interpreter', 'interpreter-fast'), null);
  });

  test('accepts provider/model format for interpreter provider', () => {
    assert.equal(validateRuntimeModelId('interpreter', 'anthropic/claude-sonnet-4.6'), null);
  });

  test('rejects local-style model IDs for interpreter provider', () => {
    const error = validateRuntimeModelId('interpreter', 'qwen3.5:9b');
    assert.ok(error);
    assert.match(error!, /Invalid hosted model ID 'qwen3.5:9b'/);
    assert.match(error!, /switch to a Local profile/i);
  });

  test('accepts provider/model format for openrouter provider', () => {
    const sampleIds = OPENROUTER_MODEL_OPTIONS.slice(0, 2).map((option) => option.id);
    assert.equal(sampleIds.length, 2);
    for (const modelId of sampleIds) {
      assert.equal(validateRuntimeModelId('openrouter', modelId), null);
    }
  });

  test('accepts current OpenRouter GPT-5.5 models', () => {
    assert.equal(validateRuntimeModelId('openrouter', 'openai/gpt-5.5'), null);
    assert.equal(validateRuntimeModelId('interpreter', 'openai/gpt-5.5'), null);
  });

  test('rejects hosted OpenAI models that do not support custom/freeform tools', () => {
    for (const provider of ['interpreter', 'openrouter'] as const) {
      for (const modelId of ['openai/gpt-4o-mini', 'openai/gpt-4.1'] as const) {
        const error = validateRuntimeModelId(provider, modelId);
        assert.ok(error);
        assert.match(error!, new RegExp(modelId.replace('.', '\\.')));
        assert.match(error!, /custom\/freeform agent tools/i);
        assert.match(error!, /gpt-5\.4-nano/);
      }
    }
  });

  test('rejects local-style model IDs for openrouter provider', () => {
    const error = validateRuntimeModelId('openrouter', 'qwen3.5:9b');
    assert.ok(error);
    assert.match(error!, /Invalid OpenRouter model ID 'qwen3.5:9b'/);
    assert.match(error!, /switch to a Local profile/i);
  });

  test('does not validate unrelated providers', () => {
    assert.equal(validateRuntimeModelId('ollama', 'qwen3.5:9b'), null);
    assert.equal(validateRuntimeModelId('lmstudio', 'qwen3.5-9b'), null);
    assert.equal(validateRuntimeModelId('custom-provider', 'model-name'), null);
  });

  test('rejects OpenAI API models that do not support custom/freeform tools', () => {
    for (const modelId of ['gpt-4o', 'openai/gpt-4o', 'gpt-4.1', 'gpt-4'] as const) {
      const error = validateRuntimeModelId('openai-api', modelId);
      assert.ok(error);
      assert.match(error!, new RegExp(modelId));
      assert.match(error!, /custom\/freeform agent tools/i);
      assert.match(error!, /gpt-5\.4-nano/);
    }
  });

  test('accepts GPT-5 family OpenAI API models for custom/freeform tools', () => {
    for (const modelId of ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-5.1', 'gpt-5.2', 'gpt-5.3-codex', 'gpt-5.4', 'gpt-5.5'] as const) {
      assert.equal(validateRuntimeModelId('openai-api', modelId), null);
      assert.equal(validateRuntimeModelId('openai', modelId), null);
    }
  });

  test('accepts OpenRouter-style GPT-5 IDs for OpenAI API custom/freeform tools', () => {
    assert.equal(validateRuntimeModelId('openai-api', 'openai/gpt-5.4'), null);
  });

  test('rejects empty model ID', () => {
    assert.equal(validateRuntimeModelId('interpreter', ''), 'Model is required.');
    assert.equal(validateRuntimeModelId('openrouter', '   '), 'Model is required.');
  });
});
