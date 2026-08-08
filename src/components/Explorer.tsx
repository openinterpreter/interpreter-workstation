import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Tree, TreeApi, NodeApi, NodeRendererProps } from '../lib/react-arborist';
import { actions as dnd } from '../lib/react-arborist/state/dnd-slice';
import { actions as visibility } from '../lib/react-arborist/state/open-slice';
import { getWorkspace, getWorkspaceFiles, getFolderChildren } from '../api';
import { FileSearchResults, type FileSearchResultsRef } from './FileSearchResults';
import { ChevronDown, X } from 'lucide-react';
import { ExplorerNode } from './explorer/ExplorerNode';
import type { FileTreeNode } from './explorer/types';
import { markResolvedDirs } from '../../shared/utils/fileTreeTransform';
import { setFileCache, clearFileCache, FileEntry } from '../stores/fileStore';
import type { SearchItem } from '../hooks/useFileSearch';
import { useContentSearch } from '../hooks/useContentSearch';
import { useVaultSearch } from '../hooks/useVaultSearch';
import type { WorkspaceContentMatch, RecentWorkspaceFolder, DetectedNoteWorkspace } from '../api';
import { detectNoteWorkspaces, getDetectedNoteWorkspaces, getRecentWorkspaces } from '../api';
import { ContextMenu } from './ContextMenu';
import { useHelp } from '../contexts/HelpContext';
import { WorkspaceLanding } from './WorkspaceLanding';
import { useActiveFilePath } from '../contexts/LayoutContext';
import { useLayoutActions } from '../hooks/useLayout';
import { EXPLORER_ID, FILE_TREE_ID, EXPLORER_SEARCH_INPUT_ID, WORKSPACE_PICKER_BUTTON_ID } from '../../shared/element-ids';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { KeyboardShortcutHint } from './ui/keyboard-shortcut-hint';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { useViewportThumbnails } from '../hooks/useViewportThumbnails';
import { filesService } from '../api/filesService';
import { appendWindowSessionKey, isAbsolutePath, isBrowserDevMode, isUnpackagedElectron, getServerPort as getServerPortFromIpc, workspace, showContextMenu, openFolderDialog, showItemInFolder, files as filesIpc, pathBasename, pathDirname, pathJoin, pathSplit, pathStartsWith, pathStripPrefix, type ContextMenuItem } from '@/ipc';
import type { WorkspaceFilesChangedEvent } from '../../electron/ipc/registry';
import { useCommandOverlay } from '../contexts/CommandOverlayContext';
import { useToast } from '../contexts/ToastContext';
import type { FolderTreeNode } from '../../shared/types/folder';
import { formatPrimaryShortcut, getShortcutPlatform } from '../utils/platformShortcuts';
import { buildWorkspacePickerMenuItems, getRevealInFileManagerLabel } from '../utils/workspacePickerMenu';
import { isMarketingDemoMode } from '../demo/marketingDemo';
import type { VaultSearchResult } from '../../shared/types/vault';
import {
  AGENT_SEED_COMPOSER_EVENT,
  enqueuePendingAgentComposerSeed,
  type AgentSeedComposerDetail,
} from '../../shared/agentEvents';
import { buildExplorerAgentSearchPrompt, buildExplorerAskAgentPrompt, type ExplorerAgentReferenceItem } from '../utils/explorerAgentSearch';
import { readJsonSseStream } from '../utils/sseStream';

const INDENT = 0;

function getRowHeight(): number {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--unit-element-height-small').trim();
  return parseInt(value, 10) || 24;
}

// Stable function references for Tree props to avoid re-render cascades.
// react-arborist's TreeProvider spreads all props into a useMemo dependency array,
// so inline arrow functions cause every RowContainer to re-render on every frame.
const childrenAccessor = (node: FileTreeNode) => node.children ?? null;
const renderCursorNull = () => null;

type WorkspaceFilesStreamEvent =
  | { progress: number; done?: false }
  | { done: true; files: FileTreeNode[]; progress?: number };

interface ExplorerProps {
  onFileOpen: (path: string) => void;
  filterQuery?: string; // Optional filter query for file/folder names
  compactMode?: boolean; // Optional compact mode for use in dropdowns
  hideSearchBar?: boolean; // Hide the search bar (e.g., for mention dropdowns)
  autoExpandAll?: boolean; // Start with all folders expanded (e.g., for mention dropdowns)
  rootPath?: string | null; // Optional fixed root folder (renders explorer for that folder instead of the workspace)
}

function folderNodesToFileTree(nodes: FolderTreeNode[], rootPath: string): FileTreeNode[] {
  return markResolvedDirs(nodes.map((node) => ({
    name: node.name,
    path: pathStripPrefix(node.path, rootPath),
    type: node.type,
    mtime: node.mtime,
    ...(node.runnableProject ? { runnableProject: node.runnableProject } : {}),
    children: node.children ? folderNodesToFileTree(node.children, rootPath) : undefined,
  })));
}

