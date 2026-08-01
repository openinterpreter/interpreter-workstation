/**
 * WorkspaceLanding - Shown when no folder is open
 *
 * Displays options to open a folder.
 * Used in Explorer when workspace is null.
 */

import { FolderOpen } from 'lucide-react';
import { Button } from './ui/button';
import { openFolderDialog, workspace } from '@/ipc';
import { formatPrimaryShortcut } from '../utils/platformShortcuts';

interface WorkspaceLandingProps {
  onFolderOpened?: () => void;
}

export function WorkspaceLanding({ onFolderOpened }: WorkspaceLandingProps) {
  const handleOpenFolder = async () => {
    let result: Awaited<ReturnType<typeof openFolderDialog>> | null = null;
    try {
      result = await openFolderDialog();
    } catch (error) {
      console.error('[WorkspaceLanding] Error opening folder:', error);
    }

    if (!result || result.canceled || result.filePaths.length === 0) {
      return;
    }

    const selectedPath = result.filePaths[0];
    // Use IPC workspace.set which goes through confirmation dialog
    const setResult = await workspace.set({ workspacePath: selectedPath });
    if (setResult.success) {
      onFolderOpened?.();
    }
  };

  return (
    <div className="flex flex-col items-center justify-center h-full p-6 text-center">
      <div className="space-y-6 max-w-xs">
        <div className="space-y-2">
          <h2 className="text-ui-base font-medium text-foreground">No folder open</h2>
          <p className="text-ui-sm text-muted-foreground">
            Open a folder to browse files and work with AI
          </p>
        </div>

        <div className="space-y-2">
          <Button
            onClick={handleOpenFolder}
            variant="default"
            size="sm"
            className="w-full justify-start gap-2"
          >
            <FolderOpen className="size-4" />
            Open Folder
          </Button>
        </div>

        <p className="text-ui-xs text-muted-foreground">
          Or use File → Open Folder ({formatPrimaryShortcut('O')})
        </p>
      </div>
    </div>
  );
}
