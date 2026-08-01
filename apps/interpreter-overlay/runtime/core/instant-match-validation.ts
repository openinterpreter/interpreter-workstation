import type { ScreenElement } from '../infra/ocr-segmentation/index.js';

type ActionTool = 'click' | 'type';

interface InstantMatchValidationParams {
  actionTool: ActionTool;
  sourceElement: Pick<ScreenElement, 'role' | 'label' | 'bbox'>;
  matchedElement: Pick<ScreenElement, 'role' | 'label' | 'bbox'>;
  elementDescription?: string;
}

const EDITABLE_ROLES = new Set([
  'AXTextField',
  'AXTextArea',
  'AXSearchField',
  'AXSecureTextField',
  'AXDateField',
  'AXTimeField',
]);

const TYPEABLE_SHELL_ROLES = new Set([
  'AXComboBox',
]);

function normalizeText(value: string | undefined): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

const GENERIC_TOKENS = new Set([
  'field',
  'input',
  'box',
  'button',
  'dropdown',
  'option',
  'entry',
  'area',
]);

const VALIDATION_TOKENS = new Set([
  'should',
  'must',
  'cannot',
  'can',
  'be',
  'letters',
  'letter',
  'digits',
  'digit',
  'numbers',
  'number',
  'spaces',
  'space',
  'characters',
  'character',
  'optional',
  'required',
  'valid',
  'invalid',
  'only',
  'enter',
  'please',
  'use',
  'or',
  'and',
]);

function semanticTokens(value: string): string[] {
  return tokenize(value).filter((token) => {
    if (GENERIC_TOKENS.has(token) || VALIDATION_TOKENS.has(token)) {
      return false;
    }
    return !/^\d+$/.test(token);
  });
}

function labelsCompatible(description: string, label: string): boolean {
  const normalizedDescription = normalizeText(description);
  const normalizedLabel = normalizeText(label);

  if (!normalizedDescription || !normalizedLabel) {
    return false;
  }

  if (
    normalizedDescription === normalizedLabel ||
    normalizedDescription.includes(normalizedLabel) ||
    normalizedLabel.includes(normalizedDescription)
  ) {
    return true;
  }

  const descriptionTokens = new Set(tokenize(normalizedDescription));
  const labelTokens = tokenize(normalizedLabel);
  if (descriptionTokens.size === 0 || labelTokens.length === 0) {
    return false;
  }

  const overlap = labelTokens.filter((token) => descriptionTokens.has(token)).length;
  if (overlap >= Math.max(1, Math.ceil(labelTokens.length / 2))) {
    return true;
  }

  const descriptionSemantic = semanticTokens(normalizedDescription);
  const labelSemantic = new Set(semanticTokens(normalizedLabel));
  if (descriptionSemantic.length > 0 && descriptionSemantic.every((token) => labelSemantic.has(token))) {
    return true;
  }

  return false;
}

function isGenericLabel(label: string): boolean {
  const normalized = normalizeText(label);
  return (
    normalized === ''
    || normalized === 'input'
    || normalized === 'text field'
    || normalized === 'text area'
    || normalized === 'combo box'
    || normalized === 'combobox'
    || normalized === 'field'
  );
}

export function getInstantMatchRejectionReason(
  params: InstantMatchValidationParams,
): string | null {
  const normalizedDescription = normalizeText(params.elementDescription);
  const labels = [params.sourceElement.label, params.matchedElement.label]
    .map((label) => normalizeText(label))
    .filter((label, index, all) => label && all.indexOf(label) === index);
  const labelSummary = labels[0] || params.matchedElement.role;

  if (
    params.actionTool === 'type'
    && !EDITABLE_ROLES.has(params.matchedElement.role)
    && !TYPEABLE_SHELL_ROLES.has(params.matchedElement.role)
  ) {
    return `Unsafe instant match: type target "${labelSummary}" resolves to ${params.matchedElement.role}, not an editable field.`;
  }

  if (!normalizedDescription) {
    return null;
  }

  if (
    params.sourceElement.role === params.matchedElement.role
    && params.sourceElement.bbox.x === params.matchedElement.bbox.x
    && params.sourceElement.bbox.y === params.matchedElement.bbox.y
    && params.sourceElement.bbox.width === params.matchedElement.bbox.width
    && params.sourceElement.bbox.height === params.matchedElement.bbox.height
    && labels.every((label) => isGenericLabel(label))
  ) {
    return null;
  }

  const descriptionMatchesLabel = labels.some((label) =>
    labelsCompatible(normalizedDescription, label),
  );

  if (!descriptionMatchesLabel && labels.length > 0) {
    return `Unsafe instant match: "${normalizedDescription}" does not match target "${labelSummary}".`;
  }

  return null;
}
