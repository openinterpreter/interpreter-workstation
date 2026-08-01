import { describe, expect, test } from 'bun:test';
import { BROKEN_CONSOLE_WRITE_ERROR } from './safeConsoleWrite';
import {
  CODEX_REAUTH_ERROR,
  MAIN_PROCESS_ENOSPC_ERROR,
  MAIN_PROCESS_TRANSIENT_FETCH_ERROR,
  MAIN_PROCESS_SENTRY_IGNORE_ERRORS,
  MAIN_PROCESS_UNHANDLED_REJECTION_IGNORE_MATCHERS,
  TRANSIENT_NETWORK_ERROR,
  UPDATER_DISK_FULL_ERROR,
  isCodexReauthRequiredError,
  isMainProcessEnospcError,
  isTransientNetworkError,
  isUpdaterDiskFullError,
} from './transientNetworkErrors';

describe('TRANSIENT_NETWORK_ERROR', () => {
  test('matches net::ERR_ prefixed strings', () => {
    expect(TRANSIENT_NETWORK_ERROR.test('net::ERR_CONNECTION_CLOSED')).toBe(true);
  });

  test('does not match arbitrary error strings', () => {
    expect(TRANSIENT_NETWORK_ERROR.test('TypeError: Cannot read property')).toBe(false);
  });
});

describe('isTransientNetworkError', () => {
  const knownCodes = [
    'net::ERR_NETWORK_CHANGED',
    'net::ERR_INTERNET_DISCONNECTED',
    'net::ERR_NETWORK_IO_SUSPENDED',
    'net::ERR_NAME_NOT_RESOLVED',
    'net::ERR_TIMED_OUT',
    'net::ERR_CONNECTION_RESET',
    'net::ERR_QUIC_PROTOCOL_ERROR',
    'net::ERR_HTTP2_PING_FAILED',
    'net::ERR_CONNECTION_CLOSED',
    'net::ERR_CONNECTION_REFUSED',
    'net::ERR_SSL_PROTOCOL_ERROR',
    'net::ERR_FAILED',
  ];

  for (const code of knownCodes) {
    test(`matches ${code}`, () => {
      expect(isTransientNetworkError(code)).toBe(true);
    });
  }

  test('matches when embedded in a longer error message', () => {
    expect(isTransientNetworkError(
      'Error: net::ERR_HTTP2_PING_FAILED\n    at SimpleURLLoaderWrapper.<anonymous>'
    )).toBe(true);
  });

  test('matches Error object .message format from electron-updater', () => {
    expect(isTransientNetworkError('net::ERR_CONNECTION_CLOSED')).toBe(true);
  });

  test('rejects empty string', () => {
    expect(isTransientNetworkError('')).toBe(false);
  });

  test('rejects non-network errors', () => {
    expect(isTransientNetworkError('ENOENT: no such file or directory')).toBe(false);
  });

  test('rejects partial prefix without net::', () => {
    expect(isTransientNetworkError('ERR_CONNECTION_CLOSED')).toBe(false);
  });

  test('rejects undefined coerced to string', () => {
    expect(isTransientNetworkError(String(undefined))).toBe(false);
  });
});

describe('UPDATER_DISK_FULL_ERROR', () => {
  test('matches interpreter-updater ENOSPC copyfile errors', () => {
    expect(UPDATER_DISK_FULL_ERROR.test(
      "Error: ENOSPC: no space left on device, copyfile 'C:\\Users\\reedg\\AppData\\Local\\interpreter-updater\\pending\\current.blockmap' -> 'C:\\Users\\reedg\\AppData\\Local\\interpreter-updater\\current.blockmap'",
    )).toBe(true);
  });

  test('rejects ENOSPC messages outside updater copyfile path', () => {
    expect(UPDATER_DISK_FULL_ERROR.test(
      "Error: ENOSPC: no space left on device, write '/tmp/output.log'",
    )).toBe(false);
  });
});

