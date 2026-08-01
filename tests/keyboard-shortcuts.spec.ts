import type { ElectronApplication, Page } from '@playwright/test';

import { test, expect } from './fixtures';
import { setupPageLogging, waitForAppReady } from './helpers';
import { sel } from './selectors';

const MODIFIER = process.platform === 'darwin' ? 'Meta' : 'Control';

interface LayoutSnapshot {
  activePaneId: string | null;
  activeTabRegion: 'main' | 'sidebar';
  panes: Array<{ id: string; tabIds: string[]; activeTabId: string | null }>;
  sidebarTabIds: string[];
  sidebarActiveTabId: string | null;
  rightSidebarOpen: boolean;
}

async function getLayoutSnapshot(page: Page): Promise<LayoutSnapshot> {
  return page.evaluate(() => {
    const ctx = (window as typeof window & {
      __layoutContext?: {
        getState: () => {
          activePaneId: string | null;
          activeTabRegion: 'main' | 'sidebar';
          tree: any;
          sidebarPane?: { tabIds?: string[] | null; activeTabId?: string | null } | null;
          rightSidebar: { isOpen: boolean };
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
      activeTabRegion: state.activeTabRegion,
      panes,
      sidebarTabIds: [...(state.sidebarPane?.tabIds ?? [])],
      sidebarActiveTabId: state.sidebarPane?.activeTabId ?? null,
      rightSidebarOpen: state.rightSidebar.isOpen,
    };
  });
}

function getOrderedTabIds(snapshot: LayoutSnapshot): string[] {
  return [
    ...snapshot.panes.flatMap((pane) => pane.tabIds),
    ...snapshot.sidebarTabIds,
  ];
}

function getMainActiveTabId(snapshot: LayoutSnapshot): string | null {
  return snapshot.panes.find((pane) => pane.id === snapshot.activePaneId)?.activeTabId ?? null;
}

async function clickPaneTab(page: Page, paneId: string, tabId: string): Promise<void> {
  await page.locator(`[data-testid="pane-tab-${paneId}-${tabId}"]`).click();
}

async function clickSidebarTab(page: Page, tabId: string): Promise<void> {
  await page.locator(sel.agentTab(tabId)).click();
}

async function setCommandOverlayVisible(page: Page, visible: boolean): Promise<void> {
  await page.evaluate((nextVisible) => {
    window.dispatchEvent(new KeyboardEvent(nextVisible ? 'keydown' : 'keyup', {
      key: 'Meta',
      metaKey: nextVisible,
      bubbles: true,
      cancelable: true,
    }));
  }, visible);

  await page.waitForTimeout(120);
}

async function blurActiveElement(page: Page): Promise<void> {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
  });
  await page.waitForTimeout(100);
}

async function getWindowId(page: Page): Promise<number | null> {
  try {
    return await page.evaluate(() => {
      return (window as any).electron?.getWindowId?.() ?? null;
    });
  } catch {
    return null;
  }
}

async function triggerMenuShortcut(
  electronApp: ElectronApplication,
  page: Page,
  accelerator: string,
): Promise<void> {
  await blurActiveElement(page);

  const windowId = await getWindowId(page);
  if (windowId == null) {
    throw new Error('Failed to resolve the current renderer window id');
  }

  await electronApp.evaluate(({ BrowserWindow, Menu }, payload: { accelerator: string; windowId: number }) => {
    const targetWindow = BrowserWindow.fromId(payload.windowId);
    if (!targetWindow) {
      throw new Error(`Window ${payload.windowId} is no longer available`);
    }

    targetWindow.focus();

    const menu = Menu.getApplicationMenu();
    if (!menu) {
      throw new Error('Application menu is not available');
    }

    const stack = [...menu.items];
    while (stack.length > 0) {
      const item = stack.shift();
      if (!item) continue;

      if (item.accelerator === payload.accelerator) {
        if (!item.click) {
          throw new Error(`Menu item ${payload.accelerator} has no click handler`);
        }
        const originalGetFocusedWindow = BrowserWindow.getFocusedWindow;
        Object.assign(BrowserWindow, {
          getFocusedWindow: () => targetWindow,
        });
        try {
          item.click(item, targetWindow, {} as never);
        } finally {
          Object.assign(BrowserWindow, {
            getFocusedWindow: originalGetFocusedWindow,
          });
        }
        return;
      }

      if (item.submenu) {
        stack.push(...item.submenu.items);
      }
    }

    throw new Error(`Menu item ${payload.accelerator} not found`);
  }, { accelerator, windowId });
}

async function isRendererWindow(page: Page): Promise<boolean> {
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 1000 });
    return await page.evaluate(() => {
      return Boolean(
        document.getElementById('root')
        && (window as any).electron?.getWindowSessionKey,
      );
    });
  } catch {
    return false;
  }
}

async function getRendererWindows(electronApp: ElectronApplication): Promise<Page[]> {
  const pages = electronApp.windows();
  const rendererPages: Page[] = [];
  for (const candidate of pages) {
    if (await isRendererWindow(candidate)) {
      rendererPages.push(candidate);
    }
  }
  return rendererPages;
}

