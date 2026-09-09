import { describe, expect, test } from 'bun:test';

import {
  buildPiiLabelAttributes,
  buildRedactedText,
  findRedactedTokens,
  mergeDetections,
  normalizePiiCategory,
} from './labels';

describe('normalizePiiCategory', () => {
  test('lowercases engine labels and maps person aliases', () => {
    expect(normalizePiiCategory('EMAIL')).toBe('email');
    expect(normalizePiiCategory('person')).toBe('person_full_name');
    expect(normalizePiiCategory('Name')).toBe('person_full_name');
    expect(normalizePiiCategory('IBAN')).toBe('iban');
  });
});

describe('findRedactedTokens', () => {
  test('finds stored tokens with document positions', () => {
    const tokens = findRedactedTokens('Contact [EMAIL_0] or [IBAN_1] please');
    expect(tokens.map((t) => t.token)).toEqual(['[EMAIL_0]', '[IBAN_1]']);
    expect(tokens[0].category).toBe('email');
    expect(tokens[1].category).toBe('iban');
    expect(tokens[0].start).toBe('Contact '.length);
  });

  test('ignores non-token brackets', () => {
    expect(findRedactedTokens('see [image: logo] and [link](x)')).toEqual([]);
  });
});

describe('buildRedactedText', () => {
  test('assigns stable per-category tokens in order of appearance', () => {
    const result = buildRedactedText('Call john@example.com or jane@example.com on 415-555-0199', [
      { category: 'email', start: 5, end: 21, text: 'john@example.com', confidence: 1 },
      { category: 'email', start: 25, end: 41, text: 'jane@example.com', confidence: 1 },
      { category: 'phone', start: 45, end: 57, text: '415-555-0199', confidence: 1 },
    ]);
    expect(result.redactedText).toBe('Call [EMAIL_0] or [EMAIL_1] on [PHONE_0]');
    expect(result.rehydrationMap).toEqual({
      '[EMAIL_0]': 'john@example.com',
      '[EMAIL_1]': 'jane@example.com',
      '[PHONE_0]': '415-555-0199',
    });
  });

  test('drops overlapping detections instead of corrupting text', () => {
    const result = buildRedactedText('john@example.com', [
      { category: 'email', start: 0, end: 16, text: 'john@example.com', confidence: 1 },
      { category: 'email', start: 5, end: 10, text: 'hn@ex', confidence: 0.4 },
    ]);
    expect(result.redactedText).toBe('[EMAIL_0]');
  });
});

describe('mergeDetections', () => {
  test('prefers full NER results and keeps regex-only gaps', () => {
    const merged = mergeDetections(
      [{ category: 'person_full_name', start: 11, end: 15, text: 'John', confidence: 0.8 }],
      [
        { category: 'email', start: 11, end: 15, text: 'John', confidence: 1 },
        { category: 'email', start: 30, end: 46, text: 'john@example.com', confidence: 1 },
      ],
    );
    expect(merged.map((detection) => detection.category)).toEqual([
      'person_full_name',
      'email',
    ]);
  });
});

describe('buildPiiLabelAttributes', () => {
  test('exposes category, positions and accessible label', () => {
    const attributes = buildPiiLabelAttributes(
      { category: 'email', token: '[EMAIL_0]' },
      { from: 8, to: 17 },
    );
    expect(attributes['data-pii-category']).toBe('email');
    expect(attributes['data-pii-token']).toBe('[EMAIL_0]');
    expect(attributes['data-from']).toBe('8');
    expect(attributes['data-to']).toBe('17');
    expect(attributes['aria-label']).toContain('Email');
  });
});
