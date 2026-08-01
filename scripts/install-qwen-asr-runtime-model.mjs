#!/usr/bin/env node
import fs from 'node:fs';
import { cp, mkdir, readFile, rename, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const QWEN_MODEL_DOWNLOAD_BASE = 'https://huggingface.co';
const MAX_DOWNLOAD_REDIRECTS = 10;

function getPlatformKey() {
  const platform = process.platform === 'win32' ? 'win32' : process.platform;
  return `${platform}-${process.arch}`;
}

function getBinaryName() {
  return process.platform === 'win32' ? 'qwen_asr.exe' : 'qwen_asr';
}

function getDefaultInstallRoot() {
  if (process.env.QWEN_ASR_ASSET_DIR?.trim()) {
    return path.resolve(process.env.QWEN_ASR_ASSET_DIR.trim());
  }

  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library/Application Support/interpreter/qwen-asr');
  }

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim();
    if (!appData) {
      throw new Error('APPDATA is required to resolve the qwen install root on Windows');
    }
    return path.join(appData, 'interpreter', 'qwen-asr');
  }

  const configHome = process.env.XDG_CONFIG_HOME?.trim()
    || path.join(os.homedir(), '.config');
  return path.join(configHome, 'interpreter', 'qwen-asr');
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf-8'));
}

function resolveModelConfig(manifest) {
  const id = typeof manifest?.model?.id === 'string' && manifest.model.id.trim()
    ? manifest.model.id.trim()
    : 'Qwen/Qwen3-ASR-0.6B';
  const dirName = typeof manifest?.model?.dirName === 'string' && manifest.model.dirName.trim()
    ? manifest.model.dirName.trim()
    : 'qwen3-asr-0.6b';
  const files = Array.isArray(manifest?.model?.files)
    ? manifest.model.files.filter((file) => typeof file === 'string' && file.trim()).map((file) => file.trim())
    : [];
  return {
    id,
    dirName,
    files: files.length > 0
      ? files
      : ['config.json', 'generation_config.json', 'model.safetensors', 'vocab.json', 'merges.txt'],
  };
}

async function downloadToFileWithRedirects(url, outputPath, redirectCount) {
  if (redirectCount >= MAX_DOWNLOAD_REDIRECTS) {
    throw new Error(`Failed to download ${url}: too many redirects`);
  }

  await new Promise((resolve, reject) => {
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

async function downloadToFile(url, outputPath) {
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

async function main() {
  const platformKey = getPlatformKey();
  const binaryName = getBinaryName();
  const sourcePlatformDir = path.join(ROOT, 'resources', 'qwen-asr', platformKey);
  const sourceBinaryPath = path.join(sourcePlatformDir, binaryName);
  const sourceManifestPath = path.join(sourcePlatformDir, 'manifest.json');

  if (!fs.existsSync(sourceBinaryPath) || !fs.existsSync(sourceManifestPath)) {
    throw new Error(
      `Bundled qwen-asr binary or manifest missing at ${sourcePlatformDir}. `
        + 'Run `pnpm run download:qwen-asr -- --current-platform` first.',
    );
  }

  const manifest = await readJson(sourceManifestPath);
  const modelConfig = resolveModelConfig(manifest);
  const installRoot = getDefaultInstallRoot();
  const targetPlatformDir = path.join(installRoot, platformKey);
  const targetModelDir = path.join(targetPlatformDir, modelConfig.dirName);

  console.log(`[qwen-asr] Installing runtime assets to ${targetPlatformDir}`);
  await rm(targetPlatformDir, { recursive: true, force: true });
  await mkdir(targetModelDir, { recursive: true });
  await cp(sourceBinaryPath, path.join(targetPlatformDir, binaryName), { force: true });
  await cp(sourceManifestPath, path.join(targetPlatformDir, 'manifest.json'), { force: true });

  for (const fileName of modelConfig.files) {
    const downloadUrl = `${QWEN_MODEL_DOWNLOAD_BASE}/${modelConfig.id}/resolve/main/${fileName}`;
    const targetPath = path.join(targetModelDir, fileName);
    await mkdir(path.dirname(targetPath), { recursive: true });
    console.log(`[qwen-asr] Downloading ${fileName}`);
    await downloadToFile(downloadUrl, targetPath);
  }

  for (const fileName of modelConfig.files) {
    const targetPath = path.join(targetModelDir, fileName);
    if (!fs.existsSync(targetPath)) {
      throw new Error(`qwen-asr runtime install failed validation: ${targetPath}`);
    }
  }

  console.log(`[qwen-asr] Runtime model ready: ${targetPlatformDir}`);
}

try {
  await main();
} catch (error) {
  console.error('[qwen-asr] Runtime model install failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
}
