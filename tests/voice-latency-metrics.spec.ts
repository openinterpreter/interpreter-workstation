import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { test, expect, pauseErrorChecking, resumeErrorChecking } from './fixtures';
import { sel } from './selectors';
import { ElectronInstanceManager } from './electron-instance';
import { applyEnv, requireQwenVoiceAssets, snapshotEnv, type EnvSnapshot } from './voice-test-utils';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const voiceFixturePath = path.join(__dirname, 'fixtures', 'audio', 'voice-latency-words-20.wav');
const wordTimingPath = path.join(__dirname, 'fixtures', 'audio', 'voice-latency-words-20.meta.tsv');
let envSnapshot: EnvSnapshot;

test.beforeAll(() => {
  envSnapshot = snapshotEnv(['TEST_FAKE_AUDIO_FILE', 'TEST_FAKE_ASR_TEXT']);
  applyEnv({
    TEST_FAKE_AUDIO_FILE: voiceFixturePath,
    TEST_FAKE_ASR_TEXT: undefined,
  });
});

type WordTiming = {
  word: string;
  endMs: number;
};

type VoiceLatencyEvent = {
  type: string;
  timestampMs: number;
  surface?: string;
  backend?: string;
  text?: string;
  silenceTimeoutMs?: number;
};

type FetchEvent = {
  timestampMs: number;
  url: string;
};

function readWordTimings(filePath: string): WordTiming[] {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const rows = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const timings: WordTiming[] = [];
  for (const row of rows) {
    const [word, endMsRaw] = row.split('\t');
    const endMs = Number.parseFloat(endMsRaw ?? '');
    if (!word || Number.isNaN(endMs)) continue;
    timings.push({ word: normalizeToken(word), endMs });
  }
  return timings;
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((token) => normalizeToken(token))
    .filter(Boolean);
}

function percentile(sortedValues: number[], percentileValue: number): number {
  if (sortedValues.length === 0) return Number.NaN;
  const index = (percentileValue / 100) * (sortedValues.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const lowerValue = sortedValues[lower] ?? sortedValues[sortedValues.length - 1] ?? Number.NaN;
  const upperValue = sortedValues[upper] ?? sortedValues[sortedValues.length - 1] ?? Number.NaN;
  if (lower === upper) return lowerValue;
  return lowerValue + ((upperValue - lowerValue) * (index - lower));
}

function summarizeLatencies(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) {
    return {
      count: 0,
      minMs: Number.NaN,
      maxMs: Number.NaN,
      avgMs: Number.NaN,
      p50Ms: Number.NaN,
      p90Ms: Number.NaN,
      p95Ms: Number.NaN,
    };
  }

  const sum = sorted.reduce((acc, value) => acc + value, 0);
  return {
    count: sorted.length,
    minMs: sorted[0] ?? Number.NaN,
    maxMs: sorted[sorted.length - 1] ?? Number.NaN,
    avgMs: sum / sorted.length,
    p50Ms: percentile(sorted, 50),
    p90Ms: percentile(sorted, 90),
    p95Ms: percentile(sorted, 95),
  };
}

function roundMetric(value: number): number {
  if (!Number.isFinite(value)) return value;
  return Math.round(value * 10) / 10;
}

function roundedSummary(summary: ReturnType<typeof summarizeLatencies>) {
  return {
    ...summary,
    minMs: roundMetric(summary.minMs),
    maxMs: roundMetric(summary.maxMs),
    avgMs: roundMetric(summary.avgMs),
    p50Ms: roundMetric(summary.p50Ms),
    p90Ms: roundMetric(summary.p90Ms),
    p95Ms: roundMetric(summary.p95Ms),
  };
}

const expectedWordTimings = readWordTimings(wordTimingPath);
const expectedWords = expectedWordTimings.map((entry) => entry.word);

test.afterAll(async () => {
  applyEnv(envSnapshot);
  ElectronInstanceManager.invalidate();
});

test.skip(
  process.platform === 'darwin' && Boolean(process.env.CI),
  'Diagnostic voice latency coverage is unstable on macOS CI and remains covered on Linux and Windows CI.',
);

