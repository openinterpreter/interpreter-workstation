/**
 * StickyTreeContainer Architecture Design
 * ========================================
 *
 * This component replaces FixedSizeList to enable native CSS position:sticky
 * for expanded directory nodes (VS Code-style sticky headers).
 *
 * ## Architecture Overview
 *
 * ```
 * BEFORE (FixedSizeList - incompatible with CSS sticky):
 * ┌─────────────────────────────────────────────────────┐
 * │ FixedSizeList                                       │
 * │ ├── Row (position: absolute; top: 0px)              │
 * │ ├── Row (position: absolute; top: 24px)             │
 * │ ├── Row (position: absolute; top: 48px)             │
 * │ └── ...                                             │
 * └─────────────────────────────────────────────────────┘
 *
 * AFTER (StickyTreeContainer - enables CSS sticky):
 * ┌─────────────────────────────────────────────────────┐
 * │ StickyTreeContainer (overflow: auto)                │
 * │ └── StickyTreeInner (position: relative)            │
 * │     └── FolderA (position: sticky; top: 0)          │
 * │         └── FolderA-children (position: relative)   │
 * │             └── FolderA1 (sticky; top: 24px)        │
 * │                 └── FolderA1-children               │
 * │                     ├── file1 (position: relative)  │
 * │                     └── file2 (position: relative)  │
 * └─────────────────────────────────────────────────────┘
 * ```
 *
 * ## Key Insight: Why CSS Sticky Works with Nesting
 *
 * CSS `position: sticky` sticks relative to the nearest scrolling ancestor.
 * When nested, each sticky element sticks within its parent's bounds:
 *
 * - FolderA sticks at top: 0 until FolderA-children scrolls out
 * - FolderA1 sticks at top: 24px (below FolderA) until FolderA1-children scrolls out
 * - This creates the natural "push out" animation when a folder section ends
 *
 * ## Data Structures
 */

import React, {
  useRef,
  useCallback,
  useMemo,
  useState,
  useEffect,
  forwardRef,
} from 'react';
import { NodeApi } from '../interfaces/node-api';
import { useDataUpdates, useTreeApi } from '../context';
import {
  flattenTreeWithStickyInfo as flattenImpl,
  getIndicesToRender,
} from '../data/flatten-sticky-tree';
import { useDragHook } from '../dnd/drag-hook';
import { useDropHook } from '../dnd/drop-hook';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Extended node info with position and sticky metadata.
 * Created by flattenTreeWithStickyInfo().
 */
export interface StickyNodeInfo<T> {
  /** Unique node ID */
  id: string;

  /** Reference to the NodeApi */
  node: NodeApi<T>;

  /** Absolute position from container top (px) */
  top: number;

  /** Node height (always ROW_HEIGHT, typically 24px) */
  height: number;

  /** Total height including all visible descendants (px) */
  totalHeight: number;

  /** Nesting level (0 = root children) */
  depth: number;

  /** True for expanded directories (these get position: sticky) */
  isSticky: boolean;

  /** Cumulative height of all sticky ancestors above this node (px) */
  stickyTop: number;

  /** z-index for stacking (higher = closer to user). Calculated as: maxDepth - depth */
  zIndex: number;

  /** Index of parent in the flat array, or null for root children */
  parentIndex: number | null;

  /** Indices of direct children in the flat array */
  childIndices: number[];

  /** Row index in visible nodes (for cursor positioning) */
  rowIndex: number;
}

/**
 * Scroll event props matching react-window's ListOnScrollProps
 */
export interface ScrollEvent {
  scrollDirection: 'forward' | 'backward';
  scrollOffset: number;
  scrollUpdateWasRequested: boolean;
}

/**
 * Items rendered event props matching react-window's ListOnItemsRenderedProps
 */
export interface ItemsRenderedEvent {
  overscanStartIndex: number;
  overscanStopIndex: number;
  visibleStartIndex: number;
  visibleStopIndex: number;
}

/**
 * Props for StickyTreeContainer.
 * Designed to be a drop-in replacement for the FixedSizeList portion of DefaultContainer.
 */
