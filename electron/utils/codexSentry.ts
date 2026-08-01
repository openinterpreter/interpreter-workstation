import type { ErrorEvent, EventHint } from '@sentry/electron/main';
import type { MainProcessUnhandledRejectionIgnoreMatcher } from './transientNetworkErrors';

const GPU_CONTEXT_INTEGRATION = 'GpuContext';
const RENDERER_EVENT_LOOP_BLOCK_INTEGRATION = 'RendererEventLoopBlock';
const SENTRY_MINIDUMP_INTEGRATION = 'SentryMinidump';
const UNHANDLED_REJECTION_INTEGRATION = 'OnUnhandledRejection';
const UNHANDLED_REJECTION_MECHANISM = 'auto.node.onunhandledrejection';

const APP_SERVER_EXIT_RE = /codex app-server exited \(([^)]+)\)/i;
const THREAD_UNAVAILABLE_RE = /\b(?:thread not found|thread not loaded|invalid thread id)\b/i;
const STDIO_NOT_WRITABLE_RE = /\bcodex app-server stdio is not writable\b/i;
const AUTH_INVALIDATED_RE =
  /\b(?:401 unauthorized|authentication token has been invalidated|refresh token has been invalidated|refresh token has already been used|refresh_token_invalidated|refresh_token_reused|please try signing in again)\b/i;
const CHATGPT_RESPONSES_403_RE =
  /\b403 forbidden\b[\s\S]*(?:backend-api\/codex\/responses|responses_websocket)\b/i;
const PROVIDER_OVERLOADED_RE =
  /\b(?:we're currently experiencing high demand|internal_server_error|internal server error|response stream disconnected|responsestreamdisconnected|reconnecting\.\.\.)\b/i;
const RESPONSES_WEBSOCKET_500_RE =
  /\bresponses_websocket\b[\s\S]*\bhttp error:\s*500\b/i;
const MEMORY_ALLOCATION_RE = /\bmemory allocation of \d+ bytes failed\b/i;
const RMCP_UNEXPECTED_CONTENT_TYPE_RE = /\bunexpected content type:\s*none\b/i;
const PROJECT_CONFIG_DISABLED_RE = /\bproject config\.toml files are disabled\b/i;
const MODELS_CACHE_CORRUPT_RE = /\bfailed to load models cache:\s*eof while parsing a value\b/i;
const MODELS_REFRESH_TIMEOUT_RE = /\bfailed to refresh available models:[\s\S]*timeout waiting for child process to exit\b/i;
const SKILL_INVALID_FRONTMATTER_RE = /\bfailed to load skill\b[\s\S]*missing yaml frontmatter\b/i;
const SKILL_ENTRY_MISSING_RE = /\bfailed to stat skills entry\b[\s\S]*no such file or directory\b/i;
const LOGIN_SERVER_TIMEOUT_RE = /\bfailed to cancel previous login server:\s*connection timed out\b/i;
const EXTERNAL_ATTENTION_POPUP_MINIDUMP_SUFFIX =
  '/.mcp/attention-popup/globalattentionwindow.app/contents/macos/globalattentionwindow';
const PACKAGED_SOUNDS_SUBRESOURCE_PATH = '/resources/app.asar/dist/sounds/';
const DATA_AUDIO_WAV_SUBRESOURCE_PREFIX = 'data:audio/wav;';
const ONBOARDING_DEMO_VIDEO_SUBRESOURCE_PREFIX = 'https://www.openinterpreter.com/videos/demos/';
const PYTHON_FRAMEWORK_PATH = '/library/frameworks/python.framework/';
const PDFKIT_FRAMEWORK_PATH = '/system/library/frameworks/pdfkit.framework/';
const PYTHON_MALLOC_FREE_NOT_ALLOCATED_RE =
  /^Python\(\d+,[^)]+\) malloc: \*\*\* error for object 0x[0-9a-f]+: pointer being freed was not allocated\s*$/i;
const OO_EDITORS_CODESIGN_ENOENT_STDERR_RE =
  /^oo-editors stderr:\s*\[[^\]]+:ERROR:electron\/shell\/common\/mac\/codesign_util\.cc:\d+\]\s+SecCodeCopyGuestWithAttributes:\s+Error Domain=NSOSStatusErrorDomain Code=100002\b[\s\S]*\bENOENT: No such file or directory\b[\s\S]*\(100002\)$/;
const BROWSER_PROCESS_ECONNRESET_MESSAGE_RE = /^(?:Error:\s*)?read ECONNRESET$/;
const BROWSER_EXTENSION_RELAY_HOST_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost):19988(?:\/|$)/;
const BORINGSSL_BAD_DECRYPT_RE = /\bOPENSSL_internal:BAD_DECRYPT\b/;
const BORINGSSL_BAD_DECRYPT_DISPLAY_MESSAGE = 'electron browser process boringssl bad decrypt';
const BORINGSSL_BAD_DECRYPT_FAMILY = 'browser_boringssl_bad_decrypt';
const CHROMIUM_DISK_DATA_ALLOCATOR_CORRUPTION_RE =
  /\bdisk_data_allocator\.cc\b[\s\S]*\bLikely file corruption\b/i;

// NOTE(victor): These families describe the underlying Codex failure class we
// observed inside an app-server exit, not a claim that process exit was the
// correct upstream contract.
//
// In vendored `codex-rs`, many of these are modeled as normal turn/session
// errors instead of process lifecycle:
// - `RefreshTokenFailed` maps to protocol `Unauthorized`
// - `ServerOverloaded` and `InternalServerError` are classified in core error
//   handling and retry policy
// - app-server surfaces turn failures through `error` / `turn/completed`
//   notifications in `app-server/src/bespoke_event_handling.rs`
//
// The workstation still needs to report that "the app-server exited" because
// that is what Electron actually observed, but Sentry grouping should be keyed
// to the failure family rather than raw stderr/stdout payloads.
type CodexErrorFamily =
  | 'auth_invalidated'
  | 'generic_exit'
  | 'login_server_timeout'
  | 'memory_allocation_failed'
  | 'models_cache_corrupt'
  | 'models_refresh_timeout'
  | 'project_config_disabled'
  | 'provider_overloaded'
  | 'rmcp_unexpected_content_type'
  | 'skill_entry_missing'
  | 'skill_invalid_frontmatter'
  | 'stdio_not_writable'
  | 'thread_unavailable';

type CodexSentrySignature = {
  exitCode: string | null;
  family: CodexErrorFamily;
  sanitizedMessage: string;
};

type CodexDetailSource = 'stderr' | 'stdout';

type CodexDiagnosticPreview = {
  preview: string | null;
  source: CodexDetailSource | null;
};

type NamedIntegration = {
  name: string;
};

type OnUnhandledRejectionIntegrationFactory<T extends NamedIntegration> = (options: {
  ignore: MainProcessUnhandledRejectionIgnoreMatcher[];
  mode: 'none' | 'strict' | 'warn';
}) => T;

type RendererEventLoopBlockIntegrationFactory<T extends NamedIntegration> = (options: {
  captureNativeStacktrace: boolean;
}) => T;

type MainProcessFatalErrorHandlerOptions = {
  exitProcess: (code: number) => void;
  logBootstrapError: (...args: unknown[]) => void;
};

type MainProcessBeforeSendTelemetry = {
  context: {
    source: 'main';
  };
  error: Error | string;
  errorType: 'unhandled_rejection';
};

type EventException = NonNullable<NonNullable<ErrorEvent['exception']>['values']>[number];
type CapturedStackFrames = NonNullable<NonNullable<EventException['stacktrace']>['frames']>;
type CapturedStackFrame = CapturedStackFrames[number];

function isCodexEventMessage(message: string): boolean {
  return (
    APP_SERVER_EXIT_RE.test(message)
    || THREAD_UNAVAILABLE_RE.test(message)
    || STDIO_NOT_WRITABLE_RE.test(message)
  );
}

function getEventMessage(event: ErrorEvent, hint?: EventHint): string {
  const original = hint?.originalException;
  if (original instanceof Error) {
    return original.message;
  }
  if (typeof original === 'string') {
    return original;
  }
  return event.exception?.values?.find((value) => typeof value.value === 'string')?.value
    ?? event.message
    ?? event.logentry?.message
    ?? '';
}

