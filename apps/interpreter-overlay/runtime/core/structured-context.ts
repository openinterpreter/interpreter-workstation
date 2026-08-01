import type { ScreenElement } from '../infra/ocr-segmentation/index.js';

const MODEL_INTERACTIVE_ELEMENT_ROLES = new Set<string>([
  'AXButton',
  'AXTextField',
  'AXTextArea',
  'AXSearchField',
  'AXSecureTextField',
  'AXComboBox',
  'AXPopUpButton',
  'AXMenuItem',
  'AXMenuBarItem',
  'AXMenuButton',
  'AXCheckBox',
  'AXRadioButton',
  'AXLink',
  'AXSlider',
  'AXDateField',
  'AXTimeField',
]);

const OVERLAY_SHEEN_CONTAINER_ROLES = new Set<string>([
  'AXLayoutArea',
  'AXScrollArea',
  'AXWebArea',
  'AXToolbar',
  'AXSplitGroup',
  'AXTabGroup',
  'AXList',
  'AXOutline',
  'AXTable',
]);

function normalizeDescription(value: string | undefined): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export function isModelInteractiveElementRole(role: string): boolean {
  return MODEL_INTERACTIVE_ELEMENT_ROLES.has(role);
}

export function isOverlayScopeSheenElementRole(role: string): boolean {
  return MODEL_INTERACTIVE_ELEMENT_ROLES.has(role) || OVERLAY_SHEEN_CONTAINER_ROLES.has(role);
}

export function ensureUniqueElementIds(elements: ScreenElement[]): ScreenElement[] {
  const seenIds = new Map<string, number>();

  return elements.map((element, index) => {
    const rawId = String(element.id || '').trim();
    if (!rawId) {
      return element;
    }

    const seenCount = seenIds.get(rawId) ?? 0;
    seenIds.set(rawId, seenCount + 1);

    if (seenCount === 0) {
      return element;
    }

    const labelSlug = normalizeDescription(element.label)
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return {
      ...element,
      id: `${rawId}__${labelSlug || 'duplicate'}_${seenCount}_${index}`,
    };
  });
}

export function rewriteFormattedTextIds(
  formattedText: string,
  originalElements: ScreenElement[],
  dedupedElements: ScreenElement[],
): string {
  const replacements = new Map<string, string[]>();

  for (let index = 0; index < originalElements.length; index += 1) {
    const rawId = String(originalElements[index]?.id || '').trim();
    const dedupedId = String(dedupedElements[index]?.id || '').trim();
    if (!rawId || !dedupedId) {
      continue;
    }

    const bucket = replacements.get(rawId) ?? [];
    bucket.push(dedupedId);
    replacements.set(rawId, bucket);
  }

  if (replacements.size === 0) {
    return formattedText;
  }

  const seenCounts = new Map<string, number>();
  return formattedText.replace(/id="([^"]+)"/g, (match, rawId: string) => {
    const bucket = replacements.get(rawId);
    if (!bucket || bucket.length === 0) {
      return match;
    }

    const nextIndex = seenCounts.get(rawId) ?? 0;
    seenCounts.set(rawId, nextIndex + 1);
    const rewrittenId = bucket[Math.min(nextIndex, bucket.length - 1)] ?? rawId;
    return `id="${rewrittenId}"`;
  });
}

export function normalizeStructuredContext(
  formattedText: string,
  elements: ScreenElement[],
): { formattedText: string; elements: ScreenElement[] } {
  const interactiveElements = elements.filter((element) => isModelInteractiveElementRole(element.role));
  const dedupedElements = ensureUniqueElementIds(interactiveElements);
  return {
    formattedText: rewriteFormattedTextIds(formattedText, interactiveElements, dedupedElements),
    elements: dedupedElements,
  };
}

export function filterOverlayScopeSheenElements(elements: ScreenElement[]): ScreenElement[] {
  return elements.filter((element) => isOverlayScopeSheenElementRole(element.role));
}
