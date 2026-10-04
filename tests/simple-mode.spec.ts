import { expect, type Frame, type Page } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from './fixtures';
import { reloadAndWaitForPageLoadSignals, waitForAppReady, waitForUiStability } from './helpers';
import { sel } from './selectors';
import { createDefaultOnboardingState, type OnboardingState } from '../shared/types/onboardingState';

let root: string | null = null;
test.afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

async function onboardingState(page: Page): Promise<OnboardingState> {
  const response = await page.evaluate(async () => {
    const result = await (window as any).electron.apiRequest({
      method: 'POST',
      path: '/api/ipc/onboardingState/get',
      body: [],
    });
    if (!result.ok) throw new Error(String(result.data?.error ?? 'Could not read onboarding state.'));
    return result.data;
  });
  return response.state;
}

async function setOnboardingState(page: Page, state: OnboardingState): Promise<void> {
  const response = await page.evaluate(async (nextState) => {
    return await (window as any).electron.apiRequest({
      method: 'POST',
      path: '/api/ipc/onboardingState/set',
      body: [nextState],
    });
  }, state);
  if (!response.ok) throw new Error(String(response.data?.error ?? 'Could not set onboarding state.'));
}

async function waitForInterfaceFrame(
  page: Page,
  predicate: (frame: Frame) => Promise<boolean>,
): Promise<Frame> {
  let active: Frame | null = null;
  await expect.poll(async () => {
    const frames = page.frames().filter((frame) => frame.url().includes('/api/simple-interface/app/index.html'));
    for (const frame of [...frames].reverse()) {
      if (await predicate(frame).catch(() => false)) {
        active = frame;
        return true;
      }
    }
    return false;
  }, { timeout: 15_000 }).toBe(true);
  if (!active) throw new Error('The active Simple interface frame did not appear.');
  return active;
}

