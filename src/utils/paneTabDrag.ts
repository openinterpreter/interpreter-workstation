import type { Tab } from '../../shared/types/layout';
import { getActiveFileDragData } from './fileDragData';

export interface PaneTabDragData {
  type: 'pane-tab';
  tabId: string;
  sourcePaneId?: string;
  sourceIndex?: number;
  sourceWindowSessionKey?: string;
  tab?: Tab;
  sidebarMeta?: Record<string, unknown>;
}

export function createPaneTabDragData(
  data: Omit<PaneTabDragData, 'type' | 'sourceWindowSessionKey'>,
): PaneTabDragData {
  return {
    type: 'pane-tab',
    ...data,
    sourceWindowSessionKey: window.electron?.getWindowSessionKey?.() ?? undefined,
  };
}

let activePaneTabDragData: PaneTabDragData | null = null;

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

export function parsePaneTabDragData(jsonStr: string): PaneTabDragData | null {
  if (!jsonStr) return null;

  try {
    const data: unknown = JSON.parse(jsonStr);
    if (
      typeof data !== 'object'
      || data === null
      || (data as { type?: unknown }).type !== 'pane-tab'
      || typeof (data as { tabId?: unknown }).tabId !== 'string'
    ) {
      return null;
    }

    const sourcePaneId = readOptionalString((data as { sourcePaneId?: unknown }).sourcePaneId);
    const sourceIndex = readOptionalNumber((data as { sourceIndex?: unknown }).sourceIndex);
    const sourceWindowSessionKey = readOptionalString((data as { sourceWindowSessionKey?: unknown }).sourceWindowSessionKey);
    const rawTab = (data as { tab?: unknown }).tab;
    const tab = typeof rawTab === 'object' && rawTab !== null
      ? rawTab as Tab
      : undefined;
    const rawSidebarMeta = (data as { sidebarMeta?: unknown }).sidebarMeta;
    const sidebarMeta = typeof rawSidebarMeta === 'object' && rawSidebarMeta !== null
      ? rawSidebarMeta as Record<string, unknown>
      : undefined;

    return {
      type: 'pane-tab',
      tabId: (data as { tabId: string }).tabId,
      ...(sourcePaneId !== undefined ? { sourcePaneId } : {}),
      ...(sourceIndex !== undefined ? { sourceIndex } : {}),
      ...(sourceWindowSessionKey !== undefined ? { sourceWindowSessionKey } : {}),
      ...(tab !== undefined ? { tab } : {}),
      ...(sidebarMeta !== undefined ? { sidebarMeta } : {}),
    };
  } catch {
    return null;
  }
}

export function setActivePaneTabDragData(data: PaneTabDragData): void {
  activePaneTabDragData = data;
}

export function clearActivePaneTabDragData(): void {
  activePaneTabDragData = null;
}

export function getActivePaneTabDragData(): PaneTabDragData | null {
  return activePaneTabDragData;
}

export function resolvePaneTabDragData(
  dataTransfer: Pick<DataTransfer, 'getData' | 'types'>,
): PaneTabDragData | null {
  const jsonData = dataTransfer.getData('application/json');
  const parsedDragData = parsePaneTabDragData(jsonData);
  if (parsedDragData) {
    return parsedDragData;
  }

  if (jsonData) {
    return null;
  }

  const dragTypes = Array.from(dataTransfer.types ?? []);
  if (
    getActiveFileDragData()
    ||
    dragTypes.includes('application/x-file-drag')
    || dragTypes.includes('Files')
    || dragTypes.includes('text/uri-list')
  ) {
    return null;
  }

  return activePaneTabDragData;
}
