#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PNPM_BIN = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const DIST_DIR = path.join(ROOT, 'dist');
const PRODUCT_NAME = 'Interpreter';
const PACKAGE_SMOKE_SENTINEL = '[package-smoke] js_repl runtime ok';
const PACKAGE_SMOKE_SENTRY_SENTINEL = '[package-smoke] sentry runtime ok';

function getArchFlag() {
  if (process.arch === 'arm64') {
    return '--arm64';
  }
  if (process.arch === 'x64') {
    return '--x64';
  }
  throw new Error(`Unsupported architecture for package smoke: ${process.arch}`);
}

function getPlatformArgs() {
  const archFlag = getArchFlag();
  switch (process.platform) {
    case 'darwin':
      return ['--mac', 'dir', archFlag];
    case 'win32':
      return ['--win', 'dir', archFlag];
    case 'linux':
      return ['--linux', 'dir', archFlag];
    default:
      throw new Error(`Unsupported platform for package smoke: ${process.platform}`);
  }
}

function findBundledResourcesRoot() {
  const pendingDirs = [DIST_DIR];

  while (pendingDirs.length > 0) {
    const currentDir = pendingDirs.pop();
    if (!currentDir) {
      continue;
    }

    if (existsSync(path.join(currentDir, 'js-repl-runtime', 'package.json'))) {
      return currentDir;
    }

    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        pendingDirs.push(path.join(currentDir, entry.name));
      }
    }
  }

  throw new Error(`[package-smoke] Could not find packaged resources root under ${DIST_DIR}`);
}

function resolvePackagedAppBinary(resourcesRoot) {
  if (process.platform === 'darwin') {
    const contentsDir = path.dirname(resourcesRoot);
    const appDir = path.dirname(contentsDir);
    const appBinary = path.join(contentsDir, 'MacOS', path.basename(appDir, '.app'));
    if (existsSync(appBinary)) {
      return appBinary;
    }
  }

  const unpackedDir = path.dirname(resourcesRoot);
  const candidateNames = process.platform === 'win32'
    ? [`${PRODUCT_NAME}.exe`]
    : [PRODUCT_NAME, PRODUCT_NAME.toLowerCase()];

  for (const candidateName of candidateNames) {
    const candidatePath = path.join(unpackedDir, candidateName);
    if (existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  throw new Error(`[package-smoke] Could not find packaged app binary next to ${resourcesRoot}`);
}

function runJsReplRuntimeSmoke() {
  const resourcesRoot = findBundledResourcesRoot();
  const appBinary = resolvePackagedAppBinary(resourcesRoot);
  const runtimeDir = path.join(resourcesRoot, 'js-repl-runtime');
  const playwrightCorePackageJson = path.join(runtimeDir, 'node_modules', 'playwright-core', 'package.json');
  const browserControlPackageJson = path.join(runtimeDir, 'node_modules', 'interpreter-browser-control', 'package.json');
  const smokeScriptPath = path.join(runtimeDir, '__package-smoke-js-repl-runtime.mjs');

  if (!existsSync(playwrightCorePackageJson)) {
    throw new Error(
      `[package-smoke] Packaged js_repl runtime is incomplete. Missing ${playwrightCorePackageJson}`,
    );
  }
  if (!existsSync(browserControlPackageJson)) {
    throw new Error(
      `[package-smoke] Packaged js_repl runtime is incomplete. Missing ${browserControlPackageJson}`,
    );
  }

  writeFileSync(smokeScriptPath, `
import { readFile } from 'node:fs/promises';

const playwrightModule = await import('playwright-core');
const browserControlModule = await import('interpreter-browser-control');
const playwright = playwrightModule.default ?? playwrightModule;
if (!playwright.chromium) {
  throw new Error('playwright-core did not expose chromium');
}
if (typeof browserControlModule.setupInterpreterBrowserControl !== 'function') {
  throw new Error('interpreter-browser-control did not expose setupInterpreterBrowserControl');
}

const packageJson = JSON.parse(
  await readFile(${JSON.stringify(playwrightCorePackageJson)}, 'utf8'),
);
process.stdout.write(${JSON.stringify(`${PACKAGE_SMOKE_SENTINEL} version=`)} + packageJson.version + ${JSON.stringify("\n")});
`, 'utf8');

  try {
    const output = execFileSync(appBinary, ['--experimental-vm-modules', smokeScriptPath], {
      cwd: runtimeDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
      },
    });

    if (!output.includes(PACKAGE_SMOKE_SENTINEL)) {
      throw new Error(`[package-smoke] js_repl runtime smoke did not report success. Output: ${output.trim()}`);
    }

    console.log(output.trim());
  } finally {
    rmSync(smokeScriptPath, { force: true });
  }

  const kernelPath = path.join(runtimeDir, 'kernel', 'kernel.cjs');
  if (!existsSync(kernelPath)) {
    throw new Error(`[package-smoke] Packaged js_repl runtime is incomplete. Missing ${kernelPath}`);
  }
  const kernelOutput = execFileSync(appBinary, ['--experimental-vm-modules', kernelPath], {
    cwd: runtimeDir,
    encoding: 'utf8',
    input: '{"type":"exec","id":"smoke","code":"console.log(\'js-repl-kernel-smoke\', 40 + 2);"}\n',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      INTERPRETER_JS_REPL_NODE_MODULE_DIRS: runtimeDir,
    },
  });
  if (!kernelOutput.includes('"output":"js-repl-kernel-smoke 42"')) {
    throw new Error(`[package-smoke] js_repl kernel smoke did not report success. Output: ${kernelOutput.trim()}`);
  }
  console.log('[package-smoke] js_repl kernel exec ok');
}

function runSentryRuntimeSmoke() {
  const resourcesRoot = findBundledResourcesRoot();
  const appBinary = resolvePackagedAppBinary(resourcesRoot);
  const appNodeModulesDir = path.join(resourcesRoot, 'app.asar', 'node_modules');
  const smokeScriptPath = path.join(resourcesRoot, '__package-smoke-sentry.mjs');

  writeFileSync(smokeScriptPath, `
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Sentry = require('@sentry/node');
if (typeof Sentry.init !== 'function') {
  throw new Error('@sentry/node did not expose init');
}

process.stdout.write(${JSON.stringify(`${PACKAGE_SMOKE_SENTRY_SENTINEL}\n`)});
`, 'utf8');

  try {
    const output = execFileSync(appBinary, [smokeScriptPath], {
      cwd: resourcesRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_PATH: appNodeModulesDir,
      },
    });

    if (!output.includes(PACKAGE_SMOKE_SENTRY_SENTINEL)) {
      throw new Error(`[package-smoke] Sentry runtime smoke did not report success. Output: ${output.trim()}`);
    }

    console.log(output.trim());
  } finally {
    rmSync(smokeScriptPath, { force: true });
  }
}

function main() {
  const args = [
    'exec',
    'electron-builder',
    ...getPlatformArgs(),
    '-c.npmRebuild=false',
    '-c.mac.notarize=false',
    '-c.mac.hardenedRuntime=false',
    '--publish',
    'never',
  ];

  console.log(`[package-smoke] Running: ${PNPM_BIN} ${args.join(' ')}`);
  execFileSync(PNPM_BIN, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    },
  });

  runJsReplRuntimeSmoke();
  runSentryRuntimeSmoke();
}

main();
