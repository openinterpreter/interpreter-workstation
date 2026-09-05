/**
 * FileSystemProxy Component
 *
 * Universal component for representing files and folders throughout the app.
 * Used in tabs, mentions, explorer, and drag overlays.
 * Always shows thumbnail + filename for consistent visual representation.
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { X, Globe, Folder, Mail, FileText } from 'lucide-react';
import { Button } from './ui/button';
import { thumbnailCache } from './explorer/thumbnailCache';
import { cn } from '../lib/utils';
import {
  createFileDragData,
  createBrowserTabDragData,
  createEmailTabDragData,
  parseDragData,
  isFileDragData,
  isBrowserTabDragData,
} from '../../shared/types/drag';
import { getFileThumbnails, pathBasename, pathDirname, pathJoin, pathStartsWith } from '@/ipc';
import { filesService } from '../api/filesService';
import { clearActiveFileDragData, setActiveFileDragData } from '../utils/fileDragData';
import { getPreviewThumbnailData } from '../utils/fileThumbnail';
import { showFileReferenceContextMenu } from '../utils/fileReferenceContextMenu';

export interface FileSystemProxyProps {
  /** Absolute path to the file or folder (required for file/directory types) */
  path?: string | null | undefined;
  /** Display name (defaults to basename of path or title for browser/email tabs) */
  filename?: string;
  /** Type of entity */
  type?: 'file' | 'directory' | 'browser-tab' | 'email-tab';
  /** Visual variant */
  variant?: 'inline' | 'tab' | 'card' | 'grid';
  /** Click handler (open file/folder) */
  onClick?: () => void;
  /** Remove handler (for mentions) */
  onRemove?: () => void;
  /** Show full path/URL in tooltip */
  showPath?: boolean;
  /** Show the native browser tooltip. */
  showTooltip?: boolean;
  /** Show as deleted (for tabs) */
  isDeleted?: boolean;
  /** Show icon/thumbnail (defaults to true) */
  showIcon?: boolean;
  /** Additional CSS classes */
  className?: string;
  /** Test ID */
  testId?: string;
  /** Prefix element (e.g., chevron for tree view) */
  prefix?: React.ReactNode;
  /** Indentation level for tree view */
  indent?: number;
  /** Unique drag context identifier to prevent conflicts */
  dragContext?: string;
  /** Disable drag handling (useful when parent handles drag) */
  disableDrag?: boolean;
  /** Pre-loaded thumbnail data URL (avoids lazy loading) */
  thumbnail?: string;
  /** Modification time for cache busting */
  mtime?: number;
  /** URL for browser tabs */
  url?: string;
  /** Unique browser tab ID (UUID) for identifying specific tabs */
  browserId?: string;
  /** Favicon URL for browser tabs */
  faviconUrl?: string;
  /** Email ID for email tabs */
  emailId?: string;
  /** Additional class for close button (for CSS targeting) */
  closeButtonClassName?: string;
  /** Thumbnail width from server (for aspect ratio calculation) */
  thumbnailWidth?: number;
  /** Thumbnail height from server (for aspect ratio calculation) */
  thumbnailHeight?: number;
  /** Native file icon from server (fallback before thumbnail loads) */
  fileIcon?: string;
  /** Override icon rendering with a custom icon node */
  customIcon?: React.ReactNode;
  /** Skip auto-fetching thumbnails (viewport-aware loading handles it) */
  skipAutoFetch?: boolean;
  /** Whether the filename is being edited inline */
  isEditing?: boolean;
  /** Called when user submits the new name (Enter key) */
  onEditSubmit?: (newName: string) => void;
  /** Called when user cancels editing (Escape key or blur) */
  onEditCancel?: () => void;
  /** Test ID for the rename input */
  renameInputTestId?: string;
}

/**
 * Extract filename from path
 */
function getBasename(path: string | null | undefined): string {
  if (!path) {
    return 'Unknown';
  }
  return pathBasename(path) || path;
}

/**
 * Extract domain from URL for display
 */
function getDomainFromUrl(url: string | null | undefined): string {
  if (!url) {
    return 'Browser';
  }
  try {
    const urlObj = new URL(url);
    return urlObj.hostname || 'Browser';
  } catch {
    return url.slice(0, 30) || 'Browser';
  }
}

