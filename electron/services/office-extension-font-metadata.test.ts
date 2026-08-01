import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  assertRequiredFontMetadata,
  getFontMetadataPaths,
  hasRequiredFontMetadata,
} from './office-extension-font-metadata';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'office-font-metadata-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('office-extension font metadata', () => {
  test('detects when required metadata is missing', () => {
    const fontDataDir = createTempDir();

    expect(hasRequiredFontMetadata(fontDataDir)).toBe(false);
    expect(() => assertRequiredFontMetadata(fontDataDir)).toThrow(
      'Required office font metadata is missing'
    );
  });

  test('requires both AllFonts.js and font_selection.bin', () => {
    const fontDataDir = createTempDir();
    const { allFontsPath } = getFontMetadataPaths(fontDataDir);

    writeFileSync(allFontsPath, '// font metadata');

    expect(hasRequiredFontMetadata(fontDataDir)).toBe(false);
    expect(() => assertRequiredFontMetadata(fontDataDir)).toThrow('font_selection.bin');
  });

  test('passes only when both required metadata files exist', () => {
    const fontDataDir = createTempDir();
    const { allFontsPath, fontSelectionPath } = getFontMetadataPaths(fontDataDir);

    writeFileSync(allFontsPath, '// font metadata');
    writeFileSync(fontSelectionPath, 'selection');

    expect(hasRequiredFontMetadata(fontDataDir)).toBe(true);
    expect(() => assertRequiredFontMetadata(fontDataDir)).not.toThrow();
  });
});
