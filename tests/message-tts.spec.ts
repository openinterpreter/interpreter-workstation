import { test, expect } from './fixtures';
import { ElectronInstanceManager } from './electron-instance';
import {
  TEST_TTS_INSTALL_ROOT,
  TTS_TEST_MODEL_ID,
  applyEnv,
  configureTtsModel,
  ensureAgentComposerReady,
  resetInstallRoot,
  sendPromptAndWaitForReply,
  snapshotEnv,
  stubSingleAssistantReply,
  type EnvSnapshot,
} from './voice-test-utils';

let envSnapshot: EnvSnapshot;

test.beforeAll(() => {
  envSnapshot = snapshotEnv(['TEST_TTS_INSTALL_ROOT']);
  applyEnv({ TEST_TTS_INSTALL_ROOT: TEST_TTS_INSTALL_ROOT });
  resetInstallRoot(TEST_TTS_INSTALL_ROOT);
});

test.afterAll(async () => {
  applyEnv(envSnapshot);
  ElectronInstanceManager.invalidate();
});

test.describe.serial('@voice message-level TTS playback', () => {
  test('play button shows the install modal when the selected TTS model is missing', async ({ page }) => {
    test.setTimeout(120000);

    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
    await ensureAgentComposerReady(page);
    await configureTtsModel(page, TTS_TEST_MODEL_ID);
    await stubSingleAssistantReply(page, 'This is the assistant reply that should be spoken aloud.');
    await sendPromptAndWaitForReply(
      page,
      'Create an assistant message for the TTS playback test.',
      'This is the assistant reply that should be spoken aloud.',
    );

    const thread = page.locator('[data-testid^="agent-thread-"][data-active="true"]');
    const assistantMessage = thread.locator('[data-message-id]').last();
    await assistantMessage.hover();
    await assistantMessage.getByRole('button', { name: 'Play message' }).click();

    const modal = page.getByRole('heading', { name: 'Download experimental voice models?' });
    await expect(modal).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(`TTS model (${TTS_TEST_MODEL_ID})`)).toBeVisible({ timeout: 5000 });
  });

  test('play button installs the selected TTS model and then plays the message', async ({ page }) => {
    test.setTimeout(420000);

    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
    await ensureAgentComposerReady(page);
    await configureTtsModel(page, TTS_TEST_MODEL_ID);
    await stubSingleAssistantReply(page, 'This is the assistant reply that should be spoken aloud.');
    await sendPromptAndWaitForReply(
      page,
      'Create an assistant message for the TTS playback test.',
      'This is the assistant reply that should be spoken aloud.',
    );

    await page.evaluate(() => {
      const events: Array<Record<string, unknown>> = [];
      (window as typeof window & { __ttsPlaybackProbe?: Array<Record<string, unknown>> }).__ttsPlaybackProbe = events;

      window.addEventListener('assistant-tts:message-speaking', (event: Event) => {
        const detail = (event as CustomEvent<{ messageId?: string | null; text?: string | null }>).detail;
        events.push({
          type: 'message-speaking',
          messageId: detail?.messageId ?? null,
          text: detail?.text ?? null,
        });
      });

      window.addEventListener('assistant-tts:playback-state', (event: Event) => {
        const detail = (event as CustomEvent<{ isSpeaking?: boolean }>).detail;
        events.push({
          type: 'playback-state',
          isSpeaking: detail?.isSpeaking ?? null,
        });
      });

      const NativeAudio = window.Audio;
      const WrappedAudio = function (...args: ConstructorParameters<typeof Audio>) {
        const audio = new NativeAudio(...args);
        audio.addEventListener('play', () => {
          events.push({ type: 'audio-play' });
        });
        audio.addEventListener('ended', () => {
          events.push({ type: 'audio-ended' });
        });
        audio.addEventListener('error', () => {
          events.push({ type: 'audio-error' });
        });

        const nativePlay = audio.play.bind(audio);
        audio.play = () => {
          events.push({ type: 'audio-play-called' });
          const playResult = nativePlay();
          void Promise.resolve(playResult)
            .then(() => {
              events.push({ type: 'audio-play-resolved' });
            })
            .catch((error) => {
              events.push({
                type: 'audio-play-rejected',
                error: error instanceof Error ? error.message : String(error),
              });
            });
          return playResult;
        };

        return audio;
      } as unknown as typeof Audio;

      WrappedAudio.prototype = NativeAudio.prototype;
      Object.setPrototypeOf(WrappedAudio, NativeAudio);
      window.Audio = WrappedAudio;
    });

    const thread = page.locator('[data-testid^="agent-thread-"][data-active="true"]');
    const assistantMessage = thread.locator('[data-message-id]').last();
    const messageId = await assistantMessage.getAttribute('data-message-id');
    if (!messageId) {
      throw new Error('Expected assistant message id for TTS playback test.');
    }

    await assistantMessage.hover();
    await assistantMessage.getByRole('button', { name: 'Play message' }).click();

    const modal = page.getByRole('heading', { name: 'Download experimental voice models?' });
    await expect(modal).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Download model' }).click();
    await expect(modal).toBeHidden({ timeout: 240000 });

    await expect.poll(
      async () => await page.evaluate((expectedMessageId: string) => {
        const events = ((window as typeof window & {
          __ttsPlaybackProbe?: Array<Record<string, unknown>>;
        }).__ttsPlaybackProbe ?? []);
        return events.some((event) =>
          event.type === 'message-speaking' && event.messageId === expectedMessageId
        );
      }, messageId),
      { timeout: 120000 },
    ).toBe(true);

    await expect.poll(
      async () => await page.evaluate(() => {
        const events = ((window as typeof window & {
          __ttsPlaybackProbe?: Array<Record<string, unknown>>;
        }).__ttsPlaybackProbe ?? []);
        return {
          playResolved: events.some((event) => event.type === 'audio-play-resolved'),
          ended: events.some((event) => event.type === 'audio-ended'),
          playRejected: events.some((event) => event.type === 'audio-play-rejected'),
          audioError: events.some((event) => event.type === 'audio-error'),
        };
      }),
      { timeout: 120000 },
    ).toEqual({
      playResolved: true,
      ended: true,
      playRejected: false,
      audioError: false,
    });

    const eventsAfterInstall = await page.evaluate(() => {
      return ((window as typeof window & {
        __ttsPlaybackProbe?: Array<Record<string, unknown>>;
      }).__ttsPlaybackProbe ?? []).length;
    });

    await assistantMessage.hover();
    await assistantMessage.getByRole('button', { name: 'Play message' }).click();
    await expect(modal).toHaveCount(0);

    await expect.poll(
      async () => await page.evaluate((previousCount: number) => {
        const events = ((window as typeof window & {
          __ttsPlaybackProbe?: Array<Record<string, unknown>>;
        }).__ttsPlaybackProbe ?? []);
        return events.length > previousCount
          && events.some((event, index) => index >= previousCount && event.type === 'audio-play-resolved');
      }, eventsAfterInstall),
      { timeout: 30000 },
    ).toBe(true);
  });
});
