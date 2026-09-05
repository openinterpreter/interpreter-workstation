/**
 * CustomTitleBar Component
 *
 * macOS custom title bar - just buttons, no tabs
 * Tabs are now rendered in EditorLayout per-pane
 */

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LogOut, PanelLeft, PanelRight } from 'lucide-react';
import { useLayout } from '../../hooks/useLayout';
import { detectNoteWorkspaces, getDetectedNoteWorkspaces, getWorkspace, getRecentWorkspaces, type RecentWorkspaceFolder, type DetectedNoteWorkspace } from '../../api';
import { TooltipButton } from '../ui/tooltip-button';
import { KeyboardShortcutHint } from '../ui/keyboard-shortcut-hint';
import { ContextMenu } from '../ContextMenu';
import { CUSTOM_TITLEBAR_ID, EXPLORER_BUTTON_ID, CHAT_BUTTON_ID, APPROVAL_BADGE_ID } from '../../../shared/element-ids';
import { workspace, windowIpc, macTitlebarClicked, showContextMenu, openFolderDialog, showItemInFolder, getRuntimeSystemInfo, openExternal, zoomFactor as zoomFactorIpc, type ContextMenuItem } from '@/ipc';
import { cn } from '@/lib/utils';
import { trackWorkspaceChanged } from '@/utils/telemetry';
import type { WindowFullscreenChangedEvent } from '../../../electron/ipc/registry';
import { useCommandOverlay } from '../../contexts/CommandOverlayContext';
import { AgentAttentionIndicator } from '../AgentAttentionIndicator';
import {
  WINDOWS_TITLE_MENUS,
  getWindowsTitleMenuItems,
  type WindowsTitleMenu,
  type WindowsTitleMenuAction,
} from '../../utils/windowsTitleMenu';
import { buildWorkspacePickerMenuItems, getRevealInFileManagerLabel } from '../../utils/workspacePickerMenu';
import { formatPrimaryShortcut } from '../../utils/platformShortcuts';
import { getDragRegionStyle } from '../../utils/titlebarLayout';
import { usePendingApprovalsByAgent } from '../../hooks/usePendingApprovalsByAgent';
import { isMarketingDemoMode } from '../../demo/marketingDemo';
import {
  canUseHostNativeFileManager,
  getBrowserWorkstationConnection,
  isPublicWorkstationPublication,
  isWorkstationReadOnly,
  workstationFetch,
} from '../../remote/workstationConnection';
import { clampZoomFactor, DEFAULT_ZOOM_FACTOR } from '../../../shared/zoom';

const WINDOWS_TITLE_MENU_ZOOM_STEP = 0.1;

