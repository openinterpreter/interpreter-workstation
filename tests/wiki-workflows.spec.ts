import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';

import type { ElectronApplication, Page } from '@playwright/test';
import { test, expect, withSetupPhase } from './fixtures';
import {
  apiCall,
  setWorkspace,
  setupPageLogging,
  waitForAppReady,
  waitForFileTreeLoaded,
  waitForResponseWithErrorCheck,
} from './helpers';
import { sel } from './selectors';
import { buildSse } from './voice-test-utils';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WIKI_FIXTURE_DIR = path.join(__dirname, 'fixtures', 'wiki-workspace-template');
const LLM_WIKI_DOC_PATH = path.join(__dirname, '..', 'docs', 'llm-wiki.md');

function formatDate(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(date: Date, deltaDays: number): Date {
  const nextDate = new Date(date);
  nextDate.setDate(nextDate.getDate() + deltaDays);
  return nextDate;
}

function createFreshWikiWorkspace(): {
  workspacePath: string;
  todayLabel: string;
  yesterdayLabel: string;
  indexPath: string;
  persistentWikiPath: string;
  rawSourcePath: string;
} {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'interpreter-wiki-e2e-'));
  fs.cpSync(WIKI_FIXTURE_DIR, workspacePath, { recursive: true });

  const rawSourcePath = path.join(workspacePath, 'raw', 'llm-wiki.md');
  fs.copyFileSync(LLM_WIKI_DOC_PATH, rawSourcePath);

  const today = new Date();
  const yesterday = addDays(today, -1);
  const todayLabel = formatDate(today);
  const yesterdayLabel = formatDate(yesterday);
  const yesterdayPath = path.join(workspacePath, 'daily', `${yesterdayLabel}.md`);
  fs.writeFileSync(
    yesterdayPath,
    `# ${yesterdayLabel}

## Tasks

- [x] Seed the wiki fixture

## Notes

## Journal
`,
    'utf-8',
  );

  return {
    workspacePath,
    todayLabel,
    yesterdayLabel,
    indexPath: path.join(workspacePath, 'index.md'),
    persistentWikiPath: path.join(workspacePath, 'wiki', 'concepts', 'persistent-wiki.md'),
    rawSourcePath,
  };
}

async function openMarkdownFile(page: Page, filePath: string): Promise<void> {
  await page.evaluate((targetPath: string) => {
    (window as typeof window & {
      __layoutContext?: {
        openFile: (path: string) => void;
      };
    }).__layoutContext?.openFile(targetPath);
  }, filePath);
  await page.waitForTimeout(800);
}

async function expectEditorFile(page: Page, filePath: string): Promise<void> {
  await expect
    .poll(
      () => page.locator(sel('editorArea')).evaluateAll(
        (nodes, expectedFilePath) => nodes.some((node) => node.getAttribute('data-file-path') === expectedFilePath),
        filePath,
      ),
      { timeout: 10000 },
    )
    .toBe(true);
}

async function editorTextForFile(page: Page, filePath: string): Promise<string> {
  return page.locator(sel('editorArea')).evaluateAll(
    (nodes, expectedFilePath) => {
      const editorNode = nodes.find((node) => node.getAttribute('data-file-path') === expectedFilePath);
      return editorNode?.textContent ?? '';
    },
    filePath,
  );
}

async function blurActiveElement(page: Page): Promise<void> {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
  });
  await page.waitForTimeout(100);
}

async function getWindowId(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    return (window as typeof window & {
      electron?: {
        getWindowId?: () => number | null;
      };
    }).electron?.getWindowId?.() ?? null;
  });
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

