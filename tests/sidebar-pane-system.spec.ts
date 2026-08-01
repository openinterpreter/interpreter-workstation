import type { Page } from '@playwright/test';

import { test, expect } from './fixtures';
import { setupPageLogging, waitForAppReady } from './helpers';
import { sel } from './selectors';

interface LayoutSnapshot {
  activePaneId: string | null;
  panes: Array<{ id: string; tabIds: string[]; activeTabId: string | null }>;
  sidebarTabIds: string[];
  sidebarActiveTabId: string | null;
}

function paneTabSelector(paneId: string, tabId: string): string {
  return `[data-testid="pane-tab-${paneId}-${tabId}"]`;
}

async function getLayoutSnapshot(page: Page): Promise<LayoutSnapshot> {
  return page.evaluate(() => {
    const ctx = (window as typeof window & {
      __layoutContext?: {
        getState: () => {
          activePaneId: string | null;
          tree: any;
          sidebarPane?: { tabIds?: string[]; activeTabId?: string | null } | null;
        };
      };
    }).__layoutContext;

    if (!ctx) {
      throw new Error('__layoutContext is not available');
    }

    const state = ctx.getState();
    const panes: Array<{ id: string; tabIds: string[]; activeTabId: string | null }> = [];

    const visit = (node: any) => {
      if (!node) return;
      if (node.kind === 'pane') {
        panes.push({
          id: node.id,
          tabIds: [...(node.tabIds ?? [])],
          activeTabId: node.activeTabId ?? null,
        });
        return;
      }

      for (const child of node.children ?? []) {
        visit(child);
      }
    };

    visit(state.tree);

    return {
      activePaneId: state.activePaneId,
      panes,
      sidebarTabIds: [...(state.sidebarPane?.tabIds ?? [])],
      sidebarActiveTabId: state.sidebarPane?.activeTabId ?? null,
    };
  });
}

async function getSidebarDomOrder(page: Page): Promise<string[]> {
  return page.locator(`${sel('agentSidebar')} [data-testid^="agent-tab-"]`).evaluateAll((elements) =>
    elements
      .map((element) => element.getAttribute('data-testid') ?? '')
      .filter(Boolean)
      .map((testId) => testId.replace('agent-tab-', '')),
  );
}

async function expectNoSidebarDropIndicators(page: Page): Promise<void> {
  await expect(page.locator(sel.sidebarTabDropIndicatorAny())).toHaveCount(0);
}

async function openRightSidebar(page: Page): Promise<void> {
  await page.evaluate(() => {
    const ctx = (window as typeof window & {
      __layoutContext?: {
        setRightSidebarOpen: (isOpen: boolean) => void;
      };
    }).__layoutContext;

    if (!ctx) {
      throw new Error('__layoutContext is not available');
    }

    ctx.setRightSidebarOpen(true);
  });

  await expect(page.locator(sel('agentSidebar'))).toBeVisible({ timeout: 10000 });
}

async function createEditorAgent(page: Page): Promise<{ tabId: string; paneId: string }> {
  const result = await page.evaluate(() => {
    const ctx = (window as typeof window & {
      __layoutContext?: {
        openNewTab: () => string;
        getState: () => {
          tree: any;
        };
      };
    }).__layoutContext;

    if (!ctx) {
      throw new Error('__layoutContext is not available');
    }

    const tabId = ctx.openNewTab();
    const state = ctx.getState();

    const findPaneId = (node: any): string | null => {
      if (!node) return null;
      if (node.kind === 'pane') {
        return (node.tabIds ?? []).includes(tabId) ? node.id : null;
      }

      for (const child of node.children ?? []) {
        const match = findPaneId(child);
        if (match) {
          return match;
        }
      }

      return null;
    };

    const paneId = findPaneId(state.tree);
    if (!paneId) {
      throw new Error(`Could not find pane for new agent tab ${tabId}`);
    }

    return { tabId, paneId };
  });

  await expect(page.locator(paneTabSelector(result.paneId, result.tabId))).toBeVisible({ timeout: 10000 });
  return result;
}

