import { existsSync } from 'fs';
import { join } from 'path';

export interface OfficeExtensionFontMetadataPaths {
  allFontsPath: string;
  fontSelectionPath: string;
}

export function getFontMetadataPaths(fontDataDir: string): OfficeExtensionFontMetadataPaths {
  return {
    allFontsPath: join(fontDataDir, 'AllFonts.js'),
    fontSelectionPath: join(fontDataDir, 'font_selection.bin'),
  };
}

export function hasRequiredFontMetadata(fontDataDir: string): boolean {
  const { allFontsPath, fontSelectionPath } = getFontMetadataPaths(fontDataDir);
  return existsSync(allFontsPath) && existsSync(fontSelectionPath);
}

export function assertRequiredFontMetadata(fontDataDir: string): void {
  const { allFontsPath, fontSelectionPath } = getFontMetadataPaths(fontDataDir);
  const missingPaths = [allFontsPath, fontSelectionPath].filter((path) => !existsSync(path));

  if (missingPaths.length > 0) {
    throw new Error(`Required office font metadata is missing: ${missingPaths.join(', ')}`);
  }
}
