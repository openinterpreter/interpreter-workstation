import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { resolveInterpreterDataDir } from '../../../../shared/interpreterConfigPaths';
import type { BuiltinToolContext, BuiltinToolDefinition } from '../../builtinTools';
import { getCurrentWorkspace } from '../../../utils/workspace';
import { resolvePathWithWorkspace } from '../../../utils/permissions';
import { emitAppToast } from '../../../utils/ipcBridge';

type TranscriptionModelId =
  | 'tiny.en'
  | 'tiny'
  | 'small.en'
  | 'small'
  | 'medium.en'
  | 'medium'
  | 'large-v3';

interface TranscriptionModelInfo {
  id: TranscriptionModelId;
  label: string;
  fileName: string;
  sha256: string;
  sizeMb: number;
  quality: 'fastest' | 'good' | 'better' | 'best';
  language: 'english' | 'multilingual';
}

const WHISPERFILE_BASE_URL = 'https://huggingface.co/Mozilla/whisperfile/resolve/main';
const MAX_DOWNLOAD_REDIRECTS = 10;
const TRANSCRIBE_TIMEOUT_MS = 30 * 60 * 1000;

// Opt-in live coverage exists at `pnpm run test:transcribe`.
// It is intentionally excluded from default CI because it downloads local
// Whisper model assets and runs real on-device transcription against generated
// audio. Keep download/install behavior app-side; agent sandbox code should
// only call these builtin tools through `interpreter-app`.
const TRANSCRIPTION_MODELS: TranscriptionModelInfo[] = [
  {
    id: 'tiny.en',
    label: 'Tiny English',
    fileName: 'whisper-tiny.en.llamafile',
    sha256: '0e8d17c72d3fd259d4ac761dd9f8f3a30ad21affb818c1aaf17f63945254f25a',
    sizeMb: 87,
    quality: 'fastest',
    language: 'english',
  },
  {
    id: 'tiny',
    label: 'Tiny multilingual',
    fileName: 'whisper-tiny.llamafile',
    sha256: 'c4f7664b54404806f7d51a2a6e0c44643a917efb76345ed3c0871596fa9683c0',
    sizeMb: 87,
    quality: 'fastest',
    language: 'multilingual',
  },
  {
    id: 'small.en',
    label: 'Small English',
    fileName: 'whisper-small.en.llamafile',
    sha256: '886fc937bdc0d0219b493ef1d033c0199615ee121379c54da6669752ded42003',
    sizeMb: 497,
    quality: 'good',
    language: 'english',
  },
  {
    id: 'small',
    label: 'Small multilingual',
    fileName: 'whisper-small.llamafile',
    sha256: '8a74a4ff175b732571b8eb0ab5877cf33128d49c642c40547f4732163933618b',
    sizeMb: 497,
    quality: 'good',
    language: 'multilingual',
  },
  {
    id: 'medium.en',
    label: 'Medium English',
    fileName: 'whisper-medium.en.llamafile',
    sha256: '004f88b8a3d505b13a0374d3b3aeff0b817241267cafda36617c414c2e56bb39',
    sizeMb: 1830,
    quality: 'better',
    language: 'english',
  },
  {
    id: 'medium',
    label: 'Medium multilingual',
    fileName: 'whisper-medium.llamafile',
    sha256: 'eaa2a57b294c098b1035beab59f0cd0ccbdd545842141f577fa5ab3c02c425e5',
    sizeMb: 1830,
    quality: 'better',
    language: 'multilingual',
  },
  {
    id: 'large-v3',
    label: 'Large v3 multilingual',
    fileName: 'whisper-large-v3.llamafile',
    sha256: '83d3a07b49830f9591f82a428f0a59965360bfd7dab26e8fa5833320e5dd3680',
    sizeMb: 3390,
    quality: 'best',
    language: 'multilingual',
  },
];

const MODEL_IDS = TRANSCRIPTION_MODELS.map((model) => model.id);
const downloadsInFlight = new Map<TranscriptionModelId, Promise<Record<string, unknown>>>();

function getModelInfo(modelId: unknown): TranscriptionModelInfo | null {
  if (typeof modelId !== 'string') return null;
  return TRANSCRIPTION_MODELS.find((model) => model.id === modelId) ?? null;
}

function getInstallRoot(): string {
  const testRoot = process.env.TEST_TRANSCRIBE_INSTALL_ROOT?.trim();
  if (testRoot) {
    return path.resolve(testRoot);
  }
  return path.join(resolveInterpreterDataDir(), 'local-transcribe');
}

function getInstalledExecutablePath(model: TranscriptionModelInfo): string {
  const fileName = process.platform === 'win32'
    ? model.fileName.replace(/\.llamafile$/, '.exe')
    : model.fileName;
  return path.join(getInstallRoot(), 'models', model.id, fileName);
}

