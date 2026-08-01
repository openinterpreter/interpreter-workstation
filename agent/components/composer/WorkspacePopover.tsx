import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Folder, FolderOpen, FolderSearch, AlertTriangle, X, ArrowRight, ChevronRight } from 'lucide-react';
import { Popover, PopoverTrigger, PopoverContent } from '../../../src/components/ui/popover';
import { Tooltip, TooltipTrigger, TooltipContent } from '../../../src/components/ui/tooltip';
import { Button } from '../../../src/components/ui/button';
import { getRecentWorkspaces, type RecentWorkspaceFolder } from '../../../src/api';
import { openFolderDialog, showItemInFolder, getRuntimeSystemInfo, pathBasename } from '../../../src/ipc';
import {
  CODEX_SANDBOX_MODE_OPTIONS,
  getCodexWorkspaceDescription,
  type CodexSandboxMode,
} from '../../../src/lib/codex/sandbox-ui';
import { getRevealInFileManagerLabel } from '../../../src/utils/workspacePickerMenu';
import { ComposerSecondaryButton } from './ComposerSecondaryButton';

interface WorkspacePopoverProps {
  windowWorkspacePath: string | null;
  effectiveWorkspacePath?: string;
  sandboxMode: CodexSandboxMode;
  onWorkspacePathChange: (path: string) => void;
  onOpenSettings?: () => void;
}

