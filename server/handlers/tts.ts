import { IPC_CHANNELS } from '../../electron/ipc/registry';
import {
  DEFAULT_TTS_SETTINGS,
  getTtsModelById,
  TTS_MODELS,
  TTS_PROVIDERS,
  type TtsModelId,
  type TtsProvider,
  type TtsSettings,
} from '../../shared/types/tts';
import * as configStore from '../configStore';
import { broadcastEvent } from './broadcast';
import {
  getTtsInstallRoot,
  getVoiceOptions,
  installTtsModel as installTtsModelService,
  isTtsModelInstalled,
  listTtsModels,
  readTextFromFile,
  synthesizeSpeech,
  toPlaybackBase64,
  writeSynthesizedAudio,
} from '../services/ttsService';

type TtsModelList = Awaited<ReturnType<typeof listTtsModels>>;

interface SpeakTextRequest {
  text?: string;
  inputPath?: string;
  outputPath?: string;
  play?: boolean;
  source?: 'manual' | 'assistant-auto';
  requestTag?: string;
  messageId?: string;
  sentenceIndex?: number;
  modelId?: TtsModelId;
  voiceId?: number;
  speed?: number;
  provider?: TtsProvider;
}

function validateProvider(provider: string): provider is TtsProvider {
  return (TTS_PROVIDERS as readonly string[]).includes(provider);
}

function validateModelId(modelId: string): modelId is TtsModelId {
  return !!getTtsModelById(modelId);
}

export function formatInstalledTtsModelsForError(models: TtsModelList): string {
  const installed = models.filter((model) => model.installed);
  if (installed.length === 0) {
    return 'Installed modelId values: none. Download a TTS model from Settings > Voice.';
  }

  return `Installed modelId values: ${installed.map((model) => model.id).join(', ')}.`;
}

async function createUnavailableTtsModelError(prefix: string): Promise<Error> {
  const models = await listTtsModels();
  return new Error(`${prefix}. ${formatInstalledTtsModelsForError(models)}`);
}

function createInvalidTtsProviderError(provider: string): Error {
  return new Error(`Invalid TTS provider: ${provider}. Available providers: ${TTS_PROVIDERS.join(', ')}.`);
}

function createUnavailableTtsVoiceError(
  modelId: TtsModelId,
  voiceId: number,
  voices: Array<{ id: number }>,
): Error {
  const availableVoiceIds = voices.map((voice) => voice.id).join(', ');
  return new Error(
    `voiceId ${voiceId} is not available for model ${modelId}. Available voiceId values: ${availableVoiceIds || 'none'}.`,
  );
}

function coerceFiniteNumber(value: unknown, fallback: number): number {
  if (typeof value !== 'number') return fallback;
  if (!Number.isFinite(value)) return fallback;
  return value;
}

function coerceNonNegativeInteger(value: unknown, fallback: number): number {
  if (typeof value !== 'number') return fallback;
  if (!Number.isInteger(value) || value < 0) return fallback;
  return value;
}

function coercePitchSemitones(value: unknown, fallback: number): number {
  if (typeof value !== 'number') return fallback;
  if (!Number.isFinite(value)) return fallback;
  if (value < -5 || value > 5) return fallback;
  return value;
}

function validateSettings(settings: TtsSettings): void {
  if (!validateModelId(settings.modelId)) {
    throw new Error(`Invalid TTS model: ${settings.modelId}`);
  }

  if (!validateProvider(settings.provider)) {
    throw new Error(`Invalid TTS provider: ${settings.provider}`);
  }

  if (!Number.isInteger(settings.voiceId) || settings.voiceId < 0) {
    throw new Error('voiceId must be a non-negative integer');
  }

  if (!Number.isFinite(settings.speed) || settings.speed <= 0) {
    throw new Error('speed must be a positive number');
  }
  if (!Number.isFinite(settings.pitch) || settings.pitch < -5 || settings.pitch > 5) {
    throw new Error('pitch must be between -5 and 5 semitones');
  }
  if (typeof settings.readAssistantMessages !== 'boolean') {
    throw new Error('readAssistantMessages must be a boolean');
  }

  if (typeof settings.autotuneEnabled !== 'boolean') {
    throw new Error('autotuneEnabled must be a boolean');
  }

  if (typeof settings.voiceResetEnabled !== 'boolean') {
    throw new Error('voiceResetEnabled must be a boolean');
  }

  if (typeof settings.voiceResetPhrase !== 'string' || !settings.voiceResetPhrase.trim()) {
    throw new Error('voiceResetPhrase must be a non-empty string');
  }
}

