import { test, expect, pauseErrorChecking, resumeErrorChecking } from './fixtures';
import { sel } from './selectors';
import { ElectronInstanceManager } from './electron-instance';
import {
  applyEnv,
  configureOverlayVoiceForTest,
  snapshotEnv,
  type EnvSnapshot,
} from './voice-test-utils';

let envSnapshot: EnvSnapshot;

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

test.beforeAll(() => {
  envSnapshot = snapshotEnv([
    'FORM_TESTS_MODE',
    'FORM_TESTS_DEBUG_PORT',
    'INTERPRETER_OVERLAY_DEBUG_PORT',
    'INTERPRETER_OVERLAY_DEBUG_TOKEN',
    'INTERPRETER_OVERLAY_DISABLE_ADVANCED_VOICE_CREATE_CALL',
  ]);
  const envOverrides: Record<string, string | undefined> = {
    FORM_TESTS_MODE: 'true',
    FORM_TESTS_DEBUG_PORT: '0',
    INTERPRETER_OVERLAY_DEBUG_PORT: undefined,
    INTERPRETER_OVERLAY_DEBUG_TOKEN: undefined,
    INTERPRETER_OVERLAY_DISABLE_ADVANCED_VOICE_CREATE_CALL: 'true',
  };
  applyEnv(envOverrides);
});

test.afterAll(async () => {
  applyEnv(envSnapshot);
  ElectronInstanceManager.invalidate();
});

test.skip(
  process.platform === 'darwin' && Boolean(process.env.CI),
  'Fake microphone voice mode is unstable on macOS CI and remains covered on Linux and Windows CI.',
);

test('@voice voice button delegates to overlay voice mode', async ({ page }) => {
  test.setTimeout(120000);

  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);

  await page.evaluate(() => {
    (window as any).__voiceLatencyEvents = [];
  });
  await configureOverlayVoiceForTest(page);

  const composer = page.locator(sel('mainComposerInput')).first();
  const voiceButton = page.locator(sel('mainComposerVoiceButton')).first();

  await page.evaluate(() => {
    (window as any).__voiceSendEvents = [];
    window.addEventListener('agent-runtime:send', (event: Event) => {
      const detail = (event as CustomEvent).detail;
      (window as any).__voiceSendEvents.push({
        text: typeof detail?.text === 'string' ? detail.text : '',
        tabId: typeof detail?.tabId === 'string' ? detail.tabId : '',
      });
    });
  });

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

  await expect.poll(async () => normalize(await composer.innerText()), { timeout: 5000 }).toBe('');

  pauseErrorChecking(page);
  try {
    // Starts voice mode (mic button when composer is empty).
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
