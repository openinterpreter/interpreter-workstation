import { app, BrowserWindow, crashReporter, dialog } from 'electron';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as Sentry from '@sentry/electron/main';
import { getTelemetryEnabled } from '../server/configStore';
import { t } from './i18n';
import { emitOpenSettings } from './ipc/events';
import { formatTelemetrySettingState, listCrashDumpBasenamesForLog } from './utils/crashDumpDiagnostics';

const LOCAL_CRASH_REPORTER_SUBMIT_URL = 'https://f.a.k/e';
const NATIVE_CRASH_CONTEXT_FILENAME = 'native-crash-context.json';

export interface NativeCrashReporterContext {
  eventProcess?: string;
  overlayRuntimeActive?: boolean;
  overlayInputBackend?: string;
  overlayAutomationDriver?: string;
  overlayGlobalHookEnabled?: boolean;
  updatedAt?: string;
}

function getNativeCrashContextPath(): string {
  return path.join(app.getPath('userData'), NATIVE_CRASH_CONTEXT_FILENAME);
}

function readNativeCrashReporterContext(): NativeCrashReporterContext | null {
  try {
    const raw = fsSync.readFileSync(getNativeCrashContextPath(), 'utf8');
    return JSON.parse(raw) as NativeCrashReporterContext;
  } catch {
    return null;
  }
}

export function updateNativeCrashReporterContext(context: NativeCrashReporterContext): void {
  const nextContext: NativeCrashReporterContext = {
    ...context,
    updatedAt: new Date().toISOString(),
  };

  if (nextContext.eventProcess) {
    crashReporter.addExtraParameter('event.process', nextContext.eventProcess);
  }
  if (typeof nextContext.overlayRuntimeActive === 'boolean') {
    crashReporter.addExtraParameter(
      'overlay.runtime',
      nextContext.overlayRuntimeActive ? 'active' : 'inactive',
    );
  }
  if (nextContext.overlayInputBackend) {
    crashReporter.addExtraParameter('overlay.input', nextContext.overlayInputBackend);
  }
  if (nextContext.overlayAutomationDriver) {
    crashReporter.addExtraParameter('overlay.auto', nextContext.overlayAutomationDriver);
  }
  if (typeof nextContext.overlayGlobalHookEnabled === 'boolean') {
    crashReporter.addExtraParameter(
      'overlay.hook',
      nextContext.overlayGlobalHookEnabled ? 'enabled' : 'disabled',
    );
  }

  try {
    fsSync.mkdirSync(path.dirname(getNativeCrashContextPath()), { recursive: true });
    fsSync.writeFileSync(getNativeCrashContextPath(), JSON.stringify(nextContext), 'utf8');
  } catch (error) {
    console.error('[CrashReports] Failed to persist native crash context:', error);
  }
}

export function startLocalCrashReporter(): void {
  if (!app.isPackaged || process.mas) {
    return;
  }

  crashReporter.start({
    companyName: '',
    ignoreSystemCrashHandler: true,
    productName: app.name || app.getName(),
    submitURL: LOCAL_CRASH_REPORTER_SUBMIT_URL,
    uploadToServer: false,
    compress: true,
    extra: {
      'event.process': 'browser',
      'event.origin': 'native-crashpad',
      'overlay.runtime_active': 'false',
      'overlay.native_addons_loaded': 'false',
    },
  });
}

export function getCrashDumpDirectories(
  crashDumpsRoot: string,
  platform: NodeJS.Platform,
): string[] {
  const completedSubdirectory = platform === 'win32' ? 'reports' : 'completed';
  const directories = [path.join(crashDumpsRoot, completedSubdirectory)];

  if (platform === 'darwin') {
    directories.push(path.join(crashDumpsRoot, 'pending'));
  }

  return directories;
}

export async function listPendingNativeCrashDumpPaths(
  crashDumpsRoot: string,
  platform: NodeJS.Platform,
): Promise<string[]> {
  const directories = getCrashDumpDirectories(crashDumpsRoot, platform);
  const dumps: string[] = [];

  for (const directory of directories) {
    try {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.dmp')) {
          dumps.push(path.join(directory, entry.name));
        }
      }
    } catch {
      // Directory may not exist yet.
    }
  }

  dumps.sort();
  return dumps;
}

async function deleteCrashDumpPaths(dumpPaths: string[]): Promise<void> {
  await Promise.all(dumpPaths.map(async (dumpPath) => {
    try {
      await fs.unlink(dumpPath);
    } catch {
      // Best-effort cleanup only.
    }
  }));
}

export function buildNativeCrashEvent(
  dumpPath: string,
  context: NativeCrashReporterContext | null = null,
): Sentry.Event {
  const browserProcessTags = context
    ? {
        'browser_process.event_process': context.eventProcess ?? 'unknown',
        'browser_process.overlay_runtime': context.overlayRuntimeActive ? 'active' : 'inactive',
        'browser_process.overlay_input': context.overlayInputBackend ?? 'unknown',
        'browser_process.overlay_auto': context.overlayAutomationDriver ?? 'unknown',
        'browser_process.overlay_hook': context.overlayGlobalHookEnabled ? 'enabled' : 'disabled',
      }
    : {};

  return {
    level: 'fatal',
    platform: 'native',
    tags: {
      'event.environment': 'native',
      'event.process': 'unknown',
      'event.origin': 'native-crashpad',
      ...browserProcessTags,
    },
    contexts: {
      electron: {
        crash_dump: path.basename(dumpPath),
      },
      ...(context
        ? {
            browser_process: {
              eventProcess: context.eventProcess ?? null,
              overlayRuntimeActive: context.overlayRuntimeActive ?? null,
              overlayInputBackend: context.overlayInputBackend ?? null,
              overlayAutomationDriver: context.overlayAutomationDriver ?? null,
              overlayGlobalHookEnabled: context.overlayGlobalHookEnabled ?? null,
            },
          }
        : {}),
    },
  };
}

