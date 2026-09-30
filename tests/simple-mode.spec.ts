import { expect } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from './fixtures';
import { waitForAppReady } from './helpers';
import { sel } from './selectors';

let root: string | null = null;
test.afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

test('Simple canvas is default, retains last-good edits and switches reversibly to Advanced', async ({ page }) => {
  test.setTimeout(90_000); // A real Electron renderer reload can take >15 seconds under CI.
  await waitForAppReady(page);
  await expect(page.locator('[data-simple-shell]')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Primary conversation' })).toBeVisible();
  await expect(page.locator('.app-workspace-shell')).toHaveCount(0);

  root = await mkdtemp(path.join(tmpdir(), 'interpreter-simple-e2e-'));
  const selected = await page.evaluate(async (folder) => {
    return await (window as any).electron.workspace.setSimple({ workspacePath: folder });
  }, root);
  expect(selected.workspacePath).toBe(root);
  const directory = path.join(root, 'interface');
  await mkdir(directory, { recursive: true });
  const candidate = path.join(directory, 'page.json');
  const makePage = (title: string) => ({
    version: 1, title, blocks: [{ type: 'heading', id: 'hello', text: title }],
  });
  await writeFile(candidate, JSON.stringify(makePage('A new canvas')), 'utf8');
  await expect(page.getByRole('heading', { name: 'A new canvas' })).toBeVisible({ timeout: 15000 });

  await writeFile(candidate, '{invalid-json', 'utf8');
  await expect(page.getByText('An interface edit needs fixing.')).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('heading', { name: 'A new canvas' })).toBeVisible();
  expect(JSON.parse(await readFile(path.join(directory, 'diagnostics.json'), 'utf8')).error).toContain('Invalid interface/page.json');

  await writeFile(candidate, JSON.stringify(makePage('Recovered canvas')), 'utf8');
  await expect(page.getByRole('heading', { name: 'Recovered canvas' })).toBeVisible({ timeout: 15000 });
  await page.reload();
  await waitForAppReady(page);
  await expect(page.getByRole('heading', { name: 'Recovered canvas' })).toBeVisible({ timeout: 15000 });

  await page.getByRole('button', { name: 'Open Settings' }).click();
  await page.getByRole('group', { name: 'Experience' }).getByRole('button', { name: 'Advanced' }).click();
  await expect(page.locator('.app-workspace-shell')).toBeVisible();
  await page.evaluate(() => (window as any).__layoutContext?.openSettings?.());
  await expect(page.locator(sel('settingsView'))).toBeVisible();
  // The legacy Settings pane animates while the canvas is being mounted; the
  // button is visible/enabled but Playwright's stability heuristic can wait
  // indefinitely for a still frame in the Electron compositor.
  await page.getByRole('group', { name: 'Experience' }).getByRole('button', { name: 'Simple' }).click({ force: true });
  await expect(page.locator('[data-simple-shell]')).toBeVisible();
  await page.getByRole('button', { name: 'Back to interface' }).click();
  await expect(page.getByRole('heading', { name: 'Recovered canvas' })).toBeVisible();
});
