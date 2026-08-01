import { describe, expect, test } from 'bun:test';
import { resolveLinkNavigationAction } from './linkNavigation';

describe('resolveLinkNavigationAction', () => {
  test('returns none when href is empty', () => {
    expect(resolveLinkNavigationAction(undefined)).toEqual({ type: 'none' });
  });

  test('routes local file links to shared local open action', () => {
    expect(resolveLinkNavigationAction('./docs/readme.md')).toEqual({
      type: 'open-local',
      target: {
        path: './docs/readme.md',
        itemType: 'file',
      },
    });
  });

  test('routes local directory links to shared local open action', () => {
    expect(resolveLinkNavigationAction('./docs/')).toEqual({
      type: 'open-local',
      target: {
        path: './docs',
        itemType: 'directory',
      },
    });
  });

  test('routes https links to external browser action', () => {
    expect(resolveLinkNavigationAction('https://example.com')).toEqual({
      type: 'open-external',
      url: 'https://example.com',
    });
  });
});
