import { app, BrowserWindow, protocol, nativeTheme, net, nativeImage, dialog, session, Tray, Menu, screen } from 'electron';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import fs from 'fs';
import util from 'node:util';
import fixPath from 'fix-path';
import * as Sentry from '@sentry/electron/main';
import { handlePendingNativeCrashReports, startLocalCrashReporter } from './crashReports';
import { getCurrentProcessPortCleanupExclusions, killPortProcessSync } from './utils/ports';
import {
  listenOnAvailableLocalPort,
} from './utils/localServerPort';
import { destroyTraySafely, shouldKeepAppResident } from './utils/windowCloseBehavior';
import {
  buildMainProcessFatalErrorHandler,
  configureMainProcessSentryIntegrations,
  getMainProcessBeforeSendTelemetry,
  sanitizeCodexSentryEvent,
} from './utils/codexSentry';
import {
  MAIN_PROCESS_SENTRY_IGNORE_ERRORS,
  MAIN_PROCESS_UNHANDLED_REJECTION_IGNORE_MATCHERS,
} from './utils/transientNetworkErrors';
import {
  buildWindowBootstrapLayoutArg,
  buildWindowSessionKeyArg,
} from './windowSessionArgs';
import { isTrustedAppRendererUrl } from './ipc/trustedRenderer';
import {
  shouldTrackOoEditorsMainRendererGone,
} from './services/office-extension-exit';
import {
  classifyMainWindowLoadFailure,
  isMainWindowLoadAbortError,
  waitForMainWindowLoadRecovery,
} from './utils/mainWindowLoad';
import { getGpuStartupPolicy, getMacWindowAppearance } from './utils/macWindowAppearance';
import { initializeCreatedWindow } from './utils/windowInitialization';
import {
  classifyExternalOpenPath,
  createExternalAskRequest,
  findExternalAskTargetsInArgv,
  findExternalOpenTargetInArgv,
  resolveFolderOpenWindowTarget,
} from './utils/externalOpen';
import {
  initializeRuntimeLogFilePath,
  resetCurrentRuntimeLogFilePath,
  setCurrentRuntimeLogFilePath,
} from './utils/runtimeLogFile';
import {
  createDefaultLogPath,
} from './utils/defaultLogPath';
import { clampZoomFactor } from './utils/zoom';
import { isInternal, isUpdating } from './autoUpdater';
import { t, initI18nMain } from './i18n';
import { attachConsoleSinkGuards, invokeConsoleSafely } from './utils/safeConsoleWrite';
import { WORKSTATION_SENTRY_DSN } from '../shared/constants/sentry';
import { isOfficeExtensionSupportedPlatform } from '../shared/constants/interpreter-overlay-platform';
import { ACTIVE_BRAND } from '../shared/branding';
import { registerElectronAppLifecycle } from './electron-lifecycle';
import { ensureOfficeExtensionInstalledInBackground } from './services/office-extension-startup';
import { WINDOWS_APP_USER_MODEL_ID } from './utils/windowsAppConfig';
import { APP_VERSION } from '../shared/version';
import { distributionProductConfig } from '../shared/productConfig';

const originalConsole = {
  log: console.log,
  error: console.error,
  warn: console.warn,
  info: console.info,
  debug: console.debug,
};

attachConsoleSinkGuards({
  stdout: process.stdout,
  stderr: process.stderr,
});

// =============================================================================
// FIX PATH - Inherit user's shell PATH in packaged Electron apps
// Must be called early, before anything that might need PATH (like spawning claude)
// =============================================================================
fixPath();

function getRendererMaxOldSpaceSizeMb(): number {
  const totalBytes = os.totalmem();
  const totalGb = totalBytes / (1024 ** 3);
  if (totalGb <= 4) return 512;
  if (totalGb <= 8) return 1024;
  return 2048;
}

function applyExplicitInterpreterUserDataDir(): void {
  const explicitUserDataDir = process.env.INTERPRETER_USER_DATA_DIR?.trim();
  if (!explicitUserDataDir) {
    return;
  }

  fs.mkdirSync(explicitUserDataDir, { recursive: true });
  app.setPath('userData', explicitUserDataDir);
  app.setPath('sessionData', explicitUserDataDir);
}

applyExplicitInterpreterUserDataDir();

// =============================================================================
// SENTRY - Handles JS error reporting.
// Native crash dumps are kept local first, then explicitly uploaded on the next
// launch only after the user approves the report dialog.
// =============================================================================
const WORKSTATION_PARTITION = 'persist:workstation';

function logBootstrapError(...args: unknown[]): void {
  invokeConsoleSafely(originalConsole.error, args, 'stderr');
}

const sentryEnvironment = !app.isPackaged ? 'development' : isInternal ? 'internal' : 'production';

Sentry.init({
  dsn: WORKSTATION_SENTRY_DSN,
  environment: sentryEnvironment,
  enabled: app.isPackaged && Boolean(WORKSTATION_SENTRY_DSN),
  // Renderers run in a custom partition, so Sentry must register sentry-ipc:// there too.
  getSessions: () => [session.defaultSession, session.fromPartition(WORKSTATION_PARTITION)],
  release: `interpreter-workstation@${app.getVersion()}`,
  ignoreErrors: MAIN_PROCESS_SENTRY_IGNORE_ERRORS,
  beforeSend: (event, hint) => {
    const sanitized = sanitizeCodexSentryEvent(event, hint);
    if (!sanitized) {
      return null;
    }
    const telemetry = getMainProcessBeforeSendTelemetry(sanitized);

    if (telemetry) {
      logBootstrapError('[Main] Unhandled rejection:', telemetry.error);
      import('../server/telemetry').then(({ trackError }) => {
        trackError(telemetry.errorType, telemetry.error, telemetry.context);
      }).catch(() => {});
    }

    return sanitized;
  },
  onFatalError: buildMainProcessFatalErrorHandler({
    exitProcess: (code) => {
      process.exit(code);
    },
    logBootstrapError,
  }),
  // NOTE(victor): Keep Sentry as the sole owner of main-process global error
  // capture. Electron main enables `OnUncaughtException` and Node
  // `OnUnhandledRejection` by default, so replace the default rejection
  // integration instead of mirroring `process.on(...)` handlers locally.
  //
  // `GpuContext` still must be removed because it lazily calls
  // `app.getGPUInfo()`, creating a C++ Promise (gin_helper::PromiseBase) that
  // can outlive the V8 isolate during shutdown and cause EXC_BAD_ACCESS in
  // GlobalHandles::Destroy.
  integrations: (defaults) => configureMainProcessSentryIntegrations(
    defaults,
    Sentry.onUnhandledRejectionIntegration,
    MAIN_PROCESS_UNHANDLED_REJECTION_IGNORE_MATCHERS,
    Sentry.rendererEventLoopBlockIntegration,
  ),
});

startLocalCrashReporter();

// Set environment for server-side Sentry (read before server module loads)
process.env.SENTRY_ENVIRONMENT = sentryEnvironment;

function addPortCleanupBreadcrumb(context: string, ports: number[]): void {
  Sentry.addBreadcrumb({
    category: 'app.lifecycle',
    message: context,
    level: 'info',
    data: { ports },
  });
}

function addBrowserExtensionRelayBreadcrumb(event: BrowserExtensionRelayLifecycleEvent): void {
  Sentry.addBreadcrumb({
    category: 'browser-extension-relay',
    message: event.message,
    level: event.level,
    data: event.data,
  });
}

type MainWindowLaunchEvent =
  | 'create-window-start'
  | 'browser-window-created'
  | 'load-target-selected'
  | 'ready-to-show'
  | 'did-start-loading'
  | 'dom-ready'
  | 'did-stop-loading'
  | 'did-finish-load'
  | 'did-fail-load'
  | 'load-threw';

type MainWindowLaunchState = {
  background: boolean;
  currentUrl: string | null;
  errorCode: number | null;
  errorDescription: string | null;
  isMainFrame: boolean | null;
  isPrimaryWindow: boolean;
  lastEvent: MainWindowLaunchEvent;
  loadTarget: 'vite-dev-server' | 'built-server-url' | 'dist-file' | null;
  sessionKey: string;
  targetUrl: string | null;
  updatedAt: string;
  validatedUrl: string | null;
  webContentsId: number | null;
  windowId: number | null;
};

let mainWindowLaunchState: MainWindowLaunchState | null = null;

function addMainWindowLaunchBreadcrumb(
  event: MainWindowLaunchEvent,
  data: Record<string, unknown>,
  level: Sentry.SeverityLevel = 'info',
): void {
  Sentry.addBreadcrumb({
    category: 'app.main-window',
    data,
    level,
    message: event,
  });
}

function updateMainWindowLaunchState(
  event: MainWindowLaunchEvent,
  data: Partial<Omit<MainWindowLaunchState, 'lastEvent' | 'updatedAt'>>,
  level: Sentry.SeverityLevel = 'info',
): void {
  const nextState: MainWindowLaunchState = {
    background: data.background === undefined ? (mainWindowLaunchState?.background ?? false) : data.background,
    currentUrl: data.currentUrl === undefined ? (mainWindowLaunchState?.currentUrl ?? null) : data.currentUrl,
    errorCode: data.errorCode === undefined ? (mainWindowLaunchState?.errorCode ?? null) : data.errorCode,
    errorDescription: data.errorDescription === undefined
      ? (mainWindowLaunchState?.errorDescription ?? null)
      : data.errorDescription,
    isMainFrame: data.isMainFrame === undefined ? (mainWindowLaunchState?.isMainFrame ?? null) : data.isMainFrame,
    isPrimaryWindow: data.isPrimaryWindow === undefined
      ? (mainWindowLaunchState?.isPrimaryWindow ?? false)
      : data.isPrimaryWindow,
    lastEvent: event,
    loadTarget: data.loadTarget === undefined ? (mainWindowLaunchState?.loadTarget ?? null) : data.loadTarget,
    sessionKey: data.sessionKey === undefined ? (mainWindowLaunchState?.sessionKey ?? 'unknown') : data.sessionKey,
    targetUrl: data.targetUrl === undefined ? (mainWindowLaunchState?.targetUrl ?? null) : data.targetUrl,
    updatedAt: new Date().toISOString(),
    validatedUrl: data.validatedUrl === undefined ? (mainWindowLaunchState?.validatedUrl ?? null) : data.validatedUrl,
    webContentsId: data.webContentsId === undefined
      ? (mainWindowLaunchState?.webContentsId ?? null)
      : data.webContentsId,
    windowId: data.windowId === undefined ? (mainWindowLaunchState?.windowId ?? null) : data.windowId,
  };

  mainWindowLaunchState = nextState;
  addMainWindowLaunchBreadcrumb(event, nextState, level);
}

function resetMainWindowLaunchFailure(): Partial<Omit<MainWindowLaunchState, 'lastEvent' | 'updatedAt'>> {
  return {
    errorCode: null,
    errorDescription: null,
    isMainFrame: null,
    validatedUrl: null,
  };
}

setBrowserExtensionRelayLifecycleListener(addBrowserExtensionRelayBreadcrumb);

// NOTE(victor): electron-builder's NSIS installer kills only the main Electron process by exe name.
// Child processes (oo-editors on 38123, tool servers on 3333/8089) are NOT killed - they are orphaned.
// Clean them up on startup so the new instance can bind its ports.
killPortProcessSync([3333, 38123, 8089], {
  breadcrumbContext: 'startup port cleanup',
  addBreadcrumb: addPortCleanupBreadcrumb,
  excludePids: getCurrentProcessPortCleanupExclusions(),
});

// Built renderer runs load the app from file:// URLs, so Chromium needs explicit
// permission to fetch sibling JS/CSS assets from the same local dist directory.
const useBuiltRenderer = process.env.INTERPRETER_USE_BUILT_RENDERER === 'true';
if (useBuiltRenderer) {
  app.commandLine.appendSwitch('allow-file-access-from-files');
}

// =============================================================================
// GPU STARTUP POLICY
//
// We only force GPU features on transparent macOS launches where vibrancy needs
// WebGL-backed compositing. Every other platform should prefer the stable path.
//
// Linux and Windows need both switches below when GPU features are off:
// - disable-gpu stops the hardware GPU path
// - disable-software-rasterizer stops Chromium's SwiftShader/Vulkan fallback
//
// That second switch matters because we have a real crash class where the GPU
// subprocess still reaches ANGLE Vulkan init under software fallback and dies
// inside vkCreateDevice on user machines with OBS/Bandicam Vulkan hooks loaded,
// and another where Linux browser processes abort with "GPU process isn't usable".
// =============================================================================
const gpuStartupPolicy = getGpuStartupPolicy({
  platform: process.platform,
  disableMacTransparencyEnv: process.env.INTERPRETER_DISABLE_MAC_TRANSPARENCY,
  forceMacTransparencyEnv: process.env.INTERPRETER_FORCE_MAC_TRANSPARENCY,
  forceGpuFeaturesEnv: process.env.INTERPRETER_FORCE_GPU_FEATURES,
  disableForcedGpuFeaturesEnv: process.env.INTERPRETER_DISABLE_FORCED_GPU_FEATURES,
  machineRunDirEnv: process.env.INTERPRETER_MACHINE_RUN_DIR,
});

