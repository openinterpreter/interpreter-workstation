import { describe, expect, test } from 'bun:test';

import { piiSpansForText } from './PiiLabel';

describe('piiSpansForText', () => {
  test('view mode finds stored tokens with node-relative offsets', () => {
    const spans = piiSpansForText('Contact [EMAIL_0] today', 'view');
    expect(spans).toEqual([{ category: 'email', token: '[EMAIL_0]', from: 8, to: 17 }]);
  });

  test('view mode ignores non-token brackets', () => {
    expect(piiSpansForText('see [image: logo]', 'view')).toEqual([]);
  });

  test('compose mode finds live structured PII', () => {
    const spans = piiSpansForText('mail me at jane@example.com', 'compose');
    expect(spans).toHaveLength(1);
    expect(spans[0].category).toBe('email');
    expect(spans[0].token).toBe('jane@example.com');
  });

  test('compose mode returns nothing for plain prose', () => {
    expect(piiSpansForText('The quick brown fox jumps.', 'compose')).toEqual([]);
  });
});
