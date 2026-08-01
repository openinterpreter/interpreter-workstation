import type { OfficeSelection, OfficeSelectedObject, OfficeSelectionPrimitive } from '../../shared/types/workstation';

type OfficeSelectionPayload =
  | {
    kind: 'cell';
    cell?: string;
    range?: string;
    activeCell?: string;
    sheetIndex?: number;
    text?: string;
  }
  | {
    kind: 'text';
    text?: string;
    objects?: OfficeSelectedObject[];
  }
  | {
    kind: 'image' | 'object';
    objects?: OfficeSelectedObject[];
  }
  | { kind: 'empty' };

interface OfficeSelectionChangedMessage {
  type: 'ONLYOFFICE_SELECTION_CHANGED';
  filePath: string;
  filename: string;
  doctype: string;
  timestamp: number;
  selection: OfficeSelectionPayload;
}

export function mapOfficeExtensionSelectionMessage(
  message: unknown,
  currentFilePath: string,
): OfficeSelection | null | undefined {
  if (!isOfficeSelectionChangedMessage(message)) {
    return undefined;
  }

  if (message.filePath !== currentFilePath) {
    return undefined;
  }

  const base = {
    type: 'office' as const,
    filePath: message.filePath,
    filename: message.filename,
    doctype: message.doctype,
  };

  switch (message.selection.kind) {
    case 'empty':
      return null;
    case 'cell':
      return {
        ...base,
        kind: 'cell',
        cell: optionalString(message.selection.cell),
        range: optionalString(message.selection.range),
        activeCell: optionalString(message.selection.activeCell),
        sheetIndex: typeof message.selection.sheetIndex === 'number' ? message.selection.sheetIndex : undefined,
        text: optionalString(message.selection.text),
      };
    case 'text': {
      if (message.selection.text !== undefined && typeof message.selection.text !== 'string') {
        return undefined;
      }
      const objects = sanitizeSelectedObjects(message.selection.objects);
      return {
        ...base,
        kind: 'text',
        text: message.selection.text ?? '',
        ...(objects.length > 0 ? { objects } : {}),
      };
    }
    case 'image':
    case 'object':
      return {
        ...base,
        kind: message.selection.kind,
        objects: sanitizeSelectedObjects(message.selection.objects),
      };
  }
}

function sanitizeSelectedObjects(objects: unknown): OfficeSelectedObject[] {
  if (!Array.isArray(objects)) {
    return [];
  }

  const sanitized: OfficeSelectedObject[] = [];
  for (const object of objects) {
    if (!object || typeof object !== 'object' || Array.isArray(object)) {
      continue;
    }
    const record = object as Record<string, unknown>;
    sanitized.push({
      ...(isOfficeSelectionPrimitive(record.type) ? { type: record.type } : {}),
      ...(isOfficeSelectionPrimitive(record.value) ? { value: record.value } : {}),
      ...(isOfficeSelectionPrimitive(record.id) ? { id: record.id } : {}),
      ...(typeof record.imageUrl === 'string' ? { imageUrl: record.imageUrl } : {}),
      ...(typeof record.imageName === 'string' ? { imageName: record.imageName } : {}),
      ...(typeof record.hasImage === 'boolean' ? { hasImage: record.hasImage } : {}),
    });
  }
  return sanitized;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isOfficeSelectionPrimitive(value: unknown): value is OfficeSelectionPrimitive {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isOfficeSelectionChangedMessage(value: unknown): value is OfficeSelectionChangedMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const message = value as Partial<OfficeSelectionChangedMessage>;
  const kind = (message.selection as { kind?: unknown } | undefined)?.kind;
  return message.type === 'ONLYOFFICE_SELECTION_CHANGED'
    && typeof message.filePath === 'string'
    && typeof message.filename === 'string'
    && typeof message.doctype === 'string'
    && !!message.selection
    && typeof message.selection === 'object'
    && (kind === 'cell' || kind === 'text' || kind === 'image' || kind === 'object' || kind === 'empty');
}
