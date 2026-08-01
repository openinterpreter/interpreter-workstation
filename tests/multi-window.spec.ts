import { test, expect, type Page } from './fixtures';
import type { ElectronApplication } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  const windows = electronApp.windows();
  const result: Page[] = [];
  for (const candidate of windows) {
    if (await isRendererWindow(candidate)) {
      result.push(candidate);
    }
  }
  return result;
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

async function waitForWindowReady(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('[data-testid="editor-layout"]', { timeout: 30000 });
  await expect.poll(async () => {
    return await page.evaluate(() => {
      return Boolean(
        (window as any).electron?.getWindowSessionKey?.()
        && (window as any).__layoutContext?.getState?.(),
      );
    });
  }, { timeout: 30000 }).toBe(true);
  await page.waitForTimeout(500);
}

async function getWindowSnapshot(page: Page): Promise<{
  sessionKey: string | null;
  workspace: string | null;
  leftSidebarOpen: boolean;
  rightSidebarOpen: boolean;
  activePaneId: string | null;
  tabs: Array<{ id: string; type: string; label: string }>;
}> {
  return await page.evaluate(() => {
    const layoutContext = (window as any).__layoutContext;
    const state = layoutContext?.getState?.();
    const workstation = (window as any).__getWorkstationContext?.();
    if (!state) {
      throw new Error('__layoutContext.getState() is not available');
    }

    return {
      sessionKey: (window as any).electron?.getWindowSessionKey?.() ?? null,
      workspace: workstation?.workspace ?? null,
      leftSidebarOpen: state.leftSidebar.isOpen,
      rightSidebarOpen: state.rightSidebar.isOpen,
      activePaneId: state.activePaneId,
      tabs: Object.values(state.tabs).map((tab: any) => ({
        id: tab.id,
        type: tab.type,
        label: tab.label,
      })),
    };
  });
}

async function apiRequestInWindow(
  page: Page,
  method: string,
  requestPath: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: any }> {
  return await page.evaluate(async (request) => {
    return await (window as any).electron.apiRequest(request);
  }, {
    method,
    path: requestPath,
    body,
  });
}

async function setWorkspaceForWindow(page: Page, workspacePath: string): Promise<void> {
  const response = await apiRequestInWindow(page, 'POST', '/api/workspace', { path: workspacePath });
  expect(response.ok).toBe(true);

  await expect.poll(async () => {
    return (await getWindowSnapshot(page)).workspace;
  }, { timeout: 15000 }).toBe(workspacePath);
}

async function openFileTab(page: Page, filePath: string): Promise<void> {
  await page.evaluate((targetPath) => {
    (window as any).__layoutContext?.openFile?.(targetPath);
  }, filePath);

  const expectedLabel = path.basename(filePath);
  await expect.poll(async () => {
    return (await getWindowSnapshot(page)).tabs.some((tab) => tab.type === 'file' && tab.label === expectedLabel);
  }, { timeout: 15000 }).toBe(true);
}

async function openSettingsTab(page: Page): Promise<string> {
  await page.evaluate(() => {
    (window as any).__layoutContext?.openSettings?.();
  });

  await expect.poll(async () => {
    const settingsTab = (await getWindowSnapshot(page)).tabs.find((tab) => tab.type === 'settings');
    return settingsTab?.id ?? null;
  }, { timeout: 15000 }).not.toBeNull();

  const snapshot = await getWindowSnapshot(page);
  const settingsTab = snapshot.tabs.find((tab) => tab.type === 'settings');
  if (!settingsTab) {
    throw new Error('Settings tab not found after opening it');
  }
  return settingsTab.id;
}

async function createAdditionalWindow(page: Page, electronApp: ElectronApplication): Promise<Page> {
  const existingWindows = await getRendererWindows(electronApp);
  const existingSessionKeys = new Set(
    (
      await Promise.all(
        existingWindows.map(async (candidate) => (await getWindowSnapshot(candidate)).sessionKey),
      )
    ).filter((sessionKey): sessionKey is string => Boolean(sessionKey)),
  );
  const expectedRendererWindowCount = existingWindows.length + 1;

  await page.evaluate(async () => {
    const result = await (window as any).electron.window.create();
    if (!result?.success) {
      throw new Error(result?.error || 'Failed to create new window');
    }
  });

  const windows = await waitForRendererWindowCount(electronApp, expectedRendererWindowCount);
  for (const candidate of windows) {
    const snapshot = await getWindowSnapshot(candidate);
    if (snapshot.sessionKey && !existingSessionKeys.has(snapshot.sessionKey)) {
      await waitForWindowReady(candidate);
      return candidate;
    }
  }

  throw new Error('Failed to identify the newly created renderer window');
}

