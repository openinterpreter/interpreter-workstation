import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Writable } from 'node:stream';
import { DEFAULT_STT_SETTINGS } from '../../shared/types/stt';
import { getInterpreterOverlayNativeHelperPath } from '../../apps/interpreter-overlay/runtime/infra/native-helper-paths';
import { getLanguage, getSttSettings } from '../configStore';
import { resolveBundledQwenPaths, sanitizeQwenTranscriptForLanguage } from './qwenAsr';
import { createSileroVadInstance, type SileroVadInstance } from './sileroVadService';

// Sessions are only cleaned up via explicit finish/abort calls from the client.
// The idle timeout is a safety net for leaked sessions (e.g. client crashed
// without calling abort). Set it very long — voice mode may be "on" for hours
// with no speech (Star Trek computer pattern).
const SESSION_IDLE_TIMEOUT_MS = 60 * 60_000; // 1 hour
const CLEANUP_INTERVAL_MS = 10_000;
const FINISH_STREAM_CLOSE_TIMEOUT_MS = 8_000;
const FINISH_STREAM_QUIET_PERIOD_MS = 1_500;
const FINISH_STREAM_TERM_GRACE_MS = 1_500;
// Streaming args for live dictation.
// -S 1: Segment every ~1 second — forces qwen_asr to produce incremental
// output DURING streaming instead of waiting for stdin EOF. This is the key
// flag that makes real-time transcription work.
// --enc-window-sec 2: Reduce encoder attention window from 8s to 2s for
// faster per-segment processing.
const DEFAULT_STREAM_ARGS: readonly string[] = ['-S', '1', '--enc-window-sec', '2'];
const DEFAULT_NATIVE_RECOGNIZER_LOCALE = 'en-US';
const STREAM_WRITE_TIMEOUT_MS = 3000;
const QWEN_STREAM_CYCLE_AUDIO_BYTES = 16_000 * 2 * 25;
const QWEN_STREAM_CYCLE_OVERLAP_CHUNKS = 15;
const NATIVE_RECOGNIZER_LOCALE_BY_LANGUAGE: Readonly<Record<string, string>> = {
  en: 'en-US',
  es: 'es-ES',
  ja: 'ja-JP',
  ko: 'ko-KR',
  'zh-cn': 'zh-CN',
};
// Ring buffer for last 8 seconds of PCM audio (16kHz Float32) = 128,000 samples
const PCM_RING_BUFFER_SAMPLES = 128_000;
const VOICE_DEBUG = !!process.env.VOICE_DEBUG;

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export interface StreamChunkResult {
  text: string;
  isSpeech: boolean;
}

interface StreamSession {
  id: string;
  process: ChildProcessWithoutNullStreams | null;
  qwenBinaryPath: string | null;
  qwenArgs: string[] | null;
  qwenCycleAudioBytes: number;
  qwenCycleOverlapChunks: Buffer[];
  qwenCycleFinalizers: Set<Promise<void>>;
  createdAt: number;
  lastTouchedAt: number;
  language: string | null;
  stripChineseCharacters: boolean;
  transcriptBuffer: string;
  /** Cached result of sanitizeQwenTranscriptForLanguage(transcriptBuffer). */
  sanitizedTranscriptCache: string;
  /** Set true when transcriptBuffer changes; cleared after re-sanitizing. */
  transcriptDirty: boolean;
  stderrBuffer: string;
  isClosing: boolean;
  closePromise: Promise<number>;
  isFake: boolean;
  isNativeRecognizer: boolean;
  vad: SileroVadInstance | null;
  /** Ring buffer of raw Float32 PCM for end-of-turn analysis (last 8s = 128000 samples). */
  pcmRingBuffer: Float32Array;
  pcmRingWritePos: number;
  pcmRingTotalWritten: number;
}

const streamSessions = new Map<string, StreamSession>();
const expectedQwenCycleCloses = new WeakSet<ChildProcessWithoutNullStreams>();

/** Return the sanitized transcript, using a cache to avoid re-processing
 *  the entire buffer on every PCM chunk. Only re-sanitizes when new
 *  transcript text has actually arrived from qwen_asr stdout. */
