import { useCallback, useEffect, useRef } from 'react';
import { tts as ttsIpc } from '../../src/ipc';
import type { TtsPlaybackRequestedEvent } from '../../electron/ipc/registry';

const ASSISTANT_TTS_ENQUEUE_EVENT = 'assistant-tts:enqueue-sentence';
const ASSISTANT_TTS_STOP_EVENT = 'assistant-tts:stop';
const ASSISTANT_TTS_MESSAGE_SPEAKING_EVENT = 'assistant-tts:message-speaking';
const ASSISTANT_TTS_PLAYBACK_STATE_EVENT = 'assistant-tts:playback-state';

interface EnqueuedSentence {
  text: string;
  messageId: string;
  sentenceIndex: number;
  source: 'assistant-auto' | 'manual';
}

/**
 * Singleton hook that wires the TTS playback pipeline:
 *   enqueue-sentence events → tts.speak IPC → playback-requested broadcast → Audio playback
 *
 * Also handles standalone playback from the speak_text tool and settings previews
 * (audio arrives via onPlaybackRequested without a preceding enqueue event).
 *
 * Mount this exactly once (e.g. in PersistentLayer).
 */
export function useTtsPlayback(): void {
  "use no memo";

  const queueRef = useRef<EnqueuedSentence[]>([]);
  const isProcessingRef = useRef(false);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const stoppedRef = useRef(false);
  const playbackResolveRef = useRef<(() => void) | null>(null);

  const stopPlayback = useCallback(() => {
    stoppedRef.current = true;
    queueRef.current = [];

    const audio = currentAudioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      currentAudioRef.current = null;
    }

    const resolve = playbackResolveRef.current;
    playbackResolveRef.current = null;
    resolve?.();

    window.dispatchEvent(
      new CustomEvent(ASSISTANT_TTS_PLAYBACK_STATE_EVENT, {
        detail: { isSpeaking: false },
      }),
    );
    window.dispatchEvent(
      new CustomEvent(ASSISTANT_TTS_MESSAGE_SPEAKING_EVENT, {
        detail: { messageId: null, sentenceIndex: null, text: null },
      }),
    );
  }, []);

  // Listen for synthesised audio from the server and play it.
  // Audio arrives here from two sources:
  //   1. Queue-driven: processQueue → tts.speak → server broadcasts
  //   2. Standalone:   speak_text tool / settings preview → server broadcasts
  useEffect(() => {
    const unsubscribe = ttsIpc.onPlaybackRequested((event: TtsPlaybackRequestedEvent) => {
      // If the queue was stopped AND the queue loop is still unwinding,
      // this is stale in-flight audio from the cancelled run — drop it.
      if (stoppedRef.current && isProcessingRef.current) {
        return;
      }

      // Clear any leftover stop flag so standalone audio (tool calls,
      // settings previews) is never blocked by a previous stop.
      stoppedRef.current = false;

      window.dispatchEvent(
        new CustomEvent(ASSISTANT_TTS_MESSAGE_SPEAKING_EVENT, {
          detail: {
            messageId: event.messageId ?? null,
            sentenceIndex: event.sentenceIndex ?? null,
            text: event.text ?? null,
          },
        }),
      );

      const audio = new Audio(`data:${event.mimeType};base64,${event.audioBase64}`);
      currentAudioRef.current = audio;

      const finish = () => {
        if (currentAudioRef.current === audio) {
          currentAudioRef.current = null;
        }
        const resolve = playbackResolveRef.current;
        playbackResolveRef.current = null;
        resolve?.();
      };

      audio.onended = finish;
      audio.onerror = finish;
      audio.play().catch(finish);
    });

    return unsubscribe;
  }, []);

  // Drain the sentence queue one sentence at a time.
  const processQueue = useCallback(async () => {
    if (isProcessingRef.current) return;
    isProcessingRef.current = true;
    stoppedRef.current = false;

    window.dispatchEvent(
      new CustomEvent(ASSISTANT_TTS_PLAYBACK_STATE_EVENT, {
        detail: { isSpeaking: true },
      }),
    );

    while (queueRef.current.length > 0 && !stoppedRef.current) {
      const sentence = queueRef.current.shift()!;

      // Prepare a promise that resolves when audio playback finishes.
      // Must be created *before* calling speak() because the server broadcasts
      // the audio synchronously inside the handler (before speak() resolves).
      const playbackPromise = new Promise<void>((resolve) => {
        playbackResolveRef.current = resolve;
      });

      try {
        const result = await ttsIpc.speak({
          text: sentence.text,
          play: true,
          source: sentence.source,
          messageId: sentence.messageId,
          sentenceIndex: sentence.sentenceIndex,
        });

        if (!result.success || stoppedRef.current) {
          // No broadcast was sent (or we were stopped) — resolve manually.
          const resolve = playbackResolveRef.current;
          playbackResolveRef.current = null;
          resolve?.();
          continue;
        }

        await playbackPromise;
      } catch {
        const resolve = playbackResolveRef.current;
        playbackResolveRef.current = null;
        resolve?.();
      }
    }

    isProcessingRef.current = false;

    if (!stoppedRef.current) {
      window.dispatchEvent(
        new CustomEvent(ASSISTANT_TTS_PLAYBACK_STATE_EVENT, {
          detail: { isSpeaking: false },
        }),
      );
      window.dispatchEvent(
        new CustomEvent(ASSISTANT_TTS_MESSAGE_SPEAKING_EVENT, {
          detail: { messageId: null, sentenceIndex: null, text: null },
        }),
      );
    }

    // Pick up sentences enqueued while the loop was winding down after a stop.
    if (queueRef.current.length > 0) {
      void processQueue();
    }
  }, []);

  // Listen for enqueue and stop events from the rest of the app.
  useEffect(() => {
    const handleEnqueue = (event: Event) => {
      const detail = (event as CustomEvent<EnqueuedSentence>).detail;
      if (!detail?.text) return;

      queueRef.current.push({
        text: detail.text,
        messageId: detail.messageId,
        sentenceIndex: detail.sentenceIndex,
        source: detail.source ?? 'manual',
      });

      void processQueue();
    };

    const handleStop = () => {
      stopPlayback();
    };

    window.addEventListener(ASSISTANT_TTS_ENQUEUE_EVENT, handleEnqueue as EventListener);
    window.addEventListener(ASSISTANT_TTS_STOP_EVENT, handleStop);

    return () => {
      window.removeEventListener(ASSISTANT_TTS_ENQUEUE_EVENT, handleEnqueue as EventListener);
      window.removeEventListener(ASSISTANT_TTS_STOP_EVENT, handleStop);
      stopPlayback();
    };
  }, [processQueue, stopPlayback]);
}
