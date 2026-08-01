import { useState, useEffect } from 'react';
import { getFileUrl, getFileThumbnails } from '@/ipc';
import { openFeedbackPopover } from '../utils/feedback';
import { useFileRefresh } from '../hooks/useFileRefresh';
import { getPreviewThumbnailUrl } from '../utils/fileThumbnail';

interface AudioViewerProps {
  filePath: string;
}

export function AudioViewer({ filePath }: AudioViewerProps) {
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [coverArt, setCoverArt] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [reloadTrigger, setReloadTrigger] = useState(0);

  useFileRefresh(filePath, () => setReloadTrigger(t => t + 1));

  useEffect(() => {
    async function setup() {
      setError(false);
      setAudioUrl(await getFileUrl(filePath));

      // Fetch high-res thumbnail (cover art) via API - size 256 for album art display
      try {
        const { thumbnails } = await getFileThumbnails([filePath], 256);
        const thumbnailUrl = getPreviewThumbnailUrl(thumbnails[filePath]);
        if (thumbnailUrl) {
          setCoverArt(thumbnailUrl);
        }
      } catch (err) {
        console.error('[AudioViewer] Failed to fetch cover art:', err);
      }
    }
    setup();
    setCoverArt(null);
  }, [filePath, reloadTrigger]);

  return (
    <div className="flex flex-col h-full">
      {/* Audio viewer */}
      <div className="voice-focus-content-surface flex-1 flex flex-col items-center justify-center bg-background p-8">
        {/* Cover art - fetched via thumbnail API (uses Quick Look on macOS to extract album art) */}
        {coverArt && (
          <img
            src={coverArt}
            alt="Album cover"
            className="w-64 h-64 object-cover rounded-lg shadow-sm mb-6"
          />
        )}

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
        ) : audioUrl ? (
          <audio
            src={audioUrl}
            controls
            className="w-full max-w-md"
            style={{ outline: 'none' }}
            onError={() => setError(true)}
          >
            Your browser does not support the audio element.
          </audio>
        ) : (
          <div className="text-muted-foreground">Loading...</div>
        )}
      </div>
    </div>
  );
}
