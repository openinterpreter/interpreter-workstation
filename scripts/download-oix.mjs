#!/usr/bin/env node
/**
 * Downloads the public OIX runtime package from GitHub releases.
 *
 * Usage:
 *   node scripts/download-oix.mjs [version] [--current-platform]
 *   node scripts/download-oix.mjs [version] --platform darwin-x64
 */

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
export const OIX_DIR_NAME = 'oix';
const OIX_DIR = path.join(ROOT, 'resources', OIX_DIR_NAME);
export const OIX_REPO = 'openinterpreter/openinterpreter';
export const PINNED_VERSION = 'rust-v0.0.34';

const PLATFORMS = {
  'darwin-arm64': {
    target: 'aarch64-apple-darwin',
    interpreterPath: 'bin/interpreter',
  },
  'darwin-x64': {
    target: 'x86_64-apple-darwin',
    interpreterPath: 'bin/interpreter',
  },
  'linux-arm64': {
    target: 'aarch64-unknown-linux-musl',
    interpreterPath: 'bin/interpreter',
  },
  'linux-x64': {
    target: 'x86_64-unknown-linux-musl',
    interpreterPath: 'bin/interpreter',
  },
  'win32-arm64': {
    target: 'aarch64-pc-windows-msvc',
    interpreterPath: 'bin/interpreter.exe',
  },
  'win32-x64': {
    target: 'x86_64-pc-windows-msvc',
    interpreterPath: 'bin/interpreter.exe',
  },
};

export const OIX_PLATFORMS = PLATFORMS;
export const PLATFORM_KEYS = Object.keys(OIX_PLATFORMS);

export function getArchiveConfig(platform) {
  const config = OIX_PLATFORMS[platform];
  if (!config) {
    return undefined;
  }

  const asset = `open-interpreter-package-${config.target}.tar.gz`;
  return {
    ...config,
    asset,
    checksumAsset: 'codex-package_SHA256SUMS',
  };
}

export function getPlatformKey(platform = process.platform, arch = process.arch) {
  const osPlatform = platform === 'win32' ? 'win32' : platform;
  return `${osPlatform}-${arch}`;
}

export function getDownloadUrl(version, asset) {
  return `https://github.com/${OIX_REPO}/releases/download/${version}/${asset}`;
}

export function isSameResolvedPath(entryPath, argvPath, pathApi = path) {
  return Boolean(argvPath)
    && pathApi.resolve(entryPath) === pathApi.resolve(argvPath);
}

export function isCliEntryPoint(importMetaUrl, argvPath = process.argv[1]) {
  return isSameResolvedPath(fileURLToPath(importMetaUrl), argvPath);
}

