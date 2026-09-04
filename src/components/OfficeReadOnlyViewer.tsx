import { useCallback, useEffect, useState } from 'react';
import FileViewer from '@file-viewer/react';
import officeRenderers from '@file-viewer/preset-office';

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

  const loadFile = useCallback(async (cancelled: { current: boolean }) => {
    setState({ status: 'loading' });
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

  if (state.status === 'loading') {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground" data-testid={OFFICE_EXTENSION_VIEWER_ID}>
        <div className="flex items-center gap-2">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
          Loading read-only preview...
        </div>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="flex h-full items-center justify-center px-6" data-testid={OFFICE_EXTENSION_VIEWER_ID}>
        <div className="max-w-md text-center">
          <p className="mb-2 text-ui-base text-foreground">Unable to preview this file</p>
          <p className="mb-4 text-ui-sm text-muted-foreground">{state.message}</p>
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

  return (
    <div className="relative h-full w-full" data-testid={OFFICE_EXTENSION_VIEWER_ID}>
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
        options={{
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
        }}
        className="h-full w-full"
        data-testid={OFFICE_READ_ONLY_PREVIEW_ID}
      />
    </div>
  );
}
