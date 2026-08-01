import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { NodeRendererProps } from '../../lib/react-arborist';
import { useNodesContext } from '../../lib/react-arborist/context';
import { actions as dnd } from '../../lib/react-arborist/state/dnd-slice';
import { ChevronRight, ChevronDown, Clapperboard, Loader2, Play, Square } from 'lucide-react';
import { FileSystemProxy } from '../FileSystemProxy';
import { getFileHelp } from '../../contexts/HelpContext';
import { createFileDragData } from '../../../shared/types/drag';
import type { FileTreeNode } from './types';
import clsx from 'clsx';
import { isPointInAnyNativeDropTarget } from '../../utils/nativeDropTargets';
import { IndentGuides } from './IndentGuides';
import {
  isUnpackagedElectron,
  showContextMenu,
  showItemsInFolder,
  files,
  filePathToUri,
  pathBasename,
  pathDirname,
  pathJoin,
  projectRunner,
  type ContextMenuItem,
} from '@/ipc';
import { callTool } from '@/api';
import { useToast } from '../../contexts/ToastContext';
import { getConversionTargetsForPath, getPathExtension } from '../../../shared/utils/converterFormats';
import type { ProjectRunnerState } from '../../../shared/types/projectRunner';
import {
  AGENT_SIDEBAR_ID,
  EXPLORER_RENAME_INPUT_ID,
  FILE_TREE_ID,
  PANE_CONTENT_ANY_SELECTOR,
} from '../../../shared/element-ids';
import {
  clearActiveFileDragData,
  setActiveFileDragData,
  wasActiveFileDragHandled,
} from '../../utils/fileDragData';
import { Button } from '../ui/button';
import { useLayoutActions } from '../../hooks/useLayout';
import { getActiveFilePathSnapshot, subscribeActiveFilePath } from '../../stores/activeFileStore';

/**
 * NOTE(victor): CRITICAL!! DRAG AND DROP ARCHITECTURE - READ BEFORE MODIFYING
 * ============================================================================
 *
 * This file handles drag operations from the file explorer tree. There are TWO
 * incompatible drag systems that CANNOT coexist without issues:
 *
 *   1. HTML5 Drag API: dataTransfer.setData() for in-process drops
 *   2. Electron Native Drag: webContents.startDrag() for cross-process drops
 *
 * THE FUNDAMENTAL CONFLICT:
 * - startDrag() BLOCKS the main process until the drop completes
 * - Calling startDrag() synchronously during dragstart causes UI hangs
 * - Deferring startDrag() until cursor leaves *the renderer* needs extra detection for native overlays (iframes/WebContentsView)
 *
 * REQUIRED DRAG OPERATIONS AND THEIR MECHANISMS:
 * ┌─────────────────────────────────┬─────────────────────┬─────────────────────────────────┐
 * │ Operation                       │ Mechanism Required  │ Why                             │
 * ├─────────────────────────────────┼─────────────────────┼─────────────────────────────────┤
 * │ Tree → TipTap (agent composer)  │ HTML5 JSON data     │ ProseMirror reads dataTransfer  │
 * │ Tree → Agent panel (Thread.tsx) │ HTML5 JSON data     │ React onDrop reads dataTransfer │
 * │ Tree → Tab bar                  │ HTML5 JSON data     │ React onDrop reads dataTransfer │
 * │ Tab bar → Tree                  │ HTML5 JSON data     │ Arborist reads dataTransfer     │
 * │ Tree → OfficeExtension (iframe)      │ Native File objects │ desktop-stub.js reads .files    │
 * │ Tree → Webview                  │ Native File objects │ WebContentsView needs File API  │
 * │ Tree → External apps (Finder)   │ Native startDrag    │ Cross-process needs native drag │
 * └─────────────────────────────────┴─────────────────────┴─────────────────────────────────┘
 *
 * CONSTRAINT: NO UI HANGS
 * - startDrag() blocks until drop completes - if called during dragstart, UI freezes
 * - The "drops right after" bug occurs when native drag starts at current cursor position
 *
 * WHAT DOESN'T WORK:
 * 1. Synchronous startDrag() during dragstart → UI hangs until drop
 * 2. Deferred startDrag() on window leave only → Doesn't cover renderer-leave into iframes/WebContentsView (still "in window")
 * 3. Both HTML5 + native simultaneously → Two drag systems compete, unpredictable behavior
 *
 * CURRENT APPROACH (hybrid, leave-detected):
 * Always sets HTML5 data for in-app drops. For files, we *prepare* native drag, and only
 * call startDrag when the cursor leaves the renderer (external apps) OR enters a registered
 * native drop target region (Browser WebContentsView, OfficeExtension iframe).
 *
 * DO NOT play whack-a-mole with this code. Any change that fixes one target will
 * likely break another. The conflict is fundamental to Electron's drag architecture.
 *
 * Relevant Electron issues: #7118, #14430, #42252
 * Native OS drag CANNOT be automated in Playwright/Electron tests.
 *
 * MANUAL VERIFICATION CHECKLIST (use computer-use tools to verify):
 * [ ] Tree → TipTap (agent composer) - drag file, should create @mention
 * [ ] Tree → Agent panel - drag file to chat area
 * [ ] Tree → Tab bar - drag file to open as tab
 * [ ] Tree → OfficeExtension iframe - drag image into spreadsheet/doc
 * [ ] Tree → Embedded browser - drag file to webpage (e.g., file upload)
 * [ ] NO UI HANGS - drag operations should not freeze the UI
 */

