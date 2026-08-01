import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Writable } from 'node:stream';
import {
  _formatUnexpectedProcessCloseMessageForTest,
  _resolveSpeechRecognizerPathForTest,
  _writeChunkToProcessStdinForTest,
  startQwenAsrStreamSession,
  appendQwenAsrStreamChunk,
  finishQwenAsrStreamSession,
  abortQwenAsrStreamSession,
} from './qwenAsrStream';
import type { StreamProcessRef } from './qwenAsrStream';

/**
 * Tests that the streaming STT session maintains constant latency
 * even when fed many chunks over an extended period (simulating 60+ seconds of speech).
 *
 * Uses TEST_FAKE_ASR_TEXT so no real qwen_asr binary is needed.
 */

const FAKE_TRANSCRIPT = 'This is a long test transcript that simulates real speech over sixty seconds of continuous talking';

beforeAll(() => {
  process.env.TEST_FAKE_ASR_TEXT = FAKE_TRANSCRIPT;
});

afterAll(() => {
  delete process.env.TEST_FAKE_ASR_TEXT;
});

function makeFakePcmChunk(sizeBytes = 2560): Buffer {
  // 80ms of 16kHz 16-bit mono PCM = 2560 bytes
  return Buffer.alloc(sizeBytes);
}

function makeProcessStub(stdin: Writable, exitCode: number | null = null): StreamProcessRef {
  return {
    stdin,
    killed: false,
    exitCode,
  };
}

describe('qwenAsrStream latency', () => {
  test('chunk response latency stays constant over 750 chunks (simulating ~60s of speech)', async () => {
    const sessionId = await startQwenAsrStreamSession();
    expect(sessionId).toBeTruthy();

    const TOTAL_CHUNKS = 750; // 750 * 80ms = 60 seconds of audio
    const chunk = makeFakePcmChunk();

    const latencies: number[] = [];

    for (let i = 0; i < TOTAL_CHUNKS; i++) {
      const start = performance.now();
      const transcript = await appendQwenAsrStreamChunk(sessionId, chunk);
      const elapsed = performance.now() - start;
      latencies.push(elapsed);

      // Verify we always get the transcript back
      if (i === 0) {
        expect(transcript).toBeTruthy();
      }
    }

    // Finish the session
    const finalTranscript = await finishQwenAsrStreamSession(sessionId);
    expect(finalTranscript).toBeTruthy();

    // Analyze latency: compare first 100 chunks vs last 100 chunks
    const firstBatch = latencies.slice(0, 100);
    const lastBatch = latencies.slice(-100);

    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const p95 = (arr: number[]) => {
      const sorted = [...arr].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    };

    const firstAvg = avg(firstBatch);
    const lastAvg = avg(lastBatch);
    const firstP95 = p95(firstBatch);
    const lastP95 = p95(lastBatch);

    console.log('[StreamLatency] First 100 chunks: avg=%.2fms p95=%.2fms', firstAvg, firstP95);
    console.log('[StreamLatency] Last 100 chunks:  avg=%.2fms p95=%.2fms', lastAvg, lastP95);
    console.log('[StreamLatency] Degradation ratio (last/first avg): %.2fx', lastAvg / firstAvg);

    // The last batch should not be more than 5x slower than the first batch.
    // With the old non-streaming approach, this ratio would be 10-100x+.
    // With proper streaming, it should be ~1x.
    expect(lastAvg / firstAvg).toBeLessThan(5);
    expect(lastP95).toBeLessThan(firstP95 * 5 + 1); // +1ms tolerance for near-zero values
  });

  test('starting a fresh session after finishing one has no carryover latency', async () => {
    // First session: send 500 chunks
    const session1 = await startQwenAsrStreamSession();
    const chunk = makeFakePcmChunk();
    for (let i = 0; i < 500; i++) {
      await appendQwenAsrStreamChunk(session1, chunk);
    }
    await finishQwenAsrStreamSession(session1);

    // Second session: should be just as fast as the start of session 1
    const session2 = await startQwenAsrStreamSession();
    const latencies: number[] = [];
    for (let i = 0; i < 50; i++) {
      const start = performance.now();
      await appendQwenAsrStreamChunk(session2, chunk);
      latencies.push(performance.now() - start);
    }
    await finishQwenAsrStreamSession(session2);

    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    console.log('[StreamLatency] Fresh session avg: %.2fms', avg);

    // Fresh session should be fast (< 1ms for fake mode)
    expect(avg).toBeLessThan(5);
  });

  test('abort cleans up session without errors', async () => {
    const sessionId = await startQwenAsrStreamSession();
    const chunk = makeFakePcmChunk();

    for (let i = 0; i < 100; i++) {
      await appendQwenAsrStreamChunk(sessionId, chunk);
    }

    // Abort should not throw
    await abortQwenAsrStreamSession(sessionId);

    // Appending to aborted session should throw
    await expect(appendQwenAsrStreamChunk(sessionId, chunk)).rejects.toThrow();
  });
});

describe('qwenAsrStream stdin writes', () => {
  test('returns false for EPIPE-style stdin errors without double-recording them', async () => {
    const stdin = new Writable({
      write(_chunk, _encoding, _callback) {
        const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
        queueMicrotask(() => {
          this.emit('error', error);
        });
        // Simulate the real-world path where stdin emits an async error
        // and write callback never completes.
      },
    });

    let callbackErrorCount = 0;
    const ok = await _writeChunkToProcessStdinForTest(
      makeProcessStub(stdin),
      Buffer.from([1, 2, 3]),
      50,
      () => {
        callbackErrorCount++;
      },
    );

    expect(ok).toBe(false);
    expect(callbackErrorCount).toBe(0);
  });

  test('returns false immediately when process stdin is already unavailable', async () => {
    const stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback(null);
      },
    });

    const ok = await _writeChunkToProcessStdinForTest(
      makeProcessStub(stdin, 1),
      Buffer.from([1, 2, 3]),
      50,
    );
    expect(ok).toBe(false);
  });
});

describe('qwenAsrStream diagnostics', () => {
  test('resolves native recognizer from the shared helper path in development', () => {
    const helperPath = '/repo/dist-electron/interpreter-overlay/speech-recognizer';
    const resolved = _resolveSpeechRecognizerPathForTest(
      'darwin',
      () => helperPath,
      (candidate) => candidate === helperPath,
    );

    expect(resolved).toBe(helperPath);
  });

  test('returns null when the shared native helper path does not exist', () => {
    const resolved = _resolveSpeechRecognizerPathForTest(
      'darwin',
      () => '/missing/speech-recognizer',
      () => false,
    );

    expect(resolved).toBeNull();
  });

  test('formats unexpected process closes with the stderr tail', () => {
    const message = _formatUnexpectedProcessCloseMessageForTest({
      sessionId: 'session-1',
      recognizer: 'qwen_asr',
      exitCode: 1,
      stderrBuffer: 'line1\nline2\nline3\nline4',
      isClosing: false,
    });

    expect(message).toBe('[VoiceStream] qwen_asr closed unexpectedly session=session-1 code=1 stderr="line2 | line3 | line4"');
  });

  test('skips close diagnostics for expected shutdown', () => {
    const message = _formatUnexpectedProcessCloseMessageForTest({
      sessionId: 'session-1',
      recognizer: 'qwen_asr',
      exitCode: 0,
      stderrBuffer: '',
      isClosing: true,
    });

    expect(message).toBeNull();
  });
});
