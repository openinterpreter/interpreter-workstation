import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import {
  getTestWorkspace,
  setWorkspace,
  waitForResponseWithErrorCheck,
  waitForAppReady,
  waitForFileTreeLoaded,
} from './helpers';
import { sel } from './selectors';

type OfficeAssetAudit = {
  requests: Set<string>;
  externalRequests: Set<string>;
};

function isLocalViewerUrl(url: string): boolean {
  if (/^(?:file|app|blob|data):/i.test(url)) {
    return true;
  }

  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
  } catch {
    return true;
  }
}

function isOfficeViewerAssetUrl(url: string): boolean {
  const normalized = url.toLowerCase();
  return [
    'file-viewer',
    'docx-preview',
    'pptx.worker',
    'sheet.worker',
    'vendor/docx',
    'vendor/pptx',
    'vendor/xlsx',
    'vendor/ppt/',
    'ppt-native',
    'ppt-font-cjk',
  ].some((marker) => normalized.includes(marker));
}

async function installOfficeAssetAudit(page: Page): Promise<OfficeAssetAudit> {
  const audit: OfficeAssetAudit = {
    requests: new Set(),
    externalRequests: new Set(),
  };

  page.on('request', (request) => {
    const url = request.url();
    if (!isOfficeViewerAssetUrl(url)) return;

    audit.requests.add(url);
    if (!isLocalViewerUrl(url)) {
      audit.externalRequests.add(url);
    }
  });

  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (isOfficeViewerAssetUrl(url) && !isLocalViewerUrl(url)) {
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });

  return audit;
}

async function getOfficeViewerDiagnostics(page: Page) {
  const outerSelector = sel('officeExtensionViewer');
  const previewSelector = sel('officeReadOnlyPreview');

  return page.evaluate(({ outerSelector: outerQuery, previewSelector: previewQuery }) => {
    const outer = document.querySelector<HTMLElement>(outerQuery);
    const preview = document.querySelector<HTMLElement>(previewQuery);
    const previewRoot = preview?.shadowRoot;

    return {
      outerState: outer?.getAttribute('data-office-viewer-state') ?? 'missing',
      outerReady: outer?.getAttribute('data-office-viewer-ready') ?? null,
      outerText: outer?.innerText.slice(0, 300) ?? '',
      previewState: preview?.getAttribute('data-office-viewer-state') ?? 'missing',
      previewReady: preview?.getAttribute('data-office-viewer-ready') ?? null,
      previewText: previewRoot?.textContent?.slice(0, 2000) ?? preview?.textContent?.slice(0, 2000) ?? '',
      previewHtml: previewRoot?.innerHTML.slice(0, 1200) ?? preview?.innerHTML.slice(0, 1200) ?? '',
    };
  }, { outerSelector, previewSelector });
}

const OFFICE_PREVIEW_CASES = [
  {
    filename: 'sample-report.docx',
    expectedText: 'Order Summary Report',
  },
  {
    filename: path.join('office-docs', 'Expense_Tracker.xlsx'),
    expectedText: 'MONTHLY EXPENSE TRACKER',
  },
  {
    filename: path.join('office-docs', 'Sample_Presentation.pptx'),
    expectedText: 'Welcome to Sample Presentation',
  },
] as const;

