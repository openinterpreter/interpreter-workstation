/**
 * Flattens a tree into an array with sticky positioning metadata.
 *
 * This is the core algorithm that enables native CSS position:sticky
 * by calculating the exact positions and relationships for each node.
 */

import { NodeApi } from '../interfaces/node-api';
import type { StickyNodeInfo } from '../components/sticky-tree-container';

/**
 * Converts the tree's visibleNodes into a flat array with sticky metadata.
 *
 * Algorithm overview:
 * 1. First pass: Calculate basic positions (top, height, depth, parentIndex, childIndices)
 * 2. Second pass (bottom-up): Calculate totalHeight for each node
 * 3. Third pass: Calculate stickyTop and zIndex
 *
 * Time: O(n) where n = visible node count
 * Space: O(n) for the output array
 */
export function flattenTreeWithStickyInfo<T>(
  visibleNodes: NodeApi<T>[],
  rowHeight: number
): StickyNodeInfo<T>[] {
  if (visibleNodes.length === 0) {
    return [];
  }

  const result: StickyNodeInfo<T>[] = [];

  // Maps node ID to index in result array
  const idToIndex = new Map<string, number>();

  // Track max depth for z-index calculation
  let maxDepth = 0;

  // First pass: Build basic structure with positions
  for (let i = 0; i < visibleNodes.length; i++) {
    const node = visibleNodes[i];
    const depth = node.level;
    maxDepth = Math.max(maxDepth, depth);

    // Find parent index by looking up the tree
    let parentIndex: number | null = null;
    if (node.parent && !node.parent.isRoot) {
      parentIndex = idToIndex.get(node.parent.id) ?? null;
    }

    const info: StickyNodeInfo<T> = {
      id: node.id,
      node,
      top: i * rowHeight,
      height: rowHeight,
      totalHeight: rowHeight, // Will be updated in second pass
      depth,
      isSticky: node.isInternal && node.isOpen,
      stickyTop: 0, // Will be calculated in third pass
      zIndex: 0, // Will be calculated after we know maxDepth
      parentIndex,
      childIndices: [],
      rowIndex: i,
    };

    // Register this node's index
    idToIndex.set(node.id, i);

    // Add this node as a child of its parent
    if (parentIndex !== null && result[parentIndex]) {
      result[parentIndex].childIndices.push(i);
    }

    result.push(info);
  }

  // Second pass (bottom-up): Calculate totalHeight
  // Process in reverse order so children are processed before parents
  for (let i = result.length - 1; i >= 0; i--) {
    const info = result[i];
    if (info.childIndices.length > 0) {
      // totalHeight = own height + sum of all children's totalHeight
      let childrenTotalHeight = 0;
      for (const childIdx of info.childIndices) {
        childrenTotalHeight += result[childIdx].totalHeight;
      }
      info.totalHeight = info.height + childrenTotalHeight;
    }
  }

  // Third pass: Calculate stickyTop and zIndex
  // stickyTop = cumulative height of all sticky ancestors
  for (let i = 0; i < result.length; i++) {
    const info = result[i];

    // Calculate z-index (decreases with depth so parents stack on top)
    info.zIndex = maxDepth - info.depth + 1;

    // Calculate stickyTop by walking up sticky ancestors
    let stickyTop = 0;
    let parentIdx = info.parentIndex;

    while (parentIdx !== null) {
      const parent = result[parentIdx];
      if (parent.isSticky) {
        stickyTop += parent.height;
      }
      parentIdx = parent.parentIndex;
    }

    info.stickyTop = stickyTop;
  }

  return result;
}

/**
 * Finds the indices of nodes that should be rendered given a scroll position.
 *
 * Returns a Set of indices that includes:
 * 1. All nodes within the visible range (plus overscan)
 * 2. All sticky ancestors of visible nodes (must be in DOM for sticky to work)
 */
export function getIndicesToRender<T>(
  stickyNodes: StickyNodeInfo<T>[],
  scrollOffset: number,
  viewportHeight: number,
  paddingTop: number,
  overscanCount: number
): Set<number> {
  const set = new Set<number>();

  if (stickyNodes.length === 0) {
    return set;
  }

  const startY = Math.max(0, scrollOffset - paddingTop);
  const endY = startY + viewportHeight;

  // Find visible range
  let startIndex = 0;
  let endIndex = stickyNodes.length - 1;

  // Binary search would be more efficient for large lists,
  // but linear scan is simpler and fine for typical tree sizes
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

  // Add all nodes in visible range
  for (let i = startIndex; i <= endIndex; i++) {
    set.add(i);

    // Add all sticky ancestors (must be in DOM for CSS sticky to work)
    let parentIdx = stickyNodes[i].parentIndex;
    while (parentIdx !== null) {
      set.add(parentIdx);
      parentIdx = stickyNodes[parentIdx].parentIndex;
    }
  }

  return set;
}

/**
 * Gets the node info at a given y-coordinate (relative to container top).
 * Useful for DnD hit testing.
 */
export function getNodeAtPosition<T>(
  stickyNodes: StickyNodeInfo<T>[],
  y: number
): StickyNodeInfo<T> | null {
  // Binary search for efficiency
  let low = 0;
  let high = stickyNodes.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const node = stickyNodes[mid];

    if (y < node.top) {
      high = mid - 1;
    } else if (y >= node.top + node.height) {
      low = mid + 1;
    } else {
      return node;
    }
  }

  return null;
}

/**
 * Gets all sticky ancestors for a given node index.
 * Returns them in order from root to immediate parent.
 */
export function getStickyAncestors<T>(
  stickyNodes: StickyNodeInfo<T>[],
  nodeIndex: number
): StickyNodeInfo<T>[] {
  const ancestors: StickyNodeInfo<T>[] = [];
  let parentIdx = stickyNodes[nodeIndex]?.parentIndex;

  while (parentIdx !== null) {
    const parent = stickyNodes[parentIdx];
    if (parent.isSticky) {
      ancestors.unshift(parent);
    }
    parentIdx = parent.parentIndex;
  }

  return ancestors;
}
