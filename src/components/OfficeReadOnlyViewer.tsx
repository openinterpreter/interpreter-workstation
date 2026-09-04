import { useCallback, useEffect, useState, type ComponentProps } from 'react';
import FileViewer, { type ViewerState } from '@file-viewer/react';
import { pptxRenderer } from '@file-viewer/renderer-pptx';
import spreadsheetRenderer from '@file-viewer/renderer-spreadsheet';
import wordRenderer from '@file-viewer/renderer-word';

import { OFFICE_EXTENSION_VIEWER_ID, OFFICE_READ_ONLY_PREVIEW_ID } from '../../shared/element-ids';
import { files, pathBasename } from '@/ipc';
import { useFileRefresh } from '../hooks/useFileRefresh';
import { Button } from './ui/button';

interface OfficeReadOnlyViewerProps {
  filePath: string;
  refreshKey?: number;
  editingUnavailable?: boolean;
  onInstallEditor?: () => void;
}

type ReadOnlyViewerState =
  | { status: 'loading' }
  | { status: 'ready'; file: File }
  | { status: 'error'; message: string };

type PreviewRenderState = 'loading' | 'ready' | 'error';

type ViewerRenderers = NonNullable<ComponentProps<typeof FileViewer>['options']>['renderers'];

// The renderer packages use the narrower HTMLDivElement handler target, while
// the public React type currently widens custom handlers to HTMLElement.
const officeRenderers = [wordRenderer, spreadsheetRenderer, pptxRenderer] as unknown as ViewerRenderers;

const officeViewerOptions = {
  renderers: officeRenderers,
  rendererMode: 'replace',
  styleIsolation: 'shadow',
  toolbar: {
    download: false,
    exportHtml: false,
    print: false,
    theme: false,
    permissions: {
      download: false,
      print: false,
      'export-html': false,
    },
  },
} as const;

function getPreviewErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === 'string' && error.trim()) {
    return error;
  }

  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) {
      return message;
    }
  }

  return 'The document could not be rendered.';
}

/**
 * Browser-local Office preview used where the optional oo-editors integration
 * is unavailable. Files remain behind the existing trusted Electron IPC
 * boundary; the renderer never receives direct filesystem access.
 */
export function OfficeReadOnlyViewer({
  filePath,
  refreshKey = 0,
  editingUnavailable = false,
  onInstallEditor,
}: OfficeReadOnlyViewerProps) {
  "use no memo";

  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<ReadOnlyViewerState>({ status: 'loading' });
  const [renderState, setRenderState] = useState<PreviewRenderState>('loading');
  const [renderError, setRenderError] = useState<string | null>(null);

  const handleViewerStateChange = useCallback((nextState: ViewerState) => {
    if (nextState.error) {
      setRenderState('error');
      setRenderError(getPreviewErrorMessage(nextState.error));
      return;
    }

    if (nextState.loading || !nextState.ready) {
      setRenderState('loading');
      setRenderError(null);
      return;
    }

    setRenderState('ready');
    setRenderError(null);
  }, []);

  const loadFile = useCallback(async (cancelled: { current: boolean }) => {
    setState({ status: 'loading' });
    setRenderState('loading');
    setRenderError(null);
    try {
      const { buffer } = await files.readBinary(filePath);
      if (cancelled.current) return;

      setState({
        status: 'ready',
        file: new File([buffer], pathBasename(filePath) || 'document'),
      });
    } catch (error) {
      if (!cancelled.current) {
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : 'The file could not be read.',
        });
      }
    }
  }, [filePath]);

  useEffect(() => {
    const cancelled = { current: false };
    void loadFile(cancelled);
    return () => {
      cancelled.current = true;
    };
  }, [loadFile, refreshKey, revision]);

  useFileRefresh(filePath, () => setRevision((current) => current + 1));

  const previewState: PreviewRenderState = state.status === 'error'
    ? 'error'
    : state.status === 'loading'
      ? 'loading'
      : renderState;
  const previewError = state.status === 'error'
    ? state.message
    : renderError ?? 'The document could not be rendered.';
  const viewerStateAttributes = {
    'data-office-viewer-state': previewState,
    'data-office-viewer-ready': String(previewState === 'ready'),
    'data-office-viewer-error': previewState === 'error' ? 'true' : undefined,
    'aria-busy': previewState === 'loading' ? 'true' : 'false',
  } as const;

  if (state.status === 'loading') {
    return (
      <div
        {...viewerStateAttributes}
        className="flex h-full items-center justify-center text-muted-foreground"
        data-testid={OFFICE_EXTENSION_VIEWER_ID}
      >
        <div className="flex items-center gap-2">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
          Loading read-only preview...
        </div>
      </div>
    );
  }

  if (previewState === 'error') {
    return (
      <div
        {...viewerStateAttributes}
        className="flex h-full items-center justify-center px-6"
        data-testid={OFFICE_EXTENSION_VIEWER_ID}
      >
        <div className="max-w-md text-center">
          <p className="mb-2 text-ui-base text-foreground">Unable to preview this file</p>
          <p className="mb-4 text-ui-sm text-muted-foreground">{previewError}</p>
          <button
            type="button"
            className="rounded-control bg-muted px-3 py-1.5 text-ui-sm text-foreground transition-colors hover:bg-muted/80"
            onClick={() => setRevision((current) => current + 1)}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (state.status !== 'ready') {
    return null;
  }

  return (
    <div
      {...viewerStateAttributes}
      className="relative h-full w-full"
      data-testid={OFFICE_EXTENSION_VIEWER_ID}
    >
      {editingUnavailable && (
        <div className="absolute left-3 top-3 z-10 flex items-center gap-2 rounded-control bg-muted px-2 py-1 text-ui-xs text-muted-foreground">
          <span>Read-only preview. Install oo-editors to edit this file here.</span>
          {onInstallEditor && (
            <Button onClick={onInstallEditor} size="sm" variant="outline">
              Install oo-editors
            </Button>
          )}
        </div>
      )}
      <FileViewer
        key={`${filePath}:${refreshKey}:${revision}`}
        file={state.file}
        name={state.file.name}
        onStateChange={handleViewerStateChange}
        options={officeViewerOptions}
        className="h-full w-full"
        data-testid={OFFICE_READ_ONLY_PREVIEW_ID}
        {...viewerStateAttributes}
      />
    </div>
  );
}
