import { useCallback, useState } from 'react';
import { FolderOpen, X } from 'lucide-react';
import { Button } from '../ui/button';
import { workspace, pathBasename } from '@/ipc';

interface WorkspaceSwitchBannerProps {
  message: string;
  displayPath?: string;
  targetWorkspacePath: string;
  actionLabelPrefix: string;
  onSwitched?: () => void;
  onDismiss?: () => void;
}

export function WorkspaceSwitchBanner({
  message,
  displayPath,
  targetWorkspacePath,
  actionLabelPrefix,
  onSwitched,
  onDismiss,
}: WorkspaceSwitchBannerProps) {
  const [isChanging, setIsChanging] = useState(false);
  const folderName = pathBasename(targetWorkspacePath) || targetWorkspacePath;

  const handleSwitchWorkspace = useCallback(async () => {
    if (isChanging) return;
    setIsChanging(true);

    let didSwitch = false;
    try {
      console.log('[WorkspaceSwitch] ui-requested', {
        source: 'switch-banner',
        workspacePath: targetWorkspacePath,
      });
      const result = await workspace.set({ workspacePath: targetWorkspacePath });
      console.log('[WorkspaceSwitch] ui-result', {
        source: 'switch-banner',
        workspacePath: targetWorkspacePath,
        success: result.success,
      });
      didSwitch = result.success;
    } catch (error) {
      console.error('[WorkspaceSwitchBanner] Failed to change workspace:', error);
    }
    setIsChanging(false);
    if (didSwitch) {
      onSwitched?.();
    }
  }, [isChanging, onSwitched, targetWorkspacePath]);

  return (
    <div
      className="flex items-center justify-between gap-3 px-4 py-3"
      style={{
        borderBottom: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 78%, transparent)',
        background: 'color-mix(in srgb, var(--oa-bg-subtle, var(--muted)) 46%, transparent)',
      }}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div
          className="flex size-7 shrink-0 items-center justify-center rounded-full"
          style={{ background: 'color-mix(in srgb, #d97706 10%, transparent)' }}
        >
          <FolderOpen className="size-3.5 text-amber-700 dark:text-amber-300" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-ui-sm text-[var(--oa-text-strong)]">{message}</p>
          <p className="truncate text-ui-xs text-[var(--oa-text-faint)]">{displayPath ?? targetWorkspacePath}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          variant="outline"
          size="sm"
          onClick={handleSwitchWorkspace}
          disabled={isChanging}
          title={targetWorkspacePath}
          className="max-w-[min(24rem,45vw)] justify-start overflow-hidden text-ellipsis rounded-full px-3 text-ui-sm text-[var(--oa-text-strong)] disabled:opacity-50"
        >
          {isChanging ? 'Changing...' : `${actionLabelPrefix} "${folderName}"`}
        </Button>
        {onDismiss && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onDismiss}
            className="rounded-full text-[var(--oa-text-faint)] hover:bg-[var(--oa-bg-hover)] hover:text-[var(--oa-text-strong)]"
            aria-label="Dismiss"
          >
            <X />
          </Button>
        )}
      </div>
    </div>
  );
}
