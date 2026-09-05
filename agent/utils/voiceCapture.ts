import { getApiUrl, getRuntimeSystemInfo } from '../../src/ipc';
import { emitVoiceLatencyEvent } from './voiceLatency';
import type { SttBackend } from '../../shared/types/stt';

const TARGET_SAMPLE_RATE = 16000;
const AUDIO_MONITOR_INTERVAL_MS = 75;
const DEFAULT_SILENCE_TIMEOUT_MS = 2000;
const DEFAULT_SPEECH_THRESHOLD = 0.002;
const DEFAULT_INTERIM_INTERVAL_MS = 1000;
const FAST_SENTENCE_SILENCE_TIMEOUT_MS = 700;
const DEFAULT_STREAM_CHUNK_INTERVAL_MS = 80;
const SENTENCE_END_PATTERN = /[.!?]["')\]]*$/;
const STREAM_WARMUP_SILENCE_SAMPLES = 1600; // 100ms at 16kHz mono

// NOTE(victor): Request any available microphone first. Issue #1042 showed
// that device-level audio constraints can fail on macOS with `NotFoundError:
// Requested device not found` during `getUserMedia()` startup, while this
// pipeline already resamples the captured audio in software below.
// https://github.com/openinterpreter/iworkstation/issues/1042
// https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
// https://developer.mozilla.org/en-US/docs/Web/API/Media_Capture_and_Streams_API/Constraints
export const MICROPHONE_CAPTURE_REQUEST: MediaStreamConstraints = {
  audio: true,
};

interface AdaptiveVoiceSilenceOptions {
  silenceTimeoutMs?: number;
  fastSentenceSilenceTimeoutMs?: number;
}

export function shouldUseMoonshineVoiceBackend(preferredBackend?: SttBackend): boolean {
  const forcedBackend = (globalThis as { __VOICE_BACKEND__?: string }).__VOICE_BACKEND__;
  if (forcedBackend === 'moonshine') return true;
  if (forcedBackend === 'qwen') return false;
  if (preferredBackend === 'moonshine') return true;
  if (preferredBackend === 'qwen') return false;
  return getRuntimeSystemInfo().platform === 'win32';
}

export function getAdaptiveVoiceSilenceTimeoutMs(text: string, options?: AdaptiveVoiceSilenceOptions): number {
  const normalized = text.trim();
  const silenceTimeoutMs = options?.silenceTimeoutMs ?? DEFAULT_SILENCE_TIMEOUT_MS;
  const fastSentenceSilenceTimeoutMs = options?.fastSentenceSilenceTimeoutMs ?? FAST_SENTENCE_SILENCE_TIMEOUT_MS;
  if (!normalized) return silenceTimeoutMs;
  return SENTENCE_END_PATTERN.test(normalized)
    ? fastSentenceSilenceTimeoutMs
    : silenceTimeoutMs;
}

interface VoiceCaptureOptions {
  silenceTimeoutMs?: number;
  speechThreshold?: number;
  interimIntervalMs?: number;
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
  onInterimUtterance?: (wavBlob: Blob) => Promise<void> | void;
  onUtterance: (wavBlob: Blob) => Promise<void> | void;
  onError?: (error: unknown) => void;
}

interface QwenStreamingCaptureOptions {
  silenceTimeoutMs?: number;
  speechThreshold?: number;
  chunkIntervalMs?: number;
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
  onPcmChunk: (pcmChunk: Uint8Array) => Promise<void> | void;
  onError?: (error: unknown) => void;
}

function writeWavHeader(view: DataView, sampleRate: number, dataSize: number): void {
  const bytesPerSample = 2;
  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);
}

function encodePcm16WavFromBytes(pcmBytes: Uint8Array, sampleRate: number): ArrayBuffer {
  const dataSize = pcmBytes.byteLength;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  writeWavHeader(view, sampleRate, dataSize);
  new Uint8Array(buffer, 44).set(pcmBytes);
  return buffer;
}

class LinearResampler {
  private leftover = new Float32Array(0);
  private cursor = 0;

  reset(): void {
    this.leftover = new Float32Array(0);
    this.cursor = 0;
  }