export interface StickyTreeContainerProps {
  /** CSS class name for the scrollable container */
  className?: string;

  /** Container height (px) */
  height: number;

  /** Container width (px or '100%') */
  width: number | string;

  /** Row height (px) - fixed for all rows */
  rowHeight: number;

  /** Number of rows to render outside visible area */
  overscanCount: number;

  /** Scroll event handler - matches react-window's ListOnScrollProps */
  onScroll?: (event: ScrollEvent) => void;

  /** Called when visible items change - matches react-window's ListOnItemsRenderedProps */
  onItemsRendered?: (info: ItemsRenderedEvent) => void;

  /** Padding at top of tree */
  paddingTop?: number;

  /** Padding at bottom of tree */
  paddingBottom?: number;
}

// ============================================================================
// FLATTEN TREE ALGORITHM (to be implemented in flatten-sticky-tree.ts)
// ============================================================================

/**
 * Re-export flattenTreeWithStickyInfo from data module.
 * See flatten-sticky-tree.ts for implementation details.
 */
export const flattenTreeWithStickyInfo = flattenImpl;

// ============================================================================
// STICKY TREE CONTAINER COMPONENT
// ============================================================================

/**
 * StickyTreeContainer renders a virtualized tree with native CSS sticky headers.
 *
 * ## Rendering Strategy
 *
 * Unlike FixedSizeList which renders rows with position: absolute,
 * this component creates a nested DOM structure where:
 *
 * 1. **Expanded directories** are wrapped in a container with:
 *    - `position: sticky`
 *    - `top: {stickyTop}px` (cumulative height of sticky ancestors)
 *    - `z-index: {zIndex}` (decreases with depth)
 *    - A child container for descendants
 *
 * 2. **Leaf nodes and collapsed directories** are rendered with:
 *    - `position: relative`
 *    - No special sticky behavior
 *
 * ## Virtualization
 *
 * Virtualization is maintained by tracking which nodes are in the visible
 * range (plus overscan). The nested structure means we must:
 *
 * 1. Always render sticky ancestors of visible nodes (even if above viewport)
 * 2. Use `visibility: hidden` for nodes outside the visible range that
 *    must exist in DOM for structure (sticky ancestors)
 *
 * ## DnD Compatibility
 *
 * The nested structure requires DnD coordinate calculations to use
 * root-relative coordinates instead of row-relative. See:
 * - compute-drop.ts: measureHover() and computeDrop() refactors
 * - cursor.tsx: Use absolute positions from StickyNodeInfo
 */
