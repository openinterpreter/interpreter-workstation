import path from 'path';
import { fileURLToPath } from 'url';
import { test, expect, pauseErrorChecking, resumeErrorChecking } from './fixtures';
import { sel } from './selectors';
import { ElectronInstanceManager } from './electron-instance';
import { applyEnv, requireQwenVoiceAssets, snapshotEnv, type EnvSnapshot } from './voice-test-utils';

/**
 * This test feeds ~80 seconds of real TTS-generated speech into the streaming
 * voice pipeline and measures transcript update latency over time.
 *
 * The key assertion: latency at the END of the recording should not be
 * significantly worse than latency at the START. If it degrades, the system
 * is re-processing accumulated audio rather than streaming incrementally.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const voiceFixturePath = path.join(__dirname, 'fixtures', 'audio', 'voice-streaming-60s.wav');
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

test('@voice streaming voice latency stays constant over 60+ seconds of continuous speech', async ({ page }) => {
  test.setTimeout(300000); // 5 minute timeout

  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
  await requireQwenVoiceAssets(page);

  // Force qwen streaming backend and set up event tracking
  await page.evaluate(async () => {
    (window as any).__VOICE_BACKEND__ = 'qwen';
    (window as any).__voiceLatencyEvents = [];

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

    window.addEventListener('voice:latency', (event: Event) => {
      const detail = (event as CustomEvent).detail;
      (window as any).__voiceLatencyEvents.push(detail);
    });
  });

  // Find composer and send button
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

    // Wait for the first transcript event rather than DOM text. The streaming
    // backend can emit latency events before the composer surface visibly
    // reflects the transcript.
    await expect.poll(
      async () => await page.evaluate(() => {
        const events = (window as any).__voiceLatencyEvents as Array<{
          type?: string;
          backend?: string;
          text?: string;
          transcript?: string;
        }>;
        return events.some((event) => {
          const text = typeof event?.text === 'string'
            ? event.text
            : typeof event?.transcript === 'string'
              ? event.transcript
              : '';
          return event?.backend === 'qwen' && text.trim().length > 0;
        });
      }),
      { timeout: 60000 },
    ).toBe(true);

    console.log('[StreamingLatency] Voice mode started, transcript appearing...');

    // Let it run for 65 seconds to collect latency data across the full recording
    console.log('[StreamingLatency] Collecting data for 65 seconds...');
    await page.waitForTimeout(65000);

    // Stop voice mode by clicking the stop button
    await activeVoiceControl.click();
    await page.waitForTimeout(2000);

    // Collect all latency events
    const latencyEvents = await page.evaluate(() => {
      return (window as any).__voiceLatencyEvents ?? [];
    }) as Array<{ type: string; timestampMs: number; text?: string; backend?: string; transcript?: string }>;

    // Analyze transcript-updated events (these are the streaming chunk responses)
    const updateEvents = latencyEvents
      .filter(e => e.type === 'transcript-updated' && e.backend === 'qwen')
      .sort((a, b) => a.timestampMs - b.timestampMs);

    // Also check composer-text-updated events
    const composerUpdates = latencyEvents
      .filter(e => e.type === 'composer-text-updated' && e.backend === 'qwen')
      .sort((a, b) => a.timestampMs - b.timestampMs);

    const allUpdates = updateEvents.length > 0 ? updateEvents : composerUpdates;
    console.log('[StreamingLatency] transcript-updated events: %d', updateEvents.length);
    console.log('[StreamingLatency] composer-text-updated events: %d', composerUpdates.length);

    expect(allUpdates.length).toBeGreaterThan(20);

    // Measure gaps between consecutive updates
    const gaps: number[] = [];
    for (let i = 1; i < allUpdates.length; i++) {
      gaps.push(allUpdates[i]!.timestampMs - allUpdates[i - 1]!.timestampMs);
    }

    // Split into quarters
    const quarterSize = Math.floor(gaps.length / 4);
    const firstQuarter = gaps.slice(0, quarterSize);
    const lastQuarter = gaps.slice(-quarterSize);

    const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const p95 = (arr: number[]) => {
      if (!arr.length) return 0;
      const sorted = [...arr].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1] ?? 0;
    };

    const earlyAvg = avg(firstQuarter);
    const lateAvg = avg(lastQuarter);
    const earlyP95 = p95(firstQuarter);
    const lateP95 = p95(lastQuarter);

    // Also track transcript length growth
    const firstText = allUpdates[0]?.text ?? allUpdates[0]?.transcript ?? '';
    const lastText = allUpdates[allUpdates.length - 1]?.text ?? allUpdates[allUpdates.length - 1]?.transcript ?? '';

    const report = {
      totalUpdates: allUpdates.length,
      firstTranscriptWords: firstText.split(/\s+/).length,
      lastTranscriptWords: lastText.split(/\s+/).length,
      updateGaps: {
        early: {
          avgMs: Math.round(earlyAvg),
          p95Ms: Math.round(earlyP95),
          count: firstQuarter.length,
        },
        late: {
          avgMs: Math.round(lateAvg),
          p95Ms: Math.round(lateP95),
          count: lastQuarter.length,
        },
      },
      degradation: {
        avgRatio: Math.round((lateAvg / earlyAvg) * 100) / 100,
        p95Ratio: earlyP95 > 0 ? Math.round((lateP95 / earlyP95) * 100) / 100 : 'N/A',
      },
    };

    // Sample transcripts from early, middle, and late
    const getTranscript = (e: typeof allUpdates[0]) => e?.text ?? e?.transcript ?? '';
    const sampleIndices = [
      0,
      Math.floor(allUpdates.length * 0.25),
      Math.floor(allUpdates.length * 0.5),
      Math.floor(allUpdates.length * 0.75),
      allUpdates.length - 1,
    ];
    const samples = sampleIndices.map(i => ({
      index: i,
      secondsIn: Math.round((allUpdates[i]!.timestampMs - allUpdates[0]!.timestampMs) / 1000),
      transcript: getTranscript(allUpdates[i]!),
    }));

    console.log('[StreamingLatency] Report:', JSON.stringify(report, null, 2));
    console.log('[StreamingLatency] Transcript samples:');
    for (const s of samples) {
      console.log('  [%ds] (%d words) %s', s.secondsIn, s.transcript.split(/\s+/).length, s.transcript);
    }

    // KEY ASSERTION: late updates should not be more than 3x slower than early ones.
    // Old batch approach: 10-100x degradation. Streaming: should be ~1x.
    if (earlyAvg > 0) {
      expect(report.degradation.avgRatio).toBeLessThan(3);
    }
  } finally {
    resumeErrorChecking(page);
  }
});
