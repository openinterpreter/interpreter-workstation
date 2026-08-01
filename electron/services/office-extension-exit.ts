import type { RenderProcessGoneDetails } from 'electron';
import { isTrustedAppRendererUrl } from '../ipc/trustedRenderer';

export interface ChildProcessGoneSignal {
  readonly timestampMs: number;
}

export const CHILD_PROCESS_GONE_SUPPRESSION_MS = 30_000;

interface OoEditorsExitCaptureInput {
  code: number | null;
  isShuttingDown: boolean;
  isAppQuitting: boolean;
  childProcessGoneSignal?: ChildProcessGoneSignal | null;
  nowMs?: number;
  suppressionWindow?: OoEditorsExitSuppressionWindow | null;
  stdout?: string;
  stderr?: string;
}

type OoEditorsExitDecisionReason =
  | 'clean-exit'
  | 'shutdown-in-progress'
  | 'app-quitting'
  | 'suppressed-windows-forced-termination-code'
  | 'suppressed-after-main-renderer-gone-cascade'
  | 'suppressed-after-app-child-process-gone'
  | 'suppressed-after-second-instance-handoff'
  | 'benign-successful-office-session-exit'
  | 'unexpected-non-zero-exit';

export interface OoEditorsExitDecision {
  shouldCapture: boolean;
  reason: OoEditorsExitDecisionReason;
}

export type OoEditorsStderrDecision =
  | {
    action: 'ignore';
    reason: 'non-error-log';
  }
  | {
    action: 'breadcrumb';
    reason: 'handled-request-not-found' | 'chromium-internal-log';
  }
  | {
    action: 'capture';
    reason: 'unexpected-stderr-error';
  };

// NOTE(victor): Chromium logs internal diagnostics to stderr in the format
// [MMDD/HHMMSS.UUUUUU:LEVEL:source_file.cc:line]. These are engine noise,
// not oo-editors application errors.
const CHROMIUM_INTERNAL_LOG = /^\[\d{4}\/\d{6}\.\d+:(?:ERROR|FATAL|WARNING):\S+\.cc:\d+\]/;

function isChromiumInternalLog(message: string): boolean {
  return CHROMIUM_INTERNAL_LOG.test(message);
}

function isBenignOoEditorsNotFoundStderr(lower: string): boolean {
  if (lower.trim() === 'notfounderror: not found') {
    return true;
  }

  if (lower.includes('notfounderror: not found') && lower.includes('sendfile')) {
    return true;
  }

  return false;
}

// Issue 881 showed that raw oo-editors stderr is not a reliable proxy for process
// failure: the server installed successfully, started successfully, passed
// healthcheck, stayed alive for about 20 minutes, then logged a handled
// sendFile-related NotFoundError stack to stderr. Keep that request noise out of
// Sentry without muting real stderr failures.
export function classifyOoEditorsStderr(message: string): OoEditorsStderrDecision {
  const lower = message.toLowerCase();
  const isErrorLog = lower.includes('error') || lower.includes('fatal');
  if (!isErrorLog) {
    return {
      action: 'ignore',
      reason: 'non-error-log',
    };
  }

  if (isBenignOoEditorsNotFoundStderr(lower)) {
    return {
      action: 'breadcrumb',
      reason: 'handled-request-not-found',
    };
  }

  if (isChromiumInternalLog(message)) {
    return {
      action: 'breadcrumb',
      reason: 'chromium-internal-log',
    };
  }

  return {
    action: 'capture',
    reason: 'unexpected-stderr-error',
  };
}

// NOTE(victor): Windows MS-ERREF maps 0x40010004 to DBG_TERMINATE_PROCESS; source: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-erref/596a1078-e883-4972-9bbc-49e60bebca55. Ignore this oo-editors exit code for now because recent incidents have looked like shutdown/teardown noise rather than real failures.
export const OO_EDITORS_WINDOWS_FORCED_TERMINATION_EXIT_CODE = 1073807364;

export interface OoEditorsExitSuppressionWindow {
  reason: 'main-renderer-gone-cascade' | 'second-instance-handoff';
  untilMs: number;
}

