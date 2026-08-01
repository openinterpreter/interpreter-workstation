#!/usr/bin/env node

import crypto from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const __dirname = path.dirname(SCRIPT_PATH);
const ROOT = path.join(__dirname, '..');
const SUBMODULE_ROOT = path.join(ROOT, 'apps', 'interpreter-extension');
const TARGET_DIR = path.join(ROOT, 'resources', 'browser-extension-relay');
const TARGET_PACKAGE_JSON = path.join(TARGET_DIR, 'package.json');
const TARGET_RUNTIME_MANIFEST = path.join(TARGET_DIR, 'runtime-manifest.json');
const TARGET_SOURCE_STATE = path.join(TARGET_DIR, 'source-state.json');
const TARGET_RELAY_ENTRY = path.join(TARGET_DIR, 'dist', 'start-relay-server.js');
const TARGET_EXTENSION_MANIFEST = path.join(TARGET_DIR, 'dist', 'extension', 'manifest.json');
const TARGET_GENERATED_MARKER = path.join(TARGET_DIR, 'GENERATED-DO-NOT-EDIT.txt');
const PLAYWRITER_SOURCE_PACKAGE_JSON = path.join(SUBMODULE_ROOT, 'playwriter', 'package.json');
const EXTENSION_SOURCE_MANIFEST = path.join(SUBMODULE_ROOT, 'extension', 'manifest.json');
const CURRENT_PRODUCTION_EXTENSION_ID = 'bboaaphdpllilofamfpommlbafpellnb';
const LEGACY_PRODUCTION_EXTENSION_IDS = [
  'jfeammnjpkecdekppnclgkkffahnhfhe',
];
const SOURCE_WATCH_PATHS = [
  path.join(ROOT, 'resources', 'icons', 'app.png'),
  path.join(ROOT, 'scripts', 'build-browser-extension-relay-runtime.mjs'),
  path.join(ROOT, 'scripts', 'build-browser-extension-brand-assets.mjs'),
  path.join(ROOT, 'scripts', 'ensure-browser-extension-relay-assets.mjs'),
  path.join(SUBMODULE_ROOT, 'pnpm-lock.yaml'),
  path.join(SUBMODULE_ROOT, 'pnpm-workspace.yaml'),
  path.join(SUBMODULE_ROOT, 'package.json'),
  path.join(SUBMODULE_ROOT, 'playwriter', 'src'),
  path.join(SUBMODULE_ROOT, 'playwriter', 'scripts'),
  path.join(SUBMODULE_ROOT, 'playwriter', 'package.json'),
  path.join(SUBMODULE_ROOT, 'extension', 'src'),
  path.join(SUBMODULE_ROOT, 'extension', 'scripts'),
  path.join(SUBMODULE_ROOT, 'extension', 'icons'),
  path.join(SUBMODULE_ROOT, 'extension', 'package.json'),
];
const BOOTSTRAP_SENTINELS = [
  path.join(SUBMODULE_ROOT, 'package.json'),
  path.join(SUBMODULE_ROOT, 'node_modules'),
  path.join(SUBMODULE_ROOT, 'node_modules', '.modules.yaml'),
  path.join(SUBMODULE_ROOT, 'playwriter', 'node_modules'),
  path.join(SUBMODULE_ROOT, 'playwriter', 'node_modules', '@mizchi', 'selector-generator', 'package.json'),
  path.join(SUBMODULE_ROOT, 'extension', 'node_modules'),
  path.join(SUBMODULE_ROOT, 'playwright', 'packages', 'playwright-core', 'index.js'),
];
const PNPM_BIN = process.platform === 'win32' ? 'pnpm' : 'pnpm';
const PLAYWRIGHT_INJECTED_GENERATOR = path.join(SUBMODULE_ROOT, 'playwright', 'utils', 'generate_injected.js');
const PLAYWRIGHT_CORE_BUILD = path.join(SUBMODULE_ROOT, 'playwright', 'packages', 'playwright-core', 'build.mjs');

