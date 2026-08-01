#!/usr/bin/env node
/**
 * IMPORTANT: pdfcpu ships as a standalone CLI. It does not require Poppler,
 * PDFium, qpdf, a C/C++ runtime bundle, or any other third-party dynamic
 * libraries next to the binary. Platform system libraries may still appear in
 * the OS loader import table, but there are no extra app-shipped DLL/dylib/so
 * dependencies to bundle for pdfcpu itself.
 *
 * Verification we ran before adding this downloader:
 * - Downloaded the official pdfcpu v0.12.0 Windows x86_64 and i386 release
 *   ZIPs from GitHub. Each archive contained only pdfcpu.exe, README.md, and
 *   LICENSE.txt.
 * - Inspected both Windows executables with objdump. Their PE import tables
 *   listed only kernel32.dll, with no pdfium.dll, Poppler DLLs, vcruntime,
 *   ucrtbase, or other third-party runtime imports.
 * - Inspected the local macOS arm64 pdfcpu binary with otool -L. It linked only
 *   normal Apple system libraries/frameworks, not external PDF libraries.
 *
 * Downloads pdfcpu binaries from GitHub releases.
 *
 * Usage:
 *   node scripts/download-pdfcpu.mjs [version] [--current-platform]
 *   node scripts/download-pdfcpu.mjs [version] --platform darwin-x64
 *
 * Options:
 *   version             Specific version tag (default: pinned version)
 *   --current-platform  Only download for current OS/arch
 *   --platform <key>    Download only the specified platform key
 */

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
export const PDFCPU_DIR_NAME = 'pdfcpu';
const PDFCPU_DIR = path.join(ROOT, 'resources', PDFCPU_DIR_NAME);

export const PINNED_VERSION = 'v0.12.0';

export function versionNumber(version) {
  return version.replace(/^v/, '');
}

export function getArchiveConfig(platform, version = PINNED_VERSION) {
  const releaseVersion = versionNumber(version);
  const configs = {
    'darwin-arm64': {
      asset: `pdfcpu_${releaseVersion}_Darwin_arm64.tar.xz`,
      extractedDir: `pdfcpu_${releaseVersion}_Darwin_arm64`,
      binary: 'pdfcpu',
    },
    'darwin-x64': {
      asset: `pdfcpu_${releaseVersion}_Darwin_x86_64.tar.xz`,
      extractedDir: `pdfcpu_${releaseVersion}_Darwin_x86_64`,
      binary: 'pdfcpu',
    },
    'linux-x64': {
      asset: `pdfcpu_${releaseVersion}_Linux_x86_64.tar.xz`,
      extractedDir: `pdfcpu_${releaseVersion}_Linux_x86_64`,
      binary: 'pdfcpu',
    },
    'win32-x64': {
      asset: `pdfcpu_${releaseVersion}_Windows_x86_64.zip`,
      extractedDir: `pdfcpu_${releaseVersion}_Windows_x86_64`,
      binary: 'pdfcpu.exe',
    },
  };

  return configs[platform];
}

export const PLATFORM_KEYS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64'];

export function getPlatformKey(platform = process.platform, arch = process.arch) {
  const osPlatform = platform === 'win32' ? 'win32' : platform;
  return `${osPlatform}-${arch}`;
}

