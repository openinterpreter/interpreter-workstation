#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PNPM_BIN = process.platform === 'win32' ? 'pnpm' : 'pnpm';

const JS_REPL_RUNTIME_SOURCE_PACKAGE_JSON = path.join(
  ROOT,
  'js-repl-runtime',
  'package.json',
);
const JS_REPL_RUNTIME_TARGET_DIR = path.join(ROOT, 'resources', 'js-repl-runtime');
const JS_REPL_RUNTIME_TARGET_PACKAGE_JSON = path.join(
  JS_REPL_RUNTIME_TARGET_DIR,
  'package.json',
);
const JS_REPL_RUNTIME_PLAYWRIGHT_PACKAGE_JSON = path.join(
  JS_REPL_RUNTIME_TARGET_DIR,
  'node_modules',
  'playwright-core',
  'package.json',
);
const JS_REPL_RUNTIME_BROWSER_CONTROL_PACKAGE_JSON = path.join(
  JS_REPL_RUNTIME_TARGET_DIR,
  'node_modules',
  'interpreter-browser-control',
  'package.json',
);
const JS_REPL_RUNTIME_KERNEL = path.join(
  JS_REPL_RUNTIME_TARGET_DIR,
  'kernel',
  'kernel.cjs',
);

function listFilesRecursive(dir) {
  if (!existsSync(dir)) {
    return [];
  }

  const entries = [];
  for (const name of readdirSync(dir).sort()) {
    const fullPath = path.join(dir, name);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      entries.push(...listFilesRecursive(fullPath));
    } else if (stat.isFile()) {
      entries.push(fullPath);
    }
  }
  return entries;
}

function sourceTreeMatchesTarget(relativeDir) {
  const sourceDir = path.join(ROOT, 'js-repl-runtime', relativeDir);
  const targetDir = path.join(JS_REPL_RUNTIME_TARGET_DIR, relativeDir);
  const sourceFiles = listFilesRecursive(sourceDir).map((file) => path.relative(sourceDir, file));
  const targetFiles = listFilesRecursive(targetDir).map((file) => path.relative(targetDir, file));

  if (sourceFiles.join('\n') !== targetFiles.join('\n')) {
    return false;
  }

  return sourceFiles.every((relativeFile) =>
    readFileSync(path.join(sourceDir, relativeFile), 'utf8')
      === readFileSync(path.join(targetDir, relativeFile), 'utf8')
  );
}

function runPnpm(args) {
  execFileSync(PNPM_BIN, args, {
    cwd: ROOT,
    env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}

function needsJsReplRuntimeRebuild() {
  if (!existsSync(JS_REPL_RUNTIME_TARGET_PACKAGE_JSON)) {
    return true;
  }
  if (!existsSync(JS_REPL_RUNTIME_PLAYWRIGHT_PACKAGE_JSON)) {
    return true;
  }
  if (!existsSync(JS_REPL_RUNTIME_BROWSER_CONTROL_PACKAGE_JSON)) {
    return true;
  }
  if (!existsSync(JS_REPL_RUNTIME_KERNEL)) {
    return true;
  }

  if (
    readFileSync(JS_REPL_RUNTIME_SOURCE_PACKAGE_JSON, 'utf8')
    !== readFileSync(JS_REPL_RUNTIME_TARGET_PACKAGE_JSON, 'utf8')
  ) {
    return true;
  }

  return !sourceTreeMatchesTarget('packages') || !sourceTreeMatchesTarget('kernel');
}

function main() {
  const needsJsReplRuntime = needsJsReplRuntimeRebuild();

  if (!needsJsReplRuntime) {
    console.log('[js-repl-assets] Bundled js_repl runtime assets are ready.');
    return;
  }

  console.log('[js-repl-assets] Preparing bundled js_repl runtime assets...');

  if (needsJsReplRuntime) {
    runPnpm(['run', 'build:js-repl-runtime']);
  }
}

main();
