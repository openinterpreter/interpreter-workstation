/**
 * SplitView Component
 *
 * Renders two children side-by-side (horizontal) or stacked (vertical)
 * with a draggable resize handle between them.
 */

import { useCallback, useRef } from 'react';
import type { SplitNode } from '../../../shared/types/layout';

interface SplitViewProps {
  node: SplitNode;
  onRatioChange: (splitId: string, ratio: number) => void;
  children: [React.ReactNode, React.ReactNode];
}

export function SplitView({ node, onRatioChange, children }: SplitViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;

    // Pre-capture terminal snapshots NOW (mousedown), before any movement.
    // toDataURL is slow (~200ms), so we do it before the first mousemove.
    window.dispatchEvent(new CustomEvent('layout:resize-prepare'));

    const container = containerRef.current;
    if (!container) return;

    let resizeStarted = false;

    const handleMouseMove = (e: MouseEvent) => {
      if (!container) return;

      // Dispatch resize-start on first actual movement (not on click)
      if (!resizeStarted) {
        resizeStarted = true;
        window.dispatchEvent(new CustomEvent('layout:resize-start'));
      }

      const rect = container.getBoundingClientRect();

      let ratio: number;
      if (node.direction === 'horizontal') {
        ratio = (e.clientX - rect.left) / rect.width;
      } else {
        ratio = (e.clientY - rect.top) / rect.height;
      }

      ratio = Math.max(0.1, Math.min(0.9, ratio));
      onRatioChange(node.id, ratio);

      // Sync PersistentLayer overlay positions during split resize
      requestAnimationFrame(() => {
        const syncFn = (window as any).__updatePaneRectImperative;
        if (syncFn) {
          document.querySelectorAll('[data-pane-id]').forEach((el) => {
            const paneId = el.getAttribute('data-pane-id');
            if (paneId) {
              const r = el.getBoundingClientRect();
              syncFn(paneId, { top: r.top, left: r.left, width: r.width, height: r.height });
            }
          });
        }
      });
    };

    const handleMouseUp = () => {
      if (resizeStarted) {
        window.dispatchEvent(new CustomEvent('layout:resize-end'));
      }
      isDragging.current = false;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = node.direction === 'horizontal' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
  }, [node.id, node.direction, onRatioChange]);

  const isHorizontal = node.direction === 'horizontal';
  const pct1 = `${node.ratio * 100}%`;
  const pct2 = `${(1 - node.ratio) * 100}%`;

  return (
    <div
      ref={containerRef}
      className="flex h-full w-full"
      style={{ flexDirection: isHorizontal ? 'row' : 'column' }}
      data-testid={`split-view-${node.id}`}
      data-split-direction={node.direction}
    >
      {/* First child */}
      <div
        style={{
          width: isHorizontal ? `calc(${pct1} - 2px)` : undefined,
          height: isHorizontal ? undefined : `calc(${pct1} - 2px)`,
          overflow: 'hidden',
          minWidth: isHorizontal ? 50 : undefined,
          minHeight: !isHorizontal ? 50 : undefined,
        }}
      >
        {children[0]}
      </div>

      {/* Resize handle */}
      <div
        onMouseDown={handleMouseDown}
        data-testid={`split-handle-${node.id}`}
        style={{
          width: isHorizontal ? '4px' : undefined,
          height: isHorizontal ? undefined : '4px',
          cursor: isHorizontal ? 'col-resize' : 'row-resize',
          flexShrink: 0,
          position: 'relative',
          zIndex: 10,
        }}
      />

      {/* Second child */}
      <div
        style={{
          width: isHorizontal ? `calc(${pct2} - 2px)` : undefined,
          height: isHorizontal ? undefined : `calc(${pct2} - 2px)`,
          overflow: 'hidden',
          minWidth: isHorizontal ? 50 : undefined,
          minHeight: !isHorizontal ? 50 : undefined,
        }}
      >
        {children[1]}
      </div>
    </div>
  );
}
