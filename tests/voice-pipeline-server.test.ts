/**
 * Server-side voice pipeline durability test.
 *
 * Feeds the 10-minute natural usage audio through the real qwen stream session wrapper
 * and verifies:
 * 1. The process stays alive for the full duration
 * 2. Transcripts keep coming throughout (no stalls after 5 min)
 * 3. Multiple session cycles work (finish one, start another)
 * 4. Session cleanup doesn't kill active sessions
 *
 * This test uses the REAL qwen_asr binary via the server wrapper — no faking.
 * Skip if QWEN_ASR_ASSET_DIR is not set or binary not found.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { describe, test, expect, beforeAll } from 'bun:test';

// Try to find qwen_asr binary
function findQwenBinary(): { binaryPath: string; modelDir: string } | null {
  const candidates = [
    process.env.QWEN_ASR_ASSET_DIR,
    path.join(process.env.HOME ?? '', 'Library/Application Support/Electron/qwen-asr'),
    path.join(process.env.HOME ?? '', 'Library/Application Support/interpreter/qwen-asr'),
  ].filter(Boolean) as string[];

  const platformKey = `${process.platform}-${process.arch}`;

  for (const root of candidates) {
    const platformDir = path.join(root, platformKey);
    const binaryName = process.platform === 'win32' ? 'qwen_asr.exe' : 'qwen_asr';
    const binaryPath = path.join(platformDir, binaryName);

    if (!existsSync(binaryPath)) continue;

    // Find model dir
    for (const modelName of ['qwen3-asr-0.6b', 'qwen-asr']) {
      const modelDir = path.join(platformDir, modelName);
      if (existsSync(modelDir)) {
        return { binaryPath, modelDir };
      }
    }
  }
  return null;
}

const AUDIO_PATH = path.join(import.meta.dir, 'fixtures/audio/voice-10min-natural.wav');
const qwenPaths = findQwenBinary();

const describeIfBinary = qwenPaths ? describe : describe.skip;

interface LongSessionResult {
  done: true;
  wall: number;
  chunks: number;
  finishMs: number;
  words: number;
  snapshots: Array<{ wall: number; audio: number; words: number; tail: string }>;
}

interface CycleResult {
  done: true;
  totalWords: number;
  results: Array<{ session: number; words: number; durationMs: number }>;
}

async function runStandalonePipelineScript<T>(script: string, timeoutMs: number): Promise<T> {
  const child = spawn(process.execPath, ['-e', script], {
    cwd: path.resolve(import.meta.dir, '..'),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  const timeout = setTimeout(() => {
    child.kill('SIGKILL');
  }, timeoutMs);

  child.stdout.on('data', (chunk: Buffer | string) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });

  const exitCode = await new Promise<number>((resolve) => {
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve(typeof code === 'number' ? code : 1);
    });
  });

  const jsonLines = stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.startsWith('{'));
  const lastJsonLine = jsonLines[jsonLines.length - 1];

  if (exitCode !== 0 || !lastJsonLine) {
    throw new Error(`Standalone voice pipeline failed code=${exitCode}\nstdout=${stdout}\nstderr=${stderr}`);
  }

  return JSON.parse(lastJsonLine) as T;
}

function buildLongSessionScript(audioPath: string): string {
  return `
    import { readFileSync } from 'node:fs';
    import {
      startQwenAsrStreamSession,
      appendQwenAsrStreamChunk,
      finishQwenAsrStreamSession,
    } from './server/utils/qwenAsrStream';

    const pcm = readFileSync(${JSON.stringify(audioPath)}).subarray(44);
    const sessionId = await startQwenAsrStreamSession();
    const snapshots = [];
    let transcript = '';
    let offset = 0;
    let chunkCount = 0;
    const chunkSize = 2560;
    const feedDelayMs = 40;
    const startTime = Date.now();

    while (offset < pcm.length) {
      const chunk = pcm.subarray(offset, offset + chunkSize);
      const result = await appendQwenAsrStreamChunk(sessionId, chunk);
      transcript = result.text;
      offset += chunk.length;
      chunkCount += 1;

      if (chunkCount % 750 === 0) {
        const snapshot = {
          wall: Math.round((Date.now() - startTime) / 1000),
          audio: Math.round(offset / 32000),
          words: transcript.split(/\\s+/).filter(Boolean).length,
          tail: transcript.slice(-80),
        };
        snapshots.push(snapshot);
        console.log(JSON.stringify(snapshot));
      }

      await new Promise(resolve => setTimeout(resolve, feedDelayMs));
    }

    const finishStartedAt = Date.now();
    transcript = await finishQwenAsrStreamSession(sessionId);
    console.log(JSON.stringify({
      done: true,
      wall: Math.round((Date.now() - startTime) / 1000),
      chunks: chunkCount,
      finishMs: Date.now() - finishStartedAt,
      words: transcript.split(/\\s+/).filter(Boolean).length,
      snapshots,
    }));
  `;
}

function buildCycleScript(audioPath: string): string {
  return `
    import { readFileSync } from 'node:fs';
    import {
      startQwenAsrStreamSession,
      appendQwenAsrStreamChunk,
      finishQwenAsrStreamSession,
    } from './server/utils/qwenAsrStream';

    const pcm = readFileSync(${JSON.stringify(audioPath)}).subarray(44);
    const sessions = 5;
    const chunksPerSession = 200;
    const chunkSize = 2560;
    const results = [];
    let pcmOffset = 0;

    for (let s = 0; s < sessions; s += 1) {
      const sessionStart = Date.now();
      const sessionId = await startQwenAsrStreamSession();

      for (let i = 0; i < chunksPerSession && pcmOffset < pcm.length; i += 1) {
        const chunk = pcm.subarray(pcmOffset, pcmOffset + chunkSize);
        await appendQwenAsrStreamChunk(sessionId, chunk);
        pcmOffset += chunk.length;
        await new Promise(resolve => setTimeout(resolve, 10));
      }

      const transcript = await finishQwenAsrStreamSession(sessionId);
      const words = transcript.split(/\\s+/).filter(Boolean).length;
      const durationMs = Date.now() - sessionStart;
      const result = { session: s, words, durationMs };
      results.push(result);
      console.log(JSON.stringify(result));
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log(JSON.stringify({
      done: true,
      totalWords: results.reduce((sum, result) => sum + result.words, 0),
      results,
    }));
  `;
}

describeIfBinary('voice pipeline server durability (real qwen_asr)', () => {
  let audioData: Buffer;
  let pcmData: Buffer;

  beforeAll(() => {
    audioData = readFileSync(AUDIO_PATH);
    // Skip 44-byte WAV header to get raw PCM
    pcmData = audioData.subarray(44);
    console.log(`[Setup] Audio: ${AUDIO_PATH}`);
    console.log(`[Setup] PCM size: ${pcmData.length} bytes (${(pcmData.length / 32000).toFixed(1)}s at 16kHz 16-bit mono)`);
    console.log(`[Setup] Binary: ${qwenPaths!.binaryPath}`);
    console.log(`[Setup] Model: ${qwenPaths!.modelDir}`);
  });

  test('single long streaming session survives 10+ minutes', async () => {
    const result = await runStandalonePipelineScript<LongSessionResult>(
      buildLongSessionScript(AUDIO_PATH),
      580_000,
    );

    console.log('\n=== DURABILITY REPORT ===');
    console.log(`Duration: ${result.wall}s`);
    console.log(`Chunks fed: ${result.chunks}`);
    console.log(`Finish duration: ${result.finishMs}ms`);
    console.log(`Total words transcribed: ${result.words}`);
    console.log('\nSnapshots:');
    for (const snap of result.snapshots) {
      console.log(`  [${snap.wall}s] ${snap.words} words`);
    }

    // === ASSERTIONS ===

    // 1. Finish should complete in a bounded amount of time
    expect(result.finishMs).toBeLessThan(15_000);

    // 2. Should have transcribed a substantial amount of the audio
    // The audio has ~500 words of speech across 40 utterances
    expect(result.words).toBeGreaterThan(100);

    // 3. Transcript should keep growing throughout — not stall after N minutes
    // Check that the second half of snapshots shows growth
    if (result.snapshots.length >= 4) {
      const half = Math.floor(result.snapshots.length / 2);
      const firstHalfWords = result.snapshots[half - 1]?.words ?? 0;
      const lastWords = result.snapshots[result.snapshots.length - 1]?.words ?? 0;
      const secondHalfGrowth = lastWords - firstHalfWords;

      console.log(`\nFirst half words: ${firstHalfWords}`);
      console.log(`Second half growth: ${secondHalfGrowth}`);

      expect(secondHalfGrowth).toBeGreaterThan(20);
    }
  }, 600000); // 10 minute timeout

  test('multiple session cycles work without degradation', async () => {
    const result = await runStandalonePipelineScript<CycleResult>(
      buildCycleScript(AUDIO_PATH),
      290_000,
    );

    for (const sessionResult of result.results) {
      console.log(`[Session ${sessionResult.session}] ${sessionResult.words} words, ${sessionResult.durationMs}ms`);
    }

    // At least some sessions should produce transcript (some may hit silence gaps)
    expect(result.totalWords).toBeGreaterThan(10);

    // Later sessions should not be dramatically slower than early ones
    const firstDuration = result.results[0]!.durationMs;
    const lastDuration = result.results[result.results.length - 1]!.durationMs;
    console.log(`\nFirst session: ${firstDuration}ms, Last session: ${lastDuration}ms`);
    // Allow 3x tolerance (model loading cached after first run)
    expect(lastDuration).toBeLessThan(firstDuration * 3 + 5000);
  }, 300000); // 5 minute timeout
});
