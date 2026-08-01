import { describe, expect, test } from 'vitest';
import { createPane, createSplitNode, getAllPanes, findPaneById, splitPane, addTabToPane } from './treeOperations';
import type { Tab, TreeNode } from '../../shared/types/layout';

function makeTab(overrides: Partial<Tab> & { id: string; type: Tab['type'] }): Tab {
  return { label: 'test', ...overrides };
}

function resolveTargetPaneForChat(
  tree: TreeNode,
  tabs: Record<string, Tab>,
  activePaneId: string,
): { tree: TreeNode; targetPaneId: string } {
  const targetPane = findPaneById(tree, activePaneId);
  if (targetPane && targetPane.activeTabId && tabs[targetPane.activeTabId]?.type === 'settings') {
    const alt = getAllPanes(tree).find(p => p.id !== activePaneId);
    if (alt) {
      return { tree, targetPaneId: alt.id };
    }
    const result = splitPane(tree, activePaneId, 'horizontal', 'after');
    if (result.newPaneId) {
      return { tree: result.tree, targetPaneId: result.newPaneId };
    }
  }
  return { tree, targetPaneId: activePaneId };
}

describe('chat pane placement (#574)', () => {
  test('should not place chat tab in pane with active settings tab', () => {
    const settingsTab = makeTab({ id: 'settings-1', type: 'settings' });
    const pane = createPane([settingsTab.id], settingsTab.id);
    const tabs: Record<string, Tab> = { [settingsTab.id]: settingsTab };

    const result = resolveTargetPaneForChat(pane, tabs, pane.id);
    expect(result.targetPaneId).not.toBe(pane.id);
  });

  test('should use existing non-settings pane when available', () => {
    const settingsTab = makeTab({ id: 'settings-1', type: 'settings' });
    const agentTab = makeTab({ id: 'agent-1', type: 'agent', label: 'Agent' });
    const settingsPane = createPane([settingsTab.id], settingsTab.id);
    const agentPane = createPane([agentTab.id], agentTab.id);
    const tree = createSplitNode('horizontal', [settingsPane, agentPane]);
    const tabs: Record<string, Tab> = {
      [settingsTab.id]: settingsTab,
      [agentTab.id]: agentTab,
    };

    const result = resolveTargetPaneForChat(tree, tabs, settingsPane.id);
    expect(result.targetPaneId).toBe(agentPane.id);
  });

  test('should split pane when settings pane is the only pane', () => {
    const settingsTab = makeTab({ id: 'settings-1', type: 'settings' });
    const pane = createPane([settingsTab.id], settingsTab.id);
    const tabs: Record<string, Tab> = { [settingsTab.id]: settingsTab };

    const result = resolveTargetPaneForChat(pane, tabs, pane.id);
    expect(result.targetPaneId).not.toBe(pane.id);
    expect(result.targetPaneId).toBeTruthy();
    const allPanes = getAllPanes(result.tree);
    expect(allPanes.length).toBe(2);
  });

  test('should use active pane directly when no settings tab is active', () => {
    const agentTab = makeTab({ id: 'agent-1', type: 'agent', label: 'Agent' });
    const pane = createPane([agentTab.id], agentTab.id);
    const tabs: Record<string, Tab> = { [agentTab.id]: agentTab };

    const result = resolveTargetPaneForChat(pane, tabs, pane.id);
    expect(result.targetPaneId).toBe(pane.id);
  });

  test('should use active pane when settings tab exists but is not active', () => {
    const settingsTab = makeTab({ id: 'settings-1', type: 'settings' });
    const fileTab = makeTab({ id: 'file-1', type: 'file', label: 'readme.md' });
    const pane = createPane([settingsTab.id, fileTab.id], fileTab.id);
    const tabs: Record<string, Tab> = {
      [settingsTab.id]: settingsTab,
      [fileTab.id]: fileTab,
    };

    const result = resolveTargetPaneForChat(pane, tabs, pane.id);
    expect(result.targetPaneId).toBe(pane.id);
  });

  test('new pane from split should accept a chat tab via addTabToPane', () => {
    const settingsTab = makeTab({ id: 'settings-1', type: 'settings' });
    const pane = createPane([settingsTab.id], settingsTab.id);
    const tabs: Record<string, Tab> = { [settingsTab.id]: settingsTab };

    const { tree, targetPaneId } = resolveTargetPaneForChat(pane, tabs, pane.id);
    const newTree = addTabToPane(tree, targetPaneId, 'chat-1');
    const targetPane = findPaneById(newTree, targetPaneId);
    expect(targetPane).not.toBeNull();
    expect(targetPane!.tabIds).toContain('chat-1');
  });

  test('should pick first non-settings pane when multiple alternatives exist', () => {
    const settingsTab = makeTab({ id: 'settings-1', type: 'settings' });
    const chatTab = makeTab({ id: 'chat-1', type: 'chat', label: 'Chat' });
    const agentTab = makeTab({ id: 'agent-1', type: 'agent', label: 'Agent' });
    const settingsPane = createPane([settingsTab.id], settingsTab.id);
    const chatPane = createPane([chatTab.id], chatTab.id);
    const agentPane = createPane([agentTab.id], agentTab.id);
    const rightSplit = createSplitNode('horizontal', [chatPane, agentPane]);
    const tree = createSplitNode('horizontal', [settingsPane, rightSplit]);
    const tabs: Record<string, Tab> = {
      [settingsTab.id]: settingsTab,
      [chatTab.id]: chatTab,
      [agentTab.id]: agentTab,
    };

    const result = resolveTargetPaneForChat(tree, tabs, settingsPane.id);
    expect(result.targetPaneId).not.toBe(settingsPane.id);
    expect([chatPane.id, agentPane.id]).toContain(result.targetPaneId);
  });

  test('should not avoid pane when activeTabId is missing from tabs record', () => {
    const pane = createPane(['ghost-tab'], 'ghost-tab');
    const tabs: Record<string, Tab> = {};

    const result = resolveTargetPaneForChat(pane, tabs, pane.id);
    expect(result.targetPaneId).toBe(pane.id);
  });

  test('should not avoid pane when activeTabId is null', () => {
    const settingsTab = makeTab({ id: 'settings-1', type: 'settings' });
    const pane = createPane([settingsTab.id], null);
    const tabs: Record<string, Tab> = { [settingsTab.id]: settingsTab };

    const result = resolveTargetPaneForChat(pane, tabs, pane.id);
    expect(result.targetPaneId).toBe(pane.id);
  });

  test('settings pane should retain its tabs after split reroute', () => {
    const settingsTab = makeTab({ id: 'settings-1', type: 'settings' });
    const pane = createPane([settingsTab.id], settingsTab.id);
    const tabs: Record<string, Tab> = { [settingsTab.id]: settingsTab };

    const { tree, targetPaneId } = resolveTargetPaneForChat(pane, tabs, pane.id);
    const originalPane = getAllPanes(tree).find(p => p.id !== targetPaneId);
    expect(originalPane).toBeDefined();
    expect(originalPane!.tabIds).toContain(settingsTab.id);
  });
});
