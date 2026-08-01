import path from 'node:path';
import { test, expect } from './fixtures';
import {
  waitForAppReady,
  setWorkspace,
  getTestWorkspace,
  waitForFileTreeLoaded,
  waitForTreeItem,
  clickTreeItem,
} from './helpers';
import { sel } from './selectors';

test('file-open smoke: clicking a workspace file opens it in the editor', async ({ page }) => {
  const testWorkspace = getTestWorkspace();

  await waitForAppReady(page);
  await setWorkspace(page, testWorkspace);
  await waitForFileTreeLoaded(page);

  const file = await waitForTreeItem(page, 'notes.txt');
  await clickTreeItem(page, file);

  const expectedPath = path.join(testWorkspace, 'notes.txt');
  await expect(page.locator(sel.tabByPath(expectedPath))).toBeVisible({ timeout: 5000 });
  await expect(page.locator(sel('editorArea'))).toHaveAttribute('data-file-path', expectedPath);
});