function buildSse(events: Array<{ event: string; payload: unknown }>): string {
  return events
    .map(({ event, payload }) => `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
    .join('');
}

for (const officeCase of OFFICE_PREVIEW_CASES) {
  test(`office preview: clicking a response file pill opens ${officeCase.filename} locally`, async ({ page }) => {
    const workspace = getTestWorkspace();
    const filePath = path.join(workspace, officeCase.filename);
    const displayName = path.basename(officeCase.filename);
    const responseText = `Here is the document: [${displayName}](${filePath})`;
    const threadId = `office-preview-${displayName.replace(/[^a-z0-9]+/gi, '-')}`;
    let latestPrompt = '';

    await waitForAppReady(page);
    await setWorkspace(page, workspace);
    await waitForFileTreeLoaded(page);
    const assetAudit = await installOfficeAssetAudit(page);

    await page.route('**/api/agent/chat/stream**', async (route) => {
      const request = route.request().postDataJSON() as { message?: string } | undefined;
      latestPrompt = typeof request?.message === 'string' ? request.message : '';
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        body: buildSse([
          { event: 'thread', payload: { threadId } },
          { event: 'delta', payload: { text: responseText } },
        ]),
      });
    });
    await page.route(`**/api/agent/threads/${threadId}**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          thread: {
            id: threadId,
            preview: responseText,
            createdAt: Date.now() - 1000,
            updatedAt: Date.now(),
            turns: [{
              id: `${threadId}-turn-1`,
              status: 'completed',
              items: [
                {
                  type: 'userMessage',
                  id: `${threadId}-user-1`,
                  content: [{ type: 'text', text: latestPrompt, text_elements: [] }],
                },
                {
                  type: 'agentMessage',
                  id: `${threadId}-assistant-1`,
                  text: responseText,
                  phase: 'final_answer',
                },
              ],
            }],
          },
        }),
      });
    });

    const composer = page.locator(sel('mainComposerInput')).first();
    await composer.fill(`Open ${displayName}`);
    await page.keyboard.press('Enter');

    const thread = page.locator(sel.activeAgentThread());
    await waitForResponseWithErrorCheck(page, page.locator(sel('typingIndicator')), thread, 15000);

    const filePill = thread.getByText(displayName, { exact: true }).last();
    await expect(filePill).toBeVisible({ timeout: 15000 });
    await filePill.click();

    await expect(page.locator(sel('editorArea'))).toHaveAttribute('data-file-path', filePath);
    try {
      await expect(page.locator(sel.officeViewerReady())).toBeVisible({ timeout: 15000 });
    } catch (error) {
      console.log(`[OfficePreview] viewer diagnostics: ${JSON.stringify(await getOfficeViewerDiagnostics(page))}`);
      throw error;
    }
    const preview = page.locator(sel.officeReadOnlyPreviewState('ready'));
    await expect(preview).toBeVisible({ timeout: 15000 });
    await expect.poll(async () => preview.evaluate((host) => {
      const viewer = host.shadowRoot;
      return viewer?.textContent ?? host.textContent ?? '';
    }), { timeout: 15000 }).toContain(officeCase.expectedText);

    expect([...assetAudit.externalRequests]).toEqual([]);
    expect([...assetAudit.requests].filter((url) => /(?:ppt-native|ppt-font-cjk|vendor\/ppt\/)/i.test(url))).toEqual([]);
  });
}

test('office preview: exposes a recoverable error when a response file cannot be read', async ({ page }) => {
  const workspace = getTestWorkspace();
  const filePath = path.join(workspace, 'office-docs', 'missing.docx');
  const displayName = path.basename(filePath);
  const responseText = `Here is the document: [${displayName}](${filePath})`;
  const threadId = 'office-preview-missing-file';
  let latestPrompt = '';

  await waitForAppReady(page);
  await setWorkspace(page, workspace);
  await waitForFileTreeLoaded(page);
  await installOfficeAssetAudit(page);

  await page.route('**/api/agent/chat/stream**', async (route) => {
    const request = route.request().postDataJSON() as { message?: string } | undefined;
    latestPrompt = typeof request?.message === 'string' ? request.message : '';
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: buildSse([
        { event: 'thread', payload: { threadId } },
        { event: 'delta', payload: { text: responseText } },
      ]),
    });
  });
  await page.route(`**/api/agent/threads/${threadId}**`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        thread: {
          id: threadId,
          preview: responseText,
          createdAt: Date.now() - 1000,
          updatedAt: Date.now(),
          turns: [{
            id: `${threadId}-turn-1`,
            status: 'completed',
            items: [
              {
                type: 'userMessage',
                id: `${threadId}-user-1`,
                content: [{ type: 'text', text: latestPrompt, text_elements: [] }],
              },
              {
                type: 'agentMessage',
                id: `${threadId}-assistant-1`,
                text: responseText,
                phase: 'final_answer',
              },
            ],
          }],
        },
      }),
    });
  });

  const composer = page.locator(sel('mainComposerInput')).first();
  await composer.fill(`Open ${displayName}`);
  await page.keyboard.press('Enter');

  const thread = page.locator(sel.activeAgentThread());
  await waitForResponseWithErrorCheck(page, page.locator(sel('typingIndicator')), thread, 15000);

  const filePill = thread.getByText(displayName, { exact: true }).last();
  await expect(filePill).toBeVisible({ timeout: 15000 });
  await filePill.click();

  await expect(page.locator(sel('editorArea'))).toHaveAttribute('data-file-path', filePath);
  const errorViewer = page.locator(sel.officeViewerError());
  await expect(errorViewer).toBeVisible({ timeout: 15000 });
  await expect(errorViewer).toHaveAttribute('data-office-viewer-state', 'error');
  await expect(errorViewer).toHaveAttribute('data-office-viewer-ready', 'false');
  await expect(errorViewer).toContainText('Unable to preview this file');
});
