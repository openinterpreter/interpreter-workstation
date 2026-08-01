import { app, BrowserWindow } from './voiceExtensionElectronBridge';
import fs from 'node:fs';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { IPC_CHANNELS } from '../ipc/registry';

const DEFAULT_MODEL_DIR = 'qwen3-asr-0.6b';
const DEFAULT_QWEN_MODEL_ID = 'Qwen/Qwen3-ASR-0.6B';
const DEFAULT_QWEN_MODEL_FILES = [
  'config.json',
  'generation_config.json',
  'model.safetensors',
  'vocab.json',
  'merges.txt',
] as const;
const QWEN_MODEL_DOWNLOAD_BASE = 'https://huggingface.co';

interface QwenManifest {
  model?: {
    id?: string;
    dirName?: string;
    files?: string[];
  };
}

interface QwenModelConfig {
  id: string;
  dirName: string;
  files: string[];
}

export interface VoiceExtensionInstallProgress {
  stage: 'preparing' | 'downloading' | 'copying' | 'complete' | 'error';
  message?: string;
  error?: string;
}

type VoiceExtensionBackend = 'qwen' | 'moonshine';
const installInFlight = new Map<VoiceExtensionBackend, Promise<void>>();

function getBinaryName(): string {
  return process.platform === 'win32' ? 'qwen_asr.exe' : 'qwen_asr';
}

function getPlatformKey(): string {
  const platform = process.platform === 'win32' ? 'win32' : process.platform;
  return `${platform}-${process.arch}`;
}

function getDefaultVoiceExtensionBackend(): VoiceExtensionBackend {
  return process.platform === 'win32' ? 'moonshine' : 'qwen';
}

function resolveVoiceExtensionBackend(requestedBackend?: VoiceExtensionBackend): VoiceExtensionBackend {
  const backend = requestedBackend ?? getDefaultVoiceExtensionBackend();
  if (process.platform === 'win32' && backend !== 'moonshine') {
    throw new Error('Windows only supports the moonshine STT backend');
  }
  return backend;
}

async function resolveQwenModelConfig(manifestPath: string): Promise<QwenModelConfig> {
  try {
    const raw = await readFile(manifestPath, 'utf-8');
    const parsed = JSON.parse(raw) as QwenManifest;

    const id = typeof parsed.model?.id === 'string' && parsed.model.id.trim()
      ? parsed.model.id.trim()
      : DEFAULT_QWEN_MODEL_ID;
    const dirName = typeof parsed.model?.dirName === 'string' && parsed.model.dirName.trim()
      ? parsed.model.dirName.trim()
      : DEFAULT_MODEL_DIR;
    const files = Array.isArray(parsed.model?.files)
      ? parsed.model.files
        .filter((file): file is string => typeof file === 'string')
        .map((file) => file.trim())
        .filter((file) => file.length > 0)
      : [];

    return {
      id,
      dirName,
      files: files.length > 0 ? files : [...DEFAULT_QWEN_MODEL_FILES],
    };
  } catch {
    return {
      id: DEFAULT_QWEN_MODEL_ID,
      dirName: DEFAULT_MODEL_DIR,
      files: [...DEFAULT_QWEN_MODEL_FILES],
    };
  }
}

async function hasValidPlatformInstall(platformDir: string): Promise<boolean> {
  if (!fs.existsSync(platformDir)) return false;

  const binaryPath = path.join(platformDir, getBinaryName());
  if (!fs.existsSync(binaryPath)) return false;

  const manifestPath = path.join(platformDir, 'manifest.json');
  const modelConfig = await resolveQwenModelConfig(manifestPath);
  const modelDirName = modelConfig.dirName;
  const modelDir = path.join(platformDir, modelDirName);
  if (!fs.existsSync(modelDir)) return false;

  return modelConfig.files.every((filePath) => fs.existsSync(path.join(modelDir, filePath)));
}

function getBundledRoots(): string[] {
  const roots: string[] = [];
  if (process.resourcesPath) {
    roots.push(path.join(process.resourcesPath, 'qwen-asr'));
  }
  roots.push(path.join(process.cwd(), 'resources', 'qwen-asr'));
  return roots;
}

