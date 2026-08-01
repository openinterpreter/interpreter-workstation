import { describe, expect, test } from 'vitest';
import { tokenizeForTyping, valuesEqual } from './pdfFormFieldAnimation';

describe('pdfFormFieldAnimation', () => {
  describe('valuesEqual', () => {
    test('treats nullish values and empty strings as equal', () => {
      expect(valuesEqual(null, '')).toBe(true);
      expect(valuesEqual(undefined, '')).toBe(true);
    });

    test('normalizes boolean-like strings', () => {
      expect(valuesEqual(true, 'yes')).toBe(true);
      expect(valuesEqual(false, '0')).toBe(true);
      expect(valuesEqual(true, 'off')).toBe(false);
    });

    test('compares arrays without caring about order', () => {
      expect(valuesEqual(['b', 'a'], ['a', 'b'])).toBe(true);
      expect(valuesEqual(['a'], ['a', 'b'])).toBe(false);
    });

    test('trims scalar string comparisons', () => {
      expect(valuesEqual('  Replaced Value  ', 'Replaced Value')).toBe(true);
      expect(valuesEqual('Initial', 'Changed')).toBe(false);
    });
  });

  describe('tokenizeForTyping', () => {
    test('preserves leading spaces with the following token', () => {
      expect(tokenizeForTyping('Hello  world')).toEqual(['Hello', '  world']);
    });

    test('splits punctuation into separate tokens', () => {
      expect(tokenizeForTyping('Acme, Inc.')).toEqual(['Acme', ',', ' Inc', '.']);
    });

    test('keeps trailing whitespace on the final token', () => {
      expect(tokenizeForTyping('field value   ')).toEqual(['field', ' value   ']);
    });
  });
});
