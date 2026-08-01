#!/usr/bin/env node
/**
 * Downloads and builds antirez/qwen-asr for the current platform,
 * into resources/qwen-asr/<platform-arch>/.
 *
 * Usage:
 *   node scripts/download-qwen-asr.mjs [--current-platform]
 *
 * Environment:
 *   QWEN_ASR_GIT_REF   Override source ref (default pinned commit)
 *   QWEN_ASR_MODEL     small|large (default: small)
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const QWEN_ROOT = path.join(ROOT, 'resources', 'qwen-asr');

const PINNED_GIT_REF = 'b00b789b17051aea61e9717458171100662318a4';
const SUPPORTED = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-x64',
  'linux-arm64',
  'win32-x64',
  'win32-arm64',
]);

function getPlatformKey() {
  const platform = process.platform === 'win32' ? 'win32' : process.platform;
  return `${platform}-${process.arch}`;
}

function getBinaryName() {
  return process.platform === 'win32' ? 'qwen_asr.exe' : 'qwen_asr';
}

function getModelConfig() {
  const requested = (process.env.QWEN_ASR_MODEL || 'small').trim().toLowerCase();
  if (requested === 'small') {
    return {
      id: 'Qwen/Qwen3-ASR-0.6B',
      dirName: 'qwen3-asr-0.6b',
      files: [
        'config.json',
        'generation_config.json',
        'model.safetensors',
        'vocab.json',
        'merges.txt',
      ],
    };
  }

  return {
    id: 'Qwen/Qwen3-ASR-1.7B',
    dirName: 'qwen3-asr-1.7b',
    files: [
      'config.json',
      'generation_config.json',
      'model.safetensors.index.json',
      'model-00001-of-00002.safetensors',
      'model-00002-of-00002.safetensors',
      'vocab.json',
      'merges.txt',
    ],
  };
}

function run(command, options = {}) {
  execSync(command, {
    stdio: 'inherit',
    ...options,
  });
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function removeDirIfPresent(dirPath) {
  if (!fs.existsSync(dirPath)) return;
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function fileExists(filePath) {
  return fs.existsSync(filePath);
}

function downloadSourceAndBuild({ gitRef, targetDir }) {
  const tmpRoot = path.join(QWEN_ROOT, '.tmp', `src-${Date.now()}`);
  const archivePath = path.join(tmpRoot, 'qwen-asr.tar.gz');
  const sourceDir = path.join(tmpRoot, 'src');

  ensureDir(sourceDir);

  try {
    const tarUrl = `https://codeload.github.com/antirez/qwen-asr/tar.gz/${gitRef}`;
    console.log(`[qwen-asr] Downloading source: ${tarUrl}`);
    run(`curl -L --fail --retry 3 --retry-delay 2 -o "${archivePath}" "${tarUrl}"`);

    console.log('[qwen-asr] Extracting source archive...');
    run(`tar -xzf "${archivePath}" -C "${sourceDir}"`);

    const extractedEntries = fs.readdirSync(sourceDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    if (extractedEntries.length !== 1) {
      throw new Error('Unexpected qwen-asr source archive layout');
    }

    const repoDir = path.join(sourceDir, extractedEntries[0]);
    console.log('[qwen-asr] Building binary...');

    run('make blas', { cwd: repoDir });

    const builtBinaryCandidates = [
      path.join(repoDir, 'qwen_asr'),
      path.join(repoDir, 'qwen_asr.exe'),
    ];
    const builtBinary = builtBinaryCandidates.find(fileExists);
    if (!builtBinary) {
      throw new Error('qwen_asr binary was not produced by build');
    }

    const outBinary = path.join(targetDir, getBinaryName());
    fs.copyFileSync(builtBinary, outBinary);
    if (process.platform !== 'win32') {
      fs.chmodSync(outBinary, 0o755);
    }
  } finally {
    removeDirIfPresent(tmpRoot);
  }
}

function writeManifest({ targetDir, gitRef, model }) {
  const manifestPath = path.join(targetDir, 'manifest.json');
  const manifest = {
    source: {
      repo: 'antirez/qwen-asr',
      gitRef,
    },
    build: {
      target: 'blas',
    },
    model: {
      id: model.id,
      dirName: model.dirName,
      files: model.files,
    },
    generatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function readManifest(manifestPath) {
  try {
    const raw = fs.readFileSync(manifestPath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function main() {
  const args = new Set(process.argv.slice(2));
  const currentPlatformOnly = args.has('--current-platform');
  const platformKey = getPlatformKey();
  const gitRef = (process.env.QWEN_ASR_GIT_REF || PINNED_GIT_REF).trim();
  const model = getModelConfig();
  const tempRoot = path.join(QWEN_ROOT, '.tmp');

  if (!currentPlatformOnly) {
    throw new Error('download-qwen-asr currently requires --current-platform');
  }

  if (!SUPPORTED.has(platformKey)) {
    throw new Error(`qwen-asr build is not supported on this platform: ${platformKey}`);
  }

  removeDirIfPresent(tempRoot);
  const targetDir = path.join(QWEN_ROOT, platformKey);
  ensureDir(targetDir);

  const manifestPath = path.join(targetDir, 'manifest.json');
  const existingManifest = readManifest(manifestPath);
  const binaryPath = path.join(targetDir, getBinaryName());
  const modelDirPath = path.join(targetDir, model.dirName);

  const needsBinaryBuild = !fileExists(binaryPath)
    || existingManifest?.source?.gitRef !== gitRef
    || existingManifest?.build?.target !== 'blas';

  if (needsBinaryBuild) {
    downloadSourceAndBuild({ gitRef, targetDir });
  } else {
    console.log('[qwen-asr] Binary already present, skipping build.');
  }

  if (fileExists(modelDirPath)) {
    fs.rmSync(modelDirPath, { recursive: true, force: true });
    console.log(`[qwen-asr] Removed bundled model directory (${model.dirName}); models are downloaded at runtime.`);
  }

  writeManifest({ targetDir, gitRef, model });
  console.log(`[qwen-asr] Ready at resources/qwen-asr/${platformKey}`);
}

try {
  main();
} catch (error) {
  console.error('[qwen-asr] Setup failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
}
