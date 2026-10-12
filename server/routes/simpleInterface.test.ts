import { describe, expect, test } from 'bun:test';
import {
  simpleAppAssetQuery,
  simpleAppFormActionSource,
  simpleAppReferrerSessionKey,
} from './simpleInterface';

describe('Simple interface runtime asset URLs', () => {
  test('preserves the owning window session on every generated asset request', () => {
    const query = simpleAppAssetQuery({
      revision: 'compiled revision',
      windowSessionKey: 'window/session',
    });
    const parsed = new URLSearchParams(query);

    expect(parsed.get('revision')).toBe('compiled revision');
    expect(parsed.get('windowSessionKey')).toBe('window/session');
  });

  test('keeps browser mode compatible when there is no window session', () => {
    const parsed = new URLSearchParams(simpleAppAssetQuery({ revision: 'compiled-1' }));

    expect(parsed.get('revision')).toBe('compiled-1');
    expect(parsed.has('windowSessionKey')).toBe(false);
  });

  test('recovers project scope for ordinary media URLs from the same-host app referrer', () => {
    expect(simpleAppReferrerSessionKey(
      'http://127.0.0.1:5177/api/simple-interface/app/index.html?revision=r1&windowSessionKey=window-2',
      '127.0.0.1:5177',
    )).toBe('window-2');
    expect(simpleAppReferrerSessionKey(
      'https://example.com/api/simple-interface/app/index.html?windowSessionKey=window-2',
      '127.0.0.1:5177',
    )).toBeNull();
    expect(simpleAppReferrerSessionKey(
      'http://127.0.0.1:5177/unrelated?windowSessionKey=window-2',
      '127.0.0.1:5177',
    )).toBeNull();
  });
});

describe('Simple interface form boundary', () => {
  test('restricts form navigation to the exact inert app document on the requested host', () => {
    expect(simpleAppFormActionSource('127.0.0.1:5177'))
      .toBe('127.0.0.1:5177/api/simple-interface/app/index.html');
    expect(simpleAppFormActionSource('example.com'))
      .toBe('example.com/api/simple-interface/app/index.html');
    expect(simpleAppFormActionSource('[::1]:5177'))
      .toBe('[::1]:5177/api/simple-interface/app/index.html');
  });

  test('fails closed on missing or directive-injecting host headers', () => {
    for (const host of [undefined, '', 'example.com/path', 'example.com;form-action *', 'user@example.com', 'example.com\nscript-src *']) {
      expect(() => simpleAppFormActionSource(host)).toThrow('Invalid interface host');
    }
  });
});
