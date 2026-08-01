import * as esbuild from 'esbuild';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Clean dist-electron
if (fs.existsSync('dist-electron')) {
  fs.rmSync('dist-electron', { recursive: true });
}

const INTERPRETER_OVERLAY_HELPER_OUTPUT_DIR = path.join('dist-electron', 'interpreter-overlay');
const CUA_DRIVER_OUTPUT_DIR = path.join('dist-electron', 'cua-driver');
const FINDER_SYNC_OUTPUT_DIR = path.join('dist-electron', 'finder-sync', 'InterpreterFinderSync.appex');
const NATIVE_BUILD_CACHE_ROOT = path.join('.cache', 'native-builds');
const CUA_DRIVER_CACHE_ROOT = path.join('.cache', 'trycua-cua-driver');

function listFilesRecursive(rootDir, { skipDirectoryNames = new Set() } = {}) {
  const files = [];
  const entries = fs.readdirSync(rootDir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (!skipDirectoryNames.has(entry.name)) {
        files.push(...listFilesRecursive(entryPath, { skipDirectoryNames }));
      }
      continue;
    }
    if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

function updateHashWithFile(hash, filePath) {
  hash.update(path.relative('.', filePath));
  hash.update('\0');
  hash.update(fs.readFileSync(filePath));
  hash.update('\0');
}

function commandOutput(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    ...options,
  }).trim();
}

function getInputHash({ label, metadata, files }) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify({
    label,
    platform: process.platform,
    arch: process.arch,
    ...metadata,
  }));
  hash.update('\0');

  for (const filePath of files) {
    updateHashWithFile(hash, filePath);
  }

  return hash.digest('hex');
}

function copyExecutable(sourcePath, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.copyFileSync(sourcePath, outputPath);
  fs.chmodSync(outputPath, 0o755);
}

function restoreCachedExecutable({ cacheRoot, inputHash, outputPath, label }) {
  const cachedBinaryPath = path.join(cacheRoot, inputHash, path.basename(outputPath));
  if (!fs.existsSync(cachedBinaryPath)) {
    return false;
  }

  copyExecutable(cachedBinaryPath, outputPath);
  console.log(`[build] Reused cached ${label} ${inputHash.slice(0, 12)}`);
  return true;
}

function writeCachedExecutable({ cacheRoot, inputHash, outputPath, label }) {
  const cacheDir = path.join(cacheRoot, inputHash);
  const cachedBinaryPath = path.join(cacheDir, path.basename(outputPath));
  const cacheMetadataPath = path.join(cacheDir, 'build-info.json');

  fs.mkdirSync(cacheDir, { recursive: true });
  copyExecutable(outputPath, cachedBinaryPath);
  fs.writeFileSync(
    cacheMetadataPath,
    `${JSON.stringify({
      inputHash,
      builtAt: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      label,
    }, null, 2)}\n`,
  );
  console.log(`[build] Cached ${label} ${inputHash.slice(0, 12)}`);
}

