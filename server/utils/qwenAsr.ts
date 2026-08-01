import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_STT_SETTINGS } from '../../shared/types/stt';
import { sanitizeTranscriptForLanguage } from '../../shared/utils/sttTranscriptSanitizer';
import { getLanguage, getSttSettings } from '../configStore';

const DEFAULT_MODEL_DIR = 'qwen3-asr-0.6b';
const COMMAND_TIMEOUT_MS = 300_000;

interface QwenManifest {
  model?: {
    dirName?: string;
    files?: string[];
  };
}
const DEFAULT_MODEL_FILES = ['config.json', 'generation_config.json', 'model.safetensors', 'vocab.json', 'merges.txt'] as const;

export interface QwenPaths {
  binaryPath: string;
  modelDir: string;
}

export function sanitizeQwenTranscriptForLanguage(
  text: string,
  language: string | null,
  stripChineseCharacters: boolean,
): string {
  return sanitizeTranscriptForLanguage(text, language, stripChineseCharacters);
}

export async function sanitizeQwenTranscript(text: string): Promise<string> {
  const [language, sttSettings] = await Promise.all([
    getLanguage().catch(() => null),
    getSttSettings().catch(() => DEFAULT_STT_SETTINGS),
  ]);
  return sanitizeQwenTranscriptForLanguage(
    text,
    language,
    sttSettings.stripChineseCharacters,
  );
}

function extractTranscript(stdout: string): string {
  const lines = stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !line.startsWith('['));

  if (lines.length === 0) return '';
  return lines[lines.length - 1] ?? '';
}

function getBinaryName(): string {
  return process.platform === 'win32' ? 'qwen_asr.exe' : 'qwen_asr';
}

function getPlatformKey(): string {
  const platform = process.platform === 'win32' ? 'win32' : process.platform;
  return `${platform}-${process.arch}`;
}

async function readManifestModelDir(manifestPath: string): Promise<string | null> {
  try {
    const raw = await readFile(manifestPath, 'utf-8');
    const parsed = JSON.parse(raw) as QwenManifest;
    const dirName = parsed.model?.dirName;
    if (typeof dirName === 'string' && dirName.trim()) {
      return dirName.trim();
    }
  } catch {
    // Ignore malformed or missing manifest.
  }
  return null;
}

async function readManifestModelFiles(manifestPath: string): Promise<string[] | null> {
  try {
    const raw = await readFile(manifestPath, 'utf-8');
    const parsed = JSON.parse(raw) as QwenManifest;
    const files = parsed.model?.files;
    if (Array.isArray(files) && files.length > 0 && files.every(file => typeof file === 'string' && file.trim())) {
      return files.map(file => file.trim());
    }
  } catch {
    // Ignore malformed or missing manifest.
  }
  return null;
}

export async function resolveBundledQwenPaths(): Promise<QwenPaths> {
  const platformKey = getPlatformKey();
  const envAssetDir = process.env.QWEN_ASR_ASSET_DIR?.trim();

  if (!envAssetDir) {
    throw new Error(
      'QWEN_ASR_ASSET_DIR is not configured. '
      + 'Voice models must be installed as an extension before using voice mode.',
    );
  }

  for (const rootDir of [envAssetDir]) {
    const platformDir = path.join(rootDir, platformKey);
    if (!fs.existsSync(platformDir)) continue;

    const binaryPath = path.join(platformDir, getBinaryName());
    if (!fs.existsSync(binaryPath)) continue;

    const envModelDir = process.env.QWEN_ASR_MODEL_DIR?.trim();
    const manifestPath = path.join(platformDir, 'manifest.json');
    const manifestModelDir = await readManifestModelDir(manifestPath);
    const modelDirName = envModelDir || manifestModelDir || DEFAULT_MODEL_DIR;
    const modelDir = path.join(platformDir, modelDirName);

    if (!fs.existsSync(modelDir)) {
      throw new Error(`Bundled qwen-asr model directory missing: ${modelDir}`);
    }

    const requiredFiles = await readManifestModelFiles(manifestPath) ?? [...DEFAULT_MODEL_FILES];
    const missingFiles = requiredFiles.filter(fileName => !fs.existsSync(path.join(modelDir, fileName)));
    if (missingFiles.length > 0) {
      throw new Error(
        `Bundled qwen-asr model files missing in ${modelDir}: ${missingFiles.join(', ')}`,
      );
    }

    return { binaryPath, modelDir };
  }

  throw new Error(
    `qwen-asr assets not found for ${platformKey}. `
      + 'Install the Voice models extension in onboarding, or run '
      + '`pnpm run download:qwen-asr -- --current-platform` before packaging.',
  );
}

async function runQwenAsrCli(wavPath: string): Promise<string> {
  const fakeTranscript = process.env.TEST_FAKE_ASR_TEXT?.trim();
  if (fakeTranscript) {
    return sanitizeQwenTranscript(fakeTranscript);
  }

  const { binaryPath, modelDir } = await resolveBundledQwenPaths();

  await access(binaryPath);
  await access(modelDir);

  const extraArgsRaw = process.env.QWEN_ASR_EXTRA_ARGS?.trim();
  const extraArgs = extraArgsRaw ? extraArgsRaw.split(/\s+/).filter(Boolean) : [];

  const args = ['-d', modelDir, '-i', wavPath, '-S', '0', ...extraArgs];

  const child = spawn(binaryPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  let stdout = '';
  let stderr = '';
  let timedOut = false;

  child.stdout.on('data', (chunk: Buffer | string) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, COMMAND_TIMEOUT_MS);

    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve(typeof code === 'number' ? code : 1);
    });
  });

  if (timedOut) {
    throw new Error('qwen_asr timed out while transcribing audio');
  }

  if (exitCode !== 0) {
    const message = stderr.trim() || stdout.trim() || `qwen_asr exited with code ${exitCode}`;
    throw new Error(message);
  }

  const transcript = await sanitizeQwenTranscript(extractTranscript(stdout));
  return transcript;
}

export async function transcribeWavWithQwenAsr(wavBuffer: Buffer): Promise<string> {
  if (!Buffer.isBuffer(wavBuffer) || wavBuffer.length === 0) {
    throw new Error('Missing WAV audio payload');
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'qwen-asr-'));
  const wavPath = path.join(tempDir, 'utterance.wav');

  try {
    await writeFile(wavPath, wavBuffer);
    return await runQwenAsrCli(wavPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
