import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';

import { OPENROUTER_MODEL_OPTIONS } from '../generated/modelCatalog';
import { isValidHostedModelId, validateProfileModelId } from './modelIdValidation';

describe('isValidHostedModelId', () => {
  test('accepts interpreter aliases', () => {
    assert.equal(isValidHostedModelId('interpreter-smart'), true);
    assert.equal(isValidHostedModelId('interpreter-fast'), true);
  });

  test('accepts hosted remote model IDs from the generated catalog', () => {
    const sampleIds = OPENROUTER_MODEL_OPTIONS.slice(0, 3).map((option) => option.id);
    assert.equal(sampleIds.length, 3);
    for (const modelId of sampleIds) {
      assert.equal(isValidHostedModelId(modelId), true);
    }
  });

  test('accepts Claude Opus 4.7 hosted model IDs', () => {
    assert.equal(isValidHostedModelId('anthropic/claude-opus-4.7'), true);
  });

  test('rejects bare model names without slash', () => {
    assert.equal(isValidHostedModelId('qwen3.5:9b'), false);
    assert.equal(isValidHostedModelId('llama3.1'), false);
  });

  test('rejects empty or whitespace', () => {
    assert.equal(isValidHostedModelId(''), false);
    assert.equal(isValidHostedModelId('  '), false);
  });
});

describe('validateProfileModelId', () => {
  test('returns error for invalid hosted model ID', () => {
    const error = validateProfileModelId('hosted', 'qwen3.5:9b');
    assert.ok(error);
    assert.match(error!, /Invalid model ID/);
  });

  test('returns null for valid hosted model ID', () => {
    assert.equal(validateProfileModelId('hosted', 'interpreter-smart'), null);
    assert.equal(validateProfileModelId('hosted', 'anthropic/claude-opus-4.7'), null);
    assert.equal(validateProfileModelId('hosted', OPENROUTER_MODEL_OPTIONS[0]?.id), null);
  });

  test('does not validate non-hosted providers', () => {
    assert.equal(validateProfileModelId('api', 'qwen3.5:9b'), null);
    assert.equal(validateProfileModelId('local', 'qwen3.5:9b'), null);
    assert.equal(validateProfileModelId(undefined, 'qwen3.5:9b'), null);
  });

  test('returns null for empty model ID', () => {
    assert.equal(validateProfileModelId('hosted', ''), null);
    assert.equal(validateProfileModelId('hosted', undefined), null);
  });
});