function hasBundledPlatformBinary(platformDir: string): boolean {
  if (!fs.existsSync(platformDir)) {
    return false;
  }
  return fs.existsSync(path.join(platformDir, getBinaryName()));
}

async function resolveBundledPlatformDir(): Promise<string> {
  const platformKey = getPlatformKey();

  for (const root of getBundledRoots()) {
    const platformDir = path.join(root, platformKey);
    if (hasBundledPlatformBinary(platformDir)) {
      return platformDir;
    }
  }

  throw new Error(
    `Bundled qwen-asr binary not found for ${platformKey}. `
      + 'Run `pnpm run download:qwen-asr -- --current-platform` before packaging.',
  );
}

function emitInstallProgress(progress: VoiceExtensionInstallProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC_CHANNELS.VOICE_EXTENSION_INSTALL_PROGRESS, progress);
  }
}

export function getQwenAsrInstallRoot(): string {
  const testInstallRoot = process.env.TEST_QWEN_ASR_INSTALL_ROOT?.trim();
  if (testInstallRoot) {
    return path.resolve(testInstallRoot);
  }
  return path.join(app.getPath('userData'), 'qwen-asr');
}

export function getMoonshineInstallRoot(): string {
  const testInstallRoot = process.env.TEST_MOONSHINE_INSTALL_ROOT?.trim();
  if (testInstallRoot) {
    return path.resolve(testInstallRoot);
  }
  return path.join(app.getPath('userData'), 'moonshine-models');
}

export function getVoiceExtensionInstallRoot(requestedBackend?: VoiceExtensionBackend): string {
  return resolveVoiceExtensionBackend(requestedBackend) === 'moonshine'
    ? getMoonshineInstallRoot()
    : getQwenAsrInstallRoot();
}

function getQwenInstallPlatformDir(): string {
  return path.join(getQwenAsrInstallRoot(), getPlatformKey());
}

export async function isVoiceExtensionInstalled(requestedBackend?: VoiceExtensionBackend): Promise<boolean> {
  if (resolveVoiceExtensionBackend(requestedBackend) === 'moonshine') {
    return hasMoonshineAssets(getMoonshineInstallRoot());
  }
  return hasValidPlatformInstall(getQwenInstallPlatformDir());
}

export async function installVoiceExtension(requestedBackend?: VoiceExtensionBackend): Promise<void> {
  const backend = resolveVoiceExtensionBackend(requestedBackend);
  const inFlightInstall = installInFlight.get(backend);
  if (inFlightInstall) {
    return inFlightInstall;
  }

  const installPromise = (async () => {
    if (backend === 'moonshine') {
      await installMoonshineAssets();
      return;
    }

    try {
      emitInstallProgress({ stage: 'preparing' });

      const sourcePlatformDir = await resolveBundledPlatformDir();
      const sourceManifestPath = path.join(sourcePlatformDir, 'manifest.json');
      const sourceBinaryPath = path.join(sourcePlatformDir, getBinaryName());
      const targetRoot = getQwenAsrInstallRoot();
      const targetPlatformDir = getQwenInstallPlatformDir();
      const targetBinaryPath = path.join(targetPlatformDir, getBinaryName());
      const targetManifestPath = path.join(targetPlatformDir, 'manifest.json');

      const modelConfig = await resolveQwenModelConfig(sourceManifestPath);

      await mkdir(targetRoot, { recursive: true });
      await rm(targetPlatformDir, { recursive: true, force: true });
      await mkdir(targetPlatformDir, { recursive: true });

      emitInstallProgress({ stage: 'copying' });
      await cp(sourceBinaryPath, targetBinaryPath, { force: true });
      if (fs.existsSync(sourceManifestPath)) {
        await cp(sourceManifestPath, targetManifestPath, { force: true });
      }

      emitInstallProgress({ stage: 'downloading' });
      const targetModelDir = path.join(targetPlatformDir, modelConfig.dirName);
      await mkdir(targetModelDir, { recursive: true });

      for (const fileName of modelConfig.files) {
        const downloadUrl = `${QWEN_MODEL_DOWNLOAD_BASE}/${modelConfig.id}/resolve/main/${fileName}`;
        const targetPath = path.join(targetModelDir, fileName);
        await mkdir(path.dirname(targetPath), { recursive: true });
        await downloadToFile(downloadUrl, targetPath);
      }

      const installed = await hasValidPlatformInstall(targetPlatformDir);
      if (!installed) {
        throw new Error(`Voice model install failed validation: ${targetPlatformDir}`);
      }

      emitInstallProgress({ stage: 'complete', message: targetPlatformDir });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emitInstallProgress({ stage: 'error', error: message });
      throw error;
    }
  })().finally(() => {
    installInFlight.delete(backend);
  });

  installInFlight.set(backend, installPromise);
  return installPromise;
}

