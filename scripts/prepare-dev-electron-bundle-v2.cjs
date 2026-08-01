const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function runOrThrow(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed: ${result.stderr || result.stdout || `exit ${result.status}`}`,
    );
  }
}

function writeStamp(stampPath, stamp) {
  fs.writeFileSync(stampPath, `${JSON.stringify(stamp, null, 2)}\n`);
}

const BRAND = {
  displayName: 'Interpreter',
  bundleName: 'Interpreter',
  bundleIdentifier: 'com.interpreter.dev',
  iconFile: 'app.icns',
};

const CUSTOM_PROTOCOL = 'workstation';

const HELPER_VERSION = 4;

function getBundleIdentity(projectRoot) {
  readJson(path.join(projectRoot, 'package.json'));
  const iconPath = path.join(projectRoot, 'resources', 'icons', 'app.icns');
  return { iconPath };
}

function buildStamp({ sourceBundlePath, iconPath }) {
  const sourceInfoPath = path.join(sourceBundlePath, 'Contents', 'Info.plist');
  return {
    helperVersion: HELPER_VERSION,
    sourceBundlePath,
    sourceInfoMtimeMs: fs.statSync(sourceInfoPath).mtimeMs,
    iconPath,
    iconMtimeMs: fs.statSync(iconPath).mtimeMs,
  };
}

function writeBrandedPlist(infoPlistPath) {
  runOrThrow('/usr/bin/plutil', ['-replace', 'CFBundleDisplayName', '-string', BRAND.displayName, infoPlistPath]);
  runOrThrow('/usr/bin/plutil', ['-replace', 'CFBundleName', '-string', BRAND.bundleName, infoPlistPath]);
  runOrThrow('/usr/bin/plutil', ['-replace', 'CFBundleIdentifier', '-string', BRAND.bundleIdentifier, infoPlistPath]);
  runOrThrow('/usr/bin/plutil', ['-replace', 'CFBundleIconFile', '-string', BRAND.iconFile, infoPlistPath]);
  runOrThrow('/usr/bin/plutil', [
    '-replace',
    'CFBundleURLTypes',
    '-json',
    JSON.stringify([
      {
        CFBundleURLName: BRAND.bundleIdentifier,
        CFBundleURLSchemes: [CUSTOM_PROTOCOL],
      },
    ]),
    infoPlistPath,
  ]);
}

function patchSourceBundle({ sourceBundlePath, iconPath }) {
  const resourcesDir = path.join(sourceBundlePath, 'Contents', 'Resources');
  ensureDir(resourcesDir);
  fs.copyFileSync(iconPath, path.join(resourcesDir, 'app.icns'));
  fs.copyFileSync(iconPath, path.join(resourcesDir, 'electron.icns'));

  const infoPlistPath = path.join(sourceBundlePath, 'Contents', 'Info.plist');
  writeBrandedPlist(infoPlistPath);
}

function prepareDevElectronBundle(options = {}) {
  const projectRoot = options.projectRoot || process.cwd();
  if (process.platform !== 'darwin') {
    return require('electron');
  }

  const sourceBundlePath = path.join(projectRoot, 'node_modules', 'electron', 'dist', 'Electron.app');
  if (!fs.existsSync(sourceBundlePath)) {
    throw new Error(`Missing Electron.app at ${sourceBundlePath}`);
  }

  const { iconPath } = getBundleIdentity(projectRoot);
  if (!fs.existsSync(iconPath)) {
    throw new Error(`Missing app icon at ${iconPath}`);
  }

  const nextStamp = buildStamp({ sourceBundlePath, iconPath });
  const targetExecutablePath = path.join(sourceBundlePath, 'Contents', 'MacOS', 'Electron');
  const cacheRoot = path.join(projectRoot, '.cache', 'dev-electron-bundles');
  const stampPath = path.join(cacheRoot, 'electron-source-bundle.stamp.json');
  let currentStamp = null;
  try {
    currentStamp = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
  } catch {
    currentStamp = null;
  }

  ensureDir(cacheRoot);

  if (JSON.stringify(currentStamp) !== JSON.stringify(nextStamp)) {
    patchSourceBundle({ sourceBundlePath, iconPath });
  }
  writeStamp(stampPath, nextStamp);

  return targetExecutablePath;
}

if (require.main === module) {
  const projectRoot = process.argv[2] || process.cwd();
  process.stdout.write(`${prepareDevElectronBundle({ projectRoot })}\n`);
}

module.exports = {
  prepareDevElectronBundle,
};
