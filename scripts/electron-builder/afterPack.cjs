#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const { assertBundledCodexSkills } = require('./checkBundledCodexSkills.cjs');

function copyOptionalFile(source, destination) {
  if (!fs.existsSync(source)) return false;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  return true;
}

function copyDirectory(source, destination) {
  if (!fs.existsSync(source)) {
    throw new Error(`[afterPack] Missing directory to copy: ${source}`);
  }
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true });
}

function copyWindowsRuntimeDlls(targetDir) {
  const dllNames = [
    'vcruntime140.dll',
    'vcruntime140_1.dll',
    'msvcp140.dll',
    'concrt140.dll',
  ];
  for (const dllName of dllNames) {
    const candidates = [
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', dllName),
      path.join('C:\\Python312', dllName),
    ];
    const copied = candidates.some((candidate) => copyOptionalFile(candidate, path.join(targetDir, dllName)));
    if (!copied) {
      throw new Error(`[afterPack] Missing required Windows runtime DLL: ${dllName}`);
    }
  }
}

// Electron marks ffmpeg.dll as a /DELAYLOAD Windows dependency (electron/electron#46151,
// shipping since 34.4.0). It must sit next to the .exe; if a stale dist cache or a botched
// pack drops it, the renderer dies at startup with HandleDelayLoadFailureCommon before any
// JS runs (Sentry #1191 on the 40.9.3 build). electron-builder bundles it from the Electron
// dist by default, so this is a fail-fast guard against a broken Windows artifact, not a copy.
function assertWindowsDelayLoadDlls(appOutDir) {
  const dllName = 'ffmpeg.dll';
  const dllPath = path.join(appOutDir, dllName);
  if (!fs.existsSync(dllPath)) {
    throw new Error(`[afterPack] Missing delay-loaded Windows runtime DLL next to the executable: ${dllPath}`);
  }
}

function getRequiredBundledResourcePaths(resourcesRoot, platform, arch) {
  const isWin = platform === 'win32' || platform === 'windows';
  const binarySuffix = isWin ? '.exe' : '';
  const oixRuntimePaths = [
    path.join(resourcesRoot, 'oix', 'bin', `interpreter${binarySuffix}`),
    path.join(resourcesRoot, 'oix', 'bin', `i${binarySuffix}`),
    path.join(resourcesRoot, 'oix', 'bin', `codex-code-mode-host${binarySuffix}`),
    path.join(resourcesRoot, 'oix', 'codex-package.json'),
    path.join(resourcesRoot, 'oix', 'codex-path', `rg${binarySuffix}`),
  ];
  if (!isWin) {
    oixRuntimePaths.push(
      path.join(resourcesRoot, 'oix', 'codex-resources', 'zsh', 'bin', 'zsh'),
    );
  }
  const jsReplRuntimePaths = [
    path.join(resourcesRoot, 'js-repl-runtime', 'package.json'),
    path.join(resourcesRoot, 'js-repl-runtime', 'node_modules', 'playwright-core', 'package.json'),
    path.join(resourcesRoot, 'js-repl-runtime', 'node_modules', 'interpreter-browser-control', 'package.json'),
    path.join(resourcesRoot, 'js-repl-runtime', 'kernel', 'kernel.cjs'),
    path.join(resourcesRoot, 'js-repl-runtime', 'kernel', 'meriyah.umd.min.cjs'),
  ];
  const relayRuntimePaths = [
    path.join(resourcesRoot, 'browser-extension-relay', 'package.json'),
    path.join(resourcesRoot, 'browser-extension-relay', 'runtime-manifest.json'),
    path.join(resourcesRoot, 'browser-extension-relay', 'dist', 'start-relay-server.js'),
    path.join(resourcesRoot, 'browser-extension-relay', 'dist', 'extension', 'manifest.json'),
    path.join(resourcesRoot, 'browser-extension-relay', 'node_modules', 'hono', 'package.json'),
  ];

  if (platform === 'darwin' || platform === 'mac') {
    return [
      ...oixRuntimePaths,
      path.join(resourcesRoot, 'pdfcpu', 'pdfcpu'),
      ...jsReplRuntimePaths,
      ...relayRuntimePaths,
      path.join(resourcesRoot, 'qwen-asr', `darwin-${arch}`, 'qwen_asr'),
      path.join(resourcesRoot, 'cua-driver', 'cua-driver'),
      path.join(resourcesRoot, 'cua-driver', 'tool-metadata.json'),
      path.join(resourcesRoot, 'cua-driver', 'macos-agent-activity-overlay.jxa'),
      path.join(resourcesRoot, 'interpreter-overlay', 'accessibility-tree'),
      path.join(resourcesRoot, 'interpreter-overlay', 'ax-set-focused-text'),
      path.join(resourcesRoot, 'interpreter-overlay', 'focus-window'),
      path.join(resourcesRoot, 'interpreter-overlay', 'keyboard-monitor'),
      path.join(resourcesRoot, 'interpreter-overlay', 'progressive-blur'),
      path.join(resourcesRoot, 'interpreter-overlay', 'speech-recognizer'),
      path.join(resourcesRoot, 'interpreter-overlay', 'verified-point'),
      path.join(resourcesRoot, 'interpreter-overlay', 'window-tracker'),
      path.join(resourcesRoot, 'interpreter-overlay', 'native', 'window_pin.node'),
    ];
  }

  if (platform === 'linux') {
    return [
      ...oixRuntimePaths,
      path.join(resourcesRoot, 'pdfcpu', 'pdfcpu'),
      ...jsReplRuntimePaths,
      ...relayRuntimePaths,
      path.join(resourcesRoot, 'qwen-asr', `linux-${arch}`, 'qwen_asr'),
    ];
  }

  if (platform === 'win32' || platform === 'windows') {
    return [
      ...oixRuntimePaths,
      path.join(resourcesRoot, 'codex-command-runner.exe'),
      path.join(resourcesRoot, 'pdfcpu', 'pdfcpu.exe'),
      path.join(resourcesRoot, 'codex-windows-sandbox-setup.exe'),
      ...jsReplRuntimePaths,
      ...relayRuntimePaths,
      path.join(resourcesRoot, 'cua-driver', 'windows-uia.ps1'),
      path.join(resourcesRoot, 'interpreter-overlay', 'native', 'window_pin.node'),
    ];
  }

  return [];
}

