function stripMarkdownFileExtension(name: string): string {
  return name.replace(/\.(md|markdown)$/i, '');
}

export function hasMarkdownFileExtension(name: string): boolean {
  const lowerName = name.toLowerCase();
  return lowerName.endsWith('.md') || lowerName.endsWith('.markdown');
}

export function splitWikilinkTarget(target: string): string[] {
  return target.split(/[\\/]/).filter(Boolean);
}

export function getWikilinkBasename(target: string): string {
  const segments = splitWikilinkTarget(target);
  return segments[segments.length - 1] || target;
}

export function getWikilinkTargetCandidates(target: string): string[] {
  const trimmedTarget = target.trim();
  if (!trimmedTarget) {
    return [];
  }

  if (hasMarkdownFileExtension(trimmedTarget)) {
    return [trimmedTarget];
  }

  return [`${trimmedTarget}.md`, `${trimmedTarget}.markdown`, trimmedTarget];
}

export function normalizeExactWikilinkRelativeTarget(target: string): string {
  const segments = splitWikilinkTarget(target);
  if (segments.length === 0) {
    return '';
  }

  const normalizedSegments = [...segments];
  const lastIndex = normalizedSegments.length - 1;
  const lastSegment = normalizedSegments[lastIndex] || '';
  normalizedSegments[lastIndex] = hasMarkdownFileExtension(lastSegment)
    ? stripMarkdownFileExtension(lastSegment)
    : lastSegment;

  return normalizedSegments.map((segment) => segment.toLowerCase()).join('/');
}
