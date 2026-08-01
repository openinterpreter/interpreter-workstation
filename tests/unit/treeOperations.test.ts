/**
 * Unit Tests: Tree Operations
 *
 * Pure function tests for the split-tree layout system.
 * Run with: pnpm test:unit
 */

import { describe, test, expect } from 'bun:test';
import {
  createPane,
  createSplitNode,
  getAllPanes,
  findPaneByTabId,
  findPaneById,
  splitPane,
  collapseSplit,
  moveTabToPane,
  removeTabFromPane,
  updateSplitRatio,
  setActiveTabInPane,
  addTabToPane,
  getFirstPane,
  replaceNode,
  updatePane,
} from '../../src/utils/treeOperations';
import type { Pane, SplitNode, TreeNode } from '../../shared/types/layout';

// ============================================================================
// Helper: create test fixtures
// ============================================================================

function pane(tabIds: string[], activeTabId?: string | null, id?: string): Pane {
  return {
    kind: 'pane',
    id: id ?? `pane-${Math.random().toString(36).slice(2, 8)}`,
    tabIds,
    activeTabId: activeTabId !== undefined ? activeTabId : (tabIds[0] ?? null),
  };
}

function split(
  direction: 'horizontal' | 'vertical',
  children: [TreeNode, TreeNode],
  ratio = 0.5,
  id?: string,
): SplitNode {
  return {
    kind: 'split',
    id: id ?? `split-${Math.random().toString(36).slice(2, 8)}`,
    direction,
    ratio,
    children,
  };
}

// ============================================================================
// getAllPanes
// ============================================================================

describe('getAllPanes', () => {
  test('returns single pane from flat tree', () => {
    const p = pane(['t1', 't2']);
    const result = getAllPanes(p);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(p);
  });

  test('returns two panes from a split', () => {
    const p1 = pane(['t1']);
    const p2 = pane(['t2']);
    const tree = split('horizontal', [p1, p2]);
    const result = getAllPanes(tree);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(p1);
    expect(result[1]).toBe(p2);
  });

  test('returns all panes from deeply nested tree', () => {
    const p1 = pane(['t1']);
    const p2 = pane(['t2']);
    const p3 = pane(['t3']);
    const inner = split('vertical', [p2, p3]);
    const tree = split('horizontal', [p1, inner]);
    const result = getAllPanes(tree);
    expect(result).toHaveLength(3);
    expect(result.map(p => p.tabIds[0])).toEqual(['t1', 't2', 't3']);
  });
});

// ============================================================================
// findPaneByTabId
// ============================================================================

describe('findPaneByTabId', () => {
  test('finds pane in flat tree', () => {
    const p = pane(['t1', 't2']);
    expect(findPaneByTabId(p, 't1')).toBe(p);
    expect(findPaneByTabId(p, 't2')).toBe(p);
  });

  test('finds pane in deeply nested tree', () => {
    const p1 = pane(['t1']);
    const p2 = pane(['t2', 't3']);
    const p3 = pane(['t4']);
    const inner = split('vertical', [p2, p3]);
    const tree = split('horizontal', [p1, inner]);

    expect(findPaneByTabId(tree, 't1')).toBe(p1);
    expect(findPaneByTabId(tree, 't2')).toBe(p2);
    expect(findPaneByTabId(tree, 't3')).toBe(p2);
    expect(findPaneByTabId(tree, 't4')).toBe(p3);
  });

  test('returns null for nonexistent tab', () => {
    const p = pane(['t1']);
    expect(findPaneByTabId(p, 'nonexistent')).toBeNull();
  });
});

// ============================================================================
// findPaneById
// ============================================================================

describe('findPaneById', () => {
  test('finds pane by ID', () => {
    const p = pane(['t1'], null, 'my-pane');
    expect(findPaneById(p, 'my-pane')).toBe(p);
  });

  test('finds nested pane by ID', () => {
    const p1 = pane(['t1'], null, 'p1');
    const p2 = pane(['t2'], null, 'p2');
    const tree = split('horizontal', [p1, p2]);
    expect(findPaneById(tree, 'p2')).toBe(p2);
  });

  test('returns null for nonexistent ID', () => {
    const p = pane(['t1'], null, 'p1');
    expect(findPaneById(p, 'nonexistent')).toBeNull();
  });
});

// ============================================================================
// splitPane
// ============================================================================