function getSanitizedTranscript(session: StreamSession): string {
  if (!session.transcriptDirty) return session.sanitizedTranscriptCache;
  session.sanitizedTranscriptCache = sanitizeQwenTranscriptForLanguage(
    session.transcriptBuffer,
    session.language,
    session.stripChineseCharacters,
  );
  session.transcriptDirty = false;
  return session.sanitizedTranscriptCache;
}

function makeSessionError(message: string, session: StreamSession): Error {
  const detail = session.stderrBuffer.trim();
  if (!detail) return new Error(message);
  return new Error(`${message}: ${detail}`);
}

function appendSessionStderr(session: StreamSession, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const detail = message.trim();
  if (!detail) return;
  session.stderrBuffer = session.stderrBuffer ? `${session.stderrBuffer}\n${detail}` : detail;
  session.lastTouchedAt = Date.now();
}

type StreamProcessStdin = Pick<Writable, 'destroyed' | 'off' | 'once' | 'write' | 'writable'>;

export interface StreamProcessRef {
  stdin: StreamProcessStdin;
  killed: boolean;
  exitCode: number | null;
}

type UnexpectedProcessCloseMessageArgs = {
  sessionId: string;
  recognizer: 'qwen_asr' | 'speech-recognizer';
  exitCode: number | null;
  stderrBuffer: string;
  isClosing: boolean;
};

function formatUnexpectedProcessCloseMessage(args: UnexpectedProcessCloseMessageArgs): string | null {
  if (args.isClosing) return null;

  const stderrTail = args.stderrBuffer
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(' | ');
  const stderrSuffix = stderrTail ? ` stderr=${JSON.stringify(stderrTail)}` : '';

  return `[VoiceStream] ${args.recognizer} closed unexpectedly session=${args.sessionId} code=${args.exitCode ?? 'null'}${stderrSuffix}`;
}

export function _formatUnexpectedProcessCloseMessageForTest(args: UnexpectedProcessCloseMessageArgs): string | null {
  return formatUnexpectedProcessCloseMessage(args);
}
async function writeChunkToProcessStdin(
  processRef: StreamProcessRef,
  pcmChunk: Buffer,
  timeoutMs: number,
  recordWriteFailure?: (error: unknown) => void,
): Promise<boolean> {
  if (!processRef.stdin.writable || processRef.stdin.destroyed || processRef.killed || processRef.exitCode !== null) {
    return false;
  }

  return await new Promise<boolean>((resolve) => {
    let settled = false;

    const settle = (ok: boolean, error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      processRef.stdin.off('error', onStdinError);
      if (error) {
        recordWriteFailure?.(error);
      }
      resolve(ok);
    };

    const onStdinError = (): void => {
      settle(false);
    };

    const timer = setTimeout(() => {
      settle(false);
    }, timeoutMs);

    processRef.stdin.once('error', onStdinError);
    try {
      processRef.stdin.write(pcmChunk, (error) => {
        if (error) {
          settle(false, error);
          return;
        }
        settle(true);
      });
    } catch (error) {
      settle(false, error);
    }
  });
}

// Exported for tests. Validates that stdin EPIPE/broken-pipe paths are handled
// without uncaught exceptions.
export async function _writeChunkToProcessStdinForTest(
  processRef: StreamProcessRef,
  pcmChunk: Buffer,
  timeoutMs = STREAM_WRITE_TIMEOUT_MS,
  recordWriteFailure?: (error: unknown) => void,
): Promise<boolean> {
  return await writeChunkToProcessStdin(processRef, pcmChunk, timeoutMs, recordWriteFailure);
}

/** Resolve the macOS SFSpeechRecognizer CLI binary path. */
function resolveSpeechRecognizerPath(): string | null {
  return _resolveSpeechRecognizerPathForTest(
    process.platform,
    getInterpreterOverlayNativeHelperPath,
    existsSync,
  );
}