function getManifestPath(model: TranscriptionModelInfo): string {
  return path.join(getInstallRoot(), 'models', model.id, 'manifest.json');
}

function isModelInstalled(model: TranscriptionModelInfo): boolean {
  return fs.existsSync(getInstalledExecutablePath(model))
    && fs.existsSync(getManifestPath(model));
}

function buildNotInstalledMessage(model: TranscriptionModelInfo): string {
  return [
    `Local transcription model \`${model.id}\` is not installed.`,
    `Ask the user whether to download it, then run \`interpreter-app tools builtin-transcribe download_model --json '{"model":"${model.id}"}'\`.`,
    'Use `interpreter-app tools builtin-transcribe list_transcription_models --json \'{}\'` to compare model size, language, and quality tradeoffs.',
  ].join(' ');
}

async function downloadToFileWithRedirects(url: string, outputPath: string, redirectCount: number): Promise<void> {
  if (redirectCount >= MAX_DOWNLOAD_REDIRECTS) {
    throw new Error(`Failed to download ${url}: too many redirects`);
  }

  await new Promise<void>((resolve, reject) => {
    if (!url.startsWith('https://')) {
      reject(new Error(`Refusing to download executable over non-HTTPS URL: ${url}`));
      return;
    }

    const client = https;
    const req = client.get(url, (response) => {
      const statusCode = response.statusCode ?? 0;

      if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
        const nextUrl = new URL(response.headers.location, url).toString();
        if (!nextUrl.startsWith('https://')) {
          response.resume();
          reject(new Error(`Refusing non-HTTPS redirect while downloading executable: ${nextUrl}`));
          return;
        }
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

async function calculateFileSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function verifyDownloadedExecutable(filePath: string, expectedSha256: string): Promise<void> {
  const actualSha256 = await calculateFileSha256(filePath);
  if (actualSha256 !== expectedSha256) {
    throw new Error(`Downloaded transcription executable failed integrity check: expected ${expectedSha256}, got ${actualSha256}`);
  }
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

async function ensureExecutable(filePath: string): Promise<void> {
  if (process.platform !== 'win32') {
    await chmod(filePath, 0o755);
  }
}

async function installModel(model: TranscriptionModelInfo): Promise<Record<string, unknown>> {
  const existingDownload = downloadsInFlight.get(model.id);
  if (existingDownload) {
    return existingDownload;
  }

  const downloadPromise = (async () => {
    const executablePath = getInstalledExecutablePath(model);
    const manifestPath = getManifestPath(model);
    const modelDir = path.dirname(executablePath);

    await mkdir(modelDir, { recursive: true });
    emitAppToast({
      message: `Downloading local transcription model ${model.id}...`,
      variant: 'info',
      autoDismissMs: 6000,
    });

    const url = `${WHISPERFILE_BASE_URL}/${model.fileName}?download=true`;
    if (process.env.TEST_TRANSCRIBE_FAKE_DOWNLOAD === '1') {
      await writeFile(executablePath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', 'utf-8');
    } else {
      await downloadToFile(url, executablePath);
      await verifyDownloadedExecutable(executablePath, model.sha256);
    }
    await ensureExecutable(executablePath);
    await writeFile(manifestPath, JSON.stringify({
      id: model.id,
      fileName: model.fileName,
      sha256: model.sha256,
      source: url,
      installedAt: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
    }, null, 2), 'utf-8');

    emitAppToast({
      message: `Local transcription model ${model.id} downloaded.`,
      variant: 'success',
      autoDismissMs: 6000,
    });

    return {
      installed: true,
      model: model.id,
      executablePath,
      installRoot: getInstallRoot(),
    };
  })().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    emitAppToast({
      message: `Local transcription model download failed: ${message}`,
      variant: 'error',
      autoDismissMs: 10000,
    });
    throw error;
  }).finally(() => {
    downloadsInFlight.delete(model.id);
  });

  downloadsInFlight.set(model.id, downloadPromise);
  return downloadPromise;
}

async function runWhisperfile(executablePath: string, audioPath: string): Promise<string> {
  if (process.env.TEST_TRANSCRIBE_FAKE_TRANSCRIPT) {
    return process.env.TEST_TRANSCRIBE_FAKE_TRANSCRIPT;
  }

  const whisperArgs = ['-f', audioPath, '--no-prints'];
  const command = process.platform === 'darwin' && executablePath.endsWith('.llamafile')
    ? '/bin/sh'
    : executablePath;
  const args = command === executablePath
    ? whisperArgs
    : [executablePath, ...whisperArgs];
  const child = spawn(command, args, {
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
    }, TRANSCRIBE_TIMEOUT_MS);

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
    throw new Error('Local transcription timed out');
  }

  if (exitCode !== 0) {
    const message = stderr.trim() || stdout.trim() || `Local transcription exited with code ${exitCode}`;
    throw new Error(message);
  }

  return stdout.trim();
}

function getToolWorkspace(context?: BuiltinToolContext): string | null {
  return context?.workspace ?? getCurrentWorkspace();
}

function resolveOptionalOutputPath(rawOutputPath: unknown, workspace: string | null): string | undefined {
  if (typeof rawOutputPath !== 'string' || !rawOutputPath.trim()) {
    return undefined;
  }
  return resolvePathWithWorkspace(rawOutputPath.trim(), workspace);
}

export const listTranscriptionModelsTool: BuiltinToolDefinition = {
  name: 'list_transcription_models',
  description: 'List local Whisper transcription models and whether each one is installed on this device.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  mode: 'read',
  annotations: {
    readOnlyHint: true,
  },
  handler: async () => ({
    content: [{
      type: 'text',
      text: JSON.stringify({
        installRoot: getInstallRoot(),
        models: TRANSCRIPTION_MODELS.map((model) => ({
          ...model,
          installed: isModelInstalled(model),
          executablePath: isModelInstalled(model) ? getInstalledExecutablePath(model) : null,
        })),
      }, null, 2),
    }],
  }),
};

export const downloadTranscriptionModelTool: BuiltinToolDefinition = {
  name: 'download_model',
  description: 'Download a local Whisper transcription model on the app side into Interpreter user data. Use before transcribing with a model that is not installed.',
  inputSchema: {
    type: 'object',
    properties: {
      model: {
        type: 'string',
        enum: MODEL_IDS,
        description: 'Model to download. tiny/tiny.en are fastest and smallest; small improves quality; medium and large-v3 are much larger and slower.',
      },
    },
    required: ['model'],
  },
  mode: 'write',
  handler: async (args) => {
    const model = getModelInfo(args.model);
    if (!model) {
      return {
        content: [{ type: 'text', text: `Error: Unknown model. Use one of: ${MODEL_IDS.join(', ')}` }],
        isError: true,
      };
    }

    if (isModelInstalled(model)) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            installed: true,
            model: model.id,
            executablePath: getInstalledExecutablePath(model),
            installRoot: getInstallRoot(),
          }, null, 2),
        }],
      };
    }

    const result = await installModel(model);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  },
};

