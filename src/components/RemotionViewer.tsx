import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { REMOTION_VIEWER_ID } from '../../shared/element-ids';
import { readFile } from '../api';
import { remotion } from '@/ipc';
import { useFileRefresh } from '../hooks/useFileRefresh';
import { clearNativeDropTargetBounds, setNativeDropTargetBounds } from '../utils/nativeDropTargets';

interface RemotionViewerProps {
  filePath: string;
  refreshKey?: number;
}

type ViewerState =
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  | { status: 'error'; message: string };

export function RemotionViewer({ filePath, refreshKey = 0 }: RemotionViewerProps) {
  const [state, setState] = useState<ViewerState>({ status: 'loading' });
  const [revision, setRevision] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const nativeDropTargetId = useMemo(() => `remotion:${filePath}`, [filePath]);

  const bootStudio = useCallback(async () => {
    setState({ status: 'loading' });
    let result: Awaited<ReturnType<typeof remotion.openProject>> | null = null;
    try {
      const manifest = await readFile(filePath);
      JSON.parse(manifest.content);

      result = await remotion.openProject(filePath);
    } catch (error: any) {
      setState({ status: 'error', message: error.message || 'Failed to start Remotion Studio' });
      return;
    }

    if (!result.success || !result.url) {
      setState({ status: 'error', message: result.error || 'Failed to start Remotion Studio' });
      return;
    }

    setState({ status: 'ready', url: result.url });
  }, [filePath]);

  useEffect(() => {
    void bootStudio();
  }, [bootStudio, refreshKey, revision]);

  useFileRefresh(filePath, () => setRevision((current) => current + 1));

  useEffect(() => {
    if (state.status !== 'ready') {
      clearNativeDropTargetBounds(nativeDropTargetId);
      return;
    }
    if (!containerRef.current) {
      return;
    }

    const updateBounds = () => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const top = rect.top + (rect.height * 2 / 3);
      const dropRect = DOMRect.fromRect({
        x: rect.left,
        y: top,
        width: rect.width,
        height: rect.height / 3,
      });
      setNativeDropTargetBounds(nativeDropTargetId, dropRect);
    };

    updateBounds();
    const resizeObserver = new ResizeObserver(updateBounds);
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      clearNativeDropTargetBounds(nativeDropTargetId);
    };
  }, [state.status, nativeDropTargetId]);

  const iframeUrl = useMemo(() => {
    if (state.status !== 'ready') {
      return '';
    }
    const stamp = Date.now();
    return `${state.url}?viewer=interpreter&t=${stamp}`;
  }, [state]);

  if (state.status === 'loading') {
    return (
      <div id={REMOTION_VIEWER_ID} data-testid={REMOTION_VIEWER_ID} className="h-full w-full flex items-center justify-center text-muted-foreground">
        Starting Remotion Studio...
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div id={REMOTION_VIEWER_ID} data-testid={REMOTION_VIEWER_ID} className="h-full w-full flex items-center justify-center px-8">
        <div className="text-center">
          <div className="text-ui-base font-medium text-foreground mb-2">Remotion failed to start</div>
          <div className="text-ui-sm text-muted-foreground whitespace-pre-wrap">{state.message}</div>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} id={REMOTION_VIEWER_ID} data-testid={REMOTION_VIEWER_ID} className="h-full w-full bg-background relative">
      <iframe
        src={iframeUrl}
        title="Remotion Studio"
        className="h-full w-full border-0"
      />
    </div>
  );
}
