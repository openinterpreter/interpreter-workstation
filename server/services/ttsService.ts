import { createReadStream, createWriteStream } from 'node:fs';
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  dirname,
  join,
  posix as pathPosix,
  resolve,
  sep,
} from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Worker } from 'node:worker_threads';
// @ts-ignore - no type declarations for tar-stream
import tar, { type Headers as TarHeader } from 'tar-stream';
// @ts-ignore - no type declarations for unbzip2-stream
import unbzip2Stream from 'unbzip2-stream';
import {
  getTtsModelById,
  TTS_MODELS,
  type TtsModelDefinition,
  type TtsModelFamily,
  type TtsModelId,
  type TtsProvider,
} from '../../shared/types/tts';

const TTS_RELEASE_BASE_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models';
const TTS_INSTALL_DIRNAME = 'tts-models';

export interface TtsModelStatus {
  id: TtsModelId;
  size: TtsModelDefinition['size'];
  label: string;
  description: string;
  installed: boolean;
  installPath: string;
}

export interface TtsInstallProgress {
  modelId: TtsModelId;
  stage: 'preparing' | 'downloading' | 'extracting' | 'complete' | 'error';
  message?: string;
  bytesDownloaded?: number;
  totalBytes?: number;
  error?: string;
}

export interface TtsVoiceOption {
  id: number;
  label: string;
}

interface OfflineTtsGeneratedAudio {
  samples: Float32Array;
  sampleRate: number;
}

interface OfflineTtsEngine {
  sampleRate: number;
  numSpeakers: number;
  generate(config: { text: string; sid: number; speed: number }): OfflineTtsGeneratedAudio;
  free(): void;
}

interface TtsEngineCacheEntry {
  engine: OfflineTtsEngine;
  modelId: TtsModelId;
  provider: TtsProvider;
}

interface ModelRuntimePaths {
  family: TtsModelFamily;
  modelPath?: string;
  voicesPath?: string;
  tokensPath?: string;
  dataDirPath?: string;
  lexiconPath?: string;
  acousticModelPath?: string;
  vocoderPath?: string;
  lang?: string;
}

const modelInstallLocks = new Map<TtsModelId, Promise<string>>();
const engineCache = new Map<string, TtsEngineCacheEntry>();

function getCacheKey(modelId: TtsModelId, provider: TtsProvider): string {
  return `${modelId}:${provider}`;
}

function getUserDataPath(): string {
  if (process.versions.electron) {
    // Lazy load electron so browser mode can still typecheck.
    const { app } = require('electron') as { app: { getPath(name: 'userData'): string } };
    return app.getPath('userData');
  }

  return join(homedir(), '.interpreter');
}

export function getTtsInstallRoot(): string {
  const testInstallRoot = process.env.TEST_TTS_INSTALL_ROOT?.trim();
  if (testInstallRoot) {
    return resolve(testInstallRoot);
  }
  return join(getUserDataPath(), TTS_INSTALL_DIRNAME);
}

function getModelInstallParent(modelId: TtsModelId): string {
  return join(getTtsInstallRoot(), modelId);
}

function getExtractedModelRoot(modelId: TtsModelId): string {
  const model = getModelByIdOrThrow(modelId);
  return join(getModelInstallParent(modelId), model.rootDirName);
}

function getModelByIdOrThrow(modelId: TtsModelId): TtsModelDefinition {
  const model = getTtsModelById(modelId);
  if (!model) {
    throw new Error(`Unknown TTS model: ${modelId}`);
  }
  return model;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function resolveModelFilePath(root: string, relativePath?: string): string | undefined {
  if (!relativePath) return undefined;
  return join(root, relativePath);
}

function resolveModelPathList(root: string, value?: string): string | undefined {
  if (!value) return undefined;
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return undefined;
  return parts.map((part) => join(root, part)).join(',');
}

function parsePathList(value?: string): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function requireModelField(
  model: TtsModelDefinition,
  field: keyof TtsModelDefinition,
): string {
  const value = model[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Model ${model.id} is missing required field: ${String(field)}`);
  }
  return value;
}

function getModelRuntimePaths(modelId: TtsModelId): ModelRuntimePaths {
  const model = getModelByIdOrThrow(modelId);
  const root = getExtractedModelRoot(modelId);

  if (model.family === 'kitten') {
    return {
      family: 'kitten',
      modelPath: join(root, requireModelField(model, 'modelFile')),
      voicesPath: join(root, requireModelField(model, 'voicesFile')),
      tokensPath: join(root, requireModelField(model, 'tokensFile')),
      dataDirPath: join(root, requireModelField(model, 'dataDir')),
    };
  }

  if (model.family === 'kokoro') {
    return {
      family: 'kokoro',
      modelPath: join(root, requireModelField(model, 'modelFile')),
      voicesPath: join(root, requireModelField(model, 'voicesFile')),
      tokensPath: join(root, requireModelField(model, 'tokensFile')),
      dataDirPath: join(root, requireModelField(model, 'dataDir')),
      lexiconPath: resolveModelPathList(root, model.lexiconFile),
      lang: model.lang,
    };
  }

  if (model.family === 'vits') {
    return {
      family: 'vits',
      modelPath: join(root, requireModelField(model, 'modelFile')),
      tokensPath: join(root, requireModelField(model, 'tokensFile')),
      dataDirPath: join(root, requireModelField(model, 'dataDir')),
      lexiconPath: resolveModelFilePath(root, model.lexiconFile),
    };
  }

  throw new Error(`Unsupported TTS model family: ${model.family}`);
}

async function validateModelInstall(modelId: TtsModelId): Promise<string> {
  const root = getExtractedModelRoot(modelId);
  const required = getModelRuntimePaths(modelId);

  await access(root);

  const requiredFiles = [
    required.modelPath,
    required.voicesPath,
    required.tokensPath,
    required.acousticModelPath,
    required.vocoderPath,
    ...parsePathList(required.lexiconPath),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);

  for (const filePath of requiredFiles) {
    await access(filePath);
  }

  if (required.dataDirPath) {
    const dataDirStats = await stat(required.dataDirPath);
    if (!dataDirStats.isDirectory()) {
      throw new Error(`Invalid TTS model data directory: ${required.dataDirPath}`);
    }
  }

  return root;
}

export async function isTtsModelInstalled(modelId: TtsModelId): Promise<boolean> {
  try {
    await validateModelInstall(modelId);
    return true;
  } catch {
    return false;
  }
}

export async function listTtsModels(): Promise<TtsModelStatus[]> {
  const result: TtsModelStatus[] = [];

  for (const model of TTS_MODELS) {
    const installed = await isTtsModelInstalled(model.id);
    result.push({
      id: model.id,
      size: model.size,
      label: model.label,
      description: model.description,
      installed,
      installPath: getExtractedModelRoot(model.id),
    });
  }

  return result;
}

function resolveArchiveDestination(modelId: TtsModelId): string {
  return join(getTtsInstallRoot(), `${modelId}.tar.bz2`);
}

function getModelDownloadUrl(modelId: TtsModelId): string {
  const model = getModelByIdOrThrow(modelId);
  return `${TTS_RELEASE_BASE_URL}/${model.assetName}`;
}

async function downloadArchive(
  url: string,
  destination: string,
  onProgress?: (bytesDownloaded: number, totalBytes: number | undefined) => void,
): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download TTS model archive: HTTP ${response.status}`);
  }

  const totalBytesHeader = response.headers.get('content-length');
  const totalBytes = totalBytesHeader ? Number(totalBytesHeader) : undefined;

  let bytesDownloaded = 0;
  const progressStream = new Transform({
    transform(chunk, _encoding, callback) {
      bytesDownloaded += Buffer.byteLength(chunk);
      onProgress?.(bytesDownloaded, totalBytes);
      callback(null, chunk);
    },
  });

  const bodyStream = Readable.fromWeb(response.body as never);
  await pipeline(bodyStream, progressStream, createWriteStream(destination));
}