export function CustomTitleBar() {
  const { t } = useTranslation();
  const { state, setLeftSidebarTab, toggleLeftSidebar, toggleRightSidebar, setActiveTabRegion, openNewTab, openSettings } = useLayout();
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [workspaceMenuPos, setWorkspaceMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [recentFolders, setRecentFolders] = useState<RecentWorkspaceFolder[]>([]);
  const [noteWorkspaces, setNoteWorkspaces] = useState<DetectedNoteWorkspace[]>([]);
  const [isScanningNoteWorkspaces, setIsScanningNoteWorkspaces] = useState(false);
  const [_isFullScreen, setIsFullScreen] = useState(false);
  const { isCommandHeld, activatedKey } = useCommandOverlay();
  const pendingApprovalsByAgent = usePendingApprovalsByAgent();
  const runtimePlatform = getRuntimeSystemInfo().platform;
  const marketingDemoMode = isMarketingDemoMode();
  const readOnlyWorkstation = isWorkstationReadOnly();
  const canUseNativeFileManager = canUseHostNativeFileManager();
  const browserConnection = getBrowserWorkstationConnection();
  const canSignOut = browserConnection.host === 'remote'
    && !isPublicWorkstationPublication()
    && browserConnection.authentication === 'password';
  const isMac = runtimePlatform === 'darwin';
  const isWindows = runtimePlatform === 'win32';

  const leftActiveTab = state.leftSidebar.activeTab;
  const leftSidebarOpen = state.leftSidebar.isOpen;
  const rightSidebarOpen = state.rightSidebar.isOpen;
  const sidebarApprovalCount = useMemo(
    () => (state.sidebarPane?.tabIds ?? []).reduce(
      (total, tabId) => total + (pendingApprovalsByAgent.get(tabId) ?? 0),
      0,
    ),
    [pendingApprovalsByAgent, state.sidebarPane?.tabIds],
  );
  const showClosedSidebarAttentionBadge = !rightSidebarOpen && sidebarApprovalCount > 0;
  const leftControlsRef = useRef<HTMLDivElement | null>(null);
  const rightControlsRef = useRef<HTMLDivElement | null>(null);

  const TITLEBAR_LAYOUT_CHANGED_EVENT = 'titlebar:layout-changed';
  const WINDOWS_LEFT_RESERVE_GAP = 8;
  const WINDOWS_RIGHT_RESERVE_GAP = 8;

  // Handle left sidebar tab click with toggle behavior
  const handleLeftTabClick = (tab: 'explorer') => {
    if (leftActiveTab === tab && leftSidebarOpen) {
      toggleLeftSidebar();
    } else {
      setLeftSidebarTab(tab);
      if (!leftSidebarOpen) {
        toggleLeftSidebar();
      }
    }
  };

  // Handle right sidebar button click with toggle behavior
  const handleRightSidebarClick = () => {
    if (rightSidebarOpen) {
      toggleRightSidebar();
    } else {
      toggleRightSidebar();
      if ((state.sidebarPane?.tabIds.length ?? 0) > 0) {
        setActiveTabRegion('sidebar');
      }
    }
  };

  // Load initial workspace and listen for changes
  useEffect(() => {
    async function loadWorkspace() {
      try {
        const { workspace } = await getWorkspace();
        setWorkspacePath(workspace);
      } catch (err) {
        console.error('[CustomTitleBar] Failed to load workspace:', err);
      }
    }

    loadWorkspace();

    const unsubscribe = workspace.onChanged((event: { workspacePath: string | null }) => {
      setWorkspacePath(event.workspacePath);
    });

    return unsubscribe;
  }, []);

  // Listen for fullscreen changes
  useEffect(() => {
    const unsubscribe = windowIpc.onFullscreenChanged((event: WindowFullscreenChangedEvent) => {
      setIsFullScreen(event.isFullScreen);
    });

    return unsubscribe;
  }, []);

  useLayoutEffect(() => {
    const root = document.documentElement;
    if (!isWindows) {
      root.style.removeProperty('--windows-titlebar-left-reserve');
      root.style.removeProperty('--windows-titlebar-right-reserve');
      return;
    }

    let frame: number | null = null;
    const observer = new ResizeObserver(() => {
      scheduleMeasure();
    });

    const measure = () => {
      frame = null;
      const leftRect = leftControlsRef.current?.getBoundingClientRect();
      const rightRect = rightControlsRef.current?.getBoundingClientRect();

      if (leftRect) {
        const leftReserve = Math.ceil(leftRect.right + WINDOWS_LEFT_RESERVE_GAP);
        root.style.setProperty('--windows-titlebar-left-reserve', `${leftReserve}px`);
      }

      if (rightRect) {
        const rightReserve = Math.ceil(Math.max(0, window.innerWidth - rightRect.left + WINDOWS_RIGHT_RESERVE_GAP));
        root.style.setProperty('--windows-titlebar-right-reserve', `${rightReserve}px`);
      }

      window.dispatchEvent(new Event(TITLEBAR_LAYOUT_CHANGED_EVENT));
    };

    function scheduleMeasure() {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(measure);
    }

    if (leftControlsRef.current) observer.observe(leftControlsRef.current);
    if (rightControlsRef.current) observer.observe(rightControlsRef.current);

    window.addEventListener('resize', scheduleMeasure);
    scheduleMeasure();

    return () => {
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
      window.removeEventListener('resize', scheduleMeasure);
      observer.disconnect();
    };
  }, [isWindows]);

  // Handle double-click on title bar (macOS window behavior)
  const handleDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isMac) return;
    if (e.currentTarget === e.target) {
      macTitlebarClicked();
    }
  };

  // Workspace context menu (custom HTML menu so it matches app popovers in all modes)
  const handleWorkspaceContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (readOnlyWorkstation) return;
    // Load persisted picker data only. Neither request probes the filesystem.
    getRecentWorkspaces().then((data) => setRecentFolders(data.folders)).catch(() => {});
    getDetectedNoteWorkspaces().then((data) => setNoteWorkspaces(data.workspaces)).catch(() => {});
    setWorkspaceMenuPos({ x: e.clientX, y: e.clientY });
  };

  const handleScanNoteWorkspaces = async () => {
    const reopenAt = workspaceMenuPos;
    setIsScanningNoteWorkspaces(true);
    try {
      const data = await detectNoteWorkspaces();
      setNoteWorkspaces(data.workspaces);
      if (reopenAt) {
        setWorkspaceMenuPos(reopenAt);
      }
    } catch (err) {
      console.error('[CustomTitleBar] Failed to scan for note workspaces:', err);
    } finally {
      setIsScanningNoteWorkspaces(false);
    }
  };

  const switchWorkspaceTo = async (path: string) => {
    try {
      console.log('[WorkspaceSwitch] ui-requested', {
        source: 'titlebar',
        workspacePath: path,
      });
      const result = await workspace.set({ workspacePath: path });
      console.log('[WorkspaceSwitch] ui-result', {
        source: 'titlebar',
        workspacePath: path,
        success: result.success,
      });
      if (result.success) {
        trackWorkspaceChanged();
      }
    } catch (err: any) {
      console.error('[CustomTitleBar] Failed to change workspace:', err);
    }
  };

  const handleChangeFolder = async () => {
    const result = await openFolderDialog();
    if (!result.canceled && result.filePaths.length > 0) {
      await switchWorkspaceTo(result.filePaths[0]);
    }
  };

  // Agent context menu
  const handleAgentContextMenu = async (e: React.MouseEvent) => {
    e.preventDefault();

    const items: ContextMenuItem[] = [
      { label: 'Cut', action: 'cut', accelerator: 'CmdOrCtrl+X' },
      { label: 'Copy', action: 'copy', accelerator: 'CmdOrCtrl+C' },
      { label: 'Paste', action: 'paste', accelerator: 'CmdOrCtrl+V' },
    ];

    const action = await showContextMenu(items, 'titlebar_edit');

    if (action === 'cut') {
      document.execCommand('cut');
    } else if (action === 'copy') {
      document.execCommand('copy');
    } else if (action === 'paste') {
      document.execCommand('paste');
    }
  };

  const executeEditCommand = (action: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'select-all') => {
    const command = action === 'select-all' ? 'selectAll' : action;
    document.execCommand(command);
  };

  const setWindowsTitleMenuZoom = async (zoomFactor: number) => {
    const nextZoomFactor = clampZoomFactor(Number(zoomFactor.toFixed(2)));
    await zoomFactorIpc.set(nextZoomFactor);
  };

  const changeWindowsTitleMenuZoom = async (delta: number) => {
    const { zoomFactor } = await zoomFactorIpc.get();
    await setWindowsTitleMenuZoom(zoomFactor + delta);
  };

  const handleWindowsTitleMenu = async (menu: WindowsTitleMenu) => {
    if (!isWindows) return;

    const action = await showContextMenu(getWindowsTitleMenuItems(menu), `titlebar_${menu}`);
    if (!action) return;

    const selectedAction = action as WindowsTitleMenuAction;
    switch (selectedAction) {
      case 'new-tab':
        openNewTab();
        break;
      case 'open-folder':
        await handleChangeFolder();
        break;
      case 'open-settings':
        openSettings();
        break;
      case 'toggle-explorer':
        handleLeftTabClick('explorer');
        break;
      case 'toggle-agent':
        handleRightSidebarClick();
        break;
      case 'actual-size':
        await setWindowsTitleMenuZoom(DEFAULT_ZOOM_FACTOR);
        break;
      case 'zoom-in':
        await changeWindowsTitleMenuZoom(WINDOWS_TITLE_MENU_ZOOM_STEP);
        break;
      case 'zoom-out':
        await changeWindowsTitleMenuZoom(-WINDOWS_TITLE_MENU_ZOOM_STEP);
        break;
      case 'undo':
      case 'redo':
      case 'cut':
      case 'copy':
      case 'paste':
      case 'select-all':
        executeEditCommand(selectedAction);
        break;
      case 'learn-more':
        await openExternal('https://www.openinterpreter.com');
        break;
      default:
        break;
    }
  };

  const revealWorkspaceLabel = getRevealInFileManagerLabel(runtimePlatform);
  const explorerShortcutLabel = formatPrimaryShortcut('K', runtimePlatform);
  const openFolderShortcutLabel = formatPrimaryShortcut('O', runtimePlatform);
  const agentShortcutLabel = formatPrimaryShortcut('L', runtimePlatform);
  const workspaceMenuItems = buildWorkspacePickerMenuItems({
    workspacePath,
    recentFolders,
    noteWorkspaces,
    revealWorkspaceLabel,
    openFolderShortcut: openFolderShortcutLabel,
    onRevealWorkspace: (path) => {
      void showItemInFolder(path);
    },
    onOpenFolder: () => {
      void handleChangeFolder();
    },
    onSelectWorkspace: (path) => {
      void switchWorkspaceTo(path);
    },
    onScanNoteWorkspaces: () => {
      void handleScanNoteWorkspaces();
    },
    isScanningNoteWorkspaces,
    includeNativeFileManagerActions: canUseNativeFileManager,
  });

  const handleSignOut = async () => {
    const response = await workstationFetch('/api/workstation-connection/session', {
      method: 'DELETE',
    });
    if (!response.ok) {
      console.error(`[Workstation] Sign out failed (${response.status})`);
      return;
    }
    window.location.reload();
  };

  const paddingStyle: React.CSSProperties = isMac
    ? { paddingLeft: 'var(--titlebar-left-inset)', paddingRight: 'var(--unit-padding)' }
    : isWindows
      ? marketingDemoMode
        ? { paddingLeft: 'var(--unit-padding)', paddingRight: 'var(--unit-padding)' }
        : { paddingLeft: 'var(--unit-padding)', paddingRight: 'calc(var(--unit-padding) + 138px)' }
      : { paddingLeft: 'var(--unit-padding)', paddingRight: 'var(--unit-padding)' };
  const shellButtonClassName = cn(
    'oa-hover-chip titlebar-button min-w-[34px] border border-transparent bg-transparent text-[#5f6673] shadow-none transition-colors duration-150',
    'hover:text-[#202123]',
    'data-[active=true]:text-[#202123]',
    'dark:text-[#bdbdbd] dark:hover:text-[#f5f5f5]',
    'dark:data-[active=true]:text-[#f5f5f5]',
  );

  return (
    <div
      className="absolute top-0 left-0 right-0 z-50 flex items-center justify-between pointer-events-none"
      style={{ height: 'var(--unit-height)', ...paddingStyle }}
      data-testid={CUSTOM_TITLEBAR_ID}
      onDoubleClick={handleDoubleClick}
    >
      {/* Left sidebar button — when sidebar closed, tabs are flush against this button,
           so crossfade the icon into ⌘K instead of showing a side label */}
      <div
        ref={leftControlsRef}
        className="pointer-events-auto flex items-center"
        style={{ gap: 'var(--unit-padding-small)', WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        {!leftSidebarOpen ? (
          <TooltipButton
            variant="ghost"
            size="icon-element"
            onClick={() => handleLeftTabClick('explorer')}
            onContextMenu={handleWorkspaceContextMenu}
            className={cn('pointer-events-auto relative', shellButtonClassName)}
            data-testid={EXPLORER_BUTTON_ID}
            tooltip={t('help.sidebar.explorer.openTitle')}
            helpDescription={t('help.sidebar.explorer.description')}
            shortcut={explorerShortcutLabel}
            tooltipSide="right"
          >
            <span className="transition-opacity duration-150 ease-out" style={{ opacity: isCommandHeld ? 0 : 1 }}>
              <PanelLeft />
            </span>
            <KeyboardShortcutHint
              shortcut="K"
              isCommandHeld={isCommandHeld}
              activatedKey={activatedKey}
              className="absolute inset-0 justify-center text-[10px]"
              activeClassName="text-foreground/60"
              inactiveClassName="text-muted-foreground/50"
              heldClassName="text-muted-foreground/50"
            />
          </TooltipButton>
        ) : null}
        {isWindows && (
          <div className="flex items-center text-ui-sm" style={{ gap: 'var(--unit-padding-medium)', WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
            {WINDOWS_TITLE_MENUS.map(menu => (
              <button
                key={menu.id}
                type="button"
                className="titlebar-button rounded-sm px-1 text-[#202123] hover:bg-hover dark:text-[#f5f5f5]"
                onClick={() => void handleWindowsTitleMenu(menu.id)}
              >
                {menu.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div
        className="flex-1 h-full"
        style={{ WebkitAppRegion: getDragRegionStyle(runtimePlatform) } as React.CSSProperties}
        onDoubleClick={handleDoubleClick}
      />

      {/* Right sidebar button */}
      {!readOnlyWorkstation || canSignOut ? <div ref={rightControlsRef} className="flex items-center pointer-events-auto" style={{ gap: 'var(--unit-padding-small)', WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        {!readOnlyWorkstation ? <div className="relative">
          <TooltipButton
            variant="ghost"
            size="icon-element"
            onClick={handleRightSidebarClick}
            onContextMenu={handleAgentContextMenu}
            data-testid={CHAT_BUTTON_ID}
            tooltip={rightSidebarOpen ? t('help.sidebar.agent.closeTitle') : t('help.sidebar.agent.openTitle')}
            helpDescription={t('help.sidebar.agent.description')}
            shortcut={agentShortcutLabel}
            tooltipSide="bottom"
            className={cn('relative', shellButtonClassName)}
            data-active={rightSidebarOpen || undefined}
          >
            <span className="transition-opacity duration-150 ease-out" style={{ opacity: isCommandHeld ? 0 : 1 }}>
              <PanelRight />
            </span>
            <KeyboardShortcutHint
              shortcut="L"
              isCommandHeld={isCommandHeld}
              activatedKey={activatedKey}
              className="absolute inset-0 justify-center text-[10px]"
              activeClassName="text-foreground/60"
              inactiveClassName="text-muted-foreground/50"
              heldClassName="text-muted-foreground/50"
            />
          </TooltipButton>
          {showClosedSidebarAttentionBadge && (
            <span data-testid={APPROVAL_BADGE_ID} className="absolute right-1 top-1 pointer-events-none">
              <AgentAttentionIndicator tone="attention" className="size-2.5" />
            </span>
          )}
        </div> : null}
        {canSignOut ? (
          <TooltipButton
            variant="ghost"
            size="icon-element"
            onClick={() => void handleSignOut()}
            tooltip="Sign out of this Workstation"
            tooltipSide="bottom"
            className={shellButtonClassName}
          >
            <LogOut aria-hidden="true" />
          </TooltipButton>
        ) : null}
      </div> : null}

      {!readOnlyWorkstation && workspaceMenuPos && (
        <ContextMenu
          x={workspaceMenuPos.x}
          y={workspaceMenuPos.y}
          items={workspaceMenuItems}
          onClose={() => setWorkspaceMenuPos(null)}
        />
      )}
    </div>
  );
}
