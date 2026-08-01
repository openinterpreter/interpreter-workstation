import * as Moonshine from '@moonshine-ai/moonshine-js';
import { getAppServerOrigin, getRuntimeSystemInfo } from '../../src/ipc';

export interface MoonshineMicrophoneCallbacks {
  onModelLoadStarted?: () => void;
  onModelLoaded?: () => void;
  onTranscriptionUpdated?: (text: string) => void;
  onTranscriptionCommitted?: (text: string, buffer?: AudioBuffer) => void;
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
  onError?: (error: unknown) => void;
}

export interface MoonshineMicrophoneTranscriber {
  load: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => void;
}

interface MoonshineModule {
  Settings: {
    BASE_ASSET_PATH: {
      MOONSHINE: string;
    };
  };
  MicrophoneTranscriber: new (
    modelName: string,
    callbacks?: MoonshineMicrophoneCallbacks,
    useVadMode?: boolean,
  ) => MoonshineMicrophoneTranscriber;
}

let moonshineAssetBaseUrlPromise: Promise<string> | null = null;
let moonshineWarmPromise: Promise<void> | null = null;

async function getMoonshineAssetBaseUrl(): Promise<string> {
  if (!moonshineAssetBaseUrlPromise) {
    // Moonshine appends relative asset paths with raw string concatenation, so
    // the base URL cannot include a windowSessionKey query parameter.
    moonshineAssetBaseUrlPromise = getAppServerOrigin()
      .then((origin) => `${origin}/api/agent/voice/moonshine-assets/`);
  }
  return moonshineAssetBaseUrlPromise;
}

export async function loadMoonshineModule(): Promise<MoonshineModule> {
  const moonshine = Moonshine as unknown as MoonshineModule;
  if (getRuntimeSystemInfo().platform !== 'win32') {
    return moonshine;
  }

  if (!moonshine.Settings?.BASE_ASSET_PATH) {
    throw new Error('Moonshine settings are not available.');
  }

  moonshine.Settings.BASE_ASSET_PATH.MOONSHINE = await getMoonshineAssetBaseUrl();
  return moonshine;
}

export async function warmMoonshineModel(modelName: string): Promise<void> {
  if (moonshineWarmPromise) {
    return moonshineWarmPromise;
  }

  moonshineWarmPromise = (async () => {
    const moonshine = await loadMoonshineModule();
    const transcriber = new moonshine.MicrophoneTranscriber(modelName, {}, true);
    await transcriber.load();
  })().catch((error) => {
    moonshineWarmPromise = null;
    throw error;
  });

  return moonshineWarmPromise;
}
