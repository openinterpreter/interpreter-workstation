import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildMacUpdateInstallScript } from './macUpdateInstall';

function makeTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'mac-update-install-test-'));
}

async function writeZipArchive(zipPath: string, entries: Record<string, string>): Promise<void> {
  const { default: JSZip } = await import('jszip');
  const archive = new JSZip();

  for (const [entryPath, contents] of Object.entries(entries)) {
    archive.file(entryPath, contents);
  }

  mkdirSync(path.dirname(zipPath), { recursive: true });
  writeFileSync(
    zipPath,
    await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
  );
}

describe('buildMacUpdateInstallScript', () => {
  test('replaces the existing app bundle instead of merging into it', () => {
    const script = buildMacUpdateInstallScript({
      appName: 'Interpreter',
      currentPid: 123,
      updaterPendingDir: '/tmp/pending',
    });

    expect(script).toContain('BACKUP_PATH="$APP_PATH.preupdate.$$"');
    expect(script).toContain('mv "$APP_PATH" "$BACKUP_PATH"');
    expect(script).toContain('/usr/bin/ditto "$STAGED_APP" "$APP_PATH"');
    expect(script).toContain('/usr/bin/codesign --verify --strict --deep "$STAGED_APP"');
    expect(script).toContain('/usr/bin/codesign --verify --strict --deep "$APP_PATH"');
    expect(script).not.toContain('/usr/bin/ditto -xk "$ZIP" "/Applications"');
  });

  test('removes stale app-bundle files when applying an update on macOS', async () => {
    if (process.platform !== 'darwin') {
      return;
    }

    const rootDir = makeTempDir();
    const pendingDir = path.join(rootDir, 'pending');
    const applicationsDir = path.join(rootDir, 'Applications');
    const tempDirRoot = path.join(rootDir, 'tmp');
    const installedAppDir = path.join(applicationsDir, 'Interpreter.app');
    const staleRelayFile = path.join(
      installedAppDir,
      'Contents',
      'Resources',
      'browser-extension-relay',
      'node_modules',
      'hono',
      'package.json',
    );
    const stagedZipPath = path.join(pendingDir, 'Interpreter-mac-arm64-9.9.9.zip');

    mkdirSync(path.dirname(staleRelayFile), { recursive: true });
    mkdirSync(tempDirRoot, { recursive: true });
    writeFileSync(staleRelayFile, 'stale');

    await writeZipArchive(stagedZipPath, {
      'Interpreter.app/Contents/Resources/browser-extension-relay/package.json': 'fresh relay payload',
    });

    const script = buildMacUpdateInstallScript({
      appName: 'Interpreter',
      currentPid: 999_999,
      updaterPendingDir: pendingDir,
      applicationsDir,
      tempDirRoot,
      relaunchApp: false,
      verifyCodeSignature: false,
    });

    execFileSync('/bin/bash', ['-lc', script], {
      env: process.env,
    });

    expect(existsSync(staleRelayFile)).toBeFalse();
    expect(existsSync(path.join(installedAppDir, 'Contents', 'Resources', 'browser-extension-relay', 'package.json'))).toBeTrue();
    expect(readFileSync(path.join(installedAppDir, 'Contents', 'Resources', 'browser-extension-relay', 'package.json'), 'utf8')).toBe(
      'fresh relay payload',
    );

    rmSync(rootDir, { recursive: true, force: true });
  });

  test('restores the old app when the update archive is malformed on macOS', async () => {
    if (process.platform !== 'darwin') {
      return;
    }

    const rootDir = makeTempDir();
    const pendingDir = path.join(rootDir, 'pending');
    const applicationsDir = path.join(rootDir, 'Applications');
    const tempDirRoot = path.join(rootDir, 'tmp');
    const installedAppDir = path.join(applicationsDir, 'Interpreter.app');
    const oldMarkerPath = path.join(installedAppDir, 'Contents', 'Resources', 'old-marker.txt');
    const stagedZipPath = path.join(pendingDir, 'Interpreter-mac-arm64-9.9.9.zip');

    mkdirSync(path.dirname(oldMarkerPath), { recursive: true });
    mkdirSync(tempDirRoot, { recursive: true });
    writeFileSync(oldMarkerPath, 'old app');

    await writeZipArchive(stagedZipPath, {
      'Wrong.app/Contents/Resources/browser-extension-relay/package.json': 'wrong app payload',
    });

    const script = buildMacUpdateInstallScript({
      appName: 'Interpreter',
      currentPid: 999_999,
      updaterPendingDir: pendingDir,
      applicationsDir,
      tempDirRoot,
      relaunchApp: false,
      verifyCodeSignature: false,
    });

    expect(() => execFileSync('/bin/bash', ['-lc', script], { env: process.env })).toThrow();
    expect(readFileSync(oldMarkerPath, 'utf8')).toBe('old app');

    rmSync(rootDir, { recursive: true, force: true });
  });
});