const MOONSHINE_DOWNLOAD_BASE = 'https://download.moonshine.ai';
const MOONSHINE_INSTALL_MARKER = '.install-complete.json';
const MOONSHINE_MODEL_FILES = [
  'model/base/quantized/encoder_model.onnx',
  'model/base/quantized/decoder_model_merged.onnx',
] as const;
const MAX_DOWNLOAD_REDIRECTS = 10;

function hasMoonshineAssets(rootDir: string): boolean {
  const markerPath = path.join(rootDir, MOONSHINE_INSTALL_MARKER);
  if (!fs.existsSync(markerPath)) return false;

  return MOONSHINE_MODEL_FILES.every((relativePath) => fs.existsSync(path.join(rootDir, relativePath)));
}

async function downloadToFileWithRedirects(url: string, outputPath: string, redirectCount: number): Promise<void> {
  if (redirectCount >= MAX_DOWNLOAD_REDIRECTS) {
    throw new Error(`Failed to download ${url}: too many redirects`);
  }
  await new Promise<void>((resolve, reject) => {
    const client = url.startsWith('https://') ? https : http;
    const req = client.get(url, (response) => {
      const statusCode = response.statusCode ?? 0;

      if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
        const nextUrl = new URL(response.headers.location, url).toString();
        response.resume();
        void downloadToFileWithRedirects(nextUrl, outputPath, redirectCount + 1).then(resolve).catch(reject);
        return;
      }

      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        reject(new Error(`Failed to download ${url}: HTTP ${statusCode}`));
        return;
      }

      const fileStream = fs.createWriteStream(outputPath);
      fileStream.on('error', reject);
      response.on('error', reject);
      response.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    });

    req.on('error', reject);
  });
}

async function downloadToFile(url: string, outputPath: string): Promise<void> {
  const tempPath = `${outputPath}.download`;
  await rm(tempPath, { force: true });

  try {
    await downloadToFileWithRedirects(url, tempPath, 0);
    await rm(outputPath, { force: true });
    await rename(tempPath, outputPath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

async function installMoonshineAssets(): Promise<void> {
  try {
    emitInstallProgress({ stage: 'preparing' });

    const installRoot = getMoonshineInstallRoot();
    const installMarkerPath = path.join(installRoot, MOONSHINE_INSTALL_MARKER);
    await mkdir(installRoot, { recursive: true });

    if (!hasMoonshineAssets(installRoot)) {
      await rm(path.join(installRoot, 'model'), { recursive: true, force: true });
      await rm(installMarkerPath, { force: true });
    }

    emitInstallProgress({ stage: 'downloading' });
    for (const relativePath of MOONSHINE_MODEL_FILES) {
      const targetPath = path.join(installRoot, relativePath);
      await mkdir(path.dirname(targetPath), { recursive: true });

      if (fs.existsSync(targetPath)) {
        continue;
      }

      const downloadUrl = `${MOONSHINE_DOWNLOAD_BASE}/${relativePath}`;
      await downloadToFile(downloadUrl, targetPath);
    }

    if (!hasMoonshineAssets(installRoot)) {
      await writeFile(installMarkerPath, JSON.stringify({
        files: MOONSHINE_MODEL_FILES,
        completedAt: new Date().toISOString(),
      }), 'utf-8');
    }

    if (!hasMoonshineAssets(installRoot)) {
      throw new Error(`Moonshine model install failed validation: ${installRoot}`);
    }

    emitInstallProgress({ stage: 'complete', message: installRoot });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitInstallProgress({ stage: 'error', error: message });
    throw error;
  }
}

export const voiceExtensionTestUtils = {
  hasMoonshineAssets,
  downloadToFile,
  MOONSHINE_INSTALL_MARKER,
  MAX_DOWNLOAD_REDIRECTS,
};
