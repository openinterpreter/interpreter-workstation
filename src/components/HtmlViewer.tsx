import { useState, useEffect, useRef } from 'react';
import { HTML_VIEWER_ID } from '../../shared/element-ids';
import { TextEditor } from './TextEditor';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/tabs';
import { readFile } from '@/api';
import { openPath, pathBasename } from '@/ipc';
import { useToast } from '../contexts/ToastContext';
import { openFeedbackPopover } from '../utils/feedback';
import { useFileRefresh } from '../hooks/useFileRefresh';
import { buildUntrustedHtmlDocument, htmlContainsBlockedPreviewContent } from '../utils/untrustedHtml';
import { SandboxedHtmlFrame } from './SandboxedHtmlFrame';

interface HtmlViewerProps {
  filePath: string;
  refreshKey?: number;
}

export function HtmlViewer({ filePath, refreshKey = 0 }: HtmlViewerProps) {
  const { showToast } = useToast();
  const [htmlContent, setHtmlContent] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [reloadTrigger, setReloadTrigger] = useState(0);
  const [viewerRevision, setViewerRevision] = useState(0);
  const loadRequestRef = useRef(0);

  useFileRefresh(filePath, () => setReloadTrigger(t => t + 1));

  useEffect(() => {
    const requestId = loadRequestRef.current + 1;
    loadRequestRef.current = requestId;

    setHtmlContent(null);
    setError(false);
    setViewerRevision(current => current + 1);

    async function loadHtmlContent() {
      try {
        const data = await readFile(filePath);
        if (loadRequestRef.current !== requestId) {
          return;
        }
        setHtmlContent(data.content);
      } catch {
        if (loadRequestRef.current !== requestId) {
          return;
        }
        setError(true);
      }
    }

    void loadHtmlContent();
  }, [filePath, refreshKey, reloadTrigger]);

  // Remount the preview iframe after reloads so stale sandbox state cannot
  // survive an on-disk HTML update. Keep the source editor mounted so local
  // editing state survives autosave-triggered refresh events.
  const previewInstanceKey = `${filePath}:${viewerRevision}`;
  const containsBlockedPreviewContent = htmlContent ? htmlContainsBlockedPreviewContent(htmlContent) : false;

  return (
    <Tabs defaultValue="preview" className="flex flex-col h-full bg-[var(--oa-surface-center)]">
      {/* Toolbar - uses universal row height */}
      <div className="voice-focus-content-toolbar px-2 flex items-center justify-end" style={{ height: 'var(--unit-height)' }}>
        <TabsList variant="line">
          <TabsTrigger value="preview">
            Preview
          </TabsTrigger>
          <TabsTrigger value="source">
            Source
          </TabsTrigger>
        </TabsList>
      </div>

      {/* Content area */}
      <TabsContent value="preview" className="flex-1 min-h-0 m-0">
        <div
          className="voice-focus-content-surface h-full"
          data-testid={HTML_VIEWER_ID}
        >
          {error ? (
            <div className="flex items-center justify-center h-full">
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
            </div>
          ) : htmlContent ? (
            <div className="flex h-full flex-col">
              {containsBlockedPreviewContent ? (
                <div
                  className="flex items-center justify-between gap-3 bg-muted/40 px-3 py-2 text-ui-sm"
                  style={{ borderBottom: 'var(--border-width) solid var(--border)' }}
                >
                  <span className="text-muted-foreground">
                    Interactive content is blocked in preview for safety.
                  </span>
                  <button
                    className="rounded-control bg-muted px-2 py-1 text-foreground transition-colors hover:bg-muted/80"
                    onClick={() => {
                      void (async () => {
                        try {
                          const result = await openPath(filePath);
                          if (result.error) {
                            showToast(`Could not open file: ${result.error}`, 'error', 5000);
                          }
                        } catch (openError) {
                          const message = openError instanceof Error ? openError.message : String(openError);
                          showToast(`Could not open file: ${message}`, 'error', 5000);
                        }
                      })();
                    }}
                    type="button"
                  >
                    Open in default browser
                  </button>
                </div>
              ) : null}
              <div className="flex-1 min-h-0">
                <SandboxedHtmlFrame
                  key={previewInstanceKey}
                  srcDoc={buildUntrustedHtmlDocument(htmlContent)}
                  title={pathBasename(filePath)}
                />
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              Loading...
            </div>
          )}
        </div>
      </TabsContent>

      <TabsContent value="source" className="flex-1 min-h-0 m-0">
        <div className="h-full">
          <TextEditor filePath={filePath} />
        </div>
      </TabsContent>
    </Tabs>
  );
}
