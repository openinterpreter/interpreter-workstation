import path from 'path';
import { fileURLToPath } from 'url';
import { test, expect, pauseErrorChecking, resumeErrorChecking } from './fixtures';
import { sel } from './selectors';
import { ElectronInstanceManager } from './electron-instance';
import { applyEnv, requireQwenVoiceAssets, snapshotEnv, type EnvSnapshot } from './voice-test-utils';

/**
 * Voice pipeline durability test — 10+ minutes of natural usage.
 *
 * Feeds a realistic audio file (commands with pauses, like Star Trek computer)
 * through the full voice pipeline via Electron's fake audio capture.
 *
 * What this catches:
 * - Session cleanup killing active sessions (SESSION_MAX_AGE_MS = 5 min)
 * - qwen_asr process memory growth / hangs over long sessions
 * - Bridge/session state corruption after many start/finish cycles
 * - Errors not surfacing to the user (silent failures)
 * - Transcript quality degradation over time
 *
 * The audio has 24 utterances with realistic gaps: short pauses (3-10s)
 * between rapid-fire commands, plus 5 long silences (60-180s) simulating
 * a user working quietly between voice commands. Total: ~12.3 minutes.
 * The test verifies the system keeps producing transcripts throughout —
 * including AFTER long silence gaps where the session could be killed.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const voiceFixturePath = path.join(__dirname, 'fixtures', 'audio', 'voice-10min-natural.wav');
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

test('@voice voice pipeline stays functional over 10+ minutes of natural usage', async ({ page }) => {
  test.setTimeout(900000); // 15 minute timeout

  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
  await requireQwenVoiceAssets(page);

  // Force qwen backend
  await page.evaluate(async () => {
    (window as any).__VOICE_BACKEND__ = 'qwen';

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

    // Track all voice-related events and errors
    (window as any).__voicePipelineLog = [] as Array<{
      type: string;
      timestampMs: number;
      detail?: any;
    }>;

    const log = (type: string, detail?: any) => {
      (window as any).__voicePipelineLog.push({
        type,
        timestampMs: Date.now(),
        detail,
      });
    };

    // Track transcript updates
    window.addEventListener('voice:latency', (event: Event) => {
      const d = (event as CustomEvent).detail;
      if (d?.type === 'transcript-updated' || d?.type === 'composer-text-updated') {
        log('transcript-update', {
          backend: d.backend,
          transcript: d.transcript?.slice(-80),
          words: d.transcript?.split(/\s+/).length ?? 0,
        });
      }
    });

    // Track errors — this is critical. Voice errors should be visible.
    const origConsoleError = console.error;
    console.error = (...args: any[]) => {
      const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
      if (msg.includes('Voice') || msg.includes('voice') || msg.includes('qwen') || msg.includes('stream')) {
        log('error', { message: msg.slice(0, 200) });
      }
      origConsoleError.apply(console, args);
    };

    // Track send events
    window.addEventListener('agent-runtime:send', (event: Event) => {
      const detail = (event as CustomEvent).detail;
      log('send', {
        text: typeof detail?.text === 'string' ? detail.text.slice(0, 100) : '',
      });
    });
  });

  // Navigate to composer
  const composer = page.locator(sel('mainComposerInput')).first();
  const voiceButton = page.locator(sel('mainComposerVoiceButton')).first();
  const activeVoiceControl = page.locator(
    `${sel('mainComposerVoiceButton')}, ${sel('mainComposerSendButton')}`,
  ).first();

  const composerVisible = await composer.isVisible().catch(() => false);
  if (!composerVisible) {
    const newAgentButton = page.locator(sel('newAgentButton')).first();
    const hasNewAgentButton = await newAgentButton.isVisible().catch(() => false);
    if (hasNewAgentButton) {
      await newAgentButton.click();
    }
  }

  const composerVisibleNow = await composer.isVisible().catch(() => false);
  test.skip(!composerVisibleNow, 'No active agent composer available');

  await expect(composer).toBeVisible({ timeout: 15000 });
  await expect(voiceButton).toBeVisible({ timeout: 15000 });

  // Clear composer
  await composer.click();
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${modifier}+A`);
  await page.keyboard.press('Backspace');

  pauseErrorChecking(page);
  try {
    // Start voice mode
    await voiceButton.click();

    // Wait for the first transcript event rather than DOM text. The qwen
    // pipeline can emit transcript updates before the composer surface has
    // visibly reflected them, especially after warmup.
    await expect.poll(
      async () => await page.evaluate(() => {
        const log = (window as any).__voicePipelineLog as Array<{
          type: string;
          detail?: {
            transcript?: string;
          };
        }>;
        return log.some((event) =>
          event.type === 'transcript-update'
          && typeof event.detail?.transcript === 'string'
          && event.detail.transcript.trim().length > 0
        );
      }),
      { timeout: 60000, message: 'First transcript never appeared' },
    ).toBe(true);

    console.log('[Durability] Voice mode started, first transcript appeared.');

    // Collect data every 30 seconds for the full 10+ minute duration
    const checkpoints: Array<{
      secondsIn: number;
      transcriptUpdates: number;
      errors: number;
      sends: number;
      lastTranscript: string;
    }> = [];

    const TOTAL_DURATION_MS = 750_000; // ~12.5 minutes (slightly longer than 12.3 min audio)
    const CHECKPOINT_INTERVAL_MS = 30_000; // Check every 30 seconds
    const startTime = Date.now();

    for (let elapsed = CHECKPOINT_INTERVAL_MS; elapsed <= TOTAL_DURATION_MS; elapsed += CHECKPOINT_INTERVAL_MS) {
      await page.waitForTimeout(CHECKPOINT_INTERVAL_MS);

      const checkpoint = await page.evaluate(() => {
        const log = (window as any).__voicePipelineLog as Array<{
          type: string;
          timestampMs: number;
          detail?: any;
        }>;
        return {
          transcriptUpdates: log.filter(e => e.type === 'transcript-update').length,
          errors: log.filter(e => e.type === 'error').length,
          sends: log.filter(e => e.type === 'send').length,
          lastTranscript: (() => {
            const updates = log.filter(e => e.type === 'transcript-update');
            const last = updates[updates.length - 1];
            return last?.detail?.transcript ?? '';
          })(),
          errorMessages: log.filter(e => e.type === 'error').map(e => e.detail?.message ?? '').slice(-3),
        };
      });

      const secondsIn = Math.round((Date.now() - startTime) / 1000);
      checkpoints.push({
        secondsIn,
        transcriptUpdates: checkpoint.transcriptUpdates,
        errors: checkpoint.errors,
        sends: checkpoint.sends,
        lastTranscript: checkpoint.lastTranscript,
      });

      console.log(
        '[Durability] %ds: %d updates, %d errors, %d sends | %s',
        secondsIn,
        checkpoint.transcriptUpdates,
        checkpoint.errors,
        checkpoint.sends,
        checkpoint.lastTranscript.slice(-60),
      );

      if (checkpoint.errorMessages.length > 0) {
        console.log('[Durability] Recent errors:', checkpoint.errorMessages);
      }
    }

    // Stop voice mode through the same active voice button.
    await activeVoiceControl.click();
    await page.waitForTimeout(2000);

    // Final snapshot
    const finalLog = await page.evaluate(() => {
      const log = (window as any).__voicePipelineLog as Array<{
        type: string;
        timestampMs: number;
        detail?: any;
      }>;
      return {
        totalEvents: log.length,
        transcriptUpdates: log.filter(e => e.type === 'transcript-update').length,
        errors: log.filter(e => e.type === 'error').length,
        sends: log.filter(e => e.type === 'send').length,
        allErrors: log.filter(e => e.type === 'error').map(e => e.detail?.message ?? ''),
      };
    });

    console.log('\n[Durability] === FINAL REPORT ===');
    console.log('[Durability] Total transcript updates:', finalLog.transcriptUpdates);
    console.log('[Durability] Total errors:', finalLog.errors);
    console.log('[Durability] Total sends:', finalLog.sends);
    if (finalLog.allErrors.length > 0) {
      console.log('[Durability] All errors:');
      for (const err of finalLog.allErrors) {
        console.log('  -', err);
      }
    }

    // === ASSERTIONS ===

    // 1. ZERO errors. Any voice pipeline error is a failure.
    expect(finalLog.errors).toBe(0);

    // 2. Transcript updates should keep happening throughout the session.
    //    The audio has 40 utterances — we should see updates for most of them.
    expect(finalLog.transcriptUpdates).toBeGreaterThan(30);

    // 3. Check that updates happen in BOTH halves of the session.
    //    This catches the SESSION_MAX_AGE_MS = 5min kill bug.
    const halfwayIndex = Math.floor(checkpoints.length / 2);
    const firstHalfUpdates = checkpoints[halfwayIndex - 1]?.transcriptUpdates ?? 0;
    const secondHalfUpdates = finalLog.transcriptUpdates - firstHalfUpdates;

    console.log('[Durability] First half updates:', firstHalfUpdates);
    console.log('[Durability] Second half updates:', secondHalfUpdates);

    // Both halves must have updates. If second half is zero, the pipeline died.
    expect(firstHalfUpdates).toBeGreaterThan(10);
    expect(secondHalfUpdates).toBeGreaterThan(10);

    // 4. No excessively long gaps without updates.
    //    The audio has 60-180 second silence gaps (Star Trek "working quietly" periods),
    //    so we allow gaps up to 210 seconds (7 consecutive 30-second periods).
    //    But any gap longer than that means the pipeline died.
    const MAX_ALLOWED_GAP_PERIODS = 7; // 210 seconds
    let consecutiveEmptyPeriods = 0;
    let maxConsecutiveEmpty = 0;
    for (let i = 1; i < checkpoints.length; i++) {
      const prev = checkpoints[i - 1]!;
      const curr = checkpoints[i]!;
      const updatesDuringPeriod = curr.transcriptUpdates - prev.transcriptUpdates;

      if (updatesDuringPeriod === 0 && i < checkpoints.length - 2) {
        consecutiveEmptyPeriods++;
        maxConsecutiveEmpty = Math.max(maxConsecutiveEmpty, consecutiveEmptyPeriods);
      } else {
        consecutiveEmptyPeriods = 0;
      }
    }
    console.log('[Durability] Max consecutive empty 30s periods:', maxConsecutiveEmpty);
    expect(maxConsecutiveEmpty).toBeLessThanOrEqual(MAX_ALLOWED_GAP_PERIODS);

  } finally {
    resumeErrorChecking(page);
  }
});