async function dragTabOutOfInterpreter(page: Page, tabId: string): Promise<void> {
  await page.evaluate((id) => {
    const tabEl = document.querySelector<HTMLElement>(`[data-tab-id="${id}"]`);
    if (!tabEl) {
      throw new Error(`Tab element not found for ${id}`);
    }

    const rect = tabEl.getBoundingClientRect();
    const dataTransfer = new DataTransfer();
    dataTransfer.effectAllowed = 'move';
    dataTransfer.dropEffect = 'none';

    tabEl.dispatchEvent(new DragEvent('dragstart', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      dataTransfer,
    }));

    dataTransfer.dropEffect = 'none';
    tabEl.dispatchEvent(new DragEvent('dragend', {
      bubbles: true,
      cancelable: true,
      clientX: window.innerWidth + 120,
      clientY: rect.top + 10,
      dataTransfer,
    }));
  }, tabId);
}

async function dragTabIntoOtherWindow(
  sourcePage: Page,
  targetPage: Page,
  tabId: string,
): Promise<void> {
  const payload = await sourcePage.evaluate((id) => {
    const layoutContext = (window as any).__layoutContext;
    const state = layoutContext?.getState?.();
    if (!state) {
      throw new Error('__layoutContext.getState() is not available');
    }

    const findPaneId = (node: any): string | null => {
      if (node.kind === 'pane') {
        return node.tabIds.includes(id) ? node.id : null;
      }
      return findPaneId(node.children[0]) ?? findPaneId(node.children[1]);
    };

    const tab = state.tabs[id];
    if (!tab) {
      throw new Error(`Tab ${id} not found in source window`);
    }

    return {
      tab,
      sourcePaneId: findPaneId(state.tree),
      sourceWindowSessionKey: (window as any).electron?.getWindowSessionKey?.() ?? null,
    };
  }, tabId);

  const targetSnapshot = await getWindowSnapshot(targetPage);
  if (!targetSnapshot.activePaneId) {
    throw new Error('Target window has no active pane');
  }

  await targetPage.evaluate(({ transferPayload, targetPaneId }) => {
    const tabBar = document.querySelector<HTMLElement>(`[data-testid="pane-tab-bar-${targetPaneId}"]`);
    if (!tabBar) {
      throw new Error(`Target tab bar not found for pane ${targetPaneId}`);
    }

    const rect = tabBar.getBoundingClientRect();
    const dataTransfer = new DataTransfer();
    dataTransfer.effectAllowed = 'move';
    dataTransfer.setData('text/plain', transferPayload.tab.id);
    dataTransfer.setData('application/json', JSON.stringify({
      type: 'pane-tab',
      tabId: transferPayload.tab.id,
      tab: transferPayload.tab,
      sourcePaneId: transferPayload.sourcePaneId,
      sourceWindowSessionKey: transferPayload.sourceWindowSessionKey,
    }));

    tabBar.dispatchEvent(new DragEvent('dragenter', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      dataTransfer,
    }));
    tabBar.dispatchEvent(new DragEvent('dragover', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      dataTransfer,
    }));
    tabBar.dispatchEvent(new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      dataTransfer,
    }));
  }, {
    transferPayload: payload,
    targetPaneId: targetSnapshot.activePaneId,
  });
}

const tempRoots: string[] = [];