  toTarget(samples: Float32Array, sourceRate: number): Float32Array {
    if (sourceRate === TARGET_SAMPLE_RATE) {
      return samples;
    }

    const merged = new Float32Array(this.leftover.length + samples.length);
    merged.set(this.leftover, 0);
    merged.set(samples, this.leftover.length);

    if (merged.length < 2) {
      this.leftover = merged;
      return new Float32Array(0);
    }

    const sourcePerTarget = sourceRate / TARGET_SAMPLE_RATE;
    const output: number[] = [];
    let cursor = this.cursor;

    while ((cursor + 1) < merged.length) {
      const baseIndex = Math.floor(cursor);
      const nextIndex = baseIndex + 1;
      const fraction = cursor - baseIndex;
      const base = merged[baseIndex] ?? 0;
      const next = merged[nextIndex] ?? base;
      output.push(base + ((next - base) * fraction));
      cursor += sourcePerTarget;
    }

    const consumed = Math.floor(cursor);
    this.leftover = merged.slice(consumed);
    this.cursor = cursor - consumed;

    if (output.length === 0) {
      return new Float32Array(0);
    }
    return Float32Array.from(output);
  }
}

export async function transcribeVoiceWav(wavBlob: Blob): Promise<string> {
  const url = await getApiUrl('/api/agent/voice/transcribe');
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'audio/wav',
    },
    body: wavBlob,
  });

  const data = await response.json().catch(() => ({} as { text?: string; error?: string }));
  if (!response.ok) {
    const errorMessage = typeof data.error === 'string'
      ? data.error
      : `Voice transcription failed with status ${response.status}`;
    throw new Error(errorMessage);
  }

  return typeof data.text === 'string' ? data.text.trim() : '';
}

export interface VoiceStreamChunkResult {
  text: string;
  isSpeech: boolean;
}

async function parseVoiceJsonResponse(response: Response): Promise<{ text?: string; sessionId?: string; error?: string; isSpeech?: boolean }> {
  return response.json().catch(() => ({} as { text?: string; sessionId?: string; error?: string; isSpeech?: boolean }));
}

export interface StartVoiceStreamOptions {
  /** Use macOS native SFSpeechRecognizer for real-time recognition. */
  nativeRecognizer?: boolean;
}

export async function startVoiceStreamSession(options?: StartVoiceStreamOptions): Promise<string> {
  const url = await getApiUrl('/api/agent/voice/stream/start');
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: options?.nativeRecognizer ? { 'Content-Type': 'application/json' } : undefined,
    body: options?.nativeRecognizer ? JSON.stringify({ nativeRecognizer: true }) : undefined,
  });

  const data = await parseVoiceJsonResponse(response);
  if (!response.ok) {
    const errorMessage = typeof data.error === 'string'
      ? data.error
      : `Voice stream start failed with status ${response.status}`;
    throw new Error(errorMessage);
  }

  if (typeof data.sessionId !== 'string' || !data.sessionId.trim()) {
    throw new Error('Voice stream start response missing sessionId');
  }

  return data.sessionId;
}

export async function appendVoiceStreamChunk(sessionId: string, pcmChunk: Uint8Array): Promise<VoiceStreamChunkResult> {
  const url = await getApiUrl(`/api/agent/voice/stream/chunk/${encodeURIComponent(sessionId)}`);
  const pcmBody = Uint8Array.from(pcmChunk).buffer;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/octet-stream',
      },
      body: pcmBody,
      signal: controller.signal,
    });

    const data = await parseVoiceJsonResponse(response);
    if (!response.ok) {
      const errorMessage = typeof data.error === 'string'
        ? data.error
        : `Voice stream chunk failed with status ${response.status}`;
      throw new Error(errorMessage);
    }

    return {
      text: typeof data.text === 'string' ? data.text.trim() : '',
      isSpeech: data.isSpeech === true,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function warmVoiceStreamSession(sessionId: string): Promise<void> {
  const silentChunk = new Uint8Array(STREAM_WARMUP_SILENCE_SAMPLES * 2);
  await appendVoiceStreamChunk(sessionId, silentChunk);
}

export async function finishVoiceStreamSession(sessionId: string): Promise<string> {
  const url = await getApiUrl(`/api/agent/voice/stream/finish/${encodeURIComponent(sessionId)}`);
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'include',
  });

  const data = await parseVoiceJsonResponse(response);
  if (!response.ok) {
    const errorMessage = typeof data.error === 'string'
      ? data.error
      : `Voice stream finish failed with status ${response.status}`;
    throw new Error(errorMessage);
  }

  return typeof data.text === 'string' ? data.text.trim() : '';
}