function getCapturedEventMessage(event: ErrorEvent): string {
  return event.exception?.values?.find((value) => typeof value.value === 'string')?.value
    ?? event.message
    ?? event.logentry?.message
    ?? '';
}

function getPrimaryException(event: ErrorEvent): EventException | undefined {
  return event.exception?.values?.find((value) => typeof value.value === 'string')
    ?? event.exception?.values?.[0];
}

function isBrowserExtensionRelayEconnreset(event: ErrorEvent, hint?: EventHint): boolean {
  if (event.tags?.['event.process'] !== 'browser') {
    return false;
  }
  if (!BROWSER_PROCESS_ECONNRESET_MESSAGE_RE.test(getEventMessage(event, hint))) {
    return false;
  }

  return event.breadcrumbs?.some((breadcrumb) => {
    if (breadcrumb.category === 'browser-extension-relay') {
      return true;
    }

    const url = (breadcrumb.data as { url?: unknown } | undefined)?.url;
    return typeof url === 'string' && BROWSER_EXTENSION_RELAY_HOST_RE.test(url);
  }) ?? false;
}

function formatCapturedStackFrame(frame: CapturedStackFrame): string {
  const fn = frame.function ?? '<anonymous>';
  const filename = frame.filename ?? frame.abs_path ?? '<unknown>';
  const line = typeof frame.lineno === 'number' ? `:${frame.lineno}` : '';
  const column = typeof frame.colno === 'number' ? `:${frame.colno}` : '';

  return `    at ${fn} (${filename}${line}${column})`;
}

function buildTelemetryErrorFromEvent(event: ErrorEvent): Error | string {
  const exception = getPrimaryException(event);
  const message = typeof event.extra?.codex_raw_exit_message === 'string'
    ? event.extra.codex_raw_exit_message
    : getCapturedEventMessage(event);
  const frames = exception?.stacktrace?.frames;

  if (!exception || !frames?.length) {
    return message;
  }

  const name = typeof exception.type === 'string' && exception.type.length > 0
    ? exception.type
    : 'Error';
  const error = new Error(message);
  error.name = name;
  error.stack = `${name}: ${message}\n${frames.map(formatCapturedStackFrame).join('\n')}`;

  return error;
}

function buildCodexDiagnosticPreview(message: string): CodexDiagnosticPreview {
  const detailMatch = message.match(/^codex app-server exited \([^)]+\):\s*([\s\S]+)$/i);
  if (!detailMatch) {
    return { preview: null, source: null };
  }

  const detail = detailMatch[1]?.trim() ?? '';
  const normalized = detail.toLowerCase();
  if (normalized.startsWith('stderr:')) {
    const preview = detail.slice('stderr:'.length).trim();
    return { preview: preview || null, source: 'stderr' };
  }
  if (normalized.startsWith('stdout:')) {
    const preview = detail.slice('stdout:'.length).trim();
    return { preview: preview || null, source: 'stdout' };
  }
  if (normalized === 'stderr detail available') {
    return { preview: null, source: 'stderr' };
  }
  if (normalized === 'stdout diagnostic available') {
    return { preview: null, source: 'stdout' };
  }
  return { preview: null, source: null };
}

function classifyCodexError(message: string): CodexSentrySignature | null {
  if (!isCodexEventMessage(message)) {
    return null;
  }

  if (THREAD_UNAVAILABLE_RE.test(message)) {
    return {
      exitCode: null,
      family: 'thread_unavailable',
      sanitizedMessage: 'codex thread unavailable',
    };
  }

  if (STDIO_NOT_WRITABLE_RE.test(message)) {
    return {
      exitCode: null,
      family: 'stdio_not_writable',
      sanitizedMessage: 'codex app-server stdio not writable',
    };
  }

  const exitCode = message.match(APP_SERVER_EXIT_RE)?.[1] ?? null;
  // NOTE(victor): `auth_invalidated` and `provider_overloaded` are intentionally
  // broken out because they dominate real-world app-server exit reports, but
  // upstream core does not treat them the same way:
  // - auth invalidation is a permanent session/auth failure
  // - provider overload is a failed turn, but not an auto-retryable one
  // See codex/codex-rs/core/src/client.rs `handle_unauthorized()` and
  // codex/codex-rs/core/src/error.rs `CodexErr::is_retryable()`.
  const family: CodexErrorFamily = (() => {
    if (AUTH_INVALIDATED_RE.test(message) || CHATGPT_RESPONSES_403_RE.test(message)) {
      return 'auth_invalidated';
    }
    if (PROVIDER_OVERLOADED_RE.test(message) || RESPONSES_WEBSOCKET_500_RE.test(message)) {
      return 'provider_overloaded';
    }
    if (MEMORY_ALLOCATION_RE.test(message)) {
      return 'memory_allocation_failed';
    }
    if (RMCP_UNEXPECTED_CONTENT_TYPE_RE.test(message)) {
      return 'rmcp_unexpected_content_type';
    }
    if (PROJECT_CONFIG_DISABLED_RE.test(message)) {
      return 'project_config_disabled';
    }
    if (MODELS_CACHE_CORRUPT_RE.test(message)) {
      return 'models_cache_corrupt';
    }
    if (MODELS_REFRESH_TIMEOUT_RE.test(message)) {
      return 'models_refresh_timeout';
    }
    if (SKILL_INVALID_FRONTMATTER_RE.test(message)) {
      return 'skill_invalid_frontmatter';
    }
    if (SKILL_ENTRY_MISSING_RE.test(message)) {
      return 'skill_entry_missing';
    }
    if (LOGIN_SERVER_TIMEOUT_RE.test(message)) {
      return 'login_server_timeout';
    }
    return 'generic_exit';
  })();

  return {
    exitCode,
    family,
    sanitizedMessage: `codex app-server exited (${exitCode ?? 'none'}): ${family}`,
  };
}

function buildSanitizedDisplayMessage(
  signature: CodexSentrySignature,
  diagnostic: CodexDiagnosticPreview,
): string {
  if (signature.family !== 'generic_exit' || !diagnostic.preview) {
    return signature.sanitizedMessage;
  }

  return `${signature.sanitizedMessage} [${diagnostic.preview}]`;
}

// NOTE(victor): Electron main enables `OnUncaughtException` and Node
// `OnUnhandledRejection` by default in
// `@sentry/electron/main/sdk.js#getDefaultIntegrations()`.
//
// Replace the default rejection integration instead of adding a parallel raw
// `process.on('unhandledRejection')` listener so the main process has one owner
// for rejection capture. `@sentry/node-core` documents that the replacement can
// keep Sentry's rejection metadata while customizing `mode` and `ignore`.
export function configureMainProcessSentryIntegrations<T extends NamedIntegration>(
  integrations: readonly T[],
  createOnUnhandledRejectionIntegration: OnUnhandledRejectionIntegrationFactory<T>,
  ignoreMatchers: readonly MainProcessUnhandledRejectionIgnoreMatcher[],
  createRendererEventLoopBlockIntegration?: RendererEventLoopBlockIntegrationFactory<T>,
): T[] {
  const configured: T[] = [];
  let replacedRendererEventLoopBlock = false;
  let replacedUnhandledRejection = false;

  for (const integration of integrations) {
    if (integration.name === GPU_CONTEXT_INTEGRATION) {
      continue;
    }

    if (integration.name === SENTRY_MINIDUMP_INTEGRATION) {
      // NOTE(native-crash-reports): Sentry documents that SentryMinidump is the
      // default native path and removing it disables native reporting. Signal
      // Desktop keeps Electron crashReporter local with uploadToServer=false,
      // while VS Code derives crash reporting from persisted telemetry state.
      // Keep electron/crashReports.ts as our single approval-gated native path.
      // Sentry: https://github.com/getsentry/sentry-electron/blob/master/MIGRATION.md#disable-native-crash-reporting
      // Signal: https://github.com/signalapp/Signal-Desktop/blob/main/app/crashReports.main.ts#L111-L114
      // VS Code: https://github.com/microsoft/vscode/blob/main/src/vs/code/electron-main/app.ts#L1727-L1764
      continue;
    }

    if (integration.name === RENDERER_EVENT_LOOP_BLOCK_INTEGRATION && createRendererEventLoopBlockIntegration) {
      configured.push(createRendererEventLoopBlockIntegration({
        captureNativeStacktrace: true,
      }));
      replacedRendererEventLoopBlock = true;
      continue;
    }

    if (integration.name === UNHANDLED_REJECTION_INTEGRATION) {
      configured.push(createOnUnhandledRejectionIntegration({
        ignore: [...ignoreMatchers],
        mode: 'none',
      }));
      replacedUnhandledRejection = true;
      continue;
    }

    configured.push(integration);
  }

  if (createRendererEventLoopBlockIntegration && !replacedRendererEventLoopBlock) {
    configured.push(createRendererEventLoopBlockIntegration({
      captureNativeStacktrace: true,
    }));
  }

  if (!replacedUnhandledRejection) {
    configured.push(createOnUnhandledRejectionIntegration({
      ignore: [...ignoreMatchers],
      mode: 'none',
    }));
  }

  return configured;
}