export const StickyTreeContainer = forwardRef<HTMLDivElement, StickyTreeContainerProps>(
  function StickyTreeContainer(props, ref) {
    useDataUpdates();
    const tree = useTreeApi();

    const {
      className,
      height,
      width,
      rowHeight,
      overscanCount,
      onScroll,
      onItemsRendered,
      paddingTop = 0,
      paddingBottom = 0,
    } = props;

    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const [scrollOffset, setScrollOffset] = useState(0);
    const lastScrollOffsetRef = useRef(0);

    // Flatten tree with sticky metadata
    const stickyNodes = useMemo(
      () => flattenTreeWithStickyInfo(tree.visibleNodes, rowHeight),
      [tree.visibleNodes, rowHeight]
    );

    // Calculate total content height
    const totalHeight = useMemo(() => {
      if (stickyNodes.length === 0) return 0;
      const lastNode = stickyNodes[stickyNodes.length - 1];
      return lastNode.top + lastNode.height + paddingTop + paddingBottom;
    }, [stickyNodes, paddingTop, paddingBottom]);

    // Set of indices to render (includes sticky ancestors)
    // Uses imported getIndicesToRender which handles both visible range and ancestor inclusion
    const indexesToRender = useMemo(
      () => getIndicesToRender(stickyNodes, scrollOffset, height, paddingTop, overscanCount),
      [stickyNodes, scrollOffset, height, paddingTop, overscanCount]
    );

    // Calculate visible range for reporting to parent
    const getVisibleRange = useCallback(
      (offset: number) => {
        const startY = Math.max(0, offset - paddingTop);
        const endY = startY + height;

        let startIndex = 0;
        let endIndex = stickyNodes.length - 1;

        for (let i = 0; i < stickyNodes.length; i++) {
          const node = stickyNodes[i];
          if (node.top + node.height > startY) {
            startIndex = Math.max(0, i - overscanCount);
            break;
          }
        }

        for (let i = startIndex; i < stickyNodes.length; i++) {
          const node = stickyNodes[i];
          if (node.top > endY) {
            endIndex = Math.min(stickyNodes.length - 1, i + overscanCount);
            break;
          }
        }

        return { startIndex, endIndex };
      },
      [stickyNodes, height, paddingTop, overscanCount]
    );

    // Handle scroll - notify parent in same event handler (not useEffect)
    const handleScroll = useCallback(
      (e: React.UIEvent<HTMLDivElement>) => {
        const newOffset = e.currentTarget.scrollTop;
        const scrollDirection: 'forward' | 'backward' =
          newOffset >= lastScrollOffsetRef.current ? 'forward' : 'backward';
        lastScrollOffsetRef.current = newOffset;

        setScrollOffset(newOffset);
        onScroll?.({
          scrollDirection,
          scrollOffset: newOffset,
          scrollUpdateWasRequested: false,
        });

        // Report visible items in same event handler per React best practices
        const range = getVisibleRange(newOffset);
        // Calculate visible range without overscan for visibleStartIndex/visibleStopIndex
        const startY = Math.max(0, newOffset - paddingTop);
        const endY = startY + height;
        let visibleStart = range.startIndex;
        let visibleEnd = range.endIndex;

        // Find actual visible (non-overscan) range
        for (let i = range.startIndex; i <= range.endIndex; i++) {
          const node = stickyNodes[i];
          if (node && node.top + node.height > startY) {
            visibleStart = i;
            break;
          }
        }
        for (let i = range.endIndex; i >= range.startIndex; i--) {
          const node = stickyNodes[i];
          if (node && node.top < endY) {
            visibleEnd = i;
            break;
          }
        }

        onItemsRendered?.({
          overscanStartIndex: range.startIndex,
          overscanStopIndex: range.endIndex,
          visibleStartIndex: visibleStart,
          visibleStopIndex: visibleEnd,
        });
      },
      [onScroll, onItemsRendered, getVisibleRange, paddingTop, height, stickyNodes]
    );

    // Forward ref to scroll container
    React.useImperativeHandle(ref, () => scrollContainerRef.current!, []);

    return (
      <div
        ref={scrollContainerRef}
        className={className}
        style={{
          height,
          width,
          overflow: 'auto',
          position: 'relative',
        }}
        onScroll={handleScroll}
      >
        <StickyTreeInner
          stickyNodes={stickyNodes}
          indexesToRender={indexesToRender}
          totalHeight={totalHeight}
          paddingTop={paddingTop}
          rowHeight={rowHeight}
        />
      </div>
    );
  }
);

// ============================================================================
// INNER CONTAINER (renders the nested structure)
// ============================================================================

interface StickyTreeInnerProps<T> {
  stickyNodes: StickyNodeInfo<T>[];
  indexesToRender: Set<number>;
  totalHeight: number;
  paddingTop: number;
  rowHeight: number;
}

/**
 * Renders the nested DOM structure for sticky tree.
 *
 * ## Rendering Algorithm
 *
 * 1. Build a tree structure from the flat stickyNodes array
 * 2. Recursively render:
 *    - For sticky nodes (expanded dirs): wrapper div with position:sticky + children container
 *    - For non-sticky nodes: simple row div
 * 3. Skip nodes not in indexesToRender (but preserve structure)
 */
