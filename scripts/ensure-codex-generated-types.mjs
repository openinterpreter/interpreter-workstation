#!/usr/bin/env node

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SCHEMAS_DIR = path.join(ROOT, 'server', 'handlers', 'codex-generated-types');
const DOWNLOAD_SCRIPT = path.join(ROOT, 'scripts', 'download-oix.mjs');
const GENERATE_SCRIPT = path.join(ROOT, 'scripts', 'generate-codex-schemas.ts');

const REQUIRED_OUTPUTS = [
  path.join(SCHEMAS_DIR, 'index.ts'),
  path.join(SCHEMAS_DIR, 'serde_json', 'JsonValue.ts'),
  path.join(SCHEMAS_DIR, 'json', 'v2', 'TurnStartParams.json'),
];

function hasGeneratedTypes() {
  return REQUIRED_OUTPUTS.every((entry) => fs.existsSync(entry));
}

function resolveCurrentPlatformBinary() {
  const osPlatform = process.platform === 'win32' ? 'win32' : process.platform;
  const currentPlatform = `${osPlatform}-${process.arch}`;
  const binaryName = process.platform === 'win32' ? 'interpreter.exe' : 'interpreter';
  return path.join(ROOT, 'resources', 'oix', currentPlatform, 'bin', binaryName);
}

function runNodeScript(scriptPath, args) {
  execFileSync(process.execPath, [scriptPath, ...args], {
    cwd: ROOT,
    stdio: 'inherit',
  });
}

function generateFromBinary(binaryPath) {
  execFileSync('bun', [GENERATE_SCRIPT, binaryPath], {
    cwd: ROOT,
    stdio: 'inherit',
  });
}

if (hasGeneratedTypes()) {
  process.exit(0);
}

const binaryPath = resolveCurrentPlatformBinary();
if (fs.existsSync(binaryPath)) {
  console.log('Generating codex app-server protocol types from the local Interpreter runtime...');
  generateFromBinary(binaryPath);
} else {
  console.log('Interpreter runtime missing; downloading the current platform runtime to generate protocol types...');
  runNodeScript(DOWNLOAD_SCRIPT, ['--current-platform']);
}

if (!hasGeneratedTypes()) {
  console.error('Failed to generate codex protocol types.');
  process.exit(1);
}