for (const commandLineSwitch of gpuStartupPolicy.commandLineSwitches) {
  app.commandLine.appendSwitch(commandLineSwitch);
}

if (gpuStartupPolicy.disableHardwareAcceleration) {
  app.disableHardwareAcceleration();
}

// NOTE(victor): Disable QUIC (HTTP/3 over UDP) to prevent net::ERR_QUIC_PROTOCOL_ERROR.
// QUIC fails silently behind firewalls, VPNs, and corporate proxies that block/throttle UDP.
// Falling back to HTTP/2 over TCP is strictly more reliable for desktop apps.
// See: https://github.com/SnosMe/awakened-poe-trade/issues/1555 (Electron app, same error)
// See: https://github.com/vsezol/fairhire (Electron: same appendSwitch pattern)
// See: https://github.com/Automattic/wp-calypso (Playwright: --disable-quic launch arg)
app.commandLine.appendSwitch('disable-quic');

// NOTE(victor): Linux utility-process crashes in c-ares/getaddrinfo can originate from
// Chromium's built-in AsyncDns resolver. Disable AsyncDns on Linux so Chromium falls back
// to the OS resolver path, which avoids this crash class.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('disable-features', 'AsyncDns');
  // NOTE(victor): Keep Linux on Chromium's `ozone-platform-hint=auto` by default.
  // Sentry issue #885 showed Wayland display errors can fatal in WaylandEventWatcher,
  // and `auto` lets Chromium prefer Wayland only when the session is functional.
  //
  // GitHub issue #1215 / Sentry issue 7460849874 is a separate native
  // browser-process SIGSEGV in base::MessagePumpGlib::Run from CachyOS/rolling
  // Linux; the reported os.build contains `-1-cachyos ...` on Electron 39.8.8.
  // Force X11 only for that kernel family so the existing Wayland-auto policy
  // remains unchanged.
  // See: https://github.com/openinterpreter/iworkstation/issues/1215
  app.commandLine.appendSwitch('ozone-platform-hint', os.release().toLowerCase().includes('cachyos') ? 'x11' : 'auto');

  // NOTE(victor): Ubuntu 24.04 enables `kernel.apparmor_restrict_unprivileged_userns=1`,
  // which denies the user namespace Chromium's renderer sandbox needs. The `.deb` build
  // installs an AppArmor `userns` profile and configures `chrome-sandbox` at install time
  // (see electron-builder.yml `appArmorProfile`), so the sandbox keeps working there. AppImage
  // has no post-install hook, so it gets neither and the renderer SIGSEGVs during Node/V8
  // bootstrap (exit 139, "ERR_FAILED (-2)" loading index.html). Disable the sandbox only
  // for the AppImage build (APPIMAGE is set by the AppImage runtime), where it
  // is the sole runtime-available fix.
  //
  // Prior art for "disable the sandbox only where it cannot be set up properly":
  // - VS Code's snap launches with --no-sandbox because snap confinement replaces it
  //   (microsoft/vscode resources/linux/snap/snapcraft.yaml: `command: ... --no-sandbox`).
  // - ipfs-desktop and Eugeny/tabby bake `linux.executableArgs: [--no-sandbox]` into
  //   every Linux build (ipfs/ipfs-desktop electron-builder.yml, Eugeny/tabby electron-builder.yml).
  // We scope to AppImage instead, so the .deb keeps the real AppArmor-backed sandbox
  // (stricter than disabling it for all Linux targets). Note VS Code and Signal ship no
  // AppImage at all -- they only distribute deb/rpm/snap/tar.gz, which can set the sandbox up.
  // See: https://github.com/openinterpreter/iworkstation/issues/1397
  // See: https://github.com/electron/electron/issues/41066
  if (process.env.APPIMAGE) {
    app.commandLine.appendSwitch('no-sandbox');
  }
}

// Enable Chrome-wide echo cancellation so that Chromium's AEC uses all audio
// output from this process (including Remotion iframe playback) as the reference
// signal, preventing speaker audio from being picked up by the STT microphone.
//
// NOTE(victor): DocumentPolicyIncludeJSCallStacksInCrashReports makes Chromium
// include JavaScript call stacks in native crash minidumps, so V8 GC/builtins
// crashes (groups #1-#2) get actionable JS context after Sentry symbolication.
// Reference: VS Code (microsoft/vscode) enables this same flag in src/main.ts
// for crash diagnostics.
app.commandLine.appendSwitch('enable-features', [
  'ChromeWideEchoCancellation',
  'DocumentPolicyIncludeJSCallStacksInCrashReports',
].join(','));

// The Interpreter Overlay window hides by dropping to opacity 0 while staying
// "visible", so macOS reports it occluded. Chromium then suspends that
// renderer (timers, rAF, IPC-driven rendering) even with
// backgroundThrottling: false, and the next hotkey open shows a wedged,
// blank overlay until the visual-health watchdog recreates the window.
// Disabling occlusion-based backgrounding keeps the always-on-top overlay
// renderer responsive while it is transparent.
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

const forcedAppName = process.env.INTERPRETER_APP_NAME?.trim();
app.setName(forcedAppName || (isInternal ? `${ACTIVE_BRAND.appName} Internal` : ACTIVE_BRAND.appName));

// Surface the real app version in the native "About" panel (macOS/Linux). Without
// this, the panel falls back to app.getVersion(), which in dev reports the Electron
// framework version instead of the Interpreter release version.
app.setAboutPanelOptions({
  applicationName: app.name,
  applicationVersion: APP_VERSION,
  version: APP_VERSION,
  copyright: `©${new Date().getFullYear()} Open Interpreter Inc. All rights reserved.`,
});

if (process.platform === 'win32') {
  // Keep this in sync with product.json win32AppUserModelId so Windows groups
  // native notifications under the app instead of Electron's default app identity.
  app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID);
}

// NOTE(victor): Windows 11 = NT 10.0 build >= 22000, Windows 10 tops out at 19045.
// Build number check is the only reliable discriminator -- the supportedOS manifest GUID
// is shared between Win10 and Win11. Pattern from Notepad++ (NSIS), mica-electron,
// sindresorhus/windows-release, and Discord -- all converge on this approach.
// See: https://github.com/nicedoc/windows-release, https://github.com/GregVido/mica-electron
// if (process.platform === 'win32') {
//   const build = parseInt(os.release().split('.')[2], 10);
//   if (isNaN(build) || build < 22000) {
//     dialog.showErrorBox(
//       'Unsupported Operating System',
//       `This application requires Windows 11 (build 22000+).\nDetected: ${os.release()}`
//     );
//     app.exit(1);
//   }
// }

// =============================================================================
// UNIFIED LOGGING - ONE file for EVERYTHING (electron, server, renderer)
//
// - Test harness sets LOG_FILE env var to control where logs go
// - Otherwise we create a default log file
// - Tests use __testLogging.setLogFile() to redirect per-test
// =============================================================================

function getPackagedLogDir(): string {
  app.setAppLogsPath(path.join(app.getPath('userData'), 'logs'));
  return app.getPath('logs');
}

function createMainDefaultLogPath(): string {
  return createDefaultLogPath({
    devDirname: __dirname,
    getPackagedLogDir,
    isPackaged: app.isPackaged,
  });
}

const LOG_FILE = process.env.LOG_FILE || createMainDefaultLogPath();
initializeRuntimeLogFilePath(LOG_FILE);
process.env.INTERPRETER_USER_DATA_DIR = app.getPath('userData');

// Share with server via env var (server/logger.ts reads this)
process.env.LOG_FILE = LOG_FILE;

// Current log file (can be changed by tests)
let currentLogFile = LOG_FILE;

const REDACTED = '[REDACTED]';

const SENSITIVE_LOG_KEYS = new Set([
  'apikey',
  'xapikey',
  'accesstoken',
  'refreshtoken',
  'authtoken',
  'oauthtoken',
  'authorization',
  'clientsecret',
  'sessiontoken',
  'password',
  'secret',
  'jwt',
]);

function isSensitiveLogKey(key: string): boolean {
  const normalizedKey = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return SENSITIVE_LOG_KEYS.has(normalizedKey);
}

function redactSensitiveText(text: string): string {
  let redacted = text;

  redacted = redacted.replace(
    /((?:["'`]?)(?:api[_-]?key|x-api-key|access[_-]?token|refresh[_-]?token|auth[_-]?token|oauth[_-]?token|authorization|client[_-]?secret|session[_-]?token|password|secret)(?:["'`]?)\s*[:=]\s*)(["'`]?)[^"'`,\s}\]]+\2/gi,
    (_match, prefix: string, quote: string) => `${prefix}${quote}${REDACTED}${quote}`
  );

  redacted = redacted.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi, `Bearer ${REDACTED}`);
  redacted = redacted.replace(/\bsk-ant-[A-Za-z0-9_-]+\b/g, REDACTED);
  redacted = redacted.replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, REDACTED);
  redacted = redacted.replace(/([?&](?:access_token|refresh_token|api_key|apikey|token)=)[^&\s]+/gi, `$1${REDACTED}`);

  return redacted;
}

function sanitizeForLogging(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return redactSensitiveText(value);
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactSensitiveText(value.message),
      stack: redactSensitiveText(value.stack || ''),
    };
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map(item => sanitizeForLogging(item, seen));
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (isSensitiveLogKey(key)) {
      sanitized[key] = REDACTED;
      continue;
    }
    sanitized[key] = sanitizeForLogging(nestedValue, seen);
  }

  return sanitized;
}

function sanitizeLogArgs(args: unknown[]): unknown[] {
  const seen = new WeakSet<object>();
  return args.map(arg => sanitizeForLogging(arg, seen));
}

function writeLog(level: string, ...args: unknown[]) {
  const sanitizedArgs = sanitizeLogArgs(args);
  const msg = sanitizedArgs
    .map(a => typeof a === 'string' ? a : util.inspect(a, { depth: 10, colors: false }))
    .map(part => redactSensitiveText(part))
    .join(' ');
  const line = `[${new Date().toISOString()}] [BACKEND_${level}] ${msg}\n`;
  try {
    fs.appendFileSync(currentLogFile, line);
  } catch {
    // Silent fail
  }
}

// Test logging: redirect ALL logs to a specific file
function setLogFile(logFilePath: string): void {
  currentLogFile = logFilePath;
  // Also update env var so server picks it up if it re-reads
  process.env.LOG_FILE = logFilePath;
  setCurrentRuntimeLogFilePath(logFilePath);
  setAgentLogFile(logFilePath);
  writeLog('LOG', `=== Log file set to: ${logFilePath} ===`);
}

function resetLogFile(): void {
  writeLog('LOG', '=== Resetting log file ===');
  currentLogFile = LOG_FILE;
  process.env.LOG_FILE = LOG_FILE;
  resetCurrentRuntimeLogFilePath();
  setAgentLogFile(LOG_FILE);
}

function getLogFile(): string {
  return currentLogFile;
}

// Expose for Playwright tests via electronApp.evaluate()
(global as any).__testLogging = { setLogFile, resetLogFile, getLogFile };

// =============================================================================
// AGENT LOGGING - Minimal log of LLM-visible conversation
// Shows only: system prompts, visible skills, user/assistant messages, tool calls/results
// Uses XML tags for context efficiency
// =============================================================================

let currentAgentLogFile: string | null = null;
let currentAgentEventLogFile: string | null = null;
let agentIndentLevel = 0;

function getAgentIndent(): string {
  return '  '.repeat(agentIndentLevel);
}

function resolveAgentSiblingLogPath(logFilePath: string, suffix: string): string {
  return logFilePath.endsWith('.log')
    ? `${logFilePath.slice(0, -4)}${suffix}`
    : `${logFilePath}${suffix}`;
}

function agentLogLine(line: string): void {
  if (!currentAgentLogFile) return;
  try {
    fs.appendFileSync(currentAgentLogFile, getAgentIndent() + line + '\n');
  } catch {
    // Silent fail
  }
}

function agentLogRaw(text: string): void {
  if (!currentAgentLogFile) return;
  try {
    fs.appendFileSync(currentAgentLogFile, text);
  } catch {
    // Silent fail
  }
}

