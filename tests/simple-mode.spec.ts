import { expect, type Frame, type Page } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from './fixtures';
import { reloadAndWaitForPageLoadSignals, waitForAppReady, waitForUiStability } from './helpers';
import { sel } from './selectors';
import { createDefaultOnboardingState, type OnboardingState } from '../shared/types/onboardingState';

let root: string | null = null;
test.afterAll(async () => { if (root) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

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
    const frames = await page.locator('iframe[data-simple-interface-frame]').all();
    for (const element of frames.reverse()) {
      const frame = await (await element.elementHandle())?.contentFrame().catch(() => null);
      if (!frame) continue;
      if (await predicate(frame).catch(() => false)) {
        active = frame;
        return true;
      }
    }
    return false;
  }, { timeout: 60_000 }).toBe(true);
  if (!active) throw new Error('The active Simple interface frame did not appear.');
  return active;
}

test('the app main frame proxies channel mutations without granting opaque web origins access', async ({ page }) => {
  await waitForAppReady(page);
  const response = await page.evaluate(async () => (window as any).electron.apiRequest({
    method: 'PUT', path: '/api/servers/whatsapp/thread-binding', body: { threadId: '../not-a-thread' },
  }));
  // Invalid input reaches normal validation via the registered main-frame IPC
  // proxy. A direct browser request with Origin:null is rejected (server test).
  expect(response.status).toBe(400);
});

test('Simple Feedback remains reachable when hidden and its visibility survives a renderer reload', async ({ page }) => {
  test.setTimeout(90_000); // Renderer reload can exceed the suite default on a constrained host.
  await waitForAppReady(page);
  await expect(page.locator('[data-simple-shell]')).toBeVisible();
  await page.getByRole('button', { name: 'Open Settings' }).click();
  const toggle = page.getByRole('switch', { name: 'Show Feedback button' });
  await expect(toggle).toBeVisible();
  if (await toggle.getAttribute('aria-checked') === 'false') await toggle.click();
  await expect(page.getByTestId('feedback-button')).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('feedback-button')).toHaveCount(0);

  await page.getByRole('button', { name: 'Leave Feedback' }).click();
  await expect(page.getByTestId('feedback-popover')).toBeVisible();
  await reloadAndWaitForPageLoadSignals(page);
  await waitForAppReady(page);
  await expect(page.getByTestId('feedback-button')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open Settings' }).click();
  const restoredToggle = page.getByRole('switch', { name: 'Show Feedback button' });
  await expect(restoredToggle).toHaveAttribute('aria-checked', 'false');
  await restoredToggle.click();
  await expect(page.getByTestId('feedback-button')).toBeVisible();
});

