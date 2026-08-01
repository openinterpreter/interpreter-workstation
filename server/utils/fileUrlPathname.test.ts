import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { normalizeFileUrlPathname } from './fileUrlPathname';

describe('normalizeFileUrlPathname', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      writable: true,
      configurable: true,
    });
  });

  test('matches VS Code URI.fsPath handling for Windows file URL pathnames', () => {
    expect(normalizeFileUrlPathname('/C:/Users/yongs/Documents/report.md')).toBe(
      'C:\\Users\\yongs\\Documents\\report.md',
    );
    expect(normalizeFileUrlPathname('/c:/Users/yongs/Documents/report.md')).toBe(
      'C:\\Users\\yongs\\Documents\\report.md',
    );
  });

  test('leaves non-file-URL pathnames alone on Windows', () => {
    expect(normalizeFileUrlPathname('/mnt/c/Users/yongs/report.md')).toBe(
      '/mnt/c/Users/yongs/report.md',
    );
    expect(normalizeFileUrlPathname('/tmp/report.md')).toBe('/tmp/report.md');
  });
});