function runPnpm(args) {
  execFileSync(PNPM_BIN, args, {
    cwd: ROOT,
    env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}

function runNode(scriptPath, cwd = ROOT) {
  execFileSync(process.execPath, [scriptPath], {
    cwd,
    stdio: 'inherit',
  });
}

function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) {
    return null;
  }

  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function normalizeHashPath(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function listSourceStateFiles(targetPath, files = []) {
  if (!existsSync(targetPath)) {
    return files;
  }

  const targetStat = statSync(targetPath);
  if (targetStat.isFile()) {
    files.push(targetPath);
    return files;
  }

  const entries = readdirSync(targetPath, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
      continue;
    }

    const entryPath = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      listSourceStateFiles(entryPath, files);
      continue;
    }

    if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

function computeSourceState() {
  const hash = crypto.createHash('sha256');
  let fileCount = 0;
  let totalBytes = 0;
  const filePaths = SOURCE_WATCH_PATHS
    .flatMap((candidate) => listSourceStateFiles(candidate))
    .sort((left, right) => normalizeHashPath(path.relative(ROOT, left)).localeCompare(
      normalizeHashPath(path.relative(ROOT, right)),
    ));

  for (const filePath of filePaths) {
    const relativePath = normalizeHashPath(path.relative(ROOT, filePath));
    const fileContents = readFileSync(filePath);
    hash.update('F\0');
    hash.update(relativePath);
    hash.update('\0');
    hash.update(String(fileContents.byteLength));
    hash.update('\0');
    hash.update(fileContents);
    fileCount += 1;
    totalBytes += fileContents.byteLength;
  }

  return {
    schemaVersion: 1,
    fileCount,
    totalBytes,
    sourceSha256: hash.digest('hex'),
  };
}

function getBundledRelayRuntimeValidationIssues(options = {}) {
  const targetDir = options.targetDir || TARGET_DIR;
  const sourceExtensionManifestPath = options.sourceExtensionManifestPath;
  const issues = [];
  const requiredPaths = [
    path.join(targetDir, 'package.json'),
    path.join(targetDir, 'runtime-manifest.json'),
    path.join(targetDir, 'dist', 'start-relay-server.js'),
    path.join(targetDir, 'dist', 'extension', 'manifest.json'),
    path.join(targetDir, 'GENERATED-DO-NOT-EDIT.txt'),
    path.join(targetDir, 'node_modules', '.modules.yaml'),
    path.join(targetDir, 'node_modules', 'hono'),
  ];

  for (const candidate of requiredPaths) {
    if (!existsSync(candidate)) {
      issues.push(`Missing bundled relay runtime path: ${candidate}`);
    }
  }

  if (existsSync(path.join(targetDir, 'src'))) {
    issues.push(`Bundled relay runtime must not include src/: ${path.join(targetDir, 'src')}`);
  }

  for (const candidate of [
    path.join(targetDir, 'dist', 'utils.js'),
    path.join(targetDir, 'dist', 'extension', 'background.js'),
  ]) {
    if (!existsSync(candidate)) {
      continue;
    }

    const contents = readFileSync(candidate, 'utf8');
    if (LEGACY_PRODUCTION_EXTENSION_IDS.some((extensionId) => contents.includes(extensionId))) {
      issues.push(`Bundled relay runtime still references legacy production extension ids in ${candidate}`);
    }
    if (!contents.includes(CURRENT_PRODUCTION_EXTENSION_ID)) {
      issues.push(`Bundled relay runtime is missing the current production extension id in ${candidate}`);
    }
  }

  if (sourceExtensionManifestPath && existsSync(sourceExtensionManifestPath) && existsSync(path.join(targetDir, 'dist', 'extension', 'manifest.json'))) {
    const bundledManifest = readJsonIfExists(path.join(targetDir, 'dist', 'extension', 'manifest.json'));
    const sourceManifest = readJsonIfExists(sourceExtensionManifestPath);
    const bundledVersion = typeof bundledManifest?.version === 'string' ? bundledManifest.version : null;
    const sourceVersion = typeof sourceManifest?.version === 'string' ? sourceManifest.version : null;

    if (bundledVersion && sourceVersion && bundledVersion !== sourceVersion) {
      issues.push(`Bundled extension manifest version ${bundledVersion} does not match source version ${sourceVersion}`);
    }
  }

  return issues;
}

function hasGitRepoMetadata() {
  return existsSync(path.join(ROOT, '.git'));
}

function bootstrapRelaySourceWorkspace() {
  if (hasGitRepoMetadata()) {
    runPnpm(['run', 'extension:bootstrap']);
    return;
  }

  runPnpm(['--dir', 'apps/interpreter-extension', 'install', '--frozen-lockfile', '--prod=false']);
  runNode(PLAYWRIGHT_INJECTED_GENERATOR, SUBMODULE_ROOT);
  runNode(PLAYWRIGHT_CORE_BUILD, SUBMODULE_ROOT);
}

function hasUsableBundledRelayRuntime() {
  const sourceExtensionManifestPath = hasRelaySourceWorkspace() ? EXTENSION_SOURCE_MANIFEST : undefined;
  return getBundledRelayRuntimeValidationIssues({
    targetDir: TARGET_DIR,
    sourceExtensionManifestPath,
  }).length === 0;
}

function hasRelaySourceWorkspace() {
  return existsSync(PLAYWRITER_SOURCE_PACKAGE_JSON);
}

function needsBootstrap() {
  return BOOTSTRAP_SENTINELS.some((candidate) => !existsSync(candidate));
}

function needsRelayRuntimeRebuild() {
  const validationIssues = getBundledRelayRuntimeValidationIssues({
    targetDir: TARGET_DIR,
    sourceExtensionManifestPath: EXTENSION_SOURCE_MANIFEST,
  });
  if (validationIssues.length > 0) {
    return true;
  }

  if (!hasRelaySourceWorkspace()) {
    return false;
  }

  const targetSourceState = readJsonIfExists(TARGET_SOURCE_STATE);
  const currentSourceState = computeSourceState();
  if (targetSourceState?.sourceSha256 !== currentSourceState.sourceSha256) {
    return true;
  }

  return false;
}

function main() {
  const relaySourceWorkspaceAvailable = hasRelaySourceWorkspace();
  const bundledRelayRuntimeReady = hasUsableBundledRelayRuntime();
  const bootstrapRequired = relaySourceWorkspaceAvailable && needsBootstrap();
  const relayRuntimeRequired = bootstrapRequired || needsRelayRuntimeRebuild();

  if (!bootstrapRequired && !relayRuntimeRequired) {
    console.log('[browser-extension-relay] Bundled browser extension relay assets are ready.');
    return;
  }

  if (!relaySourceWorkspaceAvailable && !bundledRelayRuntimeReady) {
    throw new Error(
      [
        '[browser-extension-relay] Missing both source workspace and bundled runtime.',
        `Expected either ${PLAYWRITER_SOURCE_PACKAGE_JSON} or a complete runtime under ${TARGET_DIR}.`,
        ...getBundledRelayRuntimeValidationIssues({ targetDir: TARGET_DIR }).map((issue) => `Validation issue: ${issue}`),
      ].join(' '),
    );
  }

  console.log('[browser-extension-relay] Preparing bundled browser extension relay assets...');

  if (bootstrapRequired) {
    bootstrapRelaySourceWorkspace();
  }

  if (relayRuntimeRequired) {
    runPnpm(['run', 'build:browser-extension-relay-runtime']);
    writeFileSync(TARGET_SOURCE_STATE, `${JSON.stringify(computeSourceState(), null, 2)}\n`, 'utf8');
  }
}

export {
  getBundledRelayRuntimeValidationIssues,
  hasUsableBundledRelayRuntime,
  needsRelayRuntimeRebuild,
};

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main();
}
