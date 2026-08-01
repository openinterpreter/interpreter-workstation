import { test, expect } from './fixtures';
import {
  getTestWorkspace,
  setWorkspace,
  waitForAppReady,
  waitForFileTreeLoaded,
  waitForTreeItem,
} from './helpers';
import { sel } from './selectors';
import { MAIN_COMPOSER_INPUT_ID } from '../shared/element-ids';

async function dragExplorerFileToTarget(
  page: import('@playwright/test').Page,
  sourcePath: string,
  targetSelector: string,
  targetPoint: { x: number; y: number },
  options?: { deliverDrop?: boolean },
): Promise<void> {
  await page.waitForFunction((path: string) => {
    return Array.from(document.querySelectorAll('[role="treeitem"]'))
      .some((node) => node.getAttribute('data-path') === path && (node as HTMLElement).draggable);
  }, sourcePath);

  await page.evaluate(({ sourcePath, targetSelector, targetPoint, deliverDrop }) => {
    const getPathFilename = (filePath: string): string => {
      const normalizedPath = filePath.split('\\').join('/');
      const lastSeparatorIndex = normalizedPath.lastIndexOf('/');
      return lastSeparatorIndex >= 0 ? normalizedPath.slice(lastSeparatorIndex + 1) : normalizedPath;
    };

    const toFileUri = (filePath: string): string => {
      const normalizedPath = filePath.split('\\').join('/');
      if (/^[A-Za-z]:\//.test(normalizedPath)) {
        return `file:///${encodeURI(normalizedPath)}`;
      }
      if (normalizedPath.startsWith('//')) {
        return `file://${encodeURI(normalizedPath.slice(2))}`;
      }
      return `file://${encodeURI(normalizedPath)}`;
    };

    const sourceTreeItem = Array.from(document.querySelectorAll('[role="treeitem"]'))
      .find((node) => node.getAttribute('data-path') === sourcePath) as HTMLElement | undefined;
    const targetEl = document.querySelector(targetSelector) as HTMLElement | null;
    if (!sourceTreeItem || !targetEl) {
      throw new Error(`Drag source or target missing: source=${Boolean(sourceTreeItem)} target=${Boolean(targetEl)}`);
    }

    const sourceRect = sourceTreeItem.getBoundingClientRect();
    const fileName = getPathFilename(sourcePath) || sourcePath;
    const dataTransfer = new DataTransfer();
    dataTransfer.effectAllowed = 'move';
    dataTransfer.setData('application/json', JSON.stringify({
      type: 'file',
      sourceContext: 'explorer',
      filePath: sourcePath,
      fileName,
      isDirectory: false,
    }));
    dataTransfer.setData('text/uri-list', toFileUri(sourcePath));

    sourceTreeItem.dispatchEvent(new DragEvent('dragstart', {
      bubbles: true,
      cancelable: true,
      clientX: sourceRect.left + sourceRect.width / 2,
      clientY: sourceRect.top + sourceRect.height / 2,
      dataTransfer,
    }));

    targetEl.dispatchEvent(new DragEvent('dragenter', {
      bubbles: true,
      cancelable: true,
      clientX: targetPoint.x,
      clientY: targetPoint.y,
      dataTransfer,
    }));

    targetEl.dispatchEvent(new DragEvent('dragover', {
      bubbles: true,
      cancelable: true,
      clientX: targetPoint.x,
      clientY: targetPoint.y,
      dataTransfer,
    }));

    if (deliverDrop) {
      targetEl.dispatchEvent(new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        clientX: targetPoint.x,
        clientY: targetPoint.y,
        dataTransfer,
      }));
    }

    sourceTreeItem.dispatchEvent(new DragEvent('dragend', {
      bubbles: true,
      cancelable: true,
      clientX: targetPoint.x,
      clientY: targetPoint.y,
      dataTransfer,
    }));
  }, {
    sourcePath,
    targetSelector,
    targetPoint,
    deliverDrop: options?.deliverDrop ?? false,
  });
}

async function createEditorAgent(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(async () => {
    const ctx = (window as any).__layoutContext;
    ctx.openNewTab();
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    return ctx.getState().activePaneId as string;
  });
}

async function createPinnedSidebarAgent(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(async () => {
    window.dispatchEvent(new CustomEvent('sidebar:create-pinned-agent'));
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });

    const sidebarPaneId = (window as any).__layoutContext?.getState()?.sidebarPane?.id;
    if (!sidebarPaneId) {
      throw new Error('Sidebar pane id not found after creating pinned agent');
    }

    return sidebarPaneId as string;
  });
}