export interface SmartTurnResult {
  done: boolean;
  confidence: number;
}

export async function checkEndOfTurn(sessionId: string): Promise<SmartTurnResult> {
  const url = await getApiUrl(`/api/agent/voice/stream/endofturn/${encodeURIComponent(sessionId)}`);
  const response = await fetch(url, { method: 'POST', credentials: 'include' });
  const data: { done?: boolean; confidence?: number; error?: string } = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof data.error === 'string' ? data.error : 'End-of-turn check failed');
  }
  return { done: !!data.done, confidence: typeof data.confidence === 'number' ? data.confidence : 0 };
}

export async function abortVoiceStreamSession(sessionId: string): Promise<void> {
  const url = await getApiUrl(`/api/agent/voice/stream/abort/${encodeURIComponent(sessionId)}`);
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'include',
  });

  if (response.ok) return;
  const data = await parseVoiceJsonResponse(response);
  const errorMessage = typeof data.error === 'string'
    ? data.error
    : `Voice stream abort failed with status ${response.status}`;
  throw new Error(errorMessage);
}

export class VoiceCaptureSession {
  private readonly options: Required<Pick<VoiceCaptureOptions, 'silenceTimeoutMs' | 'speechThreshold' | 'interimIntervalMs'>>
    & Omit<VoiceCaptureOptions, 'silenceTimeoutMs' | 'speechThreshold' | 'interimIntervalMs'>;
  private silenceTimeoutMs: number;

  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private mutedGainNode: GainNode | null = null;
  private monitorTimer: ReturnType<typeof setInterval> | null = null;
  private interimTimer: ReturnType<typeof setInterval> | null = null;

  private lastSpeechAt = 0;
  private isActive = false;
  private isSpeaking = false;
  private isProcessingUtterance = false;
  private isProcessingInterimUtterance = false;
  private hasPendingInterimUtterance = false;
  private utteranceGeneration = 0;
  private currentPcmChunks: Uint8Array[] = [];
  private currentPcmBytes = 0;
  private readonly resampler = new LinearResampler();

  constructor(options: VoiceCaptureOptions) {
    this.options = {
      silenceTimeoutMs: options.silenceTimeoutMs ?? DEFAULT_SILENCE_TIMEOUT_MS,
      speechThreshold: options.speechThreshold ?? DEFAULT_SPEECH_THRESHOLD,
      interimIntervalMs: options.interimIntervalMs ?? DEFAULT_INTERIM_INTERVAL_MS,
      onUtterance: options.onUtterance,
      onInterimUtterance: options.onInterimUtterance,
      onSpeechStart: options.onSpeechStart,
      onSpeechEnd: options.onSpeechEnd,
      onError: options.onError,
    };
    this.silenceTimeoutMs = this.options.silenceTimeoutMs;
  }

  setSilenceTimeoutMs(timeoutMs: number): void {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return;
    this.silenceTimeoutMs = timeoutMs;
  }

  getSilenceTimeoutMs(): number {
    return this.silenceTimeoutMs;
  }

  async start(): Promise<void> {
    if (this.isActive) return;

    this.mediaStream = await navigator.mediaDevices.getUserMedia(MICROPHONE_CAPTURE_REQUEST);

    this.audioContext = new AudioContext();
    await this.audioContext.resume();

    this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
    this.analyserNode = this.audioContext.createAnalyser();
    this.analyserNode.fftSize = 2048;
    this.analyserNode.smoothingTimeConstant = 0.1;
    this.sourceNode.connect(this.analyserNode);

    this.processorNode = this.audioContext.createScriptProcessor(1024, 1, 1);
    this.processorNode.onaudioprocess = (event) => {
      this.handleAudioProcess(event);
    };

    this.mutedGainNode = this.audioContext.createGain();
    this.mutedGainNode.gain.value = 0;

    this.sourceNode.connect(this.processorNode);
    this.processorNode.connect(this.mutedGainNode);
    this.mutedGainNode.connect(this.audioContext.destination);

    this.lastSpeechAt = Date.now();
    this.isSpeaking = false;
    this.isActive = true;
    this.resampler.reset();
    this.resetPcmBuffers();
    this.monitorTimer = setInterval(() => {
      void this.monitorAudio();
    }, AUDIO_MONITOR_INTERVAL_MS);
  }

