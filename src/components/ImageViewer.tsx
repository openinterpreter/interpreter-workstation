import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { IMAGE_VIEWER_ID } from '../../shared/element-ids';
import { Button } from './ui/button';
import { getFileUrl, pathBasename } from '@/ipc';
import { openFeedbackPopover } from '../utils/feedback';
import { useFileRefresh } from '../hooks/useFileRefresh';
import { EditorShell, EditorToolbar, EditorContentSurface } from './EditorShell';

interface ImageViewerProps {
  filePath: string;
}

function hasSvgParserError(el: HTMLIFrameElement): boolean {
  try {
    const contentDocument = el.contentDocument;
    if (!contentDocument) {
      return false;
    }
    return contentDocument.querySelector('parsererror') !== null;
  } catch {
    return false;
  }
}

export function ImageViewer({ filePath }: ImageViewerProps) {
  const { t } = useTranslation();
  const [scale, setScale] = useState(1);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [error, setError] = useState(false);
  const [reloadTrigger, setReloadTrigger] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const isSvg = pathBasename(filePath).split('.').pop()?.toLowerCase() === 'svg';

  useFileRefresh(filePath, () => setReloadTrigger(t => t + 1));

  useEffect(() => {
    setError(false);
    getFileUrl(filePath).then(setImageUrl);
    setScale(1);
    setPosition({ x: 0, y: 0 });
  }, [filePath, reloadTrigger]);

  useEffect(() => {
    const el = iframeRef.current;
    if (!el) return;
    const onError = () => setError(true);
    const onLoad = () => {
      if (hasSvgParserError(el)) {
        setError(true);
      }
    };
    el.addEventListener('error', onError);
    el.addEventListener('load', onLoad);
    return () => {
      el.removeEventListener('error', onError);
      el.removeEventListener('load', onLoad);
    };
  }, [imageUrl]);

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();

    // Handle pinch-to-zoom (trackpad)
    if (e.ctrlKey) {
      const delta = -e.deltaY;
      const scaleChange = delta > 0 ? 1.1 : 0.9;
      const newScale = Math.min(Math.max(0.1, scale * scaleChange), 10);
      setScale(newScale);
    } else {
      // Handle scroll wheel zoom
      const delta = -e.deltaY;
      const scaleChange = delta > 0 ? 1.1 : 0.9;
      const newScale = Math.min(Math.max(0.1, scale * scaleChange), 10);
      setScale(newScale);
    }
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (scale > 1) {
      setIsDragging(true);
      setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging && scale > 1) {
      setPosition({
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y,
      });
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const handleMouseLeave = () => {
    setIsDragging(false);
  };

  const resetZoom = () => {
    setScale(1);
    setPosition({ x: 0, y: 0 });
  };

  const zoomIn = () => {
    const newScale = Math.min(scale * 1.2, 10);
    setScale(newScale);
  };

  const zoomOut = () => {
    const newScale = Math.max(scale / 1.2, 0.1);
    setScale(newScale);
    // Reset position if zooming out to 1 or below
    if (newScale <= 1) {
      setPosition({ x: 0, y: 0 });
    }
  };

  return (
    <EditorShell>
      <EditorToolbar>
        <div className="flex items-center gap-2">
          <Button
            onClick={zoomOut}
            variant="ghost"
            size="xs"
            title={t('help.image.zoomOut.title')}
            data-help-title={t('help.image.zoomOut.title')}
            data-help-description={t('help.image.zoomOut.description')}
          >
            -
          </Button>
          <span className="text-ui-sm min-w-[3rem] text-center text-muted-foreground">
            {Math.round(scale * 100)}%
          </span>
          <Button
            onClick={zoomIn}
            variant="ghost"
            size="xs"
            title={t('help.image.zoomIn.title')}
            data-help-title={t('help.image.zoomIn.title')}
            data-help-description={t('help.image.zoomIn.description')}
          >
            +
          </Button>
          <Button
            onClick={resetZoom}
            variant="ghost"
            size="xs"
            title={t('help.image.resetZoom.title')}
            data-help-title={t('help.image.resetZoom.title')}
            data-help-description={t('help.image.resetZoom.description')}
          >
            {t('image.resetZoom')}
          </Button>
        </div>
      </EditorToolbar>

      <EditorContentSurface
        scroll={false}
        className="flex items-center justify-center p-4 overflow-hidden"
      >
        <div
          ref={containerRef}
          className="w-full h-full flex items-center justify-center"
          data-testid={IMAGE_VIEWER_ID}
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseLeave}
        >
        {error ? (
          <div className="text-center space-y-3">
            <div className="text-muted-foreground">{t('image.errorLoad')}</div>
            <div className="flex items-center justify-center gap-2">
              <button
                onClick={() => setReloadTrigger(t => t + 1)}
                className="px-3 py-1.5 text-ui-base rounded-control bg-muted hover:bg-muted/80 text-foreground transition-colors"
              >
                {t('common.tryAgain')}
              </button>
              <button
                onClick={() => openFeedbackPopover()}
                className="px-3 py-1.5 text-ui-base rounded-control bg-muted hover:bg-muted/80 text-foreground transition-colors"
              >
                {t('common.reportBug')}
              </button>
            </div>
          </div>
        ) : imageUrl ? (
          isSvg ? (
            // NOTE(victor): sandbox="allow-same-origin" without allow-scripts blocks SVG script
            // execution (XSS) while letting us inspect contentDocument for parsererror detection.
            // Do NOT add allow-scripts -- that + allow-same-origin lets the iframe remove its own sandbox.
            <iframe
              ref={iframeRef}
              sandbox="allow-same-origin"
              src={imageUrl}
              title={pathBasename(filePath)}
              className="w-full h-full border-0"
              style={{
                transform: `scale(${scale}) translate(${position.x / scale}px, ${position.y / scale}px)`,
                transformOrigin: 'center center',
              }}
            />
          ) : (
            <img
              src={imageUrl}
              alt={pathBasename(filePath)}
              className="max-w-full max-h-full"
              style={{
                transform: `scale(${scale}) translate(${position.x / scale}px, ${position.y / scale}px)`,
                transformOrigin: 'center center',
              }}
              draggable={false}
              onError={() => setError(true)}
            />
          )
        ) : (
          <div className="text-muted-foreground">{t('common.loading')}</div>
        )}
        </div>
      </EditorContentSurface>
    </EditorShell>
  );
}