// NOTE(victor): Since `@sentry/electron` v0.7.0 the SDK no longer exits the app
// automatically after an uncaught main-process exception; callers must provide
// `onFatalError` if they want an authoritative crash policy. The Electron main
// uncaught integration flushes first, then invokes `onFatalError`.
//
// Keep this callback synchronous. `process.exit()` does not wait for arbitrary
// async work, so repo-specific network telemetry here would be best-effort at
// best and misleading at worst. Sentry itself has already flushed the crash.
export function buildMainProcessFatalErrorHandler({
  exitProcess,
  logBootstrapError,
}: MainProcessFatalErrorHandlerOptions): (firstError: Error, secondError?: Error) => void {
  return (firstError: Error, secondError?: Error): void => {
    const fatalError = firstError instanceof Error
      ? firstError
      : new Error(String(firstError ?? 'Unknown main-process fatal error'));

    logBootstrapError('[Main] Uncaught exception:', fatalError);
    if (secondError) {
      logBootstrapError('[Main] Secondary fatal exception while handling uncaught exception:', secondError);
    }

    exitProcess(1);
  };
}

function hasMechanismType(event: ErrorEvent, mechanismType: string): boolean {
  return event.exception?.values?.some((value) => value.mechanism?.type === mechanismType) ?? false;
}

function normalizeDebugImageCodeFile(codeFile: string): string {
  return codeFile.split('\\').join('/').toLowerCase();
}

