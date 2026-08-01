#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SOURCE_DIR = path.join(ROOT, 'js-repl-runtime');
const TARGET_DIR = path.join(ROOT, 'resources', 'js-repl-runtime');
const PNPM_BIN = process.platform === 'win32' ? 'pnpm' : 'pnpm';

function runPnpm(args, cwd) {
  execFileSync(PNPM_BIN, args, {
    cwd,
    env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}

function copyRequiredFile(sourceDir, targetDir, filename) {
  const sourcePath = path.join(sourceDir, filename);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Missing js-repl runtime source file: ${sourcePath}`);
  }
  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(sourcePath, path.join(targetDir, filename));
}

function copyRequiredDir(sourceDir, targetDir, dirname) {
  const sourcePath = path.join(sourceDir, dirname);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Missing js-repl runtime source directory: ${sourcePath}`);
  }
  fs.cpSync(sourcePath, path.join(targetDir, dirname), {
    recursive: true,
    force: true,
  });
}

function main() {
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interpreter-js-repl-runtime-'));
  fs.rmSync(TARGET_DIR, { recursive: true, force: true });

  copyRequiredFile(SOURCE_DIR, stagingDir, 'package.json');
  copyRequiredDir(SOURCE_DIR, stagingDir, 'packages');

  runPnpm(
    [
      '--dir',
      stagingDir,
      'install',
      '--prod',
      '--frozen-lockfile=false',
      '--ignore-scripts',
      '--config.node-linker=hoisted',
    ],
    ROOT,
  );

  if (!fs.existsSync(path.join(stagingDir, 'node_modules', 'playwright-core', 'package.json'))) {
    throw new Error(`playwright-core was not installed into ${stagingDir}`);
  }
  if (!fs.existsSync(path.join(stagingDir, 'node_modules', 'interpreter-browser-control', 'package.json'))) {
    throw new Error(`interpreter-browser-control was not installed into ${stagingDir}`);
  }

  copyRequiredFile(SOURCE_DIR, TARGET_DIR, 'package.json');
  copyRequiredDir(SOURCE_DIR, TARGET_DIR, 'packages');
  copyRequiredDir(SOURCE_DIR, TARGET_DIR, 'kernel');
  fs.cpSync(path.join(stagingDir, 'node_modules'), path.join(TARGET_DIR, 'node_modules'), {
    recursive: true,
    force: true,
    dereference: true,
  });
  fs.rmSync(path.join(TARGET_DIR, 'node_modules', '.bin'), {
    recursive: true,
    force: true,
  });
  fs.rmSync(path.join(TARGET_DIR, 'node_modules', 'playwright-core-upstream'), {
    recursive: true,
    force: true,
  });
  fs.rmSync(stagingDir, { recursive: true, force: true });

  console.log(`\n[js-repl-runtime] Installed runtime payload at ${TARGET_DIR}`);
}

main();
