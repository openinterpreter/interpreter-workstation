export const VOICE_LATENCY_EVENT = 'voice:latency';

type VoiceLatencyRecord = {
  type: string;
  timestampMs: number;
  [key: string]: unknown;
};

type VoiceWindow = Window & {
  __voiceLatencyEvents?: VoiceLatencyRecord[];
};

export function emitVoiceLatencyEvent(
  type: string,
  payload: Record<string, unknown> = {},
): void {
  if (typeof window === 'undefined') return;

  const timestampMs = typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

  const detail: VoiceLatencyRecord = {
    type,
    timestampMs,
    ...payload,
  };

  const voiceWindow = window as VoiceWindow;
  if (Array.isArray(voiceWindow.__voiceLatencyEvents)) {
    voiceWindow.__voiceLatencyEvents.push(detail);
  }

  window.dispatchEvent(
    new CustomEvent(VOICE_LATENCY_EVENT, {
      detail,
    }),
  );
}
