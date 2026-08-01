import { describe, expect, test } from 'bun:test';
import { appendOverlayPromptExtras } from './overlay-prompt-extras';

describe('overlay prompt extras', () => {
  test('keeps the base prompt unchanged without addendum or custom instructions', () => {
    expect(appendOverlayPromptExtras('Base prompt.', {})).toBe('Base prompt.');
  });

  test('appends a trimmed system addendum before custom instructions', () => {
    const prompt = appendOverlayPromptExtras('Base prompt.', {
      systemAddendum: '  Extra system detail.  ',
      customInstructions: 'Prefer concise answers.',
    });

    expect(prompt).toContain('Base prompt.\n\nExtra system detail.');
    expect(prompt).toContain('## Persistent User Custom Instructions');
    expect(prompt).toContain('<user_custom_instructions>\nPrefer concise answers.\n</user_custom_instructions>');
    expect(prompt.indexOf('Extra system detail.')).toBeLessThan(prompt.indexOf('## Persistent User Custom Instructions'));
  });
});