export function parseArgs(args) {
  const currentPlatformOnly = args.includes('--current-platform');
  const platformIndex = args.indexOf('--platform');
  const requestedPlatform = platformIndex !== -1 ? args[platformIndex + 1] : undefined;
  const version = args.find((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--platform') || PINNED_VERSION;

  return { version, currentPlatformOnly, requestedPlatform };
}

export function getPlatformsToDownload({
  currentPlatformOnly = false,
  requestedPlatform,
  currentPlatformKey = getPlatformKey(),
} = {}) {
  if (requestedPlatform) {
    if (!PLATFORM_KEYS.includes(requestedPlatform)) {
      throw new Error(`No OIX runtime available for platform: ${requestedPlatform}`);
    }
    return [requestedPlatform];
  }

  if (currentPlatformOnly) {
    if (!PLATFORM_KEYS.includes(currentPlatformKey)) {
      throw new Error(`No OIX runtime available for platform: ${currentPlatformKey}`);
    }
    return [currentPlatformKey];
  }

  return [...PLATFORM_KEYS];
}

function expectedCliVersion(versionTag) {
  return versionTag.replace(/^rust-v/, '').replace(/^v/, '');
}

function parseCliVersion(output) {
  const match = String(output).match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  return match ? match[1] : null;
}

function canVerifyBinaryVersionForPlatform(platform) {
  const hostPlatform = process.platform === 'win32' ? 'win32' : process.platform;
  const hostKey = `${hostPlatform}-${process.arch}`;
  return hostKey === platform;
}

function readExistingBinaryVersion(binaryPath) {
  try {
    const output = execFileSync(binaryPath, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return parseCliVersion(output);
  } catch {
    return null;
  }
}

function hasGhWithAuth() {
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function downloadAsset(version, asset, destinationDir) {
  if (hasGhWithAuth()) {
    execFileSync('gh', ['release', 'download', version, '--repo', OIX_REPO, '--pattern', asset, '--dir', destinationDir], {
      stdio: 'pipe',
    });
    return;
  }

  const downloadUrl = getDownloadUrl(version, asset);
  const destinationPath = path.join(destinationDir, asset);
  execFileSync('curl', ['-L', '--fail', '-o', destinationPath, downloadUrl], { stdio: 'pipe' });
}

function fileSha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function verifyArchiveDigest(assetPath, checksumPath) {
  const assetName = path.basename(assetPath);
  const checksumLine = fs.readFileSync(checksumPath, 'utf8')
    .split(/\r?\n/)
    .find((line) => line.trim().endsWith(` ${assetName}`));
  if (!checksumLine) {
    throw new Error(`No checksum found for ${assetName} in ${path.basename(checksumPath)}`);
  }
  const expected = checksumLine.trim().split(/\s+/)[0];
  const actual = fileSha256(assetPath);
  if (actual !== expected) {
    throw new Error(`Checksum mismatch for ${path.basename(assetPath)}: expected ${expected}, got ${actual}`);
  }
}

async function getLatestVersion() {
  return PINNED_VERSION;
}

async function downloadAndExtract(version, platform) {
  const archiveConfig = getArchiveConfig(platform);
  if (!archiveConfig) {
    throw new Error(`No OIX runtime available for platform: ${platform}`);
  }

  const platformDir = path.join(OIX_DIR, platform);
  const primaryBinaryPath = path.join(platformDir, archiveConfig.interpreterPath);
  const shouldVerifyBinaryVersion = canVerifyBinaryVersionForPlatform(platform);
  const existingBinaryVersion = shouldVerifyBinaryVersion && fs.existsSync(primaryBinaryPath)
    ? readExistingBinaryVersion(primaryBinaryPath)
    : null;
  const expectedVersion = expectedCliVersion(version);
  const hasVersionMismatch = shouldVerifyBinaryVersion
    && existingBinaryVersion !== null
    && existingBinaryVersion !== expectedVersion;

  if (
    fs.existsSync(primaryBinaryPath)
    && fs.existsSync(path.join(platformDir, 'codex-package.json'))
    && !hasVersionMismatch
  ) {
    console.log(`ok ${platform}: already exists`);
    return;
  }

  if (hasVersionMismatch) {
    console.log(
      `refresh ${platform}: stale OIX version ${existingBinaryVersion} -> ${expectedVersion}`,
    );
    fs.rmSync(platformDir, { recursive: true, force: true });
  }

  const asset = archiveConfig.asset;
  const checksumAsset = archiveConfig.checksumAsset;
  console.log(`download ${platform}: ${asset}...`);
  fs.mkdirSync(platformDir, { recursive: true });

  const tmpDir = path.join(OIX_DIR, '.tmp', platform);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    downloadAsset(version, asset, tmpDir);
    downloadAsset(version, checksumAsset, tmpDir);

    const assetPath = path.join(tmpDir, asset);
    verifyArchiveDigest(assetPath, path.join(tmpDir, checksumAsset));
    execFileSync('tar', ['-xzf', assetPath, '-C', tmpDir], { stdio: 'pipe' });

    for (const entry of ['bin', 'codex-package.json', 'codex-path', 'codex-resources']) {
      const extractedPath = path.join(tmpDir, entry);
      if (!fs.existsSync(extractedPath)) {
        throw new Error(`OIX package entry not found after extraction: ${extractedPath}`);
      }
      fs.cpSync(extractedPath, path.join(platformDir, entry), {
        recursive: true,
        force: true,
      });
    }

    if (!fs.existsSync(primaryBinaryPath)) {
      throw new Error(`OIX interpreter not found after extraction: ${primaryBinaryPath}`);
    }
    if (!platform.startsWith('win32')) {
      for (const relativePath of [
        archiveConfig.interpreterPath,
        'bin/i',
        'bin/codex-code-mode-host',
        'codex-path/rg',
        'codex-resources/zsh/bin/zsh',
      ]) {
        const executablePath = path.join(platformDir, relativePath);
        if (fs.existsSync(executablePath)) {
          fs.chmodSync(executablePath, 0o755);
        }
      }
    }

    console.log(`ok ${platform}: done`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  const { version: requestedVersion, currentPlatformOnly, requestedPlatform } = parseArgs(process.argv.slice(2));
  const version = requestedVersion || await getLatestVersion();
  const versionFilePath = path.join(OIX_DIR, 'VERSION');

  let platformKeysToDownload;

  try {
    platformKeysToDownload = getPlatformsToDownload({ currentPlatformOnly, requestedPlatform });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(`Available platforms: ${PLATFORM_KEYS.join(', ')}`);
    process.exit(1);
  }

  if (requestedPlatform) {
    console.log(`Downloading OIX ${version} for ${requestedPlatform}...\n`);
  } else if (currentPlatformOnly) {
    console.log(`Downloading OIX ${version} for ${platformKeysToDownload[0]}...\n`);
  } else {
    console.log(`Downloading OIX ${version} for all platforms...\n`);
  }

  const existingVersion = fs.existsSync(versionFilePath)
    ? fs.readFileSync(versionFilePath, 'utf-8').trim()
    : null;
  if (existingVersion && existingVersion !== version) {
    console.log(`Detected OIX version change (${existingVersion} -> ${version}), refreshing binaries...`);
    for (const platform of platformKeysToDownload) {
      fs.rmSync(path.join(OIX_DIR, platform), { recursive: true, force: true });
    }
  }

  const tmpDir = path.join(OIX_DIR, '.tmp');
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  for (const platform of platformKeysToDownload) {
    try {
      await downloadAndExtract(version, platform);
    } catch (err) {
      console.error(`error ${platform}: ${err.message}`);
      process.exit(1);
    }
  }

  fs.mkdirSync(OIX_DIR, { recursive: true });
  fs.writeFileSync(versionFilePath, version);

  // NOTE(victor): the codex app-server protocol types are platform-independent,
  // so we generate them from whichever interpreter binary exists on the current host.
  const localPlatform = getPlatformKey();
  const localConfig = OIX_PLATFORMS[localPlatform];
  if (localConfig) {
    const interpreterBinary = path.join(OIX_DIR, localPlatform, localConfig.interpreterPath);
    if (fs.existsSync(interpreterBinary)) {
      console.log(`\nGenerating codex app-server protocol types from ${localPlatform} interpreter binary...`);
      execFileSync('bun', [path.join(ROOT, 'scripts', 'generate-codex-schemas.ts'), interpreterBinary], {
        cwd: ROOT,
        stdio: 'inherit',
      });
    }
  }

  const platformCount = platformKeysToDownload.length;
  const platformLabel = platformCount === 1 ? 'platform' : 'platforms';
  console.log(`\nok ${platformCount} ${platformLabel} downloaded to resources/oix/`);
}

if (isCliEntryPoint(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
