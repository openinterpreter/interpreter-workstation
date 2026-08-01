/**
 * PaneView Component
 *
 * A leaf pane's content area. Measured via ResizeObserver for persistent tab positioning.
 * Stateless tabs render inline. Stateful tabs render in PersistentLayer.
 *
 * Drop zone detection:
 * - Outer 20% horizontal → left/right split
 * - Outer 20% vertical → top/bottom split
 * - Inner 60% → add tab to this pane (center)
 * Visual overlay shows where the split will appear.
 */

import { useCallback, useRef, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Pane, Tab } from '../../../shared/types/layout';
import { STATEFUL_TAB_TYPES } from '../../../shared/types/layout';
import { MAIN_COMPOSER_INPUT_ID, PANE_CONTENT_ID } from '../../../shared/element-ids';
import { TabContent } from './TabContent';
import { resolvePaneTabDragData } from '../../utils/paneTabDrag';
import type { PaneTabDragData } from '../../utils/paneTabDrag';
import { pathBasename } from '@/ipc';
import { isComposerFileDrag, resolveComposerFileDropData } from '../../utils/composerDrop';
import { isResolvedFileDrag, markActiveFileDragHandled, resolveFileDragData } from '../../utils/fileDragData';

type DropZone = 'center' | 'left' | 'right' | 'top' | 'bottom';

const TEXT_EXTENSIONS = new Set(['md', 'markdown', 'txt']);

/** Check if the active tab can accept file content dropped into its center */
function tabAcceptsFileContent(tab: Tab | null): boolean {
  if (!tab) return false;
  if (tab.type === 'terminal') return true;
  if (tab.type === 'file' && tab.path) {
    const ext = tab.path.split('.').pop()?.toLowerCase();
    return TEXT_EXTENSIONS.has(ext || '');
  }
  return false;
}

