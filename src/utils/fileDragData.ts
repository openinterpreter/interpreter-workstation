import { pathBasename } from '@/ipc';
import { parseDragData, isFileDragData, type FileDragData } from '../../shared/types/drag';
import { parseLocalLink } from './localLinkDetection';

export interface ResolvedFileDragData {
  filePath: string;
  fileName: string;
  isDirectory: boolean;
}

let activeFileDragData: FileDragData | null = null;
let activeFileDragHandled = false;

function logFileDrag(event: string, detail?: Record<string, unknown>): void {
  console.log('[file-drag-debug]', event, detail ?? {});
}

function toResolvedFileDragData(data: FileDragData): ResolvedFileDragData {
  return {
    filePath: data.filePath,
    fileName: data.fileName,
    isDirectory: data.isDirectory,
  };
}

function getUriListFileDragData(
  dataTransfer: Pick<DataTransfer, 'getData'>,
): ResolvedFileDragData | null {
  const uriList = dataTransfer.getData('text/uri-list');
  if (!uriList) {
    return null;
  }

  const firstUri = uriList
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('#'));
  if (!firstUri) {
    return null;
  }

  const parsed = parseLocalLink(firstUri);
  if (!parsed?.path) {
    return null;
  }

  return {
    filePath: parsed.path,
    fileName: pathBasename(parsed.path) || parsed.path,
    isDirectory: false,
  };
}

export function setActiveFileDragData(data: FileDragData): void {
  activeFileDragData = data;
  activeFileDragHandled = false;
  logFileDrag('setActiveFileDragData', {
    filePath: data.filePath,
    fileName: data.fileName,
    isDirectory: data.isDirectory,
    sourceContext: data.sourceContext,
  });
}

export function clearActiveFileDragData(): void {
  if (activeFileDragData) {
    logFileDrag('clearActiveFileDragData', {
      filePath: activeFileDragData.filePath,
      fileName: activeFileDragData.fileName,
      isDirectory: activeFileDragData.isDirectory,
      sourceContext: activeFileDragData.sourceContext,
    });
  } else {
    logFileDrag('clearActiveFileDragData:empty');
  }
  activeFileDragData = null;
  activeFileDragHandled = false;
}

export function getActiveFileDragData(): FileDragData | null {
  return activeFileDragData;
}

export function markActiveFileDragHandled(reason: string, detail?: Record<string, unknown>): void {
  activeFileDragHandled = true;
  logFileDrag('markActiveFileDragHandled', {
    reason,
    ...(detail ?? {}),
  });
}

export function wasActiveFileDragHandled(): boolean {
  return activeFileDragHandled;
}

export function hasNativeFileDrag(dataTransfer: Pick<DataTransfer, 'types'>): boolean {
  const types = Array.from(dataTransfer.types ?? []);
  return (
    types.includes('application/x-file-drag')
    || types.includes('Files')
    || types.includes('text/uri-list')
  );
}

export function isResolvedFileDrag(
  dataTransfer: Pick<DataTransfer, 'getData' | 'types'>,
): boolean {
  const jsonData = dataTransfer.getData('application/json');
  const dragData = parseDragData(jsonData);
  if (dragData && isFileDragData(dragData)) {
    return true;
  }

  if (activeFileDragData) {
    return true;
  }

  return hasNativeFileDrag(dataTransfer);
}

export function resolveFileDragData(
  dataTransfer: Pick<DataTransfer, 'getData' | 'files' | 'types'>,
): ResolvedFileDragData | null {
  const jsonData = dataTransfer.getData('application/json');
  const dragData = parseDragData(jsonData);
  if (dragData && isFileDragData(dragData)) {
    const resolved = toResolvedFileDragData(dragData);
    logFileDrag('resolveFileDragData:json', {
      filePath: resolved.filePath,
      fileName: resolved.fileName,
      isDirectory: resolved.isDirectory,
      types: Array.from(dataTransfer.types ?? []),
    });
    return resolved;
  }

  if (activeFileDragData) {
    const resolved = toResolvedFileDragData(activeFileDragData);
    logFileDrag('resolveFileDragData:active', {
      filePath: resolved.filePath,
      fileName: resolved.fileName,
      isDirectory: resolved.isDirectory,
      types: Array.from(dataTransfer.types ?? []),
    });
    return resolved;
  }

  const droppedFile = dataTransfer.files?.[0] as (File & { path?: string }) | undefined;
  const droppedFilePath = droppedFile?.path || (droppedFile ? window.electron?.getPathForFile?.(droppedFile) : undefined);
  if (droppedFilePath) {
    const resolved = {
      filePath: droppedFilePath,
      fileName: droppedFile?.name || pathBasename(droppedFilePath) || droppedFilePath,
      isDirectory: false,
    };
    logFileDrag('resolveFileDragData:native', {
      filePath: resolved.filePath,
      fileName: resolved.fileName,
      types: Array.from(dataTransfer.types ?? []),
    });
    return resolved;
  }

  const uriResolved = getUriListFileDragData(dataTransfer);
  if (uriResolved) {
    logFileDrag('resolveFileDragData:uri-list', {
      filePath: uriResolved.filePath,
      fileName: uriResolved.fileName,
      types: Array.from(dataTransfer.types ?? []),
    });
  } else {
    logFileDrag('resolveFileDragData:none', {
      types: Array.from(dataTransfer.types ?? []),
    });
  }
  return uriResolved;
}
