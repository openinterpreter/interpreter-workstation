import { describe, expect, test } from 'bun:test';
import type { Pane, TreeNode } from '../../shared/types/layout';
import { moveTabToPane, splitPane, updateSplitRatio } from './treeOperations';

describe('treeOperations', () => {
  test('splitPane moves the requested tab into the new pane', () => {
    const tree: TreeNode = {
      kind: 'pane',
      id: 'pane-1',
      tabIds: ['tab-a', 'tab-b'],
      activeTabId: 'tab-b',
    };

    const result = splitPane(tree, 'pane-1', 'horizontal', 'after', 'tab-b');

    expect(result.newPaneId).toBeTruthy();
    expect(result.tree.kind).toBe('split');
    if (result.tree.kind !== 'split') return;

    const [left, right] = result.tree.children as [Pane, Pane];
    expect(left.tabIds).toEqual(['tab-a']);
    expect(left.activeTabId).toBe('tab-a');
    expect(right.tabIds).toEqual(['tab-b']);
    expect(right.activeTabId).toBe('tab-b');
  });

  test('moveTabToPane collapses an empty source pane after moving its last tab', () => {
    const tree: TreeNode = {
      kind: 'split',
      id: 'split-1',
      direction: 'horizontal',
      ratio: 0.5,
      children: [
        { kind: 'pane', id: 'left', tabIds: ['tab-a'], activeTabId: 'tab-a' },
        { kind: 'pane', id: 'right', tabIds: ['tab-b'], activeTabId: 'tab-b' },
      ],
    };

    const nextTree = moveTabToPane(tree, 'tab-a', 'left', 'right', 1);

    expect(nextTree.kind).toBe('pane');
    if (nextTree.kind !== 'pane') return;

    expect(nextTree.id).toBe('right');
    expect(nextTree.tabIds).toEqual(['tab-b', 'tab-a']);
    expect(nextTree.activeTabId).toBe('tab-a');
  });

  test('updateSplitRatio clamps ratios to the supported range', () => {
    const tree: TreeNode = {
      kind: 'split',
      id: 'split-1',
      direction: 'vertical',
      ratio: 0.5,
      children: [
        { kind: 'pane', id: 'top', tabIds: ['tab-a'], activeTabId: 'tab-a' },
        { kind: 'pane', id: 'bottom', tabIds: ['tab-b'], activeTabId: 'tab-b' },
      ],
    };

    const clampedHigh = updateSplitRatio(tree, 'split-1', 2);
    const clampedLow = updateSplitRatio(tree, 'split-1', -1);

    expect(clampedHigh.kind === 'split' ? clampedHigh.ratio : null).toBe(0.9);
    expect(clampedLow.kind === 'split' ? clampedLow.ratio : null).toBe(0.1);
  });
});
