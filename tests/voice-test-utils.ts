import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { Page } from '@playwright/test';
import { expect } from './fixtures';
import { sel } from './selectors';
import {
  clearUserConfig,
  getTestWorkspace,
  setWorkspace,
  waitForAppReady,
  waitForResponseWithErrorCheck,
} from './helpers';
import type { TtsModelId } from '../shared/types/tts';
import { DEFAULT_INTERPRETER_OVERLAY_SETTINGS } from '../apps/interpreter-overlay/shared/settings';

export const TEST_QWEN_INSTALL_ROOT = path.join(os.tmpdir(), 'workstation-test-qwen-install');
export const TEST_MOONSHINE_INSTALL_ROOT = path.join(os.tmpdir(), 'workstation-test-moonshine-install');
export const TEST_TTS_INSTALL_ROOT = path.join(os.tmpdir(), 'workstation-test-tts-install');
export const TTS_TEST_MODEL_ID = 'kitten-nano-en-v0_2-fp16';
export const QWEN_DOWNLOAD_COMMAND = 'pnpm run download:qwen-asr -- --current-platform';

export type EnvSnapshot = Record<string, string | undefined>;

export function resetInstallRoot(rootPath: string): void {
  fs.rmSync(rootPath, { recursive: true, force: true });
  fs.mkdirSync(rootPath, { recursive: true });
}

export function snapshotEnv(names: string[]): EnvSnapshot {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

export function applyEnv(overrides: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[name];
      continue;
    }
    process.env[name] = value;
  }
}

export function getPreferredTestVoiceBackend(): 'qwen' | 'moonshine' {
  const forcedBackend = process.env.TEST_FORCE_VOICE_BACKEND?.trim();
  if (forcedBackend === 'qwen' || forcedBackend === 'moonshine') {
    return forcedBackend;
  }
  return process.platform === 'win32' ? 'moonshine' : 'qwen';
}

export function buildSse(events: Array<{ event: string; payload: unknown }>): string {
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

export async function ensureAgentComposerReady(page: Page): Promise<void> {
  await clearUserConfig(page);
  await waitForAppReady(page);
  await setWorkspace(page, getTestWorkspace());

  const composer = page.locator(sel('mainComposerInput')).first();
  if (!await composer.isVisible().catch(() => false)) {
    const newAgentButton = page.locator(sel('newAgentButton')).first();
    if (await newAgentButton.isVisible().catch(() => false)) {
      await newAgentButton.click();
    }
  }

  await expect(page.locator(sel('mainComposerInput')).first()).toBeVisible({ timeout: 15000 });
  await expect.poll(async () => {
    const voiceButton = page.locator(sel('mainComposerVoiceButton')).first();
    const sendButton = page.locator(sel('mainComposerSendButton')).first();
    return (await voiceButton.isVisible().catch(() => false))
      || (await sendButton.isVisible().catch(() => false));
  }, { timeout: 15000 }).toBe(true);
}

export async function stubSingleAssistantReply(
  page: Page,
  responseText: string,
): Promise<{ threadId: string }> {
  const threadId = randomUUID();
  let latestUserPrompt = '';
  await page.route('**/api/agent/chat/stream**', async (route) => {
    const request = route.request().postDataJSON() as { message?: string } | undefined;
    latestUserPrompt = typeof request?.message === 'string' ? request.message : '';
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
      body: JSON.stringify(buildThreadReadResponse(threadId, [
        {
          userText: latestUserPrompt,
          assistantText: responseText,
        },
      ])),
    });
  });
  return { threadId };
}

export async function sendPromptAndWaitForReply(
  page: Page,
  prompt: string,
  reply: string,
): Promise<void> {
  const composer = page.locator(sel('mainComposerInput')).first();
  await composer.click();
  await page.keyboard.type(prompt, { delay: 5 });
  await page.keyboard.press('Enter');

  const thread = page.locator(sel.activeAgentThread());
  const typingIndicator = page.locator(sel('typingIndicator'));
  await waitForResponseWithErrorCheck(page, typingIndicator, thread, 15000);
  await expect(thread.getByText(reply)).toBeVisible({ timeout: 15000 });
}

export async function configureTtsModel(page: Page, modelId: TtsModelId): Promise<void> {
  await page.evaluate(async ({ modelId }) => {
    const response = await window.electron.tts.setSettings({
      settings: {
        modelId,
        readAssistantMessages: false,
        voiceId: 0,
        provider: 'cpu',
        speed: 1,
        pitch: 0,
        autotuneEnabled: false,
        voiceResetEnabled: false,
        voiceResetPhrase: 'Forget everything you know',
      },
    });
    if (!response.success) {
      throw new Error(response.error ?? 'Failed to configure TTS settings');
    }
  }, { modelId });
}