test('Simple React interface is default, preserves live state, exposes its settings, and switches reversibly to Advanced', async ({ page }) => {
  test.setTimeout(240_000); // The first Next project install/start can take over a minute.
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
  // A previous test can leave an in-flight project watcher build on the shared
  // Electron instance. Promote the complete file, not an older transient build.
  await expect.poll(async () => {
    const result = await page.evaluate(async () => (window as any).electron.apiRequest({
      method: 'POST', path: '/api/simple-interface/promote',
    }));
    return result.ok && result.data?.ready && result.data?.diagnostic === null;
  }, { timeout: 90_000 }).toBe(true);
  // Revisions cross-fade through two briefly overlapping frames; the last
  // frame is always the newly promoted interface.
  let canvas = await waitForInterfaceFrame(page, async (frame) =>
    await frame.getByRole('heading', { name: 'A live React canvas' }).isVisible());
  await expect(canvas.getByRole('heading', { name: 'A live React canvas' })).toBeVisible({ timeout: 15000 });
  const persistentNote = canvas.getByRole('textbox', { name: 'Persistent note' });
  await expect.poll(async () => {
    await persistentNote.fill('');
    await persistentNote.fill('survives hot reload');
    const result = await page.evaluate(async () => (window as any).electron.apiRequest({
      method: 'GET', path: '/api/simple-interface/app/state',
    }));
    return result.data?.['acceptance-note'];
  }, { timeout: 60_000 }).toBe('survives hot reload');

  // Next owns compilation diagnostics; exercise a valid hot edit without
  // depending on the deleted custom compiler's diagnostics.json contract.
  await writeFile(candidate, makeApp('Recovered canvas'), 'utf8');
  // A reload is a supported Next refresh outcome and exercises bridge state
  // restoration even when this headless Electron host does not receive HMR.
  await canvas.goto(canvas.url());
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
  await rawMarkdown.fill('# Edited inside Simple mode\n\nThis was saved by the canonical Workstation editor.\n');
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
  // The live folder viewer replaces virtualized rows during filesystem
  // refreshes. Aim a real double-click at the visible row's current bounds;
  // Playwright's locator action otherwise retries its scroll phase whenever
  // that row is recycled before the click can be dispatched.
  await fileTreeEntry.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  // Scrolling can recycle the very row that initiated it; reacquire it after
  // the scroll instead of measuring a detached (zero-rect) DOM node.
  const treeEntryRect = await fileTreeEntry.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  const clickPoint = { x: treeEntryRect.x + Math.min(48, treeEntryRect.width / 2), y: treeEntryRect.y + treeEntryRect.height / 2 };
  const hitName = await page.evaluate(({ x, y }) =>
    document.elementFromPoint(x, y)?.closest('[role="treeitem"]')?.getAttribute('data-name'), clickPoint);
  expect(hitName, `Folder viewer row is not hit-testable at ${JSON.stringify(clickPoint)}`).toBe('reference.md');
  await page.mouse.dblclick(clickPoint.x, clickPoint.y);
  await expect(canvas.getByText(`Opened: ${nestedPath}`)).toBeVisible({ timeout: 10_000 });

  await writeFile(candidate, makeApp('Recovered canvas'), 'utf8');
  canvas = await waitForInterfaceFrame(page, async (frame) =>
    await frame.getByRole('heading', { name: 'Recovered canvas' }).isVisible());
  await expect(canvas.getByRole('heading', { name: 'Recovered canvas' })).toBeVisible({ timeout: 15_000 });
  await expect(canvas.getByRole('textbox', { name: 'Persistent note' })).toHaveValue('survives hot reload');

  await page.getByRole('button', { name: 'Open Settings' }).click();
  await expect(page.getByRole('heading', { name: 'GPT Live' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'WhatsApp' })).toBeVisible();
  await expect(page.getByRole('radiogroup', { name: 'Appearance' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add or manage models' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New interface' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open folder' })).toBeVisible();
  await page.getByRole('group', { name: 'Experience' }).getByRole('button', { name: 'Advanced' }).click();
  await expect(page.locator('.app-workspace-shell')).toBeVisible();
  await page.evaluate(() => (window as any).__layoutContext?.openSettings?.());
  await expect(page.locator(sel('settingsView'))).toBeVisible();
  // Keyboard activation remains dependable while the legacy pane animates,
  // whereas a forced pointer click can land on a moving target without acting.
  const simpleModeButton = page.getByRole('group', { name: 'Experience' }).getByRole('button', { name: 'Simple' });
  await simpleModeButton.focus();
  await simpleModeButton.press('Enter');
  await expect(page.locator('[data-simple-shell]')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Back to interface' }).click();
  canvas = await waitForInterfaceFrame(page, async (frame) =>
    await frame.getByRole('heading', { name: 'Recovered canvas' }).isVisible());
  await expect(canvas.getByRole('heading', { name: 'Recovered canvas' })).toBeVisible();
});

test('generated React forms submit into durable project state without opening a network form route', async ({ page }) => {
  test.setTimeout(120_000);
  await waitForAppReady(page);
  const sandboxRoot = await mkdtemp(path.join(tmpdir(), 'interpreter-simple-form-'));
  const project = path.join(sandboxRoot, 'tasks');
  try {
    const control = path.join(sandboxRoot, 'control');
    await mkdir(control);
    await mkdir(project);
    await page.evaluate(async (workspacePath) => (window as any).electron.workspace.setSimple({ workspacePath }), control);
    const created = await page.evaluate(async (folder) => (window as any).electron.apiRequest({
      method: 'POST', path: '/api/simple-interface/projects/new', body: { path: folder },
    }), project);
    expect(created.ok).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new Event('simple-project:changed')));
    await writeFile(path.join(project, 'src', 'App.jsx'), `
      import React from 'react';
      import { Page, usePersistentState } from '@interpreter/interface';
      export default function App() {
        const [tasks, setTasks] = usePersistentState('acceptance-tasks', []);
        const [draft, setDraft] = usePersistentState('acceptance-draft', '');
        return <Page><form onSubmit={(event) => {
          event.preventDefault();
          setTasks((current) => [...current, draft]);
          setDraft('');
        }}><input aria-label="New task" required value={draft} onChange={(event) => setDraft(event.target.value)} />
        <button type="submit">Save task</button></form>
        <p>Saved tasks: {tasks.join(', ')}</p></Page>;
      }
    `, 'utf8');
    const promoted = await page.evaluate(async () => (window as any).electron.apiRequest({
      method: 'POST', path: '/api/simple-interface/promote',
    }));
    expect(promoted.ok).toBe(true);
    expect(promoted.data.ready).toBe(true);
    const canvas = await waitForInterfaceFrame(page, async (frame) =>
      await frame.getByRole('button', { name: 'Save task' }).isVisible());
    await expect(page.locator('iframe[data-simple-interface-frame]').last()).toHaveAttribute('sandbox', /allow-forms/);
    const formNavigations: string[] = [];
    page.on('request', (request) => {
      if (request.isNavigationRequest() && request.method() === 'POST') formNavigations.push(request.url());
    });
    const taskInput = canvas.getByRole('textbox', { name: 'New task' });
    // A visible Next page can still be hydrating. Wait for its controlled
    // onChange handler to persist the draft before submitting the form.
    await expect.poll(async () => {
      await taskInput.fill('');
      await taskInput.fill('Plan the next sprint');
      const state = JSON.parse(await readFile(path.join(project, '.interpreter', 'state.json'), 'utf8').catch(() => '{}'));
      return state['acceptance-draft'];
    }, { timeout: 60_000 }).toBe('Plan the next sprint');
    // Activate within the frame: another native project window can cover the
    // fixture window even when Playwright sees this frame as pointer-actionable.
    await canvas.getByRole('button', { name: 'Save task' }).evaluate((button) => (button as HTMLButtonElement).click());
    await expect(canvas.getByText('Saved tasks: Plan the next sprint')).toBeVisible();
    await expect(canvas.getByRole('textbox', { name: 'New task' })).toHaveValue('');
    await expect.poll(async () => {
      const state = JSON.parse(await readFile(path.join(project, '.interpreter', 'state.json'), 'utf8'));
      return state['acceptance-tasks'];
    }).toEqual(['Plan the next sprint']);
    expect(formNavigations).toEqual([]);
  } finally {
    (page as any).__testErrorControl?.pauseErrorChecking();
    const stopped = await page.evaluate(async (folder) =>
      await (window as any).electron.projectRunner.stop(folder), project);
    expect(stopped.success).toBe(true);
    // Next's dev watcher may still be writing its build directory as the
    // fixture is removed. fs.rm retries transient ENOTEMPTY races here.
    await rm(sandboxRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

test('Simple first run offers Chrome and optional WhatsApp without Advanced setup or a voice gate', async ({ page }) => {
  test.setTimeout(60_000);
  const original = await onboardingState(page);
  try {
    await setOnboardingState(page, {
      ...createDefaultOnboardingState(),
      completed: false,
      completedStepIds: ['name', 'privacy'],
    });
    await reloadAndWaitForPageLoadSignals(page);
    await waitForUiStability(page);

    await expect(page.getByRole('heading', { name: 'Connect Interpreter to Chrome' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Get the Chrome extension' })).toBeVisible();
    // An isolated first-run machine may not have the optional browser bridge
    // available yet. The step must still offer installation and recovery.
    await expect(page.locator('p[role="status"]')).toContainText(
      /Chrome is (not connected yet|connected)|Could not check Chrome connection/,
      { timeout: 15_000 },
    );
    await expect(page.getByRole('button', { name: 'Check again' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Your existing connections' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'WhatsApp' })).toHaveCount(0);
    await expect(page.locator('video')).toHaveCount(0);

    // The ten built-in tool servers are not configured MCP connections. On a
    // clean profile Chrome should lead straight to model selection.
    await page.getByRole('button', { name: 'Next step' }).click();
    await expect(page.getByRole('heading', { name: 'Models', exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Your existing connections' })).toHaveCount(0);

    await setOnboardingState(page, {
      ...createDefaultOnboardingState(),
      completed: false,
      completedStepIds: ['name', 'privacy', 'tool-addons', 'simple-mcp', 'model-setup', 'model-review', 'model-credits'],
    });
    await reloadAndWaitForPageLoadSignals(page);
    await waitForUiStability(page);
    await expect(page.getByRole('heading', { name: 'Connect WhatsApp' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Pair WhatsApp' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Talk to Interpreter' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Choose where Interpreter works' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Private connection' })).toHaveCount(0);
    await expect(page.locator('video')).toHaveCount(0);
    await expect(page.getByText('More coming soon')).toHaveCount(0);

  } finally {
    await setOnboardingState(page, original);
    await reloadAndWaitForPageLoadSignals(page).catch(() => {});
  }
});
