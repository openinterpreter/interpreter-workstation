import { test, expect, pauseErrorChecking, resumeErrorChecking } from './fixtures';
import { sel } from './selectors';
import { ElectronInstanceManager } from './electron-instance';
import {
  applyEnv,
  configureOverlayVoiceForTest,
  ensureAgentComposerReady,
  snapshotEnv,
  type EnvSnapshot,
} from './voice-test-utils';

let envSnapshot: EnvSnapshot;

test.beforeAll(() => {
  envSnapshot = snapshotEnv([
    'FORM_TESTS_MODE',
    'FORM_TESTS_DEBUG_PORT',
    'INTERPRETER_OVERLAY_DEBUG_PORT',
    'INTERPRETER_OVERLAY_DEBUG_TOKEN',
    'INTERPRETER_OVERLAY_DISABLE_ADVANCED_VOICE_CREATE_CALL',
  ]);
  applyEnv({
    FORM_TESTS_MODE: 'true',
    FORM_TESTS_DEBUG_PORT: '0',
    INTERPRETER_OVERLAY_DEBUG_PORT: undefined,
    INTERPRETER_OVERLAY_DEBUG_TOKEN: undefined,
    INTERPRETER_OVERLAY_DISABLE_ADVANCED_VOICE_CREATE_CALL: 'true',
  });
});

test.afterAll(async () => {
  applyEnv(envSnapshot);
  ElectronInstanceManager.invalidate();
});

test.skip(
  process.platform === 'darwin' && Boolean(process.env.CI),
  'Fake microphone ambient mode is unstable on macOS CI and remains covered on Linux and Windows CI.',
);

test('@voice ambient send path delegates voice button to overlay voice mode', async ({ page }) => {
  test.setTimeout(150000);

  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
  await ensureAgentComposerReady(page);

  await page.evaluate(() => {
    (window as any).__voiceLatencyEvents = [];
    (window as any).__ambientSendEvents = [];
    (window as any).__ambientPreviewEvents = [];

    window.addEventListener('agent-runtime:send', (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      (window as any).__ambientSendEvents.push({
        text: typeof detail.text === 'string' ? detail.text : '',
        tabId: typeof detail.tabId === 'string' ? detail.tabId : '',
      });
    });

    window.addEventListener('voice:latency', (event: Event) => {
      const detail = ((event as CustomEvent).detail || {}) as Record<string, unknown>;
      if (
        detail.type === 'composer-text-updated'
        && detail.surface === 'main-composer'
        && typeof detail.text === 'string'
        && detail.text.trim().length > 0
      ) {
        (window as any).__ambientPreviewEvents.push(detail.text);
      }
    });
  });
  await configureOverlayVoiceForTest(page);

  const composer = page.locator(sel('mainComposerInput')).first();
  const voiceButton = page.locator(sel('mainComposerVoiceButton')).first();

  await expect(composer).toBeVisible({ timeout: 15000 });
  await expect(voiceButton).toBeVisible({ timeout: 15000 });

  await composer.click();
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${modifier}+A`);
  await page.keyboard.press('Backspace');

  pauseErrorChecking(page);
  try {
    await voiceButton.click();

    await expect.poll(
      async () => await page.evaluate(() => {
        const events = (window as any).__voiceLatencyEvents as Array<{
          type?: string;
          surface?: string;
          selectedTextLength?: number;
        }>;
        return events.some((event) =>
          event.type === 'overlay-window-voice-started'
            && event.surface === 'main-composer'
            && event.selectedTextLength === 0
        );
      }),
      { timeout: 5000 },
    ).toBe(true);
  } finally {
    resumeErrorChecking(page);
  }
});
