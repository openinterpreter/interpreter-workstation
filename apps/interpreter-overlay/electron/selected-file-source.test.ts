import { describe, expect, test } from 'bun:test';

import { isSelectedFileSourceApp } from './selected-file-source';

describe('selected file source gating', () => {
  test('imports selected files only when Finder is foreground on macOS', () => {
    expect(isSelectedFileSourceApp('darwin', { ownerName: 'Finder' })).toBe(true);
    expect(isSelectedFileSourceApp('darwin', { ownerName: 'Chromium' })).toBe(false);
    expect(isSelectedFileSourceApp('darwin', { ownerName: null })).toBe(false);
  });

  test('imports selected files only when File Explorer is foreground on Windows', () => {
    expect(isSelectedFileSourceApp('win32', { processName: 'explorer' })).toBe(true);
    expect(isSelectedFileSourceApp('win32', { processName: 'chrome' })).toBe(false);
    expect(isSelectedFileSourceApp('win32', { processName: null })).toBe(false);
  });
});
