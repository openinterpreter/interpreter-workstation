import { describe, expect, test } from 'bun:test';
import {
  getCodexMacosAdditionalReadableRoots,
  getCodexMacosScreenshotRoots,
  getCodexMacosTempRoots,
  getCodexMacosTrustedCustomPaths,
  isPathInCodexMacosTrustedReadZone,
} from './codexTrustedPaths';

describe('codexTrustedPaths', () => {
  test('returns macOS temp roots with /private aliases', () => {
    expect(getCodexMacosTempRoots({
      platform: 'darwin',
      tmpDir: '/var/folders/example/T',
    })).toEqual([
      '/var/folders/example/T',
      '/private/var/folders/example/T',
      '/tmp',
      '/private/tmp',
    ]);
  });

  test('returns screenshot staging roots under TemporaryItems', () => {
    expect(getCodexMacosScreenshotRoots({
      platform: 'darwin',
      tmpDir: '/var/folders/example/T',
    })).toEqual([
      '/var/folders/example/T/TemporaryItems',
      '/private/var/folders/example/T/TemporaryItems',
    ]);
  });

  test('uses temp roots when temp access is enabled', () => {
    expect(getCodexMacosAdditionalReadableRoots({
      platform: 'darwin',
      tmpDir: '/var/folders/example/T',
      tempAccessEnabled: true,
      screenshotAccessEnabled: false,
    })).toEqual([
      '/var/folders/example/T',
      '/private/var/folders/example/T',
      '/tmp',
      '/private/tmp',
    ]);
  });

  test('uses screenshot roots when temp access is disabled', () => {
    expect(getCodexMacosTrustedCustomPaths({
      platform: 'darwin',
      tmpDir: '/var/folders/example/T',
      tempAccessEnabled: false,
      screenshotAccessEnabled: true,
    })).toEqual({
      '/var/folders/example/T/TemporaryItems': 'read',
      '/private/var/folders/example/T/TemporaryItems': 'read',
    });
  });

  test('matches screenshot files through /private aliases', () => {
    expect(isPathInCodexMacosTrustedReadZone(
      '/private/var/folders/example/T/TemporaryItems/NSIRD_screencaptureui_123/Screenshot.png',
      {
        platform: 'darwin',
        tmpDir: '/var/folders/example/T',
        tempAccessEnabled: false,
        screenshotAccessEnabled: true,
      },
    )).toBe(true);
  });

  test('returns no trusted macOS paths on non-macOS platforms', () => {
    expect(getCodexMacosAdditionalReadableRoots({
      platform: 'linux',
      tmpDir: '/var/folders/example/T',
    })).toEqual([]);
  });
});
