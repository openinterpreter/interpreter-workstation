import { test, expect } from './fixtures';
import { waitForAppReady } from './helpers';
import { sel } from './selectors';

test('layout smoke: can split a pane and move a tab into the new pane', async ({ page }) => {
  await waitForAppReady(page);

  const layout = await page.evaluate(async () => {
    const ctx = (window as any).__layoutContext;
    await ctx.openFile('/tmp/smoke-a.txt');
    await ctx.openFile('/tmp/smoke-b.txt');

    const before = ctx.getState();
    const sourcePaneId = before.activePaneId;
    const splitTab = (Object.values(before.tabs) as any[]).find((tab) => tab.type === 'file' && tab.label === 'smoke-b.txt');
    if (!sourcePaneId || !splitTab) {
      throw new Error('Missing source pane or split tab');
    }

    const targetPaneId = ctx.splitPaneAction(sourcePaneId, 'horizontal', 'after', splitTab.id);
    if (!targetPaneId) {
      throw new Error('Split did not create a target pane');
    }

    await ctx.openFile('/tmp/smoke-c.txt', sourcePaneId);

    const afterOpen = ctx.getState();
    const movedTab = (Object.values(afterOpen.tabs) as any[]).find((tab) => tab.type === 'file' && tab.label === 'smoke-c.txt');
    if (!movedTab) {
      throw new Error('Missing tab to move after opening it');
    }

    ctx.moveTab(movedTab.id, targetPaneId, 1);

    const afterMove = ctx.getState();
    const panes = (function getAllPanes(node: any): any[] {
      return node.kind === 'pane'
        ? [node]
        : [...getAllPanes(node.children[0]), ...getAllPanes(node.children[1])];
    })(afterMove.tree);

    return {
      paneCount: panes.length,
      treeKind: afterMove.tree.kind,
      panes: panes.map((pane: any) => ({
        id: pane.id,
        tabIds: pane.tabIds,
        activeTabId: pane.activeTabId,
      })),
      tabs: Object.fromEntries(Object.entries(afterMove.tabs).map(([id, tab]: [string, any]) => [id, tab.label])),
    };
  });

  expect(layout.treeKind).toBe('split');
  expect(layout.paneCount).toBe(2);
  await expect(page.locator(sel.paneContentAny())).toHaveCount(2);

  const paneWithMovedTab = layout.panes.find((pane: { tabIds: string[] }) =>
    pane.tabIds.some((tabId) => layout.tabs[tabId] === 'smoke-c.txt'),
  );

  expect(paneWithMovedTab).toBeTruthy();
  expect(paneWithMovedTab?.tabIds.map((tabId: string) => layout.tabs[tabId])).toContain('smoke-b.txt');
});