export const transcribeAudioTool: BuiltinToolDefinition = {
  name: 'transcribe_audio',
  description: 'Transcribe an audio file locally with an installed Whisper model. If the model is missing, this tool tells the agent to ask the user before running builtin-transcribe download_model.',
  inputSchema: {
    type: 'object',
    properties: {
      audioPath: {
        type: 'string',
        description: 'Audio file path to transcribe. Supports workspace-relative or absolute paths.',
      },
      model: {
        type: 'string',
        enum: MODEL_IDS,
        description: 'Installed transcription model to use. Default: tiny.en.',
        default: 'tiny.en',
      },
      outputPath: {
        type: 'string',
        description: 'Optional path to save the transcript as UTF-8 text.',
      },
    },
    required: ['audioPath'],
  },
  fileAccess: {
    mode: 'write',
    pathArg: ['audioPath', 'outputPath'],
    pathArgModes: {
      audioPath: 'read',
      outputPath: 'write',
    },
  },
  mode: 'write',
  handler: async (args, context) => {
    const rawAudioPath = typeof args.audioPath === 'string' ? args.audioPath.trim() : '';
    if (!rawAudioPath) {
      return {
        content: [{ type: 'text', text: 'Error: `audioPath` is required.' }],
        isError: true,
      };
    }

    const model = getModelInfo(args.model ?? 'tiny.en');
    if (!model) {
      return {
        content: [{ type: 'text', text: `Error: Unknown model. Use one of: ${MODEL_IDS.join(', ')}` }],
        isError: true,
      };
    }

    if (!isModelInstalled(model)) {
      return {
        content: [{ type: 'text', text: buildNotInstalledMessage(model) }],
        isError: true,
      };
    }

    const workspace = getToolWorkspace(context);
    const audioPath = resolvePathWithWorkspace(rawAudioPath, workspace);
    const outputPath = resolveOptionalOutputPath(args.outputPath, workspace);
    const transcript = await runWhisperfile(getInstalledExecutablePath(model), audioPath);

    if (outputPath) {
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, `${transcript.trimEnd()}${os.EOL}`, 'utf-8');
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          model: model.id,
          audioPath,
          outputPath: outputPath ?? null,
          transcript,
        }, null, 2),
      }],
    };
  },
};