describe('MAIN_PROCESS_ENOSPC_ERROR', () => {
  test('matches config write ENOSPC errors mirrored from Sentry issue 7346643650', () => {
    expect(isMainProcessEnospcError(
      "Error: ENOSPC: no space left on device, open '/Users/example/.interpreter/config.json.tmp-5465168444fabacb'",
    )).toBe(true);
    expect(isMainProcessEnospcError(
      "Error: ENOSPC: no space left on device, rename '/Users/example/Library/Application Support/interpreter/config.json.tmp-63941818126098f7' -> '/Users/example/Library/Application Support/interpreter/config.json'",
    )).toBe(true);
    expect(isMainProcessEnospcError(
      'Error: ENOSPC: no space left on device, write',
    )).toBe(true);
  });

  test('matches auth config write ENOSPC reports from issues 1771 and 1778', () => {
    const authConfigWriteStack = [
      'Error: ENOSPC: no space left on device, write',
      '    at node:fs:916:3 in writeSync',
      '    at app:///dist-electron/electron/main.cjs:50152:25 in attempt',
      '    at app:///dist-electron/electron/main.cjs:50520:49 in writeFileSync',
      '    at app:///dist-electron/electron/main.cjs:60712:13 in Conf._write',
      '    at app:///dist-electron/electron/main.cjs:60568:14 in set store',
      '    at app:///dist-electron/electron/main.cjs:103272:22 in saveConfig',
      '    at app:///dist-electron/electron/main.cjs:103903:9 in setAuthTokens',
    ].join('\n');

    expect(isMainProcessEnospcError(authConfigWriteStack)).toBe(true);
    expect(UPDATER_DISK_FULL_ERROR.test(authConfigWriteStack)).toBe(false);
  });

  test('matches oo-editors disk-full write reports from issue 1764', () => {
    expect(isMainProcessEnospcError(
      'Error: ENOSPC: no space left on device, write',
    )).toBe(true);
  });

  test('matches file watcher capacity ENOSPC errors mirrored from Sentry issue 7408296257', () => {
    expect(isMainProcessEnospcError(
      "Error: ENOSPC: System limit for number of file watchers reached, watch '/tmp/interpreter-cli-bridge-5177/requests'",
    )).toBe(true);
  });

  test('rejects non-ENOSPC filesystem errors', () => {
    expect(isMainProcessEnospcError('Error: ENOENT: no such file or directory, open config.json')).toBe(false);
    expect(isMainProcessEnospcError('Error: EACCES: permission denied, open config.json')).toBe(false);
  });
});

describe('MAIN_PROCESS_TRANSIENT_FETCH_ERROR', () => {
  test('matches undici terminated errors captured as plain terminated messages', () => {
    expect(MAIN_PROCESS_TRANSIENT_FETCH_ERROR.test('terminated')).toBe(true);
  });

  test('matches undici terminated errors captured with explicit type prefix', () => {
    expect(MAIN_PROCESS_TRANSIENT_FETCH_ERROR.test('TypeError: terminated')).toBe(true);
  });

  test('rejects broader network wrapper messages', () => {
    expect(MAIN_PROCESS_TRANSIENT_FETCH_ERROR.test('read ECONNRESET')).toBe(false);
    expect(MAIN_PROCESS_TRANSIENT_FETCH_ERROR.test('Error: read ECONNRESET')).toBe(false);
    expect(MAIN_PROCESS_TRANSIENT_FETCH_ERROR.test('fetch failed: UND_ERR_SOCKET')).toBe(false);
    expect(MAIN_PROCESS_TRANSIENT_FETCH_ERROR.test('request failed: read ECONNRESET')).toBe(false);
  });

  test('rejects unrelated type errors', () => {
    expect(MAIN_PROCESS_TRANSIENT_FETCH_ERROR.test('TypeError: Cannot read properties of undefined')).toBe(false);
  });
});

describe('isUpdaterDiskFullError', () => {
  test('matches updater no-space copy errors in multiline messages', () => {
    expect(isUpdaterDiskFullError(
      "Error: ENOSPC: no space left on device, copyfile\n'C:\\Users\\test\\AppData\\Local\\interpreter-updater\\pending\\current.blockmap' -> 'C:\\Users\\test\\AppData\\Local\\interpreter-updater\\current.blockmap'",
    )).toBe(true);
  });

  test('rejects non-updater ENOSPC messages', () => {
    expect(isUpdaterDiskFullError(
      "Error: ENOSPC: no space left on device, copyfile 'C:\\Users\\test\\Documents\\a' -> 'C:\\Users\\test\\Documents\\b'",
    )).toBe(false);
  });
});