describe('splitPane', () => {
  test('splits a leaf pane horizontally, tab to the right (after)', () => {
    const p = pane(['t1', 't2'], 't1', 'original');
    const result = splitPane(p, 'original', 'horizontal', 'after', 't2');

    // Root should now be a split
    expect(result.tree.kind).toBe('split');
    const s = result.tree as SplitNode;
    expect(s.direction).toBe('horizontal');

    // First child = original pane (without t2)
    expect(s.children[0].kind).toBe('pane');
    const left = s.children[0] as Pane;
    expect(left.tabIds).toEqual(['t1']);

    // Second child = new pane (with t2)
    expect(s.children[1].kind).toBe('pane');
    const right = s.children[1] as Pane;
    expect(right.tabIds).toEqual(['t2']);
    expect(right.activeTabId).toBe('t2');
    expect(result.newPaneId).toBe(right.id);
  });

  test('splits a leaf pane vertically, tab to the top (before)', () => {
    const p = pane(['t1', 't2'], 't1', 'original');
    const result = splitPane(p, 'original', 'vertical', 'before', 't2');

    const s = result.tree as SplitNode;
    expect(s.direction).toBe('vertical');

    // First child = new pane (before = top)
    const top = s.children[0] as Pane;
    expect(top.tabIds).toEqual(['t2']);

    // Second child = original pane
    const bottom = s.children[1] as Pane;
    expect(bottom.tabIds).toEqual(['t1']);
  });

  test('splits a nested pane inside an existing split tree', () => {
    const p1 = pane(['t1'], null, 'p1');
    const p2 = pane(['t2', 't3'], 't2', 'p2');
    const tree = split('horizontal', [p1, p2], 0.5, 'root-split');

    const result = splitPane(tree, 'p2', 'vertical', 'after', 't3');

    // Root should still be the same split
    expect(result.tree.kind).toBe('split');
    const root = result.tree as SplitNode;
    expect(root.id).toBe('root-split');

    // Left child unchanged
    expect(root.children[0]).toBe(p1);

    // Right child is now a vertical split
    expect(root.children[1].kind).toBe('split');
    const innerSplit = root.children[1] as SplitNode;
    expect(innerSplit.direction).toBe('vertical');

    // Inner first = p2 without t3
    const innerTop = innerSplit.children[0] as Pane;
    expect(innerTop.tabIds).toEqual(['t2']);

    // Inner second = new pane with t3
    const innerBottom = innerSplit.children[1] as Pane;
    expect(innerBottom.tabIds).toEqual(['t3']);
  });

  test('preserves all other panes in the tree', () => {
    const p1 = pane(['t1'], null, 'p1');
    const p2 = pane(['t2'], null, 'p2');
    const p3 = pane(['t3', 't4'], null, 'p3');
    const left = split('vertical', [p1, p2]);
    const tree = split('horizontal', [left, p3]);

    const result = splitPane(tree, 'p3', 'horizontal', 'after', 't4');
    const allPanes = getAllPanes(result.tree);
    expect(allPanes).toHaveLength(4); // p1, p2, p3 (modified), new pane
    expect(allPanes[0]).toBe(p1);
    expect(allPanes[1]).toBe(p2);
  });

  test('handles split with no tabId (creates empty new pane)', () => {
    const p = pane(['t1', 't2'], 't1', 'original');
    const result = splitPane(p, 'original', 'horizontal', 'after');

    const s = result.tree as SplitNode;
    const left = s.children[0] as Pane;
    const right = s.children[1] as Pane;

    expect(left.tabIds).toEqual(['t1', 't2']); // original unchanged
    expect(right.tabIds).toEqual([]); // new pane is empty
  });
});

// ============================================================================
// collapseSplit
// ============================================================================