test('@voice voice mode reports detailed latency metrics for live composer updates and send handoff', async ({ page }) => {
  test.setTimeout(300000);

  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
  await requireQwenVoiceAssets(page);

  await page.evaluate(async () => {
    (window as any).__VOICE_BACKEND__ = 'qwen';
    (window as any).__voiceLatencyEvents = [];
    (window as any).__voiceFetchEvents = [];

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

    const voiceWindow = window as any;
    if (!voiceWindow.__voiceFetchPatched) {
      const originalFetch = window.fetch.bind(window);
      voiceWindow.__voiceFetchPatched = true;
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
        if (url.includes('/api/agent/chat/stream')) {
          voiceWindow.__voiceFetchEvents.push({
            timestampMs: performance.now(),
            url,
          });
        }
        return originalFetch(input, init);
      };
    }
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

  let captured: { events: VoiceLatencyEvent[]; fetchEvents: FetchEvent[] } | null = null;

  pauseErrorChecking(page);
  try {
    // Empty main composer voice button enters voice mode.
    await voiceButton.click();

    await expect.poll(
      async () => await page.evaluate(() => {
        const events = (window as any).__voiceLatencyEvents as Array<{ type: string; surface?: string }>;
        return events.filter(event => event.type === 'voice-send-triggered' && event.surface === 'main-composer').length;
      }),
      { timeout: 120000 },
    ).toBeGreaterThan(0);

    await expect.poll(
      async () => await page.evaluate(() => (window as any).__voiceFetchEvents.length as number),
      { timeout: 30000 },
    ).toBeGreaterThan(0);
    captured = await page.evaluate(() => {
      return {
        events: (window as any).__voiceLatencyEvents ?? [],
        fetchEvents: (window as any).__voiceFetchEvents ?? [],
      };
    }) as { events: VoiceLatencyEvent[]; fetchEvents: FetchEvent[] };
  } finally {
    resumeErrorChecking(page);
  }

  expect(captured).toBeTruthy();
  const safeCaptured = captured as { events: VoiceLatencyEvent[]; fetchEvents: FetchEvent[] };

  const qwenMainComposerEvents = safeCaptured.events
    .filter((event) => event.type === 'composer-text-updated' && event.surface === 'main-composer' && event.backend === 'qwen')
    .sort((a, b) => a.timestampMs - b.timestampMs);

  const audioStartEvent = safeCaptured.events.find((event) => event.type === 'capture-audio-started' && event.backend === 'qwen');
  expect(audioStartEvent).toBeTruthy();

  const audioStartMs = audioStartEvent?.timestampMs ?? Number.NaN;
  const firstSeenWordAtMs = new Map<string, number>();
  const expectedWordSet = new Set(expectedWords);

  for (const updateEvent of qwenMainComposerEvents) {
    const transcript = typeof updateEvent.text === 'string' ? updateEvent.text : '';
    const tokens = tokenize(transcript);
    for (const token of tokens) {
      if (!expectedWordSet.has(token)) continue;
      if (firstSeenWordAtMs.has(token)) continue;
      firstSeenWordAtMs.set(token, updateEvent.timestampMs);
    }
  }

  const wordLatencies: Array<{ word: string; latencyMs: number }> = [];
  const missingWords: string[] = [];

  for (const timing of expectedWordTimings) {
    const firstSeenMs = firstSeenWordAtMs.get(timing.word);
    if (typeof firstSeenMs !== 'number') {
      missingWords.push(timing.word);
      continue;
    }
    const expectedWordEndMs = audioStartMs + timing.endMs;
    wordLatencies.push({
      word: timing.word,
      latencyMs: firstSeenMs - expectedWordEndMs,
    });
  }

  expect(wordLatencies.length).toBeGreaterThan(0);

  const lastWordEndMs = expectedWordTimings[expectedWordTimings.length - 1]?.endMs ?? Number.NaN;
  const doneSpeakingMs = audioStartMs + lastWordEndMs;
  const firstSpeechEnded = safeCaptured.events.find((event) => event.type === 'speech-ended' && event.backend === 'qwen');
  const firstVoiceSend = safeCaptured.events.find((event) => event.type === 'voice-send-triggered' && event.surface === 'main-composer');
  const firstFetch = safeCaptured.fetchEvents[0];

  expect(firstVoiceSend).toBeTruthy();
  expect(firstFetch).toBeTruthy();

  const wordLatencySummary = roundedSummary(summarizeLatencies(wordLatencies.map((entry) => entry.latencyMs)));
  const speechEndToSendMs = firstSpeechEnded ? firstVoiceSend!.timestampMs - firstSpeechEnded.timestampMs : Number.NaN;
  const doneToSendMs = firstVoiceSend!.timestampMs - doneSpeakingMs;
  const doneToModelFetchMs = firstFetch.timestampMs - doneSpeakingMs;
  const speechEndToModelFetchMs = firstSpeechEnded
    ? firstFetch.timestampMs - firstSpeechEnded.timestampMs
    : Number.NaN;

  const report = {
    fixture: {
      audioPath: voiceFixturePath,
      durationMs: Math.round(lastWordEndMs),
      expectedWordCount: expectedWordTimings.length,
      matchedWordCount: wordLatencies.length,
      missingWords,
    },
    thresholds: {
      wordToComposerTargetMs: 800,
      doneToModelTargetMs: 700,
    },
    wordToComposer: {
      summary: wordLatencySummary,
      thresholdCheck: {
        p90WithinTarget: Number.isFinite(wordLatencySummary.p90Ms) && wordLatencySummary.p90Ms <= 800,
        maxWithinTarget: Number.isFinite(wordLatencySummary.maxMs) && wordLatencySummary.maxMs <= 800,
      },
      samples: wordLatencies.slice(0, 8).map((entry) => ({
        word: entry.word,
        latencyMs: roundMetric(entry.latencyMs),
      })),
    },
    sendHandoff: {
      doneSpeakingToVoiceSendMs: roundMetric(doneToSendMs),
      doneSpeakingToModelFetchMs: roundMetric(doneToModelFetchMs),
      speechEndDetectedToVoiceSendMs: roundMetric(speechEndToSendMs),
      speechEndDetectedToModelFetchMs: roundMetric(speechEndToModelFetchMs),
      thresholdCheck: {
        doneToModelWithinTarget: Number.isFinite(doneToModelFetchMs) && doneToModelFetchMs >= 0 && doneToModelFetchMs <= 700,
        speechEndToModelWithinTarget: Number.isFinite(speechEndToModelFetchMs) && speechEndToModelFetchMs >= 0 && speechEndToModelFetchMs <= 700,
      },
    },
  };

  console.log('[VoiceLatencyMetrics]', JSON.stringify(report, null, 2));
});