async function getWindowSessionKey(page: Page): Promise<string | null> {
  try {
    return await page.evaluate(() => {
      return (window as any).electron?.getWindowSessionKey?.() ?? null;
    });
  } catch {
    return null;
  }
}

async function waitForRendererWindowCount(
  electronApp: ElectronApplication,
  count: number,
): Promise<Page[]> {
  await expect.poll(async () => {
    return (await getRendererWindows(electronApp)).length;
  }, { timeout: 30000 }).toBe(count);

  return await getRendererWindows(electronApp);
}

test.describe('Keyboard Shortcuts', () => {
  test.beforeEach(async ({ page }) => {
    setupPageLogging(page, 'KeyboardShortcuts');
    await waitForAppReady(page);
  });

  test(`${MODIFIER}+T creates a new main-area agent`, async ({ page, electronApp }) => {
    const before = await getLayoutSnapshot(page);
    const beforeTabIds = new Set(before.panes.flatMap((pane) => pane.tabIds));

    await triggerMenuShortcut(electronApp, page, 'CmdOrCtrl+T');

    await expect.poll(async () => {
      const snapshot = await getLayoutSnapshot(page);
      return snapshot.panes.flatMap((pane) => pane.tabIds).filter((tabId) => !beforeTabIds.has(tabId)).length;
    }, { timeout: 10000 }).toBe(1);

    const afterSnapshot = await getLayoutSnapshot(page);

    const newTabId = afterSnapshot.panes
      .flatMap((pane) => pane.tabIds)
      .find((tabId) => !beforeTabIds.has(tabId));
    expect(newTabId).toBeTruthy();

    const activePane = afterSnapshot.panes.find((pane) => pane.id === afterSnapshot.activePaneId);
    expect(activePane?.activeTabId).toBe(newTabId);
  });

  test(`${MODIFIER}+Shift+L creates pinned sidebar agents`, async ({ page, electronApp }) => {
    const before = await getLayoutSnapshot(page);
    expect(before.sidebarTabIds).toEqual([]);
    expect(before.rightSidebarOpen).toBe(false);

    await triggerMenuShortcut(electronApp, page, 'CmdOrCtrl+Shift+L');

    await expect.poll(async () => {
      const snapshot = await getLayoutSnapshot(page);
      return {
        sidebarTabCount: snapshot.sidebarTabIds.length,
        rightSidebarOpen: snapshot.rightSidebarOpen,
      };
    }, { timeout: 10000 }).toEqual({
      sidebarTabCount: 1,
      rightSidebarOpen: true,
    });

    await expect(page.locator(sel('newAgentButton'))).toBeVisible({ timeout: 10000 });

    await triggerMenuShortcut(electronApp, page, 'CmdOrCtrl+Shift+L');

    await expect.poll(async () => {
      const snapshot = await getLayoutSnapshot(page);
      return snapshot.sidebarTabIds.length;
    }, { timeout: 10000 }).toBe(2);
  });

  test(`${MODIFIER}+N creates a new window`, async ({ page, electronApp }) => {
    const existingWindows = await getRendererWindows(electronApp);
    const existingSessionKeys = new Set(
      (
        await Promise.all(existingWindows.map(async (candidate) => getWindowSessionKey(candidate)))
      ).filter((sessionKey): sessionKey is string => Boolean(sessionKey)),
    );

    await triggerMenuShortcut(electronApp, page, 'CmdOrCtrl+N');

    const windows = await waitForRendererWindowCount(electronApp, existingWindows.length + 1);
    let newWindow: Page | null = null;

    for (const candidate of windows) {
      const sessionKey = await getWindowSessionKey(candidate);
      if (sessionKey && !existingSessionKeys.has(sessionKey)) {
        newWindow = candidate;
        break;
      }
    }

    if (!newWindow) {
      throw new Error('Failed to identify the newly created renderer window');
    }

    setupPageLogging(newWindow, 'KeyboardShortcuts');
    await waitForAppReady(newWindow);

    const newWindowSnapshot = await getLayoutSnapshot(newWindow);
    expect(newWindowSnapshot.sidebarTabIds).toEqual([]);
    expect(newWindowSnapshot.rightSidebarOpen).toBe(false);

    await newWindow.close();

    await expect.poll(async () => {
      return (await getRendererWindows(electronApp)).length;
    }, { timeout: 10000 }).toBe(existingWindows.length);
  });

  test(`${MODIFIER}+W closes the active sidebar tab when the sidebar is active`, async ({ page, electronApp }) => {
    await triggerMenuShortcut(electronApp, page, 'CmdOrCtrl+Shift+L');
    await triggerMenuShortcut(electronApp, page, 'CmdOrCtrl+Shift+L');

    const snapshot = await getLayoutSnapshot(page);
    expect(snapshot.sidebarTabIds.length).toBe(2);

    const tabToClose = snapshot.sidebarTabIds[0];
    await clickSidebarTab(page, tabToClose);

    await expect.poll(async () => {
      const next = await getLayoutSnapshot(page);
      return {
        activeTabRegion: next.activeTabRegion,
        activeSidebarTabId: next.sidebarActiveTabId,
      };
    }, { timeout: 10000 }).toEqual({
      activeTabRegion: 'sidebar',
      activeSidebarTabId: tabToClose,
    });

    await triggerMenuShortcut(electronApp, page, 'CmdOrCtrl+W');

    await expect.poll(async () => {
      const next = await getLayoutSnapshot(page);
      return {
        sidebarTabIds: next.sidebarTabIds,
        mainActiveTabId: getMainActiveTabId(next),
      };
    }, { timeout: 10000 }).toEqual({
      sidebarTabIds: [snapshot.sidebarTabIds[1]],
      mainActiveTabId: getMainActiveTabId(snapshot),
    });
  });

  test(`${MODIFIER}+Shift+[ and ${MODIFIER}+Shift+] follow the combined main and sidebar tab order`, async ({ page, electronApp }) => {
    await triggerMenuShortcut(electronApp, page, 'CmdOrCtrl+T');
    await triggerMenuShortcut(electronApp, page, 'CmdOrCtrl+Shift+L');
    await triggerMenuShortcut(electronApp, page, 'CmdOrCtrl+Shift+L');

    const snapshot = await getLayoutSnapshot(page);
    const orderedTabIds = getOrderedTabIds(snapshot);
    expect(orderedTabIds).toHaveLength(4);

    const mainTargetTabId = orderedTabIds[1];
    const sidebarTargetTabId = orderedTabIds[2];
    const mainPane = snapshot.panes.find((pane) => pane.tabIds.includes(mainTargetTabId));
    if (!mainPane) {
      throw new Error(`Failed to resolve pane for main tab ${mainTargetTabId}`);
    }

    await clickPaneTab(page, mainPane.id, mainTargetTabId);

    await expect.poll(async () => {
      const next = await getLayoutSnapshot(page);
      return {
        activeTabRegion: next.activeTabRegion,
        activeTabId: getMainActiveTabId(next),
      };
    }, { timeout: 10000 }).toEqual({
      activeTabRegion: 'main',
      activeTabId: mainTargetTabId,
    });

    await triggerMenuShortcut(electronApp, page, 'CmdOrCtrl+Shift+]');

    await expect.poll(async () => {
      const next = await getLayoutSnapshot(page);
      return {
        activeTabRegion: next.activeTabRegion,
        activeSidebarTabId: next.sidebarActiveTabId,
        rightSidebarOpen: next.rightSidebarOpen,
      };
    }, { timeout: 10000 }).toEqual({
      activeTabRegion: 'sidebar',
      activeSidebarTabId: sidebarTargetTabId,
      rightSidebarOpen: true,
    });

    await triggerMenuShortcut(electronApp, page, 'CmdOrCtrl+Shift+[');

    await expect.poll(async () => {
      const next = await getLayoutSnapshot(page);
      return {
        activeTabRegion: next.activeTabRegion,
        activeTabId: getMainActiveTabId(next),
      };
    }, { timeout: 10000 }).toEqual({
      activeTabRegion: 'main',
      activeTabId: mainTargetTabId,
    });
  });

  test(`${MODIFIER}+1-9 includes sidebar tabs in the global numbering`, async ({ page, electronApp }) => {
    await triggerMenuShortcut(electronApp, page, 'CmdOrCtrl+T');
    await triggerMenuShortcut(electronApp, page, 'CmdOrCtrl+Shift+L');
    await triggerMenuShortcut(electronApp, page, 'CmdOrCtrl+Shift+L');

    const snapshot = await getLayoutSnapshot(page);
    const orderedTabIds = getOrderedTabIds(snapshot);
    expect(orderedTabIds).toHaveLength(4);

    const sidebarShortcutTabId = orderedTabIds[2];
    const sidebarShortcutNumber = 3;

    await setCommandOverlayVisible(page, true);

    await expect.poll(async () => {
      return page.evaluate((tabId) => {
        const overlay = document.querySelector<HTMLElement>(
          `[data-testid="agent-tab-${tabId}"] [data-command-overlay-shortcut="⌘3"]`,
        );
        if (!overlay) return null;
        return window.getComputedStyle(overlay).opacity;
      }, sidebarShortcutTabId);
    }, { timeout: 10000 }).toBe('1');

    await setCommandOverlayVisible(page, false);

    await triggerMenuShortcut(electronApp, page, `CmdOrCtrl+${sidebarShortcutNumber}`);

    await expect.poll(async () => {
      const next = await getLayoutSnapshot(page);
      return {
        activeTabRegion: next.activeTabRegion,
        activeSidebarTabId: next.sidebarActiveTabId,
        rightSidebarOpen: next.rightSidebarOpen,
      };
    }, { timeout: 10000 }).toEqual({
      activeTabRegion: 'sidebar',
      activeSidebarTabId: sidebarShortcutTabId,
      rightSidebarOpen: true,
    });
  });
});
