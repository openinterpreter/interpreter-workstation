/**
 * Unified Pane/Tab System Integration Tests
 *
 * Tests the complete unified windowing system: tab dragging, split creation,
 * cross-pane moves, sidebar operations, and state preservation.
 *
 * Run with: bun test tests/unit/unifiedPaneSystem.test.ts
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
} from '../../src/utils/treeOperations';
import type { Pane, SplitNode, TreeNode, Tab, LayoutState } from '../../shared/types/layout';
import { isPane, isSplitNode, STATEFUL_TAB_TYPES } from '../../shared/types/layout';

// ============================================================================
// Helpers
// ============================================================================

let _id = 0;
function uid(prefix = 'id') { return `${prefix}-${++_id}`; }

function pane(tabIds: string[], activeTabId?: string | null, id?: string): Pane {
  return {
    kind: 'pane',
    id: id ?? uid('pane'),
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
    id: id ?? uid('split'),
    direction,
    ratio,
    children,
  };
}

function makeTab(id: string, type: Tab['type'] = 'file', extra?: Partial<Tab>): Tab {
  return { id, type, label: `Tab ${id}`, ...extra };
}

function makeTabRegistry(tabs: Tab[]): Record<string, Tab> {
  const registry: Record<string, Tab> = {};
  for (const t of tabs) registry[t.id] = t;
  return registry;
}

// Simulates the drop-zone logic in PaneView / LayoutContext's handleTabDrop:
// center = move tab to pane, edge = split pane in that direction.
function simulateTabDrop(
  tree: TreeNode,
  tabs: Record<string, Tab>,
  tabId: string,
  sourcePaneId: string | null,
  targetPaneId: string,
  zone: 'center' | 'left' | 'right' | 'top' | 'bottom',
): { tree: TreeNode; tabs: Record<string, Tab> } {
  const newTabs = { ...tabs };

  if (zone === 'center') {
    // Move tab to the target pane (append at end)
    if (sourcePaneId && sourcePaneId !== targetPaneId) {
      tree = moveTabToPane(tree, tabId, sourcePaneId, targetPaneId, 9999);
    }
    // Activate the tab in the target pane
    tree = setActiveTabInPane(tree, targetPaneId, tabId);
    return { tree, tabs: newTabs };
  }

  // Edge drop: split the target pane
  const direction = (zone === 'left' || zone === 'right') ? 'horizontal' : 'vertical';
  const position = (zone === 'left' || zone === 'top') ? 'before' : 'after';

  // If the tab comes from another pane, remove it first
  if (sourcePaneId) {
    tree = removeTabFromPane(tree, sourcePaneId, tabId);
    // If removing emptied the pane, it auto-collapses. Re-find targetPaneId.
  }

  // Split the target pane, moving the tab into the new split
  const result = splitPane(tree, targetPaneId, direction, position, undefined);
  tree = result.tree;

  if (result.newPaneId) {
    // Add the tab to the new pane
    tree = addTabToPane(tree, result.newPaneId, tabId);
  }

  return { tree, tabs: newTabs };
}

// ============================================================================
// Test: Drag Tab Between Panes (Center Drop)
// ============================================================================

describe('Drag tab between panes (center drop)', () => {
  test('moves a file tab from left pane to right pane', () => {
    const p1 = pane(['f1', 'f2'], 'f1', 'left');
    const p2 = pane(['f3'], 'f3', 'right');
    const tree = split('horizontal', [p1, p2]);
    const tabs = makeTabRegistry([
      makeTab('f1'), makeTab('f2'), makeTab('f3'),
    ]);

    const result = simulateTabDrop(tree, tabs, 'f2', 'left', 'right', 'center');

    const left = findPaneById(result.tree, 'left')!;
    const right = findPaneById(result.tree, 'right')!;
    expect(left.tabIds).toEqual(['f1']);
    expect(right.tabIds).toEqual(['f3', 'f2']);
    expect(right.activeTabId).toBe('f2');
  });

  test('moving last tab from a pane collapses the split', () => {
    const p1 = pane(['f1'], 'f1', 'left');
    const p2 = pane(['f2'], 'f2', 'right');
    const tree = split('horizontal', [p1, p2]);
    const tabs = makeTabRegistry([makeTab('f1'), makeTab('f2')]);

    const result = simulateTabDrop(tree, tabs, 'f1', 'left', 'right', 'center');

    // Should collapse to single pane since left is now empty
    expect(result.tree.kind).toBe('pane');
    const remaining = result.tree as Pane;
    expect(remaining.tabIds).toEqual(['f2', 'f1']);
  });

  test('moving tab to same pane is a no-op (reorder)', () => {
    const p1 = pane(['f1', 'f2', 'f3'], 'f1', 'p1');
    const tabs = makeTabRegistry([makeTab('f1'), makeTab('f2'), makeTab('f3')]);

    const result = simulateTabDrop(p1, tabs, 'f2', 'p1', 'p1', 'center');
    const resultPane = result.tree as Pane;
    expect(resultPane.tabIds).toContain('f2');
    expect(resultPane.activeTabId).toBe('f2');
  });
});

// ============================================================================
// Test: Drag Tab to Edge Creates Split View
// ============================================================================

describe('Drag tab to edge creates split view', () => {
  test('drag to right edge creates horizontal split', () => {
    const p1 = pane(['f1', 'f2'], 'f1', 'main');
    const tabs = makeTabRegistry([makeTab('f1'), makeTab('f2')]);

    const result = simulateTabDrop(p1, tabs, 'f2', 'main', 'main', 'right');

    expect(result.tree.kind).toBe('split');
    const s = result.tree as SplitNode;
    expect(s.direction).toBe('horizontal');

    // Original pane should be on left (position='after' puts new pane on right)
    const leftPane = s.children[0] as Pane;
    const rightPane = s.children[1] as Pane;
    expect(leftPane.tabIds).toEqual(['f1']); // f2 was removed
    expect(rightPane.tabIds).toEqual(['f2']); // f2 moved here
  });

  test('drag to left edge creates horizontal split (new pane on left)', () => {
    const p1 = pane(['f1', 'f2'], 'f1', 'main');
    const tabs = makeTabRegistry([makeTab('f1'), makeTab('f2')]);

    const result = simulateTabDrop(p1, tabs, 'f2', 'main', 'main', 'left');

    expect(result.tree.kind).toBe('split');
    const s = result.tree as SplitNode;
    expect(s.direction).toBe('horizontal');

    // 'left' = position 'before', so new pane is children[0]
    const leftPane = s.children[0] as Pane;
    const rightPane = s.children[1] as Pane;
    expect(leftPane.tabIds).toEqual(['f2']);
    expect(rightPane.tabIds).toEqual(['f1']);
  });

  test('drag to bottom edge creates vertical split', () => {
    const p1 = pane(['f1', 'f2'], 'f1', 'main');
    const tabs = makeTabRegistry([makeTab('f1'), makeTab('f2')]);

    const result = simulateTabDrop(p1, tabs, 'f2', 'main', 'main', 'bottom');

    expect(result.tree.kind).toBe('split');
    const s = result.tree as SplitNode;
    expect(s.direction).toBe('vertical');

    const topPane = s.children[0] as Pane;
    const bottomPane = s.children[1] as Pane;
    expect(topPane.tabIds).toEqual(['f1']);
    expect(bottomPane.tabIds).toEqual(['f2']);
  });

  test('drag to top edge creates vertical split (new pane on top)', () => {
    const p1 = pane(['f1', 'f2'], 'f1', 'main');
    const tabs = makeTabRegistry([makeTab('f1'), makeTab('f2')]);

    const result = simulateTabDrop(p1, tabs, 'f2', 'main', 'main', 'top');

    expect(result.tree.kind).toBe('split');
    const s = result.tree as SplitNode;
    expect(s.direction).toBe('vertical');

    const topPane = s.children[0] as Pane;
    const bottomPane = s.children[1] as Pane;
    expect(topPane.tabIds).toEqual(['f2']);
    expect(bottomPane.tabIds).toEqual(['f1']);
  });

  test('drag from one pane to the edge of another creates a nested split', () => {
    const p1 = pane(['f1', 'f2'], 'f1', 'left');
    const p2 = pane(['f3'], 'f3', 'right');
    const tree = split('horizontal', [p1, p2], 0.5, 'root');
    const tabs = makeTabRegistry([makeTab('f1'), makeTab('f2'), makeTab('f3')]);

    // Drag f2 from left pane to the bottom edge of right pane
    const result = simulateTabDrop(tree, tabs, 'f2', 'left', 'right', 'bottom');

    // Left pane should have only f1
    const leftPanes = getAllPanes(result.tree).filter(p => p.tabIds.includes('f1'));
    expect(leftPanes).toHaveLength(1);
    expect(leftPanes[0].tabIds).toEqual(['f1']);

    // Right side should now be a vertical split with f3 on top and f2 on bottom
    const allPanes = getAllPanes(result.tree);
    const f3Pane = allPanes.find(p => p.tabIds.includes('f3'))!;
    const f2Pane = allPanes.find(p => p.tabIds.includes('f2'))!;
    expect(f3Pane).toBeDefined();
    expect(f2Pane).toBeDefined();
    expect(f3Pane.id).not.toBe(f2Pane.id);
  });
});

// ============================================================================
// Test: Drag Agent/Terminal/Codex Tabs (Stateful Tabs)
// ============================================================================

describe('Drag stateful tabs (terminal, browser)', () => {
  test('terminal tab moves between panes without data loss', () => {
    const terminalTab = makeTab('agent-1', 'terminal', { agentTabId: 'a1', terminalAgent: 'claude-code', label: 'Claude Code' });
    const fileTab = makeTab('f1', 'file', { path: '/test.ts' });
    const p1 = pane(['agent-1', 'f1'], 'agent-1', 'left');
    const p2 = pane(['f2'], 'f2', 'right');
    const tree = split('horizontal', [p1, p2]);
    const tabs = makeTabRegistry([terminalTab, fileTab, makeTab('f2')]);

    // Move terminal from left to right (center drop)
    const result = simulateTabDrop(tree, tabs, 'agent-1', 'left', 'right', 'center');

    const rightPane = findPaneById(result.tree, 'right')!;
    expect(rightPane.tabIds).toContain('agent-1');
    expect(rightPane.activeTabId).toBe('agent-1');

    // Tab data preserved in registry
    expect(result.tabs['agent-1'].type).toBe('terminal');
    expect(result.tabs['agent-1'].agentTabId).toBe('a1');
  });

  test('terminal tab can be dragged to edge to create split', () => {
    const termTab = makeTab('term-1', 'terminal', { terminalAgent: 'claude-code', label: 'Terminal' });
    const fileTab = makeTab('f1', 'file');
    const p1 = pane(['term-1', 'f1'], 'term-1', 'main');
    const tabs = makeTabRegistry([termTab, fileTab]);

    const result = simulateTabDrop(p1, tabs, 'term-1', 'main', 'main', 'right');

    expect(result.tree.kind).toBe('split');
    const s = result.tree as SplitNode;
    const rightPane = s.children[1] as Pane;
    expect(rightPane.tabIds).toEqual(['term-1']);
    expect(result.tabs['term-1'].type).toBe('terminal');
    expect(result.tabs['term-1'].terminalAgent).toBe('claude-code');
  });

  test('codex-profile terminal tab preserves state across cross-pane move', () => {
    const codexTab = makeTab('codex-1', 'terminal', { terminalAgent: 'codex', label: 'Codex' });
    const p1 = pane(['codex-1'], 'codex-1', 'left');
    const p2 = pane(['f1'], 'f1', 'right');
    const tree = split('horizontal', [p1, p2]);
    const tabs = makeTabRegistry([codexTab, makeTab('f1')]);

    const result = simulateTabDrop(tree, tabs, 'codex-1', 'left', 'right', 'center');

    // Left pane collapsed (was empty)
    expect(result.tree.kind).toBe('pane');
    const remaining = result.tree as Pane;
    expect(remaining.tabIds).toContain('codex-1');
    expect(result.tabs['codex-1'].terminalAgent).toBe('codex');
  });

  test('STATEFUL_TAB_TYPES includes all tab types', () => {
    expect(STATEFUL_TAB_TYPES.has('terminal')).toBe(true);
    expect(STATEFUL_TAB_TYPES.has('browser')).toBe(true);
    expect(STATEFUL_TAB_TYPES.has('file')).toBe(true);
    expect(STATEFUL_TAB_TYPES.has('agent')).toBe(true);
    expect(STATEFUL_TAB_TYPES.has('email')).toBe(true);
    expect(STATEFUL_TAB_TYPES.has('chat')).toBe(true);
    expect(STATEFUL_TAB_TYPES.has('settings')).toBe(true);
  });
});

// ============================================================================
// Test: Sidebar ↔ Center Pane Operations
// ============================================================================

describe('Sidebar to center pane operations', () => {
  test('terminal tab in sidebar pane can be moved to center tree', () => {
    // Sidebar pane with terminal tabs
    const sidebarPane = pane(['term-1', 'term-2'], 'term-1', 'sidebar');
    // Center tree with one pane
    const centerPane = pane(['f1'], 'f1', 'center');

    const tabs = makeTabRegistry([
      makeTab('term-1', 'terminal', { terminalAgent: 'claude-code', label: 'Claude Code 1' }),
      makeTab('term-2', 'terminal', { terminalAgent: 'claude-code', label: 'Claude Code 2' }),
      makeTab('f1', 'file'),
    ]);

    // Simulate: remove term-1 from sidebar, add to center pane
    const updatedSidebar: Pane = {
      ...sidebarPane,
      tabIds: sidebarPane.tabIds.filter(id => id !== 'term-1'),
      activeTabId: 'term-2',
    };
    const updatedCenter = addTabToPane(centerPane, 'center', 'term-1');

    expect(updatedSidebar.tabIds).toEqual(['term-2']);
    expect(updatedSidebar.activeTabId).toBe('term-2');
    const centerResult = updatedCenter as Pane;
    expect(centerResult.tabIds).toEqual(['f1', 'term-1']);
    expect(centerResult.activeTabId).toBe('term-1');
    expect(tabs['term-1'].type).toBe('terminal');
  });

  test('tab from center pane can be moved to sidebar pane', () => {
    const centerPane = pane(['f1', 'term-1'], 'f1', 'center');
    const sidebarPane = pane(['term-2'], 'term-2', 'sidebar');

    const tabs = makeTabRegistry([
      makeTab('f1', 'file'),
      makeTab('term-1', 'terminal', { terminalAgent: 'claude-code' }),
      makeTab('term-2', 'terminal', { terminalAgent: 'claude-code' }),
    ]);

    // Remove term-1 from center, add to sidebar
    const updatedCenter = removeTabFromPane(centerPane, 'center', 'term-1');
    const updatedSidebar: Pane = {
      ...sidebarPane,
      tabIds: [...sidebarPane.tabIds, 'term-1'],
      activeTabId: 'term-1',
    };

    const centerResult = updatedCenter as Pane;
    expect(centerResult.tabIds).toEqual(['f1']);
    expect(updatedSidebar.tabIds).toEqual(['term-2', 'term-1']);
    expect(updatedSidebar.activeTabId).toBe('term-1');
  });

  test('sidebar pane is independent from the center tree', () => {
    const centerTree = split('horizontal', [
      pane(['f1'], 'f1', 'left'),
      pane(['f2'], 'f2', 'right'),
    ]);
    const sidebarPane = pane(['term-1'], 'term-1', 'sidebar');

    // Operations on center tree don't affect sidebar
    const updatedTree = removeTabFromPane(centerTree, 'left', 'f1');

    // Sidebar unchanged
    expect(sidebarPane.tabIds).toEqual(['term-1']);

    // Center tree collapsed
    expect(updatedTree.kind).toBe('pane');
    expect((updatedTree as Pane).id).toBe('right');
  });
});

// ============================================================================
// Test: Complex Multi-Step Drag Scenarios
// ============================================================================

describe('Complex multi-step drag scenarios', () => {
  test('scenario: split, move, split again, collapse', () => {
    // Start: single pane with 3 file tabs
    let tree: TreeNode = pane(['f1', 'f2', 'f3'], 'f1', 'main');
    const tabs = makeTabRegistry([makeTab('f1'), makeTab('f2'), makeTab('f3')]);

    // Step 1: Drag f2 to right edge → horizontal split
    let result = simulateTabDrop(tree, tabs, 'f2', 'main', 'main', 'right');
    tree = result.tree;
    expect(tree.kind).toBe('split');
    let allPanes = getAllPanes(tree);
    expect(allPanes).toHaveLength(2);
    const leftPane = allPanes.find(p => p.tabIds.includes('f1'))!;
    const rightPane = allPanes.find(p => p.tabIds.includes('f2'))!;
    expect(leftPane.tabIds).toEqual(['f1', 'f3']); // f3 stayed with f1
    expect(rightPane.tabIds).toEqual(['f2']);

    // Step 2: Drag f3 to bottom edge of left pane → nested vertical split
    result = simulateTabDrop(tree, tabs, 'f3', leftPane.id, leftPane.id, 'bottom');
    tree = result.tree;
    allPanes = getAllPanes(tree);
    expect(allPanes).toHaveLength(3); // f1, f3, f2 each in own pane

    // Step 3: Close f3's pane (remove tab) → should collapse back
    const f3Pane = findPaneByTabId(tree, 'f3')!;
    tree = removeTabFromPane(tree, f3Pane.id, 'f3');
    allPanes = getAllPanes(tree);
    expect(allPanes).toHaveLength(2); // back to 2 panes

    // Step 4: Move f2 to the pane with f1 (center drop) → collapses to single pane
    const f2Pane = findPaneByTabId(tree, 'f2')!;
    const f1Pane = findPaneByTabId(tree, 'f1')!;
    result = simulateTabDrop(tree, tabs, 'f2', f2Pane.id, f1Pane.id, 'center');
    tree = result.tree;

    // Should be a single pane with both tabs
    expect(tree.kind).toBe('pane');
    expect((tree as Pane).tabIds).toContain('f1');
    expect((tree as Pane).tabIds).toContain('f2');
  });

  test('scenario: 4-way split via sequential edge drags', () => {
    let tree: TreeNode = pane(['f1', 'f2', 'f3', 'f4'], 'f1', 'main');
    const tabs = makeTabRegistry([
      makeTab('f1'), makeTab('f2'), makeTab('f3'), makeTab('f4'),
    ]);

    // Split f2 to right
    let result = simulateTabDrop(tree, tabs, 'f2', 'main', 'main', 'right');
    tree = result.tree;
    expect(getAllPanes(tree)).toHaveLength(2);

    // Split f3 to bottom of left pane (where f1,f3,f4 are)
    const f1Pane = findPaneByTabId(tree, 'f1')!;
    result = simulateTabDrop(tree, tabs, 'f3', f1Pane.id, f1Pane.id, 'bottom');
    tree = result.tree;
    expect(getAllPanes(tree)).toHaveLength(3);

    // Split f4 to bottom of top-left pane (where f1,f4 are)
    const f1PaneAgain = findPaneByTabId(tree, 'f1')!;
    result = simulateTabDrop(tree, tabs, 'f4', f1PaneAgain.id, f1PaneAgain.id, 'bottom');
    tree = result.tree;

    const allPanes = getAllPanes(tree);
    expect(allPanes).toHaveLength(4);

    // Each tab should be in its own pane
    expect(findPaneByTabId(tree, 'f1')!.tabIds).toEqual(['f1']);
    expect(findPaneByTabId(tree, 'f2')!.tabIds).toEqual(['f2']);
    expect(findPaneByTabId(tree, 'f3')!.tabIds).toEqual(['f3']);
    expect(findPaneByTabId(tree, 'f4')!.tabIds).toEqual(['f4']);
  });

  test('scenario: terminal in sidebar, drag to center, split, drag back', () => {
    // Center: single pane with a file
    let centerTree: TreeNode = pane(['f1'], 'f1', 'center');
    // Sidebar: terminal tab
    let sidebarPane: Pane = pane(['term-1'], 'term-1', 'sidebar');
    const tabs = makeTabRegistry([
      makeTab('f1', 'file'),
      makeTab('term-1', 'terminal', { agentTabId: 'a1', terminalAgent: 'claude-code' }),
    ]);

    // Step 1: Move term-1 from sidebar to center (center drop)
    sidebarPane = { ...sidebarPane, tabIds: [], activeTabId: null };
    centerTree = addTabToPane(centerTree, 'center', 'term-1');
    let centerResult = centerTree as Pane;
    expect(centerResult.tabIds).toEqual(['f1', 'term-1']);

    // Step 2: Drag term-1 to right edge → creates split
    let result = simulateTabDrop(centerTree, tabs, 'term-1', 'center', 'center', 'right');
    centerTree = result.tree;
    expect(centerTree.kind).toBe('split');
    expect(getAllPanes(centerTree)).toHaveLength(2);
    const termPane = findPaneByTabId(centerTree, 'term-1')!;
    expect(termPane.tabIds).toEqual(['term-1']);

    // Step 3: Move term-1 back to sidebar
    centerTree = removeTabFromPane(centerTree, termPane.id, 'term-1');
    sidebarPane = { ...sidebarPane, tabIds: ['term-1'], activeTabId: 'term-1' };

    // Center should collapse back to single pane
    expect(centerTree.kind).toBe('pane');
    expect((centerTree as Pane).tabIds).toEqual(['f1']);

    // Terminal back in sidebar
    expect(sidebarPane.tabIds).toEqual(['term-1']);
    expect(tabs['term-1'].agentTabId).toBe('a1'); // Data preserved
  });
});

// ============================================================================
// Test: Split View Resize
// ============================================================================

describe('Split view resize', () => {
  test('resize handle updates split ratio', () => {
    const p1 = pane(['f1'], 'f1', 'left');
    const p2 = pane(['f2'], 'f2', 'right');
    const tree = split('horizontal', [p1, p2], 0.5, 'root');

    const resized = updateSplitRatio(tree, 'root', 0.3);
    expect((resized as SplitNode).ratio).toBe(0.3);
  });

  test('resize is clamped to valid range', () => {
    const p1 = pane(['f1']);
    const p2 = pane(['f2']);
    const tree = split('horizontal', [p1, p2], 0.5, 'root');

    expect((updateSplitRatio(tree, 'root', 0.01) as SplitNode).ratio).toBe(0.1);
    expect((updateSplitRatio(tree, 'root', 0.99) as SplitNode).ratio).toBe(0.9);
  });

  test('nested split resize only affects targeted split', () => {
    const p1 = pane(['f1']);
    const p2 = pane(['f2']);
    const p3 = pane(['f3']);
    const inner = split('vertical', [p2, p3], 0.5, 'inner');
    const tree = split('horizontal', [p1, inner], 0.5, 'outer');

    const resized = updateSplitRatio(tree, 'inner', 0.7);
    const root = resized as SplitNode;
    expect(root.ratio).toBe(0.5); // outer unchanged
    expect((root.children[1] as SplitNode).ratio).toBe(0.7); // inner changed
  });
});

// ============================================================================
// Test: Tab Type Guards
// ============================================================================

describe('Type guards and layout types', () => {
  test('isPane identifies panes correctly', () => {
    expect(isPane(pane(['t1']))).toBe(true);
    expect(isPane(split('horizontal', [pane([]), pane([])]))).toBe(false);
  });

  test('isSplitNode identifies splits correctly', () => {
    expect(isSplitNode(split('horizontal', [pane([]), pane([])]))).toBe(true);
    expect(isSplitNode(pane(['t1']))).toBe(false);
  });
});

// ============================================================================
// Test: Edge Cases
// ============================================================================

describe('Edge cases', () => {
  test('dropping tab on its own pane center is harmless', () => {
    const p = pane(['f1', 'f2'], 'f1', 'main');
    const tabs = makeTabRegistry([makeTab('f1'), makeTab('f2')]);

    const result = simulateTabDrop(p, tabs, 'f1', 'main', 'main', 'center');
    const resultPane = result.tree as Pane;
    expect(resultPane.tabIds).toContain('f1');
    expect(resultPane.tabIds).toContain('f2');
    expect(resultPane.activeTabId).toBe('f1');
  });

  test('splitting a pane with one tab leaves original pane with no tabs (creates empty pane in original)', () => {
    const p = pane(['f1'], 'f1', 'main');
    const tabs = makeTabRegistry([makeTab('f1')]);

    const result = simulateTabDrop(p, tabs, 'f1', 'main', 'main', 'right');
    // After removing f1 from main, main becomes empty. splitPane creates new pane.
    const allPanes = getAllPanes(result.tree);
    // One pane should have f1, the other should be the new empty one
    const f1Pane = allPanes.find(p => p.tabIds.includes('f1'));
    expect(f1Pane).toBeDefined();
  });

  test('getAllPanes returns panes in left-to-right (depth-first) order', () => {
    const p1 = pane(['f1'], null, 'p1');
    const p2 = pane(['f2'], null, 'p2');
    const p3 = pane(['f3'], null, 'p3');
    const p4 = pane(['f4'], null, 'p4');
    const inner1 = split('vertical', [p1, p2]);
    const inner2 = split('vertical', [p3, p4]);
    const tree = split('horizontal', [inner1, inner2]);

    const panes = getAllPanes(tree);
    expect(panes.map(p => p.id)).toEqual(['p1', 'p2', 'p3', 'p4']);
  });

  test('findPaneByTabId returns null for tab not in any pane', () => {
    const tree = split('horizontal', [pane(['f1']), pane(['f2'])]);
    expect(findPaneByTabId(tree, 'nonexistent')).toBeNull();
  });

  test('multiple rapid splits and collapses produce valid tree', () => {
    let tree: TreeNode = pane(['f1', 'f2', 'f3'], 'f1', 'main');

    // Split 3 times
    for (let i = 0; i < 3; i++) {
      const result = splitPane(tree, getFirstPane(tree).id, 'horizontal', 'after');
      tree = result.tree;
    }
    expect(getAllPanes(tree)).toHaveLength(4);

    // Collapse by removing tabs
    const panes = getAllPanes(tree);
    for (const p of panes) {
      if (p.tabIds.length === 0) {
        tree = collapseSplit(tree, p.id);
      }
    }

    // Should still be valid
    const remaining = getAllPanes(tree);
    expect(remaining.length).toBeGreaterThanOrEqual(1);
    expect(remaining.some(p => p.tabIds.includes('f1'))).toBe(true);
  });
});

// ============================================================================
// Test: Full LayoutState Simulation
// ============================================================================

describe('Full LayoutState simulation', () => {
  test('complete workflow: open files, split, drag, resize, close', () => {
    // Create initial state
    const tabs: Record<string, Tab> = {};
    function addTab(id: string, type: Tab['type'] = 'file'): Tab {
      const t = makeTab(id, type, { path: type === 'file' ? `/${id}.ts` : undefined });
      tabs[t.id] = t;
      return t;
    }

    const t1 = addTab('file-1');
    const t2 = addTab('file-2');
    const t3 = addTab('file-3');
    const agent = addTab('agent-tab', 'terminal');
    const term = addTab('term-tab', 'terminal');

    let tree: TreeNode = pane([t1.id, t2.id, t3.id], t1.id, 'initial');
    let sidebarPane: Pane | null = pane([agent.id, term.id], agent.id, 'sidebar');
    let activePaneId = 'initial';

    // Step 1: Split file-2 to right
    let result = simulateTabDrop(tree, tabs, t2.id, 'initial', 'initial', 'right');
    tree = result.tree;
    expect(getAllPanes(tree)).toHaveLength(2);

    // Step 2: Resize the split
    if (isSplitNode(tree)) {
      tree = updateSplitRatio(tree, tree.id, 0.6);
      expect((tree as SplitNode).ratio).toBe(0.6);
    }

    // Step 3: Move agent from sidebar to center (bottom of right pane)
    const rightPane = findPaneByTabId(tree, t2.id)!;
    sidebarPane = { ...sidebarPane!, tabIds: [term.id], activeTabId: term.id };
    tree = addTabToPane(tree, rightPane.id, agent.id);
    // Now drag agent to bottom edge of right pane to create a vertical split
    const rightPaneId = rightPane.id;
    result = simulateTabDrop(tree, tabs, agent.id, rightPaneId, rightPaneId, 'bottom');
    tree = result.tree;
    expect(getAllPanes(tree)).toHaveLength(3);

    // Step 4: Close file-3 from left pane
    const f3Pane = findPaneByTabId(tree, t3.id)!;
    tree = removeTabFromPane(tree, f3Pane.id, t3.id);
    delete tabs[t3.id];

    // Step 5: Verify final state
    const finalPanes = getAllPanes(tree);
    // f1 in one pane, f2 in another, agent in another
    expect(finalPanes.some(p => p.tabIds.includes(t1.id))).toBe(true);
    expect(finalPanes.some(p => p.tabIds.includes(t2.id))).toBe(true);
    expect(finalPanes.some(p => p.tabIds.includes(agent.id))).toBe(true);

    // Sidebar still has terminal
    expect(sidebarPane!.tabIds).toEqual([term.id]);

    // Tab data preserved
    expect(tabs[agent.id].type).toBe('terminal');
    expect(tabs[term.id].type).toBe('terminal');
  });
});
