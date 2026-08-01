import { describe, expect, test } from 'bun:test';
import { normalizeCoverageEntries, normalizeCoverageFileUrl } from './coverage-urls';

describe('normalizeCoverageFileUrl', () => {
  const windowsOptions = {
    cwd: 'C:\\repo',
    platform: 'win32' as const,
  };

  test('normalizes malformed Windows drive file URLs', () => {
    expect(normalizeCoverageFileUrl('C:\\repo\\dist\\index.js', windowsOptions)).toBe('file:///C:/repo/dist/index.js');
    expect(normalizeCoverageFileUrl('C:/repo/dist/index.js', windowsOptions)).toBe('file:///C:/repo/dist/index.js');
    expect(normalizeCoverageFileUrl('file://C:/repo/dist/index.js', windowsOptions)).toBe('file:///C:/repo/dist/index.js');
    expect(normalizeCoverageFileUrl('file:/C:/repo/dist/index.js', windowsOptions)).toBe('file:///C:/repo/dist/index.js');
    expect(normalizeCoverageFileUrl('file:C:/repo/dist/index.js', windowsOptions)).toBe('file:///C:/repo/dist/index.js');
    expect(normalizeCoverageFileUrl('file://C:\\repo\\dist\\index.js', windowsOptions)).toBe('file:///C:/repo/dist/index.js');
  });

  test('leaves already-correct file URLs untouched', () => {
    expect(normalizeCoverageFileUrl('file:///C:/repo/dist/index.js')).toBe('file:///C:/repo/dist/index.js');
    expect(normalizeCoverageFileUrl('https://example.com/app.js.map')).toBe('https://example.com/app.js.map');
  });

  test('resolves rootless Windows file URLs against the repo when the file exists', () => {
    expect(
      normalizeCoverageFileUrl('file:///src/App.tsx', {
        cwd: 'C:\\repo',
        platform: 'win32',
      }),
    ).toBe('file:///C:/repo/src/App.tsx');
  });

  test('resolves rootless Windows file URLs even when the target file does not exist yet', () => {
    expect(
      normalizeCoverageFileUrl('file:///dist/assets/index.js.map', windowsOptions),
    ).toBe('file:///C:/repo/dist/assets/index.js.map');
  });

  test('normalizes coverage entries without mutating non-url fields', () => {
    const entries = normalizeCoverageEntries([
      { url: 'file://C:/repo/dist/index.js', text: 'source' },
      { text: 'no-url' },
    ]);

    expect(entries).toEqual([
      { url: 'file:///C:/repo/dist/index.js', text: 'source' },
      { text: 'no-url' },
    ]);
  });
});
