import { useState, useCallback, useRef, useEffect } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import { Settings, X } from 'lucide-react';
import type { Tab } from '../../shared/types/layout';
import { useHelp, getDefaultHelpInfo } from '../contexts/HelpContext';
import type { HelpInfo } from '../contexts/HelpContext';
import { useLayout } from '../hooks/useLayout';
import { useAuth } from '../contexts/AuthContext';
import { Button } from './ui/button';
import { KeyboardShortcutHint } from './ui/keyboard-shortcut-hint';
import { TooltipButton } from './ui/tooltip-button';
import { ResizeHandle } from './ui/resize-handle';
import { findSettingsTab } from '../utils/layoutHelpers';
import { findPaneById } from '../utils/treeOperations';
import { getFileThumbnails, files, uiSettings, pathBasename, getRuntimeSystemInfo } from '@/ipc';
import { OFFICE_EDITOR_EXTENSIONS } from '../../shared/utils/converterFormats';
import { FeedbackPopover } from './FeedbackPopover';
import { useCommandOverlay } from '../contexts/CommandOverlayContext';
import { SIDEBAR_FOOTER_ROW_PRIMARY_BUTTON_CLASSNAME } from './sidebarFooterButtonStyles';
import {
  getSidebarFooterMotion,
  SIDEBAR_FOOTER_HEIGHT_TRANSITION,
  SIDEBAR_FOOTER_PANEL_STYLE,
} from './sidebarFooterMotion';
import { formatPrimaryShortcut, type ShortcutPlatform } from '../utils/platformShortcuts';
import { getPreviewThumbnailUrl } from '../utils/fileThumbnail';

// Heights are computed from CSS variables
// Resize handle height = 1px + unit-padding * 2 (from .resize-handle-horizontal CSS)
// Toolbar height = unit-height (one full row)
// Collapsed = resize handle + toolbar
const DEFAULT_EXPANDED_HEIGHT = 300;
const MAX_HEIGHT = 450;

// Format file size in human-readable format
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// Get computed collapsed height from CSS variables
function getCollapsedHeight(): number {
  const style = getComputedStyle(document.documentElement);
  const unitHeight = parseFloat(style.getPropertyValue('--unit-height')) || 42;
  // Resize handle: just 1px border, Toolbar: unit-height
  return 1 + unitHeight;
}

function getActiveOfficeHelpInfo(
  activeTab: Tab | null,
  platform: ShortcutPlatform
): HelpInfo | null {
  if (!activeTab || activeTab.type !== 'file' || !activeTab.path) return null;

  const fileName = pathBasename(activeTab.path);
  const dotIndex = fileName.lastIndexOf('.');
  const extension = dotIndex >= 0 ? fileName.slice(dotIndex + 1).toLowerCase() : '';

  if (!OFFICE_EDITOR_EXTENSIONS.has(extension)) return null;

  const saveShortcut = formatPrimaryShortcut('S', platform);

  return {
    title: activeTab.label || fileName || 'Office file',
    description: `Click inside the editor, then press ${saveShortcut} to save.`,
    filePath: activeTab.path,
    itemType: 'file',
  };
}

