import { randomUUID } from 'node:crypto';
import type { OverlayFileContextItem } from '../shared/ipc.js';
import { toLocalBounds } from '../shared/scope.js';
import type { Bounds, DisplayInfo } from '../shared/types.js';

interface SelectionToolTextRecord {
  text: string;
  bounds: Bounds | null;
}

interface SelectionToolFileRecord {
  path: string;
  bounds: Bounds | null;
}

interface SelectionToolSnapshot {
  text: SelectionToolTextRecord | null;
  files: SelectionToolFileRecord[];
}

export interface OverlayFileContextSourceOptions {
  sourceKind?: OverlayFileContextItem['sourceKind'];
  sourceLabel?: string | null;
  sourceBounds?: Bounds | null;
  sourceDisplayId?: string | number | null;
}

export type NormalizeOverlayFileContextPaths = (
  filePaths: string[],
  sourceOptions?: OverlayFileContextSourceOptions,
) => Promise<OverlayFileContextItem[]>;

function isBounds(value: unknown): value is Bounds {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const bounds = value as Partial<Bounds>;
  return typeof bounds.x === 'number'
    && typeof bounds.y === 'number'
    && typeof bounds.width === 'number'
    && typeof bounds.height === 'number';
}

function readSelectionToolSnapshot(text: string): SelectionToolSnapshot {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Selection tool returned a non-object JSON payload.');
  }
  const record = parsed as { text?: unknown; files?: unknown };
  const textRecord = record.text && typeof record.text === 'object'
    ? record.text as { text?: unknown; bounds?: unknown }
    : null;
  const filesRecord = Array.isArray(record.files) ? record.files : [];

  return {
    text: typeof textRecord?.text === 'string' && textRecord.text.trim()
      ? {
          text: textRecord.text,
          bounds: isBounds(textRecord.bounds) ? textRecord.bounds : null,
        }
      : null,
    files: filesRecord
      .map((file): SelectionToolFileRecord | null => {
        if (!file || typeof file !== 'object') {
          return null;
        }
        const rawFile = file as { path?: unknown; bounds?: unknown };
        return typeof rawFile.path === 'string' && rawFile.path
          ? {
              path: rawFile.path,
              bounds: isBounds(rawFile.bounds) ? rawFile.bounds : null,
            }
          : null;
      })
      .filter((file): file is SelectionToolFileRecord => file !== null),
  };
}

export function createSelectedTextContextItem(
  text: string,
  sourceBounds: Bounds | null,
  sourceDisplayId: string | number | null,
): OverlayFileContextItem {
  const normalizedText = text.trim();
  const bytes = Buffer.from(normalizedText, 'utf8');
  return {
    id: `overlay-selected-text-${Date.now()}-${randomUUID()}`,
    kind: 'file',
    role: 'reference',
    name: 'Selected text.txt',
    mimeType: 'text/plain',
    sizeBytes: bytes.length,
    filePath: null,
    dataUrl: `data:text/plain;base64,${bytes.toString('base64')}`,
    sourceKind: 'selected-text',
    sourceLabel: 'Selected text',
    sourceBounds,
    sourceDisplayId,
  };
}

export async function buildOverlayContextItemsFromSelectionToolJson(
  selectionJson: string,
  display: DisplayInfo,
  normalizeFilePaths: NormalizeOverlayFileContextPaths,
): Promise<OverlayFileContextItem[]> {
  const selection = readSelectionToolSnapshot(selectionJson);
  const contextItems: OverlayFileContextItem[] = [];

  if (selection.text) {
    contextItems.push(createSelectedTextContextItem(
      selection.text.text,
      selection.text.bounds ? toLocalBounds(selection.text.bounds, display.boundsDIP) : null,
      display.id,
    ));
  }

  const seen = new Set<string>();
  for (const file of selection.files) {
    if (seen.has(file.path)) {
      continue;
    }
    seen.add(file.path);
    contextItems.push(...await normalizeFilePaths([file.path], {
      sourceKind: 'selected-file',
      sourceLabel: 'Selected file',
      sourceBounds: file.bounds ? toLocalBounds(file.bounds, display.boundsDIP) : null,
      sourceDisplayId: display.id,
    }));
  }

  return contextItems;
}
