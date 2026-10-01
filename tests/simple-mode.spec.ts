import { expect } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from './fixtures';
import { waitForAppReady } from './helpers';
import { sel } from './selectors';

let root: string | null = null;
test.afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

test('first-run Simple opens a standalone React project, retains last-good and reversibly switches Advanced', async ({ page }) => {
  test.setTimeout(120_000);
  await waitForAppReady(page);
  await expect(page.getByRole('main', { name: 'Interface projects' })).toBeVisible();
  await expect(page.locator('.app-workspace-shell')).toHaveCount(0);

  root = await mkdtemp(path.join(tmpdir(), 'interpreter-simple-e2e-'));
  const control = path.join(root, 'control');
  const projects = path.join(root, 'projects');
  await mkdir(control); await mkdir(projects);
  await page.evaluate(async folder => (window as any).electron.workspace.setSimple({ workspacePath: folder }), control);
  const selected = await page.evaluate(async parentPath => {
    const windowId = sessionStorage.getItem('interpreter-simple-window-id');
    return (window as any).electron.apiRequest({ method: 'POST', path: '/api/simple-interface/projects/new',
      body: { parentPath, name: 'First', windowId } });
  }, projects);
  expect(selected.ok).toBe(true);
  const project = path.join(projects, 'First');
  const source = path.join(project, 'src', 'main.tsx');
  expect(await readFile(source, 'utf8')).toContain('@interpreter/simple-runtime/v1');
  await page.reload();
  await waitForAppReady(page);
  await expect(page.locator('[data-simple-shell]')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Primary conversation' })).toBeVisible();

  const reactPage = (title: string) => `import React from 'react'; import { createRoot } from 'react-dom/client';\n` +
    `createRoot(document.getElementById('root')!).render(<h1>${title}</h1>);`;
  await writeFile(source, reactPage('A new canvas'), 'utf8');
  await expect(page.frameLocator('iframe[title="Generated interface"]').getByRole('heading', { name: 'A new canvas' }))
    .toBeVisible({ timeout: 20000 });

  await writeFile(source, 'import secret from "node:fs"; document.body.textContent = secret;', 'utf8');
  await expect(page.getByText('Interface edit needs fixing; last working version remains visible.'))
    .toBeVisible({ timeout: 20000 });
  await expect(page.frameLocator('iframe[title="Generated interface"]').getByRole('heading', { name: 'A new canvas' })).toBeVisible();
  expect(JSON.parse(await readFile(path.join(project, '.interpreter', 'diagnostics.json'), 'utf8')).error).toContain('Only bundled React');

  await writeFile(source, reactPage('Recovered canvas'), 'utf8');
  await expect(page.frameLocator('iframe[title="Generated interface"]').getByRole('heading', { name: 'Recovered canvas' }))
    .toBeVisible({ timeout: 20000 });
  await page.reload();
  await waitForAppReady(page);
  await expect(page.frameLocator('iframe[title="Generated interface"]').getByRole('heading', { name: 'Recovered canvas' }))
    .toBeVisible({ timeout: 20000 });

  await page.getByRole('button', { name: 'Open Settings' }).click();
  await page.getByText('Manage models').click();
  await expect(page.getByText('Available models')).toBeVisible({ timeout: 20_000 });
  await page.getByText('Manage models').click();
  await page.getByRole('group', { name: 'Experience' }).getByRole('button', { name: 'Advanced' }).click();
  await expect(page.locator('.app-workspace-shell')).toBeVisible();
  await page.evaluate(() => (window as any).__layoutContext?.openSettings?.());
  await expect(page.locator(sel('settingsView'))).toBeVisible();
  await page.getByRole('group', { name: 'Experience' }).getByRole('button', { name: 'Simple' }).click({ force: true });
  await expect(page.locator('[data-simple-shell]')).toBeVisible();
  // The same canvas remains underneath the attached drawer after the mode switch.
  const closeDrawer = page.getByRole('button', { name: 'Close drawer' });
  if (await closeDrawer.isVisible()) await closeDrawer.click();
  await expect(page.frameLocator('iframe[title="Generated interface"]').getByRole('heading', { name: 'Recovered canvas' })).toBeVisible();
});

test('File > New Interface opens a separate Simple picker even while Advanced is selected', async ({ page, electronApp }) => {
  test.setTimeout(90_000);
  await waitForAppReady(page);
  await page.evaluate(() => (window as any).electron.uiSettings.setAdvancedMode(true));
  await expect(page.locator('.app-workspace-shell')).toBeVisible();

  const opened = electronApp.waitForEvent('window', { timeout: 20_000 });
  await electronApp.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu()?.items.find(item => item.label === 'File');
    const item = file?.submenu?.items.find(entry => entry.label === 'New Interface…');
    if (!item?.click) throw new Error('New Interface command is unavailable');
    item.click(item, undefined, {} as never);
  });
  const window = await opened;
  try {
    await expect(window.getByRole('main', { name: 'Interface projects' })).toBeVisible({ timeout: 20_000 });
    await expect(window.locator('.app-workspace-shell')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).electron.uiSettings.getAdvancedMode()))
      .toMatchObject({ enabled: true });
  } finally {
    await window.close();
    await page.evaluate(() => (window as any).electron.uiSettings.setAdvancedMode(false));
  }
});