function SidebarFooterAvatar({ avatarUrl, displayName, isSignedOut }: { avatarUrl?: string; displayName: string; isSignedOut?: boolean }) {
  const [imageError, setImageError] = useState(false);

  if (isSignedOut) {
    return (
      <Settings className="size-[18px] shrink-0 text-[#5f6673] dark:text-[#bdbdbd]" />
    );
  }

  const initial = displayName.charAt(0).toUpperCase() || 'W';

  if (!avatarUrl || imageError) {
    return (
      <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[#202123] text-white dark:bg-[#f5f5f5] dark:text-[#111111]">
        <span className="text-ui-sm font-medium">{initial}</span>
      </div>
    );
  }

  return (
    <img
      src={avatarUrl}
      alt={displayName}
      className="size-7 shrink-0 rounded-full object-cover"
      onError={() => setImageError(true)}
    />
  );
}

export function HelpPanel() {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion() ?? false;
  const panelMotion = getSidebarFooterMotion('panel', reducedMotion);
  const {
    helpInfo,
    isHelpPanelOpen: isOpen,
    setIsHelpPanelOpen: setIsOpen,
    helpPanelHeight,
    setHelpPanelHeight,
  } = useHelp();

  const { state, openSettings, closeTab, setActiveTab } = useLayout();
  const { isCommandHeld, activatedKey } = useCommandOverlay();
  const { user } = useAuth();
  const activePane = state.activePaneId ? findPaneById(state.tree, state.activePaneId) : null;
  const activeTab = activePane?.activeTabId ? state.tabs[activePane.activeTabId] : null;
  const activeTabHelpInfo = getActiveOfficeHelpInfo(
    activeTab,
    getRuntimeSystemInfo().platform
  );

  // Check if settings tab is currently the active tab
  const settingsTab = findSettingsTab(state.tabs);
  const isSettingsActive = !!settingsTab && activePane?.activeTabId === settingsTab.id;

  const [isDragging, setIsDragging] = useState(false);
  const [collapsedHeight, setCollapsedHeight] = useState(getCollapsedHeight);
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [thumbnailLoading, setThumbnailLoading] = useState(false);
  const [fileStats, setFileStats] = useState<{
    size: number | null;
    lineCount: number | null;
    itemCount: number | null;
    isDirectory: boolean;
  } | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  const displayInfo = helpInfo || activeTabHelpInfo || getDefaultHelpInfo();
  const fullName = user?.user_metadata?.full_name || user?.user_metadata?.name;
  const isSignedOut = !user;
  const displayName = fullName || user?.email?.split('@')[0] || 'Settings';
  const avatarUrl = user?.user_metadata?.avatar_url;

  // Update collapsed height when CSS variables might change
  useEffect(() => {
    setCollapsedHeight(getCollapsedHeight());
  }, []);

  // Load and subscribe to showPreview setting
  useEffect(() => {
    uiSettings.getShowHelpPanelPreview().then((response: { enabled: boolean }) => {
      setShowPreview(response.enabled);
    }).catch(() => {
      // Default to false if loading fails
    });

    const unsubscribe = uiSettings.onShowHelpPanelPreviewChanged?.((event: { enabled: boolean }) => {
      setShowPreview(event.enabled);
    });

    return unsubscribe;
  }, []);

  // Fetch thumbnail when filePath changes (skip for folders, skip if panel closed, skip if preview disabled)
  useEffect(() => {
    const filePath = displayInfo.filePath;
    const isFolder = displayInfo.itemType === 'directory';

    if (!isOpen || !filePath || isFolder || !showPreview) {
      setThumbnailUrl(null);
      setThumbnailLoading(false);
      return;
    }

    let cancelled = false;
    setThumbnailLoading(true);

    // Use a larger size for the preview (512px for high quality)
    getFileThumbnails([filePath], 512).then((response) => {
      if (cancelled) return;
      const thumbnailUrl = getPreviewThumbnailUrl(response.thumbnails[filePath]);
      if (thumbnailUrl) {
        setThumbnailUrl(thumbnailUrl);
      } else {
        setThumbnailUrl(null);
      }
    }).catch(() => {
      if (!cancelled) setThumbnailUrl(null);
    }).finally(() => {
      if (!cancelled) setThumbnailLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [isOpen, displayInfo.filePath, displayInfo.description, showPreview]);

  // Fetch file stats when filePath changes (skip if panel closed)
  useEffect(() => {
    const filePath = displayInfo.filePath;
    if (!isOpen || !filePath) {
      setFileStats(null);
      return;
    }

    let cancelled = false;

    files.getStats(filePath).then((stats: {
      size: number | null;
      lineCount: number | null;
      itemCount: number | null;
      isDirectory: boolean;
    }) => {
      if (cancelled) return;
      setFileStats(stats);
    }).catch(() => {
      if (!cancelled) setFileStats(null);
    });

    return () => {
      cancelled = true;
    };
  }, [isOpen, displayInfo.filePath]);

  // Use ref to track if we opened during this drag
  const openedDuringDragRef = useRef(false);

  // Custom resize handling
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const wasOpen = isOpen;
    const startHeight = wasOpen ? helpPanelHeight : collapsedHeight;
    openedDuringDragRef.current = false;

    setIsDragging(true);

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaY = startY - moveEvent.clientY;
      const newHeight = Math.max(collapsedHeight, Math.min(MAX_HEIGHT, startHeight + deltaY));

      // If dragging up from collapsed, open
      if (!wasOpen && !openedDuringDragRef.current && newHeight > collapsedHeight + 20) {
        setIsOpen(true);
        openedDuringDragRef.current = true;
      }

      // If started open and dragged down to collapsed height, close
      if (wasOpen && newHeight <= collapsedHeight + 5) {
        setIsOpen(false);
        setHelpPanelHeight(DEFAULT_EXPANDED_HEIGHT);
      } else if (newHeight > collapsedHeight) {
        setHelpPanelHeight(newHeight);
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      openedDuringDragRef.current = false;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [collapsedHeight, helpPanelHeight, isOpen, setHelpPanelHeight, setIsOpen]);

  const handleToggleSettings = () => {
    if (!settingsTab) {
      // Settings doesn't exist - open it
      openSettings();
    } else if (!isSettingsActive) {
      // Settings exists but isn't active - activate it
      setActiveTab(settingsTab.id);
    } else {
      // Settings is active - close it
      closeTab(settingsTab.id);
    }
  };

  // Commented out with Ask about Interpreter
  // const handleSendToAgent = () => {
  //   if (!inputValue.trim()) return;
  //   window.dispatchEvent(new CustomEvent('help-panel:send-to-agent', {
  //     detail: { message: inputValue.trim() }
  //   }));
  //   setInputValue('');
  //   setSentFeedback(true);
  //   setTimeout(() => {
  //     setSentFeedback(false);
  //   }, 2000);
  // };

  // const handleKeyDown = (e: React.KeyboardEvent) => {
  //   if (e.key === 'Enter' && !e.shiftKey) {
  //     e.preventDefault();
  //     handleSendToAgent();
  //   }
  // };

  // Calculate total height
  const totalHeight = isOpen ? helpPanelHeight : collapsedHeight;

  useEffect(() => {
    document.documentElement.style.setProperty('--help-panel-total-height', `${totalHeight}px`);
    return () => {
      document.documentElement.style.removeProperty('--help-panel-total-height');
    };
  }, [totalHeight]);

  return (
    <div
      className="box-border flex flex-shrink-0 flex-col px-1"
      data-help-panel-root="true"
      style={{
        height: totalHeight,
        transition: reducedMotion || isDragging ? undefined : SIDEBAR_FOOTER_HEIGHT_TRANSITION,
      }}
    >
      {/* Resize handle - always at top */}
      <ResizeHandle
        onMouseDown={handleMouseDown}
        orientation="horizontal"
        className="mx-3 bg-transparent"
      />

      <div className="flex min-h-0 flex-1 flex-col justify-end">
        <AnimatePresence
          initial={false}
        >
          {isOpen ? (
            <motion.div
              key="help-panel-card"
              initial={panelMotion.initial}
              animate={panelMotion.animate}
              exit={panelMotion.exit}
              transition={panelMotion.transition}
              style={SIDEBAR_FOOTER_PANEL_STYLE}
              className="mb-2 flex min-h-0 flex-1 flex-col overflow-hidden rounded-[16px] border border-black/[0.06] bg-[var(--oa-surface-center)] shadow-[0_8px_30px_rgba(0,0,0,0.08)] dark:border-white/[0.08] dark:shadow-[0_10px_32px_rgba(0,0,0,0.4)]"
            >
            {/* File preview mode: thumbnail + metadata (only when showPreview is enabled) */}
            {showPreview && displayInfo.description !== 'Folder' && (thumbnailUrl || thumbnailLoading) ? (
              <>
                <div className="flex items-center justify-between px-3 pt-3">
                  <div className="min-w-0">
                    <div className="truncate text-ui-sm font-medium text-[#202123] dark:text-[#f5f5f5]">
                      {displayInfo.title}
                    </div>
                    <div className="text-ui-xs text-[#6b7280] dark:text-[#b4b4b4]">
                      {displayInfo.description}
                    </div>
                  </div>
                  <Button
                    onClick={() => setIsOpen(false)}
                    variant="ghost"
                    size="icon-toolbar"
                    className="flex-shrink-0 text-[#6b7280] hover:bg-black/[0.045] hover:text-[#202123] dark:text-[#b4b4b4] dark:hover:bg-white/[0.06] dark:hover:text-[#f5f5f5]"
                  >
                    <X />
                  </Button>
                </div>

                <div className="flex-1 min-h-0 overflow-hidden px-3 py-2">
                  {thumbnailLoading ? (
                    <div className="flex h-full items-center justify-center text-ui-xs text-[#6b7280] dark:text-[#b4b4b4]">{t('panel.help.loading')}</div>
                  ) : thumbnailUrl ? (
                    (() => {
                      const ext = displayInfo.filePath?.split('.').pop()?.toLowerCase() || '';
                      const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext);
                      return (
                        <img
                          src={thumbnailUrl}
                          alt={displayInfo.title}
                          className={isImage
                            ? "mx-auto block h-full max-h-full max-w-full rounded-[12px] object-contain"
                            : "h-full w-full rounded-[12px] object-cover object-top"
                          }
                        />
                      );
                    })()
                  ) : null}
                </div>

                <div className="flex flex-shrink-0 items-center justify-between px-3 pb-3 text-ui-xs text-[#6b7280] dark:text-[#b4b4b4]">
                  <span className="truncate">{displayInfo.description}</span>
                  {fileStats && (
                    <span className="pl-3">
                      {fileStats.isDirectory
                        ? t('panel.help.items', { count: fileStats.itemCount ?? 0 })
                        : fileStats.lineCount !== null
                          ? t('panel.help.lines', { count: fileStats.lineCount })
                          : fileStats.size !== null
                            ? formatFileSize(fileStats.size)
                            : null
                      }
                    </span>
                  )}
                </div>
              </>
            ) : (
              /* Simple mode: filename as title, description + metadata below */
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-3 py-3">
                <div className="mb-2 flex flex-shrink-0 items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-ui-sm font-medium text-[#202123] dark:text-[#f5f5f5]">
                      {displayInfo.title}
                    </div>
                    {fileStats && (
                      <div className="mt-0.5 text-ui-xs text-[#6b7280] dark:text-[#b4b4b4]">
                        {fileStats.isDirectory
                          ? t('panel.help.items', { count: fileStats.itemCount ?? 0 })
                          : fileStats.lineCount !== null
                            ? t('panel.help.lines', { count: fileStats.lineCount })
                            : fileStats.size !== null
                              ? formatFileSize(fileStats.size)
                              : null
                        }
                      </div>
                    )}
                  </div>
                  <Button
                    onClick={() => setIsOpen(false)}
                    variant="ghost"
                    size="icon-toolbar"
                    className="flex-shrink-0 text-[#6b7280] hover:bg-black/[0.045] hover:text-[#202123] dark:text-[#b4b4b4] dark:hover:bg-white/[0.06] dark:hover:text-[#f5f5f5]"
                  >
                    <X />
                  </Button>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto">
                  <p className="text-ui-sm leading-relaxed text-[#6b7280] dark:text-[#b4b4b4]">
                    {displayInfo.description}
                  </p>
                </div>
              </div>
            )}
            </motion.div>
          ) : null}
        </AnimatePresence>

        <div className="flex-shrink-0 pb-1 pt-0.5">
          <div className="flex w-full items-center gap-1 px-0.5">
            <TooltipButton
              onClick={handleToggleSettings}
              variant="ghost"
              size="sm"
              aria-expanded={isSettingsActive}
              tooltip={isSettingsActive ? t('panel.help.closeSettings') : t('panel.help.openSettings')}
              helpDescription={t('panel.help.settingsDescription')}
              shortcut={formatPrimaryShortcut(',')}
              tooltipSide="top"
              className={SIDEBAR_FOOTER_ROW_PRIMARY_BUTTON_CLASSNAME}
            >
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <SidebarFooterAvatar avatarUrl={avatarUrl} displayName={displayName} isSignedOut={isSignedOut} />
                <span className="min-w-0 truncate text-ui-sm font-medium leading-tight">{displayName}</span>
                <KeyboardShortcutHint
                  shortcut=","
                  isCommandHeld={isCommandHeld}
                  activatedKey={activatedKey}
                  className="flex-shrink-0 text-[10px]"
                  activeClassName="text-[#202123]/56 dark:text-[#f5f5f5]/62"
                  inactiveClassName="text-[#5f6673]/75 dark:text-[#bdbdbd]/72"
                  heldClassName="text-[#5f6673]/88 dark:text-[#bdbdbd]/84"
                />
              </span>
            </TooltipButton>

            <FeedbackPopover className="ml-auto" />
          </div>
        </div>
      </div>
    </div>
  );
}
