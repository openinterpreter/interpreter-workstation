import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function getRequestedVoiceBackend() {
  const forcedBackend = process.env.TEST_FORCE_VOICE_BACKEND?.trim();
  if (forcedBackend === 'qwen' || forcedBackend === 'moonshine') {
    return forcedBackend;
  }
  return process.platform === 'win32' ? 'moonshine' : 'qwen';
}

const requestedBackend = getRequestedVoiceBackend();

if (requestedBackend === 'moonshine') {
  console.log('✓ Voice tests are configured for the moonshine backend; skipping bundled qwen prerequisite check.');
  process.exit(0);
}

const rootDir = process.cwd();
const platformKey = `${process.platform}-${process.arch}`;
const binaryName = process.platform === 'win32' ? 'qwen_asr.exe' : 'qwen_asr';

function getDefaultQwenRoots() {
  if (process.platform === 'darwin') {
    return [
      path.join(os.homedir(), 'Library/Application Support/interpreter/qwen-asr'),
      path.join(os.homedir(), 'Library/Application Support/Interpreter/qwen-asr'),
      path.join(os.homedir(), 'Library/Application Support/Electron/qwen-asr'),
      path.join(rootDir, 'resources', 'qwen-asr'),
    ];
  }

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim();
    return [
      appData ? path.join(appData, 'interpreter', 'qwen-asr') : '',
      appData ? path.join(appData, 'Interpreter', 'qwen-asr') : '',
      path.join(rootDir, 'resources', 'qwen-asr'),
    ].filter(Boolean);
  }

  const configHome = process.env.XDG_CONFIG_HOME?.trim()
    || path.join(os.homedir(), '.config');
  return [
    path.join(configHome, 'interpreter', 'qwen-asr'),
    path.join(configHome, 'Interpreter', 'qwen-asr'),
    path.join(rootDir, 'resources', 'qwen-asr'),
  ];
}

function readManifest(manifestPath) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch {
    return null;
  }
}

function getModelConfig(platformDir) {
  const parsed = readManifest(path.join(platformDir, 'manifest.json'));
  const dirName = typeof parsed?.model?.dirName === 'string' && parsed.model.dirName.trim()
    ? parsed.model.dirName.trim()
    : 'qwen3-asr-0.6b';
  const files = Array.isArray(parsed?.model?.files)
    ? parsed.model.files.filter((file) => typeof file === 'string' && file.trim()).map((file) => file.trim())
    : [];
  return {
    dirName,
    files: files.length > 0
      ? files
      : ['config.json', 'generation_config.json', 'model.safetensors', 'vocab.json', 'merges.txt'],
  };
}

function missingForRoot(qwenRoot) {
  const platformDir = path.join(qwenRoot, platformKey);
  const binaryPath = path.join(platformDir, binaryName);
  const manifestPath = path.join(platformDir, 'manifest.json');
  const missing = [];

  if (!fs.existsSync(binaryPath)) {
    missing.push(binaryPath);
  }
  if (!fs.existsSync(manifestPath)) {
    missing.push(manifestPath);
  }

  const modelConfig = getModelConfig(platformDir);
  const modelDir = path.join(platformDir, modelConfig.dirName);
  for (const fileName of modelConfig.files) {
    const filePath = path.join(modelDir, fileName);
    if (!fs.existsSync(filePath)) {
      missing.push(filePath);
    }
  }

  return {
    platformDir,
    missing,
  };
}

const explicitQwenRoot = process.env.QWEN_ASR_ASSET_DIR?.trim();
const qwenRoots = explicitQwenRoot
  ? [path.resolve(explicitQwenRoot)]
  : getDefaultQwenRoots();

const checks = qwenRoots.map((qwenRoot) => missingForRoot(qwenRoot));
const ready = checks.find((check) => check.missing.length === 0);

if (!ready) {
  console.error('Voice tests require installed qwen assets for the current platform.');
  console.error('Checked roots:');
  for (const check of checks) {
    console.error(`- ${check.platformDir}`);
  }
  console.error('Missing paths:');
  for (const missingPath of checks[0]?.missing ?? []) {
    console.error(`- ${missingPath}`);
  }
  console.error('Run `pnpm run download:qwen-asr -- --current-platform` for the bundled binary, then `pnpm run install:qwen-asr-model` for the runtime model.');
  process.exit(1);
}

console.log(`✓ Voice test qwen assets ready: ${ready.platformDir}`);
