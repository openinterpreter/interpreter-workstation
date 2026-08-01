import { test, expect } from './fixtures';
import {
  waitForAppReady,
  setWorkspace,
  getTestWorkspace,
  waitForFileTreeLoaded,
  waitForTreeItem,
  clickTreeItem,
  expandFolder,
} from './helpers';
import { sel } from './selectors';

test.describe('PDF annotation interactions', () => {
  test.setTimeout(120000);
  let testWorkspace: string;

  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page);
    testWorkspace = getTestWorkspace();
    await setWorkspace(page, testWorkspace);
    await waitForFileTreeLoaded(page);
    await expandFolder(page, 'pdfs');
  });

  test('selected text annotation exposes drag/resize handles and supports save now', async ({ page }) => {
    const pdfFile = await waitForTreeItem(page, 'test-document.pdf');
    await clickTreeItem(page, pdfFile);

    const viewer = page.locator(sel('pdfViewer'));
    await expect(viewer).toBeVisible({ timeout: 10000 });
    await page.waitForSelector('[data-page-number="1"]', { timeout: 10000 });

    await page.click(sel('pdfAddAnnotationButton'));

    const annotation = page.locator('.pdf-annotation').first();
    await expect(annotation).toBeVisible({ timeout: 10000 });
    await annotation.click();

    const dragHandle = annotation.locator('.pdf-annotation-drag-handle');
    await expect(dragHandle).toBeVisible();
    await expect(annotation.locator('.pdf-annotation-resize-handle')).toHaveCount(4);

    const beforeDrag = await annotation.boundingBox();
    if (!beforeDrag) throw new Error('Annotation bounding box missing before drag');

    const dragHandleBox = await dragHandle.boundingBox();
    if (!dragHandleBox) throw new Error('Drag handle bounding box missing');

    await page.mouse.move(dragHandleBox.x + dragHandleBox.width / 2, dragHandleBox.y + dragHandleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      dragHandleBox.x + dragHandleBox.width / 2 + 80,
      dragHandleBox.y + dragHandleBox.height / 2 + 40,
      { steps: 16 },
    );
    await page.mouse.up();

    await page.waitForTimeout(100);
    const afterDrag = await annotation.boundingBox();
    if (!afterDrag) throw new Error('Annotation bounding box missing after drag');
    expect(afterDrag.x).toBeGreaterThan(beforeDrag.x + 30);
    expect(afterDrag.y).toBeGreaterThan(beforeDrag.y + 15);

    const resizeHandle = annotation.locator('.pdf-annotation-resize-handle[data-handle-direction="se"]');
    await expect(resizeHandle).toBeVisible();
    const resizeBox = await resizeHandle.boundingBox();
    if (!resizeBox) throw new Error('Resize handle bounding box missing');

    await page.mouse.move(resizeBox.x + resizeBox.width / 2, resizeBox.y + resizeBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      resizeBox.x + resizeBox.width / 2 + 36,
      resizeBox.y + resizeBox.height / 2 + 24,
      { steps: 12 },
    );
    await page.mouse.up();

    await page.waitForTimeout(100);
    const afterResize = await annotation.boundingBox();
    if (!afterResize) throw new Error('Annotation bounding box missing after resize');
    expect(afterResize.width).toBeGreaterThan(afterDrag.width + 10);
    expect(afterResize.height).toBeGreaterThan(afterDrag.height + 6);

    const toolbar = page.locator('.voice-focus-content-toolbar').first();
    await expect(toolbar.locator('text=Unsaved')).toBeVisible({ timeout: 5000 });

    await page.click(sel('pdfSaveButton'));
    await expect(toolbar.locator('text=Unsaved')).toBeHidden({ timeout: 10000 });
    await expect(toolbar.locator('text=Saving...')).toBeHidden({ timeout: 10000 });
    await expect(annotation.locator('.pdf-annotation-drag-handle')).toBeVisible();
    await expect(annotation.locator('.pdf-annotation-resize-handle')).toHaveCount(4);
  });
});