  stop(): void {
    this.isActive = false;
    this.isSpeaking = false;
    this.stopInterimTimer();
    this.utteranceGeneration += 1;
    this.isProcessingInterimUtterance = false;
    this.hasPendingInterimUtterance = false;
    this.resetPcmBuffers();
    this.resampler.reset();

    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }

    if (this.processorNode) {
      try {
        this.processorNode.disconnect();
      } catch {}
      this.processorNode.onaudioprocess = null;
      this.processorNode = null;
    }

    if (this.mutedGainNode) {
      try {
        this.mutedGainNode.disconnect();
      } catch {}
      this.mutedGainNode = null;
    }

    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {}
      this.sourceNode = null;
    }

    if (this.analyserNode) {
      try {
        this.analyserNode.disconnect();
      } catch {}
      this.analyserNode = null;
    }

    const currentAudioContext = this.audioContext;
    this.audioContext = null;
    if (currentAudioContext) {
      void currentAudioContext.close().catch(() => {});
    }

    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        track.stop();
      }
      this.mediaStream = null;
    }

    this.lastSpeechAt = 0;
    this.isProcessingUtterance = false;
    this.silenceTimeoutMs = this.options.silenceTimeoutMs;
  }

  private resetPcmBuffers(): void {
    this.currentPcmChunks = [];
    this.currentPcmBytes = 0;
  }

  private snapshotUtteranceWavBlob(): Blob | null {
    if (this.currentPcmBytes === 0) return null;
    const pcmBytes = concatUint8Arrays(this.currentPcmChunks, this.currentPcmBytes);
    if (pcmBytes.byteLength === 0) return null;
    const wavBuffer = encodePcm16WavFromBytes(pcmBytes, TARGET_SAMPLE_RATE);
    return new Blob([wavBuffer], { type: 'audio/wav' });
  }

  private startInterimTimer(utteranceGeneration: number): void {
    this.stopInterimTimer();
    if (!this.options.onInterimUtterance) return;

    this.interimTimer = setInterval(() => {
      void this.emitInterimUtterance(utteranceGeneration);
    }, this.options.interimIntervalMs);
  }

  private stopInterimTimer(): void {
    if (!this.interimTimer) return;
    clearInterval(this.interimTimer);
    this.interimTimer = null;
  }

  private async emitInterimUtterance(utteranceGeneration: number): Promise<void> {
    if (!this.isActive) return;
    if (!this.isSpeaking) return;
    if (!this.options.onInterimUtterance) return;
    if (this.utteranceGeneration !== utteranceGeneration) return;
    if (this.isProcessingUtterance) return;
    if (this.currentPcmBytes === 0) return;

    if (this.isProcessingInterimUtterance) {
      this.hasPendingInterimUtterance = true;
      return;
    }

    this.isProcessingInterimUtterance = true;
    try {
      do {
        this.hasPendingInterimUtterance = false;
        const wavBlob = this.snapshotUtteranceWavBlob();
        if (!wavBlob) return;
        if (!this.isActive || this.utteranceGeneration !== utteranceGeneration) return;
        await this.options.onInterimUtterance(wavBlob);
      } while (this.hasPendingInterimUtterance && this.isActive && this.utteranceGeneration === utteranceGeneration);
    } catch {
      // Ignore interim snapshot failures; final utterance processing still runs on recorder stop.
    } finally {
      this.isProcessingInterimUtterance = false;
    }
  }

  private async emitFinalUtterance(utteranceGeneration: number): Promise<void> {
    if (!this.isActive) return;
    if (this.utteranceGeneration !== utteranceGeneration) return;
    const wavBlob = this.snapshotUtteranceWavBlob();
    this.resetPcmBuffers();
    this.resampler.reset();
    if (!wavBlob) return;

    this.isProcessingUtterance = true;
    try {
      if (!this.isActive) return;
      await this.options.onUtterance(wavBlob);
    } catch (error) {
      this.options.onError?.(error);
    } finally {
      this.isProcessingUtterance = false;
      this.isProcessingInterimUtterance = false;
      this.hasPendingInterimUtterance = false;
      this.lastSpeechAt = Date.now();
    }
  }

  private handleAudioProcess(event: AudioProcessingEvent): void {
    if (!this.isActive || !this.isSpeaking) return;

    const channelData = event.inputBuffer.getChannelData(0);
    if (channelData.length === 0) return;

    const sourceSamples = channelData.slice();
    const sourceRate = this.audioContext?.sampleRate ?? TARGET_SAMPLE_RATE;
    const targetSamples = this.resampler.toTarget(sourceSamples, sourceRate);
    if (targetSamples.length === 0) return;

    const pcmChunk = encodePcm16(targetSamples);
    if (pcmChunk.length === 0) return;

    this.currentPcmChunks.push(pcmChunk);
    this.currentPcmBytes += pcmChunk.length;
  }

  private async monitorAudio(): Promise<void> {
    if (!this.isActive || this.isProcessingUtterance) return;

    const analyser = this.analyserNode;
    if (!analyser) return;

    const samples = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(samples);

    let energy = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const sample = samples[i] || 0;
      energy += sample * sample;
    }
    const rms = Math.sqrt(energy / samples.length);
    const now = Date.now();

    if (rms >= this.options.speechThreshold) {
      this.lastSpeechAt = now;
      if (!this.isSpeaking) {
        this.isSpeaking = true;
        this.utteranceGeneration += 1;
        this.resetPcmBuffers();
        this.resampler.reset();
        this.startInterimTimer(this.utteranceGeneration);
        this.options.onSpeechStart?.();
      }
      return;
    }

    if (!this.isSpeaking) return;
    if ((now - this.lastSpeechAt) < this.silenceTimeoutMs) return;

    this.isSpeaking = false;
    this.stopInterimTimer();
    this.isProcessingInterimUtterance = false;
    this.hasPendingInterimUtterance = false;
    const completedUtteranceGeneration = this.utteranceGeneration;
    this.options.onSpeechEnd?.();
    void this.emitFinalUtterance(completedUtteranceGeneration);
  }
}