function setAgentLogFile(logFilePath: string): void {
  currentAgentLogFile = resolveAgentSiblingLogPath(logFilePath, '.agent.log');
  currentAgentEventLogFile = resolveAgentSiblingLogPath(logFilePath, '.agent-events.jsonl');
  agentIndentLevel = 0;
  try {
    fs.writeFileSync(currentAgentLogFile, '');
  } catch {
    // Silent fail
  }
  try {
    fs.writeFileSync(currentAgentEventLogFile, '');
  } catch {
    // Silent fail
  }
}

function resetAgentLogFile(): void {
  currentAgentLogFile = null;
  currentAgentEventLogFile = null;
  agentIndentLevel = 0;
}

function getAgentLogFile(): string | null {
  return currentAgentLogFile;
}

function getAgentEventLogFile(): string | null {
  return currentAgentEventLogFile;
}

function logAgentSystem(content: string): void {
  agentLogLine('<system>');
  redactSensitiveText(content).split('\n').forEach(line => agentLogLine(line));
  agentLogLine('</system>');
  agentLogRaw('\n');
  logAgentTranscriptEvent('system', { content });
}

function logAgentSkills(skills: Array<{ name: string; description: string; path: string; scope: string }>): void {
  agentLogLine('<skills>');
  for (const skill of skills) {
    agentLogLine('<skill>');
    agentLogLine(`  <name>${redactSensitiveText(skill.name)}</name>`);
    agentLogLine(`  <scope>${redactSensitiveText(skill.scope)}</scope>`);
    agentLogLine(`  <path>${redactSensitiveText(skill.path)}</path>`);
    if (skill.description) {
      agentLogLine(`  <description>${redactSensitiveText(skill.description)}</description>`);
    }
    agentLogLine('</skill>');
    agentLogRaw('\n');
  }
  agentLogLine('</skills>');
  agentLogRaw('\n');
  logAgentTranscriptEvent('skills', { skills });
}

function logAgentTools(tools: Array<{ name: string; description: string; inputSchema: any }>): void {
  agentLogLine('<tools>');
  for (const tool of tools) {
    agentLogLine(`<tool name="${tool.name}">`);
    agentLogLine(`  <description>${tool.description}</description>`);
    if (tool.inputSchema) {
      agentLogLine('  <parameters>');
      const schemaStr = JSON.stringify(tool.inputSchema, null, 2);
      schemaStr.split('\n').forEach(line => agentLogLine(`    ${line}`));
      agentLogLine('  </parameters>');
    }
    agentLogLine('</tool>');
    agentLogRaw('\n');
  }
  agentLogLine('</tools>');
  agentLogRaw('\n');
  logAgentTranscriptEvent('tools', { tools });
}

function logAgentUser(content: string): void {
  agentLogLine('<user>');
  redactSensitiveText(content).split('\n').forEach(line => agentLogLine(line));
  agentLogLine('</user>');
  agentLogRaw('\n');
  logAgentTranscriptEvent('user', { content });
}

function logAgentAssistant(content: string): void {
  agentLogLine('<assistant>');
  redactSensitiveText(content).split('\n').forEach(line => agentLogLine(line));
  agentLogLine('</assistant>');
  agentLogRaw('\n');
  logAgentTranscriptEvent('assistant', { content });
}

function logAgentReasoning(content: string): void {
  agentLogLine('<reasoning>');
  redactSensitiveText(content).split('\n').forEach(line => agentLogLine(line));
  agentLogLine('</reasoning>');
  agentLogRaw('\n');
  logAgentTranscriptEvent('reasoning', { content });
}

function logAgentToolCall(toolName: string, input: any): void {
  const inputStr = redactSensitiveText(typeof input === 'string' ? input : JSON.stringify(input, null, 2));
  agentLogLine(`<tool_call name="${toolName}">`);
  inputStr.split('\n').forEach(line => agentLogLine(line));
  agentLogLine('</tool_call>');
  agentLogRaw('\n');
  logAgentTranscriptEvent('tool_call', { toolName, input });
}

function logAgentToolResult(toolName: string, output: any, isError: boolean = false): void {
  const outputStr = redactSensitiveText(typeof output === 'string' ? output : JSON.stringify(output, null, 2));
  const tag = isError ? 'tool_error' : 'tool_result';
  agentLogLine(`<${tag} name="${toolName}">`);

  const lines = outputStr.split('\n');
  const maxLines = 100;
  if (lines.length > maxLines) {
    lines.slice(0, maxLines).forEach(line => agentLogLine(line));
    agentLogLine(`... (${lines.length - maxLines} more lines truncated)`);
  } else {
    lines.forEach(line => agentLogLine(line));
  }
  agentLogLine(`</${tag}>`);
  agentLogRaw('\n');
  logAgentTranscriptEvent(isError ? 'tool_error' : 'tool_result', {
    toolName,
    output,
  });
}

function startAgentSubagent(agentName: string, task: string): void {
  agentLogLine(`<subagent name="${agentName}">`);
  agentIndentLevel++;
  logAgentTranscriptEvent('subagent_start', { agentName, task });
}

function endAgentSubagent(): void {
  agentIndentLevel = Math.max(0, agentIndentLevel - 1);
  agentLogLine('</subagent>');
  agentLogRaw('\n');
  logAgentTranscriptEvent('subagent_end', {});
}

function logAgentEvent(payload: unknown): void {
  if (!currentAgentEventLogFile) return;

  const seen = new WeakSet<object>();
  const sanitizedPayload = sanitizeForLogging(payload, seen);
  const record = sanitizedPayload && typeof sanitizedPayload === 'object' && !Array.isArray(sanitizedPayload)
    ? { timestamp: new Date().toISOString(), ...(sanitizedPayload as Record<string, unknown>) }
    : { timestamp: new Date().toISOString(), event: sanitizedPayload };

  try {
    fs.appendFileSync(currentAgentEventLogFile, `${JSON.stringify(record)}\n`);
  } catch {
    // Silent fail
  }
}

function logAgentTranscriptEvent(type: string, payload: Record<string, unknown>): void {
  logAgentEvent({
    kind: 'transcript',
    type,
    ...payload,
  });
}

// Expose agent logging globally
(global as any).__agentLogging = {
  setLogFile: setAgentLogFile,
  resetLogFile: resetAgentLogFile,
  getLogFile: getAgentLogFile,
  getEventLogFile: getAgentEventLogFile,
  logSystem: logAgentSystem,
  logSkills: logAgentSkills,
  logTools: logAgentTools,
  logUser: logAgentUser,
  logAssistant: logAgentAssistant,
  logReasoning: logAgentReasoning,
  logToolCall: logAgentToolCall,
  logToolResult: logAgentToolResult,
  startSubagent: startAgentSubagent,
  endSubagent: endAgentSubagent,
  logEvent: logAgentEvent,
};

setAgentLogFile(currentLogFile);

// Override console methods to write to log file
console.log = function(...args: any[]) {
  const sanitizedArgs = sanitizeLogArgs(args);
  invokeConsoleSafely(originalConsole.log, sanitizedArgs, 'stdout');
  writeLog('LOG', ...sanitizedArgs);
};
console.error = function(...args: any[]) {
  const sanitizedArgs = sanitizeLogArgs(args);
  invokeConsoleSafely(originalConsole.error, sanitizedArgs, 'stderr');
  writeLog('ERROR', ...sanitizedArgs);
};
console.warn = function(...args: any[]) {
  const sanitizedArgs = sanitizeLogArgs(args);
  invokeConsoleSafely(originalConsole.warn, sanitizedArgs, 'stderr');
  writeLog('WARN', ...sanitizedArgs);
};
console.info = function(...args: any[]) {
  const sanitizedArgs = sanitizeLogArgs(args);
  invokeConsoleSafely(originalConsole.info, sanitizedArgs, 'stdout');
  writeLog('INFO', ...sanitizedArgs);
};
console.debug = function(...args: any[]) {
  const sanitizedArgs = sanitizeLogArgs(args);
  invokeConsoleSafely(originalConsole.debug, sanitizedArgs, 'stdout');
  writeLog('DEBUG', ...sanitizedArgs);
};

// Print log file location on startup
invokeConsoleSafely(originalConsole.log, [`\n${'='.repeat(60)}`], 'stdout');
invokeConsoleSafely(originalConsole.log, [`  LOG FILE: ${LOG_FILE}`], 'stdout');
invokeConsoleSafely(originalConsole.log, [`${'='.repeat(60)}\n`], 'stdout');

import { app as expressApp, toolManager, setServerPort, approvalManager, agentTabManager, initializeFileWatcher, cleanupFileWatcher } from '../server/server';
import { shutdownCuaDriverProcesses } from '../server/tools/builtin-tools/cua-driver/tools';
import {
  startInterpreterCliSocketServer,
  type InterpreterCliSocketServerHandle,
} from '../server/utils/interpreterCliSocketServer';
import {
  startInterpreterCliFileBridge,
  type InterpreterCliFileBridgeHandle,
} from '../server/utils/interpreterCliFileBridge';
import {
  getTheme,
  getLanguage,
  getBooleanUISetting,
  getZoomFactor,
  setZoomFactor,
  incrementAppLaunchCount,
} from '../server/configStore';
import { broadcastEvent } from '../server/handlers/broadcast';
import { globalFileAccessResolver } from '../server/globalFileAccessResolver';
import { setupIpcHandlers } from './ipc/handlers';
import { emitWorkspaceChanged as emitWorkspaceChangedEvent, emitWindowFullscreenChanged } from './ipc/events';
import { IPC_CHANNELS } from './ipc/registry';
import { thumbnailService } from '../server/thumbnailService';
import { validateRipgrepBinary } from '../server/utils/ripgrep';
import {
  noteAppChildProcessGone,
  noteSecondInstanceHandoff,
  shutdownOfficeExtension,
} from './services/office-extension';
import {
  ensureBrowserExtensionRelayRunning,
  formatOptionalBrowserExtensionRelayStartupFailureLog,
  setBrowserExtensionRelayLifecycleListener,
  shutdownBrowserExtensionRelay,
} from './services/browser-extension-relay';
import { ensureShellIntegrationInstalled } from './services/shell-integration';
import type { BrowserExtensionRelayLifecycleEvent } from '../server/utils/browserExtensionRelay';
import { browserService } from './services/browser';
import { workstationService } from './services/workstation';
import { shutdownCodexRuntime } from '../src/lib/codex/service';
import { buildApplicationMenu, setCreateWindowHandler } from './menu';
import { buildInterpreterTrayMenuTemplate } from './trayMenu';
import { initAutoUpdater } from './autoUpdater';
import { InterpreterOverlayService, type InterpreterOverlayTrayState } from '../apps/interpreter-overlay/electron/service';
import { FormTestsDebugServer } from '../apps/interpreter-overlay/electron/form-tests-debug-server';
import { getCurrentWorkspace, resolveWorkspacePath } from '../server/utils/workspace';
import {
  getWindowSessionByWindowId,
  getWindowSessionKeyForWindowId,
  listWindowSessions,
  registerWindowSession,
  runWithWindowSessionOverride,
  unregisterWindowSession,
} from '../server/utils/windowSessions';
import {
  bindWindowSessionWorkspace,
  unbindWindowSessionWorkspace,
} from '../server/workspaceWatchRegistry';
import type { LayoutState } from '../shared/types/layout';

let mainWindow: BrowserWindow | null = null;

const DEV_VITE_PORT_START = 5173;
const DEV_VITE_PORT_END = 5193;

function probeRendererDevUrl(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get(`${url}/@vite/client`, (response) => {
      const isViteClient = (response.statusCode || 0) >= 200 && (response.statusCode || 0) < 300;
      response.destroy();
      resolve(isViteClient);
    });

    request.on('error', () => resolve(false));
    request.end();
  });
}

