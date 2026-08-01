/**
 * Voice mode integration tests for conversational and push-to-talk modes.
 *
 * Tests that qwen_asr with -S 1 streaming works correctly for:
 * - Conversational: produces transcript during/after speech, VAD silence detection
 *   triggers send, finishSession returns complete transcript
 * - Push-to-talk: releasing key (closing stdin) immediately after speech still
 *   produces full transcript, works for both short and long utterances
 *
 * Uses real qwen_asr binary with generated audio fixtures.
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { describe, test, expect } from 'bun:test';

function findQwenBinary(): { binaryPath: string; modelDir: string } | null {
  const candidates = [
    process.env.QWEN_ASR_ASSET_DIR,
    path.join(process.env.HOME ?? '', 'Library/Application Support/Interpreter/qwen-asr'),
    path.join(process.env.HOME ?? '', 'Library/Application Support/Electron/qwen-asr'),
  ].filter(Boolean) as string[];
  const platformKey = `${process.platform}-${process.arch}`;
  for (const root of candidates) {
    const platformDir = path.join(root, platformKey);
    const binaryName = process.platform === 'win32' ? 'qwen_asr.exe' : 'qwen_asr';
    const binaryPath = path.join(platformDir, binaryName);
    if (!existsSync(binaryPath)) continue;
    for (const modelName of ['qwen3-asr-0.6b', 'qwen-asr']) {
      const modelDir = path.join(platformDir, modelName);
      if (existsSync(modelDir)) return { binaryPath, modelDir };
    }
  }
  return null;
}

const qwenPaths = findQwenBinary();
const describeIfQwen = qwenPaths ? describe : describe.skip;

const CHUNK_SIZE = 2560; // 80ms at 16kHz 16-bit mono
const STREAM_ARGS = ['-S', '1', '--enc-window-sec', '2'];

function loadPcm(filename: string): Buffer {
  const p = path.join(import.meta.dir, 'fixtures/audio', filename);
  if (!existsSync(p)) throw new Error(`Audio fixture not found: ${p}`);
  return readFileSync(p).subarray(44);
}

interface StreamResult {
  /** Transcript fragments as they arrived, with timestamps */
  fragments: Array<{ timeS: number; text: string }>;
  /** Full accumulated transcript */
  fullTranscript: string;
  /** Time of first fragment (seconds) */
  firstFragmentS: number;
  /** Time stdin was closed (seconds) */
  stdinClosedS: number;
  /** Time process exited (seconds) */
  exitS: number;
}