describe('isCodexReauthRequiredError', () => {
  test('matches codex app-server exits caused by invalidated auth token', () => {
    expect(isCodexReauthRequiredError(
      'Error: codex app-server exited (null): failed to refresh available models: unexpected status 401 Unauthorized: Your authentication token has been invalidated. Please try signing in again.',
    )).toBe(true);
  });

  test('matches codex app-server exits caused by refresh token reuse', () => {
    expect(isCodexReauthRequiredError(
      'Error: codex app-server exited (null): Failed to refresh token: 401 Unauthorized: {"error":{"code":"refresh_token_reused","message":"Your refresh token has already been used to generate a new access token. Please try signing in again."}}',
    )).toBe(true);
  });

  test('matches codex app-server exits when websocket auth fails with 403 forbidden', () => {
    expect(isCodexReauthRequiredError(
      'Error: codex app-server exited (null): Failed to cancel previous login server: connection timed out\nERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 403 Forbidden, url: wss://chatgpt.com/backend-api/codex/responses',
    )).toBe(true);
  });

  test('rejects codex app-server exits that are not auth invalidation', () => {
    expect(isCodexReauthRequiredError(
      'Error: codex app-server exited (1): failed to bind stdio bridge on startup',
    )).toBe(false);
  });

  test('rejects non-codex errors even when 401 is present', () => {
    expect(isCodexReauthRequiredError(
      'HTTP error: 401 Unauthorized from local API',
    )).toBe(false);
  });
});

describe('CODEX_REAUTH_ERROR', () => {
  test('matches auth token invalidation (ignoreErrors layer)', () => {
    expect(CODEX_REAUTH_ERROR.test(
      'Error: codex app-server exited (null): failed to refresh available models: unexpected status 401 Unauthorized: Your authentication token has been invalidated. Please try signing in again.',
    )).toBe(true);
  });

  test('matches refresh token reuse (ignoreErrors layer)', () => {
    expect(CODEX_REAUTH_ERROR.test(
      'Error: codex app-server exited (null): Failed to refresh token: 401 Unauthorized: {"error":{"code":"refresh_token_reused","message":"Your refresh token has already been used to generate a new access token. Please try signing in again."}}',
    )).toBe(true);
  });

  test('matches refresh token invalidation (ignoreErrors layer)', () => {
    expect(CODEX_REAUTH_ERROR.test(
      'Error: codex app-server exited (null): Failed to refresh token: 401 Unauthorized: {"error":{"code":"refresh_token_invalidated","message":"Your refresh token has been invalidated. Please try signing in again."}}',
    )).toBe(true);
  });

  test('matches multiline websocket 403 forbidden exits (ignoreErrors layer)', () => {
    expect(CODEX_REAUTH_ERROR.test(
      'Error: codex app-server exited (null): Failed to cancel previous login server: connection timed out\nERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 403 Forbidden, url: wss://chatgpt.com/backend-api/codex/responses',
    )).toBe(true);
  });

  test('rejects non-auth codex exits', () => {
    expect(CODEX_REAUTH_ERROR.test(
      'Error: codex app-server exited (1): failed to bind stdio bridge on startup',
    )).toBe(false);
  });

  test('rejects non-codex 401 errors', () => {
    expect(CODEX_REAUTH_ERROR.test(
      'HTTP error: 401 Unauthorized from local API',
    )).toBe(false);
  });
});

describe('MAIN_PROCESS_SENTRY_IGNORE_ERRORS', () => {
  test('contains all main-process sentry ignore regex matchers', () => {
    expect(MAIN_PROCESS_SENTRY_IGNORE_ERRORS).toContain(TRANSIENT_NETWORK_ERROR);
    expect(MAIN_PROCESS_SENTRY_IGNORE_ERRORS).toContain(MAIN_PROCESS_TRANSIENT_FETCH_ERROR);
    expect(MAIN_PROCESS_SENTRY_IGNORE_ERRORS).toContain(MAIN_PROCESS_ENOSPC_ERROR);
    expect(MAIN_PROCESS_SENTRY_IGNORE_ERRORS).toContain(CODEX_REAUTH_ERROR);
    expect(MAIN_PROCESS_SENTRY_IGNORE_ERRORS).toContain(BROKEN_CONSOLE_WRITE_ERROR);
  });
});