async function resolveRendererDevUrl(): Promise<string> {
  const explicitPort = process.env.VITE_PORT?.trim();
  if (explicitPort) {
    return `http://localhost:${explicitPort}`;
  }

  for (let port = DEV_VITE_PORT_START; port <= DEV_VITE_PORT_END; port += 1) {
    const url = `http://localhost:${port}`;
    if (await probeRendererDevUrl(url)) {
      process.env.VITE_PORT = String(port);
      return url;
    }
  }

  return `http://localhost:${DEV_VITE_PORT_START}`;
}
let server: http.Server | null = null;
let interpreterCliFileBridge: InterpreterCliFileBridgeHandle | null = null;
let interpreterCliSocketServer: InterpreterCliSocketServerHandle | null = null;
let serverPort: number = 0;
let isQuitting: boolean = false;
let mainWindowCloseRequested: boolean = false;
let appReady: boolean = false;
let interpreterOverlayService: InterpreterOverlayService | null = null;
let interpreterOverlayTrayState: InterpreterOverlayTrayState = {
  enabled: false,
  accelerator: null,
  runningAgents: [],
};
let formTestsDebugServer: FormTestsDebugServer | null = null;
const appStartTime: number = Date.now(); // Track session duration for telemetry
const FORM_TESTS_MODE = process.env.FORM_TESTS_MODE === 'true';
const FORM_TESTS_INTERACTION_MODE = process.env.FORM_TESTS_INTERACTION_MODE || 'real';
const INTERPRETER_OVERLAY_DEBUG_PORT = Number(
  process.env.INTERPRETER_OVERLAY_DEBUG_PORT
    || (FORM_TESTS_MODE ? process.env.FORM_TESTS_DEBUG_PORT || '9877' : '0'),
);
const INTERPRETER_OVERLAY_DEBUG_TOKEN = process.env.INTERPRETER_OVERLAY_DEBUG_TOKEN?.trim() || '';
const SHOULD_START_INTERPRETER_OVERLAY_DEBUG_SERVER = !app.isPackaged && INTERPRETER_OVERLAY_DEBUG_PORT > 0;
const SHOULD_WARN_PACKAGED_DEBUG_SERVER_REQUEST =
  app.isPackaged && INTERPRETER_OVERLAY_DEBUG_PORT > 0;

// External open handling - for OS-level file associations and shell verbs
let pendingExternalOpenPath: string | null = null;
let pendingExternalAskPaths: string[] = [];
let pendingExternalAskTimer: ReturnType<typeof setTimeout> | null = null;

// Cached file tree for instant loading (loaded before window creation)
interface CachedFileTree {
  workspacePath: string;
  files: any[];
  timestamp: number;
}
let cachedFileTree: CachedFileTree | null = null;
let tray: Tray | null = null;

function configureTrustedMediaSession(targetSession: Electron.Session): void {
  targetSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const rendererUrl = webContents.getURL();
    const isTrustedRenderer = isTrustedAppRendererUrl(rendererUrl);

    if (isTrustedRenderer && permission === 'media') {
      callback(true);
      return;
    }

    callback(false);
  });
}

function resolveIconPath(): string {
  const iconBasePath = app.isPackaged
    ? path.join(process.resourcesPath, 'icons')
    : path.join(__dirname, '../../resources/icons');
  if (process.platform === 'darwin') return path.join(iconBasePath, 'app.icns');
  if (process.platform === 'win32') return path.join(iconBasePath, 'app.ico');
  return path.join(iconBasePath, 'app.png');
}

function resolveDockIconPath(): string {
  const iconBasePath = app.isPackaged
    ? path.join(process.resourcesPath, 'icons')
    : path.join(__dirname, '../../resources/icons');
  if (process.platform === 'darwin') return path.join(iconBasePath, 'app.png');
  return resolveIconPath();
}

function createTrayIcon(): Electron.NativeImage {
  const iconBasePath = app.isPackaged
    ? path.join(process.resourcesPath, 'icons')
    : path.join(__dirname, '../../resources/icons');
  if (process.platform === 'darwin') {
    const icon = nativeImage.createFromPath(path.join(iconBasePath, 'tray-iconTemplate.png'));
    icon.setTemplateImage(true);
    return icon;
  }
  if (process.platform === 'win32') return nativeImage.createFromPath(path.join(iconBasePath, 'app.ico'));
  return nativeImage.createFromPath(path.join(iconBasePath, 'app.png'));
}

function shouldKeepMainWindowHiddenForHeadlessRuns(): boolean {
  return (process.env.NODE_ENV === 'test' || FORM_TESTS_MODE) && process.env.SHOW_WINDOW !== '1';
}

function hideWorkstationWindowForHeadlessRuns(window: BrowserWindow): void {
  if (window.isDestroyed() || !shouldKeepMainWindowHiddenForHeadlessRuns()) {
    return;
  }
  window.setOpacity(0);
  window.setIgnoreMouseEvents(true);
  window.setSkipTaskbar(true);
  window.setBounds({ x: -20000, y: 0, width: 1200, height: 800 });
  window.hide();
}

function keepMainWindowHiddenForHeadlessRuns(): void {
  if (!shouldKeepMainWindowHiddenForHeadlessRuns()) {
    return;
  }
  for (const window of getLiveWorkstationWindows()) {
    hideWorkstationWindowForHeadlessRuns(window);
  }
  if (process.platform === 'darwin' && app.dock) {
    app.dock.hide();
  }
}

function showMainWindow(): void {
  const registeredMainWindow = workstationService.getMainWindow();
  if (registeredMainWindow) {
    mainWindow = registeredMainWindow;
  } else if (!mainWindow || mainWindow.isDestroyed() || !getWindowSessionByWindowId(mainWindow.id)) {
    mainWindow = null;
  }

  if (!mainWindow || mainWindow.isDestroyed()) {
    void createWindow();
    return;
  }
  if (shouldKeepMainWindowHiddenForHeadlessRuns()) {
    keepMainWindowHiddenForHeadlessRuns();
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.setSkipTaskbar(false);
  mainWindow.focus();
  if (process.platform === 'darwin' && app.dock) {
    app.dock.show();
  }
}

function focusWorkstationWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) {
    return;
  }
  if (shouldKeepMainWindowHiddenForHeadlessRuns()) {
    hideWorkstationWindowForHeadlessRuns(window);
    return;
  }
  if (window.isMinimized()) {
    window.restore();
  }
  window.show();
  window.setSkipTaskbar(false);
  window.focus();
  if (process.platform === 'darwin' && app.dock) {
    app.dock.show();
  }
}

function hideMainWindowToTray(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.hide();
  mainWindow.setSkipTaskbar(true);
  if (process.platform === 'darwin' && app.dock) {
    app.dock.hide();
  }
}

function destroyTray(): void {
  tray = destroyTraySafely(tray);
}

function shouldShowTray(): boolean {
  return shouldKeepAppResident();
}

function getLiveWorkstationWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter(
    (window) => !window.isDestroyed() && Boolean(getWindowSessionByWindowId(window.id)),
  );
}

function hasVisibleWorkstationWindows(): boolean {
  return getLiveWorkstationWindows().some((window) => window.isVisible());
}

function syncAppWindowVisibilityState(): void {
  if (process.platform === 'darwin' && app.dock) {
    if (hasVisibleWorkstationWindows()) {
      app.dock.show();
    } else {
      app.dock.hide();
    }
  }

  ensureTray();
}

function refreshTrayMenu(): void {
  if (!tray) return;
  const menu = Menu.buildFromTemplate(buildInterpreterTrayMenuTemplate({
    state: {
      overlayEnabled: interpreterOverlayTrayState.enabled,
      accelerator: interpreterOverlayTrayState.accelerator,
      runningAgents: interpreterOverlayTrayState.runningAgents,
    },
    translate: t,
    showMainWindow,
    showOverlay: () => {
      void interpreterOverlayService?.showOverlayFromTray();
    },
    revealAgent: (agentId) => {
      interpreterOverlayService?.revealAgentFromTray(agentId);
    },
    stopAgent: (agentId) => {
      interpreterOverlayService?.stopAgentFromTray(agentId);
    },
    quit: () => app.quit(),
  }));
  tray.setContextMenu(menu);
}

function ensureTray(): void {
  if (!shouldShowTray()) {
    destroyTray();
    return;
  }

  if (tray) {
    refreshTrayMenu();
    return;
  }

  const trayIcon = createTrayIcon();
  tray = new Tray(trayIcon);
  tray.setToolTip(app.getName());
  if (process.platform !== 'darwin') {
    tray.on('click', () => {
      showMainWindow();
      refreshTrayMenu();
    });
  }
  refreshTrayMenu();
}

async function applyLaunchAtLoginSetting(): Promise<void> {
  const launchAtLogin = await getBooleanUISetting('launchAtLogin');
  app.setLoginItemSettings({
    openAtLogin: launchAtLogin,
    openAsHidden: launchAtLogin,
  });
}

function loadFileTreeCache(): void {
  const cachePath = path.join(os.homedir(), '.interpreter', 'file-tree-cache.json');
  if (fs.existsSync(cachePath)) {
    try {
      const data = fs.readFileSync(cachePath, 'utf-8');
      cachedFileTree = JSON.parse(data);
      console.log('[Main] Loaded file tree cache for:', cachedFileTree?.workspacePath);
    } catch (e) {
      console.error('[Main] Failed to read file tree cache:', e);
      cachedFileTree = null;
    }
  }
}

// Load cache early (before app.whenReady)
loadFileTreeCache();

// NOTE(victor): Protocol must be registered before app.whenReady() for proper handling
const CUSTOM_PROTOCOL = 'workstation';

if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(CUSTOM_PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient(CUSTOM_PROTOCOL);
}

const isPlaywrightElectronSession = process.env.PLAYWRIGHT_ELECTRON_REPL === '1';
const isFormTestsSession = process.env.FORM_TESTS_MODE === 'true';
const gotTheLock =
  isPlaywrightElectronSession || isFormTestsSession ? true : app.requestSingleInstanceLock();
if (!gotTheLock) {
  // NOTE(victor): Use app.exit() (not app.quit()) for single-instance lock failure.
  // On Windows, app.quit() is asynchronous and can still allow app.whenReady() and
  // createWindow()/loadFile() to run during shutdown, causing ERR_FAILED (-2) races.
  // This mirrors Electron's own singleton fixtures and smoke tests:
  // - https://github.com/electron/electron/blob/main/spec/fixtures/api/singleton/main.js
  // - https://github.com/electron/electron/blob/main/spec/ts-smoke/electron/main.ts
  app.exit(0);
}

function handleDeepLink(url: string) {
  console.log('[Main] Handling deep link:', url);

  if (!mainWindow || mainWindow.isDestroyed()) {
    console.warn('[Main] Cannot handle deep link - no main window');
    return;
  }

  mainWindow.webContents.send(IPC_CHANNELS.AUTH_DEEP_LINK, { url });
}

function getUserSuppliedArgv(argv: string[]): string[] {
  return argv.slice(process.defaultApp ? 2 : 1);
}

/**
 * Handle opening a file from OS file associations.
 * Sets workspace to file's parent folder, configures UI, and opens the file.
 */
async function handleFileOpen(filePath: string): Promise<void> {
  console.log('[Main] handleFileOpen called with:', filePath);
  const targetWindow = BrowserWindow.getFocusedWindow() ?? mainWindow;

  // Defer if app not ready
  if (!appReady || !targetWindow || targetWindow.isDestroyed()) {
    console.log('[Main] App not ready, deferring file open');
    pendingExternalOpenPath = filePath;
    return;
  }

  // Validate file exists
  if (!fs.existsSync(filePath)) {
    console.error('[Main] File does not exist:', filePath);
    return;
  }

  try {
    // Import the workspace helper
    const { setWorkspaceForFileOpen } = await import('./ipc/workspaceConfirmation');

    // Set workspace to parent folder (no confirmation dialog)
    await setWorkspaceForFileOpen(filePath, { windowId: targetWindow.id });

    // Close left sidebar for maximum content space
    workstationService.sendToWindowWhenReady(
      targetWindow.id,
      IPC_CHANNELS.WORKSTATION_TOGGLE_SIDEBAR,
      { side: 'left', open: false },
    );

    // Open the file
    workstationService.sendToWindowWhenReady(
      targetWindow.id,
      IPC_CHANNELS.WORKSTATION_OPEN_FILE,
      { path: filePath, page: undefined, origin: 'external-file-open' },
    );

    // Focus window
    focusWorkstationWindow(targetWindow);

    console.log('[Main] File opened successfully:', filePath);
  } catch (error) {
    console.error('[Main] Error handling file open:', error);
  }
}

/**
 * Handle opening a folder from an OS shell integration.
 * Sets the folder as the active workspace and opens a fresh agent tab.
 */