export async function installTtsModelIfNeeded(page: Page, modelId: TtsModelId): Promise<void> {
  await page.evaluate(async ({ modelId }) => {
    const modelsResponse = await window.electron.tts.listModels();
    const installed = (modelsResponse.models as Array<{ id: string; installed?: boolean }>).some(
      (model) => model.id === modelId && model.installed === true,
    );
    if (installed) {
      return;
    }

    const result = await window.electron.tts.installModel({ modelId });
    if (!result.success) {
      throw new Error(result.error ?? `Failed to install TTS model ${modelId}`);
    }
  }, { modelId });
}

export async function configureConversationalQwenVoice(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const response = await window.electron.stt.setSettings({
      settings: {
        voiceMode: 'conversational',
        backend: 'qwen',
        previewBeforeSendMs: 0,
      },
    });
    if (!response.success) {
      throw new Error(response.error ?? 'Failed to configure qwen voice settings');
    }
  });
}

export async function configureConversationalVoice(page: Page, backend = getPreferredTestVoiceBackend()): Promise<void> {
  await page.evaluate(async ({ backend }) => {
    const response = await window.electron.stt.setSettings({
      settings: {
        voiceMode: 'conversational',
        backend,
        previewBeforeSendMs: 0,
      },
    });
    if (!response.success) {
      throw new Error(response.error ?? `Failed to configure ${backend} voice settings`);
    }
  }, { backend });
}

export async function configureOverlayVoiceForTest(page: Page): Promise<void> {
  await page.evaluate(async ({ settings }) => {
    const response = await window.electron.overlaySettings.set({
      ...settings,
      enabled: true,
      permissionSetupPending: false,
      advancedVoiceEnabled: true,
    });
    if (!response.success) {
      throw new Error('Failed to enable overlay voice settings for test');
    }
  }, { settings: DEFAULT_INTERPRETER_OVERLAY_SETTINGS });
}

export async function configureAmbientVoice(page: Page, backend = getPreferredTestVoiceBackend()): Promise<void> {
  await page.evaluate(async ({ backend }) => {
    const response = await window.electron.stt.setSettings({
      settings: {
        voiceMode: 'ambient',
        backend,
        previewBeforeSendMs: 0,
        ambientTriggerPhrases: ['Interpreter', 'Repertor'],
        ambientEndPhrases: ['make it so', 'take it so'],
      },
    });
    if (!response.success) {
      throw new Error(response.error ?? `Failed to configure ${backend} ambient voice settings`);
    }
  }, { backend });
}

export async function ensureQwenVoiceAssets(page: Page): Promise<void> {
  const probe = await page.evaluate(async () => {
    try {
      const result = await window.electron.voiceExtension.checkInstalled({ backend: 'qwen' });
      return {
        installed: result.installed === true,
        installPath: typeof result.installPath === 'string' ? result.installPath : '',
        error: typeof result.error === 'string' ? result.error : null,
      };
    } catch (error) {
      return {
        installed: false,
        installPath: '',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  if (probe.installed) {
    return;
  }

  const installResult = await page.evaluate(async () => {
    const install = await window.electron.voiceExtension.install({ backend: 'qwen' });
    if (!install.success) {
      return {
        success: false,
        error: install.error ?? 'Qwen install failed',
      };
    }

    const after = await window.electron.voiceExtension.checkInstalled({ backend: 'qwen' });
    return {
      success: after.installed === true,
      installPath: typeof after.installPath === 'string' ? after.installPath : '',
      error: typeof after.error === 'string' ? after.error : '',
    };
  });

  if (installResult.success) {
    return;
  }

  const detail = installResult.error
    || probe.error
    || `No installed qwen assets found at ${probe.installPath || '(unknown path)'}.`;
  throw new Error(
    `Qwen voice assets are required for this test. ${detail} `
    + `Bundled assets: \`${QWEN_DOWNLOAD_COMMAND}\`. Runtime install path: ${probe.installPath || '(unknown path)'}.`,
  );
}

export async function ensurePreferredTestVoiceAssets(page: Page): Promise<void> {
  const backend = getPreferredTestVoiceBackend();
  if (backend === 'qwen') {
    await ensureQwenVoiceAssets(page);
    return;
  }

  const result = await page.evaluate(async () => {
    const before = await window.electron.voiceExtension.checkInstalled({ backend: 'moonshine' });
    if (before.installed) {
      return {
        success: true,
        installPath: typeof before.installPath === 'string' ? before.installPath : '',
      };
    }

    const install = await window.electron.voiceExtension.install({ backend: 'moonshine' });
    if (!install.success) {
      return {
        success: false,
        error: install.error ?? 'Moonshine install failed',
      };
    }

    const after = await window.electron.voiceExtension.checkInstalled({ backend: 'moonshine' });
    return {
      success: after.installed === true,
      installPath: typeof after.installPath === 'string' ? after.installPath : '',
      error: typeof after.error === 'string' ? after.error : '',
    };
  });

  if (!result.success) {
    throw new Error(result.error || 'Moonshine voice assets are required for this test.');
  }
}

export const requireQwenVoiceAssets = ensureQwenVoiceAssets;