/** Feed audio at realtime speed, optionally with trailing silence, then close stdin. */
async function streamAudio(
  audioFile: string,
  opts: { trailingSilenceMs?: number } = {},
): Promise<StreamResult> {
  const { binaryPath, modelDir } = qwenPaths!;
  const pcm = loadPcm(audioFile);
  const proc = spawn(binaryPath, ['-d', modelDir, '--stdin', '--stream', ...STREAM_ARGS], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const startTime = Date.now();
  const t = () => (Date.now() - startTime) / 1000;
  const fragments: Array<{ timeS: number; text: string }> = [];
  let fullTranscript = '';
  let firstFragmentS = 0;
  let stdinClosedS = 0;

  proc.stdout.on('data', (chunk: Buffer) => {
    const lines = chunk.toString().split(/\r?\n/).map(l => l.trim()).filter(Boolean).filter(l => !l.startsWith('['));
    for (const line of lines) {
      fullTranscript += (fullTranscript ? ' ' : '') + line;
      const timeS = t();
      if (fragments.length === 0) firstFragmentS = timeS;
      fragments.push({ timeS, text: line });
    }
  });
  proc.stderr.on('data', () => {});

  // Feed at realtime
  let offset = 0;
  await new Promise<void>((resolve) => {
    const iv = setInterval(() => {
      for (let i = 0; i < 2 && offset < pcm.length; i++) {
        try { proc.stdin.write(pcm.subarray(offset, offset + CHUNK_SIZE)); } catch { /* ignore */ }
        offset += CHUNK_SIZE;
      }
      if (offset >= pcm.length) {
        clearInterval(iv);
        if (opts.trailingSilenceMs) {
          // Feed silence then close
          const silenceSamples = Math.floor((opts.trailingSilenceMs / 1000) * 16000) * 2;
          const silence = Buffer.alloc(silenceSamples);
          try { proc.stdin.write(silence); } catch { /* ignore */ }
          setTimeout(() => {
            stdinClosedS = t();
            proc.stdin.end();
            resolve();
          }, opts.trailingSilenceMs);
        } else {
          stdinClosedS = t();
          proc.stdin.end();
          resolve();
        }
      }
    }, 80);
  });

  const exitS = await new Promise<number>((resolve) => {
    proc.on('close', () => resolve(t()));
    setTimeout(() => { proc.kill('SIGKILL'); resolve(t()); }, 15000);
  });

  return { fragments, fullTranscript, firstFragmentS, stdinClosedS, exitS };
}

// ---- Push-to-talk tests ----

describeIfQwen('push-to-talk with qwen -S 1', () => {
  test('short utterance: releases immediately, gets full transcript', async () => {
    const result = await streamAudio('ptt-short.wav');
    console.log('  Transcript:', JSON.stringify(result.fullTranscript));
    console.log('  stdin closed:', result.stdinClosedS.toFixed(1) + 's, first fragment:', result.firstFragmentS.toFixed(1) + 's');

    // Must get a transcript
    expect(result.fullTranscript.length).toBeGreaterThan(0);
    // Must contain key words
    expect(result.fullTranscript.toLowerCase()).toContain('light');
    // Final transcript must arrive within 2s of stdin close
    expect(result.exitS - result.stdinClosedS).toBeLessThan(2);
  }, 30000);

  test('long utterance: releases immediately, gets full transcript', async () => {
    const result = await streamAudio('ptt-long.wav');
    console.log('  Transcript:', JSON.stringify(result.fullTranscript));
    console.log('  stdin closed:', result.stdinClosedS.toFixed(1) + 's, fragments:', result.fragments.length);

    expect(result.fullTranscript.length).toBeGreaterThan(0);
    // Must contain key content from the long sentence
    expect(result.fullTranscript.toLowerCase()).toContain('research');
    expect(result.fullTranscript.toLowerCase()).toContain('transformer');
    // Should arrive reasonably fast
    expect(result.exitS - result.stdinClosedS).toBeLessThan(3);
  }, 30000);
});

// ---- Conversational tests ----

describeIfQwen('conversational with qwen -S 1', () => {
  test('produces transcript and finishSession returns complete text', async () => {
    // Simulate: user speaks, then 3s silence, then finishSession (stdin close)
    const result = await streamAudio('conversational-two-turns.wav');
    console.log('  Transcript:', JSON.stringify(result.fullTranscript));
    console.log('  Fragments:', result.fragments.length, 'first at', result.firstFragmentS.toFixed(1) + 's');

    // Must produce at least one fragment during/after speech
    expect(result.fragments.length).toBeGreaterThan(0);
    // Must contain content from the audio
    expect(result.fullTranscript.toLowerCase()).toContain('weather');
    // finishSession (stdin close) must return complete transcript
    expect(result.fullTranscript.toLowerCase()).toContain('restaurant');
  }, 60000);

  test('finishSession after speech+silence returns correct transcript', async () => {
    // Feed short audio + 2s silence (simulates VAD detecting silence and calling finishSession)
    const result = await streamAudio('ptt-short.wav', { trailingSilenceMs: 2000 });
    console.log('  Transcript:', JSON.stringify(result.fullTranscript));
    console.log('  stdin closed:', result.stdinClosedS.toFixed(1) + 's, exit:', result.exitS.toFixed(1) + 's');

    expect(result.fullTranscript.length).toBeGreaterThan(0);
    expect(result.fullTranscript.toLowerCase()).toContain('light');
    // Process should exit quickly after stdin close
    expect(result.exitS - result.stdinClosedS).toBeLessThan(2);
  }, 30000);

  test('interim transcripts arrive during long speech (not just at the end)', async () => {
    // The long audio is ~8s of continuous speech — we should get fragments DURING it
    const result = await streamAudio('ptt-long.wav', { trailingSilenceMs: 2000 });
    console.log('  Fragments:', result.fragments.length);
    console.log('  First at:', result.firstFragmentS.toFixed(1) + 's, stdin closed:', result.stdinClosedS.toFixed(1) + 's');

    // Must get multiple fragments (not everything in one batch at the end)
    expect(result.fragments.length).toBeGreaterThan(1);
    // First fragment should arrive before stdin is closed (during speech, not after)
    expect(result.firstFragmentS).toBeLessThan(result.stdinClosedS);
  }, 30000);
});