async function handleFolderOpen(folderPath: string): Promise<void> {
  try {
    const normalizedFolderPath = resolveWorkspacePath(folderPath);
    console.log('[Main] handleFolderOpen called with:', normalizedFolderPath);
    const { setWorkspaceForExternalOpen } = await import('./ipc/workspaceConfirmation');
    const focusedWindow = BrowserWindow.getFocusedWindow();
    const focusedWorkstationWindowId = focusedWindow && getWindowSessionByWindowId(focusedWindow.id)
      ? focusedWindow.id
      : null;
    const target = resolveFolderOpenWindowTarget({
      workspacePath: normalizedFolderPath,
      focusedWindowId: focusedWorkstationWindowId,
      windowSessions: listWindowSessions(),
    });

    if (target.kind === 'new-window') {
      const createWindowResult = await createWorkstationWindow({
        workspacePath: normalizedFolderPath,
        sourceWindowId: focusedWorkstationWindowId,
      });
      if (!createWindowResult.success) {
        throw new Error(createWindowResult.error);
      }

      const { setWorkspace } = await import('../server/handlers/workspace');
      await runWithWindowSessionOverride(createWindowResult.sessionKey, async () => {
        await setWorkspace(normalizedFolderPath);
      });
      await buildApplicationMenu();
      workstationService.openNewTab({ windowId: createWindowResult.windowId });
      console.log('[Main] Folder opened successfully in new window:', normalizedFolderPath);
      return;
    }

    const targetWindow = BrowserWindow.fromId(target.windowId);
    if (!targetWindow || targetWindow.isDestroyed()) {
      const createWindowResult = await createWorkstationWindow({
        workspacePath: normalizedFolderPath,
        sourceWindowId: focusedWorkstationWindowId,
      });
      if (!createWindowResult.success) {
        throw new Error(createWindowResult.error);
      }

      const { setWorkspace } = await import('../server/handlers/workspace');
      await runWithWindowSessionOverride(createWindowResult.sessionKey, async () => {
        await setWorkspace(normalizedFolderPath);
      });
      await buildApplicationMenu();
      workstationService.openNewTab({ windowId: createWindowResult.windowId });
      console.log('[Main] Folder opened successfully in new window:', normalizedFolderPath);
      return;
    }

    if (target.kind === 'focused-window') {
      await setWorkspaceForExternalOpen(normalizedFolderPath, { windowId: targetWindow.id });
    }

    workstationService.openNewTab({ windowId: targetWindow.id });
    focusWorkstationWindow(targetWindow);

    console.log('[Main] Folder opened successfully:', normalizedFolderPath);
  } catch (error) {
    console.error('[Main] Error handling folder open:', error);
  }
}

function queueExternalAskPaths(paths: string[]): void {
  if (paths.length === 0) {
    return;
  }

  pendingExternalAskPaths.push(...paths);

  if (pendingExternalAskTimer) {
    clearTimeout(pendingExternalAskTimer);
  }

  pendingExternalAskTimer = setTimeout(() => {
    pendingExternalAskTimer = null;
    const pathsToHandle = Array.from(new Set(pendingExternalAskPaths));
    pendingExternalAskPaths = [];
    void handleExternalAskPaths(pathsToHandle);
  }, 250);
}

async function handleExternalAskPaths(paths: string[]): Promise<void> {
  if (paths.length === 0) {
    return;
  }

  if (!appReady || !mainWindow || mainWindow.isDestroyed()) {
    console.log('[Main] App not ready, deferring external ask paths');
    pendingExternalAskPaths.push(...paths);
    return;
  }

  const request = createExternalAskRequest(paths);
  if (!request) {
    console.error('[Main] Unsupported external ask paths:', paths);
    return;
  }

  try {
    const normalizedWorkspacePath = resolveWorkspacePath(request.workspacePath);
    const { setWorkspaceForExternalOpen } = await import('./ipc/workspaceConfirmation');
    const focusedWindow = BrowserWindow.getFocusedWindow();
    const focusedWorkstationWindowId = focusedWindow && getWindowSessionByWindowId(focusedWindow.id)
      ? focusedWindow.id
      : null;
    const target = resolveFolderOpenWindowTarget({
      workspacePath: normalizedWorkspacePath,
      focusedWindowId: focusedWorkstationWindowId,
      windowSessions: listWindowSessions(),
    });

    let targetWindow: BrowserWindow | null = null;
    let targetWindowSessionKey: string | null = null;

    if (target.kind === 'new-window') {
      const createWindowResult = await createWorkstationWindow({
        workspacePath: normalizedWorkspacePath,
        sourceWindowId: focusedWorkstationWindowId,
      });
      if (!createWindowResult.success) {
        throw new Error(createWindowResult.error);
      }

      targetWindow = BrowserWindow.fromId(createWindowResult.windowId);
      targetWindowSessionKey = createWindowResult.sessionKey;
      const { setWorkspace } = await import('../server/handlers/workspace');
      await runWithWindowSessionOverride(createWindowResult.sessionKey, async () => {
        await setWorkspace(normalizedWorkspacePath);
      });
      await buildApplicationMenu();
    } else {
      targetWindow = BrowserWindow.fromId(target.windowId);
      targetWindowSessionKey = getWindowSessionKeyForWindowId(target.windowId);
      if (!targetWindow || targetWindow.isDestroyed()) {
        const createWindowResult = await createWorkstationWindow({
          workspacePath: normalizedWorkspacePath,
          sourceWindowId: focusedWorkstationWindowId,
        });
        if (!createWindowResult.success) {
          throw new Error(createWindowResult.error);
        }
        targetWindow = BrowserWindow.fromId(createWindowResult.windowId);
        targetWindowSessionKey = createWindowResult.sessionKey;
        const { setWorkspace } = await import('../server/handlers/workspace');
        await runWithWindowSessionOverride(createWindowResult.sessionKey, async () => {
          await setWorkspace(normalizedWorkspacePath);
        });
        await buildApplicationMenu();
      } else if (target.kind === 'focused-window') {
        await setWorkspaceForExternalOpen(normalizedWorkspacePath, { windowId: targetWindow.id });
      }
    }

    if (!targetWindow || targetWindow.isDestroyed()) {
      throw new Error('No target window available for external ask request.');
    }

    agentTabManager.requestAgentTask({
      initialMessage: request.prompt,
      workspacePath: normalizedWorkspacePath,
      targetWindowSessionKey: targetWindowSessionKey ?? undefined,
      activate: true,
    });

    focusWorkstationWindow(targetWindow);

    console.log('[Main] External ask request queued:', {
      targetCount: request.targets.length,
      windowId: targetWindow.id,
      workspacePath: normalizedWorkspacePath,
    });
  } catch (error) {
    console.error('[Main] Error handling external ask paths:', error);
  }
}

/**
 * Handle an explicit OS-level open request for either a supported file or a folder.
 */
async function handleExternalOpenPath(targetPath: string): Promise<void> {
  console.log('[Main] handleExternalOpenPath called with:', targetPath);

  if (!appReady || !mainWindow || mainWindow.isDestroyed()) {
    console.log('[Main] App not ready, deferring external open');
    pendingExternalOpenPath = targetPath;
    return;
  }

  const target = classifyExternalOpenPath(targetPath);
  if (!target) {
    console.error('[Main] Unsupported external open path:', targetPath);
    return;
  }

  if (target.kind === 'folder') {
    await handleFolderOpen(target.path);
    return;
  }

  await handleFileOpen(target.path);
}

// NOTE(victor): Windows/Linux uses second-instance, macOS uses open-url
registerElectronAppLifecycle({
  app,
  addBreadcrumb: (breadcrumb) => {
    Sentry.addBreadcrumb(breadcrumb);
  },
  canHandleActivate: () => appReady,
  cleanup,
  createWindow: () => createWindow(),
  customProtocol: CUSTOM_PROTOCOL,
  findExternalAskTargetsInArgv,
  findExternalOpenTargetInArgv,
  getAllWindows: () => BrowserWindow.getAllWindows(),
  getFocusedWindow: () => BrowserWindow.getFocusedWindow(),
  getMainWindow: () => mainWindow,
  getMainWindowLaunchState: () => {
    if (
      !mainWindow
      || mainWindow.isDestroyed()
      || !mainWindowLaunchState
      || mainWindowLaunchState.windowId !== mainWindow.id
      || mainWindowLaunchState.webContentsId !== mainWindow.webContents.id
    ) {
      return null;
    }

    return mainWindowLaunchState;
  },
  getQuitState: () => ({
    appReady,
    isQuitting,
    isUpdating,
  }),
  getUserSuppliedArgv,
  handleDeepLink,
  handleExternalAskPaths: (paths) => {
    queueExternalAskPaths(paths);
  },
  handleExternalOpenPath,
  isOverlayVisible: () => interpreterOverlayService?.isOverlayVisible() ?? false,
  logger: console,
  noteAppChildProcessGone,
  noteMainWindowRendererGone: async () => {
    const { noteMainWindowRendererGone } = await import('./services/office-extension');
    noteMainWindowRendererGone();
  },
  noteSecondInstanceHandoff,
  shouldQuitWhenAllWindowsClosed: () => process.env.NODE_ENV === 'test',
  shouldTrackOoEditorsMainRendererGone,
  showMainWindow,
});

// NOTE(victor): Log GPU feature status after GPU process crashes to help
// diagnose GPU driver crash groups (#12: glStartTilingQCOM,
// VADisplayStateSingleton). VS Code listens for child-process-gone with
// type=GPU, waits for gpu-info-update, then logs getGPUFeatureStatus()
// and recent GPU log messages:
// https://github.com/microsoft/vscode/blob/b4b5c20cbbaa6de0c0c1f5430519ee3f3080c53b/src/vs/code/electron-main/app.ts#L1589-L1617
// Signal Desktop does not implement GPU crash telemetry; its main crash
// handler only covers non-clean renderer exits:
// https://github.com/signalapp/Signal-Desktop/blob/a8f91c2c20bc21a4c40c0fcca67beeeeee61915b/app/global_errors.main.ts#L65-L75
app.on('child-process-gone', (_event, details) => {
  if (details.type !== 'GPU' || details.reason === 'clean-exit') {
    return;
  }
  const gpuFeatureStatus = app.getGPUFeatureStatus();
  console.error(
    '[Main] gpu-process-gone',
    `reason=${details.reason}`,
    `exitCode=${details.exitCode}`,
    `rasterization=${gpuFeatureStatus.rasterization}`,
    `gpu_compositing=${gpuFeatureStatus.gpu_compositing}`,
    `webgl=${gpuFeatureStatus.webgl}`,
  );
});

// Register custom protocol as privileged (must be called before app.whenReady)
// This allows the thumbnail:// protocol to work properly in img src attributes
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'thumbnail',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

// Export function to emit workspace changes from server
export function emitWorkspaceChanged(workspacePath: string | null) {
  emitWorkspaceChangedEvent(mainWindow, workspacePath);
}

// Determine if we're in development or production.
// Setting INTERPRETER_USE_BUILT_RENDERER=true lets unpackaged Electron load dist/
// instead of Vite, which is useful for no-HMR local runs.
// In test mode, always use production build.
const isDev = !app.isPackaged && process.env.NODE_ENV !== 'test' && !useBuiltRenderer;

function setupThumbnailProtocol() {
  // Register custom protocol for serving thumbnails
  protocol.handle('thumbnail', async (request) => {
    try {
      const filePath = decodeURIComponent(request.url.slice('thumbnail://'.length));

      const result = await thumbnailService.getThumbnail(filePath);
      if (!result) {
        return new Response('', { status: 404 });
      }

      const base64Data = result.dataUrl.split(',')[1];
      const buffer = Buffer.from(base64Data, 'base64');

      return new Response(buffer, {
        headers: {
          'content-type': 'image/png',
          'cache-control': 'public, max-age=3600', // Cache for 1 hour
        },
      });
    } catch (error) {
      console.error('[ThumbnailProtocol] Error serving thumbnail:', error);
      return new Response('', { status: 404 });
    }
  });
}

async function startExpressServer() {
  // LOG_DIR is already set at module import time (see top of file)

  try {
    await toolManager.initialize();
  } catch (error) {
    console.error('[Server] Tool manager initialization failed, starting with no MCP servers:', error);
  }

  validateRipgrepBinary().catch((err) => {
    console.error('[Server] ripgrep validation failed:', err);
  });

  // Start Express server with retry logic for port conflicts
  server = http.createServer(expressApp);
  const serverHost = '127.0.0.1';

  serverPort = await listenOnAvailableLocalPort(server, serverHost, (port, code) => {
    console.log(`Port ${port} unavailable (${code}), trying next...`);
  });
  setServerPort(serverPort);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  MCP TOOL SERVER READY`);
  console.log(`  http://${serverHost}:${serverPort}`);
  console.log(`${'='.repeat(60)}\n`);
  interpreterCliFileBridge = await startInterpreterCliFileBridge(serverPort);
  interpreterCliSocketServer = await startInterpreterCliSocketServer(expressApp, serverPort);
}

type CreateWindowResult =
  | { status: 'created'; window: BrowserWindow }
  | { status: 'aborted-during-teardown' };

type MainWindowContentLoadResult = 'loaded' | 'aborted-during-teardown';

interface CreateWindowOptions {
  sessionKey?: string;
  workspacePath?: string | null;
  bootstrapLayout?: LayoutState | null;
  primary?: boolean;
  background?: boolean;
}

function createWindowSessionKey(): string {
  return `ws_${randomBytes(12).toString('hex')}`;
}

