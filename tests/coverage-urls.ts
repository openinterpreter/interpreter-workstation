import path from 'node:path';

type CoverageEntryLike = {
  url?: string;
};

type NormalizeCoverageFileUrlOptions = {
  cwd?: string;
  platform?: NodeJS.Platform;
};

function windowsPathToFileUrl(filePath: string): string {
  const normalizedPath = filePath.replace(/\\/g, '/');
  return `file:///${normalizedPath}`;
}

export function normalizeCoverageFileUrl(
  url: string,
  { cwd = process.cwd(), platform = process.platform }: NormalizeCoverageFileUrlOptions = {},
): string {
  let normalized = url.replace(/\\/g, '/');

  if (/^[A-Za-z]:\//.test(normalized)) {
    return `file:///${normalized}`;
  }

  if (/^file:\/\/\/[A-Za-z]:\//.test(normalized)) {
    return normalized;
  }

  if (/^file:\/\/[A-Za-z]:\//.test(normalized)) {
    return normalized.replace(/^file:\/\//, 'file:///');
  }

  if (/^file:\/[A-Za-z]:\//.test(normalized)) {
    return `file:///${normalized.slice('file:/'.length)}`;
  }

  if (/^file:[A-Za-z]:\//.test(normalized)) {
    return `file:///${normalized.slice('file:'.length)}`;
  }

  if (platform === 'win32') {
    const rootlessFileUrlMatch = normalized.match(/^file:\/\/\/([^?#]+)/);
    if (rootlessFileUrlMatch && !/^[A-Za-z]:\//.test(rootlessFileUrlMatch[1])) {
      return windowsPathToFileUrl(path.win32.resolve(cwd, rootlessFileUrlMatch[1]));
    }
  }

  return normalized;
}

export function normalizeCoverageEntries<T extends CoverageEntryLike>(entries: T[]): T[] {
  return entries.map((entry) => {
    if (typeof entry.url !== 'string') {
      return entry;
    }

    return {
      ...entry,
      url: normalizeCoverageFileUrl(entry.url),
    };
  });
}
