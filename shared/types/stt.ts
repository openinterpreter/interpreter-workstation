export const STT_BACKENDS = ['qwen', 'moonshine'] as const;
export type SttBackend = (typeof STT_BACKENDS)[number];

export const VOICE_MODES = ['conversational', 'push-to-talk', 'ambient'] as const;
export type VoiceMode = (typeof VOICE_MODES)[number];

export interface SttSettings {
  backend: SttBackend;
  stripChineseCharacters: boolean;
  silenceTimeoutMs: number;
  fastSentenceSilenceTimeoutMs: number;
  previewBeforeSendMs: number;
  sendCommand: string;
  newChatCommand: string;
  voiceMode: VoiceMode;
  ambientTriggerPhrases: string[];
  ambientEndPhrases: string[];
}

export const STT_MIN_SILENCE_TIMEOUT_MS = 250;
export const STT_MAX_SILENCE_TIMEOUT_MS = 8000;
export const STT_MIN_FAST_SENTENCE_TIMEOUT_MS = 100;
export const STT_MAX_FAST_SENTENCE_TIMEOUT_MS = 4000;
export const STT_MIN_PREVIEW_BEFORE_SEND_MS = 0;
export const STT_MAX_PREVIEW_BEFORE_SEND_MS = 4000;
export const DEFAULT_AMBIENT_TRIGGER_PHRASES = ['Interpreter', 'Repertor'];
export const DEFAULT_AMBIENT_END_PHRASES = ['make it so', 'take it so'];

export function normalizeAmbientPhrases(phrases: readonly string[], fallback: readonly string[]): string[] {
  const normalized = Array.from(new Set(
    phrases
      .map((phrase) => phrase.trim())
      .filter((phrase) => phrase.length > 0),
  ));

  if (normalized.length > 0) {
    return normalized;
  }

  return [...fallback];
}

export function getPrimaryAmbientPhrase(phrases: readonly string[], fallback: string): string {
  return normalizeAmbientPhrases(phrases, [fallback])[0] ?? fallback;
}

export const DEFAULT_STT_SETTINGS: SttSettings = {
  backend: 'qwen',
  stripChineseCharacters: true,
  silenceTimeoutMs: 2000,
  fastSentenceSilenceTimeoutMs: 700,
  previewBeforeSendMs: 0,
  sendCommand: 'make it so',
  newChatCommand: 'new chat',
  voiceMode: 'conversational',
  ambientTriggerPhrases: [...DEFAULT_AMBIENT_TRIGGER_PHRASES],
  ambientEndPhrases: [...DEFAULT_AMBIENT_END_PHRASES],
};