function resolveArchiveEntry(baseDir: string, entryName: string): string {
  const normalized = pathPosix.normalize(entryName).replace(/^\/+/, '');

  if (normalized === '.' || normalized === '') {
    return baseDir;
  }

  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Unsafe archive entry path: ${entryName}`);
  }

  const destinationPath = resolve(baseDir, normalized.split('/').join(sep));
  const basePrefix = baseDir.endsWith(sep) ? baseDir : `${baseDir}${sep}`;
  if (destinationPath !== baseDir && !destinationPath.startsWith(basePrefix)) {
    throw new Error(`Archive entry escapes destination: ${entryName}`);
  }

  return destinationPath;
}

async function extractTarBz2Archive(archivePath: string, destinationDir: string): Promise<void> {
  const extract = tar.extract();

  const extractDone = new Promise<void>((resolvePromise, rejectPromise) => {
    extract.on('entry', (header: TarHeader, stream: Readable, next: () => void) => {
      let destinationPath: string;
      try {
        destinationPath = resolveArchiveEntry(destinationDir, header.name);
      } catch (error) {
        stream.resume();
        rejectPromise(error);
        return;
      }

      if (header.type === 'directory') {
        void mkdir(destinationPath, { recursive: true })
          .then(() => {
            stream.resume();
            stream.on('end', () => next());
          })
          .catch(rejectPromise);
        return;
      }

      if (header.type !== 'file') {
        stream.resume();
        stream.on('end', () => next());
        return;
      }

      void mkdir(dirname(destinationPath), { recursive: true })
        .then(() => {
          const writeStream = createWriteStream(destinationPath, {
            mode: header.mode ?? 0o644,
          });
          stream.pipe(writeStream);
          writeStream.on('finish', () => next());
          writeStream.on('error', rejectPromise);
          stream.on('error', rejectPromise);
        })
        .catch(rejectPromise);
    });

    extract.on('finish', () => resolvePromise());
    extract.on('error', rejectPromise);
  });

  await pipeline(createReadStream(archivePath), unbzip2Stream(), extract);
  await extractDone;
}

export async function installTtsModel(
  modelId: TtsModelId,
  onProgress?: (progress: TtsInstallProgress) => void,
): Promise<string> {
  if (modelInstallLocks.has(modelId)) {
    return modelInstallLocks.get(modelId)!;
  }

  const installPromise = (async () => {
    try {
      onProgress?.({ modelId, stage: 'preparing', message: 'Preparing model install' });

      const installRoot = getTtsInstallRoot();
      const modelInstallParent = getModelInstallParent(modelId);
      const stagingDir = `${modelInstallParent}.staging`;
      const archivePath = resolveArchiveDestination(modelId);

      await mkdir(installRoot, { recursive: true });
      await rm(stagingDir, { recursive: true, force: true });
      await rm(modelInstallParent, { recursive: true, force: true });
      await mkdir(stagingDir, { recursive: true });

      onProgress?.({ modelId, stage: 'downloading', message: 'Downloading model archive' });

      const archiveUrl = getModelDownloadUrl(modelId);
      await downloadArchive(archiveUrl, archivePath, (bytesDownloaded, totalBytes) => {
        onProgress?.({
          modelId,
          stage: 'downloading',
          bytesDownloaded,
          totalBytes,
          message: 'Downloading model archive',
        });
      });

      onProgress?.({ modelId, stage: 'extracting', message: 'Extracting model files' });
      await extractTarBz2Archive(archivePath, stagingDir);

      await rm(archivePath, { force: true });
      await rename(stagingDir, modelInstallParent);

      const installedRoot = await validateModelInstall(modelId);
      onProgress?.({ modelId, stage: 'complete', message: installedRoot });
      return installedRoot;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onProgress?.({ modelId, stage: 'error', error: message });
      throw error;
    }
  })().finally(() => {
    modelInstallLocks.delete(modelId);
  });

  modelInstallLocks.set(modelId, installPromise);
  return installPromise;
}

function getCreateOfflineTtsFactory(moduleExport: unknown): ((config: unknown) => OfflineTtsEngine) {
  if (moduleExport && typeof moduleExport === 'object') {
    const asRecord = moduleExport as Record<string, unknown>;

    if (typeof asRecord.createOfflineTts === 'function') {
      return asRecord.createOfflineTts as (config: unknown) => OfflineTtsEngine;
    }

    const defaultExport = asRecord.default;
    if (defaultExport && typeof defaultExport === 'object') {
      const defaultRecord = defaultExport as Record<string, unknown>;
      if (typeof defaultRecord.createOfflineTts === 'function') {
        return defaultRecord.createOfflineTts as (config: unknown) => OfflineTtsEngine;
      }
    }
  }

  throw new Error('sherpa-onnx createOfflineTts() not available');
}

function requireRuntimePath(
  value: string | undefined,
  fieldName: string,
  family: TtsModelFamily,
): string {
  if (!value) {
    throw new Error(`Missing ${fieldName} for ${family} TTS model.`);
  }
  return value;
}

function buildOfflineTtsConfig(paths: ModelRuntimePaths, provider: TtsProvider): Record<string, unknown> {
  const modelConfigBase = {
    numThreads: 1,
    debug: 0,
    provider,
  };

  if (paths.family === 'kitten') {
    return {
      offlineTtsModelConfig: {
        ...modelConfigBase,
        offlineTtsKittenModelConfig: {
          model: requireRuntimePath(paths.modelPath, 'modelPath', 'kitten'),
          voices: requireRuntimePath(paths.voicesPath, 'voicesPath', 'kitten'),
          tokens: requireRuntimePath(paths.tokensPath, 'tokensPath', 'kitten'),
          dataDir: requireRuntimePath(paths.dataDirPath, 'dataDirPath', 'kitten'),
          lengthScale: 1.0,
        },
      },
      maxNumSentences: 1,
    };
  }

  if (paths.family === 'kokoro') {
    return {
      offlineTtsModelConfig: {
        ...modelConfigBase,
        offlineTtsKokoroModelConfig: {
          model: requireRuntimePath(paths.modelPath, 'modelPath', 'kokoro'),
          voices: requireRuntimePath(paths.voicesPath, 'voicesPath', 'kokoro'),
          tokens: requireRuntimePath(paths.tokensPath, 'tokensPath', 'kokoro'),
          dataDir: requireRuntimePath(paths.dataDirPath, 'dataDirPath', 'kokoro'),
          lengthScale: 1.0,
          lexicon: paths.lexiconPath ?? '',
          lang: paths.lang ?? '',
        },
      },
      maxNumSentences: 1,
    };
  }

  if (paths.family === 'vits') {
    return {
      offlineTtsModelConfig: {
        ...modelConfigBase,
        offlineTtsVitsModelConfig: {
          model: requireRuntimePath(paths.modelPath, 'modelPath', 'vits'),
          tokens: requireRuntimePath(paths.tokensPath, 'tokensPath', 'vits'),
          dataDir: requireRuntimePath(paths.dataDirPath, 'dataDirPath', 'vits'),
          lexicon: paths.lexiconPath ?? '',
          noiseScale: 0.667,
          noiseScaleW: 0.8,
          lengthScale: 1.0,
        },
      },
      maxNumSentences: 1,
    };
  }

  throw new Error(`Unsupported TTS model family: ${paths.family}`);
}

async function getOrCreateEngine(modelId: TtsModelId, provider: TtsProvider): Promise<TtsEngineCacheEntry> {
  const cacheKey = getCacheKey(modelId, provider);
  const cached = engineCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const required = getModelRuntimePaths(modelId);
  await validateModelInstall(modelId);

  // @ts-ignore - no type declarations for sherpa-onnx
  const sherpaOnnx = await import('sherpa-onnx');
  const createOfflineTts = getCreateOfflineTtsFactory(sherpaOnnx);
  const engine = createOfflineTts(buildOfflineTtsConfig(required, provider));

  if (!engine || typeof engine.generate !== 'function') {
    throw new Error('Failed to initialize sherpa-onnx offline TTS engine');
  }

  const entry: TtsEngineCacheEntry = {
    engine,
    modelId,
    provider,
  };

  engineCache.set(cacheKey, entry);
  return entry;
}

export async function getVoiceOptions(
  modelId: TtsModelId,
  provider: TtsProvider,
): Promise<TtsVoiceOption[]> {
  if (!await isTtsModelInstalled(modelId)) {
    return [];
  }

  const entry = await getOrCreateEngine(modelId, provider);
  const totalSpeakers = Math.max(1, entry.engine.numSpeakers || 0);

  const voices: TtsVoiceOption[] = [];
  for (let speakerId = 0; speakerId < totalSpeakers; speakerId += 1) {
    voices.push({
      id: speakerId,
      label: `Voice ${speakerId + 1}`,
    });
  }

  return voices;
}


export interface SynthesizeSpeechRequest {
  modelId: TtsModelId;
  provider: TtsProvider;
  voiceId: number;
  speed: number;
  pitch: number;
  autotuneEnabled: boolean;
  text: string;
}

export interface SynthesizeSpeechResult {
  wavBuffer: Buffer;
  sampleRate: number;
  numSamples: number;
  durationSeconds: number;
  numSpeakers: number;
}

interface WorkerSynthesisRequest {
  sherpaOnnxModulePath: string;
  family: TtsModelFamily;
  modelPath?: string;
  voicesPath?: string;
  tokensPath?: string;
  dataDirPath?: string;
  lexiconPath?: string;
  acousticModelPath?: string;
  vocoderPath?: string;
  lang?: string;
  provider: TtsProvider;
  text: string;
  voiceId: number;
  speed: number;
  pitch: number;
  autotuneEnabled: boolean;
}

interface WorkerSynthesisSuccess {
  ok: true;
  wavBase64: string;
  sampleRate: number;
  numSamples: number;
  numSpeakers: number;
}

interface WorkerSynthesisFailure {
  ok: false;
  error: string;
}

type WorkerSynthesisResponse = WorkerSynthesisSuccess | WorkerSynthesisFailure;

let cachedSherpaOnnxModulePath: string | null = null;

function resolveSherpaOnnxModulePath(): string {
  if (cachedSherpaOnnxModulePath) {
    return cachedSherpaOnnxModulePath;
  }

  try {
    cachedSherpaOnnxModulePath = require.resolve('sherpa-onnx');
    return cachedSherpaOnnxModulePath;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to resolve sherpa-onnx module path: ${message}`);
  }
}

