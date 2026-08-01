import path from 'path';
import fs from 'fs/promises';
import { getConversionTargetsForPath } from '../../shared/utils/converterFormats';

export function getConversionTargets(filePath: string): string[] | null {
  return getConversionTargetsForPath(filePath);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Get unique filename: report.pdf → report (1).pdf → report (2).pdf */
export async function getUniqueOutputPath(dir: string, baseName: string, ext: string): Promise<string> {
  let outputPath = path.join(dir, `${baseName}.${ext}`);
  let counter = 1;
  while (await exists(outputPath)) {
    outputPath = path.join(dir, `${baseName} (${counter}).${ext}`);
    counter++;
  }
  return outputPath;
}
