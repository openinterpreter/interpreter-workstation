#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const __dirname = path.dirname(SCRIPT_PATH);
const ROOT = path.join(__dirname, '..');
const TARGET_DIR = path.join(ROOT, 'resources', 'browser-extension-relay');
const STAGING_DIR = path.join(ROOT, '.tmp-browser-extension-relay');
const LEGACY_FILTER_STAGING_DIR = path.join(ROOT, 'apps', '.tmp-browser-extension-relay');
const TARGET_GENERATED_MARKER = path.join(TARGET_DIR, 'GENERATED-DO-NOT-EDIT.txt');
const TARGET_RUNTIME_MANIFEST = path.join(TARGET_DIR, 'runtime-manifest.json');
const PNPM_BIN = process.platform === 'win32' ? 'pnpm' : 'pnpm';
const RELAY_NODE_MODULES_DIR = path.join('node_modules');
const RELAY_REQUIRED_PATHS = [
  ['dist', 'start-relay-server.js'],
  ['dist', 'extension', 'manifest.json'],
  [RELAY_NODE_MODULES_DIR, 'hono', 'package.json'],
];
const NESTED_PLAYWRITER_RUNTIME_DIR = path.join(
  RELAY_NODE_MODULES_DIR,
  'mcp-extension',
  'node_modules',
  'playwriter',
);
const PROMOTED_PLAYWRITER_ROOT_ENTRIES = ['dist', 'package.json', 'bin.js'];
const DISALLOWED_SOURCE_DIR = path.join('src');
const RELAY_PRUNABLE_DIST_PATTERNS = [
  /\.test\.js$/u,
  /\.d\.ts$/u,
  /\.js\.map$/u,
];
const RUNTIME_BRANDING_REPLACEMENTS = [
  ['"name": "playwriter"', '"name": "interpreter-browser-relay"'],
  ['"description": ""', '"description": "Interpreter browser control relay runtime"'],
  ['"repository": "https://github.com/remorses/playwriter"', '"repository": "https://github.com/openinterpreter/interpreter-workstation"'],
  ['playwriter-ws-server', 'interpreter-browser-bridge'],
  ['playwriter-serve', 'interpreter-browser-bridge'],
  ['Disconnected: another Playwriter extension connected (this one was idle)', 'Disconnected: another Interpreter browser extension connected (this one was idle)'],
  ['Rejected: another Playwriter extension is actively in use', 'Rejected: another Interpreter browser extension is actively in use'],
  ['Run \'playwriter session new\' first.', 'Reconnect browser control from Interpreter and try again.'],
  ['Always run `playwriter session new` first to get a session ID to use.', 'Reconnect browser control from Interpreter to get a live session first.'],
  ['  playwriter session new --host <host> --direct ws://relay-host:9222/devtools/browser/...', '  Reconnect browser control to an existing remote-debugging browser first.'],
  ['Connect with: playwriter session new --direct', 'Connect with Interpreter browser control direct CDP'],
  ['Use with: playwriter session new [--browser <key>]', 'Use with Interpreter browser control sessions'],
  ['Could not find a supported browser binary. Install Chrome for Testing or Chromium, or pass a binary path to `playwriter browser start`.', 'Could not find a supported browser binary. Install Chrome for Testing or Chromium, or pass an explicit browser binary path.'],
];

function getPnpmMajorVersion() {
  const version = execFileSync(PNPM_BIN, ['--version'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  }).trim();
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);

  if (!Number.isFinite(major)) {
    throw new Error(`Unable to parse pnpm version: ${version}`);
  }

  return major;
}

function runPnpm(args) {
  execFileSync(PNPM_BIN, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}

function removeNamedDirsRecursively(rootDir, dirName) {
  if (!fs.existsSync(rootDir)) {
    return;
  }

  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const entryPath = path.join(rootDir, entry.name);
    if (entry.name === dirName) {
      fs.rmSync(entryPath, { recursive: true, force: true });
      continue;
    }

    removeNamedDirsRecursively(entryPath, dirName);
  }
}

function removeTopLevelSourceDir(rootDir) {
  const sourceDirPath = path.join(rootDir, DISALLOWED_SOURCE_DIR);
  fs.rmSync(sourceDirPath, { recursive: true, force: true });
}