const TTS_SYNTHESIS_WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');

function getCreateOfflineTtsFactory(moduleExport) {
  if (moduleExport && typeof moduleExport === 'object') {
    if (typeof moduleExport.createOfflineTts === 'function') {
      return moduleExport.createOfflineTts;
    }
    const defaultExport = moduleExport.default;
    if (defaultExport && typeof defaultExport === 'object' && typeof defaultExport.createOfflineTts === 'function') {
      return defaultExport.createOfflineTts;
    }
  }
  throw new Error('sherpa-onnx createOfflineTts() not available');
}

function encodeFloat32ToWav(samples, sampleRate) {
  const channelCount = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const dataSize = samples.length * bytesPerSample;
  const byteRate = sampleRate * channelCount * bytesPerSample;
  const blockAlign = channelCount * bytesPerSample;

  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channelCount, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    const int16 = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
    buffer.writeInt16LE(int16, offset);
    offset += 2;
  }

  return buffer;
}

function clampSample(value) {
  if (value > 1) return 1;
  if (value < -1) return -1;
  return value;
}

function interpolateSample(buffer, index) {
  if (index <= 0) return buffer[0];
  const last = buffer.length - 1;
  if (index >= last) return buffer[last];
  const base = Math.floor(index);
  const frac = index - base;
  return (buffer[base] * (1 - frac)) + (buffer[base + 1] * frac);
}

function computeFrameRms(samples, start, frameSize) {
  const end = Math.min(samples.length, start + frameSize);
  if (end <= start) return 0;

  let energy = 0;
  for (let i = start; i < end; i += 1) {
    const sample = samples[i];
    energy += sample * sample;
  }

  return Math.sqrt(energy / (end - start));
}

function createHannWindow(size) {
  const window = new Float32Array(size);
  for (let i = 0; i < size; i += 1) {
    window[i] = 0.5 - (0.5 * Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  return window;
}

function fftInPlace(real, imag, inverse) {
  const size = real.length;

  for (let i = 1, j = 0; i < size; i += 1) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      const realTmp = real[i];
      real[i] = real[j];
      real[j] = realTmp;

      const imagTmp = imag[i];
      imag[i] = imag[j];
      imag[j] = imagTmp;
    }
  }

  for (let len = 2; len <= size; len <<= 1) {
    const angle = (inverse ? 2 : -2) * Math.PI / len;
    const wLenCos = Math.cos(angle);
    const wLenSin = Math.sin(angle);

    for (let i = 0; i < size; i += len) {
      let wCos = 1;
      let wSin = 0;

      for (let j = 0; j < (len / 2); j += 1) {
        const evenIndex = i + j;
        const oddIndex = evenIndex + (len / 2);

        const oddReal = (real[oddIndex] * wCos) - (imag[oddIndex] * wSin);
        const oddImag = (real[oddIndex] * wSin) + (imag[oddIndex] * wCos);

        const evenReal = real[evenIndex];
        const evenImag = imag[evenIndex];

        real[evenIndex] = evenReal + oddReal;
        imag[evenIndex] = evenImag + oddImag;
        real[oddIndex] = evenReal - oddReal;
        imag[oddIndex] = evenImag - oddImag;

        const nextCos = (wCos * wLenCos) - (wSin * wLenSin);
        const nextSin = (wCos * wLenSin) + (wSin * wLenCos);
        wCos = nextCos;
        wSin = nextSin;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < size; i += 1) {
      real[i] /= size;
      imag[i] /= size;
    }
  }
}

function computeSpectralEnvelope(magnitudes, envelope, radius = 8) {
  const lastIndex = magnitudes.length - 1;

  for (let bin = 0; bin <= lastIndex; bin += 1) {
    let weightedSum = 0;
    let weightTotal = 0;

    const from = Math.max(0, bin - radius);
    const to = Math.min(lastIndex, bin + radius);

    for (let index = from; index <= to; index += 1) {
      const weight = 1 / (1 + Math.abs(index - bin));
      weightedSum += magnitudes[index] * weight;
      weightTotal += weight;
    }

    envelope[bin] = weightTotal > 0 ? (weightedSum / weightTotal) : magnitudes[bin];
  }
}

function estimateFundamentalHz(samples, sampleRate, start = 0, frameSize = Math.min(samples.length, Math.floor(sampleRate * 0.08))) {
  const minHz = 80;
  const maxHz = 400;
  const minLag = Math.floor(sampleRate / maxHz);
  const maxLag = Math.floor(sampleRate / minHz);

  if (frameSize <= maxLag + 2) return null;
  const end = Math.min(samples.length, start + frameSize);
  const span = end - start;
  if (span <= maxLag + 2) return null;

  let bestLag = -1;
  let bestScore = 0;
  let energy = 0;
  for (let i = start; i < end; i += 1) {
    energy += samples[i] * samples[i];
  }
  if (energy < 1e-5) return null;

  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let corr = 0;
    for (let i = start; i < end - lag; i += 1) {
      corr += samples[i] * samples[i + lag];
    }
    const normalized = corr / energy;
    if (normalized > bestScore) {
      bestScore = normalized;
      bestLag = lag;
    }
  }

  if (bestLag <= 0 || bestScore < 0.03) return null;
  return sampleRate / bestLag;
}