function StickyTreeInner<T>({
  stickyNodes,
  indexesToRender,
  totalHeight,
  paddingTop,
  rowHeight,
}: StickyTreeInnerProps<T>) {
  // Find root-level nodes (parentIndex === null)
  const rootIndices = useMemo(() => {
    const roots: number[] = [];
    for (let i = 0; i < stickyNodes.length; i++) {
      if (stickyNodes[i].parentIndex === null) {
        roots.push(i);
      }
    }
    return roots;
  }, [stickyNodes]);

  return (
    <div
      style={{
        position: 'relative',
        height: totalHeight,
        paddingTop,
      }}
    >
      {rootIndices.map((idx) => (
        <StickyNodeRenderer
          key={stickyNodes[idx].id}
          stickyNodes={stickyNodes}
          index={idx}
          indexesToRender={indexesToRender}
          rowHeight={rowHeight}
        />
      ))}
    </div>
  );
}

// ============================================================================
// NODE RENDERER (recursive component for nested structure)
// ============================================================================

interface StickyNodeRendererProps<T> {
  stickyNodes: StickyNodeInfo<T>[];
  index: number;
  indexesToRender: Set<number>;
  rowHeight: number;
}

/**
 * Recursively renders a node and its children with proper sticky behavior.
 *
 * ============================================================================
 * CRITICAL FIX: CSS STICKY STRUCTURE
 * ============================================================================
 *
 * CSS `position: sticky` ONLY works when:
 * 1. The sticky element is SMALLER than its containing block
 * 2. The containing block SCROLLS PAST the sticky element
 *
 * WRONG (what we had before - entire wrapper is sticky):
 * ```html
 * <div style="position: sticky; top: 0">  <!-- WRONG: entire thing sticks -->
 *   <div class="row">folder header</div>
 *   <div class="children">
 *     <!-- all children inside the sticky element -->
 *   </div>
 * </div>
 * ```
 * Problem: The sticky element CONTAINS all its children, so there's nothing
 * to "scroll past" - the whole thing moves together as one unit.
 *
 * CORRECT (only the row header is sticky):
 * ```html
 * <div style="position: relative">        <!-- Outer container establishes bounds -->
 *   <div style="position: sticky; top: 0"> <!-- ONLY the row sticks -->
 *     <div class="row">folder header</div>
 *   </div>
 *   <div>                                  <!-- Children are SIBLINGS, not nested -->
 *     <!-- children scroll normally within the container -->
 *   </div>
 * </div>
 * ```
 * Why this works:
 * - The outer `position: relative` div establishes the sticky boundary
 * - Only the row header has `position: sticky`
 * - Children are SIBLINGS of the sticky row, not inside it
 * - As children scroll, the sticky row stays put until the outer container
 *   scrolls out, creating the natural "push out" effect
 *
 * ============================================================================
 */
function StickyNodeRenderer<T>({
  stickyNodes,
  index,
  indexesToRender,
  rowHeight,
}: StickyNodeRendererProps<T>) {
  const info = stickyNodes[index];

  if (!info) return null;

  const shouldRender = indexesToRender.has(index);
  const { node, isSticky, stickyTop: _stickyTop, zIndex: _zIndex, childIndices } = info;

  // Render row content (reuses existing RowContainer logic)
  const rowContent = shouldRender ? (
    <StickyRow node={node} height={rowHeight} />
  ) : (
    // Placeholder for structure - maintains DOM hierarchy for sticky to work
    <div style={{ height: rowHeight, visibility: 'hidden' }} />
  );

  if (isSticky && childIndices.length > 0) {
    // Sticky node with children - ONLY the row is sticky, children scroll normally
    // The outer container establishes bounds for the sticky element
    // TODO: Sticky headers disabled because they conflict with vibrancy.
    //
    // THE PROBLEM:
    // - Vibrancy requires transparent backgrounds (so macOS blur effect shows through)
    // - Sticky headers need to HIDE content that scrolls behind them
    // - Normally you'd use: opaque background (blocks vibrancy) or backdrop-filter (broken in Electron)
    // - CSS masks/clip-path can't target "content behind another element" - only the element itself
    // - There's no CSS way to say "make other elements invisible when they're behind me"
    //
    // To re-enable sticky headers, you'd need either:
    // 1. Accept an opaque background (loses vibrancy in that area)
    // 2. Fix Electron's backdrop-filter support
    // 3. Use JS to detect overlapping elements and hide them (complex, perf concerns)
    //
    return (
      <div style={{ position: 'relative' }}>
        <div>
          {rowContent}
        </div>
        <div>
          {childIndices.map((childIdx) => (
            <StickyNodeRenderer
              key={stickyNodes[childIdx].id}
              stickyNodes={stickyNodes}
              index={childIdx}
              indexesToRender={indexesToRender}
              rowHeight={rowHeight}
            />
          ))}
        </div>
      </div>
    );
  }

  // Non-sticky node (leaf or collapsed) - simple row
  return rowContent;
}