function handleMainWindowLoadFailure(error: unknown): MainWindowContentLoadResult {
  const decision = classifyMainWindowLoadFailure({
    error,
    isQuitting,
    hasLiveMainWindow: Boolean(
      mainWindow
      && !mainWindow.isDestroyed()
      && !mainWindowCloseRequested
    ),
  });

  if (decision.shouldAbortWindowInitialization) {
    console.warn('[Main] Ignoring renderer load abort during teardown:', error);
    return 'aborted-during-teardown';
  }

  throw error;
}

function getWindowCurrentUrl(window: BrowserWindow): string | null {
  try {
    if (isBrowserWindowUnavailable(window)) {
      return null;
    }
    return window.webContents.getURL() || null;
  } catch {
    return null;
  }
}

function isBrowserWindowUnavailable(window: BrowserWindow | null | undefined): boolean {
  try {
    return (window?.isDestroyed() ?? true) || (window?.webContents?.isDestroyed() ?? true);
  } catch {
    return true;
  }
}

function bindMainWindowLaunchTelemetry(
  window: BrowserWindow,
  options: { isPrimaryWindow: boolean; sessionKey: string; windowId: number; webContentsId: number },
): void {
  if (!options.isPrimaryWindow) {
    return;
  }

  const debugEnabled = process.env.INTERPRETER_DEBUG_RENDERER_LOAD === '1';
  const debugLog = (
    event: Exclude<MainWindowLaunchEvent, 'create-window-start' | 'browser-window-created' | 'load-target-selected' | 'load-threw'>,
    extra: Partial<Omit<MainWindowLaunchState, 'lastEvent' | 'updatedAt'>> = {},
  ) => {
    updateMainWindowLaunchState(event, {
      currentUrl: getWindowCurrentUrl(window),
      isPrimaryWindow: options.isPrimaryWindow,
      sessionKey: options.sessionKey,
      webContentsId: options.webContentsId,
      windowId: options.windowId,
      ...(event === 'did-fail-load' ? {} : resetMainWindowLaunchFailure()),
      ...extra,
    }, event === 'did-fail-load' ? 'warning' : 'info');

    if (!debugEnabled) {
      return;
    }

    console.log('[RendererLoadDebug]', event, {
      isDev,
      useBuiltRenderer,
      serverPort,
      url: getWindowCurrentUrl(window),
      ...extra,
    });
  };

  window.on('ready-to-show', () => {
    debugLog('ready-to-show');
  });
  window.webContents.on('did-start-loading', () => {
    debugLog('did-start-loading');
  });
  window.webContents.on('dom-ready', () => {
    debugLog('dom-ready');
  });
  window.webContents.on('did-stop-loading', () => {
    debugLog('did-stop-loading');
  });
  window.webContents.on('did-finish-load', () => {
    debugLog('did-finish-load');
  });
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) {
      return;
    }

    debugLog('did-fail-load', {
      errorCode,
      errorDescription,
      isMainFrame,
      validatedUrl: validatedURL,
    });
  });
}

async function loadMainWindowContent(window: BrowserWindow): Promise<MainWindowContentLoadResult> {
  const windowId = window.id;
  const webContentsId = window.webContents.id;

  // In development, load from Vite dev server
  if (isDev) {
    const devServerUrl = await resolveRendererDevUrl();
    if (mainWindow === window) {
    updateMainWindowLaunchState('load-target-selected', {
      currentUrl: getWindowCurrentUrl(window),
      errorCode: null,
      errorDescription: null,
      isMainFrame: null,
      loadTarget: 'vite-dev-server',
      targetUrl: devServerUrl,
      validatedUrl: null,
      webContentsId,
      windowId,
    });
    }
    let retries = 10;
    let lastError: unknown = null;

    while (retries > 0) {
      try {
        await window.loadURL(devServerUrl);
        return 'loaded';
      } catch (error) {
        if (isMainWindowLoadAbortError(error)) {
          const recoveryResult = await waitForMainWindowLoadRecovery({
            window,
            expectedUrl: devServerUrl,
          });
          if (recoveryResult === 'recovered') {
            console.warn('[Main] Recovered from renderer load abort:', {
              url: devServerUrl,
            });
            return 'loaded';
          }
          console.warn('[Main] Renderer load abort did not recover:', {
            url: devServerUrl,
            recoveryResult,
          });
        }

        if (mainWindow === window) {
          updateMainWindowLaunchState('load-threw', {
            currentUrl: getWindowCurrentUrl(window),
            errorDescription: error instanceof Error ? error.message : String(error),
            loadTarget: 'vite-dev-server',
            targetUrl: devServerUrl,
            webContentsId,
            windowId,
          }, 'warning');
        }

        const loadResult = handleMainWindowLoadFailure(error);
        if (loadResult === 'aborted-during-teardown') {
          return loadResult;
        }

        lastError = error;
        retries -= 1;
        if (retries > 0) {
          console.log(`Failed to load Vite dev server at ${devServerUrl}, retrying... (${retries} attempts left)`);
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
    }

    throw new Error(`Failed to load Vite dev server at ${devServerUrl} after 10 attempts: ${String(lastError)}`);
  }

  try {
    if (useBuiltRenderer) {
      if (mainWindow === window) {
        updateMainWindowLaunchState('load-target-selected', {
          currentUrl: getWindowCurrentUrl(window),
          errorCode: null,
          errorDescription: null,
          isMainFrame: null,
          loadTarget: 'built-server-url',
          targetUrl: `http://127.0.0.1:${serverPort}`,
          validatedUrl: null,
          webContentsId,
          windowId,
        });
      }
      await window.loadURL(`http://127.0.0.1:${serverPort}`);
    } else {
      const distPath = path.join(__dirname, '../../dist/index.html');
      if (mainWindow === window) {
        updateMainWindowLaunchState('load-target-selected', {
          currentUrl: getWindowCurrentUrl(window),
          errorCode: null,
          errorDescription: null,
          isMainFrame: null,
          loadTarget: 'dist-file',
          targetUrl: distPath,
          validatedUrl: null,
          webContentsId,
          windowId,
        });
      }
      await window.loadFile(distPath);
    }
    return 'loaded';
  } catch (error) {
    if (mainWindow === window) {
      updateMainWindowLaunchState('load-threw', {
        currentUrl: getWindowCurrentUrl(window),
        errorDescription: error instanceof Error ? error.message : String(error),
        loadTarget: useBuiltRenderer ? 'built-server-url' : 'dist-file',
        targetUrl: useBuiltRenderer ? `http://127.0.0.1:${serverPort}` : path.join(__dirname, '../../dist/index.html'),
        webContentsId,
        windowId,
      }, 'warning');
    }
    return handleMainWindowLoadFailure(error);
  }
}

function bindWindowEvents(window: BrowserWindow, options: { primary: boolean; sessionKey: string; windowId: number }): void {
  window.webContents.on('context-menu', (_event, params) => {
    const menuItems: Electron.MenuItemConstructorOptions[] = [];

    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
        menuItems.push({
          label: suggestion,
          click: () => window.webContents.replaceMisspelling(suggestion),
        });
      }
      if (params.dictionarySuggestions.length > 0) {
        menuItems.push({ type: 'separator' });
      }
      menuItems.push({
        label: t('menu.context.addToDictionary'),
        click: () => window.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      });
      menuItems.push({ type: 'separator' });
    }

    menuItems.push(
      { label: t('menu.context.cut'), accelerator: 'CmdOrCtrl+X', role: 'cut', enabled: params.editFlags.canCut },
      { label: t('menu.context.copy'), accelerator: 'CmdOrCtrl+C', role: 'copy', enabled: params.editFlags.canCopy },
      { label: t('menu.context.paste'), accelerator: 'CmdOrCtrl+V', role: 'paste', enabled: params.editFlags.canPaste },
    );

    if (params.isEditable) {
      menuItems.push(
        { type: 'separator' },
        {
          label: t('menu.context.bold'),
          accelerator: 'CmdOrCtrl+B',
          click: () => window.webContents.send('markdown:format', 'bold'),
        },
        {
          label: t('menu.context.italic'),
          accelerator: 'CmdOrCtrl+I',
          click: () => window.webContents.send('markdown:format', 'italic'),
        },
        {
          label: t('menu.context.underline'),
          accelerator: 'CmdOrCtrl+U',
          click: () => window.webContents.send('markdown:format', 'underline'),
        },
        { type: 'separator' },
        {
          label: t('menu.context.heading1'),
          click: () => window.webContents.send('markdown:format', 'heading1'),
        },
        {
          label: t('menu.context.heading2'),
          click: () => window.webContents.send('markdown:format', 'heading2'),
        },
        {
          label: t('menu.context.heading3'),
          click: () => window.webContents.send('markdown:format', 'heading3'),
        },
        { type: 'separator' },
        {
          label: t('menu.context.paragraph'),
          click: () => window.webContents.send('markdown:format', 'paragraph'),
        },
      );
    }

    const menu = Menu.buildFromTemplate(menuItems);
    menu.popup({ window });
  });

  window.webContents.on('zoom-changed', () => {
    queueMicrotask(() => {
      if (window.isDestroyed()) return;

      const zoomFactor = clampZoomFactor(window.webContents.getZoomFactor());
      void setZoomFactor(zoomFactor).catch((error) => {
        console.error('[Main] Failed to persist zoom factor:', error);
      });
      broadcastEvent('zoomFactor:changed', { zoomFactor });
    });
  });

  // NOTE(victor): When the renderer process dies (OOM, V8 heap corruption, etc.)
  // the user sees a permanent blank window. Follow VS Code's pattern: log
  // reason/exitCode, show a native Reopen/Close dialog, then recreate the
  // window when the user chooses Reopen:
  // https://github.com/microsoft/vscode/blob/b4b5c20cbbaa6de0c0c1f5430519ee3f3080c53b/src/vs/platform/windows/electron-main/windowImpl.ts#L994-L1019
  // Signal Desktop records the same reason/exitCode fields before treating
  // non-clean renderer exits as fatal:
  // https://github.com/signalapp/Signal-Desktop/blob/a8f91c2c20bc21a4c40c0fcca67beeeeee61915b/app/global_errors.main.ts#L65-L75
  // Create the replacement BEFORE destroying so the app does not quit when
  // the last window closes.
  window.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') {
      return;
    }

    const { reason, exitCode } = details;
    console.error(
      '[Main] render-process-gone:',
      `reason=${reason}`,
      `exitCode=${exitCode}`,
      `windowId=${options.windowId}`,
    );
    Sentry.addBreadcrumb({
      category: 'app.lifecycle',
      message: 'renderer-crash-recovery',
      level: 'warning',
      data: { reason, exitCode, windowId: options.windowId },
    });

    const session = getWindowSessionByWindowId(options.windowId);
    const workspacePath = session?.workspacePath ?? null;
    const reasonLabel = reason === 'oom' ? 'out of memory' : reason;

    dialog.showMessageBox(window, {
      type: 'error',
      buttons: ['Reopen', 'Close'],
      defaultId: 0,
      cancelId: 1,
      title: 'Window Error',
      message: 'This window encountered an unexpected error.',
      detail: `Reason: ${reasonLabel} (code ${exitCode}).\nYou can reopen the window to continue where you left off.`,
      noLink: true,
    }).then(async ({ response }) => {
      if (response === 0) {
        const result = await createWorkstationWindow({ workspacePath });
        if (result.success) {
          console.log('[Main] Reopened window after crash:', {
            oldWindowId: options.windowId,
            newWindowId: result.windowId,
            workspacePath,
          });
        }
      }
      if (!window.isDestroyed()) {
        window.destroy();
      }
    }).catch((error) => {
      console.error('[Main] Crash recovery dialog failed:', error);
      if (!window.isDestroyed()) {
        window.destroy();
      }
    });
  });

  window.on('close', (event) => {
    if (isQuitting || (process.env.NODE_ENV === 'test' && !FORM_TESTS_MODE)) {
      if (options.primary) {
        mainWindowCloseRequested = true;
      }
      return;
    }

    const liveWindows = getLiveWorkstationWindows();
    const isLastWindow = liveWindows.length <= 1;
    const shouldHideToTray =
      options.primary
      && isLastWindow
      && shouldShowTray();

    if (shouldHideToTray) {
      event.preventDefault();
      Sentry.addBreadcrumb({
        category: 'app.lifecycle',
        message: 'hide main window to tray',
        level: 'info',
        data: { windowId: options.windowId },
      });
      ensureTray();
      hideMainWindowToTray();
      refreshTrayMenu();
      return;
    }

    if (options.primary) {
      mainWindowCloseRequested = true;
    }
  });

  window.on('show', () => {
    if (options.primary) {
      mainWindowCloseRequested = false;
    }
    window.setSkipTaskbar(false);
    syncAppWindowVisibilityState();
    refreshTrayMenu();
  });

  window.on('hide', () => {
    syncAppWindowVisibilityState();
    refreshTrayMenu();
  });

  window.on('closed', () => {
    if (options.primary) {
      mainWindowCloseRequested = false;
      mainWindowLaunchState = null;
    }
    workstationService.unregisterWindow(options.windowId);
    void unbindWindowSessionWorkspace(options.sessionKey).catch((error) => {
      console.error('[Main] Failed to unbind workspace watch for window session:', error);
    });
    unregisterWindowSession(options.windowId);

    if (mainWindow === window) {
      mainWindow = workstationService.getMainWindow();
    }

    syncAppWindowVisibilityState();

    const hasRemainingWindows = getLiveWorkstationWindows().length > 0;
    if (!isQuitting && !hasRemainingWindows && !shouldShowTray()) {
      // BrowserService.hiddenWindow keeps Electron alive after the main window closes.
      app.quit();
    }
  });

  // NOTE: Renderer console logs are captured via preload.ts IPC override
  // Do NOT add a console-message listener here - it would duplicate logs

  window.on('enter-full-screen', () => {
    emitWindowFullscreenChanged(window, true);
  });

  window.on('leave-full-screen', () => {
    emitWindowFullscreenChanged(window, false);
  });
}