test.describe('Wiki workflows', () => {
  let wikiWorkspace: ReturnType<typeof createFreshWikiWorkspace>;
  const workspacesToCleanup: string[] = [];

  test.beforeEach(async ({ page }) => {
    setupPageLogging(page, 'WikiWorkflows');
    wikiWorkspace = createFreshWikiWorkspace();
    workspacesToCleanup.push(wikiWorkspace.workspacePath);
    await withSetupPhase(page, async () => {
      await waitForAppReady(page);
      await setWorkspace(page, wikiWorkspace.workspacePath);
      await page.waitForTimeout(800);
      await waitForFileTreeLoaded(page);
    }, 1000);
  });

  test.afterAll(async () => {
    for (const workspacePath of workspacesToCleanup.splice(0)) {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  test('classifies wiki workspaces and sends the seeded Ask my wiki prompt through chat', async ({ page }) => {
    test.setTimeout(90000);

    const workspaceType = await apiCall(page, 'GET', '/api/workspace/type');
    expect(workspaceType.ok).toBe(true);
    expect(workspaceType.data).toMatchObject({
      kind: 'wiki',
      hasWikiStructure: true,
      hasIndexMd: true,
      hasLogMd: true,
    });

    const threadId = randomUUID();
    const streamRequests: string[] = [];
    await page.route('**/api/agent/chat/stream**', async (route) => {
      const request = route.request().postDataJSON() as { message?: string } | undefined;
      streamRequests.push(typeof request?.message === 'string' ? request.message : '');
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        body: buildSse([
          { event: 'thread', payload: { threadId } },
          { event: 'delta', payload: { text: 'Stubbed wiki answer.' } },
        ]),
      });
    });
    await page.route(`**/api/agent/threads/${threadId}**`, async (route) => {
      const latestPrompt = streamRequests.length > 0 ? streamRequests[streamRequests.length - 1]! : '';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          thread: {
            id: threadId,
            preview: 'Stubbed wiki answer.',
            createdAt: Date.now() - 1000,
            updatedAt: Date.now(),
            turns: [
              {
                id: `turn-${threadId}-1`,
                status: 'completed',
                items: [
                  {
                    type: 'userMessage',
                    id: `user-${threadId}-1`,
                    content: [{ type: 'text', text: latestPrompt, text_elements: [] }],
                  },
                  {
                    type: 'agentMessage',
                    id: `assistant-${threadId}-1`,
                    text: 'Stubbed wiki answer.',
                    phase: 'final_answer',
                  },
                ],
              },
            ],
          },
        }),
      });
    });

    await page.locator(sel.suggestionPill('cat:analyze')).click();
    await expect(page.locator(sel.suggestionPill('analyze:ask-wiki'))).toBeVisible({ timeout: 10000 });
    await expect(page.locator(sel.suggestionPill('analyze:check-contradictions'))).toBeVisible({ timeout: 10000 });

    await page.locator(sel.suggestionPill('analyze:ask-wiki')).click();

    const composer = page.locator(sel('mainComposerInput'));
    await expect(composer).toContainText('Read $wiki-maintainer. Read index.md first', { timeout: 10000 });
    await expect(composer).toContainText('([[Page Name]]) citations.', { timeout: 10000 });
    await composer.click();
    await page.keyboard.type('How is this different from RAG?', { delay: 5 });
    await page.keyboard.press('Enter');

    const thread = page.locator(sel.activeAgentThread());
    const typingIndicator = page.locator(sel('typingIndicator'));
    await waitForResponseWithErrorCheck(page, typingIndicator, thread, 15000);

    await expect(thread.getByText('Stubbed wiki answer.')).toBeVisible({ timeout: 15000 });
    expect(streamRequests).toHaveLength(1);
    expect(streamRequests[0]).toContain('Read $wiki-maintainer. Read index.md first');
    expect(streamRequests[0]).toContain('How is this different from RAG?');
  });

  test('Create > Daily Note opens today and links back to yesterday when it exists', async ({ page }) => {
    await page.locator(sel.suggestionPill('cat:create')).click();
    await expect(page.locator(sel.suggestionPill('create:daily-note'))).toBeVisible({ timeout: 10000 });
    await page.locator(sel.suggestionPill('create:daily-note')).click();

    const todayPath = path.join(wikiWorkspace.workspacePath, 'daily', `${wikiWorkspace.todayLabel}.md`);
    await expect
      .poll(() => fs.existsSync(todayPath), { timeout: 10000 })
      .toBe(true);

    const dailyNoteContent = fs.readFileSync(todayPath, 'utf-8');
    expect(dailyNoteContent).toContain(`# ${wikiWorkspace.todayLabel}`);
    expect(dailyNoteContent).toContain(`Previous: [[${wikiWorkspace.yesterdayLabel}]]`);
    expect(dailyNoteContent).toContain('## Tasks');
    expect(dailyNoteContent).toContain('## Journal');

    await expectEditorFile(page, todayPath);
    await expect.poll(() => editorTextForFile(page, todayPath), { timeout: 10000 }).toContain(wikiWorkspace.todayLabel);
    await expect.poll(() => editorTextForFile(page, todayPath), { timeout: 10000 }).toContain(wikiWorkspace.yesterdayLabel);
  });

  test('opens human-readable wikilinks and content-search source notes through quick open', async ({ page, electronApp }) => {
    await openMarkdownFile(page, wikiWorkspace.indexPath);
    await expectEditorFile(page, wikiWorkspace.indexPath);

    const persistentWikiLink = page.locator('[data-wikilink][data-target="Persistent Wiki"]').first();
    await expect(persistentWikiLink).toBeVisible({ timeout: 10000 });
    await persistentWikiLink.click();
    await expectEditorFile(page, wikiWorkspace.persistentWikiPath);

    const frontmatterCard = page.locator(sel('markdownFrontmatterCard'));
    await expect(frontmatterCard).toBeVisible({ timeout: 10000 });
    await expect(frontmatterCard).toContainText('Metadata');
    await expect(frontmatterCard).toContainText('Persistent Wiki');
    await expect(frontmatterCard).toContainText('raw/llm-wiki.md');

    expect(await editorTextForFile(page, wikiWorkspace.persistentWikiPath)).not.toContain('---');

    await triggerMenuShortcut(electronApp, page, 'CmdOrCtrl+K');
    const explorerSearchInput = page.locator(sel('explorerSearchInput'));
    await expect(explorerSearchInput).toBeFocused({ timeout: 10000 });
    await explorerSearchInput.fill('NotebookLM');

    await expect(page.getByText('NotebookLM').first()).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Enter');

    await expectEditorFile(page, wikiWorkspace.rawSourcePath);
    await expect.poll(() => editorTextForFile(page, wikiWorkspace.rawSourcePath), { timeout: 10000 }).toContain('NotebookLM');
  });
});
