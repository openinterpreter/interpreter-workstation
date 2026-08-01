import {
  abortVoiceStreamSession,
  appendVoiceStreamChunk,
  getAdaptiveVoiceSilenceTimeoutMs,
  startVoiceStreamSession,
  type StartVoiceStreamOptions,
} from './voiceCapture';
import { emitVoiceLatencyEvent } from './voiceLatency';
import { mergeStreamingVoiceTranscript, normalizeVoiceText } from './voiceTranscript';

export interface QwenVoiceChunkUpdate {
  transcript: string;
  silenceTimeoutMs: number;
  isSpeech: boolean;
}

export class QwenVoiceStreamBridge {
  private sessionId: string | null = null;
  private startPromise: Promise<string> | null = null;
  private chunkQueue: Promise<void> = Promise.resolve();
  private latestTranscript = '';
  private committedTranscript = '';
  private consecutiveErrors = 0;
  private onError: ((error: unknown) => void) | null = null;
  private startOptions: StartVoiceStreamOptions | undefined;

  constructor(onError?: (error: unknown) => void, startOptions?: StartVoiceStreamOptions) {
    this.onError = onError ?? null;
    this.startOptions = startOptions;
  }

  reset(): void {
    this.latestTranscript = '';
    this.committedTranscript = '';
    this.chunkQueue = Promise.resolve();
    this.consecutiveErrors = 0;
  }

  async ensureSession(): Promise<string> {
    if (this.sessionId) return this.sessionId;
    if (this.startPromise) return this.startPromise;

    this.startPromise = startVoiceStreamSession(this.startOptions)
      .then((sessionId) => {
        this.sessionId = sessionId;
        this.consecutiveErrors = 0;
        return sessionId;
      })
      .finally(() => {
        this.startPromise = null;
      });

    return this.startPromise;
  }

  private invalidateSession(): void {
    this.sessionId = null;
    this.startPromise = null;
  }

  private _chunksSent = 0;
  private _chunksCompleted = 0;
  private _lastLogAt = 0;

  enqueueChunk(pcmChunk: Uint8Array, onUpdate: (update: QwenVoiceChunkUpdate) => void): Promise<void> {
    this.chunkQueue = this.chunkQueue.then(async () => {
      if (pcmChunk.length === 0) return;

      this._chunksSent++;
      const chunkNum = this._chunksSent;

      try {
        const sessionId = await this.ensureSession();
        const t0 = Date.now();
        const result = await appendVoiceStreamChunk(sessionId, pcmChunk);
        const elapsed = Date.now() - t0;
        this._chunksCompleted++;
        const transcript = normalizeVoiceText(result.text);
        const isSpeech = result.isSpeech;
        this.consecutiveErrors = 0;

        // Log periodically (every 2s) or on transcript changes
        const now = Date.now();
        if (now - this._lastLogAt > 2000 || (transcript && transcript !== this.latestTranscript)) {
          this._lastLogAt = now;
          console.log(`[VoiceBridge] chunk#${chunkNum} ${elapsed}ms speech=${isSpeech} queued=${chunkNum - this._chunksCompleted} transcript="${transcript.slice(-50)}"`);
        }

        if (!transcript && !isSpeech) return;
        if (transcript) {
          // The macOS native recognizer emits the latest full hypothesis for the
          // active recognition task. Re-merging those revisions can duplicate
          // text when Apple rewrites the hypothesis from a shifted window, so
          // trust the latest native transcript verbatim.
          this.latestTranscript = this.startOptions?.nativeRecognizer
            ? transcript
            : mergeStreamingVoiceTranscript(this.latestTranscript, transcript);
        }

        const currentTranscript = this.latestTranscript;
        const silenceTimeoutMs = getAdaptiveVoiceSilenceTimeoutMs(currentTranscript);
        emitVoiceLatencyEvent('transcript-updated', {
          backend: 'qwen',
          transcript: currentTranscript,
          silenceTimeoutMs,
          isSpeech,
        });

        onUpdate({
          transcript: currentTranscript,
          silenceTimeoutMs,
          isSpeech,
        });
      } catch (error) {
        // Timeouts (AbortError) are expected under backpressure — skip the
        // chunk silently so the queue doesn't stall.
        const isTimeout = error instanceof DOMException && error.name === 'AbortError';
        const errorMessage = error instanceof Error ? error.message : String(error);
        const isSessionClosing =
          errorMessage.includes('Voice stream session is closing')
          || errorMessage.includes('Unknown voice stream session');
        if (isTimeout) {
          console.warn('[QwenVoiceStreamBridge] Chunk timed out — skipping');
          return;
        }
        if (isSessionClosing) {
          console.warn('[QwenVoiceStreamBridge] Chunk skipped during session shutdown');
          return;
        }

        this.consecutiveErrors++;
        console.error('[QwenVoiceStreamBridge] Chunk failed:', error);

        // Session is dead (killed by cleanup, process crashed, etc.)
        // Invalidate so next chunk starts a fresh session.
        this.invalidateSession();

        // After too many consecutive failures, surface the error
        if (this.consecutiveErrors >= 3) {
          this.onError?.(error);
        }
      }
    });

    return this.chunkQueue;
  }

  async waitForQueuedChunks(): Promise<void> {
    await this.chunkQueue;
  }

  async snapshotUtterance(preferredTranscript = ''): Promise<{ transcript: string; delta: string }> {
    await this.waitForQueuedChunks();

    const transcript = normalizeVoiceText(preferredTranscript || this.latestTranscript);
    if (!transcript) {
      return { transcript: '', delta: '' };
    }

    const previousTokens = this.committedTranscript.match(/\S+/g) ?? [];
    const currentTokens = transcript.match(/\S+/g) ?? [];
    let prefixLength = 0;
    while (
      prefixLength < previousTokens.length
      && prefixLength < currentTokens.length
      && previousTokens[prefixLength] === currentTokens[prefixLength]
    ) {
      prefixLength += 1;
    }

    const delta = currentTokens.slice(prefixLength).join(' ').trim();
    return { transcript, delta };
  }

  commitUtterance(transcript: string): void {
    const normalized = normalizeVoiceText(transcript);
    if (!normalized) return;
    this.committedTranscript = normalized;
  }

  abort(): void {
    const sessionId = this.sessionId;
    this.reset();
    if (!sessionId) return;

    void abortVoiceStreamSession(sessionId).catch(() => {});
  }
}