function getContextString(
  event: ErrorEvent,
  contextName: string,
  key: string,
): string | null {
  const contexts = event.contexts as Record<string, unknown> | undefined;
  if (!contexts) {
    return null;
  }

  const context = contexts[contextName];
  if (!context || typeof context !== 'object') {
    return null;
  }

  const value = (context as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

function getContextStringArray(
  event: ErrorEvent,
  contextName: string,
  key: string,
): string[] {
  const contexts = event.contexts as Record<string, unknown> | undefined;
  if (!contexts) {
    return [];
  }

  const context = contexts[contextName];
  if (!context || typeof context !== 'object') {
    return [];
  }

  const value = (context as Record<string, unknown>)[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function hasElectronContextValueMatching(event: ErrorEvent, matcher: RegExp): boolean {
  const contexts = event.contexts as Record<string, unknown> | undefined;
  const context = contexts?.electron;
  if (!context || typeof context !== 'object') {
    return false;
  }

  return Object.values(context as Record<string, unknown>).some((value) => {
    if (typeof value === 'string') {
      return matcher.test(value);
    }
    if (Array.isArray(value)) {
      return value.some((item) => typeof item === 'string' && matcher.test(item));
    }
    return false;
  });
}

function getTagString(event: ErrorEvent, key: string): string | null {
  const value = event.tags?.[key];
  return typeof value === 'string' ? value : null;
}

function getNativeCrashProcess(event: ErrorEvent): string {
  const processTag = getTagString(event, 'event.process');
  if (processTag && processTag !== 'unknown') {
    return processTag;
  }

  // NOTE(victor): Sentry #1997 reported `event.process=unknown`, but
  // Crashpad's Electron Framework context still recorded `process_type=browser`.
  const electronProcess = getContextString(event, 'electron', 'crashpad.process_type');
  if (electronProcess) {
    return electronProcess;
  }

  const frameworkProcess = getContextString(event, 'Electron Framework', 'process_type');
  if (frameworkProcess) {
    return frameworkProcess;
  }

  return 'unknown';
}

function hasDebugImageCodeFileIncluding(event: ErrorEvent, needle: string): boolean {
  const normalizedNeedle = needle.toLowerCase();

  return event.debug_meta?.images?.some((image) => {
    return typeof image.code_file === 'string'
      && normalizeDebugImageCodeFile(image.code_file).includes(normalizedNeedle);
  }) ?? false;
}

function getElectronCrashDetails(event: ErrorEvent): Record<string, unknown> | null {
  const contexts = event.contexts as Record<string, unknown> | undefined;
  const electronContext = contexts?.electron;
  if (!electronContext || typeof electronContext !== 'object') {
    return null;
  }

  const details = (electronContext as Record<string, unknown>).details;
  return details && typeof details === 'object' ? details as Record<string, unknown> : null;
}

function isNativeElectronMinidump(event: ErrorEvent, processTag?: string): boolean {
  if (event.platform !== 'native'
    || event.level !== 'fatal'
    || getTagString(event, 'event.environment') !== 'native'
    || getTagString(event, 'event.origin') !== 'electron'
    || getTagString(event, 'mechanism') !== 'minidump') {
    return false;
  }

  return processTag === undefined || getTagString(event, 'event.process') === processTag;
}

function isUnknownProcessNativeElectronMinidump(event: ErrorEvent): boolean {
  return isNativeElectronMinidump(event, 'unknown');
}

function isUnhandledNativeMinidump(event: ErrorEvent): boolean {
  return isNativeElectronMinidump(event);
}

// NOTE(victor): Issue #854 was a native macOS minidump for
// `~/.mcp/attention-popup/GlobalAttentionWindow.app/...`, an external helper
// that is unpacked outside this repo, outside our shipped app bundle, and not a
// dependency in this repo's `node_modules`. The mirrored Sentry payload shows
// the crash occurs during Cocoa startup inside that helper, so we drop the event
// here to avoid misclassifying a third-party helper crash as an Interpreter
// main-process crash. A root-cause fix would need to land in the upstream
// helper, not in this repo's TypeScript code.
function isExternalAttentionPopupMinidump(event: ErrorEvent): boolean {
  const mechanism = typeof event.tags?.mechanism === 'string'
    ? event.tags.mechanism.toLowerCase()
    : '';
  if (mechanism !== 'minidump') {
    return false;
  }

  return event.debug_meta?.images?.some((image) => {
    return typeof image.code_file === 'string'
      && normalizeDebugImageCodeFile(image.code_file).endsWith(EXTERNAL_ATTENTION_POPUP_MINIDUMP_SUFFIX);
  }) ?? false;
}

/*
Issues #1092 and #1171 evidence block.
Sources: GitHub issues https://github.com/openinterpreter/iworkstation/issues/1092
and https://github.com/openinterpreter/iworkstation/issues/1171, Sentry issues
7438036486 / ELECTRON-B8 and 7455581632 / ELECTRON-CG, Sentry events
dc8a3f1f78e841ebb5d95f3f2adffaf9 and 33adbc88d9ba4a3590b247e150acb6a8,
and @sentry/electron SentryMinidump integration in
node_modules/@sentry/electron/main/integrations/sentry-minidump/index.js.

#1092 (ELECTRON-B8, dc8a3f1f78e841ebb5d95f3f2adffaf9):
Exact Sentry error: Fatal Error: EXCEPTION_ACCESS_VIOLATION_READ / 0xffffffffffffffff.
Server-symbolicated metadata: function=blink::BaseFetchContext::CanRequestInternal,
filename=base_fetch_context.cc, in_app_frame_mix=system-only.
Runtime tags: platform=native, level=fatal, event.process=renderer,
exit.reason=crashed, release=interpreter@0.2.142, runtime=Electron 39.8.6,
os=Windows 10.0.26200.
Crashpad context (from event JSON):
  electron.crashpad.process_type=renderer,
  electron.crashpad.subresource_url=file:///C:/Program%20Files/Interpreter/resources/app.asar/dist/sounds/chirp.wav,
  electron.details.exitCode=-1073741819, electron.details.reason=crashed.

#1171 (ELECTRON-CG, 33adbc88d9ba4a3590b247e150acb6a8):
Exact Sentry error: Fatal Error: EXCEPTION_ACCESS_VIOLATION_EXEC / 0x7ff70683b1c4.
Server-symbolicated metadata: function=cppgc::internal::ConcurrentMarkingTask::Run,
filename=concurrent-marker.cc, in_app_frame_mix=system-only.
Runtime tags: platform=native, level=fatal, event.process=renderer,
exit.reason=crashed, mechanism=minidump, release=interpreter@0.2.152,
runtime=Electron 39.8.9, os=Windows 10.0.19045.
Crashpad context (from `sentry event view 33adbc88d9ba --json`, contexts.electron):
  electron.crashpad.process_type=renderer,
  electron.crashpad.subresource_url=data:audio/wav;base64,UklGRs6dJwBXQVZFZm10IA...,
  electron.details.exitCode=-1073741819, electron.details.reason=crashed.
NOTE: the crashpad fields are NOT in the GitHub issue raw payload (the issue
template only includes tags and breadcrumbs). The full contexts block including
crashpad.subresource_url is only available via the Sentry API/CLI.

Both crashes are Chromium-internal (in_app_frame_mix=system-only, stack is
entirely blink/cppgc/base). Not actionable by the app; filtered to reduce
Sentry noise.

beforeSend runs before Sentry server symbolicates the minidump, so the exact
crash function/filename are not available here. The precise client-side
signature is therefore the native renderer crash plus the Crashpad WAV
subresource from the same minidump:
- packaged WAV path in app resources (`file:///.../dist/sounds/*.wav`)
- inline WAV data URL payloads (`data:audio/wav;base64,...`)
*/
function isRendererPackagedSoundNativeCrash(event: ErrorEvent): boolean {
  if (event.platform !== 'native' || event.level !== 'fatal') {
    return false;
  }

  if (getTagString(event, 'event.environment') !== 'native') {
    return false;
  }
  if (getTagString(event, 'event.process') !== 'renderer') {
    return false;
  }
  if (getTagString(event, 'exit.reason') !== 'crashed') {
    return false;
  }

  if (getContextString(event, 'electron', 'crashpad.process_type') !== 'renderer') {
    return false;
  }

  const details = getElectronCrashDetails(event);
  if (details?.reason !== 'crashed' || details.exitCode !== -1073741819) {
    return false;
  }

  const subresourceUrl = getContextString(event, 'electron', 'crashpad.subresource_url');
  if (!subresourceUrl) {
    return false;
  }
  const normalizedSubresourceUrl = subresourceUrl.split('\\').join('/').toLowerCase();

  return (
    (normalizedSubresourceUrl.startsWith('file:///')
    && normalizedSubresourceUrl.includes(PACKAGED_SOUNDS_SUBRESOURCE_PATH)
    && normalizedSubresourceUrl.endsWith('.wav'))
  ) || normalizedSubresourceUrl.startsWith(DATA_AUDIO_WAV_SUBRESOURCE_PREFIX);
}

/*
Issue #1102, #1120, #1961, #1962, #2024, and #2025 evidence block.
Sources: GitHub issues https://github.com/openinterpreter/iworkstation/issues/1102
and https://github.com/openinterpreter/iworkstation/issues/1120; support mirrors
https://github.com/openinterpreter/iworkstation-issues/issues/1961,
https://github.com/openinterpreter/iworkstation-issues/issues/1962,
https://github.com/openinterpreter/iworkstation-issues/issues/2024, and
https://github.com/openinterpreter/iworkstation-issues/issues/2025; Sentry
issues 7439854031 / ELECTRON-BJ, 7447890242 / ELECTRON-BR, 7475517348 /
ELECTRON-DW, and 7489631718 / ELECTRON-EE; Sentry events
c99d59117ee44905b859f059562e5cc8, e483f644cc2a41c6875a185c9e6e5b44,
c21eb8adeaeb4237b54ec71ce4b27c4a,
6ce5efc672fa44e2bb12f48c3b249142, and
941b80c42fbb4885a96e0f2fb6344d2d; related issue 7439793906 /
ELECTRON-BH event 5c53340e17604949a514d2054ee90d4c, trace id
a8d4379ee3f44944b1197340f69ece85, and @sentry/electron SentryMinidump
integration in node_modules/@sentry/electron/main/integrations/sentry-minidump/index.js.

Exact Sentry error: Fatal Error: *::OnNoMemoryInternal (oom.cc), system-only.
Runtime tags: platform=native, level=fatal, event.environment=native,
event.origin=electron, event.process=renderer, exit.reason=crashed,
mechanism=minidump.
Crashpad context: electron.crashed_url=app:///dist/index.html,
electron.crashpad.process_type=renderer, electron.crashpad.ptype=renderer,
electron.details.reason=crashed, electron.details.exitCode=133
(Linux, issue #1102) or 5 (macOS, issue #1120), and
electron.crashpad.platform=linux|darwin.

beforeSend runs before Sentry server symbolicates the minidump, so the exact
OnNoMemoryInternal function/filename are not available here. Match the client
side native renderer Crashpad signature instead of the later issue title.
*/
function isRendererPartitionAllocOomMinidump(event: ErrorEvent): boolean {
  if (event.platform !== 'native' || event.level !== 'fatal') {
    return false;
  }

  if (getTagString(event, 'event.environment') !== 'native') {
    return false;
  }
  if (getTagString(event, 'event.origin') !== 'electron') {
    return false;
  }
  if (getTagString(event, 'event.process') !== 'renderer') {
    return false;
  }
  if (getTagString(event, 'exit.reason') !== 'crashed') {
    return false;
  }
  if (getTagString(event, 'mechanism') !== 'minidump') {
    return false;
  }

  if (getContextString(event, 'electron', 'crashed_url') !== 'app:///dist/index.html') {
    return false;
  }
  const crashpadPlatform = getContextString(event, 'electron', 'crashpad.platform');
  if (crashpadPlatform !== 'linux' && crashpadPlatform !== 'darwin') {
    return false;
  }
  if (getContextString(event, 'electron', 'crashpad.process_type') !== 'renderer') {
    return false;
  }
  if (getContextString(event, 'electron', 'crashpad.ptype') !== 'renderer') {
    return false;
  }

  const details = getElectronCrashDetails(event);
  if (details?.reason !== 'crashed') {
    return false;
  }

  return details.exitCode === 133 || details.exitCode === 5;
}

/*
Issues #1868, #1864, #1861, #1720 evidence block.
Sources: sentry_sample_details.json from the fix/fatal_sentry triage.

Windows renderer OOM crashes surface as RaiseException with exit.reason=oom
(set by Electron's render-process-gone handler). Unlike Linux/macOS, where OOM
manifests as exit.reason=crashed + specific exit codes matched by
isRendererPartitionAllocOomMinidump above, Windows explicitly sets the oom
reason. Match that tag to consistently label all renderer OOM events regardless
of platform.
*/
function isExplicitRendererOomEvent(event: ErrorEvent): boolean {
  if (event.platform !== 'native' || event.level !== 'fatal') {
    return false;
  }

  return getTagString(event, 'event.process') === 'renderer'
    && getTagString(event, 'exit.reason') === 'oom';
}

function tagRendererOomEvent(event: ErrorEvent): ErrorEvent {
  event.tags = {
    ...event.tags,
    'crash.category': 'renderer-oom',
    'crash.signal': 'oom',
    'crash.process': 'renderer',
  };
  return event;
}

/*
Issues #1750, #1751, #1909, #1910, #1959, #1960, #1964, #1970, #1980-#1983,
#1986, #1987, #2073, #2074, and #2077-#2084 evidence block.
Sources: GitHub issues #1750, #1751, #1909, #1910, #1959, #1960, #1964,
#1970, #1980-#1983, #1986, #1987, #2073, #2074, and #2077-#2084; Sentry
issues 7448227228 / ELECTRON-BT, 7456212831 / ELECTRON-CM, 7469284349 /
ELECTRON-DG, 7480595613 / ELECTRON-E0, 7480662879 / ELECTRON-E1,
7481078151 / ELECTRON-E2, 7479667874, 7500947943, 7501411091, 7501424886,
and 7501433127.

Server-symbolicated frames include TurboshaftSpecialRPONumberer
(instruction-selection-phase.cc), Object::GetPrototypeChainRootMap (objects.cc),
and Factory::NewForeign<T> (factory-inl.h). beforeSend runs before those frames
exist, so match the client-side Crashpad signature instead: native fatal
Windows renderer minidump, crashed app URL/reason, and an onboarding demo video
subresource. The sanitizer checks the exact access-violation exit code at the
drop gate so breakpoint video crashes stay reported.

Support issues #1964/#1970 can look like generic native access violations from
their Sentry issue titles, Builtins_RecordWriteSaveFP and
MarkCompactCollector::ProcessMarkingWorklist<T>. The full raw Sentry payloads
also carry the markdown onboarding demo video subresource and Windows
access-violation exit code, so keep them in this block instead of moving them to
the generic native minidump fallback.

Prior art checked on 2026-05-22: VS Code handles Electron process loss by
keying renderer and GPU paths to `{reason, exitCode}` from `render-process-gone`
and `child-process-gone`:
https://github.com/microsoft/vscode/blob/b4b5c20cbbaa6de0c0c1f5430519ee3f3080c53b/src/vs/platform/windows/electron-main/windowImpl.ts
https://github.com/microsoft/vscode/blob/b4b5c20cbbaa6de0c0c1f5430519ee3f3080c53b/src/vs/code/electron-main/app.ts
Signal Desktop ignores `clean-exit` but treats other `render-process-gone`
events as fatal process loss with the same reason/exitCode fields:
https://github.com/signalapp/Signal-Desktop/blob/a8f91c2c20bc21a4c40c0fcca67beeeeee61915b/app/global_errors.main.ts
*/
// NOTE(victor): Issues #1978/#1979 matched this onboarding-video minidump with
// EXCEPTION_PRIV_INSTRUCTION. Keep it reportable like VS Code's reason/exitCode
// process-error telemetry:
// https://github.com/microsoft/vscode/blob/main/src/vs/platform/windows/electron-main/windowImpl.ts
function isWindowsRendererOnboardingVideoMinidump(event: ErrorEvent): boolean {
  if (event.platform !== 'native' || event.level !== 'fatal') {
    return false;
  }

  if (getTagString(event, 'event.environment') !== 'native') {
    return false;
  }
  if (getTagString(event, 'event.origin') !== 'electron') {
    return false;
  }
  if (getTagString(event, 'event.process') !== 'renderer') {
    return false;
  }
  if (getTagString(event, 'exit.reason') !== 'crashed') {
    return false;
  }
  if (getTagString(event, 'mechanism') !== 'minidump') {
    return false;
  }

  if (getContextString(event, 'electron', 'crashed_url') !== 'app:///dist/index.html') {
    return false;
  }
  if (getContextString(event, 'electron', 'crashpad.platform') !== 'win32') {
    return false;
  }
  if (getContextString(event, 'electron', 'crashpad.process_type') !== 'renderer') {
    return false;
  }

  const details = getElectronCrashDetails(event);
  if (details?.reason !== 'crashed') {
    return false;
  }

  const subresourceUrl = getContextString(event, 'electron', 'crashpad.subresource_url');
  if (!subresourceUrl) {
    return false;
  }
  const normalizedSubresourceUrl = subresourceUrl.split('\\').join('/').toLowerCase();

  return normalizedSubresourceUrl.startsWith(ONBOARDING_DEMO_VIDEO_SUBRESOURCE_PREFIX)
    && normalizedSubresourceUrl.endsWith('.mp4');
}

function getWindowsRendererOnboardingVideoName(event: ErrorEvent): string | null {
  const subresourceUrl = getContextString(event, 'electron', 'crashpad.subresource_url');
  if (!subresourceUrl) {
    return null;
  }
  const normalizedSubresourceUrl = subresourceUrl.split('\\').join('/').toLowerCase();
  if (!normalizedSubresourceUrl.startsWith(ONBOARDING_DEMO_VIDEO_SUBRESOURCE_PREFIX)
    || !normalizedSubresourceUrl.endsWith('.mp4')) {
    return null;
  }

  return normalizedSubresourceUrl.split('/').pop() ?? null;
}

function tagWindowsRendererOnboardingVideoMinidump(event: ErrorEvent): ErrorEvent {
  const exception = getPrimaryException(event);
  const signal = classifyNativeCrashSignal(exception?.value ?? '');
  const demoVideoName = getWindowsRendererOnboardingVideoName(event);

  event.tags = {
    ...event.tags,
    'crash.category': 'renderer-onboarding-video',
    'crash.process': 'renderer',
    'crash.signal': signal,
    ...(demoVideoName
      ? { 'onboarding.demo_video': demoVideoName }
      : {}),
  };

  return event;
}

/*
Issues #1746 and #1747 evidence block.
Sources: GitHub issues https://github.com/openinterpreter/iworkstation-issues/issues/1746
and https://github.com/openinterpreter/iworkstation-issues/issues/1747,
Sentry issue 7447922861 / ELECTRON-BS, and Sentry event
https://openinterpreter.sentry.io/issues/7447922861/events/5b2f8660abaf4fe0be66747bb12ff418/.

Server-symbolicated metadata: function=__pthread_kill, in_app_frame_mix=system-only.
Runtime tags: platform=native, level=fatal, event.environment=native,
event.origin=electron, event.process=unknown, mechanism=minidump,
release=interpreter@0.2.144, runtime=Electron 39.8.9, os=macOS 26.4.
The crashed image set and stack belong to external
/Library/Frameworks/Python.framework/.../Python loading PyObjC, libffi, and
/System/Library/Frameworks/PDFKit.framework/.../PDFKit.
The macOS crash contexts include LaunchServices sandbox denial for
com.apple.coreservices.launchservicesd and HIServices aborting because the
external Python process cannot get an application ASN.

This is not an Interpreter renderer or main-process PDF bug. Keep the match
tied to the external Python + PDFKit images plus both LaunchServices/HIServices
abort annotations so unrelated native minidumps still reach Sentry.
*/
function isExternalPythonPdfKitLaunchServicesMinidump(event: ErrorEvent): boolean {
  if (!isUnknownProcessNativeElectronMinidump(event)) {
    return false;
  }

  if (!hasDebugImageCodeFileIncluding(event, PYTHON_FRAMEWORK_PATH)) {
    return false;
  }
  if (!hasDebugImageCodeFileIncluding(event, PDFKIT_FRAMEWORK_PATH)) {
    return false;
  }

  const launchServicesAnnotations = getContextStringArray(event, 'LaunchServices', 'annotations');
  const hiServicesAnnotations = getContextStringArray(event, 'HIServices', 'annotations');

  return launchServicesAnnotations.some((annotation) => (
    annotation.includes('sandbox denied the right to lookup com.apple.coreservices.launchservicesd')
  )) && hiServicesAnnotations.some((annotation) => (
    annotation.includes('unable to get application ASN from launchservicesd')
  ));
}

// NOTE(victor): Issues #2088/#2089, Sentry 7501525488 / ELECTRON-F2,
// event 3d9289f8d81142868d818e339c24516d, are unknown-process macOS
// minidumps where libmalloc reports an external Python process freeing an
// unallocated pointer. That is not an Interpreter renderer or main-process
// crash, so filter only the exact Python malloc annotation shape.
function isExternalPythonMallocAbortMinidump(event: ErrorEvent): boolean {
  if (!isUnknownProcessNativeElectronMinidump(event)) {
    return false;
  }

  return getContextStringArray(event, 'libsystem_malloc.dylib', 'annotations')
    .some((annotation) => PYTHON_MALLOC_FREE_NOT_ALLOCATED_RE.test(annotation));
}

// NOTE(victor): Issues #1990/#1991, Sentry 7482009921 / ELECTRON-E4,
// events 8a09035da2b44017b3437a6b794785c9 and c2df6566cd1f4b82a150187d2d3ad6fb
// are unknown-process minidumps for Homebrew Node missing `libllhttp`, outside
// the Interpreter bundle and renderer.
function isExternalHomebrewNodeDyldMinidump(event: ErrorEvent): boolean {
  if (!isUnknownProcessNativeElectronMinidump(event)) {
    return false;
  }

  return getContextStringArray(event, 'dyld', 'annotations').some(isHomebrewNodeLlhttpDyldAnnotation);
}

function isHomebrewNodeLlhttpDyldAnnotation(annotation: string): boolean {
  const normalized = annotation.toLowerCase();
  return normalized.includes('library not loaded: /usr/local/opt/llhttp/lib/libllhttp.')
    && normalized.includes('.dylib')
    && normalized.includes('referenced from:')
    && normalized.includes('/usr/local/cellar/node/')
    && normalized.includes('/bin/node')
    && normalized.includes('no such file');
}

function isOoEditorsCodesignEnoentStderr(event: ErrorEvent, message: string): boolean {
  return event.platform === 'node'
    && event.level === 'error'
    && getTagString(event, 'event.origin') === 'electron'
    && getTagString(event, 'event.process') === 'browser'
    && OO_EDITORS_CODESIGN_ENOENT_STDERR_RE.test(message);
}

function isBrowserProcessBoringSslBadDecrypt(event: ErrorEvent, message: string): boolean {
  return event.platform === 'node'
    && event.level === 'fatal'
    && getTagString(event, 'event.environment') === 'javascript'
    && getTagString(event, 'event.origin') === 'electron'
    && getTagString(event, 'event.process') === 'browser'
    && getTagString(event, 'mechanism') === 'generic'
    && BORINGSSL_BAD_DECRYPT_RE.test(message);
}

// NOTE(victor): #1972 / ELECTRON-DX is a reportable browser-process fatal with
// no stack and only a BoringSSL BAD_DECRYPT payload. Keep the event, but
// normalize the high-cardinality OpenSSL prefix while retaining the raw value in
// `extra`.
function tagBrowserProcessBoringSslBadDecrypt(event: ErrorEvent, rawMessage: string): ErrorEvent {
  event.extra = {
    ...event.extra,
    electron_raw_bad_decrypt_message: rawMessage,
  };
  event.contexts = {
    ...event.contexts,
    electronDiagnostic: {
      errorFamily: BORINGSSL_BAD_DECRYPT_FAMILY,
      sanitized: true,
    },
  };

  if (event.exception?.values) {
    for (const value of event.exception.values) {
      if (typeof value.value === 'string' && BORINGSSL_BAD_DECRYPT_RE.test(value.value)) {
        value.value = BORINGSSL_BAD_DECRYPT_DISPLAY_MESSAGE;
      }
    }
  }

  event.message = BORINGSSL_BAD_DECRYPT_DISPLAY_MESSAGE;
  if (event.logentry?.message && BORINGSSL_BAD_DECRYPT_RE.test(event.logentry.message)) {
    event.logentry.message = BORINGSSL_BAD_DECRYPT_DISPLAY_MESSAGE;
  }
  if (typeof event.transaction === 'string' && BORINGSSL_BAD_DECRYPT_RE.test(event.transaction)) {
    event.transaction = BORINGSSL_BAD_DECRYPT_DISPLAY_MESSAGE;
  }

  event.tags = {
    ...event.tags,
    'crash.category': 'browser-boringssl-bad-decrypt',
    'crash.process': 'browser',
    'electron.error.family': BORINGSSL_BAD_DECRYPT_FAMILY,
    'electron.error.sanitized': 'true',
  };
  event.fingerprint = ['electron-browser', 'boringssl-bad-decrypt'];

  return event;
}

// =============================================================================
// NATIVE MINIDUMP CRASH CATEGORIZATION
//
// beforeSend runs before Sentry server symbolicates the minidump, so the exact
// crash function/filename are NOT available here. What IS available:
//   - Exception type/value from the minidump exception record
//   - Tags: event.process, exit.reason, mechanism, event.environment
//   - Contexts: electron.crashpad.*, electron.details.*
//   - Debug images: code_file paths
//
// We classify by crash signal type (from the exception record) and Electron
// process type, which are both available pre-symbolication.
//
// Support issue closure policy for native/runtime crash families:
//
// These Sentry mirrors often name V8, Chromium, BoringSSL, SQLite, Electron, or
// OS frames. Those frames are not app-owned TypeScript callsites, and a desktop
// app cannot patch them directly from this repo. The app-owned work is to make
// the crash actionable: keep it reportable, tag the stable native signature,
// record the Electron process/reason/signal, and recover or surface the failure
// where Electron gives us a boundary.
//
// That is the same shape used by mature Electron apps. VS Code records renderer
// process failures as reason/exitCode telemetry, shows a reopen/close dialog,
// and separately records GPU crash state after Electron refreshes GPU feature
// status. Signal Desktop logs non-clean renderer exits, shows the crash details,
// and exits instead of pretending the native renderer root was fixed in app JS.
//
// GitHub search for the current signatures did not show an app-level patch for
// these Electron/Chromium/V8/SQLite roots. The useful examples were scoped
// mitigations: Bazel retries a known Netty BAD_DECRYPT race after an upstream
// Netty bug, other projects treat BAD_DECRYPT as corrupted credentials/data or
// transport corruption, and Chromium disk_data_allocator reports point at disk
// or cache corruption. None justify suppressing these events or claiming an
// app-source root-cause patch.
//
// Therefore future PRs should use `Closes` for support mirror issues when the
// PR fully resolves the app-owned obligation: classification is stable, events
// remain visible to Sentry, tests cover the signature, and the PR body states
// that upstream/native roots remain outside this repo. Use `Addresses` only
// when the PR does partial triage without making the issue closed-actionable.
//
// References:
// https://github.com/microsoft/vscode/blob/b4b5c20cbbaa6de0c0c1f5430519ee3f3080c53b/src/vs/platform/windows/electron-main/windowImpl.ts#L810-L814
// https://github.com/microsoft/vscode/blob/b4b5c20cbbaa6de0c0c1f5430519ee3f3080c53b/src/vs/platform/windows/electron-main/windowImpl.ts#L890-L928
// https://github.com/microsoft/vscode/blob/b4b5c20cbbaa6de0c0c1f5430519ee3f3080c53b/src/vs/code/electron-main/app.ts#L1589-L1625
// https://github.com/signalapp/Signal-Desktop/blob/a8f91c2c20bc21a4c40c0fcca67beeeeee61915b/app/global_errors.main.ts#L65-L75
// https://github.com/bazelbuild/bazel/blob/b16ab9f2e424d0783efb19ea2c577a3d13a1743e/src/main/java/com/google/devtools/build/lib/remote/RemoteModule.java
// =============================================================================

const NATIVE_OOM_VALUE_RE = /\bOut of Memory\b/i;
const NATIVE_ACCESS_VIOLATION_RE = /\bEXCEPTION_ACCESS_VIOLATION/;
const NATIVE_BREAKPOINT_RE = /\bEXCEPTION_BREAKPOINT\b/;
const NATIVE_PRIV_INSTRUCTION_RE = /\bEXCEPTION_PRIV_INSTRUCTION\b/;
const NATIVE_EXC_BREAKPOINT_RE = /\bEXC_BREAKPOINT\b/;
const NATIVE_EXC_BAD_INSTRUCTION_RE = /\bEXC_BAD_INSTRUCTION\b/;
const NATIVE_SIGBUS_RE = /\bSIGBUS\b/;
const NATIVE_SIGSEGV_RE = /\bSIGSEGV\b/;
const NATIVE_SIGABRT_RE = /\bSIGABRT\b/;
const NATIVE_SIGTRAP_RE = /\bSIGTRAP\b/;
const NATIVE_EXC_BAD_ACCESS_RE = /\bEXC_BAD_ACCESS\b/;
// NOTE(victor): ELECTRON-DE / support issues #1913 and #1914 are classification
// only, not an ignore rule. The reported event is an Electron Crashpad minidump:
// Electron documents native crash uploads as `upload_file_minidump` plus process
// metadata such as `process_type`, and Sentry's Symbolicator symbolicates
// minidumps server-side. At `beforeSend` time we only have the unsymbolicated
// exception record and tags, not the final native frame ownership.
//
// The Windows frame `RaiseException` is not itself an Interpreter callsite.
// Microsoft documents `RaiseException` as the generic Structured Exception
// Handling API used to raise application-defined software exceptions in the
// calling thread. The ELECTRON-DE Sentry payload only showed:
//   - metadata.function = RaiseException
//   - metadata.value = Fatal Error: Unhandled C++ Exception / 0x7ffc722273fa
//   - metadata.in_app_frame_mix = system-only
//   - event.process = browser
//   - mechanism = minidump
//
// So the app-actionable signal here is "native browser-process C++ exception",
// not "our TypeScript/JavaScript bug at this source line". Keep the crash in
// Sentry and tag it for triage; do not drop it, force a fingerprint, or treat
// this as proof of a root-cause fix. If a later symbolicated event, repro, or
// owned native frame points at Interpreter code, fix that callsite instead of
// adding a filter here.
//
// Sources:
// - Electron crashReporter payload: https://www.electronjs.org/docs/latest/api/crash-reporter
// - Sentry Symbolicator minidump API: https://getsentry.github.io/symbolicator/api/
// - Windows RaiseException API: https://learn.microsoft.com/windows/win32/api/errhandlingapi/nf-errhandlingapi-raiseexception
const NATIVE_CPP_EXCEPTION_RE = /\bUnhandled C\+\+ Exception\b/i;
const GPU_ABNORMAL_EXIT_WARNING_RE = /\bGPU\b.*\babnormal-exit\b/i;

type NativeCrashSignal =
  | 'oom'
  | 'access-violation'
  | 'breakpoint'
  | 'priv-instruction'
  | 'exc-breakpoint'
  | 'sigbus'
  | 'sigsegv'
  | 'sigabrt'
  | 'sigtrap'
  | 'exc-bad-access'
  | 'exc-bad-instruction'
  | 'cpp-exception'
  | 'unknown';

type NativeOomCrashCategory = 'renderer-oom' | 'browser-oom' | 'process-oom';
type NativeCrashCategory =
  | NativeOomCrashCategory
  | 'gpu-process-crash'
  | 'utility-process-crash'
  | `native-${NativeCrashSignal}`;

function classifyNativeCrashSignal(exceptionValue: string): NativeCrashSignal {
  if (NATIVE_OOM_VALUE_RE.test(exceptionValue)) return 'oom';
  if (NATIVE_ACCESS_VIOLATION_RE.test(exceptionValue)) return 'access-violation';
  if (NATIVE_BREAKPOINT_RE.test(exceptionValue)) return 'breakpoint';
  if (NATIVE_PRIV_INSTRUCTION_RE.test(exceptionValue)) return 'priv-instruction';
  if (NATIVE_EXC_BREAKPOINT_RE.test(exceptionValue)) return 'exc-breakpoint';
  if (NATIVE_SIGBUS_RE.test(exceptionValue)) return 'sigbus';
  if (NATIVE_SIGSEGV_RE.test(exceptionValue)) return 'sigsegv';
  if (NATIVE_SIGABRT_RE.test(exceptionValue)) return 'sigabrt';
  if (NATIVE_SIGTRAP_RE.test(exceptionValue)) return 'sigtrap';
  if (NATIVE_EXC_BAD_ACCESS_RE.test(exceptionValue)) return 'exc-bad-access';
  if (NATIVE_EXC_BAD_INSTRUCTION_RE.test(exceptionValue)) return 'exc-bad-instruction';
  if (NATIVE_CPP_EXCEPTION_RE.test(exceptionValue)) return 'cpp-exception';
  return 'unknown';
}

function isGpuProcessNativeCrash(event: ErrorEvent): boolean {
  const processTag = getNativeCrashProcess(event);
  return processTag === 'gpu' || processTag === 'GPU';
}

function isGpuProcessAbnormalExitWarning(event: ErrorEvent): boolean {
  const processTag = getTagString(event, 'event.process');
  if (processTag !== 'gpu' && processTag !== 'GPU') {
    return false;
  }

  return getTagString(event, 'event.environment') === 'javascript'
    && getTagString(event, 'event.origin') === 'electron'
    && (event.level === 'warning' || getTagString(event, 'level') === 'warning')
    && GPU_ABNORMAL_EXIT_WARNING_RE.test(getCapturedEventMessage(event));
}

function isUtilityProcessNativeCrash(event: ErrorEvent): boolean {
  const processTag = getNativeCrashProcess(event);
  return processTag === 'utility' || processTag === 'Utility';
}

// NOTE(victor): Support issues #2046/#2047 mirror Chromium's own fatal log
// from disk_data_allocator.cc:214. Keep it reportable and tag the app-visible
// Crashpad signature only; VS Code/Signal rely on Electron exit fields here:
// https://github.com/microsoft/vscode/blob/b4b5c20cbbaa6de0c0c1f5430519ee3f3080c53b/src/vs/platform/windows/electron-main/windowImpl.ts#L890-L928
// https://github.com/signalapp/Signal-Desktop/blob/a8f91c2c20bc21a4c40c0fcca67beeeeee61915b/app/global_errors.main.ts#L65-L75
function isChromiumDiskDataAllocatorCorruptionMinidump(event: ErrorEvent): boolean {
  if (event.platform !== 'native' || event.level !== 'fatal') {
    return false;
  }

  return getTagString(event, 'event.environment') === 'native'
    && getTagString(event, 'event.origin') === 'electron'
    && getTagString(event, 'event.process') === 'renderer'
    && getTagString(event, 'exit.reason') === 'crashed'
    && getTagString(event, 'mechanism') === 'minidump'
    && getContextString(event, 'electron', 'crashpad.platform') === 'win32'
    && getContextString(event, 'electron', 'crashpad.process_type') === 'renderer'
    && hasElectronContextValueMatching(event, CHROMIUM_DISK_DATA_ALLOCATOR_CORRUPTION_RE);
}

function tagChromiumDiskDataAllocatorCorruptionMinidump(event: ErrorEvent): ErrorEvent {
  const exception = getPrimaryException(event);

  event.tags = {
    ...event.tags,
    'chromium.failure': 'disk-data-allocator-corruption',
    'crash.category': 'renderer-disk-cache-corruption',
    'crash.process': 'renderer',
    'crash.signal': classifyNativeCrashSignal(exception?.value ?? ''),
  };

  return event;
}

function isMainProcessBoringSslBadDecrypt(event: ErrorEvent, message: string): boolean {
  return event.platform === 'node'
    && event.level === 'fatal'
    && getTagString(event, 'event.origin') === 'electron'
    && getTagString(event, 'event.process') === 'browser'
    && BORINGSSL_BAD_DECRYPT_RE.test(message);
}

// NOTE(victor): Issue #1971 / ELECTRON-DX is a browser-process BoringSSL fatal.
// VS Code logs process crashes for triage and Signal keeps main-process errors
// fatal, so group the variable OpenSSL prefix while preserving reportability.
// https://github.com/microsoft/vscode/blob/main/src/vs/code/electron-main/app.ts
// https://github.com/signalapp/Signal-Desktop/blob/main/app/global_errors.main.ts
function tagMainProcessBoringSslBadDecrypt(event: ErrorEvent, rawMessage: string): ErrorEvent {
  const sanitizedMessage = 'electron main process BoringSSL BAD_DECRYPT';

  if (event.exception?.values) {
    for (const value of event.exception.values) {
      if (typeof value.value === 'string' && BORINGSSL_BAD_DECRYPT_RE.test(value.value)) {
        value.value = sanitizedMessage;
      }
    }
  }

  event.message = sanitizedMessage;
  if (event.logentry?.message) {
    event.logentry.message = sanitizedMessage;
  }
  event.extra = {
    ...event.extra,
    boringSslBadDecryptRawMessage: rawMessage,
  };
  event.tags = {
    ...event.tags,
    'crash.category': 'main-process-boringssl-bad-decrypt',
    'crash.process': 'browser',
    'crash.signal': 'bad-decrypt',
  };
  event.fingerprint = ['electron-main', 'boringssl-bad-decrypt'];

  return event;
}

/*
Catch-all categorizer for native minidump events not already handled by
the specific handlers above (renderer OOM, packaged-sound, etc.).

Groups addressed:
  #1  V8 GC/heap crashes (MarkCompact, Scavenger, HeapObject, etc.)
  #2  V8 builtins crashes (CreateDataProperty, RecordWriteSaveFP, etc.)
  #3  Chromium fatal log (logging::LogMessage::HandleFatal)
  #4  Windows ntdll (RtlDispatchAPC, RtlpQueryProcessDebugInformationRemote)
  #5  Non-renderer OOM (browser/utility partition_alloc)
  #6  POSIX thread (__pthread_kill, _pthread_start)
  #7  Node network (ConnectionWrap::AfterConnect)
  #8  Node DNS (ares_dns_rr_get_ttl)
  #9  Unknown/anonymous crashes
  #10 libc crash (strlen$thunk)
  #11 libc++ crash (std::__Cr::__tree)
  #12 GPU/media driver (glStartTilingQCOM, VADisplayStateSingleton)
  #13 Linux Wayland (XdgToplevel::SurfaceMove)
  #14 Linux Electron startup frame view (ClientFrameViewLinux)

Prior art: VS Code logs renderer `render-process-gone` with reason and
exitCode, emits `windowerror` telemetry, and prompts from those fields:
https://github.com/microsoft/vscode/blob/b4b5c20cbbaa6de0c0c1f5430519ee3f3080c53b/src/vs/platform/windows/electron-main/windowImpl.ts#L812-L928
https://github.com/microsoft/vscode/blob/b4b5c20cbbaa6de0c0c1f5430519ee3f3080c53b/src/vs/platform/windows/electron-main/windowImpl.ts#L993-L1005
Signal Desktop also reports Electron's process-gone reason/exitCode directly:
https://github.com/signalapp/Signal-Desktop/blob/a8f91c2c20bc21a4c40c0fcca67beeeeee61915b/app/global_errors.main.ts#L65-L75

Since V8 GC vs V8 builtins are indistinguishable pre-symbolication (both
surface as EXCEPTION_ACCESS_VIOLATION), this helper only adds diagnostic tags.
Do not override the Sentry fingerprint here; Sentry symbolication can separate
native roots more accurately than the pre-symbolication fields available in
beforeSend.
*/
// NOTE(victor): Issues #1973/#1974 are V8 renderer minidumps. Follow VS Code
// and Signal by keeping renderer crashes fatal/reportable while tagging only
// stable process/signal facts available before symbolication.
// https://github.com/microsoft/vscode/blob/main/src/vs/platform/windows/electron-main/windowImpl.ts
// https://github.com/signalapp/Signal-Desktop/blob/main/app/global_errors.main.ts
function getNativeOomCrashCategory(processTag: string): NativeOomCrashCategory {
  if (processTag === 'renderer') return 'renderer-oom';
  if (processTag === 'browser') return 'browser-oom';
  return 'process-oom';
}

function tagUnhandledNativeMinidump(event: ErrorEvent): ErrorEvent {
  const exception = getPrimaryException(event);
  const exceptionValue = exception?.value ?? '';
  const signal = classifyNativeCrashSignal(exceptionValue);
  const processTag = getNativeCrashProcess(event);

  let category: NativeCrashCategory;
  if (signal === 'oom') {
    category = getNativeOomCrashCategory(processTag);
  } else if (isGpuProcessNativeCrash(event)) {
    category = 'gpu-process-crash';
  } else if (isUtilityProcessNativeCrash(event)) {
    category = 'utility-process-crash';
  } else {
    category = `native-${signal}`;
  }

  event.tags = {
    ...event.tags,
    'crash.category': category,
    'crash.signal': signal,
    'crash.process': processTag,
  };

  return event;
}

// NOTE(victor): `@sentry/node-core` marks Sentry-owned unhandled rejections with
// mechanism type `auto.node.onunhandledrejection` and rejection-specific context
// in `onunhandledrejection.js`. That integration calls `captureException(reason, {
// originalException: promise, ... })`, so the captured event payload is the
// stable source of the rejection message, not `hint.originalException`.
//
// Use that mechanism marker to keep repo telemetry attached to the same capture
// path instead of mirroring a second `captureException`.
export function getMainProcessBeforeSendTelemetry(
  event: ErrorEvent,
): MainProcessBeforeSendTelemetry | null {
  if (!hasMechanismType(event, UNHANDLED_REJECTION_MECHANISM)) {
    return null;
  }

  return {
    context: { source: 'main' },
    error: buildTelemetryErrorFromEvent(event),
    errorType: 'unhandled_rejection',
  };
}

export function sanitizeCodexSentryEvent(
  event: ErrorEvent,
  hint?: EventHint,
): ErrorEvent | null {
  const rawMessage = getEventMessage(event, hint);

  if (isBrowserExtensionRelayEconnreset(event, hint)) {
    return null;
  }
  if (isExternalAttentionPopupMinidump(event)) {
    return null;
  }
  if (isRendererPackagedSoundNativeCrash(event)) {
    return null;
  }
  if (isRendererPartitionAllocOomMinidump(event)) {
    return tagRendererOomEvent(event);
  }
  if (isExplicitRendererOomEvent(event)) {
    return tagRendererOomEvent(event);
  }
  if (isWindowsRendererOnboardingVideoMinidump(event)) {
    tagWindowsRendererOnboardingVideoMinidump(event);
    const details = getElectronCrashDetails(event);
    if (details?.exitCode === -1073741819) {
      return null;
    }
    return event;
  }
  if (isExternalPythonPdfKitLaunchServicesMinidump(event)) {
    return null;
  }
  if (isExternalPythonMallocAbortMinidump(event)) {
    return null;
  }
  if (isExternalHomebrewNodeDyldMinidump(event)) {
    return null;
  }
  if (isGpuProcessAbnormalExitWarning(event)) {
    return null;
  }

  if (isChromiumDiskDataAllocatorCorruptionMinidump(event)) {
    return tagChromiumDiskDataAllocatorCorruptionMinidump(event);
  }
  if (isUnhandledNativeMinidump(event)) {
    return tagUnhandledNativeMinidump(event);
  }

  if (isOoEditorsCodesignEnoentStderr(event, rawMessage)) {
    return null;
  }
  if (isBrowserProcessBoringSslBadDecrypt(event, rawMessage)) {
    return tagBrowserProcessBoringSslBadDecrypt(event, rawMessage);
  }
  if (isMainProcessBoringSslBadDecrypt(event, rawMessage)) {
    return tagMainProcessBoringSslBadDecrypt(event, rawMessage);
  }

  const signature = classifyCodexError(rawMessage);
  if (!signature) {
    return event;
  }
  const diagnostic = buildCodexDiagnosticPreview(rawMessage);
  const displayMessage = buildSanitizedDisplayMessage(signature, diagnostic);

  // NOTE(victor): Keep the raw exit payload in structured metadata so Sentry
  // retains full debugging context, but remove it from the primary grouping
  // fields (`message`, exception value, transaction). This preserves search and
  // forensics value without letting high-cardinality stdout/stderr blobs define
  // the issue title or fingerprint.
  event.extra = {
    ...event.extra,
    codex_raw_exit_message: rawMessage,
  };
  event.contexts = {
    ...event.contexts,
    codex: {
      ...(diagnostic.preview
        ? { detailPreview: diagnostic.preview }
        : {}),
      ...(diagnostic.source
        ? { detailSource: diagnostic.source }
        : {}),
      errorFamily: signature.family,
      exitCode: signature.exitCode ?? 'none',
      sanitized: true,
    },
  };

  if (event.exception?.values) {
    for (const value of event.exception.values) {
      if (typeof value.value === 'string' && isCodexEventMessage(value.value)) {
        value.value = displayMessage;
      }
    }
  }

  event.message = displayMessage;
  if (event.logentry?.message) {
    event.logentry.message = displayMessage;
  }
  if (typeof event.transaction === 'string' && isCodexEventMessage(event.transaction)) {
    event.transaction = displayMessage;
  }

  event.tags = {
    ...event.tags,
    'codex.error.family': signature.family,
    ...(diagnostic.source
      ? { 'codex.detail_source': diagnostic.source }
      : {}),
    'codex.exit_code': signature.exitCode ?? 'none',
    'codex.sanitized': 'true',
  };
  event.fingerprint = [
    'codex-app-server',
    signature.family,
    signature.exitCode ?? 'none',
  ];

  return event;
}
