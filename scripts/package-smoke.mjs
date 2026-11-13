#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import { constants, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PNPM_BIN = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const DIST_DIR = path.join(ROOT, 'dist');
const PRODUCT_NAME = 'Interpreter';
const PACKAGE_SMOKE_SENTINEL = '[package-smoke] js_repl runtime ok';
const PACKAGE_SMOKE_SENTRY_SENTINEL = '[package-smoke] sentry runtime ok';
const PACKAGE_SMOKE_PROJECT_RUNTIME_SENTINEL = '[package-smoke] bundled project runtime ok';
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

function runBundledProjectRuntimeSmoke() {
  const resourcesRoot = findBundledResourcesRoot();
  const appBinary = resolvePackagedAppBinary(resourcesRoot);
  const appNodeModulesDir = path.join(resourcesRoot, 'app.asar', 'node_modules');
  const simpleRuntimeDir = path.join(resourcesRoot, 'simple-interface-runtime');
  const simpleRuntimeManifest = JSON.parse(readFileSync(path.join(simpleRuntimeDir, 'runtime-manifest.json'), 'utf8'));
  if (simpleRuntimeManifest.platform !== process.platform || simpleRuntimeManifest.arch !== process.arch) {
    throw new Error(`[package-smoke] Wrong Simple runtime platform: ${simpleRuntimeManifest.platform}-${simpleRuntimeManifest.arch}`);
  }
  const simpleNextVersion = JSON.parse(readFileSync(path.join(simpleRuntimeDir, 'node_modules', 'next', 'package.json'), 'utf8')).version;
  const nextOutput = execFileSync(appBinary, [path.join(simpleRuntimeDir, 'node_modules', 'next', 'dist', 'bin', 'next'), '--version'], {
    cwd: simpleRuntimeDir,
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NEXT_TELEMETRY_DISABLED: '1' },
  });
  if (!nextOutput.includes(simpleNextVersion)) {
    throw new Error(`[package-smoke] Bundled Next.js failed to start: ${nextOutput.trim()}`);
  }
  const smokeScriptPath = path.join(resourcesRoot, '__package-smoke-project-runtime.cjs');

  writeFileSync(smokeScriptPath, `
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const manifestPath = require.resolve('pnpm');
const manifest = require(manifestPath);
const cliPath = path.resolve(path.dirname(manifestPath), manifest.bin.pnpm);
const result = spawnSync(process.execPath, [cliPath, '--version'], {
  encoding: 'utf8',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', npm_config_manage_package_manager_versions: 'false' },
});
if (result.status !== 0) {
  throw new Error(result.stderr || result.stdout || 'bundled pnpm failed');
}
if (result.stdout.trim() !== '10.34.5') {
  throw new Error('expected bundled pnpm 10.34.5, received ' + result.stdout.trim());
}
process.stdout.write(${JSON.stringify(`${PACKAGE_SMOKE_PROJECT_RUNTIME_SENTINEL}\n`)});
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
    if (!output.includes(PACKAGE_SMOKE_PROJECT_RUNTIME_SENTINEL)) {
      throw new Error(`[package-smoke] Bundled project runtime smoke did not report success. Output: ${output.trim()}`);
    }
    console.log(output.trim());
  } finally {
    rmSync(smokeScriptPath, { force: true });
  }
}

async function runBundledNextOfflineSmoke() {
  const resourcesRoot = findBundledResourcesRoot();
  const appBinary = resolvePackagedAppBinary(resourcesRoot);
  const runtime = path.join(resourcesRoot, 'simple-interface-runtime');
  const project = mkdtempSync(path.join(tmpdir(), 'interpreter-packaged-next-'));
  const port = 45000 + Math.floor(Math.random() * 10000);
  let child;
  try {
    cpSync(path.join(runtime, 'node_modules'), path.join(project, 'node_modules'), {
      recursive: true,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
    });
    mkdirSync(path.join(project, 'app'), { recursive: true });
    const { dependencies } = JSON.parse(readFileSync(path.join(ROOT, 'resources', 'simple-interface-runtime', 'package.json'), 'utf8'));
    writeFileSync(path.join(project, 'package.json'), JSON.stringify({ private: true, dependencies }));
    writeFileSync(path.join(project, 'app', 'layout.jsx'), 'export default function Layout({ children }) { return <html><body>{children}</body></html> }\n');
    writeFileSync(path.join(project, 'app', 'page.jsx'), 'export default function Page() { return <main>packaged-offline-next-ready</main> }\n');
    child = spawn(appBinary, [path.join(project, 'node_modules', 'next', 'dist', 'bin', 'next'), 'dev', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: project,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        NEXT_TELEMETRY_DISABLED: '1',
        npm_config_offline: 'true',
        npm_config_registry: 'http://127.0.0.1:1',
      },
    });
    let logs = '';
    child.stdout.on('data', (chunk) => { logs = (logs + chunk).slice(-3000); });
    child.stderr.on('data', (chunk) => { logs = (logs + chunk).slice(-3000); });
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      try {
        const response = await fetch(`http://127.0.0.1:${port}`);
        if (response.ok && (await response.text()).includes('packaged-offline-next-ready')) {
          console.log('[package-smoke] packaged Next.js cold offline startup ok');
          return;
        }
      } catch { /* still compiling */ }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error(`[package-smoke] Packaged Next.js did not serve the offline project. ${logs}`);
  } finally {
    if (child?.pid) {
      if (process.platform === 'win32') {
        try { execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f']); } catch { /* already exited */ }
      } else {
        try { child.kill('SIGTERM'); } catch { /* already exited */ }
      }
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise((resolve) => {
          const timeout = setTimeout(() => { child.kill('SIGKILL'); }, 5000);
          child.once('exit', () => { clearTimeout(timeout); resolve(); });
        });
      }
    }
    rmSync(project, { recursive: true, force: true });
  }
}

async function main() {
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
  runBundledProjectRuntimeSmoke();
  await runBundledNextOfflineSmoke();
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