export function _resolveSpeechRecognizerPathForTest(
  platform: NodeJS.Platform,
  resolveHelperPath: (helperName: 'speech-recognizer') => string,
  pathExists: (candidate: string) => boolean,
): string | null {
  if (platform !== 'darwin') return null;
  const binaryPath = resolveHelperPath('speech-recognizer');
  return pathExists(binaryPath) ? binaryPath : null;
}

function resolveSpeechRecognizerLocale(language: string | null): string {
  const normalized = language?.trim();
  if (!normalized) return DEFAULT_NATIVE_RECOGNIZER_LOCALE;
  return NATIVE_RECOGNIZER_LOCALE_BY_LANGUAGE[normalized.toLowerCase()] ?? normalized;
}

function attachTranscriptCapture(session: StreamSession): void {
  if (!session.process) return;

  session.process.stdout.on('data', (chunk: Buffer | string) => {
    const raw = chunk.toString();

    if (session.isNativeRecognizer) {
      // SFSpeechRecognizer CLI outputs JSON lines: {"text":"...","isFinal":false}
      // Each line contains the full cumulative transcript — just use the latest.
      const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as { text?: string; isFinal?: boolean };
          if (typeof parsed.text === 'string') {
            session.transcriptBuffer = parsed.text;
            session.transcriptDirty = true;
          }
        } catch { /* skip non-JSON lines */ }
      }
    } else {
      // qwen_asr emits incremental transcript fragments with -S flag.
      // Accumulate them with a space separator so the full transcript builds up.
      const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const transcriptLines = lines.filter(l => !l.startsWith('['));
      for (const line of transcriptLines) {
        if (session.transcriptBuffer) {
          session.transcriptBuffer += ' ' + line;
        } else {
          session.transcriptBuffer = line;
        }
        session.transcriptDirty = true;
      }
    }
    session.lastTouchedAt = Date.now();
  });

  session.process.stderr.on('data', (chunk: Buffer | string) => {
    session.stderrBuffer += chunk.toString();
    session.lastTouchedAt = Date.now();
  });
}

function registerSessionClose(session: StreamSession): void {
  const processRef = session.process;
  if (!processRef) {
    session.closePromise = Promise.resolve(0);
    return;
  }

  processRef.on('error', (error) => {
    appendSessionStderr(session, error);
  });

  processRef.stdin.on('error', (error) => {
    appendSessionStderr(session, error);
  });

  session.closePromise = new Promise<number>((resolve) => {
    processRef.on('close', (code) => {
      const message = formatUnexpectedProcessCloseMessage({
        sessionId: session.id,
        recognizer: session.isNativeRecognizer ? 'speech-recognizer' : 'qwen_asr',
        exitCode: code,
        stderrBuffer: session.stderrBuffer,
        isClosing: session.isClosing || expectedQwenCycleCloses.has(processRef),
      });
      expectedQwenCycleCloses.delete(processRef);
      if (message) {
        console.warn(message);
      }
      resolve(typeof code === 'number' ? code : 1);
    });
  });
}

function spawnQwenStreamProcess(binaryPath: string, args: string[]): ChildProcessWithoutNullStreams {
  return spawn(binaryPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });
}

function attachProcessToSession(session: StreamSession, childProcess: ChildProcessWithoutNullStreams): void {
  session.process = childProcess;
  session.closePromise = Promise.resolve(1);
  attachTranscriptCapture(session);
  registerSessionClose(session);
}

function canRestartQwenSession(session: StreamSession): session is StreamSession & { qwenBinaryPath: string; qwenArgs: string[] } {
  return !session.isClosing
    && !session.isFake
    && !session.isNativeRecognizer
    && typeof session.qwenBinaryPath === 'string'
    && Array.isArray(session.qwenArgs);
}

