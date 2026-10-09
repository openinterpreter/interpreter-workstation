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
const PACKAGE_SMOKE_SIMPLE_COMPILER_SENTINEL = '[package-smoke] simple interface compiler ok';
const PACKAGE_SMOKE_SIMPLE_RUNTIME_SENTINEL = '[package-smoke] simple interface runtime graph ok';
const REQUIRED_LICENSE_RESOURCES = [
  'NOTICE',
  'THIRD_PARTY_NOTICES.md',
  'sharp-libvips-v1.2.4-THIRD-PARTY-NOTICES.md',
  'sharp-libvips-v1.3.2-THIRD-PARTY-NOTICES.md',
  'sharp-libvips-v1.3.3-THIRD-PARTY-NOTICES.md',
  'sharp-libvips-v1.3.4-THIRD-PARTY-NOTICES.md',
  'LGPL-3.0.txt',
  'GPL-3.0.txt',
  'MPL-1.1.txt',
  'release-policy.json',
];

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

function assertPackagedLicenseResources() {
  const resourcesRoot = findBundledResourcesRoot();
  for (const fileName of REQUIRED_LICENSE_RESOURCES) {
    const requiredPath = path.join(resourcesRoot, 'licenses', fileName);
    if (!existsSync(requiredPath)) {
      throw new Error(`[package-smoke] Packaged license resource is missing: ${requiredPath}`);
    }
  }
  console.log('[package-smoke] packaged license resources ok');
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
  const simpleRuntimeRoot = path.join(resourcesRoot, 'simple-interface-runtime');
  const simpleRuntimeNodeModules = path.join(simpleRuntimeRoot, 'node_modules');
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

function runSimpleInterfaceCompilerSmoke() {
  const resourcesRoot = findBundledResourcesRoot();
  const appBinary = resolvePackagedAppBinary(resourcesRoot);
  const appNodeModulesDir = path.join(resourcesRoot, 'app.asar', 'node_modules');
  const simpleRuntimeRoot = path.join(resourcesRoot, 'simple-interface-runtime');
  const simpleRuntimeNodeModules = path.join(simpleRuntimeRoot, 'node_modules');
  const esbuildBinaryPath = path.join(
    resourcesRoot,
    'app.asar.unpacked',
    'node_modules',
    '@esbuild',
    `${process.platform}-${process.arch}`,
    ...(process.platform === 'win32' ? ['esbuild.exe'] : ['bin', 'esbuild']),
  );
  const smokeScriptPath = path.join(resourcesRoot, '__package-smoke-simple-compiler.cjs');

  if (!existsSync(esbuildBinaryPath)) {
    throw new Error(`[package-smoke] Packaged Simple compiler binary is missing: ${esbuildBinaryPath}`);
  }
  if (!existsSync(path.join(simpleRuntimeRoot, 'package.json'))) {
    throw new Error(`[package-smoke] Packaged Simple runtime is missing: ${simpleRuntimeRoot}`);
  }

  writeFileSync(smokeScriptPath, `
const esbuild = require('esbuild');
(async () => {
const result = esbuild.transformSync('export default function App(){ return <main>Ready</main> }', {
  loader: 'jsx',
  format: 'esm',
  jsx: 'automatic',
});
if (!result.code.includes('function App')) throw new Error('esbuild did not compile the Simple interface smoke source');
const runtime = await esbuild.build({
  stdin: {
    contents: ${JSON.stringify(`
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import Markdown from 'react-markdown';
      import remarkGfm from 'remark-gfm';
      import { motion } from 'motion/react';
      createRoot(document.createElement('div')).render(
        React.createElement(motion.main, null, React.createElement(Markdown, { remarkPlugins: [remarkGfm] }, '# Ready')),
      );
    `)},
    loader: 'jsx',
    resolveDir: ${JSON.stringify(simpleRuntimeNodeModules)},
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
});
if (!runtime.outputFiles?.[0]?.contents?.length) throw new Error('Simple runtime graph did not bundle');
process.stdout.write(${JSON.stringify(`${PACKAGE_SMOKE_SIMPLE_COMPILER_SENTINEL}\n`)});
process.stdout.write(${JSON.stringify(`${PACKAGE_SMOKE_SIMPLE_RUNTIME_SENTINEL}\n`)});
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`, 'utf8');

  try {
    const output = execFileSync(appBinary, [smokeScriptPath], {
      cwd: resourcesRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ESBUILD_BINARY_PATH: esbuildBinaryPath,
        NODE_PATH: appNodeModulesDir,
      },
    });
    if (!output.includes(PACKAGE_SMOKE_SIMPLE_COMPILER_SENTINEL)) {
      throw new Error(`[package-smoke] Simple compiler smoke did not report success. Output: ${output.trim()}`);
    }
    if (!output.includes(PACKAGE_SMOKE_SIMPLE_RUNTIME_SENTINEL)) {
      throw new Error(`[package-smoke] Simple runtime graph smoke did not report success. Output: ${output.trim()}`);
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

  if (!process.argv.includes('--reuse-package')) {
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
  } else {
    console.log('[package-smoke] Reusing the existing packaged directory.');
  }

  assertPackagedLicenseResources();
  runJsReplRuntimeSmoke();
  runSentryRuntimeSmoke();
  runSimpleInterfaceCompilerSmoke();
}

main();
