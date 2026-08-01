import { autoUpdater } from 'electron-updater';
import { S3Options } from 'builder-util-runtime';
import { app, BrowserWindow, Notification } from 'electron';
import { spawn } from 'child_process';
import * as path from 'node:path';
import { checkForOoEditorsUpdate } from './services/office-extension';
import { IPC_CHANNELS } from './ipc/registry';
import { buildMacUpdateInstallScript } from './utils/macUpdateInstall';
import { checkForUpdatesSafely } from './utils/updateCheck';
import { isUpdaterDiskFullError, isUpdaterHttpStatusError } from './utils/transientNetworkErrors';
import { distributionProductConfig, hasUpdateFeed } from '../shared/productConfig';

const UPDATE_INTERVAL = 30 * 60 * 1000;

export const isInternal = app.getName().toLowerCase().includes('internal') ||
  path.basename(app.getPath('exe')).toLowerCase().includes('internal');

// NOTE(victor): Flag to skip before-quit handler intervention during update install
export let isUpdating = false;
let downloadedVersion: string | null = null;
let manualCheckInProgress = false;

function emitToAllWindows(channel: string, payload?: unknown): void {
  const windows = BrowserWindow.getAllWindows();
  windows.forEach((win) => {
    if (!win.isDestroyed()) {
      if (payload === undefined) {
        win.webContents.send(channel);
        return;
      }
      win.webContents.send(channel, payload);
    }
  });
}

function emitUpdateReady(version: string): void {
  emitToAllWindows(IPC_CHANNELS.APP_UPDATE_READY, { version });
}

function emitUpdateChecking(): void {
  emitToAllWindows(IPC_CHANNELS.APP_UPDATE_CHECKING);
}

function emitUpdateUpToDate(): void {
  emitToAllWindows(IPC_CHANNELS.APP_UPDATE_UP_TO_DATE);
}

function emitUpdateError(message: string): void {
  emitToAllWindows(IPC_CHANNELS.APP_UPDATE_ERROR, { message });
}

export function installDownloadedUpdate(): boolean {
  if (!downloadedVersion) {
    console.warn('[Auto-Updater] installDownloadedUpdate called but no downloaded update is ready');
    return false;
  }

  console.log('[Auto-Updater] Installing update via user action:', downloadedVersion);

  if (process.platform === 'darwin') {
    const script = buildMacUpdateInstallScript({
      appName: app.getName(),
      currentPid: process.pid,
      updaterPendingDir: path.join(app.getPath('home'), 'Library', 'Caches', 'interpreter-updater', 'pending'),
    });
    spawn('/bin/bash', ['-lc', script], { detached: true, stdio: 'ignore' }).unref();
    app.quit();
    return true;
  }

  // NOTE(victor): isUpdating must be set only here (not macOS) to match before-quit behavior:
  // macOS needs cleanup() to run (oo-editors shutdown etc.) before quit.
  // Windows skips cleanup because quitAndInstall() handles the quit flow internally.
  isUpdating = true;

  // NOTE(victor): electron-builder v26.0.2 (pinned) works with the combination of
  // `nsis: { perMachine: true }` + `quitAndInstall()`. perMachine makes NSIS use
  // `nsProcess::FindProcess` instead of buggy `tasklist | find.exe` (UTF-8 bug #6865).
  // quitAndInstall() handles elevation fallback via elevate.exe for EACCES errors.
  // (PR #9069 PowerShell fix is in v26.0.20+, not this version.)
  autoUpdater.quitAndInstall(false, true);

  // HISTORY: Previous manual spawn approach for electron-builder v25.x
  // Abandoned due to EACCES permission errors (issue #48) - manual spawn lacks
  // elevation fallback that native quitAndInstall() provides.
  // Problem: NSIS installer shows "cannot be closed" dialog even when app has exited.
  // Root cause: electron-builder bug #6865 - UTF-8 encoding mismatch.
  // NSIS compiles with `-INPUTCHARSET UTF8` (NsisTarget.js:487) which breaks the
  // process detection: `tasklist | find.exe` returns false positives because
  // UTF-8 encoded search string doesn't match system-encoded tasklist output.
  //
  // The v25.x fix required BOTH:
  // 1. `nsis: { perMachine: true }` in electron-builder.yml
  //    - Makes NSIS use `nsProcess::FindProcess` instead of buggy `tasklist | find.exe`
  // 2. `spawn(installer, ['--updated'])` here (NOT shell.openPath)
  //    - The --updated flag gives NSIS 300ms+1000ms grace period for app to exit
  //
  // Related issues:
  // - https://github.com/electron-userland/electron-builder/issues/6865 (main UTF-8 bug)
  // - https://github.com/electron-userland/electron-builder/issues/8131 (regression)
  // - https://github.com/nodejs/node/issues/51018 (Node.js spawn bug with PowerShell)
  //
  // v25.x code (kept for reference):
  // if (!downloadedFile) {
  //   console.error('[Auto-Updater] No installer path found in event');
  //   return;
  // }
  // console.log('[Auto-Updater] Launching installer with --updated flag:', downloadedFile);
  // isUpdating = true;
  // spawn(downloadedFile, ['--updated'], { detached: true, stdio: 'ignore' }).unref();
  // app.quit();
  return true;
}