test.describe.serial('Multi Window', () => {
  test.afterEach(async ({ electronApp }) => {
    const windows = await getRendererWindows(electronApp);
    for (const extraWindow of windows.slice(1)) {
      await extraWindow.evaluate(() => {
        window.close();
      }).catch(() => {});
    }

    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (!root) continue;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('runs two windows at once with independent workspace and layout state', async ({ page, electronApp }) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'interpreter-multi-window-'));
    tempRoots.push(tempRoot);

    const workspaceA = path.join(tempRoot, 'workspace-a');
    const workspaceB = path.join(tempRoot, 'workspace-b');
    fs.mkdirSync(workspaceA, { recursive: true });
    fs.mkdirSync(workspaceB, { recursive: true });
    fs.writeFileSync(path.join(workspaceA, 'alpha.txt'), 'alpha');
    fs.writeFileSync(path.join(workspaceB, 'beta.txt'), 'beta');

    await page.evaluate(() => {
      const layout = (window as any).__layoutContext;
      layout?.setLeftSidebarOpen?.(true);
    });

    await setWorkspaceForWindow(page, workspaceA);
    await openFileTab(page, path.join(workspaceA, 'alpha.txt'));

    const secondPage = await createAdditionalWindow(page, electronApp);
    await setWorkspaceForWindow(secondPage, workspaceB);
    await openFileTab(secondPage, path.join(workspaceB, 'beta.txt'));
    await secondPage.evaluate(() => {
      const layout = (window as any).__layoutContext;
      layout?.setLeftSidebarOpen?.(false);
      layout?.openSettings?.();
    });

    await expect.poll(async () => {
      const snapshot = await getWindowSnapshot(secondPage);
      return snapshot.tabs.some((tab) => tab.type === 'settings');
    }, { timeout: 15000 }).toBe(true);

    const firstSnapshot = await getWindowSnapshot(page);
    const secondSnapshot = await getWindowSnapshot(secondPage);

    expect(firstSnapshot.sessionKey).not.toBe(secondSnapshot.sessionKey);
    expect(firstSnapshot.workspace).toBe(workspaceA);
    expect(secondSnapshot.workspace).toBe(workspaceB);
    expect(firstSnapshot.tabs.some((tab) => tab.label === 'alpha.txt')).toBe(true);
    expect(secondSnapshot.tabs.some((tab) => tab.label === 'beta.txt')).toBe(true);
    expect(firstSnapshot.tabs.some((tab) => tab.type === 'settings')).toBe(false);
    expect(secondSnapshot.tabs.some((tab) => tab.type === 'settings')).toBe(true);
    expect(firstSnapshot.leftSidebarOpen).toBe(true);
    expect(secondSnapshot.leftSidebarOpen).toBe(false);

    await secondPage.evaluate(() => {
      window.close();
    });

    await expect.poll(async () => {
      return (await getRendererWindows(electronApp)).length;
    }, { timeout: 15000 }).toBe(1);
  });

  test('dragging a tab out creates a new window and dragging it back combines the windows', async ({ page, electronApp }) => {
    const settingsTabId = await openSettingsTab(page);

    await dragTabOutOfInterpreter(page, settingsTabId);
    await waitForRendererWindowCount(electronApp, 2);

    const windows = await getRendererWindows(electronApp);
    const mainSessionKey = (await getWindowSnapshot(page)).sessionKey;
    let detachedWindow: Page | null = null;
    for (const candidate of windows) {
      const snapshot = await getWindowSnapshot(candidate);
      if (snapshot.sessionKey !== mainSessionKey) {
        detachedWindow = candidate;
        break;
      }
    }
    if (!detachedWindow) {
      throw new Error('Detached window was not created');
    }

    await waitForWindowReady(detachedWindow);

    const detachedSnapshot = await getWindowSnapshot(detachedWindow);
    expect(detachedSnapshot.tabs).toHaveLength(1);
    expect(detachedSnapshot.tabs[0]?.type).toBe('settings');
    expect(detachedSnapshot.leftSidebarOpen).toBe(false);
    expect(detachedSnapshot.rightSidebarOpen).toBe(false);

    await dragTabIntoOtherWindow(detachedWindow, page, detachedSnapshot.tabs[0].id);

    await expect.poll(async () => {
      return (await getRendererWindows(electronApp)).length;
    }, { timeout: 15000 }).toBe(1);

    await expect.poll(async () => {
      const snapshot = await getWindowSnapshot(page);
      return snapshot.tabs.filter((tab) => tab.type === 'settings').length;
    }, { timeout: 15000 }).toBe(1);
  });
});