async function ensureVoiceIsAvailable(settings: TtsSettings): Promise<void> {
  if (!await isTtsModelInstalled(settings.modelId)) {
    return;
  }

  const voices = await getVoiceOptions(settings.modelId, settings.provider);
  if (!voices.some((voice) => voice.id === settings.voiceId)) {
    throw createUnavailableTtsVoiceError(settings.modelId, settings.voiceId, voices);
  }
}

async function resolveSettingsUpdate(partial: Partial<TtsSettings>): Promise<TtsSettings> {
  const current = await configStore.getTtsSettings();

  const next: TtsSettings = {
    readAssistantMessages: typeof partial.readAssistantMessages === 'boolean'
      ? partial.readAssistantMessages
      : current.readAssistantMessages,
    modelId: partial.modelId ?? current.modelId,
    voiceId: coerceNonNegativeInteger(partial.voiceId, current.voiceId),
    speed: coerceFiniteNumber(partial.speed, current.speed),
    pitch: coercePitchSemitones(partial.pitch, current.pitch),
    provider: partial.provider ?? current.provider,
    autotuneEnabled: typeof partial.autotuneEnabled === 'boolean'
      ? partial.autotuneEnabled
      : current.autotuneEnabled,
    voiceResetEnabled: typeof partial.voiceResetEnabled === 'boolean'
      ? partial.voiceResetEnabled
      : current.voiceResetEnabled,
    voiceResetPhrase: typeof partial.voiceResetPhrase === 'string' && partial.voiceResetPhrase.trim()
      ? partial.voiceResetPhrase.trim()
      : current.voiceResetPhrase,
  };

  validateSettings(next);
  await ensureVoiceIsAvailable(next);
  return next;
}

async function resolveSpeakSettings(request: SpeakTextRequest): Promise<TtsSettings> {
  const current = await configStore.getTtsSettings();

  if (typeof request.modelId === 'string' && !validateModelId(request.modelId)) {
    throw await createUnavailableTtsModelError(
      `Unknown TTS model: ${request.modelId}. Known modelId values: ${TTS_MODELS.map((model) => model.id).join(', ')}`,
    );
  }

  if (typeof request.provider === 'string' && !validateProvider(request.provider)) {
    throw createInvalidTtsProviderError(request.provider);
  }

  const resolved: TtsSettings = {
    readAssistantMessages: current.readAssistantMessages,
    modelId: request.modelId ?? current.modelId,
    voiceId: coerceNonNegativeInteger(request.voiceId, current.voiceId),
    speed: coerceFiniteNumber(request.speed, current.speed),
    pitch: current.pitch,
    provider: request.provider ?? current.provider,
    autotuneEnabled: current.autotuneEnabled,
    voiceResetEnabled: current.voiceResetEnabled,
    voiceResetPhrase: current.voiceResetPhrase,
  };

  validateSettings(resolved);
  return resolved;
}

export async function getSettings(): Promise<{ settings: TtsSettings; installRoot: string }> {
  const settings = await configStore.getTtsSettings();
  return {
    settings,
    installRoot: getTtsInstallRoot(),
  };
}

