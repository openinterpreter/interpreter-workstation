import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createElement, useEffect } from 'react';
import { useViewportThumbnails } from './useViewportThumbnails';
import { thumbnailCache } from '../components/explorer/thumbnailCache';

const ipcMocks = vi.hoisted(() => ({
  getFileThumbnails: vi.fn(),
}));

vi.mock('@/ipc', () => ({
  getFileThumbnails: ipcMocks.getFileThumbnails,
  pathBasename: (filePath: string) => {
    const parts = filePath.split(/[\\/]/);
    return parts[parts.length - 1] || filePath;
  },
}));

function TestViewportThumbnails({ paths }: { paths: string[] }) {
  const { onVisiblePathsChange } = useViewportThumbnails({ workspacePath: '/workspace' });

  useEffect(() => {
    onVisiblePathsChange(paths);
  }, [onVisiblePathsChange, paths]);

  return null;
}

describe('useViewportThumbnails', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    thumbnailCache.clear();
    ipcMocks.getFileThumbnails.mockReset();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    thumbnailCache.clear();
  });

  test('caches icon-backed thumbnails so ordinary files are not refetched', async () => {
    const filePath = '/workspace/config.json';
    const iconUrl = 'data:image/png;base64,icon';
    ipcMocks.getFileThumbnails.mockResolvedValue({
      thumbnails: {
        [filePath]: {
          dataUrl: iconUrl,
          width: 32,
          height: 32,
          kind: 'icon',
        },
      },
    });

    const { rerender } = render(createElement(TestViewportThumbnails, { paths: [filePath] }));

    await act(async () => {
      vi.advanceTimersByTime(150);
      await Promise.resolve();
    });

    expect(ipcMocks.getFileThumbnails).toHaveBeenCalledTimes(1);
    expect(thumbnailCache.get(filePath)).toBe(iconUrl);

    rerender(createElement(TestViewportThumbnails, { paths: [filePath] }));

    await act(async () => {
      vi.advanceTimersByTime(150);
      await Promise.resolve();
    });

    expect(ipcMocks.getFileThumbnails).toHaveBeenCalledTimes(1);
  });
});
