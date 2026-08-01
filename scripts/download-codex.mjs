#!/usr/bin/env node
/**
 * Downloads the Windows sandbox helper binaries from GitHub releases.
 *
 * The OIX runtime provides the app-server and CLI binaries, but on Windows it
 * still spawns the codex-built sandbox helpers (codex-windows-sandbox-setup and
 * codex-command-runner) and OIX ships no replacement yet. Only those helpers are
 * downloaded here; the standalone codex app-server binary is no longer shipped.
 *
 * On platforms without Windows helpers (macOS, Linux) this is a no-op.
 *
 * Usage:
 *   node scripts/download-codex.mjs [version] [--current-platform]
 *   node scripts/download-codex.mjs [version] --platform win32-x64
 *
 * Options:
 *   version             Specific version tag (default: pinned)
 *   --current-platform  Only download for current OS/arch (faster for CI)
 *   --platform <key>    Download only the specified platform key
 */

import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CODEX_DIR = path.join(ROOT, 'resources', 'codex');

// Platform mappings: electron-builder names -> GitHub release names.
// Only Windows ships sandbox helpers; other platforms download nothing.
// extractedName is what's inside the archive, binary is what we rename it to.
const PLATFORMS = {
  'win32-x64': {
    files: [
      {
        asset: 'codex-command-runner-x86_64-pc-windows-msvc.exe.zip',
        extractedName: 'codex-command-runner-x86_64-pc-windows-msvc.exe',
        binary: 'codex-command-runner.exe',
      },
      {
        asset: 'codex-windows-sandbox-setup-x86_64-pc-windows-msvc.exe.zip',
        extractedName: 'codex-windows-sandbox-setup-x86_64-pc-windows-msvc.exe',
        binary: 'codex-windows-sandbox-setup.exe',
      },
    ],
  },
};

// NOTE(victor): pinned for deterministic release packaging. Do not default to
// latest -- the pinned version must ship .zip archives for Windows binaries.
const PINNED_VERSION = 'rust-v0.108.0-alpha.16';