async function ensureWritableStreamProcess(session: StreamSession): Promise<ChildProcessWithoutNullStreams> {
  if (!session.process) {
    if (!canRestartQwenSession(session)) {
      throw new Error(`Voice stream session process unavailable: ${session.id}`);
    }
    const childProcess = spawnQwenStreamProcess(session.qwenBinaryPath, session.qwenArgs);
    attachProcessToSession(session, childProcess);
    return childProcess;
  }

  if (
    !session.process.killed
    && session.process.exitCode === null
    && session.process.stdin.writable
    && !session.process.stdin.destroyed
  ) {
    return session.process;
  }

  if (!canRestartQwenSession(session)) {
    return session.process;
  }

  console.warn(`[VoiceStream] Restarting qwen_asr stream session after process close session=${session.id}`);
  const childProcess = spawnQwenStreamProcess(session.qwenBinaryPath, session.qwenArgs);
  attachProcessToSession(session, childProcess);
  return childProcess;
}

function rememberQwenCycleOverlap(session: StreamSession, pcmChunk: Buffer): void {
  if (!canRestartQwenSession(session)) return;
  session.qwenCycleOverlapChunks.push(Buffer.from(pcmChunk));
  while (session.qwenCycleOverlapChunks.length > QWEN_STREAM_CYCLE_OVERLAP_CHUNKS) {
    session.qwenCycleOverlapChunks.shift();
  }
}

function waitForProcessClose(processRef: ChildProcessWithoutNullStreams): Promise<number> {
  if (processRef.exitCode !== null) return Promise.resolve(processRef.exitCode);
  return new Promise<number>((resolve) => {
    processRef.once('close', (code) => {
      resolve(typeof code === 'number' ? code : 1);
    });
  });
}

async function finalizeQwenCycleProcess(
  session: StreamSession,
  processRef: ChildProcessWithoutNullStreams,
): Promise<void> {
  expectedQwenCycleCloses.add(processRef);
  const closePromise = waitForProcessClose(processRef);

  if (!processRef.stdin.destroyed && processRef.stdin.writable) {
    await new Promise<void>((resolve) => {
      processRef.stdin.end(() => resolve());
    });
  }

  let exitCode = await Promise.race<number | null>([
    closePromise,
    sleep(FINISH_STREAM_CLOSE_TIMEOUT_MS).then(() => null),
  ]);

  if (exitCode === null && processRef.exitCode === null && !processRef.killed) {
    processRef.kill('SIGTERM');
    exitCode = await Promise.race<number | null>([
      closePromise,
      sleep(FINISH_STREAM_TERM_GRACE_MS).then(() => null),
    ]);
  }

  if (exitCode === null && processRef.exitCode === null && !processRef.killed) {
    processRef.kill('SIGKILL');
    exitCode = await closePromise;
  }

  if (typeof exitCode === 'number' && exitCode !== 0) {
    console.warn(`[VoiceStream] qwen_asr cycle exited with code ${exitCode} session=${session.id}`);
  }
}

async function rotateQwenStreamProcessIfNeeded(session: StreamSession): Promise<void> {
  if (!canRestartQwenSession(session)) return;
  if (session.qwenCycleAudioBytes < QWEN_STREAM_CYCLE_AUDIO_BYTES) return;

  if (VOICE_DEBUG) {
    console.log(`[VoiceStream] Rotating qwen_asr stream session=${session.id} cycleBytes=${session.qwenCycleAudioBytes}`);
  }

  const oldProcess = session.process;
  if (oldProcess && oldProcess.exitCode === null && !oldProcess.killed) {
    const finalizer = finalizeQwenCycleProcess(session, oldProcess);
    session.qwenCycleFinalizers.add(finalizer);
    finalizer.finally(() => {
      session.qwenCycleFinalizers.delete(finalizer);
    }).catch((error) => {
      appendSessionStderr(session, error);
    });
  }

  const childProcess = spawnQwenStreamProcess(session.qwenBinaryPath, session.qwenArgs);
  attachProcessToSession(session, childProcess);
  session.qwenCycleAudioBytes = 0;

  for (const overlapChunk of session.qwenCycleOverlapChunks) {
    const writeOk = await writeChunkToProcessStdin(
      childProcess,
      overlapChunk,
      STREAM_WRITE_TIMEOUT_MS,
      (error) => appendSessionStderr(session, error),
    );
    if (!writeOk) break;
    session.qwenCycleAudioBytes += overlapChunk.length;
  }
}