function buildSwiftHelper(sourcePath, outputPath) {
  if (process.platform !== 'darwin') {
    return;
  }

  const label = `swift-helper:${path.basename(outputPath)}`;
  const inputHash = getInputHash({
    label,
    metadata: {
      swiftcVersion: commandOutput('swiftc', ['--version']),
      sourcePath,
      outputPath,
      args: ['-O', sourcePath, '-o', outputPath],
    },
    files: [sourcePath],
  });

  if (restoreCachedExecutable({
    cacheRoot: path.join(NATIVE_BUILD_CACHE_ROOT, 'swift-helper'),
    inputHash,
    outputPath,
    label,
  })) {
    return;
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  // Always compile on macOS so the helper architecture matches the build host
  // (x64 vs arm64) and the binary is guaranteed to match current Swift sources.
  execFileSync('swiftc', ['-O', sourcePath, '-o', outputPath], { stdio: 'inherit' });
  writeCachedExecutable({
    cacheRoot: path.join(NATIVE_BUILD_CACHE_ROOT, 'swift-helper'),
    inputHash,
    outputPath,
    label,
  });
}

const swiftHelpers = [
  {
    sourcePath: path.join(
      'apps',
      'interpreter-overlay',
      'runtime',
      'infra',
      'ax-set-focused-text',
      'ax-set-focused-text.swift',
    ),
    outputName: 'ax-set-focused-text',
  },
  {
    sourcePath: path.join(
      'apps',
      'interpreter-overlay',
      'runtime',
      'infra',
      'keyboard-monitor',
      'keyboard-monitor.swift',
    ),
    outputName: 'keyboard-monitor',
  },
  {
    sourcePath: path.join(
      'apps',
      'interpreter-overlay',
      'runtime',
      'infra',
      'progressive-blur',
      'progressive-blur.swift',
    ),
    outputName: 'progressive-blur',
  },
  {
    sourcePath: path.join(
      'apps',
      'interpreter-overlay',
      'runtime',
      'infra',
      'accessibility-parser',
      'main.swift',
    ),
    outputName: 'accessibility-tree',
  },
  {
    sourcePath: path.join(
      'apps',
      'interpreter-overlay',
      'runtime',
      'infra',
      'file-drag-context',
      'file-drag-context.swift',
    ),
    outputName: 'file-drag-context',
  },
  {
    sourcePath: path.join(
      'apps',
      'interpreter-overlay',
      'runtime',
      'infra',
      'selected-file-context',
      'selected-file-context.swift',
    ),
    outputName: 'selected-file-context',
  },
  {
    sourcePath: path.join(
      'apps',
      'interpreter-overlay',
      'runtime',
      'infra',
      'focus-window',
      'focus-window.swift',
    ),
    outputName: 'focus-window',
  },
  {
    sourcePath: path.join(
      'apps',
      'interpreter-overlay',
      'runtime',
      'infra',
      'verified-point',
      'verified-point.swift',
    ),
    outputName: 'verified-point',
  },
  {
    sourcePath: path.join(
      'apps',
      'interpreter-overlay',
      'runtime',
      'infra',
      'speech-recognizer',
      'speech-recognizer.swift',
    ),
    outputName: 'speech-recognizer',
  },
  {
    sourcePath: path.join(
      'apps',
      'interpreter-overlay',
      'runtime',
      'infra',
      'window-tracker',
      'window-tracker.swift',
    ),
    outputName: 'window-tracker',
  },
];

for (const helper of swiftHelpers) {
  buildSwiftHelper(
    helper.sourcePath,
    path.join(INTERPRETER_OVERLAY_HELPER_OUTPUT_DIR, helper.outputName),
  );
}

// Copy the prebuilt window-pin native addon into dist-electron so the bundled
// main process can require it via a known absolute path without depending on
// node_modules layout in deployed/staged environments. Runs on macOS and
// Windows (the only two platforms the addon supports today).
function copyWindowPinAddon() {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return;
  const candidates = [
    path.join('node_modules', 'interpreter-window-pin', 'build', 'Release', 'window_pin.node'),
    path.join(
      'node_modules',
      '.pnpm',
      'interpreter-window-pin@file+apps+interpreter-overlay+native+window-pin',
      'node_modules',
      'interpreter-window-pin',
      'build',
      'Release',
      'window_pin.node',
    ),
  ];
  const source = candidates.find((p) => fs.existsSync(p));
  if (!source) {
    throw new Error('[build] window-pin .node not found. Run `pnpm install` to build interpreter-window-pin before bundling.');
  }
  const outDir = path.join(INTERPRETER_OVERLAY_HELPER_OUTPUT_DIR, 'native');
  const outPath = path.join(outDir, 'window_pin.node');
  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(source, outPath);
  console.log('[build] Copied window_pin.node from', source);
}
copyWindowPinAddon();

function buildFinderSyncExtension() {
  if (process.platform !== 'darwin') {
    return;
  }

  const sourcePath = path.join('native', 'finder-sync', 'FinderSync.swift');
  const plistPath = path.join('native', 'finder-sync', 'Info.plist');
  const contentsDir = path.join(FINDER_SYNC_OUTPUT_DIR, 'Contents');
  const macosDir = path.join(contentsDir, 'MacOS');
  const outputPath = path.join(macosDir, 'InterpreterFinderSync');
  const label = 'finder-sync';
  const compileArgs = [
    '-O',
    '-emit-library',
    '-module-name',
    'InterpreterFinderSync',
    '-framework',
    'Cocoa',
    '-framework',
    'FinderSync',
    sourcePath,
    '-o',
    outputPath,
  ];
  const inputHash = getInputHash({
    label,
    metadata: {
      swiftcVersion: commandOutput('swiftc', ['--version']),
      outputPath,
      args: compileArgs,
    },
    files: [sourcePath, plistPath],
  });

  fs.mkdirSync(macosDir, { recursive: true });
  fs.copyFileSync(plistPath, path.join(contentsDir, 'Info.plist'));
  if (restoreCachedExecutable({
    cacheRoot: path.join(NATIVE_BUILD_CACHE_ROOT, 'finder-sync'),
    inputHash,
    outputPath,
    label,
  })) {
    return;
  }

  execFileSync('swiftc', compileArgs, { stdio: 'inherit' });
  writeCachedExecutable({
    cacheRoot: path.join(NATIVE_BUILD_CACHE_ROOT, 'finder-sync'),
    inputHash,
    outputPath,
    label,
  });
}

buildFinderSyncExtension();

function getTrycuaCuaDriverInputHash(submodulePath) {
  const hash = createHash('sha256');
  const packagePath = path.join(submodulePath, 'libs', 'cua-driver', 'rust');
  const rustVersion = commandOutput('rustc', ['--version']);
  const submoduleHead = commandOutput('git', ['rev-parse', 'HEAD'], {
    cwd: submodulePath,
  });

  hash.update(JSON.stringify({
    platform: process.platform,
    arch: process.arch,
    rustVersion,
    submoduleHead,
  }));
  hash.update('\0');

  for (const filePath of [
    path.join(packagePath, 'Cargo.toml'),
    path.join(packagePath, 'Cargo.lock'),
  ]) {
    updateHashWithFile(hash, filePath);
  }

  for (const filePath of listFilesRecursive(path.join(packagePath, 'crates'), {
    skipDirectoryNames: new Set(['target']),
  })) {
    updateHashWithFile(hash, filePath);
  }

  return hash.digest('hex');
}

function buildCuaDriverBinary() {
  if (process.platform !== 'darwin') {
    return;
  }

  const prebuiltDriverPath = process.env.INTERPRETER_CUA_DRIVER_PREBUILT_PATH?.trim();
  if (prebuiltDriverPath) {
    if (!fs.existsSync(prebuiltDriverPath)) {
      throw new Error(`[build] Missing prebuilt cua-driver: ${prebuiltDriverPath}`);
    }
    fs.mkdirSync(CUA_DRIVER_OUTPUT_DIR, { recursive: true });
    const outputPath = path.join(CUA_DRIVER_OUTPUT_DIR, 'cua-driver');
    fs.copyFileSync(prebuiltDriverPath, outputPath);
    fs.chmodSync(outputPath, 0o755);
    console.log(`[build] Reused prebuilt cua-driver ${prebuiltDriverPath}`);
    return;
  }

  const submodulePath = path.join('submodules', 'interpreter-cua');
  const packageManifestPath = path.join(submodulePath, 'libs', 'cua-driver', 'rust', 'Cargo.toml');
  if (!fs.existsSync(packageManifestPath)) {
    throw new Error(`[build] Missing trycua/cua submodule package: ${packageManifestPath}`);
  }

  fs.mkdirSync(CUA_DRIVER_OUTPUT_DIR, { recursive: true });
  const outputPath = path.join(CUA_DRIVER_OUTPUT_DIR, 'cua-driver');
  const inputHash = getTrycuaCuaDriverInputHash(submodulePath);
  const cacheDir = path.join(CUA_DRIVER_CACHE_ROOT, inputHash);
  const cachedBinaryPath = path.join(cacheDir, 'cua-driver');
  const cacheMetadataPath = path.join(cacheDir, 'build-info.json');

  if (fs.existsSync(cachedBinaryPath)) {
    fs.copyFileSync(cachedBinaryPath, outputPath);
    fs.chmodSync(outputPath, 0o755);
    console.log(`[build] Reused cached cua-driver ${inputHash.slice(0, 12)}`);
    return;
  }

  const packagePath = path.join(submodulePath, 'libs', 'cua-driver', 'rust');
  execFileSync('cargo', ['build', '--release', '-p', 'cua-driver'], {
    cwd: packagePath,
    stdio: 'inherit',
  });
  const builtBinary = path.join(packagePath, 'target', 'release', 'cua-driver');
  if (!fs.existsSync(builtBinary)) {
    throw new Error(`[build] Rust package did not produce cua-driver at ${builtBinary}`);
  }
  fs.copyFileSync(builtBinary, outputPath);

  fs.chmodSync(outputPath, 0o755);
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.copyFileSync(outputPath, cachedBinaryPath);
  fs.chmodSync(cachedBinaryPath, 0o755);
  fs.writeFileSync(
    cacheMetadataPath,
    `${JSON.stringify({
      inputHash,
      builtAt: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
    }, null, 2)}\n`,
  );
  console.log(`[build] Cached cua-driver ${inputHash.slice(0, 12)}`);
}

buildCuaDriverBinary();

// Build main process
await esbuild.build({
  entryPoints: ['electron/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist-electron/electron/main.cjs',
  external: [
    'electron',
    'electron-updater',
    'fsevents',
    '@vscode/ripgrep',
    'canvas',
    '@napi-rs/canvas',
    'pdfjs-dist',
    'unpdf',
    'mammoth',
    'jszip',
    'xml-formatter',
    '@resvg/resvg-js',
    // sharp ships platform-specific native addons loaded dynamically.
    'sharp',
    // trash uses import.meta.url to locate binary, must not be bundled
    'trash',
    // Native file watcher module
    '@parcel/watcher',
    // node-pty is a native module with .node binaries - must not be bundled
    'node-pty',
    'uiohook-napi',
    // In-process macOS NSWindow.orderWindow:relativeTo: addon for the world overlay.
    'interpreter-window-pin',
    '@nut-tree-fork/nut-js',
    // heic-convert uses WASM (libheif-js) for HEIC decoding - must not be bundled
    'heic-convert',
    // sherpa-onnx ships a runtime WASM payload loaded via __dirname
    'sherpa-onnx',
    // onnxruntime-node has native .node binaries - must not be bundled
    'onnxruntime-node',
    // Movie editor preview/export runtime dependencies must stay external.
    'esbuild',
    'react',
    'react-dom',
    'react/jsx-runtime',
    'react/jsx-dev-runtime',
    'remotion',
    '@remotion/bundler',
    '@remotion/renderer',
  ],
  sourcemap: true,
  target: 'node18',
  define: {
    // Only client ID is needed - PKCE flow doesn't require API key
    'process.env.NYLAS_CLIENT_ID': '"e78ec813-8f5b-455a-92cf-a19c76fa6f45"',
  },
});

// Build preload script
await esbuild.build({
  entryPoints: ['electron/preload.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist-electron/electron/preload.cjs',
  external: ['electron'],
  sourcemap: true,
  target: 'node18',
});

await esbuild.build({
  entryPoints: ['apps/interpreter-overlay/renderer/preload.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist-electron/apps/interpreter-overlay/renderer/preload.cjs',
  external: ['electron'],
  sourcemap: true,
  target: 'node18',
});

console.log('[build] Electron build complete');

// NOTE: Sentry source map upload happens in CI after version is set
// See .github/workflows/internal-release.yml and prod-release.yml