async function createWindow(options?: CreateWindowOptions): Promise<CreateWindowResult> {
  const isTest = process.env.NODE_ENV === 'test';
  const showWindow = process.env.SHOW_WINDOW === '1'; // Override show:false for demos
  const hideForFormTests = FORM_TESTS_MODE && !showWindow;
  const sessionKey = options?.sessionKey ?? createWindowSessionKey();
  const isPrimaryWindow = options?.primary ?? !mainWindow;
  const initialWorkspacePath = options?.workspacePath ?? getCurrentWorkspace();
  const shouldShowWindow = options?.background === true
    ? false
    : ((!isTest && !hideForFormTests) || showWindow);
  if (isPrimaryWindow) {
    updateMainWindowLaunchState('create-window-start', {
      background: options?.background === true,
      currentUrl: null,
      errorCode: null,
      errorDescription: null,
      isMainFrame: null,
      isPrimaryWindow,
      loadTarget: null,
      sessionKey,
      targetUrl: null,
      validatedUrl: null,
      webContentsId: null,
      windowId: null,
    });
  }

  // Custom title bar configuration for macOS
  const HEADER_HEIGHT = 32; // Matches tab height (h-8)
  const MACOS_TRAFFIC_LIGHTS_HEIGHT = 14;

  const iconPath = resolveIconPath();

  if (process.platform === 'darwin' && app.dock) {
    const dockIconPath = resolveDockIconPath();
    console.log('\x1b[36m%s\x1b[0m', `[Dock] Setting dock icon: ${dockIconPath}`);
    const dockIcon = nativeImage.createFromPath(dockIconPath);
    if (!dockIcon.isEmpty()) {
      app.dock.setIcon(dockIcon);
    } else {
      console.warn(`[Dock] Failed to load dock icon from ${dockIconPath}`);
    }
  }

  const defaultWorkArea = screen.getPrimaryDisplay().workArea;
  const defaultWindowBounds = {
    x: Math.round(defaultWorkArea.x + defaultWorkArea.width * 0.04),
    y: Math.round(defaultWorkArea.y + defaultWorkArea.height * 0.04),
    width: Math.round(defaultWorkArea.width * 0.92),
    height: Math.round(defaultWorkArea.height * 0.92),
  };

  // Allow env vars to set initial window geometry (used by demo scripts)
  const initX = process.env.WINDOW_X ? parseInt(process.env.WINDOW_X, 10) : undefined;
  const initY = process.env.WINDOW_Y ? parseInt(process.env.WINDOW_Y, 10) : undefined;
  const initWidth = process.env.WINDOW_WIDTH ? parseInt(process.env.WINDOW_WIDTH, 10) : defaultWindowBounds.width;
  const initHeight = process.env.WINDOW_HEIGHT ? parseInt(process.env.WINDOW_HEIGHT, 10) : defaultWindowBounds.height;
  const macWindowAppearance = getMacWindowAppearance({
    platform: process.platform,
    disableMacTransparencyEnv: process.env.INTERPRETER_DISABLE_MAC_TRANSPARENCY,
    forceMacTransparencyEnv: process.env.INTERPRETER_FORCE_MAC_TRANSPARENCY,
    machineRunDirEnv: process.env.INTERPRETER_MACHINE_RUN_DIR,
    shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
  });

  const window = new BrowserWindow({
    width: initWidth,
    height: initHeight,
    x: initX ?? (process.env.WINDOW_WIDTH || process.env.WINDOW_HEIGHT ? undefined : defaultWindowBounds.x),
    y: initY ?? (process.env.WINDOW_WIDTH || process.env.WINDOW_HEIGHT ? undefined : defaultWindowBounds.y),
    minWidth: 320,
    minHeight: 220,
    icon: iconPath,
    show: shouldShowWindow, // Background windows stay hidden until explicitly surfaced.
    skipTaskbar: options?.background === true || ((isTest || hideForFormTests) && !showWindow), // Hide background/test/form-test windows from taskbar until surfaced.
    // NOTE(victor): Transparency/vibrancy is macOS-only. On Windows, transparent windows require
    // GPU compositing, but we disable GPU globally (see app.disableHardwareAcceleration above).
    // This caused white screen on Windows VMs. Windows 11 Mica could be added later via backgroundMaterial.
    transparent: macWindowAppearance.transparent,
    // Use the clearer material so transparent sidebars show through to the desktop again.
    vibrancy: macWindowAppearance.vibrancy,
    // Keep the mac material in its active state even through hidden/show/focus
    // transitions so the transparent shell does not come up looking flat.
    visualEffectState: macWindowAppearance.vibrancy ? 'active' : undefined,
    backgroundColor: macWindowAppearance.backgroundColor,
    // Custom title bar configuration (macOS + Windows)
    titleBarStyle: process.platform === 'darwin' || process.platform === 'win32' ? 'hidden' : undefined,
    titleBarOverlay: process.platform === 'win32'
      ? {
          color: '#00000000',
          symbolColor: '#5f6673',
          height: 42,
        }
      : undefined,
    autoHideMenuBar: process.platform === 'win32',
    // Traffic lights positioned for visual alignment
    // x = 19px, y = 13px (adjusted for proper visual centering)
    trafficLightPosition: process.platform === 'darwin'
      ? { x: 19, y: 13 }
      : undefined,
    acceptFirstMouse: true, // Better UX - no double-click needed
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // Disable sandbox to allow ES module preload
      webSecurity: false, // NOTE(victor): Disabled to allow file:// <-> http://localhost communication for oo-editors iframe on Windows
      // Use persist partition to ensure localStorage survives app restarts
      // This is CRITICAL for auth token persistence
      partition: WORKSTATION_PARTITION,
      additionalArguments: [
        `--js-flags=--max-old-space-size=${getRendererMaxOldSpaceSizeMb()}`,
        buildWindowSessionKeyArg(sessionKey),
        ...(buildWindowBootstrapLayoutArg(options?.bootstrapLayout ?? null)
          ? [buildWindowBootstrapLayoutArg(options?.bootstrapLayout ?? null)!]
          : []),
      ],
    },
  });
  const windowId = window.id;
  const webContentsId = window.webContents.id;
  if (shouldKeepMainWindowHiddenForHeadlessRuns()) {
    hideWorkstationWindowForHeadlessRuns(window);
    window.on('show', () => {
      hideWorkstationWindowForHeadlessRuns(window);
    });
    window.on('focus', () => {
      hideWorkstationWindowForHeadlessRuns(window);
    });
  }

  const abortWindowInitialization = async (): Promise<CreateWindowResult> => {
    workstationService.unregisterWindow(windowId);
    await unbindWindowSessionWorkspace(sessionKey).catch(() => {});
    unregisterWindowSession(windowId);
    if (mainWindow === window) {
      mainWindow = workstationService.getMainWindow();
      mainWindowCloseRequested = false;
    }
    return { status: 'aborted-during-teardown' };
  };

  registerWindowSession({
    sessionKey,
    windowId,
    workspacePath: initialWorkspacePath ?? null,
  });
  await bindWindowSessionWorkspace(sessionKey, initialWorkspacePath ?? null);
  if (isBrowserWindowUnavailable(window)) {
    return abortWindowInitialization();
  }

  if (isPrimaryWindow) {
    mainWindow = window;
    mainWindowCloseRequested = false;
    updateMainWindowLaunchState('browser-window-created', {
      background: options?.background === true,
      currentUrl: getWindowCurrentUrl(window),
      errorCode: null,
      errorDescription: null,
      isMainFrame: null,
      isPrimaryWindow,
      sessionKey,
      validatedUrl: null,
      webContentsId,
      windowId,
    });
  }
  bindWindowEvents(window, { primary: isPrimaryWindow, sessionKey, windowId });
  bindMainWindowLaunchTelemetry(window, { isPrimaryWindow, sessionKey, windowId, webContentsId });

  const initializationResult = await initializeCreatedWindow(window, {
    abortInitialization: async () => {
      await abortWindowInitialization();
    },
    getZoomFactor,
    loadContent: loadMainWindowContent,
    maximize: isPlaywrightElectronSession,
    registerWindow: (createdWindow) => {
      workstationService.registerWindow(createdWindow, { primary: isPrimaryWindow });
    },
  });
  if (initializationResult === 'aborted-during-teardown') {
    return { status: 'aborted-during-teardown' };
  }

  return { status: 'created', window };
}

async function createWorkstationWindow(options?: {
  sourceWindowId?: number | null;
  workspacePath?: string | null;
  bootstrapLayout?: LayoutState | null;
  background?: boolean;
}): Promise<{ success: true; windowId: number; sessionKey: string } | { success: false; error: string }> {
  const sourceWindow = options?.sourceWindowId ? BrowserWindow.fromId(options.sourceWindowId) : BrowserWindow.getFocusedWindow();
  const inheritedWorkspacePath = options?.workspacePath
    ?? getWindowSessionByWindowId(sourceWindow?.id ?? null)?.workspacePath
    ?? getCurrentWorkspace();
  const sessionKey = createWindowSessionKey();
  const createWindowResult = await createWindow({
    sessionKey,
    workspacePath: inheritedWorkspacePath,
    bootstrapLayout: options?.bootstrapLayout ?? null,
    primary: false,
    background: options?.background === true,
  });

  if (createWindowResult.status !== 'created') {
    return { success: false, error: 'Window creation aborted during teardown.' };
  }

  if (sourceWindow && !sourceWindow.isDestroyed()) {
    const sourceBounds = sourceWindow.getBounds();
    createWindowResult.window.setBounds({
      x: sourceBounds.x + 40,
      y: sourceBounds.y + 40,
      width: sourceBounds.width,
      height: sourceBounds.height,
    });
  }

  if (shouldKeepMainWindowHiddenForHeadlessRuns()) {
    hideWorkstationWindowForHeadlessRuns(createWindowResult.window);
    return {
      success: true,
      windowId: createWindowResult.window.id,
      sessionKey,
    };
  }

  if (options?.background !== true) {
    focusWorkstationWindow(createWindowResult.window);
  }

  return {
    success: true,
    windowId: createWindowResult.window.id,
    sessionKey,
  };
}

