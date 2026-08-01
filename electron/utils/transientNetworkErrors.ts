import { ENOSPC_ERROR_PATTERN, isDiskSpaceFullErrorMessage } from '../../shared/diskSpace';
import { BROKEN_CONSOLE_WRITE_ERROR } from './safeConsoleWrite';

// NOTE(victor): Chromium net::ERR_* codes from OS-level interface changes
// (Wi-Fi reconnect, sleep/wake, VPN toggle, HTTP/2 keepalive timeout).
// Not actionable -- the 30-minute auto-updater interval retries naturally.
// Chromium has dozens of codes (net_error_list.h); match the prefix instead of enumerating.
export const TRANSIENT_NETWORK_ERROR = /net::ERR_/;

// NOTE(victor): Node/undici can surface an aborted fetch in Electron main as a
// bare `terminated` unhandled rejection (sometimes with a `TypeError:` prefix).
// Sentry often records that as two linked exceptions: the outer unhandled
// `terminated` rejection plus a handled inner transport error like
// `read ECONNRESET`.
//
// Evidence:
// - https://github.com/openinterpreter/iworkstation-issues/issues/647
//   (`ELECTRON-3D`, event `0e17eced20aa4dba998816b118435a0d`)
// - https://github.com/nodejs/node/blob/v22.16.0/deps/undici/src/lib/web/fetch/index.js#L2028-L2048
//   (`onAborted()` emits `new TypeError('terminated', { cause: reason })`)
//
// Ignore only the exact outer rejection shape here. Do not widen this to
// `fetch failed`, `ECONNRESET`, or generic `UND_ERR_*` text, or we will hide
// broader main-process fetch failures that may still be actionable.
export const MAIN_PROCESS_TRANSIENT_FETCH_ERROR =
  /^(?:TypeError:\s*)?terminated$/i;

export function isTransientNetworkError(message: string): boolean {
  return TRANSIENT_NETWORK_ERROR.test(message);
}

// NOTE(victor): ENOSPC is a host capacity limit, not an app defect. We are
// intentionally keeping local sidecars and caches for UX/performance, so ignore
// this Sentry family for now and revisit if we add product-level disk budgeting.
export const MAIN_PROCESS_ENOSPC_ERROR = ENOSPC_ERROR_PATTERN;

export function isMainProcessEnospcError(message: string): boolean {
  return isDiskSpaceFullErrorMessage(message);
}

// NOTE(victor): Updater copy failures due to full disk are user-environmental.
// We still surface them in updater UI flows, but they should not trigger Sentry noise.
export const UPDATER_DISK_FULL_ERROR =
  /ENOSPC:\s*no space left on device,\s*copyfile[\s\S]*interpreter-updater/i;

export function isUpdaterDiskFullError(message: string): boolean {
  return UPDATER_DISK_FULL_ERROR.test(message);
}

// NOTE(victor): Sentry issue #616 -- CDN HTTP errors (400, 403, 404, 5xx) during
// auto-update download. Not actionable from app code; the 30-min retry interval
// handles transient CDN failures.
export const UPDATER_HTTP_STATUS_ERROR =
  /Cannot download\b.*\bstatus \d{3}/i;

export function isUpdaterHttpStatusError(message: string): boolean {
  return UPDATER_HTTP_STATUS_ERROR.test(message);
}

export const CODEX_REAUTH_ERROR =
  /codex app-server exited[\s\S]*(?:401 [Uu]nauthorized|token has been invalidated|refresh.token.*(?:invalidated|reused|already been used)|please try signing in again|403 [Ff]orbidden[\s\S]*backend-api\/codex\/responses)/;

const CODEX_APP_SERVER_EXITED = 'codex app-server exited';
const CODEX_AUTH_REAUTH_MARKERS = [
  '401 unauthorized',
  'authentication token has been invalidated',
  'refresh token has been invalidated',
  'refresh token has already been used',
  'refresh_token_invalidated',
  'refresh_token_reused',
  'please try signing in again',
  '403 forbidden, url: wss://chatgpt.com/backend-api/codex/responses',
];

export function isCodexReauthRequiredError(message: string): boolean {
  const normalized = message.toLowerCase();
  if (!normalized.includes(CODEX_APP_SERVER_EXITED)) {
    return false;
  }

  return CODEX_AUTH_REAUTH_MARKERS.some((marker) => normalized.includes(marker));
}

export type MainProcessUnhandledRejectionIgnoreMatcher = {
  message?: RegExp | string;
  name?: RegExp | string;
};

const MAIN_PROCESS_IGNORED_ERROR_PATTERNS = [
  TRANSIENT_NETWORK_ERROR,
  MAIN_PROCESS_TRANSIENT_FETCH_ERROR,
  MAIN_PROCESS_ENOSPC_ERROR,
  CODEX_REAUTH_ERROR,
  BROKEN_CONSOLE_WRITE_ERROR,
] as const;

export const MAIN_PROCESS_SENTRY_IGNORE_ERRORS = [...MAIN_PROCESS_IGNORED_ERROR_PATTERNS];

// NOTE(victor): `ignoreErrors` is applied by Sentry's event filter integration
// before `beforeSend`, but `OnUnhandledRejection` has its own earlier `ignore`
// path in `@sentry/node-core`'s `onunhandledrejection.js`.
//
// Keep one repo-owned matcher list and feed both layers from it so rejection
// capture and post-capture event filtering do not drift apart.
export const MAIN_PROCESS_UNHANDLED_REJECTION_IGNORE_MATCHERS = MAIN_PROCESS_IGNORED_ERROR_PATTERNS.map(
  (pattern) => ({ message: pattern } satisfies MainProcessUnhandledRejectionIgnoreMatcher)
);
