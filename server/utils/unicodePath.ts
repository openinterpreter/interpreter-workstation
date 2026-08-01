import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Normalize Unicode characters to ASCII equivalents.
 * This handles cases where file/directory names contain "smart" characters
 * that look similar to ASCII but are different Unicode codepoints.
 */
export function normalizeUnicodeToAscii(text: string): string {
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u00A0/g, ' ')
    .replace(/[\u2012\u2212]/g, '-');
}

/**
 * Resolve the absolute root prefix for a path in a cross-platform-safe way.
 * This preserves Windows drive roots and UNC roots even when exercised off-platform.
 */
export function getPathResolutionRoot(inputPath: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(inputPath) || inputPath.startsWith('\\\\')) {
    return path.win32.parse(inputPath).root;
  }
  if (inputPath.startsWith('/')) {
    return path.posix.parse(inputPath).root;
  }
  return '';
}

/**
 * Resolve filesystem paths when the typed path differs only by Unicode normalization.
 */
export async function resolveUnicodePath(inputPath: string): Promise<string> {
  try {
    await fs.access(inputPath);
    return inputPath;
  } catch {
    // Fall through to component-by-component resolution.
  }

  const isAbsolute = path.isAbsolute(inputPath);
  const normalizedPath = path.normalize(inputPath);
  const root = isAbsolute ? getPathResolutionRoot(normalizedPath) : '';
  const remainder = root ? normalizedPath.slice(root.length) : normalizedPath;
  const components = remainder.split(path.sep).filter((component) => component !== '');

  let resolvedPath = isAbsolute ? (root || path.sep) : '';

  for (let index = 0; index < components.length; index += 1) {
    const component = components[index];
    const candidatePath = path.join(resolvedPath, component);

    try {
      await fs.access(candidatePath);
      resolvedPath = candidatePath;
      continue;
    } catch {
      // Fall through to Unicode-equivalent lookup.
    }

    try {
      const stats = await fs.stat(resolvedPath || '.');
      if (!stats.isDirectory()) {
        return inputPath;
      }
    } catch {
      return inputPath;
    }

    try {
      const normalizedComponent = normalizeUnicodeToAscii(component);
      const entries = await fs.readdir(resolvedPath || '.');
      let foundMatch = false;

      for (const entry of entries) {
        if (normalizeUnicodeToAscii(entry) !== normalizedComponent) {
          continue;
        }
        const actualPath = path.join(resolvedPath, entry);
        if (entry !== component) {
          console.log(`[resolveUnicodePath] Resolved Unicode mismatch: "${component}" -> "${entry}"`);
        }
        resolvedPath = actualPath;
        foundMatch = true;
        break;
      }

      if (!foundMatch) {
        return path.join(resolvedPath, ...components.slice(index));
      }
    } catch {
      return inputPath;
    }
  }

  return resolvedPath;
}