function assertRequiredBundledResources(resourcesRoot, platform, arch) {
  for (const requiredPath of getRequiredBundledResourcePaths(resourcesRoot, platform, arch)) {
    if (!fs.existsSync(requiredPath)) {
      throw new Error(`[afterPack] Missing required bundled resource: ${requiredPath}`);
    }
  }

  const liveRelayTreePath = path.join(resourcesRoot, 'browser-extension-relay');
  const relayArchivePath = path.join(resourcesRoot, 'browser-extension-relay.zip');
  if (!fs.existsSync(liveRelayTreePath)) {
    throw new Error(`[afterPack] Missing required bundled resource: ${liveRelayTreePath}`);
  }
  if (fs.existsSync(relayArchivePath)) {
    throw new Error(`[afterPack] Packaged app must not include a relay archive: ${relayArchivePath}`);
  }
}

function getMacExtraResourceBinariesForSigning(resourcesRoot) {
  const binaries = [];
  const addIfExists = (binaryPath) => {
    if (fs.existsSync(binaryPath)) {
      binaries.push(binaryPath);
    }
  };

  for (const binary of [
    path.join('oix', 'bin', 'interpreter'),
    path.join('oix', 'bin', 'i'),
    path.join('oix', 'bin', 'codex-code-mode-host'),
    path.join('oix', 'codex-path', 'rg'),
    path.join('oix', 'codex-resources', 'zsh', 'bin', 'zsh'),
  ]) {
    addIfExists(path.join(resourcesRoot, binary));
  }
  addIfExists(path.join(resourcesRoot, 'pdfcpu', 'pdfcpu'));
  addIfExists(path.join(resourcesRoot, 'cua-driver', 'cua-driver'));

  const overlayHelpersDir = path.join(resourcesRoot, 'interpreter-overlay');
  const overlayHelpers = [
    'accessibility-tree',
    'ax-set-focused-text',
    'focus-window',
    'keyboard-monitor',
    'progressive-blur',
    'speech-recognizer',
    'verified-point',
    'window-tracker',
  ];
  for (const helper of overlayHelpers) {
    addIfExists(path.join(overlayHelpersDir, helper));
  }
  addIfExists(path.join(overlayHelpersDir, 'native', 'window_pin.node'));

  return binaries;
}

