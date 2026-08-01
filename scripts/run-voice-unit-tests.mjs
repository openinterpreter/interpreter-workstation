import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const rootDir = process.cwd();
const platformKey = `${process.platform}-${process.arch}`;
const binaryName = process.platform === 'win32' ? 'qwen_asr.exe' : 'qwen_asr';
const modelDirNames = ['qwen3-asr-0.6b', 'qwen-asr'];

function hasUsableQwenInstall(rootDirPath) {
  if (!rootDirPath) {
    return false;
  }

  const platformDir = path.join(rootDirPath, platformKey);
  const binaryPath = path.join(platformDir, binaryName);
  if (!fs.existsSync(binaryPath)) {
    return false;
  }

  return modelDirNames.some((modelDirName) => fs.existsSync(path.join(platformDir, modelDirName)));
}

function resolveQwenAssetDir() {
  const candidates = [
    process.env.QWEN_ASR_ASSET_DIR?.trim(),
    path.join(os.homedir(), 'Library/Application Support/interpreter/qwen-asr'),
    path.join(os.homedir(), 'Library/Application Support/Interpreter/qwen-asr'),
    path.join(os.homedir(), 'Library/Application Support/Electron/qwen-asr'),
    path.join(rootDir, 'resources', 'qwen-asr'),
  ].filter(Boolean);

  const usableRoot = candidates.find((candidate) => hasUsableQwenInstall(candidate));
  if (!usableRoot) {
    throw new Error(
      `No usable qwen asset root found for ${platformKey}. `
      + 'Expected a qwen_asr binary plus a downloaded model directory.',
    );
  }

  return usableRoot;
}

const qwenAssetDir = resolveQwenAssetDir();

async function runCommand(command, args, env) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env,
      cwd: rootDir,
    });
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} exited with code ${code ?? 1}`));
    });
  });
}

const env = {
  ...process.env,
  QWEN_ASR_ASSET_DIR: qwenAssetDir,
};

await runCommand('node', ['scripts/check-voice-test-prereqs.mjs'], env);
await runCommand('node', ['scripts/run-unit-tests.mjs', '--voice'], env);
await runCommand('bun', [
  'test',
  'tests/voice-ambient-cycling.test.ts',
  'tests/voice-modes.test.ts',
  'tests/voice-pipeline-server.test.ts',
], env);
