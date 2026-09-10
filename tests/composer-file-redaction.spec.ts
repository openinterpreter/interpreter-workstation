import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { test, expect, pauseErrorChecking, resumeErrorChecking } from './fixtures';
import {
  apiCall,
  clearUserConfig,
  deleteProfile,
  getTestWorkspace,
  setWorkspace,
  waitForAppReady,
} from './helpers';
import { sel } from './selectors';
import type { StreamRequestBody } from '../src/lib/codex/api-types';

const PROBE_EMAIL = 'john@example.com';
const PASTE_TEXT = `Contact details\nReach ${PROBE_EMAIL} for the report`;
// The notice and toast copy is locale-dependent (the app follows the system
// language); match the English and French wordings.
const NOTICE_TEXT = /Files will be redacted|pseudonymis/;
const UNAVAILABLE_TEXT = /Attachment redaction is unavailable|pièces jointes indisponible/;

function buildSse(events: Array<{ event: string; payload: unknown }>): string {
  return events
    .map(({ event, payload }) => `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
    .join('');
}

function writeOpenRouterReasoningModelCache(): void {
  const configDir = path.join(os.homedir(), '.interpreter');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'openrouter-models.json'),
    JSON.stringify(
      {
        fetchedAt: Date.now(),
        models: [
          {
            id: 'openai/gpt-5.4',
            name: 'GPT-5.4',
            provider: 'openai',
            description: 'Flagship reasoning model',
            contextLength: 400000,
            supportedReasoningEfforts: ['low', 'medium', 'high'],
            defaultReasoningEffort: 'medium',
          },
        ],
      },
      null,
      2,
    ),
    'utf-8',
  );
}

async function createHostedProfile(page: import('@playwright/test').Page, profile: {
  id: string;
  name: string;
  modelId: string;
}) {
  const response = await apiCall(page, 'POST', '/api/profiles', {
    id: profile.id,
    name: profile.name,
    modelId: profile.modelId,
    isBuiltin: false,
    provider: 'hosted',
    providerId: 'builtin:hosted',
  });
  expect(response.ok).toBe(true);
}

async function pasteProbeAsChip(page: import('@playwright/test').Page): Promise<void> {
  // Drive the production paste handler with a synthetic clipboard payload.
  // (navigator.clipboard is permission-gated in the test shell.)
  const composer = page.locator(sel.activeComposer());
  await composer.click();
  // Runtime constraint: the synthetic paste is dispatched at the ProseMirror
  // view, which only handles it once focus has settled after the click.
  await page.waitForTimeout(300);
  await page.evaluate((text) => {
    const editor = document.querySelector('.main-composer-editor')
      ?? document.querySelector('.ProseMirror');
    if (!editor) {
      throw new Error('composer editor not found for synthetic paste');
    }
    (editor as HTMLElement).focus();
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', text);
    editor.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: dataTransfer,
    }));
  }, PASTE_TEXT);
}

test.describe('Composer file redaction', () => {
  test('pasted PII attachment shows the notice and never reaches the model raw', async ({ page }) => {
    // NER availability varies by machine (basemind models may or may not be
    // cached). The send path is branch-tolerant by design: tokenized send
    // when NER answers, blocked send with a toast when it does not. Either
    // branch proves raw PII never reaches the model.
    test.setTimeout(90000);

    const threadId = randomUUID();
    const profileId = `file-redaction-${Date.now()}`;
    const profileName = `File Redaction ${Date.now()}`;
    try {
      writeOpenRouterReasoningModelCache();
      await clearUserConfig(page);
      await waitForAppReady(page);
      await setWorkspace(page, getTestWorkspace());
      await createHostedProfile(page, {
        id: profileId,
        name: profileName,
        modelId: 'openai/gpt-5.4',
      });

      const streamRequests: StreamRequestBody[] = [];
      await page.route('**/api/agent/chat/stream**', async (route) => {
        streamRequests.push(route.request().postDataJSON() as StreamRequestBody);
        const responseText = streamRequests.length === 1
          ? 'First stub response'
          : 'Second stub response';
        await route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
          body: buildSse([
            { event: 'thread', payload: { threadId } },
            { event: 'delta', payload: { text: responseText } },
          ]),
        });
      });

      const settingsButton = page.locator(sel('agentSettingsButton'));
      await settingsButton.click();
      const popover = page.locator(sel('settingsPopover'));
      await expect(popover).toBeVisible({ timeout: 5000 });
      await popover.getByText(profileName, { exact: true }).click();
      await expect(popover).toBeHidden({ timeout: 5000 });

      const composer = page.locator(sel.activeComposer());
      await composer.click();
      await page.keyboard.type('Hello before attach.', { delay: 10 });
      await page.keyboard.press('Enter');

      const thread = page.locator(sel.activeAgentThread());
      await expect(thread.getByText('First stub response')).toBeVisible({ timeout: 15000 });
      await expect(thread.getByText('Something went wrong')).toHaveCount(0);
      // Profile selection verified: the first turn rode the hosted profile.
      expect(streamRequests.length).toBeGreaterThan(0);
      expect(streamRequests[0].profileId).toBe(profileId);

      await pasteProbeAsChip(page);

      await expect(page.locator(sel('composerAttachmentChip')).first()).toBeVisible({ timeout: 5000 });
      await expect(page.getByText(NOTICE_TEXT).first()).toBeVisible({ timeout: 5000 });

      // The fail-closed toast logs a UI error by design; pause the console
      // guard for the send window and resume before cleanup.
      pauseErrorChecking(page);
      await page.keyboard.press('Enter');

      const requestsBeforeAttach = streamRequests.length;
      const outcome = await Promise.race([
        thread.getByText('Second stub response').waitFor({ timeout: 60000 }).then(() => 'sent' as const),
        page.getByText(UNAVAILABLE_TEXT).waitFor({ timeout: 60000 }).then(() => 'blocked' as const),
      ]);
      // eslint-disable-next-line no-console
      console.log(`[file-redaction-e2e] send outcome: ${outcome}`);

      if (outcome === 'sent') {
        expect(streamRequests.length).toBeGreaterThan(requestsBeforeAttach);
        const lastMessage = streamRequests[streamRequests.length - 1].message ?? '';
        expect(lastMessage).toMatch(/\[EMAIL_\d+\]/);
        expect(lastMessage).not.toContain(PROBE_EMAIL);
        await expect(thread.getByText('Something went wrong')).toHaveCount(0);
      } else {
        expect(streamRequests.length).toBe(requestsBeforeAttach);
      }
    } finally {
      resumeErrorChecking(page);
      await deleteProfile(page, profileId).catch(() => {});
    }
  });
});
