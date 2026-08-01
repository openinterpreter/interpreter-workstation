import { describe, expect, test } from 'bun:test';

import {
  appendCustomInstructionsToPrompt,
  CUSTOM_INSTRUCTIONS_MAX_CHARS,
  normalizeCustomInstructions,
} from './customInstructions';

describe('customInstructions', () => {
  test('normalizeCustomInstructions returns null for missing/empty values', () => {
    expect(normalizeCustomInstructions(undefined)).toBeNull();
    expect(normalizeCustomInstructions(null)).toBeNull();
    expect(normalizeCustomInstructions('   \n\t')).toBeNull();
  });

  test('normalizeCustomInstructions trims and enforces maximum length', () => {
    const oversized = `  ${'x'.repeat(CUSTOM_INSTRUCTIONS_MAX_CHARS + 25)}  `;
    const normalized = normalizeCustomInstructions(oversized);
    expect(normalized).not.toBeNull();
    expect(normalized?.length).toBe(CUSTOM_INSTRUCTIONS_MAX_CHARS);
  });

  test('appendCustomInstructionsToPrompt includes explicit xml tag wrapper', () => {
    const basePrompt = 'Base prompt';
    expect(appendCustomInstructionsToPrompt(basePrompt, null)).toBe(basePrompt);

    const withCustomInstructions = appendCustomInstructionsToPrompt(
      basePrompt,
      'Always answer in bullet points.',
    );
    expect(withCustomInstructions).toContain('## Persistent User Custom Instructions');
    expect(withCustomInstructions).toContain('<user_custom_instructions>');
    expect(withCustomInstructions).toContain('Always answer in bullet points.');
    expect(withCustomInstructions).toContain('</user_custom_instructions>');
  });
});