interface CreateOoEditorsExitSuppressionWindowInput {
  reason: OoEditorsExitSuppressionWindow['reason'];
  nowMs: number;
  durationMs: number;
}

interface ShouldTrackOoEditorsMainRendererGoneInput {
  reason: RenderProcessGoneDetails['reason'];
  rendererUrl: string;
}

export function createOoEditorsExitSuppressionWindow({
  reason,
  nowMs,
  durationMs,
}: CreateOoEditorsExitSuppressionWindowInput): OoEditorsExitSuppressionWindow {
  return {
    reason,
    untilMs: nowMs + durationMs,
  };
}

export function shouldTrackOoEditorsMainRendererGone({
  reason,
  rendererUrl,
}: ShouldTrackOoEditorsMainRendererGoneInput): boolean {
  if (reason === 'clean-exit') {
    return false;
  }

  return isTrustedAppRendererUrl(rendererUrl);
}

function isBenignSuccessfulOfficeSessionExit({
  code,
  stdout,
  stderr,
}: Pick<OoEditorsExitCaptureInput, 'code' | 'stdout' | 'stderr'>): boolean {
  // oo-editors routes logError() through console.error on stderr, so any stderr
  // output remains capture-worthy.
  // Source: https://github.com/openinterpreter/oo-editors/blob/460b9137b0876e5df9e5703d726ab9d58b6f3e26/server.js#L54-L68
  if (code !== 1 || stderr?.trim()) {
    return false;
  }

  const output = stdout ?? '';
  const serverStarted = output.includes('[oo-editors:STARTUP] server running');
  const conversionSucceeded = output.includes('[oo-editors:CONVERT] x2t exited with code 0');
  const responseSent = output.includes('[oo-editors:CONVERT] sending ');

  return serverStarted && conversionSucceeded && responseSent;
}

function getSuppressionDecisionReason(
  suppressionWindow: OoEditorsExitSuppressionWindow,
): Extract<
  OoEditorsExitDecisionReason,
  'suppressed-after-main-renderer-gone-cascade' | 'suppressed-after-second-instance-handoff'
> {
  switch (suppressionWindow.reason) {
    case 'main-renderer-gone-cascade':
      return 'suppressed-after-main-renderer-gone-cascade';
    case 'second-instance-handoff':
      return 'suppressed-after-second-instance-handoff';
  }
}

export function classifyOoEditorsExit({
  code,
  isShuttingDown,
  isAppQuitting,
  childProcessGoneSignal,
  nowMs,
  suppressionWindow,
  stdout,
  stderr,
}: OoEditorsExitCaptureInput): OoEditorsExitDecision {
  if (code === null || code === 0) {
    return {
      shouldCapture: false,
      reason: 'clean-exit',
    };
  }

  if (isShuttingDown) {
    return {
      shouldCapture: false,
      reason: 'shutdown-in-progress',
    };
  }

  if (isAppQuitting) {
    return {
      shouldCapture: false,
      reason: 'app-quitting',
    };
  }

  if (code === OO_EDITORS_WINDOWS_FORCED_TERMINATION_EXIT_CODE) {
    return {
      shouldCapture: false,
      reason: 'suppressed-windows-forced-termination-code',
    };
  }

  if (
    childProcessGoneSignal
    && typeof nowMs === 'number'
    && nowMs <= childProcessGoneSignal.timestampMs + CHILD_PROCESS_GONE_SUPPRESSION_MS
  ) {
    return {
      shouldCapture: false,
      reason: 'suppressed-after-app-child-process-gone',
    };
  }

  if (
    typeof nowMs === 'number'
    && suppressionWindow
    && nowMs <= suppressionWindow.untilMs
  ) {
    return {
      shouldCapture: false,
      reason: getSuppressionDecisionReason(suppressionWindow),
    };
  }

  if (isBenignSuccessfulOfficeSessionExit({ code, stdout, stderr })) {
    return {
      shouldCapture: false,
      reason: 'benign-successful-office-session-exit',
    };
  }

  return {
    shouldCapture: true,
    reason: 'unexpected-non-zero-exit',
  };
}
