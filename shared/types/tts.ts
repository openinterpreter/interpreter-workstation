export const TTS_PROVIDERS = ['cpu', 'xnnpack', 'coreml', 'cuda'] as const;
export type TtsProvider = (typeof TTS_PROVIDERS)[number];

export const TTS_MODEL_FAMILIES = ['kitten', 'kokoro', 'vits'] as const;
export type TtsModelFamily = (typeof TTS_MODEL_FAMILIES)[number];
export type TtsModelSize = 'nano' | 'mini' | 'medium' | 'large';
export const DEFAULT_TTS_MODEL_ID = 'vits-piper-en_US-libritts_r-medium' as const;

export const TTS_MODELS = [
  {
    id: 'kitten-nano-en-v0_2-fp16',
    family: 'kitten',
    size: 'nano',
    label: 'Kitten Nano (English v0.2, fp16)',
    description: 'Fastest and recommended for real-time playback.',
    assetName: 'kitten-nano-en-v0_2-fp16.tar.bz2',
    rootDirName: 'kitten-nano-en-v0_2-fp16',
    modelFile: 'model.fp16.onnx',
    voicesFile: 'voices.bin',
    tokensFile: 'tokens.txt',
    dataDir: 'espeak-ng-data',
    downloadBytes: 26600550,
  },
  {
    id: 'kitten-mini-en-v0_1-fp16',
    family: 'kitten',
    size: 'mini',
    label: 'Kitten Mini (English v0.1, fp16)',
    description: 'Higher quality than nano at a higher compute cost.',
    assetName: 'kitten-mini-en-v0_1-fp16.tar.bz2',
    rootDirName: 'kitten-mini-en-v0_1-fp16',
    modelFile: 'model.fp16.onnx',
    voicesFile: 'voices.bin',
    tokensFile: 'tokens.txt',
    dataDir: 'espeak-ng-data',
    downloadBytes: 156677678,
  },
  {
    id: 'kokoro-en-v0_19',
    family: 'kokoro',
    size: 'medium',
    label: 'Kokoro English (v0.19)',
    description: 'Natural-sounding English Kokoro model with 11 speakers.',
    assetName: 'kokoro-en-v0_19.tar.bz2',
    rootDirName: 'kokoro-en-v0_19',
    modelFile: 'model.onnx',
    voicesFile: 'voices.bin',
    tokensFile: 'tokens.txt',
    dataDir: 'espeak-ng-data',
    downloadBytes: 319625534,
  },
  {
    id: 'kokoro-multi-lang-v1_0',
    family: 'kokoro',
    size: 'large',
    label: 'Kokoro Multi-Lang (EN/JA/ZH, v1.0)',
    description: 'Multi-language Kokoro model with English, Japanese, Chinese, and more (53 speakers).',
    assetName: 'kokoro-multi-lang-v1_0.tar.bz2',
    rootDirName: 'kokoro-multi-lang-v1_0',
    modelFile: 'model.onnx',
    voicesFile: 'voices.bin',
    tokensFile: 'tokens.txt',
    dataDir: 'espeak-ng-data',
    lexiconFile: 'lexicon-us-en.txt,lexicon-zh.txt',
    downloadBytes: 349418188,
  },
  {
    id: 'vits-piper-zh_CN-huayan-medium',
    family: 'vits',
    size: 'medium',
    label: 'Piper Huayan (zh_CN medium)',
    description: 'Mandarin Chinese Piper voice for native Chinese playback.',
    assetName: 'vits-piper-zh_CN-huayan-medium.tar.bz2',
    rootDirName: 'vits-piper-zh_CN-huayan-medium',
    modelFile: 'zh_CN-huayan-medium.onnx',
    tokensFile: 'tokens.txt',
    dataDir: 'espeak-ng-data',
    downloadBytes: 67255926,
  },
  {
    id: 'vits-piper-en_US-lessac-medium',
    family: 'vits',
    size: 'medium',
    label: 'Piper Lessac (en_US medium)',
    description: 'Piper VITS voice with strong clarity and broad compatibility.',
    assetName: 'vits-piper-en_US-lessac-medium.tar.bz2',
    rootDirName: 'vits-piper-en_US-lessac-medium',
    modelFile: 'en_US-lessac-medium.onnx',
    tokensFile: 'tokens.txt',
    dataDir: 'espeak-ng-data',
    downloadBytes: 67230653,
  },
  {
    id: 'vits-piper-en_US-glados',
    family: 'vits',
    size: 'medium',
    label: 'Piper Glados (en_US)',
    description: 'GlaDOS-style English Piper voice with synthetic character.',
    assetName: 'vits-piper-en_US-glados.tar.bz2',
    rootDirName: 'vits-piper-en_US-glados',
    modelFile: 'en_US-glados.onnx',
    tokensFile: 'tokens.txt',
    dataDir: 'espeak-ng-data',
    downloadBytes: 67208137,
  },
  {
    id: 'vits-piper-en_US-libritts_r-medium',
    family: 'vits',
    size: 'medium',
    label: 'Piper LibriTTS-R (en_US medium)',
    description: 'Cleaner US English Piper voice trained from LibriTTS.',
    assetName: 'vits-piper-en_US-libritts_r-medium.tar.bz2',
    rootDirName: 'vits-piper-en_US-libritts_r-medium',
    modelFile: 'en_US-libritts_r-medium.onnx',
    tokensFile: 'tokens.txt',
    dataDir: 'espeak-ng-data',
    downloadBytes: 82038311,
  },
  {
    id: 'vits-piper-es_ES-davefx-medium',
    family: 'vits',
    size: 'medium',
    label: 'Piper DaveFX (es_ES medium)',
    description: 'Spanish (Spain) Piper voice for non-English playback.',
    assetName: 'vits-piper-es_ES-davefx-medium.tar.bz2',
    rootDirName: 'vits-piper-es_ES-davefx-medium',
    modelFile: 'es_ES-davefx-medium.onnx',
    tokensFile: 'tokens.txt',
    dataDir: 'espeak-ng-data',
    downloadBytes: 67184952,
  },
  {
    id: 'vits-piper-de_DE-thorsten-medium',
    family: 'vits',
    size: 'medium',
    label: 'Piper Thorsten (de_DE medium)',
    description: 'German Piper voice with strong intelligibility.',
    assetName: 'vits-piper-de_DE-thorsten-medium.tar.bz2',
    rootDirName: 'vits-piper-de_DE-thorsten-medium',
    modelFile: 'de_DE-thorsten-medium.onnx',
    tokensFile: 'tokens.txt',
    dataDir: 'espeak-ng-data',
    downloadBytes: 67214254,
  },
  {
    id: 'vits-piper-fr_FR-siwis-medium',
    family: 'vits',
    size: 'medium',
    label: 'Piper Siwis (fr_FR medium)',
    description: 'French Piper voice for non-English playback.',
    assetName: 'vits-piper-fr_FR-siwis-medium.tar.bz2',
    rootDirName: 'vits-piper-fr_FR-siwis-medium',
    modelFile: 'fr_FR-siwis-medium.onnx',
    tokensFile: 'tokens.txt',
    dataDir: 'espeak-ng-data',
    downloadBytes: 67207459,
  },
] as const;