describe('collapseSplit', () => {
  test('removes empty pane and promotes sibling to parent position', () => {
    const empty = pane([], null, 'empty');
    const sibling = pane(['t1'], 't1', 'sibling');
    const tree = split('horizontal', [empty, sibling]);

    const result = collapseSplit(tree, 'empty');
    expect(result).toBe(sibling);
  });

  test('collapses when empty pane is on the right', () => {
    const sibling = pane(['t1'], 't1', 'sibling');
    const empty = pane([], null, 'empty');
    const tree = split('horizontal', [sibling, empty]);

    const result = collapseSplit(tree, 'empty');
    expect(result).toBe(sibling);
  });

  test('collapses deeply nested split when inner pane empties', () => {
    const p1 = pane(['t1'], null, 'p1');
    const empty = pane([], null, 'empty');
    const p3 = pane(['t3'], null, 'p3');
    const inner = split('vertical', [empty, p3], 0.5, 'inner-split');
    const tree = split('horizontal', [p1, inner], 0.5, 'root-split');

    const result = collapseSplit(tree, 'empty');

    // Root split should remain, but inner split should collapse
    expect(result.kind).toBe('split');
    const root = result as SplitNode;
    expect(root.children[0]).toBe(p1);
    expect(root.children[1]).toBe(p3); // p3 promoted to replace inner split
  });

  test('handles collapsing root split (result is a single pane)', () => {
    const sibling = pane(['t1'], 't1', 'sibling');
    const empty = pane([], null, 'empty');
    const tree = split('horizontal', [sibling, empty]);

    const result = collapseSplit(tree, 'empty');
    expect(result.kind).toBe('pane');
    expect((result as Pane).tabIds).toEqual(['t1']);
  });

  test('no-op when pane is not empty', () => {
    const p1 = pane(['t1'], null, 'p1');
    const p2 = pane(['t2'], null, 'p2');
    const tree = split('horizontal', [p1, p2]);

    const result = collapseSplit(tree, 'p1');
    expect(result).toBe(tree); // unchanged - p1 has tabs
  });
});

// ============================================================================
// moveTabToPane
// ============================================================================

describe('moveTabToPane', () => {
  test('moves tab between two panes', () => {
    const p1 = pane(['t1', 't2'], 't1', 'p1');
    const p2 = pane(['t3'], 't3', 'p2');
    const tree = split('horizontal', [p1, p2]);

    const result = moveTabToPane(tree, 't2', 'p1', 'p2', 0);
    const panes = getAllPanes(result);

    expect(panes).toHaveLength(2);
    expect(panes[0].tabIds).toEqual(['t1']);
    expect(panes[1].tabIds).toEqual(['t2', 't3']);
    expect(panes[1].activeTabId).toBe('t2');
  });

  test('auto-collapses source pane if it becomes empty', () => {
    const p1 = pane(['t1'], 't1', 'p1');
    const p2 = pane(['t2'], 't2', 'p2');
    const tree = split('horizontal', [p1, p2]);

    const result = moveTabToPane(tree, 't1', 'p1', 'p2', 1);

    // Should collapse to a single pane
    expect(result.kind).toBe('pane');
    const resultPane = result as Pane;
    expect(resultPane.tabIds).toEqual(['t2', 't1']);
  });

  test('inserts at specified index in target pane', () => {
    const p1 = pane(['t1', 't2'], 't1', 'p1');
    const p2 = pane(['t3', 't4', 't5'], 't3', 'p2');
    const tree = split('horizontal', [p1, p2]);

    const result = moveTabToPane(tree, 't1', 'p1', 'p2', 1);
    const p2After = findPaneById(result, 'p2');
    expect(p2After?.tabIds).toEqual(['t3', 't1', 't4', 't5']);
  });

  test('reorders within the same pane', () => {
    const p = pane(['t1', 't2', 't3'], 't1', 'p1');
    const result = moveTabToPane(p, 't3', 'p1', 'p1', 0);

    const resultPane = result as Pane;
    expect(resultPane.tabIds).toEqual(['t3', 't1', 't2']);
    expect(resultPane.activeTabId).toBe('t3');
  });
});

// ============================================================================
// removeTabFromPane
// ============================================================================

describe('removeTabFromPane', () => {
  test('removes a tab and selects next', () => {
    const p = pane(['t1', 't2', 't3'], 't2', 'p1');
    const result = removeTabFromPane(p, 'p1', 't2');
    const resultPane = result as Pane;
    expect(resultPane.tabIds).toEqual(['t1', 't3']);
    expect(resultPane.activeTabId).toBe('t3'); // next tab after t2
  });

  test('removes last tab and selects previous', () => {
    const p = pane(['t1', 't2'], 't2', 'p1');
    const result = removeTabFromPane(p, 'p1', 't2');
    const resultPane = result as Pane;
    expect(resultPane.tabIds).toEqual(['t1']);
    expect(resultPane.activeTabId).toBe('t1');
  });

  test('removes only tab, pane stays (root pane)', () => {
    const p = pane(['t1'], 't1', 'p1');
    const result = removeTabFromPane(p, 'p1', 't1');
    // Root pane stays even when empty
    expect(result.kind).toBe('pane');
    const resultPane = result as Pane;
    expect(resultPane.tabIds).toEqual([]);
    expect(resultPane.activeTabId).toBeNull();
  });

  test('auto-collapses pane in split when becoming empty', () => {
    const p1 = pane(['t1'], 't1', 'p1');
    const p2 = pane(['t2'], 't2', 'p2');
    const tree = split('horizontal', [p1, p2]);

    const result = removeTabFromPane(tree, 'p1', 't1');
    // Should collapse: p1 is empty, promote p2
    expect(result.kind).toBe('pane');
    expect((result as Pane).id).toBe('p2');
  });

  test('does not affect activeTabId when removing non-active tab', () => {
    const p = pane(['t1', 't2', 't3'], 't1', 'p1');
    const result = removeTabFromPane(p, 'p1', 't3');
    const resultPane = result as Pane;
    expect(resultPane.activeTabId).toBe('t1'); // unchanged
  });
});