function concatUint8Arrays(chunks: Uint8Array[], totalLength: number): Uint8Array {
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function encodePcm16(samples: Float32Array): Uint8Array {
  const output = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] || 0));
    output[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return new Uint8Array(output.buffer.slice(0));
}

/**
 * QwenStreamingCaptureSession
 *
 * Captures mic audio, resamples to 16kHz mono PCM Int16, and sends ALL chunks
 * to the server via onPcmChunk. Speech detection is handled server-side by
 * Silero VAD — the onSpeechStart/onSpeechEnd callbacks are NOT called from here.
 * They are driven externally by the QwenVoiceStreamBridge's isSpeech response.
 */
export class QwenStreamingCaptureSession {
  private readonly options: Required<Pick<QwenStreamingCaptureOptions, 'chunkIntervalMs'>>
    & Omit<QwenStreamingCaptureOptions, 'silenceTimeoutMs' | 'speechThreshold' | 'chunkIntervalMs'>;

  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private mutedGainNode: GainNode | null = null;
  private chunkFlushTimer: ReturnType<typeof setInterval> | null = null;

  private isActive = false;
  private pendingChunks: Uint8Array[] = [];
  private pendingChunkBytes = 0;
  private isFlushingChunks = false;
  private hasPendingFlush = false;
  private hasEmittedAudioStart = false;
  private readonly resampler = new LinearResampler();

  constructor(options: QwenStreamingCaptureOptions) {
    this.options = {
      chunkIntervalMs: options.chunkIntervalMs ?? DEFAULT_STREAM_CHUNK_INTERVAL_MS,
      onPcmChunk: options.onPcmChunk,
      onSpeechStart: options.onSpeechStart,
      onSpeechEnd: options.onSpeechEnd,
      onError: options.onError,
    };
  }

