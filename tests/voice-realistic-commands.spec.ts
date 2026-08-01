import path from 'path';
import { fileURLToPath } from 'url';
import { test, expect, pauseErrorChecking, resumeErrorChecking } from './fixtures';
import { sel } from './selectors';
import { ElectronInstanceManager } from './electron-instance';
import { applyEnv, requireQwenVoiceAssets, snapshotEnv, type EnvSnapshot } from './voice-test-utils';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const voiceFixturePath = path.join(__dirname, 'fixtures', 'audio', 'voice-realistic-commands.wav');
let envSnapshot: EnvSnapshot;

test.beforeAll(() => {
  envSnapshot = snapshotEnv(['TEST_FAKE_AUDIO_FILE', 'TEST_FAKE_ASR_TEXT']);
  applyEnv({
    TEST_FAKE_AUDIO_FILE: voiceFixturePath,
    TEST_FAKE_ASR_TEXT: undefined,
  });
});

test.afterAll(async () => {
  applyEnv(envSnapshot);
  ElectronInstanceManager.invalidate();
});

test.skip(
  process.platform === 'darwin' && Boolean(process.env.CI),
  'Fake microphone voice mode is unstable on macOS CI and remains covered on Linux and Windows CI.',
);

test('@voice voice mode handles realistic command sequence from fake mic with qwen backend', async ({ page }) => {
  test.setTimeout(180000);

  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
  await requireQwenVoiceAssets(page);

  await page.evaluate(async () => {
    (window as any).__VOICE_BACKEND__ = 'qwen';
    (window as any).__realisticVoiceStartMs = 0;
    (window as any).__realisticVoiceSendEvents = [];
    (window as any).__realisticVoiceLatencyEvents = [];

    const response = await window.electron.stt.setSettings({
      settings: {
        voiceMode: 'conversational',
        backend: 'qwen',
        previewBeforeSendMs: 0,
      },
    });
    if (!response.success) {
      throw new Error(`Failed to set STT settings: ${response.error ?? 'unknown error'}`);
    }

    window.addEventListener('agent-runtime:send', (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      const text = typeof detail.text === 'string' ? detail.text : '';
      (window as any).__realisticVoiceSendEvents.push({
        timestampMs: performance.now(),
        text,
      });
    });

    window.addEventListener('voice:latency', (event: Event) => {
      const detail = ((event as CustomEvent).detail || {}) as Record<string, unknown>;
      (window as any).__realisticVoiceLatencyEvents.push({
        type: typeof detail.type === 'string' ? detail.type : '',
        timestampMs: typeof detail.timestampMs === 'number' ? detail.timestampMs : performance.now(),
        surface: typeof detail.surface === 'string' ? detail.surface : undefined,
        backend: typeof detail.backend === 'string' ? detail.backend : undefined,
        text: typeof detail.text === 'string' ? detail.text : undefined,
      });
    });
  });

  const composer = page.locator(sel('mainComposerInput')).first();
  const voiceButton = page.locator(sel('mainComposerVoiceButton')).first();

  const composerInitiallyVisible = await composer.isVisible().catch(() => false);
  if (!composerInitiallyVisible) {
    const onboardingVisible = await page.getByText('Complete onboarding to start chatting').isVisible().catch(() => false);
    test.skip(onboardingVisible, 'Onboarding state does not expose agent composer controls');

    const newAgentButton = page.locator(sel('newAgentButton')).first();
    const hasNewAgentButton = await newAgentButton.isVisible().catch(() => false);
    if (hasNewAgentButton) {
      await newAgentButton.click();
    }
  }

  const composerVisibleNow = await composer.isVisible().catch(() => false);
  test.skip(!composerVisibleNow, 'No active agent composer available in this environment');

  await expect(composer).toBeVisible({ timeout: 15000 });
  await expect(voiceButton).toBeVisible({ timeout: 15000 });

  await composer.click();
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${modifier}+A`);
  await page.keyboard.press('Backspace');
  await expect.poll(async () => (await composer.innerText()).trim(), { timeout: 5000 }).toBe('');

  pauseErrorChecking(page);
  try {
    await page.evaluate(() => {
      (window as any).__realisticVoiceStartMs = performance.now();
    });
    await voiceButton.click();

    await expect.poll(
      async () => await page.evaluate(() => (window as any).__realisticVoiceSendEvents.length as number),
      { timeout: 120000 },
    ).toBeGreaterThan(2);

    const report = await page.evaluate(() => {
      const startMs = (window as any).__realisticVoiceStartMs as number;
      const sendEvents = ((window as any).__realisticVoiceSendEvents ?? []) as Array<{ timestampMs: number; text: string }>;
      const latencyEvents = ((window as any).__realisticVoiceLatencyEvents ?? []) as Array<{
        type: string;
        timestampMs: number;
        surface?: string;
        backend?: string;
        text?: string;
      }>;

      const composerUpdates = latencyEvents
        .filter(
          event => event.type === 'composer-text-updated'
            && event.backend === 'qwen'
            && event.surface === 'main-composer',
        )
        .sort((a, b) => a.timestampMs - b.timestampMs);

      const firstComposerMs = composerUpdates[0]?.timestampMs ?? Number.NaN;
      const firstUpdateLatencyMs = Number.isFinite(firstComposerMs) ? (firstComposerMs - startMs) : Number.NaN;

      const normalizedMessages = sendEvents.map(event => ({
        ...event,
        normalized: event.text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim(),
      }));

      const sendGapsMs: number[] = [];
      for (let i = 1; i < sendEvents.length; i += 1) {
        sendGapsMs.push(sendEvents[i].timestampMs - sendEvents[i - 1].timestampMs);
      }

      return {
        sendCount: sendEvents.length,
        firstUpdateLatencyMs: Number.isFinite(firstUpdateLatencyMs)
          ? Math.round(firstUpdateLatencyMs * 10) / 10
          : null,
        sendGapsMs: sendGapsMs.map(value => Math.round(value * 10) / 10),
        messages: normalizedMessages.map(event => event.normalized),
      };
    });

    console.log('[VoiceRealisticSequence]', JSON.stringify(report, null, 2));

    expect(report.sendCount).toBeGreaterThan(2);

    const combined = report.messages.join(' ');
    expect(
      combined.includes('voice')
      || combined.includes('mode')
      || combined.includes('typecheck')
      || combined.includes('session')
      || combined.includes('error'),
    ).toBeTruthy();
  } finally {
    resumeErrorChecking(page);
  }
});