function listSymlinksRecursively(rootDir, symlinks = []) {
  if (!fs.existsSync(rootDir)) {
    return symlinks;
  }

  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isSymbolicLink()) {
      symlinks.push(entryPath);
      continue;
    }
    if (entry.isDirectory()) {
      listSymlinksRecursively(entryPath, symlinks);
    }
  }

  return symlinks;
}

function pruneRelayDistArtifacts(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return;
  }

  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      pruneRelayDistArtifacts(entryPath);
      continue;
    }

    if (RELAY_PRUNABLE_DIST_PATTERNS.some((pattern) => pattern.test(entry.name))) {
      fs.rmSync(entryPath, { force: true });
    }
  }
}

function walkFiles(rootDir, files = []) {
  if (!fs.existsSync(rootDir)) {
    return files;
  }

  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(entryPath, files);
      continue;
    }
    if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

function normalizeArchiveRelativePath(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function computeRelayRuntimeManifest(rootDir) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  if (typeof packageJson.version !== 'string' || packageJson.version.trim().length === 0) {
    throw new Error(`[browser-extension-relay] Missing runtime package version in ${path.join(rootDir, 'package.json')}`);
  }

  const hash = crypto.createHash('sha256');
  let fileCount = 0;
  let totalBytes = 0;
  const filePaths = walkFiles(rootDir)
    .filter((filePath) => path.relative(rootDir, filePath) !== 'runtime-manifest.json')
    .sort((left, right) => normalizeArchiveRelativePath(path.relative(rootDir, left)).localeCompare(
      normalizeArchiveRelativePath(path.relative(rootDir, right)),
    ));

  for (const filePath of filePaths) {
    const relativePath = normalizeArchiveRelativePath(path.relative(rootDir, filePath));
    const fileContents = fs.readFileSync(filePath);
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
    packageVersion: packageJson.version,
    fileCount,
    totalBytes,
    treeSha256: hash.digest('hex'),
  };
}

function applyRuntimeBrandingOverrides(rootDir) {
  const textFilePaths = [
    path.join(rootDir, 'package.json'),
    ...walkFiles(path.join(rootDir, 'dist')),
  ].filter((entryPath) => {
    if (!fs.existsSync(entryPath)) {
      return false;
    }
    return ['.js', '.json', '.md', '.txt', '.html'].includes(path.extname(entryPath));
  });

  for (const filePath of textFilePaths) {
    const originalText = fs.readFileSync(filePath, 'utf8');
    let nextText = originalText;
    for (const [fromText, toText] of RUNTIME_BRANDING_REPLACEMENTS) {
      nextText = nextText.split(fromText).join(toText);
    }
    if (nextText !== originalText) {
      fs.writeFileSync(filePath, nextText, 'utf8');
    }
  }
}

function findUnexpectedNodeModulesSymlinks(symlinkPaths) {
  return symlinkPaths.filter((symlinkPath) => !symlinkPath.split(path.sep).includes('.bin'));
}

function assertRelayRuntimeLayout(rootDir) {
  for (const relativePathSegments of RELAY_REQUIRED_PATHS) {
    const requiredPath = path.join(rootDir, ...relativePathSegments);
    if (!fs.existsSync(requiredPath)) {
      const label = relativePathSegments.join('/');
      throw new Error(`Missing staged relay runtime file (${label}): ${requiredPath}`);
    }
  }

  const sourceDirPath = path.join(rootDir, DISALLOWED_SOURCE_DIR);
  if (fs.existsSync(sourceDirPath)) {
    throw new Error(
      `[browser-extension-relay] Generated runtime must not include src/. Edit apps/interpreter-extension instead.`,
    );
  }
}