async function uploadNativeCrashReports(dumpPaths: string[]): Promise<boolean> {
  const nativeCrashContext = readNativeCrashReporterContext();
  for (const dumpPath of dumpPaths) {
    const data = await fs.readFile(dumpPath);
    Sentry.captureEvent(buildNativeCrashEvent(dumpPath, nativeCrashContext), {
      attachments: [{
        data,
        filename: path.basename(dumpPath),
        attachmentType: 'event.minidump',
      }],
    });
  }

  return Sentry.flush(5000);
}

async function showCrashDialog(
  window: BrowserWindow | null,
  options: Electron.MessageBoxOptions,
): Promise<Electron.MessageBoxReturnValue> {
  if (window) {
    return dialog.showMessageBox(window, options);
  }
  return dialog.showMessageBox(options);
}

export async function handlePendingNativeCrashReports(options: {
  window: BrowserWindow | null;
  showMainWindow: () => void;
}): Promise<void> {
  if (!app.isPackaged || process.mas) {
    return;
  }

  const crashDumpsRoot = app.getPath('crashDumps');
  const dumpPaths = await listPendingNativeCrashDumpPaths(crashDumpsRoot, process.platform);
  if (dumpPaths.length === 0) {
    return;
  }

  const telemetryEnabledSetting = await getTelemetryEnabled();
  const telemetryEnabled = telemetryEnabledSetting ?? false;
  console.warn(
    '[CrashReports] pending_native_dumps',
    `count=${dumpPaths.length}`,
    `telemetry=${formatTelemetrySettingState(telemetryEnabledSetting)}`,
    `dumps=${listCrashDumpBasenamesForLog(dumpPaths)}`,
  );

  if (!telemetryEnabled) {
    console.warn(
      '[CrashReports] upload_skipped',
      `reason=telemetry_${formatTelemetrySettingState(telemetryEnabledSetting)}`,
      `count=${dumpPaths.length}`,
    );
    const result = await showCrashDialog(options.window, {
      type: 'warning',
      buttons: [t('crashReport.okButton'), t('crashReport.openSettingsButton')],
      defaultId: 0,
      cancelId: 0,
      title: t('crashReport.disabledTitle'),
      message: t('crashReport.disabledMessage'),
      detail: t('crashReport.disabledDetail'),
      noLink: true,
    });

    await deleteCrashDumpPaths(dumpPaths);
    console.log('[CrashReports] local_dumps_deleted', `reason=telemetry_skip`, `count=${dumpPaths.length}`);

    if (result.response === 1) {
      console.log('[CrashReports] settings_opened', 'source=telemetry_disabled_dialog');
      options.showMainWindow();
      emitOpenSettings(options.window);
    }
    return;
  }

  console.log('[CrashReports] upload_prompted', `count=${dumpPaths.length}`);
  const consent = await showCrashDialog(options.window, {
    type: 'question',
    buttons: [t('common.cancel'), t('crashReport.sendButton')],
    defaultId: 0,
    cancelId: 0,
    title: t('crashReport.consentTitle'),
    message: t('crashReport.consentMessage'),
    detail: t('crashReport.consentDetail'),
    noLink: true,
  });

  if (consent.response !== 1) {
    console.log('[CrashReports] upload_canceled', `count=${dumpPaths.length}`);
    await deleteCrashDumpPaths(dumpPaths);
    console.log('[CrashReports] local_dumps_deleted', `reason=user_canceled`, `count=${dumpPaths.length}`);
    return;
  }

  console.log('[CrashReports] upload_started', `count=${dumpPaths.length}`);
  let sent = false;
  try {
    sent = await uploadNativeCrashReports(dumpPaths);
  } catch (error) {
    console.error('[CrashReports] Failed to upload native crash report:', error);
  }

  if (!sent) {
    console.error('[CrashReports] upload_failed', `count=${dumpPaths.length}`, 'retainingDumps=true');
    await showCrashDialog(options.window, {
      type: 'error',
      buttons: [t('crashReport.okButton')],
      defaultId: 0,
      cancelId: 0,
      title: t('crashReport.sendFailedTitle'),
      message: t('crashReport.sendFailedMessage'),
      detail: t('crashReport.sendFailedDetail'),
      noLink: true,
    });
    return;
  }

  await deleteCrashDumpPaths(dumpPaths);
  console.log('[CrashReports] upload_sent', `count=${dumpPaths.length}`, 'deletedLocalDumps=true');

  await showCrashDialog(options.window, {
    type: 'info',
    buttons: [t('crashReport.okButton')],
    defaultId: 0,
    cancelId: 0,
    title: t('crashReport.sentTitle'),
    message: t('crashReport.sentMessage'),
    detail: t('crashReport.sentDetail'),
    noLink: true,
  });
}