describe('MAIN_PROCESS_UNHANDLED_REJECTION_IGNORE_MATCHERS', () => {
  test('shares the same ignore policy with the configured rejection integration', () => {
    expect(MAIN_PROCESS_UNHANDLED_REJECTION_IGNORE_MATCHERS).toEqual([
      { message: TRANSIENT_NETWORK_ERROR },
      { message: MAIN_PROCESS_TRANSIENT_FETCH_ERROR },
      { message: MAIN_PROCESS_ENOSPC_ERROR },
      { message: CODEX_REAUTH_ERROR },
      { message: BROKEN_CONSOLE_WRITE_ERROR },
    ]);
  });

  test('matches the codex auth invalidation rejection family', () => {
    const matcher = MAIN_PROCESS_UNHANDLED_REJECTION_IGNORE_MATCHERS[3];
    const messageMatcher = matcher?.message;

    expect(messageMatcher).toBeInstanceOf(RegExp);
    expect(messageMatcher instanceof RegExp && messageMatcher.test(
      'Error: codex app-server exited (null): failed to refresh available models: unexpected status 401 Unauthorized: Your authentication token has been invalidated. Please try signing in again.',
    )).toBe(true);
  });

  test('matches transient undici terminated rejections', () => {
    const matcher = MAIN_PROCESS_UNHANDLED_REJECTION_IGNORE_MATCHERS[1];
    const messageMatcher = matcher?.message;

    expect(messageMatcher).toBeInstanceOf(RegExp);
    expect(messageMatcher instanceof RegExp && messageMatcher.test('terminated')).toBe(true);
    expect(messageMatcher instanceof RegExp && messageMatcher.test('TypeError: terminated')).toBe(true);
    expect(messageMatcher instanceof RegExp && messageMatcher.test('fetch failed: UND_ERR_SOCKET')).toBe(false);
  });

  test('matches main-process ENOSPC rejections', () => {
    const matcher = MAIN_PROCESS_UNHANDLED_REJECTION_IGNORE_MATCHERS[2];
    const messageMatcher = matcher?.message;

    expect(messageMatcher).toBeInstanceOf(RegExp);
    expect(messageMatcher instanceof RegExp && messageMatcher.test('Error: ENOSPC: no space left on device, write')).toBe(true);
    expect(messageMatcher instanceof RegExp && messageMatcher.test('Error: ENOENT: no such file or directory')).toBe(false);
  });

  test('matches auth config write ENOSPC rejections from the shipped issue 1771 and 1778 fix', () => {
    const matcher = MAIN_PROCESS_UNHANDLED_REJECTION_IGNORE_MATCHERS[2];
    const messageMatcher = matcher?.message;

    expect(messageMatcher).toBeInstanceOf(RegExp);
    expect(messageMatcher instanceof RegExp && messageMatcher.test(
      'Error: ENOSPC: no space left on device, write\n    at Conf._write\n    at saveConfig\n    at setAuthTokens',
    )).toBe(true);
  });

  test('matches broken console write rejections', () => {
    const matcher = MAIN_PROCESS_UNHANDLED_REJECTION_IGNORE_MATCHERS[4];
    const messageMatcher = matcher?.message;

    expect(messageMatcher).toBeInstanceOf(RegExp);
    expect(messageMatcher instanceof RegExp && messageMatcher.test('Error: write EIO')).toBe(true);
    expect(messageMatcher instanceof RegExp && messageMatcher.test('Error: write EPIPE')).toBe(true);
    expect(messageMatcher instanceof RegExp && messageMatcher.test('Error: Cannot call write after a stream was destroyed')).toBe(true);
    expect(messageMatcher instanceof RegExp && messageMatcher.test('Error: EIO reading config')).toBe(false);
  });

  test('matches support issues 1953-1956 main-process Object.log EPIPE events', () => {
    const matcher = MAIN_PROCESS_UNHANDLED_REJECTION_IGNORE_MATCHERS[4];
    const messageMatcher = matcher?.message;

    expect(messageMatcher).toBeInstanceOf(RegExp);
    expect(messageMatcher instanceof RegExp && messageMatcher.test(
      'Error: write EPIPE\n    at Object.log (app:///dist-electron/electron/main.cjs)',
    )).toBe(true);
  });
});