async function afterPack(context) {
  console.log('[afterPack] Starting post-pack processing...');

  const { appOutDir, packager, arch: _arch } = context;
  const platform = packager.platform.name;
  const isWin = platform === 'win32' || platform === 'windows';
  const isMac = platform === 'darwin' || platform === 'mac';
  const isLinux = platform === 'linux';
  const arch = (_arch === 3 || _arch === 'arm64') ? 'arm64' : 'x64';
  const platformArch = isMac ? `darwin-${arch}` : isWin ? `win32-${arch}` : `linux-${arch}`;

  const appName = packager?.appInfo?.productFilename ?? packager?.appInfo?.name;
  if (!appName) {
    throw new Error('[afterPack] App name not found');
  }

  console.log('[afterPack] Platform:', platform, 'Arch:', arch);
  console.log('[afterPack] Platform-Arch:', platformArch);
  console.log('[afterPack] App name:', appName);
  console.log('[afterPack] Output directory:', appOutDir);

  const resourcesRoot = isMac
    ? path.join(appOutDir, `${appName}.app`, 'Contents', 'Resources')
    : path.join(appOutDir, 'resources');

  console.log('[afterPack] Resources root:', resourcesRoot);

  if (!fs.existsSync(resourcesRoot)) {
    throw new Error(`[afterPack] Resources directory not found: ${resourcesRoot}`);
  }

  assertRequiredBundledResources(resourcesRoot, platform, arch);

  if (isWin) {
    console.log('[afterPack] Copying Windows runtime DLLs for packaged app...');
    copyWindowsRuntimeDlls(appOutDir);
    copyWindowsRuntimeDlls(resourcesRoot);
    assertWindowsDelayLoadDlls(appOutDir);
  }

  assertBundledCodexSkills(path.join(resourcesRoot, 'codex-skills'));

  if (isMac) {
    const appBundleRoot = path.join(appOutDir, `${appName}.app`);
    const sourceFinderSyncExtension = path.join(
      process.cwd(),
      'dist-electron',
      'finder-sync',
      'InterpreterFinderSync.appex',
    );
    const targetFinderSyncExtension = path.join(
      appBundleRoot,
      'Contents',
      'PlugIns',
      'InterpreterFinderSync.appex',
    );
    copyDirectory(sourceFinderSyncExtension, targetFinderSyncExtension);
    console.log('[afterPack] Copied Finder Sync extension:', targetFinderSyncExtension);
  }

  const hasAsar = fs.existsSync(path.join(resourcesRoot, 'app.asar'));
  const appRoot = hasAsar
    ? path.join(resourcesRoot, 'app.asar.unpacked')
    : path.join(resourcesRoot, 'app');

  console.log('[afterPack] hasAsar:', hasAsar, 'appRoot:', appRoot);

  // NOTE(victor): Helper to find package in node_modules, handles pnpm .pnpm structure
  const findPackageInNodeModules = (nodeModulesDir, packageName) => {
    if (!fs.existsSync(nodeModulesDir)) return null;

    const directPath = path.join(nodeModulesDir, packageName);
    if (fs.existsSync(directPath)) return directPath;

    const pnpmDir = path.join(nodeModulesDir, '.pnpm');
    if (!fs.existsSync(pnpmDir)) return null;

    const entries = fs.readdirSync(pnpmDir);
    const pkgNameEscaped = packageName.replace(/\//g, '+');
    for (const entry of entries) {
      if (entry.startsWith(pkgNameEscaped + '@')) {
        const nestedPath = path.join(pnpmDir, entry, 'node_modules', packageName);
        if (fs.existsSync(nestedPath)) return nestedPath;
      }
    }
    return null;
  };

  // NOTE(victor): Helper to find all possible node_modules locations
  const getNodeModulesDirs = () => {
    const dirs = [];
    if (fs.existsSync(appRoot)) {
      const appNodeModules = path.join(appRoot, 'node_modules');
      if (fs.existsSync(appNodeModules)) dirs.push(appNodeModules);
    }
    return dirs;
  };

  const nodeModulesDirs = getNodeModulesDirs();
  console.log('[afterPack] node_modules directories:', nodeModulesDirs);

  // --- macOS binary signing ---
  if (isMac) {
    console.log('[afterPack] Building macOS binary signing list...');
    const toSign = [];

    const addFilesFromDir = (dir, filter) => {
      if (!fs.existsSync(dir)) return;
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        const st = fs.statSync(p);
        if (st.isFile() && (!filter || filter(name))) toSign.push(p);
      }
    };

    const scanDirRecursive = (dir, filter) => {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        const fullPath = path.join(dir, entry);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          scanDirRecursive(fullPath, filter);
        } else if (stat.isFile() && (!filter || filter(entry, stat))) {
          toSign.push(fullPath);
        }
      }
    };

    // Ripgrep binary
    for (const nmDir of nodeModulesDirs) {
      const ripgrepPkg = findPackageInNodeModules(nmDir, '@vscode/ripgrep');
      if (ripgrepPkg) {
        const rgBin = path.join(ripgrepPkg, 'bin', 'rg');
        if (fs.existsSync(rgBin)) {
          console.log('[afterPack] Adding ripgrep binary for signing...');
          toSign.push(rgBin);
        }
      }
    }

    for (const binaryPath of getMacExtraResourceBinariesForSigning(resourcesRoot)) {
      console.log('[afterPack] Adding extraResource binary for signing:', binaryPath);
      toSign.push(binaryPath);
    }

    const relayRuntimeDir = path.join(resourcesRoot, 'browser-extension-relay');
    if (fs.existsSync(relayRuntimeDir)) {
      console.log('[afterPack] Adding browser-extension-relay native binaries for signing...');
      scanDirRecursive(relayRuntimeDir, (name) => name.endsWith('.node') || name.endsWith('.dylib'));
    }

    const opts = packager.platformSpecificBuildOptions || {};
    opts.binaries = Array.from(new Set([...(opts.binaries || []), ...toSign]));
    packager.platformSpecificBuildOptions = opts;
    console.log('[afterPack] Will sign', opts.binaries.length, 'extra binaries');
  }

  console.log('[afterPack] Post-pack processing complete');
}

module.exports = afterPack;
module.exports.assertRequiredBundledResources = assertRequiredBundledResources;
module.exports.copyWindowsRuntimeDlls = copyWindowsRuntimeDlls;
module.exports.assertWindowsDelayLoadDlls = assertWindowsDelayLoadDlls;
module.exports.getMacExtraResourceBinariesForSigning = getMacExtraResourceBinariesForSigning;
