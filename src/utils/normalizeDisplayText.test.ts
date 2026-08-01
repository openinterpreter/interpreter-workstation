import { describe, expect, test } from 'bun:test';
import { normalizeDisplayText } from './normalizeDisplayText';

describe('normalizeDisplayText', () => {
  test('returns strings unchanged', () => {
    expect(normalizeDisplayText('Download failed')).toBe('Download failed');
  });

  test('returns error messages for Error instances', () => {
    expect(normalizeDisplayText(new Error('LM Studio crashed'))).toBe('LM Studio crashed');
  });

  test('stringifies plain objects', () => {
    expect(normalizeDisplayText({ message: 'Bad request', code: 400 })).toBe('{"message":"Bad request","code":400}');
  });

  test('returns empty string for nullish values', () => {
    expect(normalizeDisplayText(undefined)).toBe('');
    expect(normalizeDisplayText(null)).toBe('');
  });

  test('falls back to String() for circular objects', () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(normalizeDisplayText(circular)).toBe('[object Object]');
  });
});