// ============================================================================
// updateSplitRatio
// ============================================================================

describe('updateSplitRatio', () => {
  test('updates ratio of a split node', () => {
    const p1 = pane(['t1']);
    const p2 = pane(['t2']);
    const tree = split('horizontal', [p1, p2], 0.5, 'my-split');

    const result = updateSplitRatio(tree, 'my-split', 0.7);
    expect((result as SplitNode).ratio).toBe(0.7);
  });

  test('clamps ratio between 0.1 and 0.9', () => {
    const p1 = pane(['t1']);
    const p2 = pane(['t2']);
    const tree = split('horizontal', [p1, p2], 0.5, 'my-split');

    expect((updateSplitRatio(tree, 'my-split', 0.05) as SplitNode).ratio).toBe(0.1);
    expect((updateSplitRatio(tree, 'my-split', 0.95) as SplitNode).ratio).toBe(0.9);
  });

  test('no-op for nonexistent split ID', () => {
    const p = pane(['t1']);
    const result = updateSplitRatio(p, 'nonexistent', 0.7);
    expect(result).toBe(p);
  });
});

// ============================================================================
// setActiveTabInPane
// ============================================================================

describe('setActiveTabInPane', () => {
  test('sets active tab', () => {
    const p = pane(['t1', 't2'], 't1', 'p1');
    const result = setActiveTabInPane(p, 'p1', 't2');
    expect((result as Pane).activeTabId).toBe('t2');
  });
});

// ============================================================================
// addTabToPane
// ============================================================================

describe('addTabToPane', () => {
  test('adds tab at end by default', () => {
    const p = pane(['t1'], 't1', 'p1');
    const result = addTabToPane(p, 'p1', 't2');
    const resultPane = result as Pane;
    expect(resultPane.tabIds).toEqual(['t1', 't2']);
    expect(resultPane.activeTabId).toBe('t2');
  });

  test('adds tab at specific index', () => {
    const p = pane(['t1', 't3'], 't1', 'p1');
    const result = addTabToPane(p, 'p1', 't2', 1);
    expect((result as Pane).tabIds).toEqual(['t1', 't2', 't3']);
  });
});

// ============================================================================
// getFirstPane
// ============================================================================

describe('getFirstPane', () => {
  test('returns the pane from flat tree', () => {
    const p = pane(['t1']);
    expect(getFirstPane(p)).toBe(p);
  });

  test('returns leftmost pane from split tree', () => {
    const p1 = pane(['t1']);
    const p2 = pane(['t2']);
    const p3 = pane(['t3']);
    const inner = split('vertical', [p2, p3]);
    const tree = split('horizontal', [p1, inner]);
    expect(getFirstPane(tree)).toBe(p1);
  });
});

// ============================================================================
// replaceNode
// ============================================================================

describe('replaceNode', () => {
  test('replaces root node', () => {
    const p = pane(['t1'], null, 'p1');
    const replacement = pane(['t2'], null, 'p2');
    const result = replaceNode(p, 'p1', replacement);
    expect(result).toBe(replacement);
  });

  test('replaces nested node', () => {
    const p1 = pane(['t1'], null, 'p1');
    const p2 = pane(['t2'], null, 'p2');
    const tree = split('horizontal', [p1, p2], 0.5, 's1');
    const replacement = pane(['t3'], null, 'p3');
    const result = replaceNode(tree, 'p2', replacement);
    expect((result as SplitNode).children[1]).toBe(replacement);
    expect((result as SplitNode).children[0]).toBe(p1);
  });
});