export function getDownloadUrl(version, asset) {
  return `https://github.com/pdfcpu/pdfcpu/releases/download/${version}/${asset}`;
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

export function getPlatformsToDownload({ currentPlatformOnly = false, requestedPlatform, currentPlatformKey = getPlatformKey() } = {}) {
  if (requestedPlatform) {
    if (!PLATFORM_KEYS.includes(requestedPlatform)) {
      throw new Error(`No pdfcpu binary configured for platform: ${requestedPlatform}`);
    }
    return [requestedPlatform];
  }

  if (currentPlatformOnly) {
    if (!PLATFORM_KEYS.includes(currentPlatformKey)) {
      throw new Error(`No pdfcpu binary configured for platform: ${currentPlatformKey}`);
    }
    return [currentPlatformKey];
  }

  return [...PLATFORM_KEYS];
}

export function getCurlDownloadArgs(version, asset, destinationPath) {
  return ['-L', '--fail', '-o', destinationPath, getDownloadUrl(version, asset)];
}

function downloadAsset(version, asset, destinationDir) {
  const destinationPath = path.join(destinationDir, asset);
  execFileSync('curl', getCurlDownloadArgs(version, asset, destinationPath), { stdio: 'pipe' });
}

function extractArchive(assetPath, platformDir) {
  if (assetPath.endsWith('.tar.xz')) {
    execSync(`tar -xJf "${assetPath}" -C "${platformDir}"`, { stdio: 'pipe' });
    return;
  }

  if (assetPath.endsWith('.zip')) {
    if (process.platform === 'win32') {
      execSync(`powershell -Command "Expand-Archive -Path '${assetPath}' -DestinationPath '${platformDir}' -Force"`, { stdio: 'pipe' });
    } else {
      execSync(`unzip -o "${assetPath}" -d "${platformDir}"`, { stdio: 'pipe' });
    }
    return;
  }

  throw new Error(`Unsupported archive format: ${assetPath}`);
}

async function downloadAndExtract(version, platform) {
  const config = getArchiveConfig(platform, version);
  if (!config) {
    throw new Error(`No pdfcpu binary configured for platform: ${platform}`);
  }

  const platformDir = path.join(PDFCPU_DIR, platform);
  const binaryPath = path.join(platformDir, config.binary);
  if (fs.existsSync(binaryPath)) {
    console.log(`✓ ${platform}: already exists`);
    return;
  }

  console.log(`↓ ${platform}: downloading ${config.asset}...`);
  fs.mkdirSync(platformDir, { recursive: true });

  const tmpDir = path.join(PDFCPU_DIR, '.tmp', platform);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    downloadAsset(version, config.asset, tmpDir);
    const assetPath = path.join(tmpDir, config.asset);
    extractArchive(assetPath, platformDir);

    const extractedBinaryPath = path.join(platformDir, config.extractedDir, config.binary);
    if (!fs.existsSync(extractedBinaryPath)) {
      throw new Error(`Binary not found after extraction: ${extractedBinaryPath}`);
    }

    fs.copyFileSync(extractedBinaryPath, binaryPath);
    if (!platform.startsWith('win32')) {
      fs.chmodSync(binaryPath, 0o755);
    }
    fs.rmSync(path.join(platformDir, config.extractedDir), { recursive: true, force: true });

    console.log(`✓ ${platform}: done`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  const { version, currentPlatformOnly, requestedPlatform } = parseArgs(process.argv.slice(2));
  const versionFilePath = path.join(PDFCPU_DIR, 'VERSION');

  let platformsToDownload;
  try {
    platformsToDownload = getPlatformsToDownload({ currentPlatformOnly, requestedPlatform });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(`Available platforms: ${PLATFORM_KEYS.join(', ')}`);
    process.exit(1);
  }

  if (requestedPlatform) {
    console.log(`Downloading pdfcpu ${version} for ${requestedPlatform}...\n`);
  } else if (currentPlatformOnly) {
    console.log(`Downloading pdfcpu ${version} for ${platformsToDownload[0]}...\n`);
  } else {
    console.log(`Downloading pdfcpu ${version} for all platforms...\n`);
  }

  const existingVersion = fs.existsSync(versionFilePath)
    ? fs.readFileSync(versionFilePath, 'utf-8').trim()
    : null;
  if (existingVersion && existingVersion !== version) {
    console.log(`Detected pdfcpu version change (${existingVersion} -> ${version}), refreshing binaries...`);
    for (const platform of platformsToDownload) {
      fs.rmSync(path.join(PDFCPU_DIR, platform), { recursive: true, force: true });
    }
  }

  fs.rmSync(path.join(PDFCPU_DIR, '.tmp'), { recursive: true, force: true });

  for (const platform of platformsToDownload) {
    try {
      await downloadAndExtract(version, platform);
    } catch (error) {
      console.error(`✗ ${platform}: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  }

  fs.mkdirSync(PDFCPU_DIR, { recursive: true });
  fs.writeFileSync(versionFilePath, `${version}\n`);

  const platformLabel = platformsToDownload.length === 1 ? 'platform' : 'platforms';
  console.log(`\n✓ ${platformsToDownload.length} ${platformLabel} downloaded to resources/pdfcpu/`);
}

if (isCliEntryPoint(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