export function WorkspacePopover({
  windowWorkspacePath,
  effectiveWorkspacePath,
  sandboxMode,
  onWorkspacePathChange,
  onOpenSettings,
}: WorkspacePopoverProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [recent, setRecent] = useState<RecentWorkspaceFolder[]>([]);
  // Dismissal is scoped to a specific (agent path, window path) pair. When either
  // side changes (e.g. the user switches the window workspace later), the warning
  // re-triggers for the new pair. Choosing a folder from inside the popover is
  // treated as acknowledged — no warning for something the user just set.
  const [dismissedPair, setDismissedPair] = useState<{ agent: string; window: string } | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    getRecentWorkspaces().then(r => setRecent(r.folders)).catch(() => setRecent([]));
  }, [isOpen]);

  const workspaceLabel = effectiveWorkspacePath
    ? pathBasename(effectiveWorkspacePath) || effectiveWorkspacePath
    : t('composer.workspaceButton');
  const revealWorkspaceLabel = getRevealInFileManagerLabel(getRuntimeSystemInfo().platform);
  const workspaceHelpDescription = getCodexWorkspaceDescription(sandboxMode, effectiveWorkspacePath);
  const workspaceTooltipDescription = getCodexWorkspaceDescription(
    sandboxMode,
    effectiveWorkspacePath ? workspaceLabel : effectiveWorkspacePath,
  );
  const sandboxOption = CODEX_SANDBOX_MODE_OPTIONS.find((option) => option.value === sandboxMode);
  const differsFromWindow =
    !!effectiveWorkspacePath && !!windowWorkspacePath && effectiveWorkspacePath !== windowWorkspacePath;
  const openWorkspaceLabel = windowWorkspacePath
    ? pathBasename(windowWorkspacePath) || windowWorkspacePath
    : '';
  const warningActive =
    differsFromWindow
    && !(
      dismissedPair
      && dismissedPair.agent === effectiveWorkspacePath
      && dismissedPair.window === windowWorkspacePath
    );

  // Any explicit user choice from inside this popover counts as acknowledgement
  // for the resulting pair, so the warning doesn't nag after they picked.
  const acknowledgePair = useCallback((nextAgentPath: string) => {
    if (!windowWorkspacePath) return;
    if (nextAgentPath === windowWorkspacePath) {
      // Same as window — nothing to dismiss, clear any stale dismissal.
      setDismissedPair(null);
      return;
    }
    setDismissedPair({ agent: nextAgentPath, window: windowWorkspacePath });
  }, [windowWorkspacePath]);

  const handlePickRecent = useCallback((path: string) => {
    acknowledgePair(path);
    onWorkspacePathChange(path);
    setIsOpen(false);
  }, [acknowledgePair, onWorkspacePathChange]);

  const handleSwitchToOpenWorkspace = useCallback(() => {
    if (!windowWorkspacePath) return;
    onWorkspacePathChange(windowWorkspacePath);
    setDismissedPair(null);
    setIsOpen(false);
  }, [onWorkspacePathChange, windowWorkspacePath]);

  const handleDismissWarning = useCallback(() => {
    if (!effectiveWorkspacePath || !windowWorkspacePath) return;
    setDismissedPair({ agent: effectiveWorkspacePath, window: windowWorkspacePath });
  }, [effectiveWorkspacePath, windowWorkspacePath]);

  const handlePick = useCallback(async () => {
    const result = await openFolderDialog();
    const next = result.filePaths[0];
    if (!result.canceled && next) {
      acknowledgePair(next);
      onWorkspacePathChange(next);
      setIsOpen(false);
    }
  }, [acknowledgePair, onWorkspacePathChange]);

  const handleRevealWorkspace = useCallback(async () => {
    if (!effectiveWorkspacePath) return;
    await showItemInFolder(effectiveWorkspacePath);
    setIsOpen(false);
  }, [effectiveWorkspacePath]);

  const handleOpenSettingsClick = useCallback(() => {
    setIsOpen(false);
    onOpenSettings?.();
  }, [onOpenSettings]);

  const filteredRecent = recent.filter(r => r.path !== effectiveWorkspacePath).slice(0, 6);

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <ComposerSecondaryButton
              type="button"
              className="max-w-[15rem] gap-1.5"
              aria-expanded={isOpen}
              aria-label={workspaceLabel}
              data-help-title={t('composer.workspaceButton')}
              data-help-description={workspaceHelpDescription}
              data-path={effectiveWorkspacePath}
              data-help-item-type={effectiveWorkspacePath ? 'directory' : undefined}
            >
              <FolderOpen className="size-3.5 shrink-0" />
              <span className="block min-w-0 truncate">{workspaceLabel}</span>
              {warningActive ? (
                <span
                  className="ml-0.5 size-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: 'color-mix(in srgb, rgb(245 158 11) 70%, transparent)' }}
                  aria-hidden
                />
              ) : null}
            </ComposerSecondaryButton>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[min(28rem,calc(100vw-2rem))] whitespace-normal break-words">
          {workspaceTooltipDescription}
        </TooltipContent>
      </Tooltip>

      <PopoverContent
        side="top"
        align="start"
        sideOffset={4}
        className="flex max-h-[calc(100dvh-var(--unit-height)-0.75rem)] w-[min(19.5rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-[14px] p-0 shadow-[0_16px_40px_-28px_var(--shadow-color)]"
        style={{
          maxHeight: 'min(calc(100dvh - var(--unit-height) - 0.75rem), var(--radix-popover-content-available-height))',
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex min-h-0 flex-1 flex-col px-2.5 pb-2.5 pt-2.5">
          <div className="flex items-center justify-between gap-3 px-1.5 pb-2">
            <div className="min-w-0 flex-1 px-1">
              <h2 className="text-ui-base font-medium text-foreground">{t('common.workspace')}</h2>
            </div>

            <div className="flex items-center gap-1">
              {onOpenSettings ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={handleOpenSettingsClick}
                  className="h-7 rounded-[8px] px-2 text-ui-sm text-muted-foreground shadow-none hover:text-foreground"
                >
                  <span>{t('settings.profiles.card.settings')}</span>
                  <ChevronRight className="size-3.5" />
                </Button>
              ) : null}
              <button
                type="button"
                className="inline-flex size-7 items-center justify-center rounded-[var(--oa-radius-sm)] text-muted-foreground transition-colors hover:bg-black/[0.04] hover:text-foreground dark:hover:bg-white/[0.08]"
                aria-label={t('common.close')}
                onClick={() => setIsOpen(false)}
              >
                <X className="size-3.5" />
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="px-1.5 pb-2">
              <div
                className="mt-1 flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5"
                style={{ border: 'var(--border-width) solid var(--border)' }}
              >
                <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate text-ui-sm text-foreground">
                  {workspaceLabel}
                </span>
              </div>

              {effectiveWorkspacePath ? (
                <button
                  type="button"
                  onClick={() => void handleRevealWorkspace()}
                  className="mt-2 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui-sm text-foreground transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.05]"
                >
                  <FolderSearch className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{revealWorkspaceLabel}</span>
                </button>
              ) : null}

              {warningActive ? (
                <div
                  className="mt-2 flex items-start gap-2 rounded-md px-2 py-1.5"
                  style={{
                    border: 'var(--border-width) solid color-mix(in srgb, rgb(245 158 11) 28%, transparent)',
                    backgroundColor: 'color-mix(in srgb, rgb(245 158 11) 6%, transparent)',
                  }}
                >
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 text-ui-xs text-muted-foreground">
                    {t('composer.workspaceMismatch', { workspace: openWorkspaceLabel })}
                  </span>
                  <button
                    type="button"
                    onClick={handleDismissWarning}
                    className="-mr-1 inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/[0.06]"
                    aria-label={t('composer.dismissWarning')}
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ) : null}

              {differsFromWindow ? (
                <button
                  type="button"
                  onClick={handleSwitchToOpenWorkspace}
                  className="mt-2 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui-sm text-foreground transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.05]"
                  style={{ border: 'var(--border-width) solid var(--border)' }}
                >
                  <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">
                    {t('composer.switchToOpenWorkspace', { workspace: openWorkspaceLabel })}
                  </span>
                </button>
              ) : null}

              {filteredRecent.length > 0 ? (
                <>
                  <div className="mt-3 px-1 text-ui-xs font-medium text-muted-foreground">{t('common.recent')}</div>
                  <div className="mt-1 flex flex-col gap-0.5">
                    {filteredRecent.map(folder => (
                      <button
                        key={folder.path}
                        type="button"
                        onClick={() => handlePickRecent(folder.path)}
                        className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.05]"
                      >
                        <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate text-ui-sm text-foreground">{folder.name}</span>
                      </button>
                    ))}
                  </div>
                </>
              ) : null}

              <button
                type="button"
                onClick={() => void handlePick()}
                className="mt-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui-sm text-foreground transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.05]"
              >
                <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
                {t('composer.openFolder')}
              </button>
            </div>

            <div className="px-1.5 py-2" style={{ borderTop: 'var(--border-width) solid var(--border)' }}>
              <div className="px-1 text-ui-xs font-medium text-muted-foreground">{t('composer.runtimePermissions')}</div>
              <div
                className="mt-1 rounded-md px-2 py-2"
                style={{ border: 'var(--border-width) solid var(--border)' }}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-ui-sm text-foreground">{t('composer.sandboxMode')}</div>
                    <div className="text-ui-xs text-muted-foreground">
                      {sandboxOption?.label ?? sandboxMode}
                    </div>
                  </div>
                  {onOpenSettings ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={handleOpenSettingsClick}
                      className="h-7 shrink-0 rounded-[8px] px-2 text-ui-sm text-muted-foreground shadow-none hover:text-foreground"
                    >
                      <span>{t('common.permissions')}</span>
                      <ChevronRight className="size-3.5" />
                    </Button>
                  ) : null}
                </div>
                <p className="mt-2 text-ui-xs text-muted-foreground">
                  {t('composer.sharedPermissionsRestart')}
                </p>
              </div>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