export function FileSystemProxy({
  path,
  filename,
  type = 'file',
  variant = 'card',
  onClick,
  onRemove,
  showPath = true,
  showTooltip = true,
  isDeleted = false,
  showIcon = true,
  className = '',
  testId,
  prefix,
  indent = 0,
  dragContext = 'default',
  disableDrag = false,
  thumbnail: thumbnailProp,
  mtime,
  url,
  browserId,
  faviconUrl,
  emailId,
  closeButtonClassName = '',
  thumbnailWidth: _thumbnailWidthProp,
  thumbnailHeight: _thumbnailHeightProp,
  fileIcon,
  customIcon,
  skipAutoFetch = false,
  isEditing = false,
  onEditSubmit,
  onEditCancel,
  renameInputTestId,
}: FileSystemProxyProps) {
  const isReadOnlySurface = typeof document !== 'undefined'
    && document.documentElement.dataset.remoteAccess === 'read-only';
  const shortPath = path ? pathBasename(path) : 'no-path';
  const [instanceId] = useState(() => Math.random().toString(36).slice(2, 6));

  const [thumbnailError, setThumbnailError] = useState(false);
  const [faviconError, setFaviconError] = useState(false);
  const [internalThumbnail, setInternalThumbnail] = useState<string | null>(() => {
    if (!path || type === 'directory' || type === 'browser-tab' || type === 'email-tab' || thumbnailProp) {
      // console.log(`[FSP:INIT] ${shortPath} #${instanceId} SKIP (type=${type} hasProp=${!!thumbnailProp})`);
      return null;
    }
    const cached = thumbnailCache.get(path);
    // console.log(`[FSP:INIT] ${shortPath} #${instanceId} cache=${cached ? 'HIT' : 'MISS'}`);
    return cached ?? null;
  });
  const [_internalWidth, setInternalWidth] = useState<number | null>(null);
  const [_internalHeight, setInternalHeight] = useState<number | null>(null);
  const prevPathRef = useRef<string | null | undefined>(null);

  // Fetch thumbnail internally when path is provided (skipped when skipAutoFetch is true)
  useEffect(() => {
    // console.log(`[FSP:EFFECT] ${shortPath} #${instanceId} START mtime=${mtime} skipAutoFetch=${skipAutoFetch}`);

    if (!path || type === 'directory' || type === 'browser-tab' || type === 'email-tab' || thumbnailProp) {
      // console.log(`[FSP:EFFECT] ${shortPath} #${instanceId} EARLY_EXIT`);
      return;
    }

    const filePath = path;

    // Check cache first
    const cached = thumbnailCache.get(filePath);
    if (cached) {
      // const isBlack = cached.length < 200;
      // console.log(`[FSP:EFFECT] ${shortPath} #${instanceId} CACHE_HIT len=${cached.length} isBlack=${isBlack}`);
      setInternalThumbnail(cached);
      setThumbnailError(false);
      return;
    }

    // Reset state only when path changes and not cached
    if (prevPathRef.current !== filePath) {
      // console.log(`[FSP:EFFECT] ${shortPath} #${instanceId} PATH_CHANGED: ${prevPathRef.current ? pathBasename(prevPathRef.current) : 'null'} -> ${shortPath} RESETTING_STATE`);
      setThumbnailError(false);
      setInternalThumbnail(null);
      prevPathRef.current = filePath;
    }

    // When skipAutoFetch is true, only subscribe to cache updates (viewport loading handles fetching)
    if (skipAutoFetch) {
      // console.log(`[FSP:EFFECT] ${shortPath} #${instanceId} SKIP_AUTO_FETCH - subscribing to cache only`);
      const unsubscribe = thumbnailCache.subscribe(filePath, (url) => {
        // const isBlack = url.length < 200;
        // console.log(`[FSP:SUBSCRIBE] ${shortPath} #${instanceId} GOT_NOTIFICATION len=${url.length} isBlack=${isBlack}`);
        setInternalThumbnail(url);
      });
      return unsubscribe;
    }

    // Subscribe if already loading
    if (thumbnailCache.isLoading(filePath)) {
      // console.log(`[FSP:EFFECT] ${shortPath} #${instanceId} SUBSCRIBING (already loading)`);
      const unsubscribe = thumbnailCache.subscribe(filePath, (url) => {
        // const isBlack = url.length < 200;
        // console.log(`[FSP:SUBSCRIBE] ${shortPath} #${instanceId} GOT_NOTIFICATION len=${url.length} isBlack=${isBlack}`);
        setInternalThumbnail(url);
      });
      return unsubscribe;
    }

    // Mark as loading and fetch
    // console.log(`[FSP:EFFECT] ${shortPath} #${instanceId} STARTING_FETCH`);
    thumbnailCache.markLoading(filePath);
    let cancelled = false;

    async function fetchThumbnail() {
      try {
        const { thumbnails } = await getFileThumbnails([filePath]);

        if (cancelled) {
          thumbnailCache.clearLoading(filePath);
          return;
        }

        const previewThumbnail = getPreviewThumbnailData(thumbnails[filePath]);

        if (previewThumbnail) {
          thumbnailCache.set(filePath, previewThumbnail.dataUrl);
          setInternalThumbnail(previewThumbnail.dataUrl);
          if (previewThumbnail.width) setInternalWidth(previewThumbnail.width);
          if (previewThumbnail.height) setInternalHeight(previewThumbnail.height);
        } else {
          setInternalThumbnail(null);
        }
        thumbnailCache.clearLoading(filePath);
      } catch (err) {
        // console.error(`[FSP:FETCH] ${shortPath} #${instanceId} ERROR:`, err);
        thumbnailCache.clearLoading(filePath);
      }
    }

    fetchThumbnail();

    return () => {
      // console.log(`[FSP:CLEANUP] ${shortPath} #${instanceId} UNMOUNTING`);
      cancelled = true;
    };
  }, [path, type, thumbnailProp, mtime, shortPath, instanceId, skipAutoFetch]);

  // Use prop if provided, otherwise use internally fetched thumbnail
  const thumbnail = thumbnailProp || internalThumbnail;

  // NOTE(victor): only for debugging thumbnail
  // const isBlack = thumbnail ? thumbnail.length < 200 : false;
  // if (type === 'file' && path) {
  //   console.log(`[FSP:RENDER] ${shortPath} #${instanceId} thumbnail=${thumbnail ? `len=${thumbnail.length} isBlack=${isBlack}` : 'null'}`);
  // }

  const isBrowserTab = type === 'browser-tab';
  const isEmailTab = type === 'email-tab';
  const displayName = filename || (isBrowserTab ? getDomainFromUrl(url) : isEmailTab ? '(no subject)' : getBasename(path));
  const tooltipText = showPath ? (isBrowserTab ? url : isEmailTab ? `Email: ${displayName}` : path) || displayName : displayName;
  const entityId = isBrowserTab ? browserId : isEmailTab ? emailId : path;

  // Native HTML5 drag state
  const [isDragging, setIsDragging] = useState(false);
  const [isOver, setIsOver] = useState(false);
  const nodeRef = useRef<HTMLDivElement>(null);

  // Native HTML5 drag start
  const handleDragStart = useCallback((e: React.DragEvent) => {
    if (disableDrag || isReadOnlySurface || !entityId) {
      e.preventDefault();
      return;
    }

    setIsDragging(true);

    // Create type-safe drag data
    let dragData = null;
    if (isBrowserTab && browserId && url) {
      dragData = createBrowserTabDragData(browserId, url, displayName, faviconUrl);
    } else if (isEmailTab && emailId) {
      dragData = createEmailTabDragData(emailId, displayName);
    } else if (path) {
      const sourceContext = dragContext === 'explorer'
        ? 'explorer'
        : dragContext === 'tabs'
          ? 'tabs'
          : 'unknown';
      dragData = createFileDragData(path, displayName, type === 'directory', sourceContext);
    }

    if (!dragData) {
      e.preventDefault();
      return;
    }

    e.dataTransfer.setData('application/json', JSON.stringify(dragData));
    if ('filePath' in dragData && !dragData.isDirectory) {
      setActiveFileDragData(dragData);
    }
    console.log('[file-drag-debug] file-system-proxy:dragstart', {
      dragContext,
      dragData,
      types: Array.from(e.dataTransfer.types ?? []),
    });
    // NOTE(victor): Use 'move' to prevent the browser showing a "+" cursor during drag.
    // 'copyMove' would show + by default until a drop target sets dropEffect='move'.
    e.dataTransfer.effectAllowed = 'move';

    // Set drag image (optional - uses element by default)
    if (nodeRef.current) {
      e.dataTransfer.setDragImage(nodeRef.current, 0, 0);
    }
  }, [disableDrag, isReadOnlySurface, entityId, isBrowserTab, isEmailTab, url, displayName, browserId, faviconUrl, emailId, path, type, dragContext]);

  const handleDragEnd = useCallback(() => {
    console.log('[file-drag-debug] file-system-proxy:dragend', {
      dragContext,
      path,
      type,
    });
    setIsDragging(false);
    clearActiveFileDragData();
  }, [dragContext, path, type]);

  // Native HTML5 drop target (for folders and files with external drops)
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (isReadOnlySurface) return;
    if (isBrowserTab || !path) return;

    const isExternal = e.dataTransfer.types.includes('Files') && !e.dataTransfer.types.includes('application/json');

    // Files only accept external drops, directories accept both
    if (type !== 'directory' && !isExternal) return;

    e.preventDefault();
    e.stopPropagation();
    setIsOver(true);
    e.dataTransfer.dropEffect = isExternal ? 'copy' : 'move';
  }, [type, isBrowserTab, isReadOnlySurface, path]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    if (isReadOnlySurface) return;
    e.preventDefault();
    e.stopPropagation();
    setIsOver(false);

    if (!path) return;

    // Check for external file drop (from Finder/Desktop)
    const isExternal = e.dataTransfer.files.length > 0 && !e.dataTransfer.getData('application/json');
    if (isExternal) {
      const files = Array.from(e.dataTransfer.files);
      const sourcePaths = files.map(file => window.electron?.getPathForFile?.(file)).filter(Boolean) as string[];
      const targetDir = type === 'directory' ? path : pathDirname(path);

      if (sourcePaths.length > 0) {
        filesService.copyExternal(sourcePaths, targetDir)
          .then((response) => {
            if (response.success) {
              window.dispatchEvent(new CustomEvent('explorer:expand-folder', {
                detail: { folderPath: path }
              }));
            } else {
              console.error('Failed to copy external files:', response.error);
            }
          })
          .catch((error) => {
            console.error('Error copying external files:', error);
          });
      }
      return;
    }

    // Internal drags only work on directories
    if (type !== 'directory') return;

    // Parse dropped data using type-safe parser (internal drag)
    const jsonData = e.dataTransfer.getData('application/json');
    if (!jsonData) return;

    const data = parseDragData(jsonData);
    if (!data) return;

    if (isFileDragData(data)) {
      // NOTE(victor): Explorer uses react-arborist onMove for internal drags - skip our handler to avoid conflicts.
      if (dragContext === 'explorer' && data.sourceContext === 'explorer') return;

      const sourcePath = data.filePath;
      const destFolder = path;

      if (sourcePath === destFolder) return;
      if (pathStartsWith(destFolder, sourcePath)) return;

      const sourceParent = pathDirname(sourcePath);
      if (sourceParent === destFolder) return;

      const fileName = pathBasename(sourcePath);
      const destPath = pathJoin(destFolder, fileName);

      filesService.move(sourcePath, destPath)
        .then((response) => {
          if (response.success) {
            window.dispatchEvent(new CustomEvent('explorer:expand-folder', {
              detail: { folderPath: destFolder }
            }));
          } else {
            alert(`Failed to move file: ${response.error}`);
          }
        })
        .catch((error) => {
          alert(`Error moving file: ${error.message}`);
        });
    } else if (isBrowserTabDragData(data)) {
      filesService.createBookmark(data.url, data.fileName || 'Bookmark', data.faviconUrl, path)
        .then((response) => {
          if (response.success) {
            window.dispatchEvent(new CustomEvent('explorer:expand-folder', {
              detail: { folderPath: path }
            }));
          }
        });
    }
  }, [type, path, dragContext, isReadOnlySurface]);

  // Context menu handler - defines items here, system handles rendering
  // When in Explorer (dragContext='explorer'), let ExplorerNode handle context menu
  // since it has more comprehensive options and proper inline rename
  const handleContextMenu = useCallback(async (e: React.MouseEvent) => {
    if (isReadOnlySurface) return;
    if (dragContext === 'explorer') return; // ExplorerNode has better context menu
    if (isBrowserTab || isEmailTab) return;
    if (!path) return;
    e.preventDefault();
    e.stopPropagation();

    await showFileReferenceContextMenu(path, 'file_system_proxy');
  }, [path, isBrowserTab, isEmailTab, dragContext, isReadOnlySurface]);

  // Size classes based on variant
  // Inline variant uses CSS variables for consistent spacing
  // Note: card variant gap is set via inline style to use CSS variable
  const sizeClasses = {
    inline: 'text-ui-sm',  // Height and padding set via inline style
    tab: 'gap-2 px-0 text-ui-sm',
    card: 'h-full px-2 text-ui-sm',
    grid: 'text-ui-sm',
  };

  const INDENT_WIDTH = 20;

  const containerClasses = `
    ${variant === 'card' ? 'flex' : variant === 'grid' ? 'flex' : 'inline-flex'} items-center
    ${variant === 'tab' ? '' : 'flex-shrink-0'}
    ${sizeClasses[variant]}
    ${variant === 'inline' ? 'rounded-control bg-background hover:opacity-80 min-w-0 max-w-full align-middle' : ''}
    ${variant === 'card' || variant === 'grid' ? 'select-none' : ''}
    ${isDeleted ? 'opacity-60' : ''}
    ${isDragging ? 'opacity-50' : ''}
    ${isOver && type === 'directory' ? '' : ''}
    ${className}
  `.trim();

  // Inline variant styles - styled to match content container but sized to fit inline with text
  // Negative vertical margin compensates for the mention being taller than text line height
  const inlineStyle: React.CSSProperties | undefined = variant === 'inline' ? {
    gap: 'var(--unit-padding-small)',
    paddingLeft: 'var(--unit-padding-small)',
    paddingRight: 'var(--unit-padding-small)',
    border: 'var(--border-width) solid var(--border)',
    boxShadow: 'var(--shadow-elevated)',
    verticalAlign: 'middle',
    marginTop: '-0.25em',
    marginBottom: '-0.1em',
    marginLeft: 'var(--mention-inline-margin-x, 0.2em)',
    marginRight: 'var(--mention-inline-margin-x, 0.2em)',
    maxWidth: '100%',
  } : undefined;

  const visualNode = customIcon ? (
    customIcon
  ) : type === 'directory' ? (
    <Folder className="text-muted-foreground" style={{ width: 'var(--icon-ui)', height: 'var(--icon-ui)' }} />
  ) : isEmailTab ? (
    <Mail className="text-muted-foreground" style={{ width: 'var(--icon-ui)', height: 'var(--icon-ui)' }} />
  ) : isBrowserTab ? (
    faviconUrl && !faviconError ? (
      <img
        src={faviconUrl}
        alt={displayName}
        className="block max-w-full max-h-full object-contain"
        onError={() => setFaviconError(true)}
        draggable={false}
      />
    ) : (
      <Globe className="text-muted-foreground" style={{ width: 'var(--icon-ui)', height: 'var(--icon-ui)' }} />
    )
  ) : (() => {
    const showFallback = thumbnailError || !path || !thumbnail;

    if (showFallback) {
      if (fileIcon) {
        return (
          <img
            src={fileIcon}
            alt={displayName}
            className="block w-full h-full object-contain"
            draggable={false}
          />
        );
      }
      return <FileText className="w-full h-full text-muted-foreground" />;
    }

    return (
      <img
        key={mtime ? `${path}-${mtime}` : path}
        src={thumbnail}
        alt={displayName}
        className="block w-full h-full object-contain"
        onError={() => {
          setThumbnailError(true);
        }}
        draggable={false}
      />
    );
  })();

  if (variant === 'grid') {
    const visualSurfaceClasses = type === 'directory' || isBrowserTab || isEmailTab || (!thumbnail && !fileIcon)
      ? 'bg-[var(--surface-secondary)]'
      : 'bg-[var(--muted)]/30';

    return (
      <div
        ref={nodeRef}
        className={cn(
          'group flex w-full max-w-[14rem] flex-col overflow-hidden rounded-control bg-background',
          className,
        )}
        onClick={onClick}
        onContextMenu={handleContextMenu}
        title={showTooltip ? tooltipText : undefined}
        data-testid={testId}
        data-type={type}
        data-path={path}
        data-url={isBrowserTab ? url : undefined}
        data-browser-id={isBrowserTab ? browserId : undefined}
        data-email-id={isEmailTab ? emailId : undefined}
        style={{
          opacity: isDragging ? 0.5 : 1,
          border: 'var(--border-width) solid var(--border)',
          boxShadow: 'var(--shadow-elevated)',
        }}
        draggable={!disableDrag && !isReadOnlySurface && !!entityId}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className={cn('flex aspect-[4/3] w-full items-center justify-center overflow-hidden px-3 py-3', visualSurfaceClasses)}>
          <div className="flex h-full w-full items-center justify-center overflow-hidden rounded-[calc(var(--control-radius)-2px)]">
            {React.isValidElement(visualNode)
              ? React.cloneElement(visualNode as React.ReactElement<{ className?: string }>, {
                className: cn(
                  'block h-full w-full',
                  type === 'directory' || isBrowserTab || isEmailTab ? 'object-contain p-6' : 'object-cover',
                  (visualNode.props as { className?: string }).className,
                ),
              })
              : visualNode}
          </div>
        </div>
        <div className="flex min-h-[3rem] items-start px-2.5 py-2">
          <span className={cn('line-clamp-2 leading-tight', isDeleted ? 'line-through' : '')}>
            {displayName}
          </span>
        </div>
      </div>
    );
  }

  return (
    <>
      <div
        ref={nodeRef}
        className={containerClasses}
        onClick={onClick}
        onContextMenu={handleContextMenu}
        title={showTooltip ? tooltipText : undefined}
        data-testid={testId}
        data-type={type}
        data-path={path}
        data-url={isBrowserTab ? url : undefined}
        data-browser-id={isBrowserTab ? browserId : undefined}
        data-email-id={isEmailTab ? emailId : undefined}
        style={{
          opacity: isDragging ? 0.5 : 1,
          paddingLeft: variant === 'card' ? `${indent * INDENT_WIDTH + 12}px` : undefined,
          gap: variant === 'card' ? 'var(--unit-padding)' : undefined,
          ...inlineStyle,
        }}
        draggable={!disableDrag && !isReadOnlySurface && !!entityId}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
      {/* Prefix element (chevron) - same size as thumbnail for alignment */}
      {prefix && (
        <div
          className="flex items-center justify-center flex-shrink-0"
          style={{ width: '14px', height: '14px' }}
        >
          {prefix}
        </div>
      )}

      {/* Icon slot - only for non-directory items or directories without prefix */}
      {showIcon && (type !== 'directory' || !prefix) && (
        <div
          className="flex items-center justify-center flex-shrink-0"
          style={{
            width: variant === 'tab' ? '18px' : '14px',
            height: variant === 'tab' ? '18px' : '14px',
          }}
        >
          {visualNode}
        </div>
      )}

      {/* Filename - editable textarea when isEditing, otherwise static text */}
      {isEditing ? (
        <textarea
          autoFocus
          defaultValue={displayName}
          data-testid={renameInputTestId}
          className="flex-1 min-w-0 bg-background text-foreground text-ui-sm px-1 py-0 rounded border border-primary outline-none resize-none overflow-hidden leading-tight"
          style={{
            minHeight: '1.4em',
            height: 'auto',
          }}
          rows={1}
          onFocus={(e) => {
            // Select filename without extension
            const lastDot = displayName.lastIndexOf('.');
            if (lastDot > 0) {
              e.currentTarget.setSelectionRange(0, lastDot);
            } else {
              e.currentTarget.select();
            }
            // Auto-resize to fit content
            e.currentTarget.style.height = 'auto';
            e.currentTarget.style.height = `${e.currentTarget.scrollHeight}px`;
          }}
          onChange={(e) => {
            // Auto-resize on content change
            e.currentTarget.style.height = 'auto';
            e.currentTarget.style.height = `${e.currentTarget.scrollHeight}px`;
          }}
          onBlur={() => onEditCancel?.()}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              onEditCancel?.();
            } else if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onEditSubmit?.(e.currentTarget.value);
            }
          }}
        />
      ) : (
        <span
          className={cn(
            variant === 'tab' ? 'whitespace-nowrap' : variant === 'inline' ? 'min-w-0 whitespace-normal' : 'truncate',
            isDeleted ? 'line-through' : '',
          )}
          style={variant === 'inline' ? { overflowWrap: 'anywhere' } : undefined}
        >
          {displayName}
        </span>
      )}

      {/* Remove button (for mentions) */}
      {onRemove && (
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className={`${closeButtonClassName} flex-shrink-0`}
          style={{ width: 'var(--icon-ui-small)', height: 'var(--icon-ui-small)' }}
          aria-label={`Remove ${displayName}`}
        >
          <X />
        </Button>
      )}
      </div>
    </>
  );
}