  async start(): Promise<void> {
    if (this.isActive) return;

    this.mediaStream = await navigator.mediaDevices.getUserMedia(MICROPHONE_CAPTURE_REQUEST);

    this.audioContext = new AudioContext();
    await this.audioContext.resume();

    this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);

    this.processorNode = this.audioContext.createScriptProcessor(1024, 1, 1);
    this.processorNode.onaudioprocess = (event) => {
      this.handleAudioProcess(event);
    };

    this.mutedGainNode = this.audioContext.createGain();
    this.mutedGainNode.gain.value = 0;

    this.sourceNode.connect(this.processorNode);
    this.processorNode.connect(this.mutedGainNode);
    this.mutedGainNode.connect(this.audioContext.destination);

    this.isActive = true;
    this.hasEmittedAudioStart = false;
    this.resampler.reset();

    this.chunkFlushTimer = setInterval(() => {
      void this.flushPendingChunks();
    }, this.options.chunkIntervalMs);
  }

  stop(): void {
    this.isActive = false;
    this.pendingChunks = [];
    this.pendingChunkBytes = 0;
    this.hasPendingFlush = false;
    this.isFlushingChunks = false;
    this.resampler.reset();
    this.hasEmittedAudioStart = false;

    if (this.chunkFlushTimer) {
      clearInterval(this.chunkFlushTimer);
      this.chunkFlushTimer = null;
    }

    if (this.processorNode) {
      try {
        this.processorNode.disconnect();
      } catch {}
      this.processorNode.onaudioprocess = null;
      this.processorNode = null;
    }

    if (this.mutedGainNode) {
      try {
        this.mutedGainNode.disconnect();
      } catch {}
      this.mutedGainNode = null;
    }

    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {}
      this.sourceNode = null;
    }

    const currentAudioContext = this.audioContext;
    this.audioContext = null;
    if (currentAudioContext) {
      void currentAudioContext.close().catch(() => {});
    }

    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        track.stop();
      }
      this.mediaStream = null;
    }
  }

  private handleAudioProcess(event: AudioProcessingEvent): void {
    // Send ALL audio to server — VAD is server-side now
    if (!this.isActive) return;
    if (!this.hasEmittedAudioStart) {
      this.hasEmittedAudioStart = true;
      emitVoiceLatencyEvent('capture-audio-started', { backend: 'qwen' });
    }

    const channelData = event.inputBuffer.getChannelData(0);
    if (channelData.length === 0) return;

    const sourceSamples = channelData.slice();
    const sourceRate = this.audioContext?.sampleRate ?? TARGET_SAMPLE_RATE;
    const targetSamples = this.resampler.toTarget(sourceSamples, sourceRate);
    if (targetSamples.length === 0) return;

    const pcmChunk = encodePcm16(targetSamples);
    if (pcmChunk.length === 0) return;

    this.pendingChunks.push(pcmChunk);
    this.pendingChunkBytes += pcmChunk.length;
  }

  private _flushCount = 0;
  private _lastFlushLogAt = 0;

  private async flushPendingChunks(): Promise<void> {
    if (!this.isActive || this.pendingChunkBytes === 0) return;

    if (this.isFlushingChunks) {
      this.hasPendingFlush = true;
      return;
    }

    this.isFlushingChunks = true;
    try {
      do {
        this.hasPendingFlush = false;
        const chunks = this.pendingChunks;
        const totalBytes = this.pendingChunkBytes;
        this.pendingChunks = [];
        this.pendingChunkBytes = 0;

        if (totalBytes === 0) continue;
        this._flushCount++;
        const now = Date.now();
        if (now - this._lastFlushLogAt > 2000 || this._flushCount <= 3) {
          this._lastFlushLogAt = now;
          console.log(`[VoiceCapture] flush#${this._flushCount} ${totalBytes}B`);
        }
        const pcmChunk = concatUint8Arrays(chunks, totalBytes);
        await this.options.onPcmChunk(pcmChunk);
      } while (this.hasPendingFlush && this.isActive);
    } catch (error) {
      this.options.onError?.(error);
    } finally {
      this.isFlushingChunks = false;
    }
  }
}
