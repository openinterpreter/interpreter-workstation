/**
 * Tree Operations
 *
 * Pure functions for manipulating the split-tree layout.
 * All functions return new trees (immutable).
 */

import { nanoid } from 'nanoid';
import type { TreeNode, Pane, SplitNode } from '../../shared/types/layout';
import { isPane } from '../../shared/types/layout';

// ============================================================================
// Constructors
// ============================================================================

export function createPane(tabIds: string[] = [], activeTabId: string | null = null): Pane {
  return {
    kind: 'pane',
    id: nanoid(),
    tabIds,
    activeTabId,
  };
}

export function createSplitNode(
  direction: 'horizontal' | 'vertical',
  children: [TreeNode, TreeNode],
  ratio: number = 0.5,
): SplitNode {
  return {
    kind: 'split',
    id: nanoid(),
    direction,
    ratio,
    children,
  };
}

// ============================================================================
// Queries
// ============================================================================

/**
 * Get all panes in the tree (flattened).
 */
export function getAllPanes(node: TreeNode): Pane[] {
  if (isPane(node)) {
    return [node];
  }
  return [...getAllPanes(node.children[0]), ...getAllPanes(node.children[1])];
}

/**
 * Find the pane that contains a given tab ID.
 */
export function findPaneByTabId(node: TreeNode, tabId: string): Pane | null {
  if (isPane(node)) {
    return node.tabIds.includes(tabId) ? node : null;
  }
  return findPaneByTabId(node.children[0], tabId) || findPaneByTabId(node.children[1], tabId);
}

/**
 * Find a pane by its ID.
 */
export function findPaneById(node: TreeNode, paneId: string): Pane | null {
  if (isPane(node)) {
    return node.id === paneId ? node : null;
  }
  return findPaneById(node.children[0], paneId) || findPaneById(node.children[1], paneId);
}

/**
 * Find a split node by its ID.
 */
export function findSplitById(node: TreeNode, splitId: string): SplitNode | null {
  if (isPane(node)) return null;
  if (node.id === splitId) return node;
  return findSplitById(node.children[0], splitId) || findSplitById(node.children[1], splitId);
}

// ============================================================================
// Tree Mutations (pure - return new trees)
// ============================================================================

/**
 * Replace a node in the tree by ID, returning a new tree.
 */
export function replaceNode(tree: TreeNode, nodeId: string, replacement: TreeNode): TreeNode {
  if (tree.id === nodeId) {
    return replacement;
  }
  if (isPane(tree)) {
    return tree; // not found here
  }
  // SplitNode - recurse into children
  const newChild0 = replaceNode(tree.children[0], nodeId, replacement);
  const newChild1 = replaceNode(tree.children[1], nodeId, replacement);
  if (newChild0 === tree.children[0] && newChild1 === tree.children[1]) {
    return tree; // no change
  }
  return { ...tree, children: [newChild0, newChild1] };
}

/**
 * Update a pane in the tree by ID.
 */
export function updatePane(tree: TreeNode, paneId: string, updater: (pane: Pane) => Pane): TreeNode {
  if (isPane(tree)) {
    return tree.id === paneId ? updater(tree) : tree;
  }
  const newChild0 = updatePane(tree.children[0], paneId, updater);
  const newChild1 = updatePane(tree.children[1], paneId, updater);
  if (newChild0 === tree.children[0] && newChild1 === tree.children[1]) {
    return tree;
  }
  return { ...tree, children: [newChild0, newChild1] };
}

/**
 * Split a pane, inserting a new pane in the specified direction.
 *
 * `position` determines where the tab goes:
 * - 'before': tab goes to the NEW pane, placed first (left/top)
 * - 'after': tab goes to the NEW pane, placed second (right/bottom)
 *
 * If `tabId` is provided, it's moved from the original pane to the new pane.
 * If not provided, both panes keep their current tabs and the new pane starts empty.
 */
export function splitPane(
  tree: TreeNode,
  paneId: string,
  direction: 'horizontal' | 'vertical',
  position: 'before' | 'after',
  tabId?: string,
): { tree: TreeNode; newPaneId: string } {
  const pane = findPaneById(tree, paneId);
  if (!pane) return { tree, newPaneId: '' };

  let originalPane: Pane;
  let newPane: Pane;

  if (tabId && pane.tabIds.includes(tabId)) {
    // Move the tab to the new pane
    const remainingTabIds = pane.tabIds.filter(id => id !== tabId);
    if (remainingTabIds.length === 0) {
      // Don't create an empty pane — just keep the tab where it is
      return { tree, newPaneId: '' };
    }
    const newActiveTabId = pane.activeTabId === tabId
      ? (remainingTabIds[0] ?? null)
      : pane.activeTabId;
    originalPane = { ...pane, tabIds: remainingTabIds, activeTabId: newActiveTabId };
    newPane = createPane([tabId], tabId);
  } else {
    // No tab to move - keep original, create empty new pane
    originalPane = pane;
    newPane = createPane();
  }

  const children: [TreeNode, TreeNode] = position === 'before'
    ? [newPane, originalPane]
    : [originalPane, newPane];

  const splitNode = createSplitNode(direction, children);

  return {
    tree: replaceNode(tree, paneId, splitNode),
    newPaneId: newPane.id,
  };
}

/**
 * Collapse a split by removing an empty pane and promoting its sibling.
 * If the pane isn't empty, this is a no-op.
 */
