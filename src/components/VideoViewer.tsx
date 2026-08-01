import { useState, useEffect } from 'react';
import { VIDEO_VIEWER_ID } from '../../shared/element-ids';
import { getFileUrl } from '@/ipc';
import { openFeedbackPopover } from '../utils/feedback';
import { useFileRefresh } from '../hooks/useFileRefresh';

interface VideoViewerProps {
  filePath: string;
}

export function VideoViewer({ filePath }: VideoViewerProps) {
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [reloadTrigger, setReloadTrigger] = useState(0);

  useFileRefresh(filePath, () => setReloadTrigger(t => t + 1));

  useEffect(() => {
    setError(false);
    getFileUrl(filePath).then(setVideoUrl);
  }, [filePath, reloadTrigger]);

  return (
    <div className="flex flex-col h-full">
      {/* Video viewer */}
      <div
        className="voice-focus-content-surface flex-1 flex items-center justify-center bg-background p-4 overflow-auto"
        data-testid={VIDEO_VIEWER_ID}
      >
        {error ? (
          <div className="text-center space-y-3">
            <div className="text-muted-foreground">Unable to load this file</div>
            <div className="flex items-center justify-center gap-2">
              <button
                onClick={() => setReloadTrigger(t => t + 1)}
                className="px-3 py-1.5 text-ui-base rounded-control bg-muted hover:bg-muted/80 text-foreground transition-colors"
              >
                Try again
              </button>
              <button
                onClick={() => openFeedbackPopover()}
                className="px-3 py-1.5 text-ui-base rounded-control bg-muted hover:bg-muted/80 text-foreground transition-colors"
              >
                Report bug
              </button>
            </div>
          </div>
        ) : videoUrl ? (
          <video
            src={videoUrl}
            controls
            className="max-w-full max-h-full"
            onError={() => setError(true)}
          >
            Your browser does not support the video tag.
          </video>
        ) : (
          <div className="text-muted-foreground">Loading...</div>
        )}
      </div>
    </div>
  );
}
