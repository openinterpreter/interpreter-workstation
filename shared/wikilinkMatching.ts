function stripMarkdownFileExtension(name: string): string {
  return name.replace(/\.(md|markdown)$/i, '');
}

function normalizeWikilinkText(value: string): string {
  const lower = stripMarkdownFileExtension(value.trim()).toLowerCase();
  let normalized = '';
  let previousWasSeparator = true;

  for (const char of lower) {
    const isSeparator = char === '-' || char === '_' || char.trim() === '';
    if (isSeparator) {
      if (!previousWasSeparator) {
        normalized += ' ';
      }
      previousWasSeparator = true;
      continue;
    }

    normalized += char;
    previousWasSeparator = false;
  }

  return normalized.trim();
}

export function normalizeLooseWikilinkName(value: string): string {
  return normalizeWikilinkText(value);
}

export function normalizeLooseWikilinkSegments(segments: string[]): string {
  if (segments.length === 0) return '';

  const normalizedSegments = [...segments];
  const lastIndex = normalizedSegments.length - 1;
  normalizedSegments[lastIndex] = stripMarkdownFileExtension(normalizedSegments[lastIndex] ?? '');

  return normalizedSegments
    .map((segment) => normalizeWikilinkText(segment))
    .filter((segment) => segment.length > 0)
    .join('/');
}