// ============================================================================
// STICKY ROW (individual row with DnD hooks)
// ============================================================================

interface StickyRowProps<T> {
  node: NodeApi<T>;
  height: number;
}

/**
 * Individual row component with DnD support.
 * Adapted from RowContainer but works with sticky structure.
 */
function StickyRow<T>({ node, height }: StickyRowProps<T>) {
  const tree = useTreeApi<T>();
  const el = useRef<HTMLDivElement | null>(null);

  // DnD hooks - reuse existing implementations
  const dragHandle = useDragHook<T>(el, node);
  useDropHook(el, node);

  const innerRef = useCallback((n: HTMLDivElement | null) => {
    el.current = n;
  }, []);

  const indent = tree.indent * node.level;
  const nodeStyle = useMemo(() => ({ paddingLeft: indent }), [indent]);

  const rowAttrs: React.HTMLAttributes<any> = {
    role: 'treeitem',
    'aria-level': node.level + 1,
    'aria-selected': node.isSelected,
    'aria-expanded': node.isInternal ? node.isOpen : undefined,
    style: { height },
    tabIndex: -1,
    className: tree.props.rowClassName,
  };

  // Focus handling
  useEffect(() => {
    if (!node.isEditing && node.isFocused) {
      el.current?.focus({ preventScroll: true });
    }
  }, [node.isEditing, node.isFocused]);

  const Node = tree.renderNode;
  const Row = tree.renderRow;

  return (
    <Row node={node} innerRef={innerRef} attrs={rowAttrs}>
      <Node node={node} tree={tree} style={nodeStyle} dragHandle={dragHandle} />
    </Row>
  );
}

// ============================================================================
// EXPORTS & INTEGRATION NOTES
// ============================================================================

/**
 * ## Integration Steps
 *
 * 1. Implement flattenTreeWithStickyInfo() in flatten-sticky-tree.ts
 * 2. Refactor DnD system:
 *    - compute-drop.ts: Use root-relative coordinates
 *    - measure-hover.ts: Accept nodes array instead of DOM traversal
 *    - cursor.tsx: Position using absolute coords from StickyNodeInfo
 *    - drag-hook.ts / drop-hook.ts: Handle event bubbling in nested containers
 * 3. Replace FixedSizeList in DefaultContainer with StickyTreeContainer
 * 4. Update Explorer.tsx to remove StickyBreadcrumbs overlay
 *
 * ## DnD Coordinate Refactor
 *
 * Current (row-relative):
 * ```typescript
 * const rect = rowElement.getBoundingClientRect();
 * const x = offset.x - rect.x; // x relative to row
 * const hoverLevel = Math.round((x - indent) / indent);
 * ```
 *
 * New (root-relative):
 * ```typescript
 * const rootRect = rootContainer.getBoundingClientRect();
 * const x = offset.x - rootRect.x; // x relative to root
 * const hoverLevel = Math.round(x / indent);
 * ```
 *
 * ## Cursor Positioning
 *
 * Current: Uses rowIndex * rowHeight
 * New: Uses StickyNodeInfo.top directly (already calculated)
 *
 * ## Event Bubbling
 *
 * With nested containers, drag events bubble up. The drop-hook must:
 * 1. Use event.stopPropagation() on the innermost valid target
 * 2. Or compare event.target with event.currentTarget to ignore bubbled events
 */

export default StickyTreeContainer;