export function collapseSplit(tree: TreeNode, emptyPaneId: string): TreeNode {
  if (isPane(tree)) return tree;

  // Check if this split directly contains the empty pane
  const [child0, child1] = tree.children;

  if (isPane(child0) && child0.id === emptyPaneId && child0.tabIds.length === 0) {
    // Child 0 is empty - promote child 1
    return child1;
  }
  if (isPane(child1) && child1.id === emptyPaneId && child1.tabIds.length === 0) {
    // Child 1 is empty - promote child 0
    return child0;
  }

  // Recurse into children
  const newChild0 = collapseSplit(tree.children[0], emptyPaneId);
  const newChild1 = collapseSplit(tree.children[1], emptyPaneId);

  // If a child was a split that collapsed, we might need to replace our child
  if (newChild0 === tree.children[0] && newChild1 === tree.children[1]) {
    return tree; // no change
  }

  return { ...tree, children: [newChild0, newChild1] };
}

/**
 * Move a tab from one pane to another.
 * Auto-collapses the source pane if it becomes empty.
 */
export function moveTabToPane(
  tree: TreeNode,
  tabId: string,
  sourcePaneId: string,
  targetPaneId: string,
  index: number,
): TreeNode {
  if (sourcePaneId === targetPaneId) {
    // Reorder within the same pane
    return updatePane(tree, sourcePaneId, (pane) => {
      const tabIds = [...pane.tabIds];
      const fromIndex = tabIds.indexOf(tabId);
      if (fromIndex === -1) return pane;
      tabIds.splice(fromIndex, 1);
      const adjustedIndex = index > fromIndex ? index - 1 : index;
      tabIds.splice(adjustedIndex, 0, tabId);
      return { ...pane, tabIds, activeTabId: tabId };
    });
  }

  // Remove from source
  let newTree = updatePane(tree, sourcePaneId, (pane) => {
    const tabIds = pane.tabIds.filter(id => id !== tabId);
    const newActive = pane.activeTabId === tabId
      ? (tabIds[Math.min(pane.tabIds.indexOf(tabId), tabIds.length - 1)] ?? null)
      : pane.activeTabId;
    return { ...pane, tabIds, activeTabId: newActive };
  });

  // Add to target
  newTree = updatePane(newTree, targetPaneId, (pane) => {
    const tabIds = [...pane.tabIds];
    tabIds.splice(Math.min(index, tabIds.length), 0, tabId);
    return { ...pane, tabIds, activeTabId: tabId };
  });

  // Auto-collapse if source is now empty
  const sourcePane = findPaneById(newTree, sourcePaneId);
  if (sourcePane && sourcePane.tabIds.length === 0) {
    newTree = collapseSplit(newTree, sourcePaneId);
  }

  return newTree;
}

/**
 * Remove a tab from a pane. Auto-collapses the pane if it becomes empty
 * AND is not the root pane.
 */
export function removeTabFromPane(
  tree: TreeNode,
  paneId: string,
  tabId: string,
): TreeNode {
  let newTree = updatePane(tree, paneId, (pane) => {
    const tabIds = pane.tabIds.filter(id => id !== tabId);
    let newActive = pane.activeTabId;
    if (pane.activeTabId === tabId) {
      const closingIndex = pane.tabIds.indexOf(tabId);
      // Prefer the next tab, then previous
      if (closingIndex < tabIds.length) {
        newActive = tabIds[closingIndex];
      } else if (tabIds.length > 0) {
        newActive = tabIds[tabIds.length - 1];
      } else {
        newActive = null;
      }
    }
    return { ...pane, tabIds, activeTabId: newActive };
  });

  // Auto-collapse any empty panes (not just the one we removed from).
  // Loop in case collapsing one empty pane reveals another.
  if (!isPane(newTree)) {
    let changed = true;
    while (changed && !isPane(newTree)) {
      changed = false;
      const allPanes = getAllPanes(newTree);
      for (const p of allPanes) {
        if (p.tabIds.length === 0) {
          newTree = collapseSplit(newTree, p.id);
          changed = true;
          break; // restart scan after structural change
        }
      }
    }
  }

  return newTree;
}

/**
 * Update the ratio of a split node.
 */
export function updateSplitRatio(tree: TreeNode, splitId: string, ratio: number): TreeNode {
  if (isPane(tree)) return tree;
  if (tree.id === splitId) {
    return { ...tree, ratio: Math.max(0.1, Math.min(0.9, ratio)) };
  }
  const newChild0 = updateSplitRatio(tree.children[0], splitId, ratio);
  const newChild1 = updateSplitRatio(tree.children[1], splitId, ratio);
  if (newChild0 === tree.children[0] && newChild1 === tree.children[1]) {
    return tree;
  }
  return { ...tree, children: [newChild0, newChild1] };
}

/**
 * Set the active tab in a pane.
 */
export function setActiveTabInPane(tree: TreeNode, paneId: string, tabId: string): TreeNode {
  return updatePane(tree, paneId, (pane) => ({
    ...pane,
    activeTabId: tabId,
  }));
}

/**
 * Add a tab to a pane, making it active.
 */
export function addTabToPane(tree: TreeNode, paneId: string, tabId: string, index?: number): TreeNode {
  return updatePane(tree, paneId, (pane) => {
    const tabIds = [...pane.tabIds];
    const insertAt = index !== undefined ? Math.min(index, tabIds.length) : tabIds.length;
    tabIds.splice(insertAt, 0, tabId);
    return { ...pane, tabIds, activeTabId: tabId };
  });
}

/**
 * Get the first pane in the tree (depth-first, leftmost).
 */
export function getFirstPane(node: TreeNode): Pane {
  if (isPane(node)) return node;
  return getFirstPane(node.children[0]);
}

