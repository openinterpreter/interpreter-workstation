import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';

import {
  getUsageAccentColor,
  resolveUsageIconIdentity,
} from './planUsageAppearance';

describe('resolveUsageIconIdentity', () => {
  test('treats interpreter plans as interpreter-branded rows', () => {
    assert.deepEqual(resolveUsageIconIdentity('Workstation Pro'), { type: 'interpreter' });
    assert.deepEqual(resolveUsageIconIdentity('Free'), { type: 'interpreter' });
  });
});

describe('getUsageAccentColor', () => {
  test('returns washed provider hues for known model families', () => {
    assert.match(getUsageAccentColor('openai/gpt-5.4'), /#10A37F/i);
    assert.match(getUsageAccentColor('claude-3-5-sonnet-20240620'), /#D4A373/i);
    assert.match(getUsageAccentColor('qwen\/qwen3.5-397b-a17b'), /#2AA198/i);
  });

  test('falls back to a muted neutral tone when the provider is unknown', () => {
    assert.match(
      getUsageAccentColor('search'),
      /var\(--foreground\)/,
    );
  });
});
