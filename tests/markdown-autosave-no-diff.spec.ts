import { test, expect } from './fixtures';
import { waitForAppReady, getTestWorkspace, setWorkspace, waitForFileTreeLoaded } from './helpers';
import { sel } from './selectors';
import * as fs from 'fs';
import * as path from 'path';

const DIFF_SELECTORS = {
  keepAllButton: sel('keepAllButton'),
  undoAllButton: sel('undoAllButton'),
};

test.describe('Markdown diff review smoke', () => {
  const testWorkspace = getTestWorkspace();
  const mdFile = path.join(testWorkspace, 'autosave-test.md');
  const diffBodyBase = '# Externally Modified\n\nAn agent changed this file.\n';

  test.beforeEach(async () => {
    fs.writeFileSync(mdFile, '# Hello\n\nSome initial content.\n', 'utf-8');
  });

  test('external disk write triggers markdown diff review UI', async ({ page }) => {
    test.setTimeout(60000);

    await waitForAppReady(page);
    await setWorkspace(page, testWorkspace);
    await waitForFileTreeLoaded(page);

    await page.evaluate((filePath: string) => {
      (window as any).__layoutContext?.openFile(filePath);
    }, mdFile);

    const editorArea = page.locator(sel('editorArea'));
    const keepAllButton = page.locator(DIFF_SELECTORS.keepAllButton);
    const undoAllButton = page.locator(DIFF_SELECTORS.undoAllButton);

    await expect(editorArea).toBeVisible({ timeout: 10000 });
    await expect(editorArea).toHaveAttribute('data-file-path', mdFile);
    await expect(keepAllButton).not.toBeVisible();
    await expect(undoAllButton).not.toBeVisible();

    // Drive writes through the app IPC layer so each attempt emits a deterministic
    // workspace change event and refreshes markdown diff state on CI.
    let writeCount = 0;
    await expect
      .poll(async () => {
        writeCount += 1;
        const content = `${diffBodyBase}\n<!-- write-${writeCount}-${Date.now()} -->\n`;
        await page.evaluate(async ({ filePath, text }) => {
          const bytes = new TextEncoder().encode(text);
          await (window as any).electron.files.writeBinary(filePath, bytes.buffer);
        }, { filePath: mdFile, text: content });
        return (await keepAllButton.isVisible()) && (await undoAllButton.isVisible());
      }, {
        timeout: 30000,
        intervals: [500, 1000, 1500],
      })
      .toBe(true);

    await expect(keepAllButton).toBeVisible({ timeout: 10000 });
    await expect(undoAllButton).toBeVisible({ timeout: 10000 });
  });
});