export async function checkForUpdatesManually(): Promise<boolean> {
  if (!app.isPackaged) {
    emitUpdateError('Update checks are unavailable in development mode.');
    return false;
  }

  if (!hasUpdateFeed()) {
    emitUpdateError('This distribution does not provide an automatic update feed.');
    return false;
  }

  if (manualCheckInProgress) {
    return false;
  }

  manualCheckInProgress = true;
  emitUpdateChecking();

  try {
    await checkForUpdatesSafely(autoUpdater);
    return true;
  } catch (error) {
    manualCheckInProgress = false;
    const message = error instanceof Error ? error.message : 'Unknown update error';
    emitUpdateError(message);
    return false;
  }
}

export function initAutoUpdater() {
  const isDevOrTest = !app.isPackaged || process.env.NODE_ENV === 'test';
  const isTest = process.env.NODE_ENV === 'test';

  const channel = isInternal ? 'internal' : 'production';
  console.log(`[Auto-Updater] Initializing for ${channel} channel, version ${app.getVersion()}`);

  if (!isTest) {
    // oo-editors updates run in dev and packaged app runs, but test startup must
    // stay deterministic and avoid background downloads during fixture setup.
    const checkOoEditorsUpdates = () => {
      checkForOoEditorsUpdate().catch((error) => {
        console.error('[OfficeExtension] Update check failed:', error);
      });
    };
    checkOoEditorsUpdates();
    setInterval(checkOoEditorsUpdates, UPDATE_INTERVAL);
  } else {
    console.log('[OfficeExtension] Skipping oo-editors update checks in test mode');
  }

  if (isDevOrTest) {
    console.warn('[Auto-Updater] Skipping app auto-updater in dev/test mode');
    return;
  }

  if (!hasUpdateFeed()) {
    console.log('[Auto-Updater] No update feed is configured for this distribution');
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  const updateConfig = distributionProductConfig.updates;
  const s3Options: S3Options = {
    provider: 's3',
    bucket: updateConfig.bucket,
    region: updateConfig.region,
    acl: updateConfig.acl || undefined,
    endpoint: updateConfig.endpoint,
    path: isInternal ? updateConfig.internalPath : updateConfig.path,
  };

  autoUpdater.setFeedURL(s3Options);

  autoUpdater.on('checking-for-update', () => {
    console.log('[Auto-Updater] Checking for updates...');
  });

  autoUpdater.on('update-available', (info) => {
    console.log('[Auto-Updater] Update available:', info.version);
    if (manualCheckInProgress) {
      manualCheckInProgress = false;
    }
    const notification = new Notification({
      title: 'Update Available',
      body: `A new version ${info.version} is available and will be downloaded automatically.`
    });
    notification.show();
  });

  autoUpdater.on('update-not-available', (_info) => {
    console.log('[Auto-Updater] Current version is up to date.');
    if (manualCheckInProgress) {
      manualCheckInProgress = false;
      emitUpdateUpToDate();
    }
  });

  autoUpdater.on('error', (err) => {
    const message = err?.message ?? String(err ?? 'Failed to check for updates.');
    if (isUpdaterDiskFullError(message)) {
      console.warn('[Auto-Updater] Disk full during update copy (ignored for Sentry):', message);
      if (manualCheckInProgress) {
        manualCheckInProgress = false;
        emitUpdateError(message);
      }
      return;
    }

    if (isUpdaterHttpStatusError(message)) {
      console.warn('[Auto-Updater] HTTP error during update download (ignored for Sentry):', message);
      if (manualCheckInProgress) {
        manualCheckInProgress = false;
        emitUpdateError(message);
      }
      return;
    }

    console.error('[Auto-Updater] Error:', err);
    if (manualCheckInProgress) {
      manualCheckInProgress = false;
      emitUpdateError(message);
    }
  });

  autoUpdater.on('download-progress', (progressObj) => {
    const logMessage = `Downloaded ${progressObj.percent.toFixed(1)}% (${progressObj.transferred}/${progressObj.total})`;
    console.log('[Auto-Updater]', logMessage);
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[Auto-Updater] Update downloaded:', info.version);
    // NOTE(victor): No longer using blocking native dialog here.
    // Update is now surfaced in renderer as a persistent modal via APP_UPDATE_READY.
    downloadedVersion = info.version;
    emitUpdateReady(info.version);
  });

  const runScheduledAppUpdateCheck = () => {
    // NOTE(victor): Keep retry behavior fixed at the scheduler interval only.
    // Do not add exponential backoff/jitter or immediate retry loops for updater errors.
    checkForUpdatesSafely(autoUpdater).catch(() => {});
  };

  runScheduledAppUpdateCheck();
  setInterval(runScheduledAppUpdateCheck, UPDATE_INTERVAL);
}
