const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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

function readStamp(stampPath) {
  if (!fs.existsSync(stampPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(stampPath, 'utf8'));
  } catch {
    return null;
  }
}

function getBundleIdentity(projectRoot) {
  const packageJson = readJson(path.join(projectRoot, 'package.json'));
  const appName = process.env.INTERPRETER_DEV_APP_NAME
    || (packageJson.private ? 'Interpreter Internal' : 'Interpreter');
  const bundleId = process.env.INTERPRETER_DEV_BUNDLE_ID
    || `com.openinterpreter.${appName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.dev`;
  const iconPath = path.join(projectRoot, 'resources', 'icons', 'app.icns');
  return { appName, bundleId, iconPath };
}

function buildStamp({ appName, bundleId, sourceBundlePath, iconPath }) {
  const sourceInfoPath = path.join(sourceBundlePath, 'Contents', 'Info.plist');
  return {
    appName,
    bundleId,
    sourceBundlePath,
    sourceInfoMtimeMs: fs.statSync(sourceInfoPath).mtimeMs,
    iconPath,
    iconMtimeMs: fs.statSync(iconPath).mtimeMs,
  };
}

function getStampHash(stamp) {
  return crypto.createHash('sha256').update(JSON.stringify(stamp)).digest('hex').slice(0, 12);
}

function patchPlist(infoPlistPath, { appName, bundleId }) {
  runOrThrow('/usr/bin/plutil', ['-replace', 'CFBundleDisplayName', '-string', appName, infoPlistPath]);
  runOrThrow('/usr/bin/plutil', ['-replace', 'CFBundleName', '-string', appName, infoPlistPath]);
  runOrThrow('/usr/bin/plutil', ['-replace', 'CFBundleIdentifier', '-string', bundleId, infoPlistPath]);
  runOrThrow('/usr/bin/plutil', ['-replace', 'CFBundleIconFile', '-string', 'app.icns', infoPlistPath]);
}

function copyBundle({ sourceBundlePath, targetBundlePath, iconPath, appName, bundleId }) {
  fs.rmSync(targetBundlePath, { recursive: true, force: true });
  fs.cpSync(sourceBundlePath, targetBundlePath, { recursive: true });

  const resourcesDir = path.join(targetBundlePath, 'Contents', 'Resources');
  ensureDir(resourcesDir);
  fs.copyFileSync(iconPath, path.join(resourcesDir, 'app.icns'));
  fs.copyFileSync(iconPath, path.join(resourcesDir, 'electron.icns'));

  const infoPlistPath = path.join(targetBundlePath, 'Contents', 'Info.plist');
  patchPlist(infoPlistPath, { appName, bundleId });
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

  const { appName, bundleId, iconPath } = getBundleIdentity(projectRoot);
  if (!fs.existsSync(iconPath)) {
    throw new Error(`Missing app icon at ${iconPath}`);
  }

  const cacheRoot = path.join(projectRoot, '.cache', 'dev-electron-bundles');
  const nextStamp = buildStamp({ appName, bundleId, sourceBundlePath, iconPath });
  const stampHash = getStampHash(nextStamp);
  const targetBundlePath = path.join(cacheRoot, `${appName}-${stampHash}.app`);
  const targetExecutablePath = path.join(targetBundlePath, 'Contents', 'MacOS', 'Electron');
  const stampPath = path.join(cacheRoot, `${appName}.stamp.json`);

  ensureDir(cacheRoot);

  if (!fs.existsSync(targetExecutablePath)) {
    copyBundle({ sourceBundlePath, targetBundlePath, iconPath, appName, bundleId });
  }
  writeStamp(stampPath, { ...nextStamp, stampHash, targetBundlePath });

  return targetExecutablePath;
}

if (require.main === module) {
  const projectRoot = process.argv[2] || process.cwd();
  process.stdout.write(`${prepareDevElectronBundle({ projectRoot })}\n`);
}

module.exports = {
  prepareDevElectronBundle,
};