function estimateFundamentalYin(samples, sampleRate, start, frameSize) {
  const minHz = 70;
  const maxHz = 450;
  const minTau = Math.floor(sampleRate / maxHz);
  const maxTau = Math.min(Math.floor(sampleRate / minHz), frameSize - 2);
  if (maxTau <= minTau) return null;

  const cmndf = new Float32Array(maxTau + 1);
  let runningSum = 0;
  cmndf[0] = 1;

  for (let tau = minTau; tau <= maxTau; tau += 1) {
    let diff = 0;
    const upper = frameSize - tau;
    for (let j = 0; j < upper; j += 1) {
      const a = samples[start + j];
      const b = samples[start + j + tau];
      const d = a - b;
      diff += d * d;
    }
    runningSum += diff;
    cmndf[tau] = runningSum > 0 ? ((diff * tau) / runningSum) : 1;
  }

  const threshold = 0.18;
  let tauEstimate = -1;
  for (let tau = minTau; tau <= maxTau; tau += 1) {
    if (cmndf[tau] < threshold) {
      while (tau + 1 <= maxTau && cmndf[tau + 1] < cmndf[tau]) {
        tau += 1;
      }
      tauEstimate = tau;
      break;
    }
  }

  if (tauEstimate === -1) {
    let bestTau = minTau;
    let bestValue = cmndf[minTau];
    for (let tau = minTau + 1; tau <= maxTau; tau += 1) {
      if (cmndf[tau] < bestValue) {
        bestValue = cmndf[tau];
        bestTau = tau;
      }
    }
    tauEstimate = bestTau;
  }

  if (tauEstimate <= minTau || tauEstimate >= maxTau) {
    const hz = sampleRate / tauEstimate;
    return Number.isFinite(hz) ? hz : null;
  }

  const y0 = cmndf[tauEstimate - 1];
  const y1 = cmndf[tauEstimate];
  const y2 = cmndf[tauEstimate + 1];
  const denom = (2 * y1) - y0 - y2;
  const correction = Math.abs(denom) > 1e-9 ? ((y2 - y0) / (2 * denom)) : 0;
  const tauRefined = tauEstimate + correction;
  if (!Number.isFinite(tauRefined) || tauRefined <= 0) return null;

  const hz = sampleRate / tauRefined;
  if (!Number.isFinite(hz) || hz < minHz || hz > maxHz) return null;
  return hz;
}

function estimateFundamentalHzZeroCrossing(samples, sampleRate, start, frameSize) {
  const end = Math.min(samples.length, start + frameSize);
  if (end - start < 32) return null;

  let zeroCrossings = 0;
  let prev = samples[start];
  for (let i = start + 1; i < end; i += 1) {
    const current = samples[i];
    if ((prev <= 0 && current > 0) || (prev >= 0 && current < 0)) {
      zeroCrossings += 1;
    }
    prev = current;
  }

  const duration = (end - start) / sampleRate;
  if (duration <= 0) return null;
  const frequency = (zeroCrossings / 2) / duration;
  if (!Number.isFinite(frequency) || frequency < 70 || frequency > 450) {
    return null;
  }
  return frequency;
}

function estimateDominantFundamentalHz(samples, sampleRate) {
  const frameSize = Math.min(samples.length, Math.floor(sampleRate * 0.08));
  const hop = Math.max(128, Math.floor(frameSize / 2));
  const estimates = [];

  for (let start = 0; start + frameSize < samples.length && estimates.length < 32; start += hop) {
    const ac = estimateFundamentalHz(samples, sampleRate, start, frameSize);
    const zc = estimateFundamentalHzZeroCrossing(samples, sampleRate, start, frameSize);
    const hz = ac ?? zc;
    if (hz && Number.isFinite(hz)) {
      estimates.push(hz);
    }
  }

  if (estimates.length === 0) {
    return null;
  }

  estimates.sort((a, b) => a - b);
  return estimates[Math.floor(estimates.length / 2)];
}

function quantizeMidiToMajorScale(midiValue, rootMidi = 60) {
  const majorIntervals = [0, 2, 4, 5, 7, 9, 11];

  let bestMidi = rootMidi;
  let bestDistance = Number.POSITIVE_INFINITY;

  const baseOctave = Math.floor((midiValue - rootMidi) / 12);
  for (let octaveOffset = -1; octaveOffset <= 1; octaveOffset += 1) {
    const octave = baseOctave + octaveOffset;
    const octaveBase = rootMidi + (octave * 12);
    for (let i = 0; i < majorIntervals.length; i += 1) {
      const candidate = octaveBase + majorIntervals[i];
      const distance = Math.abs(candidate - midiValue);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestMidi = candidate;
      }
    }
  }

  return bestMidi;
}

function medianFromRecent(values, count) {
  if (!values || count <= 0) return null;
  const sorted = [];
  for (let i = 0; i < count; i += 1) {
    sorted.push(values[i]);
  }
  sorted.sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function applySimplePitchShift(samples, semitones) {
  const clampedSemitones = Number.isFinite(semitones)
    ? Math.max(-5, Math.min(5, semitones))
    : 0;

  if (Math.abs(clampedSemitones) < 1e-4) {
    return samples;
  }

  const ratio = 2 ** (clampedSemitones / 12);
  if (!Number.isFinite(ratio) || ratio <= 0) {
    return samples;
  }

  // Simple resampling shift: pitch moves with playback rate by design.
  const outputLength = Math.max(1, Math.floor(samples.length / ratio));
  const shifted = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    shifted[i] = interpolateSample(samples, i * ratio);
  }

  return shifted;
}

