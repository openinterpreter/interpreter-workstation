import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, test } from 'node:test';

import {
  PDFCPU_DIR_NAME,
  PINNED_VERSION,
  getArchiveConfig,
  getCurlDownloadArgs,
  getDownloadUrl,
  getPlatformKey,
  getPlatformsToDownload,
  isSameResolvedPath,
  parseArgs,
} from '../scripts/download-pdfcpu.mjs';

describe('download-pdfcpu helpers', () => {
  test('maps supported app platforms to pdfcpu release assets', () => {
    assert.deepEqual(getArchiveConfig('darwin-arm64'), {
      asset: 'pdfcpu_0.12.0_Darwin_arm64.tar.xz',
      extractedDir: 'pdfcpu_0.12.0_Darwin_arm64',
      binary: 'pdfcpu',
    });
    assert.deepEqual(getArchiveConfig('darwin-x64'), {
      asset: 'pdfcpu_0.12.0_Darwin_x86_64.tar.xz',
      extractedDir: 'pdfcpu_0.12.0_Darwin_x86_64',
      binary: 'pdfcpu',
    });
    assert.deepEqual(getArchiveConfig('linux-x64'), {
      asset: 'pdfcpu_0.12.0_Linux_x86_64.tar.xz',
      extractedDir: 'pdfcpu_0.12.0_Linux_x86_64',
      binary: 'pdfcpu',
    });
    assert.deepEqual(getArchiveConfig('win32-x64'), {
      asset: 'pdfcpu_0.12.0_Windows_x86_64.zip',
      extractedDir: 'pdfcpu_0.12.0_Windows_x86_64',
      binary: 'pdfcpu.exe',
    });
  });

  test('selects all platforms or one requested platform', () => {
    assert.deepEqual(getPlatformsToDownload({ currentPlatformOnly: false }), [
      'darwin-arm64',
      'darwin-x64',
      'linux-x64',
      'win32-x64',
    ]);

    assert.deepEqual(getPlatformsToDownload({ requestedPlatform: 'win32-x64' }), ['win32-x64']);
    assert.deepEqual(
      getPlatformsToDownload({ currentPlatformOnly: true, currentPlatformKey: 'darwin-arm64' }),
      ['darwin-arm64'],
    );
  });

  test('rejects unsupported platform keys', () => {
    assert.throws(
      () => getPlatformsToDownload({ requestedPlatform: 'linux-arm64' }),
      /No pdfcpu binary configured for platform: linux-arm64/,
    );
  });

  test('downloads from the direct GitHub release URL without the GitHub API', () => {
    assert.deepEqual(
      getCurlDownloadArgs(PINNED_VERSION, 'pdfcpu_0.12.0_Linux_x86_64.tar.xz', '/tmp/pdfcpu.tar.xz'),
      [
        '-L',
        '--fail',
        '-o',
        '/tmp/pdfcpu.tar.xz',
        'https://github.com/pdfcpu/pdfcpu/releases/download/v0.12.0/pdfcpu_0.12.0_Linux_x86_64.tar.xz',
      ],
    );
  });

  test('builds the GitHub download URL from pinned version and asset', () => {
    const config = getArchiveConfig('win32-x64');
    assert.equal(
      getDownloadUrl(PINNED_VERSION, config.asset),
      'https://github.com/pdfcpu/pdfcpu/releases/download/v0.12.0/pdfcpu_0.12.0_Windows_x86_64.zip',
    );
  });

  test('detects CLI entrypoint paths with Windows path semantics', () => {
    const windowsScriptPath = 'C:\\actions-runner\\iworkstation\\iworkstation\\scripts\\download-pdfcpu.mjs';
    assert.equal(isSameResolvedPath(windowsScriptPath, windowsScriptPath, path.win32), true);
    assert.equal(
      isSameResolvedPath(windowsScriptPath, 'C:\\actions-runner\\iworkstation\\iworkstation\\scripts\\other.mjs', path.win32),
      false,
    );
  });

  test('parses CLI arguments like download-codex', () => {
    assert.deepEqual(parseArgs(['--current-platform']), {
      version: PINNED_VERSION,
      currentPlatformOnly: true,
      requestedPlatform: undefined,
    });
    assert.deepEqual(parseArgs(['v0.12.0', '--platform', 'linux-x64']), {
      version: 'v0.12.0',
      currentPlatformOnly: false,
      requestedPlatform: 'linux-x64',
    });
  });

  test('uses resources/pdfcpu as output root and node platform arch keys', () => {
    assert.equal(PDFCPU_DIR_NAME, 'pdfcpu');
    assert.equal(getPlatformKey('darwin', 'arm64'), 'darwin-arm64');
    assert.equal(getPlatformKey('win32', 'x64'), 'win32-x64');
  });
});