interface ExplorerNodeProps extends NodeRendererProps<FileTreeNode> {
  workspacePath: string | null;
  onFileOpen: (path: string) => void;
  onAskAgent?: (items: ContextTargetItem[]) => void;
  onItemCreated?: (path: string, type: 'file' | 'directory') => void;
  onTreeMutated?: () => void;
  isLoading?: boolean;
  flashPath?: string | null;
}

interface ContextTargetItem {
  path: string;
  type: 'file' | 'directory';
  name: string;
}

function extractToolText(result: any): string {
  const content = result?.content;
  if (Array.isArray(content) && content[0] && typeof content[0].text === 'string') {
    return content[0].text;
  }
  return '';
}

function isPointInsideRect(clientX: number, clientY: number, rect: DOMRect): boolean {
  return (
    clientX >= rect.left
    && clientX <= rect.right
    && clientY >= rect.top
    && clientY <= rect.bottom
  );
}

function hasVisibleRect(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isHiddenPersistentPaneElement(element: HTMLElement): boolean {
  const persistentContainer = element.closest<HTMLElement>('[data-persistent-pane]');
  if (!persistentContainer) {
    return false;
  }
  return persistentContainer.getAttribute('data-persistent-visible') !== 'true';
}

function findDropSurfaceAtPoint(clientX: number, clientY: number): HTMLElement | null {
  const fileTree = document.querySelector<HTMLElement>(`[data-testid="${FILE_TREE_ID}"]`);
  if (fileTree && hasVisibleRect(fileTree) && isPointInsideRect(clientX, clientY, fileTree.getBoundingClientRect())) {
    return null;
  }

  const sidebar = document.querySelector<HTMLElement>(`[data-testid="${AGENT_SIDEBAR_ID}"]`);
  if (sidebar && hasVisibleRect(sidebar) && isPointInsideRect(clientX, clientY, sidebar.getBoundingClientRect())) {
    return sidebar;
  }

  const composer = Array.from(document.querySelectorAll<HTMLElement>('[data-file-drop-surface="composer"]'))
    .find((element) => (
      hasVisibleRect(element)
      && !isHiddenPersistentPaneElement(element)
      && isPointInsideRect(clientX, clientY, element.getBoundingClientRect())
    ));
  if (composer) {
    return composer;
  }

  const paneContent = Array.from(document.querySelectorAll<HTMLElement>(PANE_CONTENT_ANY_SELECTOR))
    .find((element) => (
      hasVisibleRect(element)
      && !isHiddenPersistentPaneElement(element)
      && isPointInsideRect(clientX, clientY, element.getBoundingClientRect())
    ));
  if (paneContent) {
    return paneContent;
  }

  const elementAtPoint = document.elementFromPoint(clientX, clientY);
  return elementAtPoint instanceof HTMLElement ? elementAtPoint : null;
}

function createSyntheticFileDropEvent(
  filePath: string,
  fileName: string,
  isDirectory: boolean,
  clientX: number,
  clientY: number,
): DragEvent {
  const dataTransfer = new DataTransfer();
  dataTransfer.effectAllowed = 'move';
  dataTransfer.setData('application/json', JSON.stringify(
    createFileDragData(filePath, fileName, isDirectory, 'explorer'),
  ));
  dataTransfer.setData('text/uri-list', filePathToUri(filePath));
  const event = new DragEvent('drop', {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
    dataTransfer,
  });
  (event as DragEvent & { __fileDragSynthetic?: boolean }).__fileDragSynthetic = true;
  return event;
}

function createSyntheticDragEvent(
  type: 'dragenter' | 'dragover' | 'dragleave' | 'drop',
  dataTransfer: DataTransfer,
  clientX: number,
  clientY: number,
): DragEvent {
  const event = new DragEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
    dataTransfer,
  });
  (event as DragEvent & { __fileDragSynthetic?: boolean }).__fileDragSynthetic = true;
  return event;
}

const PROJECT_ACTION_BUTTON_CLASSNAME = 'relative h-7 w-7 shrink-0 overflow-hidden rounded-full border border-black/[0.06] bg-black/[0.03] px-0 text-[#4b5563] shadow-[inset_0_1px_0_rgba(255,255,255,0.28)] transition-[width,background-color,color,border-color,box-shadow] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:w-[50px] hover:border-black/[0.1] hover:bg-black/[0.06] hover:text-[#111827] focus-visible:w-[50px] focus-visible:border-black/[0.12] focus-visible:bg-black/[0.06] dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-[#d1d5db] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] dark:hover:border-white/[0.14] dark:hover:bg-white/[0.09] dark:hover:text-[#f8f8f8] dark:focus-visible:border-white/[0.14] dark:focus-visible:bg-white/[0.09]';