// Inner component that has access to HelpContext
function ExplorerContent({
  onFileOpen,
  filterQuery,
  compactMode: _compactMode = false,
  hideSearchBar = false,
  autoExpandAll = false,
  rootPath: rootPathOverride = null,
}: ExplorerProps) {
  "use no memo";

  const viteEnv = (import.meta as ImportMeta & {
    env?: {
      DEV?: boolean;
      VITE_ENABLE_DEV_VIDEO_TOOLING?: string;
    };
  }).env;
  const { t } = useTranslation();
  const { isHelpPanelOpen, setIsHelpPanelOpen, setHelpPanelHeight } = useHelp();
  const { isCommandHeld, activatedKey } = useCommandOverlay();
  const isDevelopmentRenderer = Boolean(viteEnv?.DEV) || isUnpackagedElectron();
  const isDevVideoToolingAvailable = isUnpackagedElectron()
    && (Boolean(viteEnv?.DEV) || viteEnv?.VITE_ENABLE_DEV_VIDEO_TOOLING === '1');
  const isRemotionAvailable = isDevVideoToolingAvailable;
  const isMovieAvailable = isDevVideoToolingAvailable
    && typeof window !== 'undefined'
    && !!window.electron?.files?.writeBinary;
  const runtimePlatform = getShortcutPlatform();
  const openFolderShortcutLabel = formatPrimaryShortcut('O');
  const hasFixedRoot = !!rootPathOverride;
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [files, setFiles] = useState<FileTreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [loadProgress, setLoadProgress] = useState(0);
  const { showToast } = useToast();
  const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(null);
  const treeRef = useRef<TreeApi<FileTreeNode>>(null);
  const scrollOffsetRef = useRef(0);
  const treeContainerRef = useRef<HTMLDivElement | null>(null);
  // Stable ref callback — inline ref callbacks create new functions every render,
  // causing React to call them with null then element, which triggers setState
  // twice per render and creates an infinite re-render loop.
  const treeContainerRefCallback = useCallback((node: HTMLDivElement | null) => {
    setScrollContainer(node);
    treeContainerRef.current = node;
  }, []);
  const [containerHeight, setContainerHeight] = useState(400);
  const [loadingFolders, setLoadingFolders] = useState<Set<string>>(new Set());

  // Track expanded folders to restore them after tree reload
  const expandedFoldersRef = useRef<Set<string>>(new Set());

  // Track current files for synchronous access (avoids async calls inside setState)
  const filesRef = useRef<FileTreeNode[]>([]);

  // Track files/folders that should enter edit mode after being revealed (newly created)
  const pendingEditRef = useRef<string | null>(null);

  // Track pending folder to reveal and edit (folders don't have activeFilePath)
  const [pendingFolderEdit, setPendingFolderEdit] = useState<string | null>(null);
  // Ref mirror for synchronous access in loadFilesPreservingScroll
  const pendingFolderEditRef = useRef<string | null>(null);
  // Flag to indicate we're about to create an item (set BEFORE async create, prevents scroll restore)
  const pendingCreationRef = useRef<boolean>(false);

  // Edge scroll state for drag operations
  const edgeScrollIntervalRef = useRef<number | null>(null);
  const currentMouseYRef = useRef(0);

  // Workspace picker popover state (opened from the breadcrumb / change-folder button).
  const [pickerMenuPos, setPickerMenuPos] = useState<{ x: number; y: number } | null>(null);
  const suppressWorkspacePickerOpenRef = useRef(false);
  const [recentFolders, setRecentFolders] = useState<RecentWorkspaceFolder[]>([]);
  const [noteWorkspaces, setNoteWorkspaces] = useState<DetectedNoteWorkspace[]>([]);
  const [isScanningNoteWorkspaces, setIsScanningNoteWorkspaces] = useState(false);

  // Search state for the search bar
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchResultsRef = useRef<FileSearchResultsRef>(null);
  const isSearching = searchQuery.length > 0;

  // Get active file path for highlighting
  const activeFilePath = useActiveFilePath();
  const { openNewTab, openSeededAgentTab, setLeftSidebarOpen, setLeftSidebarTab, updateTabPath } = useLayoutActions();

  // Drag state for file tree drop zone
  const [isTreeDragOver, setIsTreeDragOver] = useState(false);

  // Track if tree is scrolled (for breadcrumb border)
  const [isScrolled, setIsScrolled] = useState(false);

  const [flashPath, setFlashPath] = useState<string | null>(null);
  const flashTimerRef = useRef<number | null>(null);

  // Track multi-selected node relative paths for the selection overlay
  const [selectedRelPaths, setSelectedRelPaths] = useState<Set<string>>(new Set());

  // Viewport-aware thumbnail loading
  const { onVisiblePathsChange } = useViewportThumbnails({ workspacePath });

  // Edge scroll during drag - constants and functions
  const EDGE_THRESHOLD = 60;
  const MAX_SCROLL_SPEED = 15;

  const loadDirectoryChildren = useCallback(async (relativePath: string) => {
    if (rootPathOverride) {
      const fullPath = pathJoin(rootPathOverride, relativePath);
      const result = await filesIpc.listDirectory(fullPath);
      if (!result.success) {
        throw new Error(result.error || 'Failed to load folder children');
      }
      return folderNodesToFileTree(result.entries ?? [], rootPathOverride);
    }

    const result = await getFolderChildren(relativePath);
    return markResolvedDirs(result.children);
  }, [rootPathOverride]);

  const getEdgeScrollSpeed = useCallback((distanceFromEdge: number): number => {
    if (distanceFromEdge >= EDGE_THRESHOLD) return 0;
    const ratio = 1 - (distanceFromEdge / EDGE_THRESHOLD);
    return Math.round(MAX_SCROLL_SPEED * ratio * ratio);
  }, []);

  const performEdgeScroll = useCallback(() => {
    if (!treeContainerRef.current) return;

    const container = treeContainerRef.current;
    const rect = container.getBoundingClientRect();

    const distFromTop = currentMouseYRef.current - rect.top;
    const distFromBottom = rect.bottom - currentMouseYRef.current;

    let scrollY = 0;

    if (distFromTop < EDGE_THRESHOLD && distFromTop > 0) {
      scrollY = -getEdgeScrollSpeed(distFromTop);
    } else if (distFromBottom < EDGE_THRESHOLD && distFromBottom > 0) {
      scrollY = getEdgeScrollSpeed(distFromBottom);
    }

    if (scrollY !== 0) {
      container.scrollTop += scrollY;
    }
  }, [getEdgeScrollSpeed]);

  const startEdgeScroll = useCallback(() => {
    if (edgeScrollIntervalRef.current !== null) return;
    edgeScrollIntervalRef.current = window.setInterval(performEdgeScroll, 16);
  }, [performEdgeScroll]);

  const stopEdgeScroll = useCallback(() => {
    if (edgeScrollIntervalRef.current !== null) {
      clearInterval(edgeScrollIntervalRef.current);
      edgeScrollIntervalRef.current = null;
    }
  }, []);

  const handleTreeDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsTreeDragOver(true);

    currentMouseYRef.current = e.clientY;
    startEdgeScroll();

    const isExternal = e.dataTransfer.types.includes('Files') && !e.dataTransfer.types.includes('application/json');
    e.dataTransfer.dropEffect = isExternal ? 'copy' : 'move';
  }, [startEdgeScroll]);

  const handleTreeDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsTreeDragOver(false);
    stopEdgeScroll();
  }, [stopEdgeScroll]);

  const handleTreeDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsTreeDragOver(false);
    stopEdgeScroll();

    if (!workspacePath) return;

    // Handle external file drop (from Finder/Desktop)
    if (e.dataTransfer.files.length > 0 && !e.dataTransfer.getData('application/json')) {
      const files = Array.from(e.dataTransfer.files);
      const sourcePaths = files.map(file => window.electron?.getPathForFile?.(file)).filter(Boolean) as string[];

      if (sourcePaths.length > 0) {
        filesService.copyExternal(sourcePaths, workspacePath)
          .then((response) => {
            if (response.success) {
              if (hasFixedRoot) {
                void loadFilesPreservingScroll();
              } else {
                window.dispatchEvent(new CustomEvent('workspace:refresh'));
              }
            } else {
              console.error('Failed to copy external files:', response.error);
            }
          })
          .catch((error) => {
            console.error('Error copying external files:', error);
          });
      }
    }
  }, [hasFixedRoot, workspacePath, stopEdgeScroll]);

  // Reveal an item in the explorer tree (expand parents, scroll to it, optionally expand if folder)
  const revealInTree = useCallback(async (fullPath: string, options?: { expand?: boolean; scrollAlign?: 'center' | 'smart' }) => {
    if (!workspacePath || !treeRef.current) return;
    if (!pathStartsWith(fullPath, workspacePath)) return;

    const relativePath = pathStripPrefix(fullPath, workspacePath);
    const segments = pathSplit(relativePath);
    let currentPath = '';

    // Expand parent folders first
    for (let i = 0; i < segments.length - 1; i++) {
      currentPath = currentPath ? pathJoin(currentPath, segments[i]) : segments[i];
      const node = treeRef.current?.get(currentPath);

      if (!node) return;

      // Load children if needed
      if (node.data.type === 'directory' && node.data.children === undefined) {
        try {
          const children = await loadDirectoryChildren(currentPath);
          setFiles(prevFiles => {
            const updateChildren = (nodes: FileTreeNode[]): FileTreeNode[] => {
              return nodes.map(n => {
                if (n.path === currentPath) {
                  return { ...n, children, isResolved: true };
                }
                if (n.children) {
                  return { ...n, children: updateChildren(n.children) };
                }
                return n;
              });
            };
            return updateChildren(prevFiles);
          });
          await new Promise(r => setTimeout(r, 50));
        } catch (error) {
          console.error('[Explorer] Failed to load folder children:', error instanceof Error ? error.message : error);
          return;
        }
      }

      // Open the folder if it's closed
      if (!node.isOpen) {
        node.open();
        expandedFoldersRef.current.add(currentPath);
        await new Promise(r => setTimeout(r, 100));
      }
    }

    // Scroll to the item
    await treeRef.current?.scrollTo(relativePath, options?.scrollAlign || 'smart');

    // Optionally expand if it's a folder
    if (options?.expand) {
      const node = treeRef.current?.get(relativePath);
      if (node && node.data.type === 'directory' && !node.isOpen) {
        // Load children first if needed (same pattern as parent expansion)
        if (node.data.children === undefined) {
          try {
            const children = await loadDirectoryChildren(relativePath);
            setFiles(prevFiles => {
              const updateChildren = (nodes: FileTreeNode[]): FileTreeNode[] => {
                return nodes.map(n => {
                  if (n.path === relativePath) {
                    return { ...n, children, isResolved: true };
                  }
                  if (n.children) {
                    return { ...n, children: updateChildren(n.children) };
                  }
                  return n;
                });
              };
              return updateChildren(prevFiles);
            });
            await new Promise(r => setTimeout(r, 50));
          } catch (error) {
            console.error('[Explorer] Failed to load folder children:', error instanceof Error ? error.message : error);
          }
        }
        node.open();
        expandedFoldersRef.current.add(relativePath);
      }
    }

    return treeRef.current?.get(relativePath);
  }, [workspacePath]);

  // Handle search result selection
  const handleSearchSelect = useCallback(async (item: SearchItem) => {
    if (item.type === 'browser-tab' && item.browserId) {
      // Open browser tab - use layout context
      const layoutContext = (window as any).__layoutContext;
      if (layoutContext?.openBrowser && item.url) {
        layoutContext.openBrowser(item.url);
      }
    } else if (item.type === 'directory' && item.path) {
      onFileOpen(item.path);
    } else if (item.path) {
      // Open file - system results will trigger the outside-workspace banner
      onFileOpen(item.path);
    }
    // Clear search after selection
    setSearchQuery('');
    searchInputRef.current?.blur();
  }, [onFileOpen]);

  // Handle keyboard events in search input
  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setSearchQuery('');
      searchInputRef.current?.blur();
      return;
    }

    // Forward navigation keys to search results
    if (isSearching && searchResultsRef.current) {
      const handled = searchResultsRef.current.onKeyDown(e.nativeEvent);
      if (handled) {
        e.preventDefault();
      }
    }
  }, [isSearching]);

  const { matches: contentMatches, loading: contentSearchLoading } = useContentSearch(searchQuery);
  const { matches: vaultMatches, loading: vaultSearchLoading } = useVaultSearch(searchQuery);

  const switchWorkspaceTo = useCallback(async (path: string) => {
    try {
      console.log('[WorkspaceSwitch] ui-requested', {
        source: 'explorer',
        workspacePath: path,
      });
      const result = await workspace.set({ workspacePath: path });
      console.log('[WorkspaceSwitch] ui-result', {
        source: 'explorer',
        workspacePath: path,
        success: result.success,
      });
    } catch (err) {
      console.error('[Explorer] Failed to change workspace:', err);
    }
  }, []);

  const loadWorkspacePickerData = useCallback(() => {
    getRecentWorkspaces().then((data) => setRecentFolders(data.folders)).catch(() => {});
    getDetectedNoteWorkspaces().then((data) => setNoteWorkspaces(data.workspaces)).catch(() => {});
  }, []);

  const handleScanNoteWorkspaces = useCallback(async () => {
    const reopenAt = pickerMenuPos;
    setIsScanningNoteWorkspaces(true);
    try {
      const data = await detectNoteWorkspaces();
      setNoteWorkspaces(data.workspaces);
      if (reopenAt) {
        setPickerMenuPos(reopenAt);
      }
    } catch (err) {
      console.error('[Explorer] Failed to scan for note workspaces:', err);
    } finally {
      setIsScanningNoteWorkspaces(false);
    }
  }, [pickerMenuPos]);

  const openWorkspacePickerFromElement = useCallback((anchor: HTMLElement | null) => {
    if (!anchor) return;
    if (suppressWorkspacePickerOpenRef.current) {
      suppressWorkspacePickerOpenRef.current = false;
      return;
    }
    const rect = anchor.getBoundingClientRect();
    setPickerMenuPos({ x: rect.left, y: rect.bottom + 4 });
    loadWorkspacePickerData();
  }, [loadWorkspacePickerData]);

  const handleWorkspacePickerMouseDown = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (!pickerMenuPos) return;
    suppressWorkspacePickerOpenRef.current = true;
    event.preventDefault();
    event.stopPropagation();
    setPickerMenuPos(null);
  }, [pickerMenuPos]);

  const handlePickerOpenFolder = useCallback(async () => {
    setPickerMenuPos(null);
    const result = await openFolderDialog();
    if (!result.canceled && result.filePaths.length > 0) {
      await switchWorkspaceTo(result.filePaths[0]);
    }
  }, [switchWorkspaceTo]);

  const handleSelectContentMatch = useCallback((match: WorkspaceContentMatch) => {
    onFileOpen(match.path);
    // Scroll to the matched line once the editor is mounted.
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('mention:scroll-to', {
        detail: { path: match.path, lineStart: match.line },
      }));
    }, 300);
    setSearchQuery('');
    searchInputRef.current?.blur();
  }, [onFileOpen]);

  const handleRunAgentSearch = useCallback((query: string) => {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      return;
    }

    openSeededAgentTab(buildExplorerAgentSearchPrompt(trimmedQuery), { preferFastProfile: true });
    setSearchQuery('');
  }, [openSeededAgentTab]);

  const seedAgentComposer = useCallback((tabId: string, prompt: string, autoSend: boolean) => {
    const detail: AgentSeedComposerDetail = {
      agentId: tabId,
      prompt,
      autoSend,
    };
    enqueuePendingAgentComposerSeed(detail);

    const composer = document.querySelector(`[data-agent-id="${tabId}"] [contenteditable="true"]`);
    if (!composer) {
      return;
    }

    window.dispatchEvent(new CustomEvent(AGENT_SEED_COMPOSER_EVENT, { detail }));
  }, []);

  const handleAskAgentAboutItems = useCallback((items: ExplorerAgentReferenceItem[]) => {
    const prompt = buildExplorerAskAgentPrompt(items);
    if (!prompt) {
      return;
    }

    const tabId = openNewTab();
    seedAgentComposer(tabId, prompt, false);
  }, [openNewTab, seedAgentComposer]);

  // Listen for focus-explorer-search custom event (CMD+K from menu)
  // This is the single entry point for focusing the search bar
  // The menu handles CMD+K and opens the sidebar before dispatching this event
  useEffect(() => {
    const handleFocusSearch = () => {
      // Small delay to ensure sidebar is open before focusing
      setTimeout(() => {
        searchInputRef.current?.focus();
      }, 100);
    };

    window.addEventListener('focus-explorer-search', handleFocusSearch);
    return () => window.removeEventListener('focus-explorer-search', handleFocusSearch);
  }, []);

  useEffect(() => {
    const handleSetSearchQuery = (event: Event) => {
      const customEvent = event as CustomEvent<{ query?: string; focus?: boolean }>;
      const nextQuery = customEvent.detail?.query ?? '';
      setLeftSidebarTab('explorer');
      setLeftSidebarOpen(true);
      setSearchQuery(nextQuery);
      if (customEvent.detail?.focus !== false) {
        window.setTimeout(() => {
          searchInputRef.current?.focus();
        }, 100);
      }
    };

    window.addEventListener('explorer:set-search-query', handleSetSearchQuery as EventListener);
    return () => {
      window.removeEventListener('explorer:set-search-query', handleSetSearchQuery as EventListener);
    };
  }, [setLeftSidebarOpen, setLeftSidebarTab]);

  useEffect(() => {
    return () => {
      if (edgeScrollIntervalRef.current !== null) {
        clearInterval(edgeScrollIntervalRef.current);
      }
    };
  }, []);

  // Filter files based on query
  const filteredFiles = React.useMemo(() => {
    if (!filterQuery || filterQuery.trim() === '') {
      return files;
    }

    const query = filterQuery.toLowerCase();

    // Recursively filter tree
    const filterTree = (nodes: FileTreeNode[]): FileTreeNode[] => {
      return nodes
        .map(node => {
          // Check if node name matches
          const nameMatches = node.name.toLowerCase().includes(query);

          // Check if path matches
          const pathMatches = node.path.toLowerCase().includes(query);

          // If directory, recursively filter children
          if (node.type === 'directory' && node.children) {
            const filteredChildren = filterTree(node.children);

            // Include directory if it matches or has matching children
            if (nameMatches || pathMatches || filteredChildren.length > 0) {
              return {
                ...node,
                children: filteredChildren,
              };
            }
            return null;
          }

          // Include file if it matches
          if (nameMatches || pathMatches) {
            return node;
          }

          return null;
        })
        .filter((node): node is FileTreeNode => node !== null);
    };

    return filterTree(files);
  }, [files, filterQuery]);

  const refreshFixedRootTree = useCallback(() => {
    if (!hasFixedRoot) {
      return;
    }

    void loadFilesPreservingScroll();
  }, [hasFixedRoot, rootPathOverride]);

  useEffect(() => {
    if (hasFixedRoot && rootPathOverride) {
      expandedFoldersRef.current.clear();
      setWorkspacePath(rootPathOverride);
      void loadFixedRoot(rootPathOverride);
      return;
    }

    loadWorkspace();

    // Listen for workspace change events from IPC
    const unsubscribers: Array<() => void> = [];

    const unsubscribeChanged = workspace.onChanged((event: { workspacePath: string | null }) => {
      // Clear file cache immediately to prevent stale files showing in mentions
      clearFileCache();
      setWorkspacePath(event.workspacePath);
      if (event.workspacePath) {
        // Pass explicit workspace to avoid React state timing issues
        loadFiles(event.workspacePath);
      } else {
        setFiles([]);
      }
    });
    unsubscribers.push(unsubscribeChanged);

    // Listen for file system change events
    const unsubscribeFilesChanged = workspace.onFilesChanged((event: WorkspaceFilesChangedEvent) => {
      // If we have a specific file path and it's a change event, do surgical update
      if (event.path && event.eventType === 'change' && event.mtime) {
        handleFileChanged(event.path, event.mtime);
      } else if (event.path && (event.eventType === 'add' || event.eventType === 'addDir')) {
        // For add events, check if node already exists (optimistic update)
        // NOTE(victor): Use ref for synchronous access - avoids async call inside setState
        const nodeExists = findNodeByPath(filesRef.current, event.path);
        if (nodeExists && event.mtime) {
          // NOTE(victor): Windows atomic rename (fs.rename) reports 'create' instead of 'update'.
          // The watcher always includes mtime for file 'add' events (fileWatcher.ts:162), but the
          // type is optional since other WORKSPACE_FILES_CHANGED emitters may omit it.
          handleFileChanged(event.path, event.mtime);
        } else if (!nodeExists) {
          // Node doesn't exist (external add), reload tree
          loadFilesPreservingScroll();
        }
      } else if (event.path && (event.eventType === 'unlink' || event.eventType === 'unlinkDir')) {
        // For delete events, remove the node from tree surgically instead of full reload
        setFiles(currentFiles => {
          const removeNode = (nodes: FileTreeNode[]): FileTreeNode[] => {
            return nodes
              .filter(node => node.path !== event.path)
              .map(node => ({
                ...node,
                children: node.children ? removeNode(node.children) : undefined
              }));
          };
          return removeNode(currentFiles);
        });
      } else {
        // Otherwise, reload the entire tree
        loadFilesPreservingScroll();
      }
    });
    unsubscribers.push(unsubscribeFilesChanged);

    return () => {
      unsubscribers.forEach(unsub => unsub());
    };
  }, [hasFixedRoot, rootPathOverride]); // Empty in workspace mode; re-run when fixed root changes

  useEffect(() => {
    if (!hasFixedRoot || !rootPathOverride) {
      return;
    }

    const handleFocus = () => {
      void loadFilesPreservingScroll();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void loadFilesPreservingScroll();
      }
    };
    const unsubscribe = workspace.onFilesChanged((event: WorkspaceFilesChangedEvent) => {
      if (!event.path || !isAbsolutePath(event.path)) {
        return;
      }
      if (event.path === rootPathOverride || pathStartsWith(event.path, rootPathOverride)) {
        void loadFilesPreservingScroll();
      }
    });

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      unsubscribe();
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [hasFixedRoot, rootPathOverride]);

  // Keep filesRef in sync with files state for synchronous access
  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  // Sync file cache whenever files state changes (for search and @ mentions)
  useEffect(() => {
    if (!workspacePath || files.length === 0 || hasFixedRoot) return;

    const flatFiles: FileEntry[] = [];
    const flatten = (nodes: FileTreeNode[]) => {
      for (const node of nodes) {
        flatFiles.push({
          path: pathJoin(workspacePath, node.path),
          name: node.name,
          type: node.type,
        });
        if (node.children) {
          flatten(node.children);
        }
      }
    };
    flatten(files);
    setFileCache(flatFiles);
  }, [files, hasFixedRoot, workspacePath]);

  useEffect(() => {
    if (!scrollContainer) return;
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerHeight(entry.contentRect.height);
      }
    });
    resizeObserver.observe(scrollContainer);
    return () => resizeObserver.disconnect();
  }, [scrollContainer]);

  const recalculateVisiblePaths = useCallback(() => {
    const tree = treeRef.current;
    if (!tree || !workspacePath) return;

    const visibleNodes = tree.visibleNodes;
    const scrollOffset = scrollOffsetRef.current;
    const rowHeight = getRowHeight();
    const startIndex = Math.max(0, Math.floor(scrollOffset / rowHeight) - 5);
    const endIndex = Math.min(
      visibleNodes.length,
      Math.ceil((scrollOffset + containerHeight) / rowHeight) + 5
    );

    const paths = visibleNodes
      .slice(startIndex, endIndex)
      .filter(n => n.data?.type === 'file' && n.data?.path)
      .map(n => pathJoin(workspacePath!, n.data.path));

    onVisiblePathsChange(paths);
  }, [containerHeight, workspacePath, onVisiblePathsChange]);

  // Compute bounding overlay for multi-selected items via DOM measurement.
  // Position is relative to the outer wrapper div (flex-1 relative overflow-hidden).
  const [selectionOverlay, setSelectionOverlay] = useState<{ top: number; height: number } | null>(null);

  const updateSelectionOverlay = useCallback(() => {
    if (selectedRelPaths.size < 2 || !treeRef.current) {
      setSelectionOverlay(null);
      return;
    }
    const visibleNodes = treeRef.current.visibleNodes;
    const rowHeight = getRowHeight();
    const scrollOffset = scrollOffsetRef.current;

    let minIndex = Infinity;
    let maxIndex = -Infinity;
    for (let i = 0; i < visibleNodes.length; i++) {
      if (selectedRelPaths.has(visibleNodes[i].data.path)) {
        if (i < minIndex) minIndex = i;
        if (i > maxIndex) maxIndex = i;
      }
    }
    if (minIndex === Infinity) {
      setSelectionOverlay(null);
      return;
    }
    const top = minIndex * rowHeight - scrollOffset;
    const height = (maxIndex - minIndex + 1) * rowHeight;
    setSelectionOverlay({ top, height });
  }, [selectedRelPaths]);

  // Update overlay when selection changes
  useEffect(() => {
    updateSelectionOverlay();
  }, [updateSelectionOverlay, filteredFiles]);

  const handleScroll = useCallback(({ scrollOffset }: { scrollOffset: number }) => {
    scrollOffsetRef.current = scrollOffset;
    setIsScrolled(scrollOffset > 0);
    recalculateVisiblePaths();
    updateSelectionOverlay();
  }, [recalculateVisiblePaths, updateSelectionOverlay]);

  const handleToggle = useCallback(async (id: string) => {
    const node = treeRef.current?.get(id);
    if (!node) {
      return;
    }

    // Track expanded/collapsed folders in ref (survives closures and reloads)
    // NOTE(victor): onToggle fires AFTER react-arborist updates internal state,
    // so node.isOpen reflects the NEW state, not the previous state
    if (node.data.type === 'directory') {
      if (node.isOpen) {
        expandedFoldersRef.current.add(node.data.path);
        if (!hasFixedRoot) {
          // Start watching folder for external changes (addWatch is idempotent)
          workspace.addWatch(node.data.path).catch(() => {});
        }
      } else {
        expandedFoldersRef.current.delete(node.data.path);
        if (!hasFixedRoot) {
          // Stop watching collapsed folder to free up file descriptors
          workspace.removeWatch(node.data.path).catch(() => {});
        }
      }
    }

    // NOTE(victor): Must check isResolved, NOT children === undefined. File watcher
    // sets children: [] for new directories, and [] !== undefined bypasses the fetch.
    if (node.data.type === 'directory' && node.isOpen && !node.data.isResolved) {
      setLoadingFolders(prev => new Set(prev).add(id));
      try {
        const children = await loadDirectoryChildren(node.data.path);
        setFiles(prevFiles => {
          const updateChildren = (nodes: FileTreeNode[]): FileTreeNode[] => {
            return nodes.map(n => {
              if (n.path === node.data.path) {
                return { ...n, children, isResolved: true };
              }
              if (n.children) {
                return { ...n, children: updateChildren(n.children) };
              }
              return n;
            });
          };
          return updateChildren(prevFiles);
        });
      } catch (error) {
        console.error('[Explorer] Failed to load folder children:', error instanceof Error ? error.message : error);
      } finally {
        setLoadingFolders(prev => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    }

    // Trigger thumbnail loading for newly visible files after tree re-renders
    setTimeout(() => {
      recalculateVisiblePaths();
    }, 50);
  }, [hasFixedRoot, loadDirectoryChildren, recalculateVisiblePaths]);

  const collapseAll = useCallback(() => {
    if (!treeRef.current) return;
    if (!hasFixedRoot) {
      expandedFoldersRef.current.forEach(p => workspace.removeWatch(p).catch(() => {}));
    }
    expandedFoldersRef.current.clear();
    treeRef.current.dispatch(visibility.clear(treeRef.current.isFiltered));
    if (treeContainerRef.current) treeContainerRef.current.scrollTop = 0;
    setTimeout(() => recalculateVisiblePaths(), 50);
  }, [hasFixedRoot, recalculateVisiblePaths]);

  const handleActivate = useCallback((node: NodeApi<FileTreeNode>) => {
    if (node.isEditing) {
      return;
    }

    if (node.data.type === 'directory') {
      node.toggle();
      return;
    }

    const fullPath = workspacePath ? pathJoin(workspacePath, node.data.path) : node.data.path;
    onFileOpen(fullPath);
  }, [workspacePath, onFileOpen]);

  const handleSelect = useCallback((nodes: NodeApi<FileTreeNode>[]) => {
    setSelectedRelPaths(new Set(nodes.map((node) => node.data.path)));

    if (nodes.length === 0) {
      setSelectedRelPaths(new Set());
      window.dispatchEvent(new CustomEvent('selection:changed', { detail: null }));
    } else if (nodes.length === 1 && nodes[0].data.type === 'directory') {
      const item = {
        path: workspacePath ? pathJoin(workspacePath, nodes[0].data.path) : nodes[0].data.path,
        kind: 'folder' as const,
      };
      window.dispatchEvent(new CustomEvent('selection:changed', {
        detail: { type: 'files' as const, items: [item] },
      }));
    } else if (nodes.length > 1) {
      const items = nodes.map((node) => ({
        path: workspacePath ? pathJoin(workspacePath, node.data.path) : node.data.path,
        kind: node.data.type === 'directory' ? 'folder' : 'file',
      }));
      window.dispatchEvent(new CustomEvent('selection:changed', {
        detail: { type: 'files' as const, items },
      }));
    } else {
      window.dispatchEvent(new CustomEvent('selection:changed', { detail: null }));
    }
  }, [workspacePath]);

  const handleMove = useCallback(async ({ dragIds: _dragIds, dragNodes, parentId: _parentId, parentNode, index: _index, externalData }: {
    dragIds: string[];
    dragNodes: any[];
    parentId: string | null;
    parentNode: any | null;
    index: number;
    externalData?: { type: string; filePath: string; fileName: string; isDirectory: boolean } | null;
  }) => {
    if (!workspacePath) return;

    // Handle external drops (from tabs) - COPY file to destination folder
    if (dragNodes.length === 0 && externalData) {
      const destFolder = parentNode
        ? pathJoin(workspacePath, parentNode.data.path)
        : workspacePath;

      try {
        const response = await filesService.copyExternal([externalData.filePath], destFolder);
        if (!response?.success && response?.error) {
          console.error('[Explorer] Copy failed:', response.error);
        }
      } catch (error) {
        console.error('[Explorer] Copy error:', error);
      }
      return;
    }

    if (dragNodes.length === 0) return;

    const destFolder = parentNode
      ? pathJoin(workspacePath, parentNode.data.path)
      : workspacePath;

    for (const sourceNode of dragNodes) {
      const sourcePath = pathJoin(workspacePath, sourceNode.data.path);
      const fileName = sourceNode.data.name;
      const destPath = pathJoin(destFolder, fileName);

      if (sourcePath === destPath) continue;

      const isMovingIntoSelf = sourceNode.data.type === 'directory' &&
        pathStartsWith(destPath, sourcePath);
      if (isMovingIntoSelf) {
        console.warn('[Explorer] Cannot move folder into itself');
        continue;
      }

      // Optimistic update: move in tree immediately
      const destParentRelativePath = parentNode?.data?.path || null;
      moveNodeInTree(sourceNode.data.path, destParentRelativePath);

      // NOTE(victor): crucial UI fix - dragend event may not fire before tree re-renders, causing stale highlight
      treeRef.current?.dispatch(dnd.hovering(null, null));
      treeRef.current?.dispatch(dnd.dragEnd());
      treeRef.current?.hideCursor();

      // Then do the actual filesystem move (errors will be caught by watcher if it fails)
      try {
        const response = await filesService.move(sourcePath, destPath);
        if (!response?.success) {
          console.error('[Explorer] Move failed:', response?.error);
          // TODO: could revert optimistic update here on failure
        }
      } catch (error) {
        console.error('[Explorer] Move error:', error);
        // TODO: could revert optimistic update here on failure
      }
    }
  }, [workspacePath]);

  // Handle rename from inline edit
  const handleRename = useCallback(async ({ id, name, node: _node }: { id: string; name: string; node: any }) => {
    if (!workspacePath) return;
    const oldPath = pathJoin(workspacePath, id);

    try {
      const result = await filesIpc.rename(oldPath, name);
      if (result.success && result.newPath) {
        // Optimistic update: immediately update the tree with the new name
        const newRelativePath = pathStripPrefix(result.newPath, workspacePath);
        renameNodeInTree(id, newRelativePath);
        // Update any open tab with this file to use new path (keeps tab open)
        updateTabPath(oldPath, result.newPath);
      } else if (!result.success) {
        console.error('[Explorer] Rename failed:', result.error);
      }
    } catch (error) {
      console.error('[Explorer] Rename error:', error);
    }
  }, [workspacePath, updateTabPath]);

  // Handle create - tree calls this, we create the file/folder and return the data
  // The tree will then enter edit mode for the new item
  const handleCreate = useCallback(async ({ type, parentId: _parentId, parentNode }: {
    type: 'internal' | 'leaf';
    parentId: string | null;
    index: number;
    parentNode: any | null;
  }) => {
    if (!workspacePath) return null;

    const parentPath = parentNode
      ? pathJoin(workspacePath, parentNode.data.path)
      : workspacePath;

    try {
      if (type === 'internal') {
        // Create folder
        const result = await filesIpc.createFolder(parentPath);
        if (result.success && result.path) {
          // Return object with id for tree to identify it
          const relativePath = pathStripPrefix(result.path, workspacePath);
          return { id: relativePath };
        }
      } else {
        // Create file (note)
        const result = await filesIpc.create('note', parentPath);
        if (result.success && result.path) {
          const relativePath = pathStripPrefix(result.path, workspacePath);
          return { id: relativePath };
        }
      }
    } catch (error) {
      console.error('[Explorer] Create error:', error);
    }
    return null;
  }, [workspacePath]);

  // Handle context menu on empty space in the tree
  const handleTreeContextMenu = useCallback(async (e: React.MouseEvent) => {
    // Only handle if clicking on the container itself, not on a node
    const target = e.target as HTMLElement;
    if (target.closest('[role="treeitem"]')) return;

    e.preventDefault();

    const items: ContextMenuItem[] = [
      { label: 'New Note', action: 'new-note' },
      ...(isMovieAvailable ? [{ label: 'Create New Movie', action: 'new-movie' }] : []),
      ...(isRemotionAvailable ? [{ label: 'New Remotion Project', action: 'new-remotion' }] : []),
      ...(isDevelopmentRenderer ? [{ label: 'New Automation', action: 'new-automation' }] : []),
      { label: 'New Folder', action: 'new-folder' },
    ];

    if (!hasFixedRoot) {
      items.push({ label: '', action: '', separator: true });
      items.push({ label: 'Open Folder...', action: 'open-folder' });
    }

    if (workspacePath) {
      items.push({ label: '', action: '', separator: true });
      items.push({ label: 'Show in Finder', action: 'show-in-finder' });
    }

    if (expandedFoldersRef.current.size > 0) {
      items.push({ label: '', action: '', separator: true });
      items.push({ label: 'Collapse All Folders', action: 'collapse-all' });
    }

    items.push({ label: '', action: '', separator: true });
    items.push({ label: isHelpPanelOpen ? 'Hide Help' : 'Show Help', action: 'toggle-help' });

    const action = await showContextMenu(items, 'file_tree');

    if (action === 'new-note') {
      // Create note in workspace root using filesIpc (consistent with toolbar button)
      if (workspacePath) {
        const result = await filesIpc.create('note', workspacePath);
        if (result.success && result.path) {
          onFileOpen(result.path);
        }
      }
    } else if (action === 'new-movie') {
      if (workspacePath) {
        const result = await filesIpc.create('movie', workspacePath);
        if (result.success && result.path) {
          onFileOpen(result.path);
        }
      }
    } else if (action === 'new-remotion') {
      if (workspacePath) {
        const result = await filesIpc.create('remotion', workspacePath);
        if (result.success && result.path) {
          onFileOpen(result.path);
        }
      }
    } else if (action === 'new-automation') {
      if (workspacePath) {
        const result = await filesIpc.create('automation', workspacePath);
        if (result.success && result.path) {
          onFileOpen(result.path);
        }
      }
    } else if (action === 'new-folder') {
      // Create folder in workspace root using filesIpc
      if (workspacePath) {
        pendingCreationRef.current = true;
        const result = await filesIpc.createFolder(workspacePath);
        if (result.success && result.path) {
          // revealAndEdit will optimistically add the node and enter edit mode
          revealAndEdit(result.path, 'directory');
        }
        pendingCreationRef.current = false;
      }
    } else if (action === 'open-folder' && !hasFixedRoot) {
      const result = await openFolderDialog();
      if (!result.canceled && result.filePaths.length > 0) {
        try {
          await workspace.set({ workspacePath: result.filePaths[0] });
        } catch (err) {
          console.error('[Explorer] Failed to change workspace:', err);
        }
      }
    } else if (action === 'show-in-finder' && workspacePath) {
      void showItemInFolder(workspacePath);
    } else if (action === 'toggle-help') {
      if (isHelpPanelOpen) {
        setIsHelpPanelOpen(false);
      } else {
        setIsHelpPanelOpen(true);
        setHelpPanelHeight(300);
      }
    } else if (action === 'collapse-all') {
      collapseAll();
    }
  }, [workspacePath, hasFixedRoot, isHelpPanelOpen, isMovieAvailable, isRemotionAvailable, isDevelopmentRenderer, setIsHelpPanelOpen, setHelpPanelHeight, collapseAll]);

  const handleTreeBackgroundClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('[role="treeitem"]')) {
      return;
    }
    treeRef.current?.deselectAll();
  }, []);

  // Reveal an item in the explorer and enter edit mode
  // Also optimistically adds the node to the tree if not already present
  const revealAndEdit = useCallback((path: string, type: 'file' | 'directory') => {
    if (!workspacePath) return;

    // Optimistically add the node to the tree if it doesn't exist yet
    const relativePath = pathStartsWith(path, workspacePath) ? pathStripPrefix(path, workspacePath) : path;
    addNodeToTree(relativePath, type);

    if (type === 'file') {
      // For files: set pendingEditRef and open the file (triggers existing reveal effect)
      pendingEditRef.current = path;
      onFileOpen(path);
    } else {
      // For folders: set both ref (synchronous, for loadFilesPreservingScroll check)
      // and state (for the useEffect to trigger)
      pendingFolderEditRef.current = path;
      setPendingFolderEdit(path);
    }
  }, [onFileOpen, workspacePath]);

  const renderNode = useCallback((props: NodeRendererProps<FileTreeNode>) => (
    <ExplorerNode
      {...props}
      workspacePath={workspacePath}
      onFileOpen={onFileOpen}
      onAskAgent={handleAskAgentAboutItems}
      onItemCreated={revealAndEdit}
      onTreeMutated={refreshFixedRootTree}
      isLoading={loadingFolders.has(props.node.id)}
      flashPath={flashPath}
    />
  ), [workspacePath, onFileOpen, handleAskAgentAboutItems, revealAndEdit, refreshFixedRootTree, loadingFolders, flashPath]);

  // Trigger thumbnail recalculation on container resize
  useEffect(() => {
    if (containerHeight > 0) {
      recalculateVisiblePaths();
    }
  }, [containerHeight, recalculateVisiblePaths]);

  // Trigger thumbnail recalculation when filtered files change
  useEffect(() => {
    if (filteredFiles.length > 0 && workspacePath) {
      const timer = setTimeout(() => {
        recalculateVisiblePaths();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [filteredFiles, workspacePath, recalculateVisiblePaths]);

  // Reveal active file in tree when it changes (expand parents + scroll)
  // Visual selection is automatic via isActive prop in ExplorerNode
  useEffect(() => {
    if (!activeFilePath || !workspacePath || !treeRef.current) return;

    const revealFile = async () => {
      // If this file was just created, scroll to center and enter edit mode
      const isPendingEdit = pendingEditRef.current === activeFilePath;
      const node = await revealInTree(activeFilePath, {
        scrollAlign: isPendingEdit ? 'center' : 'smart'
      });

      if (isPendingEdit && node) {
        node.edit();
        pendingEditRef.current = null;
      }
    };

    // Small delay to ensure Tree has re-rendered with new data
    const timer = setTimeout(revealFile, 50);
    return () => clearTimeout(timer);
  }, [activeFilePath, workspacePath, files, revealInTree]);

  useEffect(() => {
    if (hasFixedRoot) {
      return;
    }

    const handleRevealInExplorer = (event: Event) => {
      const customEvent = event as CustomEvent<{ path?: string }>;
      const requestedPath = customEvent.detail?.path;
      if (!requestedPath || !workspacePath || !treeRef.current) {
        return;
      }
      if (!pathStartsWith(requestedPath, workspacePath)) {
        return;
      }

      void (async () => {
        const node = await revealInTree(requestedPath, { scrollAlign: 'center' });
        if (!node || !treeRef.current) {
          return;
        }

        treeRef.current.select(node.id, { align: 'center', focus: false });
        setFlashPath(requestedPath);
        if (flashTimerRef.current !== null) {
          window.clearTimeout(flashTimerRef.current);
        }
        flashTimerRef.current = window.setTimeout(() => {
          setFlashPath((current) => (current === requestedPath ? null : current));
          flashTimerRef.current = null;
        }, 1800);
      })();
    };

    window.addEventListener('reveal-in-explorer', handleRevealInExplorer);
    return () => {
      window.removeEventListener('reveal-in-explorer', handleRevealInExplorer);
      if (flashTimerRef.current !== null) {
        window.clearTimeout(flashTimerRef.current);
        flashTimerRef.current = null;
      }
    };
  }, [hasFixedRoot, revealInTree, workspacePath]);

  // Reveal and enter edit mode for newly created folders
  useEffect(() => {
    if (!pendingFolderEdit || !workspacePath || !treeRef.current) return;

    // Validate path is within workspace
    if (!pathStartsWith(pendingFolderEdit, workspacePath)) {
      pendingFolderEditRef.current = null;
      setPendingFolderEdit(null);
      return;
    }

    const revealFolder = async () => {
      const node = await revealInTree(pendingFolderEdit, { scrollAlign: 'center' });
      if (node) {
        node.edit();
        pendingFolderEditRef.current = null;
        setPendingFolderEdit(null);
      }
    };

    // Small delay to ensure Tree has re-rendered with new data
    const timer = setTimeout(revealFolder, 100);
    return () => clearTimeout(timer);
  }, [pendingFolderEdit, workspacePath, files, revealInTree]);

  async function loadWorkspace() {
    try {
      // Reset error state (errors now shown via toast)

      // Check cache FIRST before showing any loading state
      const cached = await window.electron?.getInitialFileTree?.().catch(() => null);
      if (cached?.workspacePath && cached.files?.length > 0) {
        setWorkspacePath(cached.workspacePath);
        setFiles(cached.files);

        // Populate global file cache for mentions
        const flatFiles: FileEntry[] = [];
        const flatten = (nodes: FileTreeNode[]) => {
          for (const node of nodes) {
            flatFiles.push({
              path: pathJoin(cached.workspacePath, node.path),
              name: node.name,
              type: node.type,
            });
            if (node.children) {
              flatten(node.children);
            }
          }
        };
        flatten(cached.files);
        setFileCache(flatFiles);
        setLoading(false);

        // Verify workspace in background, refresh if mismatch
        getWorkspace().then(({ workspace }) => {
          if (workspace && workspace !== cached.workspacePath) {
            setWorkspacePath(workspace);
            loadFiles(workspace);
          } else if (workspace) {
            loadFiles(workspace);
          }
        }).catch(console.error);
        return;
      }

      // No cache - show loading and fall back to HTTP + SSE
      setLoading(true);
      const { workspace } = await getWorkspace();
      setWorkspacePath(workspace);

      if (workspace) {
        await loadFiles(workspace);
      }
    } catch (err: any) {
      console.error('Failed to load workspace:', err);
      showToast(err.message, 'error', 5000);
    } finally {
      setLoading(false);
    }
  }

  async function loadFixedRoot(targetRootPath: string) {
    try {
      setLoading(true);
      setLoadingFiles(true);
      setWorkspacePath(targetRootPath);

      const result = await filesIpc.listDirectory(targetRootPath);
      if (!result.success) {
        throw new Error(result.error || 'Failed to load folder');
      }

      setFiles(folderNodesToFileTree(result.entries ?? [], targetRootPath));
    } catch (err: any) {
      console.error('[Explorer] Failed to load folder:', err);
      showToast(err.message, 'error', 5000);
    } finally {
      setLoading(false);
      setLoadingFiles(false);
      setLoadProgress(0);
    }
  }

  async function loadFiles(explicitWorkspace?: string) {
    if (rootPathOverride) {
      await loadFixedRoot(rootPathOverride);
      return;
    }

    try {
      setLoadingFiles(true);
      setLoadProgress(0);

      if (isMarketingDemoMode()) {
        const result = await getWorkspaceFiles();
        setFiles(result.files);
        setLoadingFiles(false);
        setLoadProgress(0);
        return;
      }

      // Use SSE for progress reporting - retry on network errors (server may be restarting)
      const maxRetries = 5;
      let lastError: Error | null = null;
      let response: Response | null = null;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const port = await getServerPort();
          const url = appendWindowSessionKey(
            port ? `http://127.0.0.1:${port}/api/workspace/files?stream=true` : '/api/workspace/files?stream=true',
          );
          response = await fetch(url);
          if (response.ok && response.body) {
            break; // Success
          }
          lastError = new Error('Failed to load files');
        } catch (err: any) {
          lastError = err;
          // Wait before retry (exponential backoff: 200ms, 400ms, 800ms, 1600ms)
          if (attempt < maxRetries - 1) {
            await new Promise(r => setTimeout(r, 200 * Math.pow(2, attempt)));
          }
        }
      }

      if (!response?.ok || !response?.body) {
        throw lastError || new Error('Failed to load files');
      }

      for await (const data of readJsonSseStream<WorkspaceFilesStreamEvent>(response.body, { streamName: 'workspace-files' })) {
        if (data.done && data.files) {
          setFiles(markResolvedDirs(data.files));
          setLoadProgress(100);

          // Populate global file cache for mentions
          const effectiveWorkspace = explicitWorkspace || workspacePath;
          if (effectiveWorkspace) {
            const flatFiles: FileEntry[] = [];
            const flatten = (nodes: FileTreeNode[], basePath: string) => {
              for (const node of nodes) {
                flatFiles.push({
                  path: pathJoin(basePath, node.path),
                  name: node.name,
                  type: node.type,
                });
                if (node.children) {
                  flatten(node.children, basePath);
                }
              }
            };
            flatten(data.files, effectiveWorkspace);
            setFileCache(flatFiles);
          }
        } else if (data.progress !== undefined) {
          // Progress update
          setLoadProgress(data.progress);
        }
      }

      // Keep loading state visible briefly
      setTimeout(() => {
        setLoadingFiles(false);
        setLoadProgress(0);
      }, 300);
    } catch (err: any) {
      console.error('[Explorer] Failed to load files:', err);
      showToast(err.message, 'error', 5000);
      setLoadingFiles(false);
      setLoadProgress(0);
    }
  }

  async function getServerPort(): Promise<number | null> {
    // In browser dev mode, use relative URLs (Vite proxies /api to backend)
    if (isBrowserDevMode()) {
      return null;
    }
    return getServerPortFromIpc();
  }

  /**
   * Surgically update a specific file's thumbnail when it changes
   */
  function handleFileChanged(changedPath: string, mtime: number) {
    // Helper function to update node in tree recursively
    const updateNodeInTree = (nodes: FileTreeNode[]): FileTreeNode[] => {
      return nodes.map(node => {
        if (node.type === 'file' && node.path === changedPath) {
          // Found the file! Update its mtime to trigger thumbnail reload
          return {
            ...node,
            mtime,
          };
        } else if (node.type === 'directory' && node.children) {
          // Recursively update children
          return {
            ...node,
            children: updateNodeInTree(node.children),
          };
        }
        return node;
      });
    };

    setFiles(prevFiles => updateNodeInTree(prevFiles));
  }

  // Find a node by path in the tree
  function findNodeByPath(nodes: FileTreeNode[], path: string): FileTreeNode | null {
    for (const node of nodes) {
      if (node.path === path) return node;
      if (node.children) {
        const found = findNodeByPath(node.children, path);
        if (found) return found;
      }
    }
    return null;
  }

  function updateFolderChildrenInTree(
    nodes: FileTreeNode[],
    targetPath: string,
    children: FileTreeNode[]
  ): FileTreeNode[] {
    return nodes.map(n => {
      if (n.path === targetPath) {
        return { ...n, children, isResolved: true };
      }
      if (n.children) {
        return { ...n, children: updateFolderChildrenInTree(n.children, targetPath, children) };
      }
      return n;
    });
  }

  async function rehydrateExpandedFolders(fileTree: FileTreeNode[]): Promise<FileTreeNode[]> {
    let nextTree = fileTree;

    for (const folderPath of Array.from(expandedFoldersRef.current)) {
      try {
        const children = await loadDirectoryChildren(folderPath);
        nextTree = updateFolderChildrenInTree(nextTree, folderPath, children);
      } catch {
        expandedFoldersRef.current.delete(folderPath);
      }
    }

    return nextTree;
  }

  // Optimistically rename a node in the tree (update path and name without reloading)
  function renameNodeInTree(oldRelativePath: string, newRelativePath: string) {
    // Helper to update paths for a node and all its children (for folder renames)
    const updatePathsRecursively = (node: FileTreeNode, oldPrefix: string, newPrefix: string): FileTreeNode => {
      const updatedPath = node.path.replace(oldPrefix, newPrefix);
      return {
        ...node,
        path: updatedPath,
        name: pathBasename(updatedPath) || updatedPath,
        children: node.children?.map(child => updatePathsRecursively(child, oldPrefix, newPrefix)),
      };
    };

    const updateNodes = (nodes: FileTreeNode[]): FileTreeNode[] => {
      return nodes.map(node => {
        if (node.path === oldRelativePath) {
          // This is the renamed node - update it and all children
          return updatePathsRecursively(node, oldRelativePath, newRelativePath);
        }
        if (node.children) {
          return { ...node, children: updateNodes(node.children) };
        }
        return node;
      }).sort((a, b) => {
        // Re-sort siblings after rename (folders first, then alphabetical)
        if (a.type === 'directory' && b.type !== 'directory') return -1;
        if (a.type !== 'directory' && b.type === 'directory') return 1;
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      });
    };

    setFiles(prevFiles => updateNodes(prevFiles));

    // Update expanded folders ref if we renamed a folder that was expanded
    if (expandedFoldersRef.current.has(oldRelativePath)) {
      expandedFoldersRef.current.delete(oldRelativePath);
      expandedFoldersRef.current.add(newRelativePath);
    }
  }

  // Optimistically add a new node to the tree (for folder/file creation)
  // Does nothing if node already exists
  function addNodeToTree(relativePath: string, type: 'file' | 'directory') {
    const name = pathBasename(relativePath) || relativePath;
    const parentPath = pathDirname(relativePath);

    const newNode: FileTreeNode = {
      path: relativePath,
      name,
      type,
      children: type === 'directory' ? [] : undefined,
      isResolved: false,
    };

    const insertSorted = (nodes: FileTreeNode[], node: FileTreeNode): FileTreeNode[] => {
      // Don't add if already exists
      if (nodes.some(n => n.path === node.path)) {
        return nodes;
      }
      const result = [...nodes, node];
      return result.sort((a, b) => {
        // Folders first, then alphabetical
        if (a.type === 'directory' && b.type !== 'directory') return -1;
        if (a.type !== 'directory' && b.type === 'directory') return 1;
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      });
    };

    setFiles(prevFiles => {
      if (!parentPath) {
        // Adding to root
        return insertSorted(prevFiles, newNode);
      }

      // Adding to a subfolder - find the parent and add there
      const addToParent = (nodes: FileTreeNode[]): FileTreeNode[] => {
        return nodes.map(node => {
          if (node.path === parentPath && node.children) {
            return { ...node, children: insertSorted(node.children, newNode) };
          }
          if (node.children) {
            return { ...node, children: addToParent(node.children) };
          }
          return node;
        });
      };
      return addToParent(prevFiles);
    });
  }

  // Optimistically move a node in the tree (remove from source, add to destination)
  function moveNodeInTree(sourceRelativePath: string, destParentRelativePath: string | null) {
    setFiles(prevFiles => {
      // First, find and extract the node to move
      let nodeToMove: FileTreeNode | null = null;

      const extractNode = (nodes: FileTreeNode[]): FileTreeNode[] => {
        return nodes.filter(node => {
          if (node.path === sourceRelativePath) {
            nodeToMove = node;
            return false; // Remove from current location
          }
          return true;
        }).map(node => {
          if (node.children) {
            return { ...node, children: extractNode(node.children) };
          }
          return node;
        });
      };

      const filesWithoutSource = extractNode(prevFiles);

      if (!nodeToMove) {
        console.warn('[Explorer] moveNodeInTree: source node not found:', sourceRelativePath);
        return prevFiles;
      }

      // Update the node's path to reflect new location
      const extractedNode = nodeToMove as FileTreeNode;
      const fileName = extractedNode.name;
      const newPath = destParentRelativePath ? pathJoin(destParentRelativePath, fileName) : fileName;

      // Update paths recursively for the node and all its children
      const updatePaths = (node: FileTreeNode, oldBasePath: string, newBasePath: string): FileTreeNode => {
        let updatedPath: string;
        if (node.path === oldBasePath) {
          updatedPath = newBasePath;
        } else if (pathStartsWith(node.path, oldBasePath)) {
          const suffix = pathStripPrefix(node.path, oldBasePath);
          updatedPath = pathJoin(newBasePath, suffix);
        } else {
          updatedPath = node.path;
        }
        return {
          ...node,
          path: updatedPath,
          children: node.children?.map(child => updatePaths(child, oldBasePath, newBasePath)),
        };
      };

      const movedNode = updatePaths(extractedNode, sourceRelativePath, newPath);

      // Insert sorted helper
      const insertSorted = (nodes: FileTreeNode[], node: FileTreeNode): FileTreeNode[] => {
        const result = [...nodes, node];
        return result.sort((a, b) => {
          if (a.type === 'directory' && b.type !== 'directory') return -1;
          if (a.type !== 'directory' && b.type === 'directory') return 1;
          return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        });
      };

      // Insert into destination
      if (!destParentRelativePath) {
        // Moving to root
        return insertSorted(filesWithoutSource, movedNode);
      }

      // Moving to a subfolder
      const insertIntoParent = (nodes: FileTreeNode[]): FileTreeNode[] => {
        return nodes.map(node => {
          if (node.path === destParentRelativePath && node.children) {
            return { ...node, children: insertSorted(node.children, movedNode) };
          }
          if (node.children) {
            return { ...node, children: insertIntoParent(node.children) };
          }
          return node;
        });
      };

      return insertIntoParent(filesWithoutSource);
    });

    // Update expanded folders ref if we moved a folder that was expanded
    if (expandedFoldersRef.current.has(sourceRelativePath)) {
      const fileName = pathBasename(sourceRelativePath) || sourceRelativePath;
      const newPath = destParentRelativePath ? pathJoin(destParentRelativePath, fileName) : fileName;
      expandedFoldersRef.current.delete(sourceRelativePath);
      expandedFoldersRef.current.add(newPath);
    }
  }

  async function loadFilesPreservingScroll() {
    if (rootPathOverride) {
      try {
        setLoadingFiles(true);
        const scrollTop = treeContainerRef.current?.scrollTop ?? 0;
        const result = await filesIpc.listDirectory(rootPathOverride);
        if (!result.success) {
          throw new Error(result.error || 'Failed to load folder');
        }

        const fileTree = await rehydrateExpandedFolders(folderNodesToFileTree(result.entries ?? [], rootPathOverride));
        setFiles(fileTree);
        setLoadingFiles(false);
        setLoadProgress(0);

        const hasPendingEdit = pendingEditRef.current !== null || pendingFolderEditRef.current !== null || pendingCreationRef.current;
        if (!hasPendingEdit) {
          requestAnimationFrame(() => {
            if (treeContainerRef.current) {
              treeContainerRef.current.scrollTop = scrollTop;
            }
          });
        }
      } catch (err: any) {
        console.error('[Explorer] Failed to load folder:', err);
        showToast(err.message, 'error', 5000);
        setLoadingFiles(false);
        setLoadProgress(0);
      }
      return;
    }

    try {
      setLoadingFiles(true);
      setLoadProgress(0);

      // Save scroll position using ref (avoids closure issues)
      const scrollTop = treeContainerRef.current?.scrollTop ?? 0;

      // Reload files with retry on network errors
      const maxRetries = 3;
      let lastError: Error | null = null;
      let fileTree: FileTreeNode[] | null = null;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const result = await getWorkspaceFiles();
          fileTree = result.files;
          break; // Success
        } catch (err: any) {
          lastError = err;
          // Wait before retry (exponential backoff: 100ms, 200ms, 400ms)
          if (attempt < maxRetries - 1) {
            await new Promise(r => setTimeout(r, 100 * Math.pow(2, attempt)));
          }
        }
      }

      if (!fileTree) {
        throw lastError || new Error('Failed to load files');
      }

      fileTree = await rehydrateExpandedFolders(fileTree);

      setFiles(fileTree);
      setLoadingFiles(false);
      setLoadProgress(0);

      // Restore scroll position after a brief delay to allow re-render
      // BUT skip if we have a pending edit or creation - the reveal effect will handle scrolling
      // Use refs for synchronous access (state may not be updated yet)
      const hasPendingEdit = pendingEditRef.current !== null || pendingFolderEditRef.current !== null || pendingCreationRef.current;
      if (!hasPendingEdit) {
        requestAnimationFrame(() => {
          if (treeContainerRef.current) {
            treeContainerRef.current.scrollTop = scrollTop;
          }
        });
      }
    } catch (err: any) {
      console.error('[Explorer] Failed to load files:', err);
      showToast(err.message, 'error', 5000);
      setLoadingFiles(false);
      setLoadProgress(0);
    }
  }


  if (loading) {
    return (
      <div className="flex h-full items-center px-4 text-ui-sm text-[#6b7280] dark:text-[#b4b4b4]">
        Loading...
      </div>
    );
  }

  // Show landing page when no folder is open
  if (workspacePath === null && !hasFixedRoot) {
    return (
      <div className="app-explorer-surface flex h-full flex-col overflow-visible" data-testid={EXPLORER_ID}>
        <WorkspaceLanding />
      </div>
    );
  }

  return (
    <div className="app-explorer-surface flex h-full flex-col overflow-visible text-[#202123] dark:text-[#f5f5f5]" data-testid={EXPLORER_ID}>
      {/* Search bar */}
      {!hideSearchBar && (
        <div
          className="app-explorer-header-surface sticky top-0 z-10 bg-transparent px-1 pb-2 pt-0"
          style={{
            paddingLeft: '0px',
            paddingRight: '0px',
          }}
          data-help-title={t('help.explorer.search.title')}
          data-help-description={t('help.explorer.search.description')}
        >
          <div
            className="oa-interactive-surface relative overflow-hidden rounded-[var(--control-radius-lg)]"
          >
            <Input
              ref={searchInputRef}
              type="text"
              placeholder={t('help.explorer.search.placeholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              data-explorer-search="true"
              data-testid={EXPLORER_SEARCH_INPUT_ID}
              className="!h-[var(--oa-control-h-md)] !border-transparent !bg-transparent !text-ui-sm !shadow-none focus-visible:!border-transparent focus-visible:!ring-0 focus-visible:!shadow-none"
              style={{
                paddingLeft: '12px',
                paddingRight: '60px',
                borderRadius: 'inherit',
              }}
            />
            {/* Loading progress overlay */}
            {loadingFiles && (
              <div
                className="absolute inset-0 pointer-events-none overflow-hidden"
                style={{ borderRadius: 'inherit' }}
              >
                <div
                  className="h-full bg-black/[0.06] transition-all duration-200 dark:bg-white/[0.08]"
                  style={{ width: `${loadProgress}%` }}
                />
              </div>
            )}
            <div className="absolute right-4 top-1/2 flex -translate-y-1/2 items-center">
              {isSearching ? (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => {
                    setSearchQuery('');
                    searchInputRef.current?.focus();
                  }}
                  className="text-[#6b7280] hover:bg-black/[0.045] hover:text-[#202123] dark:text-[#b4b4b4] dark:hover:bg-white/[0.05] dark:hover:text-[#f5f5f5]"
                >
                  <X />
                </Button>
              ) : (
                <KeyboardShortcutHint
                  shortcut="K"
                  isCommandHeld={isCommandHeld}
                  activatedKey={activatedKey}
                  mode="always"
                  className="px-0 text-[10px]"
                  activeClassName="text-[#202123]/50 dark:text-[#f5f5f5]/58"
                  inactiveClassName="text-[#7a808a]/80 dark:text-[#9ea3ab]/78"
                  heldClassName="text-[#696f79]/88 dark:text-[#b3b8c0]/84"
                />
              )}
            </div>
          </div>
        </div>
      )}

      {/* Workspace breadcrumbs */}
      {workspacePath && !isSearching && (
        hasFixedRoot ? (
          <button
            type="button"
            className={`mx-1 flex w-[calc(100%-0.5rem)] items-center rounded-[12px] px-3 py-2 text-left text-ui-sm transition-colors duration-150 ${isScrolled ? 'bg-transparent text-[#4b5563] dark:text-[#b4b4b4]' : 'bg-transparent text-[#6b7280] dark:text-[#b4b4b4]'} hover:bg-[var(--oa-button-hover-bg)] hover:text-[#202123] dark:hover:text-[#f5f5f5]`}
            style={{
              paddingLeft: '14px',
              paddingRight: '14px',
              paddingTop: '10px',
              paddingBottom: '10px',
            }}
            onClick={() => {
              void showItemInFolder(workspacePath);
            }}
            title={workspacePath}
          >
            <span className="truncate">{pathBasename(workspacePath) || workspacePath}</span>
          </button>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                data-testid={WORKSPACE_PICKER_BUTTON_ID}
                className={`relative mx-1 flex items-center rounded-[12px] px-3 py-2 text-ui-sm transition-colors duration-150 ${isScrolled ? 'bg-transparent text-[#4b5563] dark:text-[#b4b4b4]' : 'bg-transparent text-[#6b7280] dark:text-[#b4b4b4]'} hover:bg-[var(--oa-button-hover-bg)] hover:text-[#202123] dark:hover:text-[#f5f5f5]`}
                style={{
                  paddingLeft: '14px',
                  paddingRight: '14px',
                  paddingTop: '10px',
                  paddingBottom: '10px',
                }}
                onMouseDown={handleWorkspacePickerMouseDown}
                onClick={(event) => openWorkspacePickerFromElement(event.currentTarget as HTMLElement)}
                aria-expanded={pickerMenuPos ? 'true' : 'false'}
                aria-haspopup="menu"
                data-help-title={t('help.explorer.changeFolder.title')}
                data-help-description={t('help.explorer.changeFolder.description')}
              >
                <span className="flex min-w-0 items-center">
                  {(() => {
                    const parts = pathSplit(workspacePath);
                    if (parts.length <= 2) {
                      return <span className="truncate">/{parts.join('/')}</span>;
                    }
                    return (
                      <>
                        <span className="opacity-50 flex-shrink-0">...</span>
                        <span className="mx-2 opacity-50 flex-shrink-0">/</span>
                        <span className="flex-shrink-0">{parts[parts.length - 2]}</span>
                        <span className="mx-2 opacity-50 flex-shrink-0">/</span>
                        <span className="truncate">{parts[parts.length - 1]}</span>
                      </>
                    );
                  })()}
                </span>
                <ChevronDown className={`ml-2 size-3.5 flex-shrink-0 transition-transform duration-150 ${pickerMenuPos ? 'rotate-180 text-[#202123] dark:text-[#f5f5f5]' : 'text-[#7a808a] dark:text-[#9ea3ab]'}`} />
              </button>
            </TooltipTrigger>
            <TooltipContent
              side="right"
              sideOffset={0}
              className="pointer-events-none translate-x-[calc(-100%-var(--unit-padding))]"
            >
              <span className="flex items-center gap-1.5">
                <span>{t('help.explorer.changeFolder.title')}</span>
                <span className="opacity-60">{openFolderShortcutLabel}</span>
              </span>
            </TooltipContent>
          </Tooltip>
        )
      )}

      {/* Search results or File tree */}
      {isSearching ? (
        <div className="flex-1 overflow-y-auto px-1 pb-2">
          <FileSearchResults
            ref={searchResultsRef}
            query={searchQuery}
            onSelect={handleSearchSelect}
            noteMatches={vaultMatches}
            noteSearchLoading={vaultSearchLoading}
            onSelectNoteMatch={(match: VaultSearchResult) => {
              onFileOpen(match.path);
              setSearchQuery('');
              searchInputRef.current?.blur();
            }}
            showBorder={false}
            maxHeight="none"
            className="bg-transparent"
            emptyMessage="No matching files or tabs"
            emptyActionLabel="Run Agent Search"
            emptyActionDescription={t('help.explorer.search.agentSearchDescription')}
            onEmptyAction={handleRunAgentSearch}
            contentMatches={contentMatches}
            contentSearchLoading={contentSearchLoading}
            onSelectContentMatch={handleSelectContentMatch}
            // showSearchComputer={true}
            // onSearchComputer={handleSearchComputer}
          />
        </div>
      ) : (
        <div className="relative flex-1 overflow-hidden">
          <div
            ref={treeContainerRefCallback}
            className="app-explorer-scroll-surface file-tree group/tree absolute inset-0 overflow-auto px-0.5 pb-2 transition-none data-[drag-over=true]:bg-black/[0.025] dark:data-[drag-over=true]:bg-white/[0.035]"
            data-testid={FILE_TREE_ID}
            data-drag-over={isTreeDragOver}
            onDragOver={handleTreeDragOver}
            onDragLeave={handleTreeDragLeave}
            onDrop={handleTreeDrop}
            onContextMenu={handleTreeContextMenu}
          >
            {!workspacePath ? (
              <div className="p-4 text-center text-ui-base text-[#6b7280] dark:text-[#b4b4b4]">
                <p>{t('explorer.empty.noWorkspaceSelected')}</p>
                <p className="mt-2 text-ui-base text-[#6b7280] dark:text-[#b4b4b4]">{t('explorer.empty.openFolderHint')}</p>
              </div>
            ) : loadingFiles && files.length === 0 ? (
              <div className="flex-1 flex items-center justify-center p-8">
                <div className="text-center">
                  <div className="mb-2 text-ui-base text-[#6b7280] dark:text-[#b4b4b4]">{t('explorer.empty.loadingFiles')}</div>
                  <div className="text-ui-base text-[#9ca3af] dark:text-[#8c8c8c]">{t('explorer.empty.pleaseWait')}</div>
                </div>
              </div>
            ) : filteredFiles.length === 0 ? (
              <div className="p-4 text-ui-base text-[#6b7280] dark:text-[#b4b4b4]">
                <p>{filterQuery ? t('explorer.empty.noMatchingFilesFound') : t('explorer.empty.noFilesFound')}</p>
              </div>
            ) : (
              <Tree<FileTreeNode>
                ref={treeRef}
                data={filteredFiles}
                dndRootElement={treeContainerRef.current}
                idAccessor="path"
                childrenAccessor={childrenAccessor}
                openByDefault={autoExpandAll}
                width="100%"
                height={containerHeight}
                indent={INDENT}
                rowHeight={getRowHeight()}
                overscanCount={10}
                paddingTop={0}
                paddingBottom={72}
                onActivate={handleActivate}
                onToggle={handleToggle}
                onSelect={handleSelect}
                onClick={handleTreeBackgroundClick}
                onScroll={handleScroll}
                onMove={handleMove}
                onRename={handleRename}
                onCreate={handleCreate}
                renderCursor={renderCursorNull}
              >
                {renderNode}
              </Tree>
            )}
          </div>
          {/* Selection overlay — single outline around all selected items */}
          {selectionOverlay && (
            <div
              className="pointer-events-none absolute left-1 right-1 rounded-[12px] bg-transparent shadow-none ring-1 ring-black/[0.08] dark:ring-white/[0.1]"
              style={{ top: selectionOverlay.top, height: selectionOverlay.height }}
            />
          )}

        </div>
      )}

      {pickerMenuPos && (
        <ContextMenu
          x={pickerMenuPos.x}
          y={pickerMenuPos.y}
          items={buildWorkspacePickerMenuItems({
            workspacePath,
            recentFolders,
            noteWorkspaces,
            revealWorkspaceLabel: getRevealInFileManagerLabel(runtimePlatform),
            openFolderShortcut: openFolderShortcutLabel,
            onRevealWorkspace: (path) => {
              void showItemInFolder(path);
            },
            onOpenFolder: () => {
              void handlePickerOpenFolder();
            },
            onSelectWorkspace: (path) => {
              void switchWorkspaceTo(path);
            },
            onScanNoteWorkspaces: () => {
              void handleScanNoteWorkspaces();
            },
            isScanningNoteWorkspaces,
          })}
          onClose={() => setPickerMenuPos(null)}
        />
      )}
    </div>
  );
}

export function Explorer(props: ExplorerProps) {
  return <ExplorerContent {...props} />;
}
