export interface TypingTargetElement {
  id: string;
  role: string;
  label: string;
  bbox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

function normalizeLabel(label: string): string {
  return String(label || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function isTextEntryRole(role: string): boolean {
  return [
    'AXTextField',
    'AXTextArea',
    'AXSearchField',
    'AXSecureTextField',
    'AXDateField',
    'AXTimeField',
  ].includes(role);
}

export function isLikelyFieldLabel(element: TypingTargetElement): boolean {
  return normalizeLabel(element.label).endsWith(':');
}

export function resolveTypingTarget<T extends TypingTargetElement>(
  elements: Iterable<T>,
  element: T,
): T {
  if (!isLikelyFieldLabel(element)) {
    return element;
  }

  const labelCenterY = element.bbox.y + (element.bbox.height / 2);
  const minimumTargetX = element.bbox.x + Math.max(24, element.bbox.width * 0.6);
  let bestCandidate: T | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const candidate of elements) {
    if (candidate.id === element.id) {
      continue;
    }

    if (!isTextEntryRole(candidate.role) || isLikelyFieldLabel(candidate)) {
      continue;
    }

    const candidateCenterY = candidate.bbox.y + (candidate.bbox.height / 2);
    const verticalDistance = Math.abs(candidateCenterY - labelCenterY);
    if (verticalDistance > Math.max(36, element.bbox.height)) {
      continue;
    }

    if (candidate.bbox.x < minimumTargetX) {
      continue;
    }

    const horizontalDistance = candidate.bbox.x - minimumTargetX;
    const score = (verticalDistance * 4) + horizontalDistance;
    if (score < bestScore) {
      bestScore = score;
      bestCandidate = candidate;
    }
  }

  return bestCandidate ?? element;
}
