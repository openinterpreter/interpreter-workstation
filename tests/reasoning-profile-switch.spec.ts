import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { test, expect, pauseErrorChecking, resumeErrorChecking } from './fixtures';
import {
  apiCall,
  clearUserConfig,
  deleteProfile,
  getActiveCodexThreadId,
  getTestWorkspace,
  reloadAndWaitForPageLoadSignals,
  setWorkspace,
  waitForAppReady,
  waitForResponseWithErrorCheck,
} from './helpers';
import { sel } from './selectors';
import type { StreamRequestBody } from '../src/lib/codex/api-types';

function buildSse(events: Array<{ event: string; payload: unknown }>): string {
  return events
    .map(({ event, payload }) => `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
    .join('');
}

function buildThreadReadResponse(
  threadId: string,
  turns: Array<{ userText: string; assistantText: string }>,
) {
  const now = Date.now();
  const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null;
  return {
    thread: {
      id: threadId,
      preview: lastTurn?.assistantText ?? lastTurn?.userText ?? '',
      createdAt: now - 1_000,
      updatedAt: now,
      turns: turns.map((turn, index) => ({
        id: `turn-${threadId}-${index + 1}`,
        status: 'completed' as const,
        items: [
          {
            type: 'userMessage' as const,
            id: `user-${threadId}-${index + 1}`,
            content: [{ type: 'text' as const, text: turn.userText, text_elements: [] }],
          },
          {
            type: 'agentMessage' as const,
            id: `assistant-${threadId}-${index + 1}`,
            text: turn.assistantText,
            phase: 'final_answer' as const,
          },
        ],
      })),
    },
  };
}

function visibleSliderThumb(page: import('@playwright/test').Page) {
  return page.locator('[data-slot="slider-thumb"]').first();
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
  reasoningEffort?: 'low' | 'medium' | 'high';
}) {
  const response = await apiCall(page, 'POST', '/api/profiles', {
    id: profile.id,
    name: profile.name,
    modelId: profile.modelId,
    isBuiltin: false,
    provider: 'hosted',
    providerId: 'builtin:hosted',
    ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
  });
  expect(response.ok).toBe(true);
}

async function deleteProfiles(page: import('@playwright/test').Page, profileIds: string[]) {
  for (const profileId of profileIds) {
    await deleteProfile(page, profileId);
  }
}

test.describe('Reasoning and profile switching', () => {
  test('settings does not expose hosted profile reasoning defaults', async ({ page }) => {
    test.setTimeout(60000);

    const profileId = `reasoning-default-${Date.now()}`;
    try {
      writeOpenRouterReasoningModelCache();
      await clearUserConfig(page);
      await waitForAppReady(page);
      await createHostedProfile(page, {
        id: profileId,
        name: 'Reasoning Default Test',
        modelId: 'openai/gpt-5.4',
      });

      await page.locator(sel('agentSettingsButton')).click();
      await expect(page.locator(sel('settingsPopover'))).toBeVisible({ timeout: 5000 });
      await page.locator(sel('settingsPopover')).getByText('Settings').click();

      const settingsView = page.locator(sel('settingsView'));
      await expect(settingsView).toBeVisible({ timeout: 10000 });
      await page.locator(sel.settingsTab('models')).click();
      await settingsView.locator(sel.profileCard(profileId)).click();
      await expect(page.locator(sel.profileProviderTab('hosted'))).toBeVisible();

      await expect(page.getByText('Reasoning', { exact: true })).toHaveCount(0);
      await expect(visibleSliderThumb(page)).toHaveCount(0);
    } finally {
      await deleteProfiles(page, [profileId]);
    }
  });

  test('composer keeps the current chat when switching profiles and applies reasoning on the next turn', async ({ page }) => {
    test.setTimeout(60000);

    const threadId = randomUUID();
    const profileA = {
      id: `reasoning-switch-a-${Date.now()}`,
      name: `Reasoning Switch A ${Date.now()}`,
      modelId: 'interpreter-smart',
    };
    const profileB = {
      id: `reasoning-switch-b-${Date.now()}`,
      name: `Reasoning Switch B ${Date.now()}`,
      modelId: 'openai/gpt-5.4',
    };
    try {
      writeOpenRouterReasoningModelCache();
      await clearUserConfig(page);
      await waitForAppReady(page);
      await createHostedProfile(page, profileA);
      await createHostedProfile(page, profileB);

      const streamRequests: StreamRequestBody[] = [];
      await page.route('**/api/agent/chat/stream**', async (route) => {
        const requestBody = route.request().postDataJSON() as StreamRequestBody;
        streamRequests.push(requestBody);

        const responseText = streamRequests.length === 1
          ? 'First stub response'
          : 'Second stub response';

        await new Promise((resolve) => setTimeout(resolve, 200));

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
      const initialTabCount = await page.locator(sel.agentTabAny()).count();

      await settingsButton.click();
      const popover = page.locator(sel('settingsPopover'));
      await expect(popover).toBeVisible({ timeout: 5000 });
      await popover.getByText(profileA.name, { exact: true }).click();
      await expect(popover).toBeHidden({ timeout: 5000 });
      expect(await page.locator(sel.agentTabAny()).count()).toBe(initialTabCount);

      const composer = page.locator(sel.activeComposer());
      await composer.click();
      await page.keyboard.type('First request to create thread.', { delay: 10 });
      await page.keyboard.press('Enter');

      const thread = page.locator(sel.activeAgentThread());
      await expect(thread.getByText('First stub response')).toBeVisible({ timeout: 10000 });
      await expect(thread.getByText('Something went wrong')).toHaveCount(0);
      await expect(page.locator(sel('typingIndicator'))).toBeHidden({ timeout: 10000 });

    await settingsButton.click();
    await expect(popover).toBeVisible({ timeout: 5000 });
    await popover.getByText(profileB.name, { exact: true }).click();

      await expect(popover).toBeHidden({ timeout: 5000 });
      expect(await page.locator(sel.agentTabAny()).count()).toBe(initialTabCount);

    await settingsButton.click();
    await expect(popover).toBeVisible({ timeout: 5000 });

      const settingsFooterButton = popover.getByRole('button', { name: 'Settings' });
      await expect(settingsFooterButton).toBeVisible({ timeout: 5000 });
      await expect(popover.getByText('Reasoning', { exact: true })).toBeVisible({ timeout: 5000 });
      const settingsBounds = await settingsFooterButton.boundingBox();
      const reasoningBounds = await popover.getByText('Reasoning', { exact: true }).boundingBox();
      expect(settingsBounds).not.toBeNull();
      expect(reasoningBounds).not.toBeNull();
      expect(settingsBounds!.y).toBeLessThan(reasoningBounds!.y);

      const slider = visibleSliderThumb(page);
      await expect(slider).toBeVisible({ timeout: 5000 });
      await slider.focus();
      await page.keyboard.press('End');
      await page.keyboard.press('Escape');
      await expect(popover).toBeHidden({ timeout: 5000 });

      await composer.click();
      await page.keyboard.type('Second request after switching profile.', { delay: 10 });
      await page.keyboard.press('Enter');

      await expect(thread.getByText('Second stub response')).toBeVisible({ timeout: 10000 });
      await expect(thread.getByText('Something went wrong')).toHaveCount(0);
      await expect(page.locator(sel('typingIndicator'))).toBeHidden({ timeout: 10000 });

      expect(streamRequests).toHaveLength(2);
      expect(streamRequests[0]?.profileId).toBe(profileA.id);
      expect(streamRequests[0]?.model).toBe('interpreter-smart');
      expect(streamRequests[0]).not.toHaveProperty('codexProfileId');
      expect(streamRequests[0]).not.toHaveProperty('customEndpoint');
      expect(streamRequests[0]).not.toHaveProperty('customApiKey');
      expect(streamRequests[1]?.profileId).toBe(profileB.id);
      expect(streamRequests[1]?.threadId).toBe(threadId);
      expect(streamRequests[1]?.model).toBe('openai/gpt-5.4');
      expect(streamRequests[1]?.reasoningEffort).toBe('high');
      expect(streamRequests[1]).not.toHaveProperty('codexProfileId');
      expect(streamRequests[1]).not.toHaveProperty('customEndpoint');
      expect(streamRequests[1]).not.toHaveProperty('customApiKey');
    } finally {
      await deleteProfiles(page, [profileA.id, profileB.id]);
    }
  });

  test('stop preserves the visible chat when the next turn has not emitted events', async ({ page }) => {
    test.setTimeout(60000);

    const threadId = randomUUID();
    const streamRequests: StreamRequestBody[] = [];
    let resolveSecondStreamStarted: (() => void) | null = null;
    let releaseSecondStream: () => void = () => {};
    const secondStreamStarted = new Promise<void>((resolve) => {
      resolveSecondStreamStarted = resolve;
    });
    const secondStreamRelease = new Promise<void>((resolve) => {
      releaseSecondStream = resolve;
    });

    await clearUserConfig(page);
    await waitForAppReady(page);
    await setWorkspace(page, getTestWorkspace());

    await page.route('**/api/agent/chat/stream**', async (route) => {
      const requestBody = route.request().postDataJSON() as StreamRequestBody;
      streamRequests.push(requestBody);

      if (streamRequests.length === 1) {
        await route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
          body: buildSse([
            { event: 'thread', payload: { threadId } },
            { event: 'delta', payload: { text: 'First completed response' } },
          ]),
        });
        return;
      }

      resolveSecondStreamStarted?.();
      await secondStreamRelease;
      await route.fulfill({
        status: 499,
        headers: { 'Content-Type': 'text/event-stream' },
        body: '',
      }).catch(() => {});
    });

    await page.route('**/api/agent/chat/stop', async (route) => {
      releaseSecondStream();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });

    try {
      const composer = page.locator(sel.activeComposer());
      const thread = page.locator(sel.activeAgentThread());

      await composer.click();
      await page.keyboard.type('First request before stop.', { delay: 10 });
      await page.keyboard.press('Enter');

      await expect(thread.getByText('First request before stop.')).toBeVisible({ timeout: 10000 });
      await expect(thread.getByText('First completed response')).toBeVisible({ timeout: 10000 });
      await expect(page.locator(sel('typingIndicator'))).toBeHidden({ timeout: 10000 });

      await composer.click();
      await page.keyboard.type('Second request that will be stopped.', { delay: 10 });
      await page.keyboard.press('Enter');

      await secondStreamStarted;
      await expect(thread.getByText('Second request that will be stopped.')).toBeVisible({ timeout: 10000 });

      const stopButton = page.locator(`${sel('mainComposerSendButton')}[data-help-title="Stop"]`);
      await expect(stopButton).toBeVisible({ timeout: 10000 });
      await stopButton.click();

      await expect(page.locator(sel('typingIndicator'))).toBeHidden({ timeout: 10000 });
      await expect(thread.getByText('First request before stop.')).toBeVisible();
      await expect(thread.getByText('First completed response')).toBeVisible();
      await expect(thread.getByText('Second request that will be stopped.')).toBeVisible();
      expect(streamRequests).toHaveLength(2);
      expect(streamRequests[1]?.threadId).toBe(threadId);
    } finally {
      releaseSecondStream();
    }
  });

  test('inline errors offer bug reporting and fresh-chat recovery after a profile switch', async ({ page }) => {
    test.setTimeout(60000);

    const firstThreadId = randomUUID();
    const recoveryThreadId = randomUUID();
    const profileA = {
      id: `reasoning-error-a-${Date.now()}`,
      name: `Reasoning Error A ${Date.now()}`,
      modelId: 'interpreter-smart',
    };
    const profileB = {
      id: `reasoning-error-b-${Date.now()}`,
      name: `Reasoning Error B ${Date.now()}`,
      modelId: 'openai/gpt-5.4',
    };

    try {
      writeOpenRouterReasoningModelCache();
      await clearUserConfig(page);
      await waitForAppReady(page);
      await createHostedProfile(page, profileA);
      await createHostedProfile(page, profileB);

      const streamRequests: StreamRequestBody[] = [];
      await page.route('**/api/agent/chat/stream**', async (route) => {
        const requestBody = route.request().postDataJSON() as StreamRequestBody;
        streamRequests.push(requestBody);

        if (streamRequests.length === 1) {
          await route.fulfill({
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
            body: buildSse([
              { event: 'thread', payload: { threadId: firstThreadId } },
              { event: 'delta', payload: { text: 'First stub response' } },
            ]),
          });
          return;
        }

        if (streamRequests.length === 2) {
          await route.fulfill({
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
            body: buildSse([
              { event: 'error', payload: { errorInfo: { kind: 'raw', text: 'OpenAI model returned an error' } } },
            ]),
          });
          return;
        }

        await route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
          body: buildSse([
            { event: 'thread', payload: { threadId: recoveryThreadId } },
            { event: 'delta', payload: { text: 'Recovered in a fresh chat' } },
          ]),
        });
      });

      const settingsButton = page.locator(sel('agentSettingsButton'));
      const composer = page.locator(sel.activeComposer());
      const thread = page.locator(sel.activeAgentThread());

      await settingsButton.click();
      const popover = page.locator(sel('settingsPopover'));
      await expect(popover).toBeVisible({ timeout: 5000 });
      await popover.getByText(profileA.name, { exact: true }).click();
      await expect(popover).toBeHidden({ timeout: 5000 });

      await composer.click();
      await page.keyboard.type('First request to create thread.', { delay: 10 });
      await page.keyboard.press('Enter');

      await expect(thread.getByText('First stub response')).toBeVisible({ timeout: 10000 });
      await expect(page.locator(sel('typingIndicator'))).toBeHidden({ timeout: 10000 });

      await settingsButton.click();
      await expect(popover).toBeVisible({ timeout: 5000 });
      await popover.getByText(profileB.name, { exact: true }).click();
      await expect(popover).toBeHidden({ timeout: 5000 });

      await composer.click();
      await page.keyboard.type('Second request after switching profile.', { delay: 10 });
      const errorBlock = page.locator(sel('errorMessage'));
      pauseErrorChecking(page);
      try {
        await page.keyboard.press('Enter');
        await expect(errorBlock).toBeVisible({ timeout: 10000 });
        await expect(errorBlock.getByText('Provider error')).toBeVisible();
        await expect(errorBlock.getByRole('button', { name: 'Report Bug' })).toBeVisible();
        await expect(errorBlock.getByRole('button', { name: 'Retry' })).toBeVisible();
        await expect(errorBlock.getByRole('button', { name: 'New Chat (with history)' })).toBeVisible();
        await expect(errorBlock.getByRole('button', { name: 'Start new chat', exact: true })).toHaveCount(0);
        await expect(errorBlock.getByText("We're aware of chat errors after switching profiles. Please report your error to help us fix them faster. In the meantime, you can start a new chat.")).toHaveCount(0);
      } finally {
        resumeErrorChecking(page);
      }

      await errorBlock.getByRole('button', { name: 'New Chat (with history)' }).click();
      await expect.poll(async () => (await composer.innerText()).trim(), { timeout: 10000 }).toContain(
        'Continue this conversation in a fresh chat. Here is the conversation so far:',
      );
      expect(streamRequests).toHaveLength(2);

      await composer.click();
      await page.keyboard.press('Enter');

      const typingIndicator = page.locator(sel('typingIndicator'));
      const recoveredMessage = thread.getByText('Recovered in a fresh chat');
      const recoveryStarted = await Promise.race([
        typingIndicator.waitFor({ state: 'visible', timeout: 10000 }).then(() => 'typing'),
        recoveredMessage.waitFor({ state: 'visible', timeout: 10000 }).then(() => 'completed'),
      ]);

      if (recoveryStarted === 'typing') {
        await expect(recoveredMessage).toBeVisible({ timeout: 10000 });
      }

      await expect(recoveredMessage).toBeVisible({ timeout: 10000 });
      await expect(typingIndicator).toBeHidden({ timeout: 10000 });

      expect(streamRequests).toHaveLength(3);
      expect(streamRequests[2]?.profileId).toBe(profileB.id);
      expect(streamRequests[2]?.threadId ?? null).toBeNull();
      expect(streamRequests[2]?.message).toContain('Continue this conversation in a fresh chat. Here is the conversation so far:');
      expect(streamRequests[2]?.message).toContain('User:\nFirst request to create thread.');
      expect(streamRequests[2]?.message).toContain('Assistant:\nFirst stub response');
      expect(streamRequests[2]?.message).toContain('User:\nSecond request after switching profile.');
    } finally {
      await deleteProfiles(page, [profileA.id, profileB.id]);
    }
  });

  test('popover stays within the window and scrolls when many profiles exist', async ({ page }) => {
    test.setTimeout(60000);

    const createdProfileIds: string[] = [];
    try {
      await clearUserConfig(page);
      await waitForAppReady(page);

      const runId = Date.now();
      const createdProfiles: string[] = [];
      for (let index = 0; index < 18; index += 1) {
        const profileId = `overflow-profile-${runId}-${index}`;
        const name = `Overflow Profile ${runId}-${index + 1}`;
        createdProfileIds.push(profileId);
        createdProfiles.push(name);
        await createHostedProfile(page, {
          id: profileId,
          name,
          modelId: index % 2 === 0 ? 'interpreter-smart' : 'interpreter-fast',
        });
      }

      await page.locator(sel('agentSettingsButton')).click();
      const popover = page.locator(sel('settingsPopover'));
      await expect(popover).toBeVisible({ timeout: 5000 });
      await popover.locator(sel.profileCard(createdProfileIds[createdProfileIds.length - 1]!)).waitFor({
        state: 'attached',
        timeout: 10000,
      });

      const viewportHeight = await page.evaluate(() => window.innerHeight);
      const bounds = await popover.boundingBox();
      expect(bounds).not.toBeNull();
      expect(viewportHeight).toBeGreaterThan(0);
      expect(bounds!.y).toBeGreaterThanOrEqual(8);
      expect(bounds!.height).toBeLessThanOrEqual(viewportHeight - 8);

      const scrollState = await popover.evaluate((element) => {
        const nodes = [element, ...Array.from(element.querySelectorAll<HTMLElement>('*'))];
        const scrollable = nodes.find((node) => node.scrollHeight > node.clientHeight + 1);
        if (!scrollable) {
          return { hasScrollableRegion: false, scrollTop: 0, clientHeight: 0, scrollHeight: 0 };
        }

        scrollable.scrollTop = scrollable.scrollHeight;
        return {
          hasScrollableRegion: true,
          scrollTop: scrollable.scrollTop,
          clientHeight: scrollable.clientHeight,
          scrollHeight: scrollable.scrollHeight,
        };
      });

      expect(scrollState.hasScrollableRegion).toBe(true);
      expect(scrollState.scrollHeight).toBeGreaterThan(scrollState.clientHeight);
      expect(scrollState.scrollTop).toBeGreaterThan(0);
      await expect(popover.getByText(createdProfiles[createdProfiles.length - 1]!, { exact: true })).toBeVisible();
    } finally {
      await deleteProfiles(page, createdProfileIds);
    }
  });

  test('workspace changes keep an active chat pinned to its original workspace without showing a banner', async ({ page }) => {
    test.setTimeout(60000);

    const threadId = randomUUID();
    await clearUserConfig(page);
    await waitForAppReady(page);

    const workspaceA = getTestWorkspace();
    const workspaceB = fs.mkdtempSync(path.join(os.tmpdir(), 'workstation-chat-workspace-'));
    fs.writeFileSync(path.join(workspaceB, 'README.md'), '# workspace b\n');

    await setWorkspace(page, workspaceA);

    await page.route('**/api/agent/chat/stream**', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        body: buildSse([
          { event: 'thread', payload: { threadId } },
          { event: 'delta', payload: { text: 'Workspace sync response' } },
        ]),
      });
    });

    const composer = page.locator(sel.activeComposer());
    await composer.click();
    await page.keyboard.type('Create a thread before changing workspaces.', { delay: 10 });
    await page.keyboard.press('Enter');

    const thread = page.locator(sel.activeAgentThread());
    await expect(thread.getByText('Workspace sync response')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('This chat originated in workspace')).toHaveCount(0);

    await setWorkspace(page, workspaceB);

    await page.waitForFunction((expectedWorkspace) => {
      const state = (window as any).__layoutContext?.getState?.() as {
        tabs?: Record<string, { type?: string; agent?: { runtime?: { workspacePath?: string } } }>;
      };
      if (!state?.tabs) return false;
      return Object.values(state.tabs || {}).some((tab) =>
        tab.type === 'agent' && tab.agent?.runtime?.workspacePath === expectedWorkspace
      );
    }, workspaceA);

    await expect(page.getByText('This chat originated in workspace')).toHaveCount(0);
  });

  test('reloading the app keeps the active conversation on the same thread and model', async ({ page }) => {
    test.setTimeout(60000);

    const threadId = randomUUID();
    const profile = {
      id: `reasoning-reload-${Date.now()}`,
      name: `Reasoning Reload ${Date.now()}`,
      modelId: 'openai/gpt-5.4',
    };

    try {
      writeOpenRouterReasoningModelCache();
      await createHostedProfile(page, profile);

      const workspace = getTestWorkspace();
      await setWorkspace(page, workspace);
      const editorAgentSurface = page.locator(`${sel.editorAgentSurfaceAny()}:visible`);
      await expect(editorAgentSurface).toHaveCount(1);
      await expect(editorAgentSurface.locator(sel('mainComposerInput'))).toBeVisible();
      expect(await getActiveCodexThreadId(page)).toBeNull();

      const streamRequests: StreamRequestBody[] = [];
      await page.route('**/api/agent/chat/stream**', async (route) => {
        const requestBody = route.request().postDataJSON() as StreamRequestBody;
        streamRequests.push(requestBody);

        const responseText = streamRequests.length === 1
          ? 'Reload response one'
          : 'Reload response two';

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
        const response = buildThreadReadResponse(
          threadId,
          streamRequests.length >= 2
            ? [
              {
                userText: 'Create a thread that must survive reload.',
                assistantText: 'Reload response one',
              },
              {
                userText: 'Continue after reload on the same thread.',
                assistantText: 'Reload response two',
              },
            ]
            : [
              {
                userText: 'Create a thread that must survive reload.',
                assistantText: 'Reload response one',
              },
            ],
        );
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(response),
        });
      });

      const settingsButton = editorAgentSurface.locator(sel('agentSettingsButton'));
      await expect(settingsButton).toHaveCount(1);
      await settingsButton.click();
      const popover = page.locator(sel('settingsPopover'));
      await expect(popover).toBeVisible({ timeout: 5000 });
      await popover.getByText(profile.name, { exact: true }).click();
      await expect(popover).toBeHidden({ timeout: 5000 });

      const composer = editorAgentSurface.locator(sel('mainComposerInput'));
      await composer.click();
      await page.keyboard.type('Create a thread that must survive reload.', { delay: 10 });
      await page.keyboard.press('Enter');

      const thread = page.locator(sel.activeAgentThread());
      const typingIndicator = page.locator(sel('typingIndicator'));
      await waitForResponseWithErrorCheck(page, typingIndicator, thread, 10000);
      await expect(thread.getByText('Reload response one')).toBeVisible({ timeout: 10000 });

      expect(await getActiveCodexThreadId(page)).toBe(threadId);

      pauseErrorChecking(page);
      await reloadAndWaitForPageLoadSignals(page);
      resumeErrorChecking(page);
      await page.waitForFunction((expectedThreadId) => {
        const layout = (window as any).__layoutContext?.getState?.() as {
          tree?: {
            kind: 'pane' | 'split';
            id?: string;
            activeTabId?: string;
            children?: unknown[];
          };
          activePaneId?: string | null;
          tabs?: Record<string, {
            type?: string;
            agent?: { session?: { codexThreadId?: string } };
          }>;
        };
        if (!layout?.tree || !layout.tabs) return false;

        const findPane = (node: {
          kind: 'pane' | 'split';
          id?: string;
          activeTabId?: string;
          children?: unknown[];
        } | null | undefined): { activeTabId?: string } | null => {
          if (!node) return null;
          if (node.kind === 'pane') {
            return node.id === layout.activePaneId ? node : null;
          }
          if (!Array.isArray(node.children)) {
            return null;
          }
          for (const child of node.children) {
            const match = findPane(child as {
              kind: 'pane' | 'split';
              id?: string;
              activeTabId?: string;
              children?: unknown[];
            });
            if (match) {
              return match;
            }
          }
          return null;
        };

        const activeThread = document.querySelector('[data-testid^="agent-thread-"][data-active="true"]');
        const activeAgentId = activeThread?.getAttribute('data-agent-id') ?? findPane(layout.tree)?.activeTabId;
        if (!activeAgentId) return false;

        return layout.tabs[activeAgentId]?.type === 'agent'
          && layout.tabs[activeAgentId]?.agent?.session?.codexThreadId === expectedThreadId;
      }, threadId);

      expect(await getActiveCodexThreadId(page)).toBe(threadId);

      const restoredThread = page.locator(sel.activeAgentThread());
      await expect(restoredThread.getByText('Reload response one')).toBeVisible({ timeout: 10000 });

      const reloadedComposer = page.locator(`${sel.editorAgentSurfaceAny()}:visible`).locator(sel('mainComposerInput'));
      await reloadedComposer.click();
      await page.keyboard.type('Continue after reload on the same thread.', { delay: 10 });
      await page.keyboard.press('Enter');

      const reloadedThread = page.locator(sel.activeAgentThread());
      const reloadedTypingIndicator = page.locator(sel('typingIndicator'));
      await waitForResponseWithErrorCheck(page, reloadedTypingIndicator, reloadedThread, 10000);
      await expect(reloadedThread.getByText('Reload response two')).toBeVisible({ timeout: 10000 });

      expect(streamRequests).toHaveLength(2);
      expect(streamRequests[0]?.profileId).toBe(profile.id);
      expect(streamRequests[0]?.model).toBe('openai/gpt-5.4');
      expect(streamRequests[0]?.workspacePath).toBe(workspace);
      expect(streamRequests[1]?.profileId).toBe(profile.id);
      expect(streamRequests[1]?.threadId).toBe(threadId);
      expect(streamRequests[1]?.model).toBe('openai/gpt-5.4');
      expect(streamRequests[1]?.workspacePath).toBe(workspace);
    } finally {
      await deleteProfiles(page, [profile.id]);
    }
  });
});
