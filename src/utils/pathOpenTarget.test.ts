import { describe, expect, test } from 'bun:test';

import { resolveOpenTargetType } from './pathOpenTarget';

describe('resolveOpenTargetType', () => {
  test('opens directories as folder tabs when folder tabs are available', async () => {
    const targetType = await resolveOpenTargetType('/tmp/dist', {
      canOpenFolderTabs: true,
      getStats: async () => ({ isDirectory: true }),
    });

    expect(targetType).toBe('folder');
  });

  test('keeps regular files as file tabs', async () => {
    const targetType = await resolveOpenTargetType('/tmp/readme.md', {
      canOpenFolderTabs: true,
      getStats: async () => ({ isDirectory: false }),
    });

    expect(targetType).toBe('file');
  });

  test('does not attempt folder tabs when the viewer is unavailable', async () => {
    let statsCalled = false;

    const targetType = await resolveOpenTargetType('/tmp/dist', {
      canOpenFolderTabs: false,
      getStats: async () => {
        statsCalled = true;
        return { isDirectory: true };
      },
    });

    expect(targetType).toBe('file');
    expect(statsCalled).toBe(false);
  });

  test('falls back to file tabs if path inspection fails', async () => {
    const targetType = await resolveOpenTargetType('/tmp/dist', {
      canOpenFolderTabs: true,
      getStats: async () => {
        throw new Error('ENOENT');
      },
    });

    expect(targetType).toBe('file');
  });
});