export async function setSettings(
  partial: Partial<TtsSettings>,
): Promise<{ success: boolean; settings: TtsSettings; error?: string }> {
  try {
    const next = await resolveSettingsUpdate(partial);
    await configStore.setTtsSettings(next);
    broadcastEvent(IPC_CHANNELS.TTS_SETTINGS_CHANGED, { settings: next });
    return {
      success: true,
      settings: next,
    };
  } catch (error) {
    return {
      success: false,
      settings: await configStore.getTtsSettings().catch(() => DEFAULT_TTS_SETTINGS),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function listModels(): Promise<{
  models: Awaited<ReturnType<typeof listTtsModels>>;
  installRoot: string;
}> {
  return {
    models: await listTtsModels(),
    installRoot: getTtsInstallRoot(),
  };
}

async function ensureModelInstalled(modelId: TtsModelId): Promise<void> {
  if (await isTtsModelInstalled(modelId)) {
    return;
  }
  throw await createUnavailableTtsModelError(`TTS model not installed: ${modelId}`);
}

export async function installModel(
  modelId: TtsModelId,
): Promise<{ success: boolean; modelId: TtsModelId; installPath?: string; error?: string }> {
  if (!validateModelId(modelId)) {
    return { success: false, modelId, error: `Unknown TTS model: ${modelId}` };
  }

  try {
    const installPath = await installTtsModelService(modelId, (progress) => {
      broadcastEvent(IPC_CHANNELS.TTS_INSTALL_PROGRESS, progress);
    });

    return {
      success: true,
      modelId,
      installPath,
    };
  } catch (error) {
    return {
      success: false,
      modelId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getVoices(modelId?: TtsModelId): Promise<{
  modelId: TtsModelId;
  installed: boolean;
  voices: Array<{ id: number; label: string }>;
  error?: string;
}> {
  try {
    const current = await configStore.getTtsSettings();
    const resolvedModelId = modelId ?? current.modelId;

    if (!validateModelId(resolvedModelId)) {
      throw new Error(`Unknown TTS model: ${resolvedModelId}`);
    }

    const installed = await isTtsModelInstalled(resolvedModelId);
    if (!installed) {
      return {
        modelId: resolvedModelId,
        installed: false,
        voices: [],
      };
    }

    const voices = await getVoiceOptions(resolvedModelId, current.provider);
    return {
      modelId: resolvedModelId,
      installed: true,
      voices,
    };
  } catch (error) {
    return {
      modelId: modelId ?? DEFAULT_TTS_SETTINGS.modelId,
      installed: false,
      voices: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function speakText(request: SpeakTextRequest): Promise<{
  success: boolean;
  chars?: number;
  outputPath?: string;
  modelId?: TtsModelId;
  voiceId?: number;
  durationSeconds?: number;
  error?: string;
}> {
  try {
    const settings = await resolveSpeakSettings(request);
    await ensureModelInstalled(settings.modelId);
    await ensureVoiceIsAvailable(settings);

    const fragments: string[] = [];
    if (request.text?.trim()) {
      fragments.push(request.text.trim());
    }

    if (request.inputPath?.trim()) {
      const fileText = await readTextFromFile(request.inputPath.trim());
      if (fileText.trim()) {
        fragments.push(fileText.trim());
      }
    }

    const text = fragments.join('\n\n').trim();
    if (!text) {
      throw new Error('Provide either text or inputPath with non-empty text content.');
    }

    const synthesized = await synthesizeSpeech({
      modelId: settings.modelId,
      provider: settings.provider,
      voiceId: settings.voiceId,
      speed: settings.speed,
      pitch: settings.pitch,
      autotuneEnabled: settings.autotuneEnabled,
      text,
    });

    if (request.outputPath?.trim()) {
      await writeSynthesizedAudio(request.outputPath.trim(), synthesized.wavBuffer);
    }

    const shouldPlay = request.play !== false;
    if (shouldPlay) {
      broadcastEvent(IPC_CHANNELS.TTS_PLAYBACK_REQUESTED, {
        audioBase64: toPlaybackBase64(synthesized.wavBuffer),
        mimeType: 'audio/wav',
        text,
        source: request.source ?? 'manual',
        requestTag: request.requestTag,
        messageId: request.messageId,
        sentenceIndex: Number.isInteger(request.sentenceIndex) ? request.sentenceIndex : undefined,
        modelId: settings.modelId,
        voiceId: settings.voiceId,
        speed: settings.speed,
      });
    }

    return {
      success: true,
      chars: text.length,
      outputPath: request.outputPath?.trim() || undefined,
      modelId: settings.modelId,
      voiceId: settings.voiceId,
      durationSeconds: synthesized.durationSeconds,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