async function getEditorAgentComposerPoint(
  page: import('@playwright/test').Page,
  paneId: string,
): Promise<{ x: number; y: number }> {
  return page.evaluate(({ paneId, composerTestId }) => {
    const composer = document.querySelector<HTMLElement>(
      `[data-persistent-pane="${paneId}"][data-persistent-visible="true"] [data-testid="${composerTestId}"]`,
    );
    if (!composer) {
      throw new Error(`Composer not found for pane ${paneId}`);
    }
    const rect = composer.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  }, { paneId, composerTestId: MAIN_COMPOSER_INPUT_ID });
}

async function getEditorAgentPaneBodyPoint(
  page: import('@playwright/test').Page,
  paneId: string,
): Promise<{ x: number; y: number }> {
  return page.evaluate(({ paneId, composerTestId, paneSelector }) => {
    const pane = document.querySelector<HTMLElement>(paneSelector);
    if (!pane) {
      throw new Error(`Pane content not found for pane ${paneId}`);
    }

    const paneRect = pane.getBoundingClientRect();
    const composer = document.querySelector<HTMLElement>(
      `[data-persistent-pane="${paneId}"][data-persistent-visible="true"] [data-testid="${composerTestId}"]`,
    );
    const composerRect = composer?.getBoundingClientRect() ?? null;
    const availableBottom = composerRect ? composerRect.top : paneRect.bottom;
    const y = paneRect.top + Math.max(32, (availableBottom - paneRect.top) / 2);

    return {
      x: paneRect.left + paneRect.width / 2,
      y,
    };
  }, {
    paneId,
    composerTestId: MAIN_COMPOSER_INPUT_ID,
    paneSelector: sel.paneContent(paneId),
  });
}

test.describe('Agent file drops', () => {
  let testWorkspace: string;

  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page);
    testWorkspace = getTestWorkspace();
    await setWorkspace(page, testWorkspace);
    await waitForFileTreeLoaded(page);
  });

  test('sidebar mention drop still works when the browser never delivers drop', async ({ page }) => {
    const source = await waitForTreeItem(page, 'notes.txt');
    const sourcePath = await source.getAttribute('data-path');
    if (!sourcePath) {
      throw new Error('notes.txt tree item missing data-path');
    }
    const sidebarPaneId = await createPinnedSidebarAgent(page);

    const sidebarBox = await page.locator(sel('agentSidebar')).boundingBox();
    if (!sidebarBox) {
      throw new Error('Agent sidebar has no bounding box');
    }

    await dragExplorerFileToTarget(page, sourcePath, sel('agentSidebar'), {
      x: sidebarBox.x + sidebarBox.width / 2,
      y: sidebarBox.y + Math.min(48, sidebarBox.height / 4),
    });

    const sidebarMention = page.locator(
      `[data-persistent-pane="${sidebarPaneId}"][data-persistent-visible="true"] .mention-node-view`,
    ).first();
    await expect(sidebarMention).toBeVisible({ timeout: 5000 });
    await expect(sidebarMention).toContainText('notes.txt');
  });

  test('editor composer mention drop still works when the browser never delivers drop', async ({ page }) => {
    const paneId = await createEditorAgent(page);
    const source = await waitForTreeItem(page, 'notes.txt');
    const sourcePath = await source.getAttribute('data-path');
    if (!sourcePath) {
      throw new Error('notes.txt tree item missing data-path');
    }

    await expect(page.locator(sel.paneContent(paneId))).toBeVisible({ timeout: 5000 });
    const composerPoint = await getEditorAgentComposerPoint(page, paneId);

    await dragExplorerFileToTarget(page, sourcePath, sel.paneContent(paneId), composerPoint);

    const paneMention = page.locator(
      `[data-persistent-pane="${paneId}"][data-persistent-visible="true"] .mention-node-view`,
    ).first();
    await expect(paneMention).toBeVisible({ timeout: 5000 });
    await expect(paneMention).toContainText('notes.txt');
  });

  test('agent pane body still splits when the browser never delivers drop', async ({ page }) => {
    const paneId = await createEditorAgent(page);
    const source = await waitForTreeItem(page, 'notes.txt');
    const sourcePath = await source.getAttribute('data-path');
    if (!sourcePath) {
      throw new Error('notes.txt tree item missing data-path');
    }

    const paneBodyPoint = await getEditorAgentPaneBodyPoint(page, paneId);
    const paneMention = page.locator(
      `[data-persistent-pane="${paneId}"][data-persistent-visible="true"] .mention-node-view`,
    );
    const initialMentionCount = await paneMention.count();

    await dragExplorerFileToTarget(page, sourcePath, sel.paneContent(paneId), paneBodyPoint);

    await expect(page.locator(sel.paneContentAny())).toHaveCount(2, { timeout: 5000 });
    await expect(paneMention).toHaveCount(initialMentionCount);
  });
});