function pitchShiftPhaseVocoder(
  samples,
  sampleRate,
  frameRatios,
  phaseResetFrames = null,
  frameSize = 1024,
  hop = 256,
) {
  if (samples.length < frameSize) {
    return samples;
  }

  const half = frameSize / 2;
  const expectedPhaseAdvance = (2 * Math.PI * hop) / frameSize;
  const window = createHannWindow(frameSize);

  const real = new Float32Array(frameSize);
  const imag = new Float32Array(frameSize);
  const output = new Float32Array(samples.length + frameSize);
  const weights = new Float32Array(samples.length + frameSize);

  const lastPhase = new Float32Array(half + 1);
  const sumPhase = new Float32Array(half + 1);
  const analysisMagnitudes = new Float32Array(half + 1);
  const analysisFrequencies = new Float32Array(half + 1);
  const analysisEnvelope = new Float32Array(half + 1);
  const synthesisMagnitudes = new Float32Array(half + 1);
  const synthesisFrequencies = new Float32Array(half + 1);
  const synthesisCounts = new Uint16Array(half + 1);

  const maxStart = samples.length - frameSize;
  let frameIndex = 0;

  for (let start = 0; start <= maxStart; start += hop) {
    const ratioIndex = Math.min(frameIndex, frameRatios.length - 1);
    if (phaseResetFrames && phaseResetFrames[ratioIndex]) {
      lastPhase.fill(0);
      sumPhase.fill(0);
    }

    for (let i = 0; i < frameSize; i += 1) {
      real[i] = samples[start + i] * window[i];
      imag[i] = 0;
    }

    fftInPlace(real, imag, false);

    for (let bin = 0; bin <= half; bin += 1) {
      const realValue = real[bin];
      const imagValue = imag[bin];
      const magnitude = Math.hypot(realValue, imagValue);
      const phase = Math.atan2(imagValue, realValue);

      let deltaPhase = phase - lastPhase[bin];
      lastPhase[bin] = phase;
      deltaPhase -= bin * expectedPhaseAdvance;
      deltaPhase -= (2 * Math.PI) * Math.round(deltaPhase / (2 * Math.PI));

      const trueBin = bin + (deltaPhase / expectedPhaseAdvance);
      analysisMagnitudes[bin] = magnitude;
      analysisFrequencies[bin] = (trueBin * sampleRate) / frameSize;
    }

    computeSpectralEnvelope(analysisMagnitudes, analysisEnvelope, 8);

    synthesisMagnitudes.fill(0);
    synthesisFrequencies.fill(0);
    synthesisCounts.fill(0);

    const ratioRaw = frameRatios[ratioIndex] ?? 1;
    const ratio = Math.max(0.5, Math.min(2, ratioRaw));
    frameIndex += 1;

    for (let bin = 0; bin <= half; bin += 1) {
      const targetBin = Math.round(bin * ratio);
      if (targetBin > half) {
        continue;
      }

      const sourceEnvelope = Math.max(1e-6, analysisEnvelope[bin]);
      const targetEnvelope = Math.max(1e-6, analysisEnvelope[targetBin]);
      const formantGainRaw = targetEnvelope / sourceEnvelope;
      const formantGain = Math.max(0.6, Math.min(1.6, formantGainRaw));

      synthesisMagnitudes[targetBin] += analysisMagnitudes[bin] * formantGain;
      synthesisFrequencies[targetBin] += analysisFrequencies[bin] * ratio;
      synthesisCounts[targetBin] += 1;
    }

    for (let bin = 0; bin <= half; bin += 1) {
      const magnitude = synthesisMagnitudes[bin];
      const binFrequency = (bin * sampleRate) / frameSize;
      const frequency = synthesisCounts[bin] > 0
        ? (synthesisFrequencies[bin] / synthesisCounts[bin])
        : binFrequency;

      const phaseAdvance = (bin * expectedPhaseAdvance)
        + ((2 * Math.PI * hop * (frequency - binFrequency)) / sampleRate);

      sumPhase[bin] += phaseAdvance;
      const phase = sumPhase[bin];
      real[bin] = magnitude * Math.cos(phase);
      imag[bin] = magnitude * Math.sin(phase);
    }

    for (let bin = half + 1; bin < frameSize; bin += 1) {
      const mirrorBin = frameSize - bin;
      real[bin] = real[mirrorBin];
      imag[bin] = -imag[mirrorBin];
    }

    fftInPlace(real, imag, true);

    for (let i = 0; i < frameSize; i += 1) {
      const outputIndex = start + i;
      const windowValue = window[i];
      output[outputIndex] += real[i] * windowValue;
      weights[outputIndex] += windowValue * windowValue;
    }
  }

  const normalized = new Float32Array(samples.length);
  for (let i = 0; i < normalized.length; i += 1) {
    normalized[i] = weights[i] > 1e-6 ? (output[i] / weights[i]) : samples[i];
  }

  return normalized;
}

function resampleWithDynamicRatio(samples, frameRatios, hop, stepLocked = false) {
  if (samples.length === 0 || frameRatios.length === 0) {
    return samples;
  }

  const output = new Float32Array(samples.length);
  output[0] = samples[0];
  const lastFrame = frameRatios.length - 1;

  function ratioForSample(sampleIndex) {
    const framePosition = sampleIndex / hop;
    const baseFrame = Math.floor(framePosition);
    const clampedBase = Math.max(0, Math.min(lastFrame, baseFrame));
    const current = frameRatios[clampedBase] ?? 1;

    if (stepLocked || clampedBase >= lastFrame) {
      return current;
    }

    const next = frameRatios[Math.min(lastFrame, clampedBase + 1)] ?? current;
    const alpha = framePosition - baseFrame;
    return current + ((next - current) * alpha);
  }

  let summedSteps = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const ratio = ratioForSample(i);
    summedSteps += Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  }

  const normalization = summedSteps > 1e-6
    ? ((samples.length - 1) / summedSteps)
    : 1;

  let sourcePosition = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const ratio = ratioForSample(i);
    const step = (Number.isFinite(ratio) && ratio > 0 ? ratio : 1) * normalization;
    sourcePosition += step;
    output[i] = interpolateSample(samples, sourcePosition);
  }

  return output;
}

