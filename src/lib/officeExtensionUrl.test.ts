import { describe, expect, test } from 'bun:test';

import { buildOfficeExtensionOpenUrl } from './officeExtensionUrl';

describe('buildOfficeExtensionOpenUrl', () => {
  test('builds open URL with encoded filepath, language, and theme', () => {
    const url = buildOfficeExtensionOpenUrl({
      port: 38123,
      filePath: '/tmp/demo file.docx',
      language: 'fr',
      theme: 'dark',
    });

    const parsed = new URL(url);
    expect(parsed.origin).toBe('http://localhost:38123');
    expect(parsed.pathname).toBe('/open');
    expect(parsed.searchParams.get('filepath')).toBe('/tmp/demo file.docx');
    expect(parsed.searchParams.get('lang')).toBe('fr');
    expect(parsed.searchParams.get('theme')).toBe('dark');
    expect(parsed.searchParams.has('t')).toBe(false);
  });

  test('defaults language to en and appends timestamp when busting cache', () => {
    const originalNow = Date.now;
    Date.now = () => 1700000000000;

    try {
      const url = buildOfficeExtensionOpenUrl({
        port: 38123,
        filePath: '/tmp/demo.docx',
        language: '',
        theme: 'light',
        bustCache: true,
      });

      const parsed = new URL(url);
      expect(parsed.searchParams.get('lang')).toBe('en');
      expect(parsed.searchParams.get('theme')).toBe('light');
      expect(parsed.searchParams.get('t')).toBe('1700000000000');
    } finally {
      Date.now = originalNow;
    }
  });
});
