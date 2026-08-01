import { useRef, useCallback } from 'react';
import { thumbnailCache } from '../components/explorer/thumbnailCache';
import { getFileThumbnails } from '@/ipc';

const SCROLL_DEBOUNCE_MS = 150;

interface UseViewportThumbnailsOptions {
  workspacePath: string | null;
}

export function useViewportThumbnails({ workspacePath: _workspacePath }: UseViewportThumbnailsOptions) {
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPathsRef = useRef<string[]>([]);
  const abortControllerRef = useRef<AbortController | null>(null);

  const loadThumbnails = useCallback(async (paths: string[]) => {
    const pathsToLoad = paths.filter(p =>
      !thumbnailCache.get(p) && !thumbnailCache.isLoading(p)
    );

    if (pathsToLoad.length === 0) return;

    abortControllerRef.current?.abort();
    abortControllerRef.current = new AbortController();

    pathsToLoad.forEach(p => thumbnailCache.markLoading(p));

    let thumbnails: Awaited<ReturnType<typeof getFileThumbnails>>['thumbnails'] | null = null;
    try {
      const response = await getFileThumbnails(pathsToLoad, 64);
      thumbnails = response.thumbnails;
    } catch (err) {
      console.error('[useViewportThumbnails] batch load failed:', err);
    }

    const wasAborted = abortControllerRef.current?.signal.aborted;
    if (wasAborted) {
      pathsToLoad.forEach(p => thumbnailCache.clearLoading(p));
      return;
    }

    if (thumbnails) {
      for (const [path, data] of Object.entries(thumbnails)) {
        if (data.dataUrl) {
          thumbnailCache.set(path, data.dataUrl);
        }
      }
    }

    pathsToLoad.forEach(p => thumbnailCache.clearLoading(p));
  }, []);

  const onVisiblePathsChange = useCallback((paths: string[]) => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    pendingPathsRef.current = paths;

    debounceTimerRef.current = setTimeout(() => {
      loadThumbnails(pendingPathsRef.current);
    }, SCROLL_DEBOUNCE_MS);
  }, [loadThumbnails]);

  return { onVisiblePathsChange };
}