export const ExplorerNode = React.memo(function ExplorerNode({
  node,
  style,
  dragHandle,
  workspacePath,
  onFileOpen,
  onAskAgent,
  onItemCreated,
  onTreeMutated,
  isLoading = false,
  flashPath,
}: ExplorerNodeProps) {
  "use no memo";

  const viteEnv = (import.meta as ImportMeta & {
    env?: {
      DEV?: boolean;
      VITE_ENABLE_DEV_VIDEO_TOOLING?: string;
    };
  }).env;
  const data = node.data;
  const fullPath = workspacePath ? pathJoin(workspacePath, data.path) : data.path;
  const helpInfo = getFileHelp(data.name, data.type);
  const storeActiveFilePath = useSyncExternalStore(
    subscribeActiveFilePath,
    getActiveFilePathSnapshot,
    getActiveFilePathSnapshot,
  );
  const isActive = data.type === 'file' && storeActiveFilePath === fullPath;
  const shouldFlash = flashPath === fullPath;
  const isRunnableProject = data.type === 'directory' && data.runnableProject?.kind === 'node-web-app';
  const canUseProjectRunner = isRunnableProject
    && typeof window !== 'undefined'
    && Boolean(window.electron?.projectRunner?.start);
  const isDevelopmentRenderer = Boolean(viteEnv?.DEV) || isUnpackagedElectron();
  const isDevVideoToolingAvailable = isUnpackagedElectron()
    && (Boolean(viteEnv?.DEV) || viteEnv?.VITE_ENABLE_DEV_VIDEO_TOOLING === '1');
  const isMovieAvailable = isDevVideoToolingAvailable
    && typeof window !== 'undefined'
    && !!window.electron?.files?.writeBinary;
  const isRemotionAvailable = isDevVideoToolingAvailable;
  const projectIcon = data.type === 'file' && (
    data.name.toLowerCase().endsWith('.movie')
    || (isRemotionAvailable && data.name.toLowerCase().endsWith('.remotion'))
  )
    ? <Clapperboard className="w-full h-full text-muted-foreground" />
    : undefined;
  const { showToast } = useToast();
  const { openBrowser } = useLayoutActions();
  const [projectRuntimeState, setProjectRuntimeState] = useState<ProjectRunnerState | null>(null);
  const projectStatus = projectRuntimeState?.status ?? 'stopped';
  const isProjectStarting = projectStatus === 'starting';
  const isProjectRunning = projectStatus === 'running';

  useEffect(() => {
    if (!canUseProjectRunner) {
      setProjectRuntimeState(null);
      return;
    }

    let cancelled = false;

    const loadStatus = async () => {
      try {
        const result = await projectRunner.getStatus(fullPath);
        if (!cancelled) {
          setProjectRuntimeState(result.state);
        }
      } catch (error) {
        if (!cancelled) {
          console.error('[ExplorerNode] Failed to load project status:', error);
          setProjectRuntimeState({
            projectPath: fullPath,
            status: 'stopped',
          });
        }
      }
    };

    void loadStatus();

    const unsubscribe = projectRunner.onChanged?.((event) => {
      if (!cancelled && event.state.projectPath === fullPath) {
        setProjectRuntimeState(event.state);
      }
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [canUseProjectRunner, fullPath]);

  // NOTE(victor): useNodesContext subscribes to drag state changes, triggering re-renders when drop target changes
  const nodesState = useNodesContext();
  const { destinationParentId } = nodesState.drag;
  const dropTargetId = destinationParentId !== '__REACT_ARBORIST_INTERNAL_ROOT__' ? destinationParentId : null;

  const isInDropTarget = (() => {
    if (!dropTargetId) return false;
    // NOTE(victor): Skip same-folder drops - no visual feedback for no-op moves
    const dragSourceParentId = node.tree.dragNodes[0]?.parent?.id ?? null;
    if (dropTargetId === dragSourceParentId) return false;
    let current: typeof node | null = node;
    while (current) {
      if (current.id === dropTargetId) return true;
      current = current.parent;
    }
    return false;
  })();

  // Intercept modifier clicks in the capture phase so they stay selection-only.
  const handleClickCapture = useCallback((e: React.MouseEvent) => {
    const isMac = navigator.platform.toLowerCase().includes('mac');
    const isToggleMultiSelect = e.metaKey || (!isMac && e.ctrlKey);
    if (isToggleMultiSelect) {
      e.preventDefault();
      e.stopPropagation();
      if (node.isSelected) {
        node.deselect();
      } else {
        node.selectMulti();
      }
      return;
    }

    if (e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      if (node.tree.hasNoSelection) {
        node.select();
      } else {
        node.selectContiguous();
      }
      return;
    }

  }, [node]);

  const isOverlayHandlingFileDrop = () => document.documentElement.dataset.fileDropOverlayActive === 'true';

  const handleChevronClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    node.toggle();
  }, [node]);

  const getContextTargetItems = useCallback((): ContextTargetItem[] => {
    const selectedNodes = node.tree.selectedNodes
      .filter((selectedNode: any) => (
        selectedNode?.data?.path &&
        (selectedNode.data.type === 'file' || selectedNode.data.type === 'directory')
      ))
      .map((selectedNode: any) => ({
        path: workspacePath ? pathJoin(workspacePath, selectedNode.data.path) : selectedNode.data.path,
        type: selectedNode.data.type as 'file' | 'directory',
        name: selectedNode.data.name as string,
      }));

    if (node.isSelected && selectedNodes.length > 0) {
      return selectedNodes;
    }

    return [{ path: fullPath, type: data.type, name: data.name }];
  }, [node, workspacePath, fullPath, data.type, data.name]);

  const getCommonConversionTargets = useCallback((items: ContextTargetItem[]): string[] => {
    if (items.length === 0 || !items.every((item) => item.type === 'file')) {
      return [];
    }

    const paths = items.map((item) => item.path);
    const firstTargets = getConversionTargetsForPath(paths[0]) ?? [];
    if (firstTargets.length === 0) {
      return [];
    }

    return firstTargets.filter((format) => {
      const formatLower = format.toLowerCase();
      const supportedByAll = paths.every((filePath) => {
        const targets = getConversionTargetsForPath(filePath) ?? [];
        return targets.includes(format);
      });
      if (!supportedByAll) {
        return false;
      }

      // Hide no-op conversions where every selected file already has this extension.
      return !paths.every((filePath) => getPathExtension(filePath) === `.${formatLower}`);
    });
  }, []);

  const handleContextMenu = useCallback(async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (!node.isSelected) {
      node.tree.select(node.id, { focus: false });
    }

    const contextTargets = getContextTargetItems();
    const hasMultipleTargets = contextTargets.length > 1;
    const conversionTargets = getCommonConversionTargets(contextTargets);

    const items: ContextMenuItem[] = [
      { label: 'Open', action: 'open' },
      { label: 'Ask Agent', action: 'ask-agent' },
      { label: '', action: '', separator: true },
      { label: 'New Note Here', action: 'new-note' },
      ...(isMovieAvailable ? [{ label: 'Create New Movie Here', action: 'new-movie' }] : []),
      ...(isRemotionAvailable ? [{ label: 'New Remotion Project Here', action: 'new-remotion' }] : []),
      ...(isDevelopmentRenderer ? [{ label: 'New Automation Here', action: 'new-automation' }] : []),
      { label: 'New Folder Here', action: 'new-folder' },
    ];

    if (conversionTargets.length > 0) {
      items.push({ label: '', action: '', separator: true });
      items.push({
        label: 'Convert',
        action: '',
        submenu: conversionTargets.map((format) => ({
          label: `To .${format}`,
          action: `convert:${format}`,
        })),
      });
    }

    items.push(
      { label: '', action: '', separator: true },
      { label: hasMultipleTargets ? `Move ${contextTargets.length} Items to Trash` : 'Move to Trash', action: 'trash' },
      { label: '', action: '', separator: true },
      { label: 'Rename', action: 'rename', disabled: hasMultipleTargets },
      { label: hasMultipleTargets ? `Duplicate ${contextTargets.length} Items` : 'Duplicate', action: 'duplicate' },
      { label: 'Copy', action: 'copy' },
      { label: '', action: '', separator: true },
      { label: hasMultipleTargets ? 'Copy Paths' : 'Copy Path', action: 'copy-path' },
      { label: 'Show in Finder', action: 'show-in-finder' },
    );

    const action = await showContextMenu(items, 'file_tree_node');
    const targetFiles = contextTargets.filter((item) => item.type === 'file');

    if (action === 'open') {
      contextTargets.forEach((item) => onFileOpen(item.path));
    } else if (action === 'ask-agent') {
      onAskAgent?.(contextTargets);
    } else if (action === 'new-note') {
      const targetFolder = data.type === 'directory' ? fullPath : pathDirname(fullPath);
      const result = await files.create('note', targetFolder);
      if (result.success && result.path) {
        // Use onItemCreated to reveal and enter edit mode, fallback to just opening
        if (onItemCreated) {
          onItemCreated(result.path, 'file');
        } else {
          onFileOpen(result.path);
        }
      }
    } else if (action === 'new-movie') {
      const targetFolder = data.type === 'directory' ? fullPath : pathDirname(fullPath);
      const result = await files.create('movie', targetFolder);
      if (result.success && result.path) {
        onFileOpen(result.path);
      }
    } else if (action === 'new-automation') {
      const targetFolder = data.type === 'directory' ? fullPath : pathDirname(fullPath);
      const result = await files.create('automation', targetFolder);
      if (result.success && result.path) {
        if (onItemCreated) {
          onItemCreated(result.path, 'file');
        } else {
          onFileOpen(result.path);
        }
      }
    } else if (action === 'new-remotion') {
      const targetFolder = data.type === 'directory' ? fullPath : pathDirname(fullPath);
      const result = await files.create('remotion', targetFolder);
      if (result.success && result.path) {
        if (onItemCreated) {
          onItemCreated(result.path, 'file');
        } else {
          onFileOpen(result.path);
        }
      }
    } else if (action === 'new-folder') {
      const targetFolder = data.type === 'directory' ? fullPath : pathDirname(fullPath);
      const result = await files.createFolder(targetFolder);
      if (result.success && result.path && onItemCreated) {
        onItemCreated(result.path, 'directory');
      }
    } else if (action === 'trash') {
      await Promise.all(contextTargets.map((item) => files.trash(item.path)));
      onTreeMutated?.();
    } else if (action === 'rename') {
      if (!hasMultipleTargets) {
        node.edit();
      }
    } else if (action === 'duplicate') {
      await Promise.all(contextTargets.map((item) => files.duplicate(item.path)));
      onTreeMutated?.();
    } else if (action === 'copy') {
      await navigator.clipboard.writeText(contextTargets.map((item) => item.path).join('\n'));
    } else if (action === 'copy-path') {
      await navigator.clipboard.writeText(contextTargets.map((item) => item.path).join('\n'));
    } else if (action === 'show-in-finder') {
      await showItemsInFolder(contextTargets.map((item) => item.path));
    } else if (action?.startsWith('convert:')) {
      const targetFormat = action.slice('convert:'.length).toLowerCase();
      let successCount = 0;
      let failureCount = 0;
      let firstError = '';

      for (const item of targetFiles) {
        try {
          const result = await callTool('builtin-converter', 'convert_file', {
            path: item.path,
            format: targetFormat,
          });

          if (result?.isError) {
            failureCount++;
            if (!firstError) {
              firstError = extractToolText(result) || `Failed converting ${item.name}`;
            }
            continue;
          }

          successCount++;
        } catch (error) {
          failureCount++;
          if (!firstError) {
            firstError = error instanceof Error ? error.message : `Failed converting ${item.name}`;
          }
        }
      }

      if (failureCount === 0) {
        showToast(
          `Converted ${successCount} ${successCount === 1 ? 'file' : 'files'} to .${targetFormat}`,
          'success',
          3000
        );
      } else {
        showToast(
          `Converted ${successCount}, failed ${failureCount}. ${firstError}`,
          'error',
          5000
        );
      }
    }
  }, [
    data.type,
    fullPath,
    getCommonConversionTargets,
    getContextTargetItems,
    isDevelopmentRenderer,
    isMovieAvailable,
    isRemotionAvailable,
    node,
    onFileOpen,
    onAskAgent,
    onItemCreated,
    onTreeMutated,
    showToast,
  ]);

  const handleProjectActionPointerDown = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  }, []);

  const handleProjectAction = useCallback(async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();

    if (!canUseProjectRunner || !isRunnableProject) {
      return;
    }

    if (isProjectStarting) {
      return;
    }

    if (isProjectRunning) {
      try {
        const result = await projectRunner.stop(fullPath);
        setProjectRuntimeState(result.state);
        if (!result.success && result.error) {
          showToast(result.error, 'error', 5000);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to stop the project.';
        showToast(message, 'error', 5000);
      }
      return;
    }

    setProjectRuntimeState({
      projectPath: fullPath,
      status: 'starting',
    });

    try {
      const result = await projectRunner.start(fullPath);
      setProjectRuntimeState(result.state);

      if (!result.success) {
        showToast(result.error ?? 'The project failed to start.', 'error', 5000);
        return;
      }

      if (result.state.status === 'running' && result.state.url) {
        openBrowser(result.state.url);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The project failed to start.';
      setProjectRuntimeState({
        projectPath: fullPath,
        status: 'error',
        error: message,
      });
      showToast(message, 'error', 5000);
    }
  }, [
    canUseProjectRunner,
    fullPath,
    isProjectRunning,
    isProjectStarting,
    isRunnableProject,
    openBrowser,
    showToast,
  ]);

  const expandTimerRef = useRef<number | null>(null);
  const dragCounterRef = useRef(0);

  const clearExpandTimer = useCallback(() => {
    if (expandTimerRef.current) {
      clearTimeout(expandTimerRef.current);
      expandTimerRef.current = null;
    }
    dragCounterRef.current = 0;
    document.removeEventListener('dragend', clearExpandTimer, true);
    document.removeEventListener('drop', clearExpandTimer, true);
    window.removeEventListener('blur', clearExpandTimer);
  }, []);

  const handleDragEnter = useCallback(() => {
    dragCounterRef.current++;
    if (data.type !== 'directory' || node.isOpen) return;
    if (expandTimerRef.current) return;

    // NOTE(victor): Clean up timer if drag ends without dragleave (e.g., drop on another window).
    document.addEventListener('dragend', clearExpandTimer, true);
    document.addEventListener('drop', clearExpandTimer, true);
    window.addEventListener('blur', clearExpandTimer);

    expandTimerRef.current = window.setTimeout(() => {
      expandTimerRef.current = null;
      node.open();
      clearExpandTimer();
    }, 600);
  }, [data.type, node, clearExpandTimer]);

  const handleDragLeave = useCallback(() => {
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      clearExpandTimer();
    }
  }, [clearExpandTimer]);

  const pendingNativeDragRef = useRef<string | null>(null);

  const handleDragStart = useCallback((e: React.DragEvent) => {
    // NOTE(victor): Create transparent drag preview - clone element without background or indent guides
    const clone = e.currentTarget.cloneNode(true) as HTMLElement;
    clone.style.background = 'transparent';
    clone.style.backgroundColor = 'transparent';
    // Reset all positioning from react-arborist's virtualized list
    clone.style.position = 'absolute';
    clone.style.top = '-9999px';
    clone.style.left = '0';
    clone.style.transform = 'none';
    clone.style.height = 'auto';
    clone.style.width = 'auto';
    // Remove indent guides from drag preview
    const indentGuides = clone.querySelector('[data-indent-guides]');
    if (indentGuides) {
      indentGuides.remove();
    }
    document.body.appendChild(clone);
    // NOTE(victor): offsetX/offsetY = cursor position relative to dragged element at drag start.
    // Using these as setDragImage offsets keeps cursor at the same relative position on the preview,
    // so the preview follows naturally from where user clicked rather than snapping to top-left corner.
    e.dataTransfer.setDragImage(clone, e.nativeEvent.offsetX, e.nativeEvent.offsetY);
    requestAnimationFrame(() => clone.remove());

    // NOTE(victor): Use 'move' to prevent green + cursor - all drop targets use 'move' consistently
    e.dataTransfer.effectAllowed = 'move';
    const dragData = createFileDragData(fullPath, data.name, data.type === 'directory', 'explorer');
    e.dataTransfer.setData('application/json', JSON.stringify(dragData));
    // NOTE(victor): Set text/uri-list so webviews (OfficeExtension, etc.) can receive proper file paths
    e.dataTransfer.setData('text/uri-list', filePathToUri(fullPath));
    console.log('[file-drag-debug] explorer:dragstart', {
      filePath: dragData.filePath,
      fileName: dragData.fileName,
      isDirectory: dragData.isDirectory,
      types: Array.from(e.dataTransfer.types ?? []),
    });
    if (!dragData.isDirectory) {
      setActiveFileDragData(dragData);
    }

    // For files, set up arborist state and prepare for potential native drag
    if (data.type === 'file' && workspacePath) {
      const tree = node.tree;
      const selectedIds = tree.selectedIds;
      const dragIds = tree.isSelected(node.id) ? Array.from(selectedIds) : [node.id];
      tree.dispatch(dnd.dragStart(node.id, dragIds));

      // Store path for deferred native drag - only triggers when cursor leaves window
      pendingNativeDragRef.current = fullPath;
      let nativeDragTimer: number | null = null;
      let lastClientX: number | null = null;
      let lastClientY: number | null = null;
      let didCleanup = false;
      let lastDropSurface: HTMLElement | null = null;
      let dispatchingSyntheticSurfaceEvent = false;
      
      // DO NOT TOUCH THIS COMMENT. WILL BE USED FOR LATER
      // NOTE(victor): On macOS, startDrag() doesn't block - call it immediately so dataTransfer.files
      // gets populated for native targets (OfficeExtension iframe, WebContentsView). On Windows/Linux,
      // startDrag() blocks until drop completes, so we defer it until cursor leaves the window.
      // const isMac = navigator.platform.toLowerCase().includes('mac');
      // if (isMac) {
      //   console.log('[DnD] macOS detected - calling startDrag immediately');
      //   window.electron.files.startDrag(fullPath);
      //   pendingNativeDragRef.current = null; // Clear since we already started native drag
      // }

      const startNativeDragNow = () => {
        if (!pendingNativeDragRef.current) return;
        if (nativeDragTimer) {
          clearTimeout(nativeDragTimer);
          nativeDragTimer = null;
        }
        window.electron.files.startDrag(pendingNativeDragRef.current);
        pendingNativeDragRef.current = null;
      };

      const resolveClientPoint = (evt: DragEvent) => {
        const clientX = evt.clientX === 0 && evt.clientY === 0 && lastClientX != null
          ? lastClientX
          : evt.clientX;
        const clientY = evt.clientX === 0 && evt.clientY === 0 && lastClientY != null
          ? lastClientY
          : evt.clientY;
        return { clientX, clientY };
      };

      const dispatchSyntheticSurfaceEvent = (
        target: HTMLElement,
        type: 'dragenter' | 'dragover' | 'dragleave' | 'drop',
        dataTransfer: DataTransfer,
        clientX: number,
        clientY: number,
      ) => {
        dispatchingSyntheticSurfaceEvent = true;
        let dispatchError: unknown = null;
        try {
          target.dispatchEvent(createSyntheticDragEvent(type, dataTransfer, clientX, clientY));
        } catch (error) {
          dispatchError = error;
        }
        dispatchingSyntheticSurfaceEvent = false;
        if (dispatchError) {
          throw dispatchError;
        }
      };

      const syncDropSurfaceHover = (
        target: HTMLElement | null,
        dataTransfer: DataTransfer,
        clientX: number,
        clientY: number,
      ) => {
        if (lastDropSurface === target) {
          if (target) {
            dispatchSyntheticSurfaceEvent(target, 'dragover', dataTransfer, clientX, clientY);
          }
          return;
        }

        if (lastDropSurface) {
          console.log('[file-drag-debug] explorer:surface-leave', {
            clientX,
            clientY,
            targetTestId: lastDropSurface.getAttribute('data-testid'),
            targetPath: lastDropSurface.getAttribute('data-path'),
          });
          dispatchSyntheticSurfaceEvent(lastDropSurface, 'dragleave', dataTransfer, clientX, clientY);
        }

        lastDropSurface = target;
        if (!target) {
          return;
        }

        console.log('[file-drag-debug] explorer:surface-enter', {
          clientX,
          clientY,
          targetTestId: target.getAttribute('data-testid'),
          targetPath: target.getAttribute('data-path'),
        });
        dispatchSyntheticSurfaceEvent(target, 'dragenter', dataTransfer, clientX, clientY);
        dispatchSyntheticSurfaceEvent(target, 'dragover', dataTransfer, clientX, clientY);
      };

      const handleDocumentDragOver = (evt: DragEvent) => {
        if (dispatchingSyntheticSurfaceEvent) return;

        // Some layers (e.g. ProseMirror) can emit synthetic drag events with 0,0 coordinates.
        // Track the last non-zero position so we can use it when dragleave reports 0,0.
        if (evt.clientX !== 0 || evt.clientY !== 0) {
          lastClientX = evt.clientX;
          lastClientY = evt.clientY;
        }

        if ((evt as DragEvent & { __fileDragSynthetic?: boolean }).__fileDragSynthetic || isOverlayHandlingFileDrop()) {
          return;
        }

        if (!evt.dataTransfer || !pendingNativeDragRef.current) {
          return;
        }

        const { clientX, clientY } = resolveClientPoint(evt);
        const isInsideWindow = (
          clientX >= 0
          && clientY >= 0
          && clientX <= window.innerWidth
          && clientY <= window.innerHeight
        );
        const isOverNativeDropTarget = isPointInAnyNativeDropTarget(clientX, clientY);
        const target = isInsideWindow && !isOverNativeDropTarget
          ? findDropSurfaceAtPoint(clientX, clientY)
          : null;

        syncDropSurfaceHover(target, evt.dataTransfer, clientX, clientY);

        if (!target) {
          return;
        }

        evt.preventDefault();
        evt.dataTransfer.dropEffect = 'move';
      };

      const handleDragLeave = (evt: DragEvent) => {
        if ((evt as DragEvent & { __fileDragSynthetic?: boolean }).__fileDragSynthetic || isOverlayHandlingFileDrop()) {
          return;
        }

        // Only trigger native drag when actually leaving the document
        // relatedTarget is null when leaving document, non-null when moving between elements
        if (!evt.relatedTarget) {
          let clientX = evt.clientX;
          let clientY = evt.clientY;
          if (clientX === 0 && clientY === 0 && lastClientX !== null && lastClientY !== null) {
            clientX = lastClientX;
            clientY = lastClientY;
          }

          const isOutsideWindow =
            clientX < 0 ||
            clientY < 0 ||
            clientX > window.innerWidth ||
            clientY > window.innerHeight;

          const isOverNativeDropTarget = isPointInAnyNativeDropTarget(clientX, clientY);

          // Trigger native drag when leaving the renderer (external apps) OR entering a native drop target
          // like WebContentsView/iframes (BrowserView, OfficeExtension).
          if (isOverNativeDropTarget) {
            startNativeDragNow();
            return;
          }

          // Keep the existing delayed start when leaving the app window. This avoids occasional
          // "drop right after" behavior when starting the native drag at the exact boundary.
          if (isOutsideWindow) {
            if (pendingNativeDragRef.current && !nativeDragTimer) {
              nativeDragTimer = window.setTimeout(() => {
                startNativeDragNow();
              }, 50);
            }
          }
        }
      };

      const cleanup = () => {
        if (didCleanup) return;
        didCleanup = true;
        console.log('[file-drag-debug] explorer:cleanup');
        if (nativeDragTimer) {
          clearTimeout(nativeDragTimer);
          nativeDragTimer = null;
        }
        if (lastDropSurface) {
          const syntheticDataTransfer = new DataTransfer();
          syntheticDataTransfer.effectAllowed = 'move';
          syntheticDataTransfer.setData('application/json', JSON.stringify(dragData));
          syntheticDataTransfer.setData('text/uri-list', filePathToUri(dragData.filePath));
          dispatchSyntheticSurfaceEvent(
            lastDropSurface,
            'dragleave',
            syntheticDataTransfer,
            lastClientX ?? 0,
            lastClientY ?? 0,
          );
          lastDropSurface = null;
        }
        clearActiveFileDragData();
        pendingNativeDragRef.current = null;
        document.removeEventListener('dragleave', handleDragLeave, true);
        document.removeEventListener('dragover', handleDocumentDragOver, true);
        document.removeEventListener('drop', handleDocumentDrop, true);
        document.removeEventListener('dragend', handleDocumentDragEnd);
      };

      const handleDocumentDrop = (evt: DragEvent) => {
        if ((evt as DragEvent & { __fileDragSynthetic?: boolean }).__fileDragSynthetic || isOverlayHandlingFileDrop()) {
          return;
        }

        if (dispatchingSyntheticSurfaceEvent || !evt.dataTransfer) {
          cleanup();
          return;
        }

        const { clientX, clientY } = resolveClientPoint(evt);
        const isInsideWindow = (
          clientX >= 0
          && clientY >= 0
          && clientX <= window.innerWidth
          && clientY <= window.innerHeight
        );
        const isOverNativeDropTarget = isPointInAnyNativeDropTarget(clientX, clientY);
        const target = isInsideWindow && !isOverNativeDropTarget
          ? findDropSurfaceAtPoint(clientX, clientY)
          : null;

        console.log('[file-drag-debug] explorer:document-drop', {
          clientX,
          clientY,
          hasTarget: Boolean(target),
          targetTestId: target?.getAttribute('data-testid') ?? null,
          targetPath: target?.getAttribute('data-path') ?? null,
        });

        if (target && pendingNativeDragRef.current && !wasActiveFileDragHandled()) {
          evt.preventDefault();
          evt.stopPropagation();
          dispatchSyntheticSurfaceEvent(target, 'drop', evt.dataTransfer, clientX, clientY);
        }

        cleanup();
      };

      const handleDocumentDragEnd = (evt: DragEvent) => {
        const { clientX, clientY } = resolveClientPoint(evt);
        const isInsideWindow = (
          clientX >= 0
          && clientY >= 0
          && clientX <= window.innerWidth
          && clientY <= window.innerHeight
        );
        const isOverNativeDropTarget = isPointInAnyNativeDropTarget(clientX, clientY);

        if (wasActiveFileDragHandled()) {
          console.log('[file-drag-debug] explorer:synthetic-drop:skip-handled', {
            clientX,
            clientY,
          });
        } else if (!pendingNativeDragRef.current) {
          console.log('[file-drag-debug] explorer:synthetic-drop:skip-native', {
            clientX,
            clientY,
          });
        } else if (!isInsideWindow) {
          console.log('[file-drag-debug] explorer:synthetic-drop:skip-outside-window', {
            clientX,
            clientY,
          });
        } else if (isOverNativeDropTarget) {
          console.log('[file-drag-debug] explorer:synthetic-drop:skip-native-target', {
            clientX,
            clientY,
          });
        } else {
          const target = findDropSurfaceAtPoint(clientX, clientY);
          if (!target) {
            console.log('[file-drag-debug] explorer:synthetic-drop:no-target', {
              clientX,
              clientY,
            });
          } else {
            console.log('[file-drag-debug] explorer:synthetic-drop:dispatch', {
              clientX,
              clientY,
              filePath: dragData.filePath,
              fileName: dragData.fileName,
              isDirectory: dragData.isDirectory,
              targetTag: target.tagName,
              targetTestId: target.getAttribute('data-testid'),
              targetPath: target.getAttribute('data-path'),
            });
            target.dispatchEvent(createSyntheticFileDropEvent(
              dragData.filePath,
              dragData.fileName,
              dragData.isDirectory,
              clientX,
              clientY,
            ));
          }
        }

        cleanup();
      };

      document.addEventListener('dragleave', handleDragLeave, true);
      document.addEventListener('dragover', handleDocumentDragOver, true);
      document.addEventListener('drop', handleDocumentDrop, true);
      document.addEventListener('dragend', handleDocumentDragEnd);
    }
  }, [fullPath, data.name, data.type, workspacePath, node]);


  useEffect(() => {
    return () => {
      clearExpandTimer();
    };
  }, [clearExpandTimer]);

  const attachNodeRef = useCallback((el: HTMLDivElement | null) => {
    // NOTE(victor): Arborist's dragHandle can be callback or ref object - handle both.
    if (typeof dragHandle === 'function') {
      dragHandle(el);
    } else if (dragHandle && typeof (dragHandle as any) === 'object') {
      (dragHandle as any).current = el;
    }

    if (!el) return;
    if (!el.dataset.hovered) {
      el.dataset.hovered = 'false';
    }
  }, [dragHandle]);

  const renderChevron = () => {
    if (data.type !== 'directory') return null;

    return (
      <div
        onClick={handleChevronClick}
        className="flex size-4 flex-shrink-0 items-center justify-center rounded-[6px] text-[#8c8f96] transition-colors duration-150 group-hover:text-[#4b5563] dark:text-[#8c8c8c] dark:group-hover:text-[#b4b4b4]"
      >
        {isLoading ? (
          <span>{'\u22EF'}</span>
        ) : node.isOpen ? (
          <ChevronDown size={10} />
        ) : (
          <ChevronRight size={10} />
        )}
      </div>
    );
  };

  const renderProjectAction = () => {
    if (!canUseProjectRunner || !isRunnableProject) {
      return null;
    }

    const label = isProjectRunning ? 'Stop' : 'Run';
    const ariaLabel = isProjectStarting
      ? `Starting ${data.name}`
      : `${label} ${data.name}`;

    return (
      <div className="absolute right-2 top-1/2 flex w-[50px] -translate-y-1/2 justify-end">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={isProjectStarting}
          aria-label={ariaLabel}
          title={ariaLabel}
          className={PROJECT_ACTION_BUTTON_CLASSNAME}
          onPointerDown={handleProjectActionPointerDown}
          onClick={handleProjectAction}
        >
          {isProjectStarting ? (
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <Loader2 className="size-3 animate-spin" />
            </span>
          ) : (
            <>
              <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center whitespace-nowrap pl-2 transition-transform duration-150 ease-out -translate-x-1 group-hover:translate-x-0 group-focus-visible/button:translate-x-0">
                <span className="text-ui-sm font-medium leading-none opacity-0 transition-opacity duration-75 ease-out group-hover:delay-100 group-hover:opacity-100 group-focus-visible/button:delay-100 group-focus-visible/button:opacity-100">
                  {label}
                </span>
              </span>
              <span className="pointer-events-none absolute inset-y-0 right-0 flex w-7 items-center justify-center">
                {isProjectRunning ? <Square className="size-3" /> : <Play className="size-3 fill-current" />}
              </span>
            </>
          )}
        </Button>
      </div>
    );
  };

  // Helper for extension change confirmation
  const getExtension = useCallback((name: string) => {
    const lastDot = name.lastIndexOf('.');
    return lastDot > 0 ? name.slice(lastDot) : '';
  }, []);

  const handleEditSubmit = useCallback((newName: string) => {
    const oldExt = getExtension(data.name);
    const newExt = getExtension(newName);

    if (oldExt && newExt !== oldExt) {
      const confirmed = window.confirm(
        `Are you sure you want to change the extension from "${oldExt}" to "${newExt || '(none)'}"?\n\nThis may make the file unusable.`
      );
      if (!confirmed) {
        return;
      }
    }

    node.submit(newName);
  }, [data.name, getExtension, node]);

  const handleEditCancel = useCallback(() => {
    node.reset();
  }, [node]);

  return (
    <div
      ref={attachNodeRef}
      className={clsx(
        'group relative flex h-full w-full items-center rounded-[10px] px-1 transition-[background-color,color,box-shadow] duration-150',
        isActive
          ? 'bg-white text-[#202123] shadow-[0_1px_2px_rgba(0,0,0,0.04)] dark:bg-[#212121] dark:text-[#f5f5f5]'
          : node.isSelected
            ? 'text-[#202123] dark:text-[#f5f5f5]'
            : 'text-[#5f6368] hover:text-[#202123] dark:text-[#b4b4b4] dark:hover:text-[#f5f5f5]',
        isInDropTarget && 'bg-black/[0.06] dark:bg-white/[0.07]',
        shouldFlash && 'animate-ring-reveal',
      )}
      style={style}
      role="treeitem"
      aria-expanded={data.type === 'directory' ? node.isOpen : undefined}
      aria-level={node.level + 1}
      aria-selected={node.isSelected}
      data-path={fullPath}
      data-name={pathBasename(fullPath)}
      data-help-title={helpInfo.title}
      data-help-description={helpInfo.description}
      data-help-item-type={helpInfo.itemType}
      draggable={node.isDraggable}
      onClickCapture={handleClickCapture}
      onContextMenu={handleContextMenu}
      onDragStart={handleDragStart}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={clearExpandTimer}
      onPointerEnter={(e) => { (e.currentTarget as HTMLDivElement).dataset.hovered = 'true'; }}
      onPointerLeave={(e) => { (e.currentTarget as HTMLDivElement).dataset.hovered = 'false'; }}
    >
      <IndentGuides level={node.level} />
      <FileSystemProxy
        path={fullPath}
        filename={data.name}
        type={data.type}
        variant="card"
        dragContext="explorer"
        indent={node.level}
        mtime={data.mtime}
        thumbnailWidth={data.thumbnailWidth}
        thumbnailHeight={data.thumbnailHeight}
        fileIcon={data.fileIcon}
        customIcon={projectIcon}
        disableDrag={true}
        skipAutoFetch={true}
        showPath={false}
        className={clsx('w-full', canUseProjectRunner ? 'pr-16' : 'pr-3')}
        prefix={renderChevron()}
        isEditing={node.isEditing}
        onEditSubmit={handleEditSubmit}
        onEditCancel={handleEditCancel}
        renameInputTestId={EXPLORER_RENAME_INPUT_ID}
      />
      {renderProjectAction()}
    </div>
  );
});