function expectedCliVersion(versionTag) {
  return versionTag.replace(/^rust-v/, '');
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
    execSync('gh auth status', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function downloadAsset(version, asset, destinationDir) {
  if (hasGhWithAuth()) {
    execSync(
      `gh release download ${version} --repo openinterpreter/codex --pattern "${asset}" --dir "${destinationDir}"`,
      { stdio: 'pipe' }
    );
    return;
  }

  const downloadUrl = `https://github.com/openinterpreter/codex/releases/download/${version}/${asset}`;
  const destinationPath = path.join(destinationDir, asset);
  execSync(`curl -L --fail -o "${destinationPath}" "${downloadUrl}"`, { stdio: 'pipe' });
}

async function getLatestVersion() {
  return PINNED_VERSION;
  // NOTE(victor): keeping working logic for later
  // const output = execSync('gh release list --repo openinterpreter/codex --limit 10 --json tagName,isPrerelease', {
  //   encoding: 'utf-8',
  // });
  // const releases = JSON.parse(output);
  // const stable = releases.find(r => !r.isPrerelease);
  // return stable?.tagName || releases[0]?.tagName;
}

async function downloadAndExtract(version, platform, config) {
  const platformDir = path.join(CODEX_DIR, platform);
  const binaryPaths = config.files.map(({ binary }) => path.join(platformDir, binary));
  const primaryBinaryPath = path.join(platformDir, config.files[0].binary);
  const shouldVerifyBinaryVersion = canVerifyBinaryVersionForPlatform(platform);
  const existingBinaryVersion = shouldVerifyBinaryVersion && fs.existsSync(primaryBinaryPath)
    ? readExistingBinaryVersion(primaryBinaryPath)
    : null;
  const expectedVersion = expectedCliVersion(version);
  const hasVersionMismatch = shouldVerifyBinaryVersion
    && existingBinaryVersion !== null
    && existingBinaryVersion !== expectedVersion;

  // Skip if already exists
  if (binaryPaths.every((binaryPath) => fs.existsSync(binaryPath)) && !hasVersionMismatch) {
    console.log(`✓ ${platform}: already exists`);
    return;
  }

  if (hasVersionMismatch) {
    console.log(
      `↻ ${platform}: refreshing stale binary version ${existingBinaryVersion} -> ${expectedVersion}`,
    );
    fs.rmSync(platformDir, { recursive: true, force: true });
    fs.mkdirSync(platformDir, { recursive: true });
  }

  const assetsLabel = config.files.map(({ asset }) => asset).join(', ');
  console.log(`↓ ${platform}: downloading ${assetsLabel}...`);
  fs.mkdirSync(platformDir, { recursive: true });

  const tmpDir = path.join(CODEX_DIR, '.tmp', platform);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    for (const file of config.files) {
      downloadAsset(version, file.asset, tmpDir);

      const assetPath = path.join(tmpDir, file.asset);

      // Extract based on format
      if (file.asset.endsWith('.tar.gz')) {
        execSync(`tar -xzf "${assetPath}" -C "${platformDir}"`, { stdio: 'pipe' });
      } else if (file.asset.endsWith('.zip')) {
        if (process.platform === 'win32') {
          // PowerShell's Expand-Archive works on all Windows versions
          execSync(`powershell -Command "Expand-Archive -Path '${assetPath}' -DestinationPath '${platformDir}' -Force"`, { stdio: 'pipe' });
        } else {
          execSync(`unzip -o "${assetPath}" -d "${platformDir}"`, { stdio: 'pipe' });
        }
      } else {
        throw new Error(`Unsupported archive format: ${file.asset}`);
      }

      // Rename extracted binary to standard name
      const extractedPath = path.join(platformDir, file.extractedName);
      const binaryPath = path.join(platformDir, file.binary);
      if (fs.existsSync(extractedPath) && file.extractedName !== file.binary) {
        fs.renameSync(extractedPath, binaryPath);
      }

      if (!fs.existsSync(binaryPath)) {
        throw new Error(`Binary not found after extraction: ${binaryPath}`);
      }

      // Make executable (unix only)
      if (!platform.startsWith('win32')) {
        fs.chmodSync(binaryPath, 0o755);
      }
    }

    console.log(`✓ ${platform}: done`);
  } finally {
    // Cleanup tmp
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const currentPlatformOnly = args.includes('--current-platform');
  const platformIndex = args.indexOf('--platform');
  const requestedPlatform = platformIndex !== -1 ? args[platformIndex + 1] : undefined;
  const requestedVersion = args.find((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--platform');
  const version = requestedVersion || await getLatestVersion();
  const versionFilePath = path.join(CODEX_DIR, 'VERSION');

  // Determine which platforms to download
  let platformsToDownload = Object.entries(PLATFORMS);

  if (requestedPlatform) {
    platformsToDownload = platformsToDownload.filter(([platform]) => platform === requestedPlatform);
    if (platformsToDownload.length === 0) {
      console.log(`No Windows sandbox helpers for platform ${requestedPlatform}; nothing to download.`);
      return;
    }
    console.log(`Downloading Windows sandbox helpers ${version} for ${requestedPlatform}...\n`);
  } else if (currentPlatformOnly) {
    const osPlatform = process.platform === 'win32' ? 'win32' : process.platform;
    const currentPlatform = `${osPlatform}-${process.arch}`;
    platformsToDownload = platformsToDownload.filter(([p]) => p === currentPlatform);

    if (platformsToDownload.length === 0) {
      console.log(`No Windows sandbox helpers for platform ${currentPlatform}; nothing to download.`);
      return;
    }

    console.log(`Downloading Windows sandbox helpers ${version} for ${currentPlatform}...\n`);
  } else {
    console.log(`Downloading Windows sandbox helpers ${version} for all platforms...\n`);
  }

  const existingVersion = fs.existsSync(versionFilePath)
    ? fs.readFileSync(versionFilePath, 'utf-8').trim()
    : null;
  if (existingVersion && existingVersion !== version) {
    console.log(`Detected codex version change (${existingVersion} -> ${version}), refreshing binaries...`);
    for (const [platform] of platformsToDownload) {
      const platformDir = path.join(CODEX_DIR, platform);
      fs.rmSync(platformDir, { recursive: true, force: true });
    }
  }

  // Clean up any leftover tmp directory
  const tmpDir = path.join(CODEX_DIR, '.tmp');
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // Download for each platform
  for (const [platform, config] of platformsToDownload) {
    try {
      await downloadAndExtract(version, platform, config);
    } catch (err) {
      console.error(`✗ ${platform}: ${err.message}`);
      process.exit(1);
    }
  }

  // Write version file
  fs.writeFileSync(versionFilePath, version);

  const platformCount = platformsToDownload.length;
  const platformLabel = platformCount === 1 ? 'platform' : 'platforms';
  console.log(`\n✓ ${platformCount} ${platformLabel} downloaded to resources/codex/`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
