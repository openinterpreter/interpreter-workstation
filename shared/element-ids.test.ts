import { describe, expect, test } from 'bun:test';
import { ELEMENT_IDS } from './element-ids';

describe('ELEMENT_IDS.tabByPath', () => {
  test('escapes Windows backslashes for CSS attribute selectors', () => {
    expect(ELEMENT_IDS.tabByPath('C:\\repo\\notes.txt')).toBe(
      '[data-tab-path="C:\\\\repo\\\\notes.txt"]',
    );
  });

  test('escapes double quotes in attribute values', () => {
    expect(ELEMENT_IDS.tabByPath('/tmp/a"b.txt')).toBe(
      '[data-tab-path="/tmp/a\\"b.txt"]',
    );
  });
});