function applyAutotune(samples, sampleRate, strength) {
  const clampedStrength = Math.max(0, Math.min(1, strength));
  if (clampedStrength <= 0 || samples.length < 1024) {
    return samples;
  }

  const hardLock = clampedStrength >= 0.999;
  const analysisWindowSize = 1024;
  const synthesisWindowSize = hardLock ? 256 : 1024;
  const hop = hardLock ? 64 : 256;
  const frameCount = Math.max(1, Math.floor((samples.length - synthesisWindowSize) / hop) + 1);

  function hzToMidi(hz) {
    return 69 + (12 * Math.log2(hz / 440));
  }

  function midiToHz(midi) {
    return 440 * (2 ** ((midi - 69) / 12));
  }

  function estimateFrameFundamental(start, size) {
    const candidates = [];
    const yin = estimateFundamentalYin(samples, sampleRate, start, size);
    if (yin && Number.isFinite(yin)) {
      candidates.push(yin);
    }
    const ac = estimateFundamentalHz(samples, sampleRate, start, size);
    if (ac && Number.isFinite(ac)) {
      candidates.push(ac);
    }
    const zc = estimateFundamentalHzZeroCrossing(samples, sampleRate, start, size);
    if (zc && Number.isFinite(zc)) {
      candidates.push(zc);
    }

    if (candidates.length === 0) {
      return null;
    }

    candidates.sort((a, b) => a - b);
    return candidates[Math.floor(candidates.length / 2)];
  }

  const observedMidiByFrame = new Float32Array(frameCount);
  const quantizedMidiByFrame = new Float32Array(frameCount);
  const voicedByFrame = new Uint8Array(frameCount);
  let hasPitch = false;

  const dominantFundamental = estimateDominantFundamentalHz(samples, sampleRate) ?? 220;
  const dominantMidi = hzToMidi(dominantFundamental);
  const dominantQuantizedMidi = quantizeMidiToMajorScale(dominantMidi, 60);
  let lastObservedMidi = dominantMidi;
  let lastQuantizedMidi = dominantQuantizedMidi;
  const recentObserved = new Float32Array(12);
  let recentObservedCount = 0;

  function pushRecentObserved(midi) {
    if (recentObservedCount < recentObserved.length) {
      recentObserved[recentObservedCount] = midi;
      recentObservedCount += 1;
      return;
    }
    for (let i = 1; i < recentObserved.length; i += 1) {
      recentObserved[i - 1] = recentObserved[i];
    }
    recentObserved[recentObserved.length - 1] = midi;
  }

  for (let frame = 0; frame < frameCount; frame += 1) {
    const frameStart = frame * hop;
    const frameRms = computeFrameRms(samples, frameStart, analysisWindowSize);
    const frameIsVoiced = frameRms > 0.0015;

    let estimatedFundamental = null;
    if (frameIsVoiced) {
      estimatedFundamental = estimateFrameFundamental(frameStart, analysisWindowSize);
    }

    if (estimatedFundamental && Number.isFinite(estimatedFundamental) && estimatedFundamental > 0) {
      hasPitch = true;
      const midi = hzToMidi(estimatedFundamental);

      const localMedian = medianFromRecent(recentObserved, recentObservedCount);
      const jumpFromLast = Math.abs(midi - lastObservedMidi);
      const jumpFromMedian = localMedian === null ? 0 : Math.abs(midi - localMedian);
      const isOutlier = !hardLock && jumpFromLast > 7 && jumpFromMedian > 7;

      if (isOutlier) {
        voicedByFrame[frame] = 1;
        observedMidiByFrame[frame] = lastObservedMidi;
        quantizedMidiByFrame[frame] = lastQuantizedMidi;
      } else {
        voicedByFrame[frame] = 1;
        const snappedMidi = quantizeMidiToMajorScale(midi, 60); // C major
        observedMidiByFrame[frame] = midi;
        quantizedMidiByFrame[frame] = snappedMidi;
        lastObservedMidi = midi;
        lastQuantizedMidi = snappedMidi;
        pushRecentObserved(midi);
      }
    } else {
      voicedByFrame[frame] = 0;
      observedMidiByFrame[frame] = lastObservedMidi;
      quantizedMidiByFrame[frame] = lastQuantizedMidi;
    }
  }

  if (!hasPitch) {
    return samples;
  }

  const stabilizedMidiByFrame = new Float32Array(frameCount);
  stabilizedMidiByFrame[0] = quantizedMidiByFrame[0];

  if (hardLock) {
    for (let frame = 1; frame < frameCount; frame += 1) {
      stabilizedMidiByFrame[frame] = quantizedMidiByFrame[frame];
    }
  } else {
    const holdFrames = 1;
    const hysteresisSemitones = 0.08 + (clampedStrength * 0.35);
    let holdCounter = 0;
    for (let frame = 1; frame < frameCount; frame += 1) {
      const previous = stabilizedMidiByFrame[frame - 1];
      const current = quantizedMidiByFrame[frame];
      const delta = Math.abs(current - previous);

      if (delta < hysteresisSemitones || holdCounter < holdFrames) {
        stabilizedMidiByFrame[frame] = previous;
        holdCounter += 1;
      } else {
        stabilizedMidiByFrame[frame] = current;
        holdCounter = 0;
      }
    }
  }

  const retunedMidiByFrame = new Float32Array(frameCount);
  const retuneMs = hardLock
    ? 0
    : (
      clampedStrength < 0.9
        ? (40 + ((0.9 - clampedStrength) * 155))
        : (8 + (((1 - clampedStrength) / 0.1) * 32))
    );
  const alpha = hardLock
    ? 1
    : (1 - Math.exp(-hop / (sampleRate * (retuneMs / 1000))));

  let runningMidi = stabilizedMidiByFrame[0];
  for (let frame = 0; frame < frameCount; frame += 1) {
    const target = stabilizedMidiByFrame[frame];
    runningMidi = hardLock ? target : (runningMidi + ((target - runningMidi) * alpha));

    const observed = observedMidiByFrame[frame];
    const desiredShift = runningMidi - observed;
    const corrected = observed + (desiredShift * clampedStrength);
    retunedMidiByFrame[frame] = corrected;
  }

  const frameRatios = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    if (!voicedByFrame[frame]) {
      frameRatios[frame] = 1;
      continue;
    }
    const observedHz = midiToHz(observedMidiByFrame[frame]);
    const retunedHz = midiToHz(retunedMidiByFrame[frame]);
    const ratioRaw = retunedHz / observedHz;
    frameRatios[frame] = Number.isFinite(ratioRaw) && ratioRaw > 0
      ? Math.max(0.5, Math.min(2, ratioRaw))
      : 1;
  }

  let phaseResetFrames = null;
  if (hardLock) {
    phaseResetFrames = new Uint8Array(frameCount);
    phaseResetFrames[0] = 1;
    for (let frame = 1; frame < frameCount; frame += 1) {
      if (voicedByFrame[frame] !== voicedByFrame[frame - 1]) {
        phaseResetFrames[frame] = 1;
        continue;
      }
      const current = stabilizedMidiByFrame[frame];
      const previous = stabilizedMidiByFrame[frame - 1];
      if (Math.abs(current - previous) > 1e-4) {
        phaseResetFrames[frame] = 1;
      }
    }
  }

  const shifted = hardLock
    ? resampleWithDynamicRatio(samples, frameRatios, hop, true)
    : pitchShiftPhaseVocoder(
      samples,
      sampleRate,
      frameRatios,
      phaseResetFrames,
      synthesisWindowSize,
      hop,
    );
  const output = new Float32Array(shifted.length);

  const dryMix = hardLock ? 0 : (1 - clampedStrength);
  const wetMix = 1 - dryMix;
  for (let i = 0; i < output.length; i += 1) {
    const mixed = (samples[i] * dryMix) + (shifted[i] * wetMix);
    output[i] = clampSample(mixed);
  }

  return output;
}

function smoothstep(edge0, edge1, value) {
  if (value <= edge0) return 0;
  if (value >= edge1) return 1;
  const x = (value - edge0) / (edge1 - edge0);
  return x * x * (3 - (2 * x));
}

function softClip(value, drive = 1) {
  const safeDrive = Math.max(0.1, drive);
  return Math.tanh(value * safeDrive) / Math.tanh(safeDrive);
}