function normalizeNestedPlaywriterRuntimeLayout(rootDir) {
  const rootRuntimeEntry = path.join(rootDir, 'dist', 'start-relay-server.js');
  if (fs.existsSync(rootRuntimeEntry)) {
    return false;
  }

  const nestedRuntimeRoot = path.join(rootDir, NESTED_PLAYWRITER_RUNTIME_DIR);
  const nestedRuntimeEntry = path.join(nestedRuntimeRoot, 'dist', 'start-relay-server.js');
  if (!fs.existsSync(nestedRuntimeEntry)) {
    return false;
  }

  for (const relativeEntry of PROMOTED_PLAYWRITER_ROOT_ENTRIES) {
    const sourcePath = path.join(nestedRuntimeRoot, relativeEntry);
    const targetPath = path.join(rootDir, relativeEntry);
    if (!fs.existsSync(sourcePath) || fs.existsSync(targetPath)) {
      continue;
    }

    const stats = fs.statSync(sourcePath);
    if (stats.isDirectory()) {
      fs.cpSync(sourcePath, targetPath, { recursive: true, force: true });
    } else {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }

  return true;
}

function assertNodeModulesLayout(rootDir) {
  const symlinkPaths = listSymlinksRecursively(rootDir);
  const unexpectedSymlinkPaths = findUnexpectedNodeModulesSymlinks(symlinkPaths);
  if (unexpectedSymlinkPaths.length === 0) {
    return;
  }

  const preview = unexpectedSymlinkPaths.slice(0, 5).join(', ');
  throw new Error(
    `[browser-extension-relay] Runtime node_modules must not include non-.bin symlinks. Found ${unexpectedSymlinkPaths.length}: ${preview}`,
  );
}

function getDeployArgs() {
  const deployArgs = [
    '--dir',
    'apps/interpreter-extension',
    '--filter',
    'playwriter',
    'deploy',
  ];

  // pnpm 10+ requires legacy deploy mode for non-injected workspaces, while
  // pnpm 9 rejects the flag entirely.
  if (getPnpmMajorVersion() >= 10) {
    deployArgs.push('--legacy');
  }

  deployArgs.push(
    '--prod',
    '--config.node-linker=hoisted',
    STAGING_DIR,
  );

  return deployArgs;
}

function main() {
  fs.rmSync(STAGING_DIR, { recursive: true, force: true });
  // Clean the stale path produced by older filtered deploy runs before we rebuild.
  fs.rmSync(LEGACY_FILTER_STAGING_DIR, { recursive: true, force: true });
  fs.rmSync(TARGET_DIR, { recursive: true, force: true });
  fs.rmSync(path.join(ROOT, 'resources', 'browser-extension-relay.zip'), { force: true });

  runPnpm(['run', 'extension:build']);
  runPnpm(getDeployArgs());
  removeTopLevelSourceDir(STAGING_DIR);
  normalizeNestedPlaywriterRuntimeLayout(STAGING_DIR);

  assertRelayRuntimeLayout(STAGING_DIR);
  assertNodeModulesLayout(path.join(STAGING_DIR, RELAY_NODE_MODULES_DIR));

  fs.cpSync(STAGING_DIR, TARGET_DIR, {
    recursive: true,
    force: true,
  });
  fs.rmSync(STAGING_DIR, { recursive: true, force: true });

  // NOTE(victor): Keep markdown assets referenced by bundled playwriter entrypoints, but strip validated dev-only files.
  pruneRelayDistArtifacts(path.join(TARGET_DIR, 'dist'));
  removeTopLevelSourceDir(TARGET_DIR);
  removeNamedDirsRecursively(path.join(TARGET_DIR, RELAY_NODE_MODULES_DIR), '.bin');
  applyRuntimeBrandingOverrides(TARGET_DIR);

  fs.writeFileSync(
    TARGET_GENERATED_MARKER,
    [
      'Generated runtime payload for browser control.',
      '',
      'Do not edit files in this directory.',
      'The app intentionally uses this staged deploy in development and in packaged builds.',
      'Source of truth:',
      '  - apps/interpreter-extension/extension',
      '  - apps/interpreter-extension/playwriter',
      '',
      'Rebuild with:',
      '  pnpm run build:browser-extension-relay-runtime',
      '  pnpm run ensure:browser-extension-relay-assets',
      '',
      'This directory is gitignored on purpose.',
      '',
    ].join('\n'),
    'utf8',
  );

  fs.writeFileSync(
    TARGET_RUNTIME_MANIFEST,
    JSON.stringify(computeRelayRuntimeManifest(TARGET_DIR), null, 2) + '\n',
    'utf8',
  );

  console.log(`\n[browser-extension-relay] Installed runtime payload at ${TARGET_DIR}`);
}

export {
  assertNodeModulesLayout,
  assertRelayRuntimeLayout,
  findUnexpectedNodeModulesSymlinks,
  getDeployArgs,
  main,
  normalizeNestedPlaywriterRuntimeLayout,
  pruneRelayDistArtifacts,
  removeNamedDirsRecursively,
};

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  await main();
}