async function dragPaneTabToSidebar(page: Page, tabId: string, sourcePaneId: string): Promise<void> {
  await page.evaluate(({ sourcePaneId, tabId, sidebarSelector }) => {
    const sourceEl = document.querySelector(paneTabSelector(sourcePaneId, tabId));
    const targetEl = document.querySelector(sidebarSelector);
    if (!sourceEl || !targetEl) {
      throw new Error(`Elements not found for pane -> sidebar drag: tab=${!!sourceEl} sidebar=${!!targetEl}`);
    }

    const sourceRect = sourceEl.getBoundingClientRect();
    const targetRect = targetEl.getBoundingClientRect();
    const dropX = targetRect.left + targetRect.width / 2;
    const dropY = targetRect.top + Math.min(80, targetRect.height / 3);

    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', tabId);
    dataTransfer.setData('application/json', JSON.stringify({
      type: 'pane-tab',
      tabId,
      sourcePaneId,
    }));

    sourceEl.dispatchEvent(new DragEvent('dragstart', {
      bubbles: true,
      cancelable: true,
      clientX: sourceRect.left + sourceRect.width / 2,
      clientY: sourceRect.top + sourceRect.height / 2,
      dataTransfer,
    }));
    targetEl.dispatchEvent(new DragEvent('dragenter', {
      bubbles: true,
      cancelable: true,
      clientX: dropX,
      clientY: dropY,
      dataTransfer,
    }));
    targetEl.dispatchEvent(new DragEvent('dragover', {
      bubbles: true,
      cancelable: true,
      clientX: dropX,
      clientY: dropY,
      dataTransfer,
    }));
    targetEl.dispatchEvent(new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      clientX: dropX,
      clientY: dropY,
      dataTransfer,
    }));
    sourceEl.dispatchEvent(new DragEvent('dragend', {
      bubbles: true,
      cancelable: true,
      clientX: dropX,
      clientY: dropY,
      dataTransfer,
    }));

    function paneTabSelector(paneId: string, draggedTabId: string): string {
      return `[data-testid="pane-tab-${paneId}-${draggedTabId}"]`;
    }
  }, {
    sourcePaneId,
    tabId,
    sidebarSelector: sel('agentSidebar'),
  });
}

async function dragPaneTabToSidebarWithPointer(page: Page, tabId: string, sourcePaneId: string): Promise<void> {
  const sourceTab = page.locator(paneTabSelector(sourcePaneId, tabId));
  const sidebar = page.locator(sel('agentSidebar'));

  await expect(sourceTab).toBeVisible({ timeout: 10000 });
  await expect(sidebar).toBeVisible({ timeout: 10000 });

  const sourceBox = await sourceTab.boundingBox();
  const sidebarBox = await sidebar.boundingBox();
  if (!sourceBox || !sidebarBox) {
    throw new Error('Could not get bounding boxes for editor -> sidebar pointer drag');
  }

  const startX = sourceBox.x + sourceBox.width / 2;
  const startY = sourceBox.y + sourceBox.height / 2;
  const endX = sidebarBox.x + sidebarBox.width / 2;
  const endY = sidebarBox.y + sidebarBox.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 20, startY + 5, { steps: 4 });
  await page.mouse.move(endX, endY, { steps: 20 });
  await page.mouse.up();
  await page.waitForTimeout(250);
}

async function dragSidebarTabToSidebar(page: Page, tabId: string, targetTabId: string, position: 'before' | 'after'): Promise<void> {
  await page.evaluate(({ tabId, targetTabId, position }) => {
    const sourceEl = document.querySelector(`[data-testid="agent-tab-${tabId}"]`);
    const targetEl = document.querySelector(`[data-testid="agent-tab-${targetTabId}"]`);
    if (!sourceEl || !targetEl) {
      throw new Error(`Elements not found for sidebar reorder: source=${!!sourceEl} target=${!!targetEl}`);
    }

    const sourceRect = sourceEl.getBoundingClientRect();
    const targetRect = targetEl.getBoundingClientRect();
    const dropY = position === 'before'
      ? targetRect.top + Math.min(4, targetRect.height / 4)
      : targetRect.bottom - Math.min(4, targetRect.height / 4);
    const dropX = targetRect.left + targetRect.width / 2;

    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', tabId);
    dataTransfer.setData('application/json', JSON.stringify({
      type: 'pane-tab',
      tabId,
      sourcePaneId: 'sidebar',
    }));

    sourceEl.dispatchEvent(new DragEvent('dragstart', {
      bubbles: true,
      cancelable: true,
      clientX: sourceRect.left + sourceRect.width / 2,
      clientY: sourceRect.top + sourceRect.height / 2,
      dataTransfer,
    }));
    targetEl.dispatchEvent(new DragEvent('dragenter', {
      bubbles: true,
      cancelable: true,
      clientX: dropX,
      clientY: dropY,
      dataTransfer,
    }));
    targetEl.dispatchEvent(new DragEvent('dragover', {
      bubbles: true,
      cancelable: true,
      clientX: dropX,
      clientY: dropY,
      dataTransfer,
    }));
    targetEl.dispatchEvent(new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      clientX: dropX,
      clientY: dropY,
      dataTransfer,
    }));
    sourceEl.dispatchEvent(new DragEvent('dragend', {
      bubbles: true,
      cancelable: true,
      clientX: dropX,
      clientY: dropY,
      dataTransfer,
    }));
  }, { tabId, targetTabId, position });
}