function upsampleLinear(samples, factor) {
  if (!Number.isInteger(factor) || factor <= 1 || samples.length < 2) {
    return samples;
  }

  const outputLength = ((samples.length - 1) * factor) + 1;
  const output = new Float32Array(outputLength);
  let outputIndex = 0;

  for (let i = 0; i < samples.length - 1; i += 1) {
    const current = samples[i];
    const next = samples[i + 1];
    for (let step = 0; step < factor; step += 1) {
      const t = step / factor;
      output[outputIndex] = current + ((next - current) * t);
      outputIndex += 1;
    }
  }

  output[outputIndex] = samples[samples.length - 1];
  return output;
}

function resampleToSampleRate(samples, sourceSampleRate, targetSampleRate) {
  if (!Number.isFinite(sourceSampleRate) || sourceSampleRate <= 1000) {
    return samples;
  }
  if (!Number.isFinite(targetSampleRate) || targetSampleRate <= 1000) {
    return samples;
  }
  if (Math.abs(sourceSampleRate - targetSampleRate) < 1e-6 || samples.length < 2) {
    return samples;
  }

  const ratio = targetSampleRate / sourceSampleRate;
  const outputLength = Math.max(1, Math.round(samples.length * ratio));
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i += 1) {
    const sourceIndex = i / ratio;
    output[i] = interpolateSample(samples, sourceIndex);
  }

  return output;
}

function applyErosion(samples, sampleRate, amount) {
  const normalizedAmount = Math.max(0, Math.min(1, amount));
  const mix = Math.min(1, normalizedAmount * 2);
  if (mix <= 0 || samples.length < 32) {
    return {
      samples,
      sampleRate,
    };
  }

  const oversampleFactor = mix >= 0.75 ? 4 : 2;
  const workingSamples = upsampleLinear(samples, oversampleFactor);
  const workingSampleRate = sampleRate * oversampleFactor;

  const safeSampleRate = Number.isFinite(workingSampleRate) && workingSampleRate > 1000
    ? workingSampleRate
    : 24000;

  // Speech-gated harmonic exciter:
  // 1) extract upper-mid source band, 2) generate harmonics, 3) lift "air" band.
  // Using upper-mids (not only existing highs) lets lower-rate models (e.g. Piper)
  // still synthesize audible top-end detail.
  const sourceCutHz = Math.min((safeSampleRate * 0.22), 1600 + (mix * 1900));
  const airCutHz = Math.min((safeSampleRate * 0.47), 9000 + (mix * 10000));
  const sourceCoeff = Math.exp((-2 * Math.PI * sourceCutHz) / safeSampleRate);
  const airCoeff = Math.exp((-2 * Math.PI * airCutHz) / safeSampleRate);

  const attackCoeff = Math.exp(-1 / (safeSampleRate * 0.004));
  const releaseCoeff = Math.exp(-1 / (safeSampleRate * 0.09));

  const harmonicDrive = 2.5 + (mix * 12.5);
  const harmonicGain = 0.2 + (mix * 0.72);
  const airGain = 0.1 + (mix * 0.48);
  const transientGain = 0.05 + (mix * 0.24);
  const brightnessGain = 0.08 + (mix * 0.3);
  const harshnessCeiling = 0.2 + (mix * 0.22);
  const noiseCutHz = Math.min((safeSampleRate * 0.485), 12000 + (mix * 10000));
  const noiseCoeff = Math.exp((-2 * Math.PI * noiseCutHz) / safeSampleRate);
  const gatedNoiseGain = 0.0015 + (mix * 0.02);

  const output = new Float32Array(workingSamples.length);
  let sourceLowState = 0;
  let airLowState = 0;
  let noiseLowState = 0;
  let envelope = 0;
  let previousSourceBand = 0;
  let randomState = 0x7f4a7c15;

  function nextRandomSigned() {
    randomState = ((1664525 * randomState) + 1013904223) >>> 0;
    return ((randomState / 0xffffffff) * 2) - 1;
  }

  for (let i = 0; i < workingSamples.length; i += 1) {
    const input = workingSamples[i];

    sourceLowState = (sourceCoeff * sourceLowState) + ((1 - sourceCoeff) * input);
    const sourceBand = input - sourceLowState;

    const absInput = Math.abs(input);
    const envCoeff = absInput > envelope ? attackCoeff : releaseCoeff;
    envelope = (envCoeff * envelope) + ((1 - envCoeff) * absInput);
    const voiceGate = smoothstep(0.00035, 0.0085, envelope);
    const voicedMix = mix * voiceGate;

    const driven = sourceBand * harmonicDrive;
    const oddHarmonic = Math.tanh(driven) - (sourceBand * 0.25);
    const evenRectified = Math.abs(driven);
    const evenHarmonic = (evenRectified - (Math.abs(sourceBand) * harmonicDrive * 0.72))
      * (sourceBand >= 0 ? 1 : -1);

    const transient = sourceBand - previousSourceBand;
    previousSourceBand = sourceBand;

    let exciter = ((oddHarmonic * 0.85) + (evenHarmonic * 0.55)) * harmonicGain;
    exciter += transient * transientGain;

    const exciterAbs = Math.abs(exciter);
    if (exciterAbs > harshnessCeiling) {
      const scale = harshnessCeiling / (exciterAbs + 1e-9);
      exciter *= scale;
    }

    airLowState = (airCoeff * airLowState) + ((1 - airCoeff) * exciter);
    const airBand = exciter - airLowState;

    const whiteNoise = nextRandomSigned();
    noiseLowState = (noiseCoeff * noiseLowState) + ((1 - noiseCoeff) * whiteNoise);
    const ultraHighNoise = whiteNoise - noiseLowState;
    const gatedNoise = ultraHighNoise * gatedNoiseGain * voiceGate;

    const enhancement = exciter
      + (airBand * airGain)
      + (sourceBand * brightnessGain)
      + gatedNoise;
    const wet = input + (enhancement * voicedMix);

    const saturationBlend = (0.15 + (mix * 0.35)) * voiceGate;
    const clipped = softClip(wet, 1 + (mix * 0.7));
    const mixed = (wet * (1 - saturationBlend)) + (clipped * saturationBlend);

    output[i] = clampSample(mixed);
  }

  return {
    samples: output,
    sampleRate: safeSampleRate,
  };
}

function postError(error) {
  const message = error instanceof Error ? error.message : String(error);
  parentPort.postMessage({ ok: false, error: message });
}