// Helper for cleanup operations with timeout
async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  operationName: string
): Promise<{ success: boolean; timedOut: boolean }> {
  let timeoutId: NodeJS.Timeout;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`${operationName} timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
    clearTimeout(timeoutId!);
    return { success: true, timedOut: false };
  } catch (error) {
    clearTimeout(timeoutId!);
    const timedOut = error instanceof Error && error.message.includes('timed out');
    console.error(`${operationName}: ${timedOut ? 'timed out' : 'failed'}`, timedOut ? '' : error);
    return { success: false, timedOut };
  }
}

// Cleanup function to be called on app quit
async function cleanup() {
  if (isQuitting) {
    return;
  }
  isQuitting = true;

  console.log('Starting cleanup...');

  // Track session end (respects telemetryEnabled setting)
  try {
    const { trackSessionEnd } = await import('../server/telemetry');
    const sessionDuration = Date.now() - appStartTime;
    await trackSessionEnd(sessionDuration);
  } catch {
    // Silently ignore telemetry failures during cleanup
  }

  const cleanupResults: Record<string, { success: boolean; timedOut: boolean }> = {};

  // NOTE(victor): Port 38123 (oo-editors) is intentionally excluded. shutdownOfficeExtension() below
  // sets isShuttingDown=true before killing it - including 38123 here races that flag and triggers a
  // false Sentry crash report (exit code 1) on every clean quit.
  killPortProcessSync([3333, 8089], {
    breadcrumbContext: 'quit port cleanup',
    addBreadcrumb: addPortCleanupBreadcrumb,
    excludePids: getCurrentProcessPortCleanupExclusions(),
  });
  destroyTray();

  // Clear manager state FIRST (synchronous, no timeout needed)
  try {
    approvalManager.clearAll();
    agentTabManager.clearAll();
    console.log('Cleared manager state');
    cleanupResults['managerState'] = { success: true, timedOut: false };
  } catch (error) {
    console.error('Error clearing manager state:', error);
    cleanupResults['managerState'] = { success: false, timedOut: false };
  }

  // Stop file watcher
  cleanupResults['fileWatcher'] = await withTimeout(
    cleanupFileWatcher(),
    2000,
    'File watcher cleanup'
  );

  // Shutdown OfficeExtension
  try {
    Sentry.addBreadcrumb({
      category: 'oo-editors',
      message: 'App quitting, shutting down oo-editors',
      level: 'info',
    });
    await shutdownOfficeExtension();
    console.log('OfficeExtension shutdown complete');
    cleanupResults['officeExtension'] = { success: true, timedOut: false };
  } catch (error) {
    console.error('Error shutting down OfficeExtension:', error);
    cleanupResults['officeExtension'] = { success: false, timedOut: false };
  }

  try {
    await shutdownBrowserExtensionRelay();
    console.log('Browser extension relay shutdown complete');
    cleanupResults['browserExtensionRelay'] = { success: true, timedOut: false };
  } catch (error) {
    console.error('Error shutting down browser extension relay:', error);
    cleanupResults['browserExtensionRelay'] = { success: false, timedOut: false };
  }

  // Shutdown browser service (synchronous)
  try {
    browserService.shutdown();
    console.log('Browser service shutdown complete');
    cleanupResults['browserService'] = { success: true, timedOut: false };
  } catch (error) {
    console.error('Error shutting down browser service:', error);
    cleanupResults['browserService'] = { success: false, timedOut: false };
  }

  try {
    if (formTestsDebugServer) {
      await formTestsDebugServer.stop();
      formTestsDebugServer = null;
    }

    interpreterOverlayService?.stop();
    interpreterOverlayService = null;
    cleanupResults['interpreterOverlay'] = { success: true, timedOut: false };
  } catch (error) {
    console.error('Error shutting down Interpreter Overlay:', error);
    cleanupResults['interpreterOverlay'] = { success: false, timedOut: false };
  }

  try {
    shutdownCodexRuntime();
    console.log('OIX app-server shutdown complete');
    cleanupResults['codexRuntime'] = { success: true, timedOut: false };
  } catch (error) {
    console.error('Error shutting down OIX app-server:', error);
    cleanupResults['codexRuntime'] = { success: false, timedOut: false };
  }

  cleanupResults['cuaDriver'] = await withTimeout(
    shutdownCuaDriverProcesses(),
    2000,
    'CUA driver shutdown'
  );

  if (server) {
    // Shutdown tool manager
    console.log('Shutting down tool manager...');
    cleanupResults['toolManager'] = await withTimeout(
      toolManager.shutdown(),
      5000,
      'Tool manager shutdown'
    );

    // Close HTTP server
    console.log('Closing HTTP server...');
    cleanupResults['httpServer'] = await withTimeout(
      new Promise<void>((resolve) => {
        server!.close((err) => {
          if (err) {
            console.error('Error closing HTTP server:', err);
          } else {
            console.log('HTTP server closed');
          }
          resolve();
        });
        // Force close all connections to speed up shutdown
        server!.closeAllConnections?.();
      }),
      5000,
      'HTTP server close'
    );

    server = null;
  }

  if (interpreterCliSocketServer) {
    console.log('Closing interpreter CLI socket server...');
    cleanupResults['interpreterCliSocket'] = await withTimeout(
      interpreterCliSocketServer.close(),
      5000,
      'Interpreter CLI socket close'
    );
    interpreterCliSocketServer = null;
  }

  if (interpreterCliFileBridge) {
    console.log('Closing interpreter CLI file bridge...');
    cleanupResults['interpreterCliFileBridge'] = await withTimeout(
      interpreterCliFileBridge.close(),
      5000,
      'Interpreter CLI file bridge close'
    );
    interpreterCliFileBridge = null;
  }

  // Log cleanup summary
  const failed = Object.entries(cleanupResults).filter(([_, r]) => !r.success);
  if (failed.length > 0) {
    console.warn(`Cleanup completed with ${failed.length} issue(s):`, failed.map(([k]) => k).join(', '));
  } else {
    console.log('Cleanup complete - all operations successful');
  }

  // NOTE(victor): Must close Sentry AFTER all cleanup (so breadcrumbs are captured)
  // but BEFORE we resume Electron's quit sequence. Pending Sentry integrations
  // that hold native C++ Promise handles can crash during isolate teardown.
  await Sentry.close(1000);
}

// NOTE(victor): CRITICAL!! Disable AutomationControlled to prevent navigator.webdriver = true
// This is required to avoid Google bot detection when viewing search results
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

// App lifecycle
app.whenReady().then(async () => {
  try {
    // Set up custom protocol handlers
    setupThumbnailProtocol();

    configureTrustedMediaSession(session.defaultSession);
    configureTrustedMediaSession(session.fromPartition(WORKSTATION_PARTITION));

    // Voice model extensions are installed into app userData.
    const { getQwenAsrInstallRoot, getMoonshineInstallRoot } = await import('./services/voice-extension');
    process.env.QWEN_ASR_ASSET_DIR = getQwenAsrInstallRoot();
    process.env.MOONSHINE_ASSET_DIR = getMoonshineInstallRoot();

    // Start Express server first (this initializes workspace)
    await startExpressServer();

    // Browser control is a desktop app capability. Start the relay at app boot
    // instead of waiting for the Browser settings screen to ask for status.
    void ensureBrowserExtensionRelayRunning().catch((error) => {
      console.warn(formatOptionalBrowserExtensionRelayStartupFailureLog(error));
    });

    // Initialize i18n before building menu (menu labels use t())
    const configLanguage = await getLanguage();
    await initI18nMain(configLanguage);

    setCreateWindowHandler(async () => {
      const result = await createWorkstationWindow({
        sourceWindowId: BrowserWindow.getFocusedWindow()?.id ?? null,
      });
      if (!result.success) {
        throw new Error(result.error);
      }
    });

    // Build application menu (this loads recent folders)
    await buildApplicationMenu();

    // Set up IPC handlers with dependencies
    setupIpcHandlers({
      serverPort,
      approvalManager,
      agentTabManager,
      globalFileAccessResolver,
      cleanup,
      cachedFileTree,
      getInterpreterOverlayService: () => interpreterOverlayService,
      createWorkstationWindow,
    });

    // Initialize native theme from saved preference
    const savedTheme = await getTheme();
    nativeTheme.themeSource = savedTheme;
    await applyLaunchAtLoginSetting();

    try {
      const appLaunchCount = await incrementAppLaunchCount();
      console.log('[Main] App launch count:', appLaunchCount);
    } catch (error) {
      console.error('[Main] Failed to increment app launch count:', error);
    }

    // Create the window
    const createWindowResult = await createWindow();
    if (createWindowResult.status === 'aborted-during-teardown') {
      return;
    }

    await handlePendingNativeCrashReports({
      window: mainWindow,
      showMainWindow,
    });

    interpreterOverlayService = new InterpreterOverlayService({
      showMainWindow,
      createWorkstationWindow: async (options) => {
        return await createWorkstationWindow(options);
      },
      benchmarkMode: FORM_TESTS_MODE && FORM_TESTS_INTERACTION_MODE !== 'real',
      onTrayStateChanged: (nextTrayState) => {
        interpreterOverlayTrayState = nextTrayState;
        syncAppWindowVisibilityState();
      },
    });
    await interpreterOverlayService.start();
    interpreterOverlayTrayState = interpreterOverlayService.getTrayState();
    syncAppWindowVisibilityState();

    if (FORM_TESTS_MODE) {
      keepMainWindowHiddenForHeadlessRuns();
    }

    if (SHOULD_START_INTERPRETER_OVERLAY_DEBUG_SERVER) {
      if (!INTERPRETER_OVERLAY_DEBUG_TOKEN) {
        throw new Error(
          'INTERPRETER_OVERLAY_DEBUG_TOKEN is required when INTERPRETER_OVERLAY_DEBUG_PORT is set',
        );
      }
      formTestsDebugServer = new FormTestsDebugServer({
        port: INTERPRETER_OVERLAY_DEBUG_PORT,
        overlayService: interpreterOverlayService,
        debugAuthToken: INTERPRETER_OVERLAY_DEBUG_TOKEN,
      });
      await formTestsDebugServer.start();
    } else if (SHOULD_WARN_PACKAGED_DEBUG_SERVER_REQUEST) {
      console.warn(
        '[Main] Ignoring INTERPRETER_OVERLAY_DEBUG_PORT in packaged app run',
      );
    }

    // Initialize file watcher for workspace
    await initializeFileWatcher();

    if (!distributionProductConfig.documentEngine.releaseRepository) {
      console.log('[DocumentEngine] No engine configured; using code-and-skills workflows');
    } else if (process.env.INTERPRETER_SKIP_OFFICE_EXTENSION_INSTALL === '1') {
      console.log('[OfficeExtension] Skipping background install by environment request');
    } else {
      // Keep install warm in the background on supported platforms.
      // The server itself starts lazily from OfficeExtensionViewer -> officeExtension.ensureRunning().
      void ensureOfficeExtensionInstalledInBackground({
        importOfficeExtension: () => import('./services/office-extension'),
        isSupportedPlatform: isOfficeExtensionSupportedPlatform,
        logger: console,
        platform: process.platform,
      });
    }

    // Mark app as fully ready
    appReady = true;
    console.log('Application started successfully');

    if (app.isPackaged) {
      void ensureShellIntegrationInstalled({
        executablePath: process.execPath,
        platform: process.platform,
      }).catch((error) => {
        console.warn('[Main] Failed to install shell integration:', error);
      });
    }

    // Handle external opens from startup.
    // On packaged macOS launches Finder typically delivers files through the open-file event, but
    // source-built CLI launches pass supported paths in argv just like Windows/Linux.
    const startupArgv = getUserSuppliedArgv(process.argv);
    const startupExternalAskTargets = findExternalAskTargetsInArgv(startupArgv);
    if (startupExternalAskTargets.length > 0) {
      console.log('[Main] Found startup external ask paths in argv:', startupExternalAskTargets.length);
      queueExternalAskPaths(startupExternalAskTargets);
    }

    const startupExternalOpenTarget = startupExternalAskTargets.length > 0
      ? null
      : findExternalOpenTargetInArgv(startupArgv);
    if (startupExternalOpenTarget) {
      console.log(`[Main] Found startup ${startupExternalOpenTarget.kind} in argv:`, startupExternalOpenTarget.path);
      handleExternalOpenPath(startupExternalOpenTarget.path);
    }

    if (pendingExternalAskPaths.length > 0 && startupExternalAskTargets.length === 0) {
      const pathsToHandle = Array.from(new Set(pendingExternalAskPaths));
      pendingExternalAskPaths = [];
      queueExternalAskPaths(pathsToHandle);
    }

    // Process any pending external open from macOS open-file event (fired before app was ready)
    if (pendingExternalOpenPath) {
      if (pendingExternalOpenPath === startupExternalOpenTarget?.path) {
        pendingExternalOpenPath = null;
      } else {
      console.log('[Main] Processing pending external open:', pendingExternalOpenPath);
      const targetPath = pendingExternalOpenPath;
      pendingExternalOpenPath = null;
      handleExternalOpenPath(targetPath);
      }
    }

    // Track app launch (respects telemetryEnabled setting)
    import('../server/telemetry').then(({ trackAppLaunch }) => {
      trackAppLaunch().catch(() => {
        // Silently ignore telemetry failures
      });
    }).catch(() => {
      // Module may not be available in some contexts
    });

    // Initialize auto-updater
    initAutoUpdater();
  } catch (error) {
    console.error('Failed to start application:', error);
    appReady = false;
    // NOTE(victor): Replaced manual fetch to /v0/crash-report -- Sentry handles all crash reporting now
    Sentry.captureException(error);
    await Sentry.flush(2000);
    dialog.showErrorBox(
      'Interpreter',
      'The application failed to start.\n\nOur team has been notified. If this persists, please contact help@openinterpreter.com'
    );
    app.quit();
  }

});

// NOTE(victor): Exposed on global for Playwright test access via electronApp.evaluate()
(global as any).electronCleanup = cleanup;
(global as any).browserService = browserService;