async function dragSidebarTabToTabBar(
  page: Page,
  tabId: string,
  targetPaneId: string,
): Promise<void> {
  await page.evaluate(({ tabId, targetPaneId }) => {
    const sourceEl = document.querySelector(`[data-testid="agent-tab-${tabId}"]`);
    const targetEl = document.querySelector(`[data-testid="pane-tab-bar-${targetPaneId}"]`);
    if (!sourceEl || !targetEl) {
      throw new Error(`Elements not found for sidebar -> tab bar drag: source=${!!sourceEl} target=${!!targetEl}`);
    }

    const sourceRect = sourceEl.getBoundingClientRect();
    const targetRect = targetEl.getBoundingClientRect();
    const dropX = targetRect.left + targetRect.width / 2;
    const dropY = targetRect.top + targetRect.height / 2;

    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', tabId);
    dataTransfer.setData('application/json', JSON.stringify({
      type: 'pane-tab',
      tabId,
      sourcePaneId: 'sidebar',
      sidebarMeta: {
        tabType: 'agent',
        label: 'New Agent',
        agentTabId: tabId,
      },
    }));

    sourceEl.dispatchEvent(new DragEvent('dragstart', {
      bubbles: true,
      cancelable: true,
      clientX: sourceRect.left + sourceRect.width / 2,
      clientY: sourceRect.top + sourceRect.height / 2,
      dataTransfer,
    }));
    targetEl.dispatchEvent(new DragEvent('dragenter', {
      bubbles: true,
      cancelable: true,
      clientX: dropX,
      clientY: dropY,
      dataTransfer,
    }));
    targetEl.dispatchEvent(new DragEvent('dragover', {
      bubbles: true,
      cancelable: true,
      clientX: dropX,
      clientY: dropY,
      dataTransfer,
    }));
    targetEl.dispatchEvent(new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      clientX: dropX,
      clientY: dropY,
      dataTransfer,
    }));
    sourceEl.dispatchEvent(new DragEvent('dragend', {
      bubbles: true,
      cancelable: true,
      clientX: dropX,
      clientY: dropY,
      dataTransfer,
    }));
  }, { tabId, targetPaneId });
}

async function expectSidebarOrder(page: Page, expectedTabIds: string[]): Promise<void> {
  await expect.poll(async () => {
    const snapshot = await getLayoutSnapshot(page);
    return snapshot.sidebarTabIds;
  }).toEqual(expectedTabIds);

  await expect.poll(async () => getSidebarDomOrder(page)).toEqual(expectedTabIds);
}

async function clickSidebarNewAgentButton(page: Page): Promise<string> {
  const before = await getLayoutSnapshot(page);
  await page.locator(sel('newAgentButton')).click();

  let createdTabId: string | null = null;
  await expect.poll(async () => {
    const after = await getLayoutSnapshot(page);
    createdTabId = after.sidebarTabIds.find((tabId) => !before.sidebarTabIds.includes(tabId)) ?? null;
    return createdTabId;
  }).not.toBeNull();

  if (!createdTabId) {
    throw new Error('Sidebar new agent button did not create a pinned agent');
  }

  return createdTabId;
}