function requireWorkerPath(value, fieldName, family) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(\`Missing \${fieldName} for \${family} TTS model\`);
  }
  return value;
}

function requireWorkerModulePath(value, fieldName) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(\`Missing \${fieldName} for TTS worker module resolution\`);
  }
  return value;
}

function createWorkerOfflineTtsConfig(data) {
  const modelConfigBase = {
    numThreads: 1,
    debug: 0,
    provider: data.provider,
  };

  if (data.family === 'kitten') {
    return {
      offlineTtsModelConfig: {
        ...modelConfigBase,
        offlineTtsKittenModelConfig: {
          model: requireWorkerPath(data.modelPath, 'modelPath', 'kitten'),
          voices: requireWorkerPath(data.voicesPath, 'voicesPath', 'kitten'),
          tokens: requireWorkerPath(data.tokensPath, 'tokensPath', 'kitten'),
          dataDir: requireWorkerPath(data.dataDirPath, 'dataDirPath', 'kitten'),
          lengthScale: 1.0,
        },
      },
      maxNumSentences: 1,
    };
  }

  if (data.family === 'kokoro') {
    return {
      offlineTtsModelConfig: {
        ...modelConfigBase,
        offlineTtsKokoroModelConfig: {
          model: requireWorkerPath(data.modelPath, 'modelPath', 'kokoro'),
          voices: requireWorkerPath(data.voicesPath, 'voicesPath', 'kokoro'),
          tokens: requireWorkerPath(data.tokensPath, 'tokensPath', 'kokoro'),
          dataDir: requireWorkerPath(data.dataDirPath, 'dataDirPath', 'kokoro'),
          lengthScale: 1.0,
          lexicon: typeof data.lexiconPath === 'string' ? data.lexiconPath : '',
          lang: typeof data.lang === 'string' ? data.lang : '',
        },
      },
      maxNumSentences: 1,
    };
  }

  if (data.family === 'vits') {
    return {
      offlineTtsModelConfig: {
        ...modelConfigBase,
        offlineTtsVitsModelConfig: {
          model: requireWorkerPath(data.modelPath, 'modelPath', 'vits'),
          tokens: requireWorkerPath(data.tokensPath, 'tokensPath', 'vits'),
          dataDir: requireWorkerPath(data.dataDirPath, 'dataDirPath', 'vits'),
          lexicon: typeof data.lexiconPath === 'string' ? data.lexiconPath : '',
          noiseScale: 0.667,
          noiseScaleW: 0.8,
          lengthScale: 1.0,
        },
      },
      maxNumSentences: 1,
    };
  }

  throw new Error(\`Unsupported TTS model family: \${data.family}\`);
}

try {
  const sherpaOnnx = require(
    requireWorkerModulePath(workerData.sherpaOnnxModulePath, 'sherpaOnnxModulePath'),
  );
  const createOfflineTts = getCreateOfflineTtsFactory(sherpaOnnx);
  const engine = createOfflineTts(createWorkerOfflineTtsConfig(workerData));

  if (!engine || typeof engine.generate !== 'function') {
    throw new Error('Failed to initialize sherpa-onnx offline TTS engine');
  }

  const totalSpeakers = Math.max(1, engine.numSpeakers || 0);
  if (!Number.isInteger(workerData.voiceId) || workerData.voiceId < 0 || workerData.voiceId >= totalSpeakers) {
    throw new Error(\`Invalid voiceId \${workerData.voiceId}. Valid range: 0-\${totalSpeakers - 1}\`);
  }

  const generated = engine.generate({
    text: workerData.text,
    sid: workerData.voiceId,
    speed: workerData.speed,
  });

  if (typeof engine.free === 'function') {
    engine.free();
  }

  const pitchedSamples = applySimplePitchShift(generated.samples, workerData.pitch);
  const processedSamples = workerData.autotuneEnabled
    ? applyAutotune(pitchedSamples, generated.sampleRate, 1)
    : pitchedSamples;
  const targetOutputSampleRate = 48000;
  const finalSamples = resampleToSampleRate(
    processedSamples,
    generated.sampleRate,
    targetOutputSampleRate,
  );
  const wavBuffer = encodeFloat32ToWav(finalSamples, targetOutputSampleRate);
  parentPort.postMessage({
    ok: true,
    wavBase64: wavBuffer.toString('base64'),
    sampleRate: targetOutputSampleRate,
    numSamples: finalSamples.length,
    numSpeakers: totalSpeakers,
  });
} catch (error) {
  postError(error);
}
`;

async function synthesizeSpeechInWorker(
  request: WorkerSynthesisRequest,
): Promise<{
  wavBuffer: Buffer;
  sampleRate: number;
  numSamples: number;
  numSpeakers: number;
}> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(TTS_SYNTHESIS_WORKER_SOURCE, {
      eval: true,
      workerData: request,
    });

    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      reject(new Error('TTS synthesis timed out'));
    }, 120_000);

    const finalize = (handler: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      handler();
    };

    worker.once('message', (message: WorkerSynthesisResponse) => {
      finalize(() => {
        void worker.terminate();
        if (!message || typeof message !== 'object' || !('ok' in message)) {
          reject(new Error('Invalid TTS worker response'));
          return;
        }

        if (!message.ok) {
          reject(new Error(message.error || 'TTS worker failed'));
          return;
        }

        resolve({
          wavBuffer: Buffer.from(message.wavBase64, 'base64'),
          sampleRate: message.sampleRate,
          numSamples: message.numSamples,
          numSpeakers: message.numSpeakers,
        });
      });
    });

    worker.once('error', (error: Error) => {
      finalize(() => {
        void worker.terminate();
        reject(error);
      });
    });

    worker.once('exit', (code: number) => {
      if (settled) return;
      finalize(() => {
        if (code === 0) {
          reject(new Error('TTS worker exited without response'));
          return;
        }
        reject(new Error(`TTS worker exited with code ${code}`));
      });
    });
  });
}

export async function synthesizeSpeech(request: SynthesizeSpeechRequest): Promise<SynthesizeSpeechResult> {
  const text = request.text.trim();
  if (!text) {
    throw new Error('Cannot synthesize empty text.');
  }

  if (!await isTtsModelInstalled(request.modelId)) {
    throw new Error(
      `TTS model ${request.modelId} is not installed. Install it in Settings > Text to Speech first.`,
    );
  }

  const speed = Number.isFinite(request.speed) ? Math.max(0.25, Math.min(3, request.speed)) : 1;
  const pitch = Number.isFinite(request.pitch) ? Math.max(-5, Math.min(5, request.pitch)) : 0;
  const autotuneEnabled = request.autotuneEnabled === true;
  const required = getModelRuntimePaths(request.modelId);
  const generated = await synthesizeSpeechInWorker({
    sherpaOnnxModulePath: resolveSherpaOnnxModulePath(),
    family: required.family,
    modelPath: required.modelPath,
    voicesPath: required.voicesPath,
    tokensPath: required.tokensPath,
    dataDirPath: required.dataDirPath,
    lexiconPath: required.lexiconPath,
    acousticModelPath: required.acousticModelPath,
    vocoderPath: required.vocoderPath,
    lang: required.lang,
    provider: request.provider,
    text,
    voiceId: request.voiceId,
    speed,
    pitch,
    autotuneEnabled,
  });

  return {
    wavBuffer: generated.wavBuffer,
    sampleRate: generated.sampleRate,
    numSamples: generated.numSamples,
    durationSeconds: generated.numSamples / generated.sampleRate,
    numSpeakers: generated.numSpeakers,
  };
}

export async function writeSynthesizedAudio(outputPath: string, wavBuffer: Buffer): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, wavBuffer);
}

export async function readTextFromFile(inputPath: string): Promise<string> {
  return readFile(inputPath, 'utf-8');
}

export function toPlaybackBase64(wavBuffer: Buffer): string {
  return wavBuffer.toString('base64');
}

export async function removeInstalledTtsModel(modelId: TtsModelId): Promise<void> {
  const installParent = getModelInstallParent(modelId);
  if (await pathExists(installParent)) {
    await rm(installParent, { recursive: true, force: true });
  }

  const model = getModelByIdOrThrow(modelId);
  const cachePrefix = `${model.id}:`;
  for (const [key, entry] of engineCache.entries()) {
    if (!key.startsWith(cachePrefix)) continue;
    try {
      entry.engine.free();
    } catch {
      // Best-effort cache cleanup.
    }
    engineCache.delete(key);
  }
}
