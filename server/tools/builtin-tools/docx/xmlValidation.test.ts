import { describe, test, expect } from 'bun:test';
import { validateOoxmlDocument } from './xmlValidation';

describe('validateOoxmlDocument', () => {
  test('valid XML returns valid result', () => {
    const xml = '<?xml version="1.0"?><root><child>text</child></root>';
    const result = validateOoxmlDocument(xml);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test('invalid XML returns error with message', () => {
    const xml = '<root><![CDATA[unterminated';
    const result = validateOoxmlDocument(xml);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].message).toBeTruthy();
  });

  test('unclosed comment returns error', () => {
    const xml = '<root><!-- unterminated comment';
    const result = validateOoxmlDocument(xml);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toBeTruthy();
  });

  test('malformed attribute returns error', () => {
    const xml = '<root><child attr="missing close>text</child></root>';
    const result = validateOoxmlDocument(xml);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toBeTruthy();
  });

  test('mismatched closing tag returns line-aware error', () => {
    const xml = [
      '<?xml version="1.0"?>',
      '<root>',
      '  <outer>',
      '    <inner>text</inner>',
      '  </root>',
    ].join('\n');
    const result = validateOoxmlDocument(xml);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('Expected closing tag');
    expect(result.errors[0].line).toBeTruthy();
  });
});