test.describe('Right Sidebar Agent Tabs', () => {
  test.beforeEach(async ({ page }) => {
    setupPageLogging(page, 'SidebarPaneSystem');
    await waitForAppReady(page);
    await openRightSidebar(page);
  });

  test('dragging editor agent tabs into the sidebar pins multiple tabs and reveals the new agent button', async ({ page }) => {
    test.setTimeout(60000);

    await expect(page.locator(sel('newAgentButton'))).toHaveCount(0);

    const agentOne = await createEditorAgent(page);
    const agentTwo = await createEditorAgent(page);

    await dragPaneTabToSidebar(page, agentOne.tabId, agentOne.paneId);
    await expectSidebarOrder(page, [agentOne.tabId]);
    await expect(page.locator(sel('newAgentButton'))).toBeVisible({ timeout: 5000 });
    await expectNoSidebarDropIndicators(page);

    await dragPaneTabToSidebar(page, agentTwo.tabId, agentTwo.paneId);
    await expectSidebarOrder(page, [agentOne.tabId, agentTwo.tabId]);
    await expectNoSidebarDropIndicators(page);

    await expect(page.locator(sel.agentTab(agentOne.tabId))).toBeVisible();
    await expect(page.locator(sel.agentTab(agentTwo.tabId))).toBeVisible();
  });

  test('a populated sidebar still accepts real pointer drags from editor agent tabs', async ({ page }) => {
    test.setTimeout(60000);

    const agentOne = await createEditorAgent(page);
    const agentTwo = await createEditorAgent(page);

    await dragPaneTabToSidebar(page, agentOne.tabId, agentOne.paneId);
    await expectSidebarOrder(page, [agentOne.tabId]);
    await expect(page.locator(sel('newAgentButton'))).toBeVisible({ timeout: 5000 });

    await dragPaneTabToSidebarWithPointer(page, agentTwo.tabId, agentTwo.paneId);
    await expectSidebarOrder(page, [agentOne.tabId, agentTwo.tabId]);
    await expect(page.locator(sel.agentTab(agentTwo.tabId))).toBeVisible();
    await expect(page.locator(paneTabSelector(agentTwo.paneId, agentTwo.tabId))).toHaveCount(0);
    await expectNoSidebarDropIndicators(page);
  });

  test('sidebar tabs can be reordered, a new pinned agent can be created, and all pinned agents can be closed', async ({ page }) => {
    test.setTimeout(60000);

    const agentOne = await createEditorAgent(page);
    const agentTwo = await createEditorAgent(page);

    await dragPaneTabToSidebar(page, agentOne.tabId, agentOne.paneId);
    await dragPaneTabToSidebar(page, agentTwo.tabId, agentTwo.paneId);
    await expectSidebarOrder(page, [agentOne.tabId, agentTwo.tabId]);
    await expectNoSidebarDropIndicators(page);

    await dragSidebarTabToSidebar(page, agentTwo.tabId, agentOne.tabId, 'before');
    await expectSidebarOrder(page, [agentTwo.tabId, agentOne.tabId]);
    await expectNoSidebarDropIndicators(page);

    const createdAgentId = await clickSidebarNewAgentButton(page);
    await expectSidebarOrder(page, [agentTwo.tabId, agentOne.tabId, createdAgentId]);

    for (const tabId of [createdAgentId, agentTwo.tabId, agentOne.tabId]) {
      await page.locator(sel.agentTab(tabId)).locator(sel.closeAgent(tabId)).click({ force: true });
    }

    await expect.poll(async () => {
      const snapshot = await getLayoutSnapshot(page);
      return snapshot.sidebarTabIds;
    }).toEqual([]);

    await expect(page.locator(sel('newAgentButton'))).toHaveCount(0);
    await expect(page.locator(sel('agentSidebar'))).toContainText('Drop agent tabs here');
  });

  test('dragging pinned sidebar agents back to the main tab area restores editor tabs and removes them from the sidebar', async ({ page }) => {
    test.setTimeout(60000);

    const agentOne = await createEditorAgent(page);
    const agentTwo = await createEditorAgent(page);

    await dragPaneTabToSidebar(page, agentOne.tabId, agentOne.paneId);
    await dragPaneTabToSidebar(page, agentTwo.tabId, agentTwo.paneId);
    await expectSidebarOrder(page, [agentOne.tabId, agentTwo.tabId]);
    await expectNoSidebarDropIndicators(page);

    const targetPaneId = (await getLayoutSnapshot(page)).panes[0]?.id;
    if (!targetPaneId) {
      throw new Error('Could not find a target pane for sidebar -> editor drag');
    }

    await dragSidebarTabToTabBar(page, agentOne.tabId, targetPaneId);
    await expectSidebarOrder(page, [agentTwo.tabId]);
    await expect.poll(async () => {
      const snapshot = await getLayoutSnapshot(page);
      return snapshot.panes.find((pane) => pane.id === targetPaneId)?.tabIds ?? [];
    }).toContain(agentOne.tabId);
    await expect(page.locator(paneTabSelector(targetPaneId, agentOne.tabId))).toBeVisible({ timeout: 5000 });

    await dragSidebarTabToTabBar(page, agentTwo.tabId, targetPaneId);
    await expect.poll(async () => {
      const snapshot = await getLayoutSnapshot(page);
      return snapshot.sidebarTabIds;
    }).toEqual([]);

    await expect.poll(async () => {
      const snapshot = await getLayoutSnapshot(page);
      return snapshot.panes.find((pane) => pane.id === targetPaneId)?.tabIds ?? [];
    }).toContain(agentTwo.tabId);
    await expect(page.locator(paneTabSelector(targetPaneId, agentTwo.tabId))).toBeVisible({ timeout: 5000 });
    await expect(page.locator(sel('agentSidebar'))).toContainText('Drop agent tabs here');
  });
});
