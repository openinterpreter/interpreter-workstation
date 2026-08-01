import { IPC_CHANNELS } from '../../electron/ipc/registry';
import {
  STT_BACKENDS,
  DEFAULT_STT_SETTINGS,
  STT_MAX_FAST_SENTENCE_TIMEOUT_MS,
  STT_MAX_PREVIEW_BEFORE_SEND_MS,
  STT_MAX_SILENCE_TIMEOUT_MS,
  STT_MIN_FAST_SENTENCE_TIMEOUT_MS,
  STT_MIN_PREVIEW_BEFORE_SEND_MS,
  STT_MIN_SILENCE_TIMEOUT_MS,
  normalizeAmbientPhrases,
  type SttBackend,
  type SttSettings,
} from '../../shared/types/stt';
import * as configStore from '../configStore';
import { broadcastEvent } from './broadcast';

function coerceNumber(value: unknown, fallback: number): number {
  if (typeof value !== 'number') return fallback;
  if (!Number.isFinite(value)) return fallback;
  return value;
}

function coerceBackend(value: unknown, fallback: SttBackend): SttBackend {
  if (typeof value !== 'string') return fallback;
  if (!(STT_BACKENDS as readonly string[]).includes(value)) return fallback;
  return value as SttBackend;
}

function coerceString(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  return value;
}

function coerceBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value !== 'boolean') return fallback;
  return value;
}

function coerceStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  return value.filter((item): item is string => typeof item === 'string');
}

function validateSettings(settings: SttSettings): void {
  if (!(STT_BACKENDS as readonly string[]).includes(settings.backend)) {
    throw new Error(`Invalid STT backend: ${settings.backend}`);
  }

  if (process.platform === 'win32' && settings.backend !== 'moonshine') {
    throw new Error('Windows only supports the moonshine STT backend');
  }

  if (settings.silenceTimeoutMs < STT_MIN_SILENCE_TIMEOUT_MS || settings.silenceTimeoutMs > STT_MAX_SILENCE_TIMEOUT_MS) {
    throw new Error(`silenceTimeoutMs must be between ${STT_MIN_SILENCE_TIMEOUT_MS} and ${STT_MAX_SILENCE_TIMEOUT_MS}`);
  }

  if (settings.fastSentenceSilenceTimeoutMs < STT_MIN_FAST_SENTENCE_TIMEOUT_MS || settings.fastSentenceSilenceTimeoutMs > STT_MAX_FAST_SENTENCE_TIMEOUT_MS) {
    throw new Error(`fastSentenceSilenceTimeoutMs must be between ${STT_MIN_FAST_SENTENCE_TIMEOUT_MS} and ${STT_MAX_FAST_SENTENCE_TIMEOUT_MS}`);
  }

  if (settings.previewBeforeSendMs < STT_MIN_PREVIEW_BEFORE_SEND_MS || settings.previewBeforeSendMs > STT_MAX_PREVIEW_BEFORE_SEND_MS) {
    throw new Error(`previewBeforeSendMs must be between ${STT_MIN_PREVIEW_BEFORE_SEND_MS} and ${STT_MAX_PREVIEW_BEFORE_SEND_MS}`);
  }

  if (typeof settings.stripChineseCharacters !== 'boolean') {
    throw new Error('stripChineseCharacters must be a boolean');
  }

  if (settings.ambientTriggerPhrases.length === 0) {
    throw new Error('ambientTriggerPhrases must contain at least one phrase');
  }

  if (settings.ambientEndPhrases.length === 0) {
    throw new Error('ambientEndPhrases must contain at least one phrase');
  }
}

async function resolveSettingsUpdate(partial: Partial<SttSettings>): Promise<SttSettings> {
  const current = await configStore.getSttSettings();

  const next: SttSettings = {
    backend: coerceBackend(partial.backend, current.backend),
    stripChineseCharacters: coerceBoolean(
      partial.stripChineseCharacters,
      current.stripChineseCharacters,
    ),
    silenceTimeoutMs: coerceNumber(partial.silenceTimeoutMs, current.silenceTimeoutMs),
    fastSentenceSilenceTimeoutMs: coerceNumber(
      partial.fastSentenceSilenceTimeoutMs,
      current.fastSentenceSilenceTimeoutMs,
    ),
    previewBeforeSendMs: coerceNumber(partial.previewBeforeSendMs, current.previewBeforeSendMs),
    sendCommand: coerceString(partial.sendCommand, current.sendCommand),
    newChatCommand: coerceString(partial.newChatCommand, current.newChatCommand),
    voiceMode: (partial.voiceMode && ['conversational', 'push-to-talk', 'ambient'].includes(partial.voiceMode))
      ? partial.voiceMode
      : current.voiceMode,
    ambientTriggerPhrases: normalizeAmbientPhrases(
      coerceStringArray(partial.ambientTriggerPhrases, current.ambientTriggerPhrases),
      DEFAULT_STT_SETTINGS.ambientTriggerPhrases,
    ),
    ambientEndPhrases: normalizeAmbientPhrases(
      coerceStringArray(partial.ambientEndPhrases, current.ambientEndPhrases),
      DEFAULT_STT_SETTINGS.ambientEndPhrases,
    ),
  };

  validateSettings(next);
  return next;
}

export async function getSettings(): Promise<{ settings: SttSettings }> {
  return {
    settings: await configStore.getSttSettings(),
  };
}

export async function setSettings(
  partial: Partial<SttSettings>,
): Promise<{ success: boolean; settings: SttSettings; error?: string }> {
  try {
    const next = await resolveSettingsUpdate(partial);
    await configStore.setSttSettings(next);
    broadcastEvent(IPC_CHANNELS.STT_SETTINGS_CHANGED, { settings: next });
    return {
      success: true,
      settings: next,
    };
  } catch (error) {
    const platformDefaultSettings: SttSettings = process.platform === 'win32'
      ? { ...DEFAULT_STT_SETTINGS, backend: 'moonshine' }
      : DEFAULT_STT_SETTINGS;
    return {
      success: false,
      settings: await configStore.getSttSettings().catch(() => platformDefaultSettings),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