export type TtsModelId = (typeof TTS_MODELS)[number]['id'];

export interface TtsModelDefinition {
  id: TtsModelId;
  family: TtsModelFamily;
  size: TtsModelSize;
  label: string;
  description: string;
  assetName: string;
  rootDirName: string;
  modelFile?: string;
  voicesFile?: string;
  tokensFile?: string;
  dataDir?: string;
  lexiconFile?: string;
  acousticModelFile?: string;
  vocoderFile?: string;
  lang?: string;
  downloadBytes: number;
}

export interface TtsSettings {
  readAssistantMessages: boolean;
  modelId: TtsModelId;
  voiceId: number;
  speed: number;
  pitch: number;
  provider: TtsProvider;
  autotuneEnabled: boolean;
  voiceResetEnabled: boolean;
  voiceResetPhrase: string;
}

export const DEFAULT_TTS_SETTINGS: TtsSettings = {
  readAssistantMessages: false,
  modelId: DEFAULT_TTS_MODEL_ID,
  voiceId: 0,
  speed: 1,
  pitch: 0,
  provider: 'cpu',
  autotuneEnabled: false,
  voiceResetEnabled: false,
  voiceResetPhrase: 'Forget everything you know',
};

export function getTtsModelById(modelId: string): TtsModelDefinition | null {
  const model = TTS_MODELS.find((candidate) => candidate.id === modelId);
  if (!model) return null;
  return model;
}

export function getDefaultTtsModelForSize(size: TtsModelSize): TtsModelDefinition {
  const preferredModel = getTtsModelById(DEFAULT_TTS_MODEL_ID);
  if (preferredModel && preferredModel.size === size) {
    return preferredModel;
  }

  const model = TTS_MODELS.find((candidate) => candidate.size === size);
  if (!model) {
    return TTS_MODELS[0];
  }
  return model;
}

export function getDefaultTtsModelForFamily(family: TtsModelFamily): TtsModelDefinition {
  const preferredModel = getTtsModelById(DEFAULT_TTS_MODEL_ID);
  if (preferredModel && preferredModel.family === family) {
    return preferredModel;
  }

  const model = TTS_MODELS.find((candidate) => candidate.family === family);
  if (!model) {
    return TTS_MODELS[0];
  }
  return model;
}