interface PaneViewProps {
  pane: Pane;
  tabs: Record<string, Tab>;
  isActive: boolean;
  onActivatePane: (paneId: string) => void;
  onActivateTab: (paneId: string, tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onPaneRectChange?: (paneId: string, rect: DOMRect | null) => void;
  onTabDrop?: (tabId: string, sourcePaneId: string | null, targetPaneId: string, zone: DropZone, index?: number, sidebarMeta?: any, dragData?: PaneTabDragData | null) => void;
}

function detectZone(e: React.DragEvent, el: HTMLElement): DropZone {
  const rect = el.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  const y = (e.clientY - rect.top) / rect.height;

  if (x < 0.2) return 'left';
  if (x > 0.8) return 'right';
  if (y < 0.2) return 'top';
  if (y > 0.8) return 'bottom';
  return 'center';
}

function getEffectiveFileDropZone(
  zone: DropZone,
  currentTab: Tab | null,
  droppedOnAgentComposer: boolean,
): DropZone {
  if (currentTab?.type === 'agent' && !droppedOnAgentComposer && zone === 'center') {
    return 'right';
  }
  return zone;
}

/** Compute fixed-position rect for a drop zone overlay, given the pane's bounding rect.
 *  Edge overlays match the 20% detection strip; center covers the inner 60%. */
function getZoneOverlayStyle(zone: DropZone, rect: DOMRect): React.CSSProperties {
  const e = 0.2; // edge fraction — must match detectZone thresholds
  switch (zone) {
    case 'left':
      return { top: rect.top, left: rect.left, width: rect.width * e, height: rect.height };
    case 'right':
      return { top: rect.top, left: rect.left + rect.width * (1 - e), width: rect.width * e, height: rect.height };
    case 'top':
      return { top: rect.top, left: rect.left, width: rect.width, height: rect.height * e };
    case 'bottom':
      return { top: rect.top + rect.height * (1 - e), left: rect.left, width: rect.width, height: rect.height * e };
    case 'center':
      return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
  }
}

function isPointInsideRect(clientX: number, clientY: number, rect: DOMRect): boolean {
  return (
    clientX >= rect.left
    && clientX <= rect.right
    && clientY >= rect.top
    && clientY <= rect.bottom
  );
}

function getVisibleAgentComposerRect(agentId: string): DOMRect | null {
  const composerEl = document.querySelector<HTMLElement>(
    `[data-persistent-tab="${agentId}"][data-persistent-visible="true"] [data-testid="${MAIN_COMPOSER_INPUT_ID}"]`,
  );
  return composerEl?.getBoundingClientRect() ?? null;
}

export function PaneView({
  pane,
  tabs,
  isActive,
  onActivatePane,
  onActivateTab: _onActivateTab,
  onCloseTab: _onCloseTab,
  onPaneRectChange,
  onTabDrop,
}: PaneViewProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [activeZone, setActiveZone] = useState<DropZone | null>(null);
  const dragCountRef = useRef(0); // Track nested dragenter/dragleave

  // Measure content slot rect via ResizeObserver
  useEffect(() => {
    if (!contentRef.current || !onPaneRectChange) return;

    const measure = () => {
      if (contentRef.current) {
        onPaneRectChange(pane.id, contentRef.current.getBoundingClientRect());
      }
    };
    const observer = new ResizeObserver(measure);
    observer.observe(contentRef.current);

    // Initial measurement
    measure();

    // Re-measure after sidebar animation ends — the pane's position may
    // have shifted without its size changing (e.g. left sidebar toggle).
    window.addEventListener('layout:resize-end', measure);

    return () => {
      observer.disconnect();
      window.removeEventListener('layout:resize-end', measure);
      onPaneRectChange(pane.id, null);
    };
  }, [pane.id, onPaneRectChange]);

  // Also update rect on scroll
  useEffect(() => {
    const handleScroll = () => {
      if (contentRef.current && onPaneRectChange) {
        onPaneRectChange(pane.id, contentRef.current.getBoundingClientRect());
      }
    };
    window.addEventListener('scroll', handleScroll, true);
    return () => window.removeEventListener('scroll', handleScroll, true);
  }, [pane.id, onPaneRectChange]);

  const handlePaneClick = useCallback(() => {
    onActivatePane(pane.id);
  }, [pane.id, onActivatePane]);

  // Resolve active tab
  const activeTab = pane.activeTabId ? tabs[pane.activeTabId] : null;
  const isStatefulActive = activeTab ? STATEFUL_TAB_TYPES.has(activeTab.type) : false;

  // Drop zone detection with visual feedback
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCountRef.current++;
  }, []);

  const [isContentFileDrag, setIsContentFileDrag] = useState(false);
  const [overlayRect, setOverlayRect] = useState<DOMRect | null>(null);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();

    if (contentRef.current) {
      setOverlayRect(contentRef.current.getBoundingClientRect());
    }

    const currentTab = pane.activeTabId ? tabs[pane.activeTabId] : null;
    const composerRect = currentTab?.type === 'agent'
      ? getVisibleAgentComposerRect(currentTab.id)
      : null;
    const overAgentComposer = currentTab?.type === 'agent'
      && composerRect != null
      && isPointInsideRect(e.clientX, e.clientY, composerRect)
      && isComposerFileDrag(e.dataTransfer, tabs);

    if (overAgentComposer) {
      setIsContentFileDrag(false);
      setActiveZone(null);
      e.dataTransfer.dropEffect = 'copy';
    } else if (isResolvedFileDrag(e.dataTransfer) && contentRef.current) {
      const rawZone = detectZone(e, contentRef.current);
      const zone = getEffectiveFileDropZone(rawZone, currentTab, false);
      const centerAccepts = zone === 'center' && tabAcceptsFileContent(currentTab);
      setIsContentFileDrag(centerAccepts);
      setActiveZone(zone);
      e.dataTransfer.dropEffect = centerAccepts ? 'copy' : 'move';
    } else if (contentRef.current) {
      setIsContentFileDrag(false);
      setActiveZone(detectZone(e, contentRef.current));
      e.dataTransfer.dropEffect = 'move';
    } else {
      setIsContentFileDrag(false);
      setActiveZone(null);
    }
  }, [pane.activeTabId, tabs]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCountRef.current--;
    if (dragCountRef.current <= 0) {
      dragCountRef.current = 0;
      setActiveZone(null);
      setOverlayRect(null);
      setIsContentFileDrag(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCountRef.current = 0;
    setActiveZone(null);
    setOverlayRect(null);
    setIsContentFileDrag(false);

    const rawZone = contentRef.current ? detectZone(e, contentRef.current) : 'center';
    const currentTab = pane.activeTabId ? tabs[pane.activeTabId] : null;

    const composerRect = currentTab?.type === 'agent'
      ? getVisibleAgentComposerRect(currentTab.id)
      : null;
    const droppedOnAgentComposer = currentTab?.type === 'agent'
      && composerRect != null
      && isPointInsideRect(e.clientX, e.clientY, composerRect);

    if (droppedOnAgentComposer) {
      const composerDrop = resolveComposerFileDropData(e.dataTransfer, tabs);
      if (composerDrop) {
        markActiveFileDragHandled('pane-composer-drop', {
          agentId: currentTab.id,
          filePath: composerDrop.filePath,
        });
        window.dispatchEvent(new CustomEvent('composer:file-drop', {
          detail: {
            filePath: composerDrop.filePath,
            fileName: composerDrop.fileName,
            isDirectory: composerDrop.isDirectory,
            agentId: currentTab.id,
          },
        }));
        return;
      }
    }

    const zone = getEffectiveFileDropZone(rawZone, currentTab, droppedOnAgentComposer);
    const resolvedFileDrop = resolveFileDragData(e.dataTransfer);
    const paneTabDrag = resolvePaneTabDragData(e.dataTransfer);
    console.log('[file-drag-debug] pane:drop', {
      paneId: pane.id,
      activeTabId: currentTab?.id ?? null,
      activeTabType: currentTab?.type ?? null,
      rawZone,
      zone,
      droppedOnAgentComposer,
      resolvedFileDrop,
      paneTabDrag,
      types: Array.from(e.dataTransfer.types ?? []),
    });

    if (resolvedFileDrop) {
      markActiveFileDragHandled('pane-drop', {
        paneId: pane.id,
        zone,
        filePath: resolvedFileDrop.filePath,
      });
      // File drag from Explorer
      if (zone === 'center' && tabAcceptsFileContent(currentTab)) {
        if (currentTab?.type === 'terminal') {
          window.dispatchEvent(new CustomEvent('terminal:file-drop', {
            detail: { filePath: resolvedFileDrop.filePath, tabId: currentTab.id }
          }));
        } else if (currentTab?.type === 'file') {
          window.dispatchEvent(new CustomEvent('editor:file-drop', {
            detail: {
              filePath: resolvedFileDrop.filePath,
              fileName: resolvedFileDrop.fileName || pathBasename(resolvedFileDrop.filePath),
              isDirectory: resolvedFileDrop.isDirectory,
              paneId: pane.id,
              editorFilePath: currentTab.path,
            }
          }));
        }
      } else if (zone !== 'center') {
        window.dispatchEvent(new CustomEvent('pane:file-split', {
          detail: { filePath: resolvedFileDrop.filePath, paneId: pane.id, zone }
        }));
      } else if (!resolvedFileDrop.isDirectory) {
        window.dispatchEvent(new CustomEvent('pane:file-drop', {
          detail: { filePath: resolvedFileDrop.filePath, paneId: pane.id }
        }));
      }
    } else if (paneTabDrag) {
      const tabId = e.dataTransfer.getData('text/plain');
      if (tabId && onTabDrop) {
        const sourcePaneId = paneTabDrag.sourcePaneId ?? null;
        const sidebarMeta = paneTabDrag.sidebarMeta ?? undefined;
        onTabDrop(tabId, sourcePaneId, pane.id, zone, undefined, sidebarMeta, paneTabDrag);
      }
    } else if (e.dataTransfer.files.length > 0) {
      // Native OS file drop
      const paths: string[] = [];
      for (let i = 0; i < e.dataTransfer.files.length; i++) {
        const file = e.dataTransfer.files[i] as File & { path?: string };
        if (file.path) paths.push(file.path);
      }
      if (paths.length === 0) return;

      if (zone === 'center' && currentTab?.type === 'terminal') {
        window.dispatchEvent(new CustomEvent('terminal:file-drop', {
          detail: { filePaths: paths, tabId: currentTab.id }
        }));
      } else if (zone === 'center' && currentTab?.type === 'file' && tabAcceptsFileContent(currentTab)) {
        const filePath = paths[0];
        window.dispatchEvent(new CustomEvent('editor:file-drop', {
          detail: {
            filePath,
            fileName: pathBasename(filePath) || filePath,
            isDirectory: false,
            paneId: pane.id,
            editorFilePath: currentTab.path,
          }
        }));
      } else if (zone !== 'center') {
        window.dispatchEvent(new CustomEvent('pane:file-split', {
          detail: { filePath: paths[0], paneId: pane.id, zone }
        }));
      } else {
        window.dispatchEvent(new CustomEvent('pane:file-drop', {
          detail: { filePath: paths[0], paneId: pane.id }
        }));
      }
    }
  }, [onTabDrop, pane.activeTabId, pane.id, tabs]);

  return (
    <div
      ref={contentRef}
      className="app-pane-surface relative flex-1 min-h-0 min-w-0 bg-transparent"
      data-testid={PANE_CONTENT_ID(pane.id)}
      data-pane-id={pane.id}
      data-pane-active={isActive || undefined}
      onClick={handlePaneClick}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Stateless tabs render inline. Stateful tabs render in PersistentLayer. */}
      {activeTab && !isStatefulActive && (
        <div className="h-full">
          <TabContent activeTab={activeTab} />
        </div>
      )}

      {/* Drop zone visual overlay */}
      {activeZone && overlayRect && createPortal(
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          style={{
            position: 'fixed',
            ...getZoneOverlayStyle(activeZone, overlayRect),
            zIndex: 25,
            pointerEvents: 'auto',
            ...(isContentFileDrag
              ? {
                  border: '1px solid color-mix(in srgb, var(--foreground) 10%, transparent)',
                  borderRadius: 16,
                  background: 'color-mix(in srgb, var(--foreground) 4%, transparent)',
                  boxShadow: '0 12px 32px color-mix(in srgb, var(--foreground) 8%, transparent)',
                }
              : {
                  backgroundColor: 'color-mix(in srgb, var(--foreground) 8%, transparent)',
                  borderRadius: 16,
                  boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--foreground) 5%, transparent)',
                }),
            transition: 'all 100ms ease-out',
          }}
        />,
        document.body,
      )}
    </div>
  );
}
