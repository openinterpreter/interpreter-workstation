import type { Tab } from '../../shared/types/layout';
import { pathBasename } from '@/ipc';
import {
  hasNativeFileDrag,
  isResolvedFileDrag,
  resolveFileDragData,
} from './fileDragData';
import { resolvePaneTabDragData } from './paneTabDrag';

export interface ComposerTabMentionData {
  id: string;
  label: string;
  itemType: 'file' | 'browser-tab';
  url?: string;
  faviconUrl?: string;
}

export interface ComposerFileDropData {
  filePath: string;
  fileName: string;
  isDirectory: boolean;
}

export function getComposerTabMentionData(tab: Tab | null | undefined): ComposerTabMentionData | null {
  if (!tab) return null;

  if (tab.type === 'file' && tab.path) {
    return {
      id: tab.path,
      label: tab.label || pathBasename(tab.path) || tab.path,
      itemType: 'file',
    };
  }

  if (tab.type === 'browser' && tab.browserId && tab.url) {
    return {
      id: tab.browserId,
      label: tab.label || tab.url,
      itemType: 'browser-tab',
      url: tab.url,
      faviconUrl: tab.faviconUrl,
    };
  }

  return null;
}

export function getComposerFileDropData(tab: Tab | null | undefined): ComposerFileDropData | null {
  if (!tab || tab.type !== 'file' || !tab.path) {
    return null;
  }

  return {
    filePath: tab.path,
    fileName: tab.label || pathBasename(tab.path) || tab.path,
    isDirectory: false,
  };
}

export function isComposerFileDrag(
  dataTransfer: Pick<DataTransfer, 'getData' | 'types'>,
  tabs: Record<string, Tab>,
): boolean {
  if (isResolvedFileDrag(dataTransfer)) {
    return true;
  }

  const paneTabDrag = resolvePaneTabDragData(dataTransfer);
  if (paneTabDrag && getComposerFileDropData(tabs[paneTabDrag.tabId])) {
    return true;
  }

  return hasNativeFileDrag(dataTransfer);
}

export function resolveComposerFileDropData(
  dataTransfer: Pick<DataTransfer, 'getData' | 'files' | 'types'>,
  tabs: Record<string, Tab>,
): ComposerFileDropData | null {
  const resolvedFileDrag = resolveFileDragData(dataTransfer);
  if (resolvedFileDrag) {
    return resolvedFileDrag;
  }

  const paneTabDrag = resolvePaneTabDragData(dataTransfer);
  if (paneTabDrag) {
    const fileDropData = getComposerFileDropData(tabs[paneTabDrag.tabId]);
    if (fileDropData) {
      return fileDropData;
    }
  }

  return null;
}