async function waitForSessionCloseOrTimeout(
  session: StreamSession,
  timeoutMs: number,
): Promise<number | null> {
  return Promise.race<number | null>([
    session.closePromise,
    sleep(timeoutMs).then(() => null),
  ]);
}

async function waitForSessionQuietPeriod(
  session: StreamSession,
  quietPeriodMs: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (Date.now() - session.lastTouchedAt >= quietPeriodMs) {
      return;
    }
    await sleep(100);
  }
}

function getSessionOrThrow(sessionId: string): StreamSession {
  const session = streamSessions.get(sessionId);
  if (!session) {
    throw new Error(`Unknown voice stream session: ${sessionId}`);
  }
  return session;
}

export interface StartStreamSessionOptions {
  /** Use macOS native SFSpeechRecognizer instead of qwen_asr. */
  nativeRecognizer?: boolean;
}

export async function startQwenAsrStreamSession(options?: StartStreamSessionOptions): Promise<string> {
  const [language, sttSettings] = await Promise.all([
    getLanguage().catch(() => null),
    getSttSettings().catch(() => DEFAULT_STT_SETTINGS),
  ]);
  const wantsNativeRecognizer = options?.nativeRecognizer === true;
  const fakeTranscript = process.env.TEST_FAKE_ASR_TEXT?.trim();
  if (fakeTranscript) {
    const sessionId = randomUUID();
    streamSessions.set(sessionId, {
      id: sessionId,
      process: null,
      qwenBinaryPath: null,
      qwenArgs: null,
      qwenCycleAudioBytes: 0,
      qwenCycleOverlapChunks: [],
      qwenCycleFinalizers: new Set(),
      createdAt: Date.now(),
      lastTouchedAt: Date.now(),
      language,
      stripChineseCharacters: sttSettings.stripChineseCharacters,
      transcriptBuffer: normalizeText(fakeTranscript),
      sanitizedTranscriptCache: '',
      transcriptDirty: true,
      stderrBuffer: '',
      isClosing: false,
      closePromise: Promise.resolve(0),
      isFake: true,
      isNativeRecognizer: false,
      vad: null,
      pcmRingBuffer: new Float32Array(PCM_RING_BUFFER_SAMPLES),
      pcmRingWritePos: 0,
      pcmRingTotalWritten: 0,
    });
    return sessionId;
  }

  if (wantsNativeRecognizer && process.platform !== 'darwin') {
    throw new Error('Native speech recognizer is only available on macOS.');
  }

  const nativePath = wantsNativeRecognizer ? resolveSpeechRecognizerPath() : null;
  if (wantsNativeRecognizer && !nativePath) {
    throw new Error(
      'macOS speech recognizer helper is missing. Run `pnpm run build:electron` so `speech-recognizer` is built and bundled.',
    );
  }

  let childProcess: ChildProcessWithoutNullStreams;
  let isNativeRecognizer = false;

  let qwenBinaryPath: string | null = null;
  let qwenArgs: string[] | null = null;

  if (nativePath) {
    const localeIdentifier = resolveSpeechRecognizerLocale(language);
    console.log(`[VoiceStream] Using macOS native SFSpeechRecognizer (${localeIdentifier})`);
    childProcess = spawn(nativePath, ['--locale', localeIdentifier], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    isNativeRecognizer = true;
  } else {
    const { binaryPath, modelDir } = await resolveBundledQwenPaths();
    const extraArgsRaw = process.env.QWEN_ASR_STREAM_EXTRA_ARGS?.trim();
    const extraArgs = extraArgsRaw ? extraArgsRaw.split(/\s+/).filter(Boolean) : [];
    const args = ['-d', modelDir, '--stdin', '--stream', ...DEFAULT_STREAM_ARGS, ...extraArgs];

    qwenBinaryPath = binaryPath;
    qwenArgs = args;
    childProcess = spawnQwenStreamProcess(binaryPath, args);
  }

  let vad: SileroVadInstance | null = null;
  try {
    vad = createSileroVadInstance();
  } catch (err) {
    console.warn('[VoiceStream] Failed to create Silero VAD (speech detection will be unavailable):', err);
  }

  const sessionId = randomUUID();
  const session: StreamSession = {
    id: sessionId,
    process: childProcess,
    qwenBinaryPath,
    qwenArgs,
    qwenCycleAudioBytes: 0,
    qwenCycleOverlapChunks: [],
    qwenCycleFinalizers: new Set(),
    createdAt: Date.now(),
    lastTouchedAt: Date.now(),
    language,
    stripChineseCharacters: sttSettings.stripChineseCharacters,
    transcriptBuffer: '',
    sanitizedTranscriptCache: '',
    transcriptDirty: false,
    stderrBuffer: '',
    isClosing: false,
    closePromise: Promise.resolve(1),
    isFake: false,
    isNativeRecognizer,
    vad,
    pcmRingBuffer: new Float32Array(PCM_RING_BUFFER_SAMPLES),
    pcmRingWritePos: 0,
    pcmRingTotalWritten: 0,
  };

  attachTranscriptCapture(session);
  registerSessionClose(session);
  streamSessions.set(sessionId, session);
  return sessionId;
}

function appendToRingBuffer(session: StreamSession, pcm16Buffer: Buffer): void {
  const sampleCount = pcm16Buffer.length / 2;
  for (let i = 0; i < sampleCount; i++) {
    session.pcmRingBuffer[session.pcmRingWritePos] = pcm16Buffer.readInt16LE(i * 2) / 32768.0;
    session.pcmRingWritePos = (session.pcmRingWritePos + 1) % PCM_RING_BUFFER_SAMPLES;
  }
  session.pcmRingTotalWritten += sampleCount;
}

/** Extract the last N samples from the ring buffer as a contiguous Float32Array. */
export function extractRingBuffer(sessionId: string): Float32Array {
  const session = getSessionOrThrow(sessionId);
  const available = Math.min(session.pcmRingTotalWritten, PCM_RING_BUFFER_SAMPLES);
  const result = new Float32Array(available);
  if (available === 0) return result;

  // Read from ring buffer in order
  const startPos = (session.pcmRingWritePos - available + PCM_RING_BUFFER_SAMPLES) % PCM_RING_BUFFER_SAMPLES;
  for (let i = 0; i < available; i++) {
    result[i] = session.pcmRingBuffer[(startPos + i) % PCM_RING_BUFFER_SAMPLES];
  }
  return result;
}

let _chunkCounter = 0;

export async function appendQwenAsrStreamChunk(sessionId: string, pcmChunk: Buffer): Promise<StreamChunkResult> {
  const session = getSessionOrThrow(sessionId);
  if (session.isClosing) {
    throw new Error(`Voice stream session is closing: ${sessionId}`);
  }
  if (!Buffer.isBuffer(pcmChunk) || pcmChunk.length === 0) {
    throw new Error('Expected non-empty PCM chunk payload');
  }

  const chunkNum = ++_chunkCounter;
  const chunkBytes = pcmChunk.length;

  session.lastTouchedAt = Date.now();

  // Accumulate PCM in ring buffer for potential end-of-turn analysis
  appendToRingBuffer(session, pcmChunk);

  // Run Silero VAD classification
  let isSpeech = false;
  if (session.vad) {
    try {
      isSpeech = session.vad.feedPcm(pcmChunk);
    } catch {
      // VAD failure is non-fatal — fall back to assuming speech
      isSpeech = true;
    }
  }

  if (VOICE_DEBUG && (chunkNum % 10 === 1 || chunkNum <= 3)) {
    const sanitized = getSanitizedTranscript(session);
    console.log(`[VoiceStream] chunk#${chunkNum} ${chunkBytes}B speech=${isSpeech} transcript="${sanitized.slice(-60)}"`);
  }

  if (session.isFake) {
    return {
      text: getSanitizedTranscript(session),
      isSpeech,
    };
  }

  await rotateQwenStreamProcessIfNeeded(session);
  const processRef = await ensureWritableStreamProcess(session);

  // Guard against stdin backpressure: if qwen_asr can't consume fast enough,
  // stdin.write may never call back. Use a 3s timeout — if it fires, skip
  // writing this chunk but still return the current transcript.
  const writeOk = await writeChunkToProcessStdin(
    processRef,
    pcmChunk,
    STREAM_WRITE_TIMEOUT_MS,
    (error) => appendSessionStderr(session, error),
  );

  if (!writeOk) {
    // stdin write timed out or errored — return current transcript anyway
    // so the client isn't blocked. The audio chunk is lost but the pipeline
    // stays alive.
    console.warn('[VoiceStream] stdin.write timed out or failed — skipping chunk');
  } else {
    session.qwenCycleAudioBytes += pcmChunk.length;
    rememberQwenCycleOverlap(session, pcmChunk);
  }

  return {
    text: getSanitizedTranscript(session),
    isSpeech,
  };
}

export async function finishQwenAsrStreamSession(sessionId: string): Promise<string> {
  const session = getSessionOrThrow(sessionId);
  session.isClosing = true;
  session.lastTouchedAt = Date.now();

  if (session.isFake) {
    streamSessions.delete(sessionId);
    return getSanitizedTranscript(session);
  }

  if (!session.process) {
    streamSessions.delete(sessionId);
    throw new Error(`Voice stream session process unavailable: ${sessionId}`);
  }
  const processRef = session.process;

  await new Promise<void>((resolve, reject) => {
    processRef.stdin.end((error: NodeJS.ErrnoException | null) => {
      if (error) {
        reject(makeSessionError('Failed to finish qwen_asr stream', session));
        return;
      }
      resolve();
    });
  });

  let exitCode = await waitForSessionCloseOrTimeout(session, FINISH_STREAM_CLOSE_TIMEOUT_MS);
  let forcedCleanup = false;

  if (exitCode === null) {
    forcedCleanup = true;
    await waitForSessionQuietPeriod(
      session,
      FINISH_STREAM_QUIET_PERIOD_MS,
      FINISH_STREAM_CLOSE_TIMEOUT_MS,
    );

    if (processRef.exitCode === null && !processRef.killed) {
      processRef.kill('SIGTERM');
      exitCode = await waitForSessionCloseOrTimeout(session, FINISH_STREAM_TERM_GRACE_MS);
    }

    if (exitCode === null) {
      processRef.kill('SIGKILL');
      exitCode = await session.closePromise;
    }
  }

  if (session.qwenCycleFinalizers.size > 0) {
    await Promise.allSettled([...session.qwenCycleFinalizers]);
  }

  const transcript = getSanitizedTranscript(session);
  streamSessions.delete(sessionId);
  session.vad?.free();

  if (forcedCleanup) {
    if (transcript) {
      console.warn('[VoiceStream] Forced qwen_asr shutdown after finish timeout');
      return transcript;
    }
    throw makeSessionError('qwen_asr stream did not shut down cleanly after finish timeout', session);
  }

  if (exitCode !== 0) {
    throw makeSessionError(`qwen_asr stream exited with code ${exitCode}`, session);
  }

  return transcript;
}

export async function abortQwenAsrStreamSession(sessionId: string): Promise<void> {
  const session = streamSessions.get(sessionId);
  if (!session) return;

  session.isClosing = true;
  streamSessions.delete(sessionId);
  session.vad?.free();
  if (session.process) {
    session.process.kill('SIGKILL');
  }
  for (const finalizer of session.qwenCycleFinalizers) {
    finalizer.catch(() => {});
  }
  await session.closePromise.catch(() => {});
}

function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [sessionId, session] of streamSessions.entries()) {
    const isExpiredByIdle = (now - session.lastTouchedAt) > SESSION_IDLE_TIMEOUT_MS;
    if (!isExpiredByIdle) continue;

    session.isClosing = true;
    streamSessions.delete(sessionId);
    session.vad?.free();
    if (session.process) {
      session.process.kill('SIGKILL');
    }
    for (const finalizer of session.qwenCycleFinalizers) {
      finalizer.catch(() => {});
    }
  }
}

const cleanupTimer = setInterval(cleanupExpiredSessions, CLEANUP_INTERVAL_MS);
cleanupTimer.unref();