test('Simple React interface is default, preserves live state, exposes its settings, and switches reversibly to Advanced', async ({ page }) => {
  test.setTimeout(90_000); // A real Electron renderer reload can take >15 seconds under CI.
  await waitForAppReady(page);
  await expect(page.locator('[data-simple-shell]')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Primary conversation' })).toBeVisible();
  await expect(page.locator('.app-workspace-shell')).toHaveCount(0);

  root = await mkdtemp(path.join(tmpdir(), 'interpreter-simple-e2e-'));
  const controlWorkspace = path.join(root, 'workspace');
  let interfaceProject = path.join(root, 'live-interface');
  await mkdir(controlWorkspace);
  await mkdir(interfaceProject);
  const selected = await page.evaluate(async (folder) => {
    return await (window as any).electron.workspace.setSimple({ workspacePath: folder });
  }, controlWorkspace);
  // macOS canonicalizes /var to /private/var at the workspace boundary.
  expect(path.basename(selected.workspacePath)).toBe('workspace');
  const created = await page.evaluate(async (folder) => {
    return await (window as any).electron.apiRequest({
      method: 'POST',
      path: '/api/simple-interface/projects/new',
      body: { path: folder },
    });
  }, interfaceProject);
  expect(created.ok).toBe(true);
  interfaceProject = created.data.path;
  expect(path.basename(interfaceProject)).toBe('live-interface');
  await page.evaluate(() => window.dispatchEvent(new Event('simple-project:changed')));
  const directory = path.join(interfaceProject, 'src');
  const candidate = path.join(directory, 'App.jsx');
  const makeApp = (title: string) => `
    import React from 'react';
    import { Page, Card, Heading, TextInput, usePersistentState } from '@interpreter/interface';
    import { motion } from '@interpreter/motion';
    export default function App() {
      const [note, setNote] = usePersistentState('acceptance-note', '');
      return <Page><motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
        <Card><Heading>${title}</Heading><TextInput aria-label="Persistent note" value={note} onChange={(event) => setNote(event.target.value)} /></Card>
      </motion.div></Page>;
    }
  `;
  await writeFile(candidate, makeApp('A live React canvas'), 'utf8');
  const promoted = await page.evaluate(async () => {
    return await (window as any).electron.apiRequest({
      method: 'POST',
      path: '/api/simple-interface/promote',
    });
  });
  expect(promoted.ok).toBe(true);
  expect(promoted.data.ready).toBe(true);
  expect(promoted.data.diagnostic).toBeNull();
  // Revisions cross-fade through two briefly overlapping frames; the last
  // frame is always the newly promoted interface.
  let canvas = await waitForInterfaceFrame(page, async (frame) =>
    await frame.getByRole('heading', { name: 'A live React canvas' }).isVisible());
  await expect(canvas.getByRole('heading', { name: 'A live React canvas' })).toBeVisible({ timeout: 15000 });
  await canvas.getByRole('textbox', { name: 'Persistent note' }).fill('survives hot reload');

  await writeFile(candidate, 'export default function App( {', 'utf8');
  await expect(page.getByRole('status')).toContainText('latest interface edit needs fixing', { timeout: 15000 });
  await expect(canvas.getByRole('heading', { name: 'A live React canvas' })).toBeVisible();
  await expect(canvas.getByRole('textbox', { name: 'Persistent note' })).toHaveValue('survives hot reload');
  expect(JSON.parse(await readFile(path.join(interfaceProject, '.interpreter', 'runtime', 'diagnostics.json'), 'utf8')).error).toContain('Expected identifier');

  await writeFile(candidate, makeApp('Recovered canvas'), 'utf8');
  canvas = await waitForInterfaceFrame(page, async (frame) =>
    await frame.getByRole('heading', { name: 'Recovered canvas' }).isVisible());
  await expect(canvas.getByRole('heading', { name: 'Recovered canvas' })).toBeVisible({ timeout: 15000 });
  await expect(canvas.getByRole('textbox', { name: 'Persistent note' })).toHaveValue('survives hot reload');
  await page.reload();
  await waitForAppReady(page);
  canvas = await waitForInterfaceFrame(page, async (frame) =>
    await frame.getByRole('heading', { name: 'Recovered canvas' }).isVisible());
  await expect(canvas.getByRole('heading', { name: 'Recovered canvas' })).toBeVisible({ timeout: 15000 });
  await expect(canvas.getByRole('textbox', { name: 'Persistent note' })).toHaveValue('survives hot reload');

  const notePath = path.join(interfaceProject, 'note.md');
  await writeFile(notePath, '# Canonical Markdown\n\nEditable in Workstation.\n', 'utf8');
  await writeFile(candidate, `
    import React from 'react';
    import { Page, FileViewer } from '@interpreter/interface';
    export default function App() {
      return <Page><FileViewer path="note.md" minHeight={520} /></Page>;
    }
  `, 'utf8');
  const editorArea = page.locator(sel('editorArea'));
  await expect(page.locator('[data-simple-host-view="file"]')).toBeVisible({ timeout: 15_000 });
  await expect(editorArea).toBeVisible();
  await expect(editorArea).toHaveAttribute('data-file-path', notePath);
  await editorArea.getByRole('button', { name: 'Raw' }).click();
  const rawMarkdown = editorArea.getByRole('textbox');
  await expect(rawMarkdown).toHaveValue(/Canonical Markdown/);
  await rawMarkdown.click();
  await rawMarkdown.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await rawMarkdown.pressSequentially('# Edited inside Simple mode\n\nThis was saved by the canonical Workstation editor.\n');
  await expect(rawMarkdown).toHaveValue(/Edited inside Simple mode/);
  await rawMarkdown.press('Tab');
  await expect.poll(async () => readFile(notePath, 'utf8'), { timeout: 10_000 })
    .toContain('Edited inside Simple mode');

  const nestedPath = path.join(interfaceProject, 'reference.md');
  await writeFile(nestedPath, '# Reference file\n', 'utf8');
  await writeFile(candidate, `
    import React from 'react';
    import { FolderViewer, Page, Text, usePersistentState } from '@interpreter/interface';
    export default function App() {
      const [opened, setOpened] = usePersistentState('opened-from-folder', '');
      return <Page><Text>{opened ? 'Opened: ' + opened : 'Choose a file'}</Text><FolderViewer path="." minHeight={520} onOpen={setOpened} /></Page>;
    }
  `, 'utf8');
  canvas = await waitForInterfaceFrame(page, async (frame) =>
    await frame.getByText(`Opened: ${nestedPath}`).count() > 0 || await frame.getByText('Choose a file').count() > 0);
  await expect(page.locator('[data-simple-host-view="folder"]')).toBeVisible({ timeout: 15_000 });
  const fileTreeEntry = page.locator(sel.fileEntryByName('reference.md'));
  await expect(fileTreeEntry).toBeVisible({ timeout: 10_000 });
  await fileTreeEntry.dblclick();
  await expect(canvas.getByText(`Opened: ${nestedPath}`)).toBeVisible({ timeout: 10_000 });

  await writeFile(candidate, makeApp('Recovered canvas'), 'utf8');
  canvas = await waitForInterfaceFrame(page, async (frame) =>
    await frame.getByRole('heading', { name: 'Recovered canvas' }).isVisible());
  await expect(canvas.getByRole('heading', { name: 'Recovered canvas' })).toBeVisible({ timeout: 15_000 });
  await expect(canvas.getByRole('textbox', { name: 'Persistent note' })).toHaveValue('survives hot reload');

  await page.getByRole('button', { name: 'Open Settings' }).click();
  await expect(page.getByRole('heading', { name: 'GPT Live' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'WhatsApp' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add or manage models' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New interface' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open folder' })).toBeVisible();
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
  canvas = await waitForInterfaceFrame(page, async (frame) =>
    await frame.getByRole('heading', { name: 'Recovered canvas' }).isVisible());
  await expect(canvas.getByRole('heading', { name: 'Recovered canvas' })).toBeVisible();
});

test('Simple first run skips the old tour and includes connections plus the control folder', async ({ page }) => {
  test.setTimeout(60_000);
  const original = await onboardingState(page);
  try {
    await setOnboardingState(page, {
      ...createDefaultOnboardingState(),
      completed: false,
      completedStepIds: ['name', 'privacy', 'model-setup', 'model-review', 'model-credits'],
    });
    await reloadAndWaitForPageLoadSignals(page);
    await waitForUiStability(page);

    await expect(page.getByRole('heading', { name: 'Talk or message from anywhere' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'GPT Live' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'WhatsApp' })).toBeVisible();
    await expect(page.locator('video')).toHaveCount(0);
    await expect(page.getByText('More coming soon')).toHaveCount(0);

    await setOnboardingState(page, {
      ...createDefaultOnboardingState(),
      completed: false,
      completedStepIds: ['name', 'privacy', 'model-setup', 'model-review', 'model-credits', 'stay-connected'],
    });
    await reloadAndWaitForPageLoadSignals(page);
    await waitForUiStability(page);
    await expect(page.getByRole('heading', { name: 'Choose where Interpreter works' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Interface projects stay in their own folders beside it/)).toBeVisible();
  } finally {
    await setOnboardingState(page, original);
    await reloadAndWaitForPageLoadSignals(page).catch(() => {});
  }
});
