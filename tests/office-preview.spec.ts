import path from 'node:path';
import { expect, test } from './fixtures';
import {
  getTestWorkspace,
  setWorkspace,
  waitForResponseWithErrorCheck,
  waitForAppReady,
  waitForFileTreeLoaded,
} from './helpers';
import { sel } from './selectors';

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
    const preview = page.locator(sel('officeReadOnlyPreview'));
    await expect(preview).toBeVisible({ timeout: 15000 });
    await expect.poll(async () => preview.evaluate((host, expectedText: string) => {
      const viewer = host.shadowRoot;
      return viewer?.textContent?.includes(expectedText) ?? false;
    }, officeCase.expectedText), { timeout: 15000 }).toBe(true);
  });
}
