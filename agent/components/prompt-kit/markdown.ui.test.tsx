import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Markdown } from './markdown';
import { MENTION_PREVIEW_DELAY_MS, MENTION_PREVIEW_START_EVENT, type MentionPreviewDetail } from '../../../shared/types/mentionPreview';
import { clearFileCache } from '../../../src/stores/fileStore';
import { resetWorkspaceStoreForTests, setWorkspacePathSnapshot } from '../../../src/stores/workspaceStore';
import { resetResolvedWikilinkCacheForTests } from '../../../src/hooks/useResolvedWikilink';

const apiMocks = vi.hoisted(() => ({
  resolveWikilink: vi.fn(),
}));

const ipcMocks = vi.hoisted(() => ({
  openExternal: vi.fn(),
  showContextMenu: vi.fn(),
  showItemInFolder: vi.fn(),
  getFileThumbnails: vi.fn(),
}));

vi.mock('../../../src/api', () => ({
  resolveWikilink: apiMocks.resolveWikilink,
}));

vi.mock('../../../src/ipc', () => ({
  openExternal: ipcMocks.openExternal,
  getRuntimeSystemInfo: () => ({ platform: 'darwin' }),
  showContextMenu: ipcMocks.showContextMenu,
  showItemInFolder: ipcMocks.showItemInFolder,
  getFileThumbnails: ipcMocks.getFileThumbnails,
  pathBasename: (value: string) => value.split(/[/\\]/).pop() || value,
  pathDirname: (value: string) => {
    const parts = value.split(/[/\\]/);
    parts.pop();
    return parts.join('/') || '/';
  },
  pathJoin: (...parts: string[]) => parts.join('/').replace(/\/+/g, '/'),
  pathSplit: (value: string) => value.split(/[/\\]+/).filter(Boolean),
  pathStartsWith: (fullPath: string, prefixPath: string) => {
    const normalizedFull = fullPath.replace(/\\/g, '/');
    const normalizedPrefix = prefixPath.replace(/\\/g, '/').replace(/\/+$/, '');
    return normalizedFull === normalizedPrefix || normalizedFull.startsWith(`${normalizedPrefix}/`);
  },
  pathStripPrefix: (fullPath: string, prefixPath: string) => {
    const normalizedFull = fullPath.replace(/\\/g, '/');
    const normalizedPrefix = prefixPath.replace(/\\/g, '/').replace(/\/+$/, '');
    if (normalizedFull === normalizedPrefix) {
      return '';
    }
    return normalizedFull.startsWith(`${normalizedPrefix}/`)
      ? normalizedFull.slice(normalizedPrefix.length + 1)
      : normalizedFull;
  },
}));

vi.mock('../../../src/components/FileSystemProxy', () => ({
  FileSystemProxy: ({
    path,
    filename,
    onClick,
  }: {
    path?: string;
    filename?: string;
    onClick?: () => void;
  }) => (
    <button type="button" data-path={path} onClick={onClick}>
      {filename}
    </button>
  ),
}));

describe('assistant markdown wikilinks', () => {
  beforeEach(() => {
    apiMocks.resolveWikilink.mockReset();
    ipcMocks.openExternal.mockReset();
    ipcMocks.showContextMenu.mockReset();
    ipcMocks.showItemInFolder.mockReset();
    ipcMocks.getFileThumbnails.mockReset();
    ipcMocks.getFileThumbnails.mockResolvedValue({ thumbnails: {} });
    clearFileCache();
    resetWorkspaceStoreForTests();
    resetResolvedWikilinkCacheForTests();
    setWorkspacePathSnapshot('/workspace');
  });

  afterEach(() => {
    clearFileCache();
    resetWorkspaceStoreForTests();
    resetResolvedWikilinkCacheForTests();
  });

  test('resolve to a real file path and emit the same hover preview events as file mentions', async () => {
    apiMocks.resolveWikilink.mockResolvedValue({
      path: '/workspace/wiki/persistent-wiki.md',
    });

    const hoverDetails: Array<{ path?: string }> = [];
    const previewDetails: MentionPreviewDetail[] = [];
    const handleHoverStart = (event: Event) => {
      hoverDetails.push((event as CustomEvent<{ path?: string }>).detail);
    };
    const handlePreviewStart = (event: Event) => {
      previewDetails.push((event as CustomEvent<MentionPreviewDetail>).detail);
    };

    window.addEventListener('mention:hover-start', handleHoverStart);
    window.addEventListener(MENTION_PREVIEW_START_EVENT, handlePreviewStart);

    try {
      const { container } = render(<Markdown>See [[Persistent Wiki]] now.</Markdown>);

      const mention = await waitFor(() => {
        const nextMention = container.querySelector('.mention-node-view');
        expect(nextMention).toBeTruthy();
        return nextMention as HTMLElement;
      });

      const proxyBeforeHover = mention.querySelector('[data-path]');
      expect(proxyBeforeHover).toHaveAttribute('data-path', '/workspace/Persistent Wiki.md');
      expect(apiMocks.resolveWikilink).not.toHaveBeenCalled();

      expect(mention).not.toHaveAttribute('data-dangling');

      fireEvent.mouseEnter(mention);

      await waitFor(() => {
        expect(apiMocks.resolveWikilink).toHaveBeenCalledWith('Persistent Wiki');
        const proxy = mention.querySelector('[data-path]');
        expect(proxy).toHaveAttribute('data-path', '/workspace/wiki/persistent-wiki.md');
      });

      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, MENTION_PREVIEW_DELAY_MS + 60));
      });

      await waitFor(() => {
        expect(hoverDetails[0]?.path).toBe('/workspace/wiki/persistent-wiki.md');
        expect(previewDetails[0]?.path).toBe('/workspace/wiki/persistent-wiki.md');
      });
    } finally {
      window.removeEventListener('mention:hover-start', handleHoverStart);
      window.removeEventListener(MENTION_PREVIEW_START_EVENT, handlePreviewStart);
    }
  });

  test('reveals local markdown images from their context menu', async () => {
    ipcMocks.showContextMenu.mockResolvedValueOnce('reveal');

    const { getByRole } = render(<Markdown>![Screenshot](/tmp/screenshot.png)</Markdown>);

    fireEvent.contextMenu(getByRole('img', { name: 'Screenshot' }));

    await waitFor(() => {
      expect(ipcMocks.showContextMenu).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ action: 'reveal', label: 'Reveal in Finder' }),
        ]),
        'markdown_image',
      );
      expect(ipcMocks.showItemInFolder).toHaveBeenCalledWith('/tmp/screenshot.png');
    });
  });

  test('reveals rich file preview rows from their context menu', async () => {
    ipcMocks.showContextMenu.mockResolvedValueOnce('reveal');

    const { container } = render(<Markdown>{'- [screenshot.png](/tmp/screenshot.png) - preview image'}</Markdown>);
    const previewRow = await waitFor(() => {
      const row = container.querySelector('button[title="screenshot.png"]');
      expect(row).toBeTruthy();
      return row as HTMLElement;
    });

    fireEvent.contextMenu(previewRow);

    await waitFor(() => {
      expect(ipcMocks.showContextMenu).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ action: 'reveal', label: 'Reveal in Finder' }),
        ]),
        'markdown_file_preview',
      );
      expect(ipcMocks.showItemInFolder).toHaveBeenCalledWith('/tmp/screenshot.png');
    });
  });
});
