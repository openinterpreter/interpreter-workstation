import { describe, expect, test } from 'bun:test';
import {
  simpleAppAssetQuery,
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
