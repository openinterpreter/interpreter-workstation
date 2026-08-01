import { describe, expect, test } from 'bun:test';
import {
  CHILD_PROCESS_GONE_SUPPRESSION_MS,
  OO_EDITORS_WINDOWS_FORCED_TERMINATION_EXIT_CODE,
  classifyOoEditorsExit,
  classifyOoEditorsStderr,
  createOoEditorsExitSuppressionWindow,
  shouldTrackOoEditorsMainRendererGone,
} from './office-extension-exit';

function shouldCapture(input: Parameters<typeof classifyOoEditorsExit>[0]): boolean {
  return classifyOoEditorsExit(input).shouldCapture;
}

describe('classifyOoEditorsExit', () => {
  test('captures non-zero exits while app is still running', () => {
    expect(shouldCapture({
      code: 1,
      isShuttingDown: false,
      isAppQuitting: false,
    })).toBe(true);
  });

  test('does not capture successful office sessions that later exit with code 1 and no stderr', () => {
    expect(classifyOoEditorsExit({
      code: 1,
      isShuttingDown: false,
      isAppQuitting: false,
      stdout: [
        '[oo-editors:STARTUP] server running at http://localhost:38123/ version=1.0.37',
        '[oo-editors:OPEN] opening report.xlsx with offline loader',
        '[oo-editors:CONVERT] x2t exited with code 0',
        '[oo-editors:CONVERT] sending 10382 bytes',
      ].join('\n'),
      stderr: '',
    })).toEqual({
      shouldCapture: false,
      reason: 'benign-successful-office-session-exit',
    });
  });

  test('captures code 1 exits when the successful office session evidence is missing', () => {
    expect(classifyOoEditorsExit({
      code: 1,
      isShuttingDown: false,
      isAppQuitting: false,
      stdout: '[oo-editors:STARTUP] server running at http://localhost:38123/ version=1.0.37',
      stderr: '',
    })).toEqual({
      shouldCapture: true,
      reason: 'unexpected-non-zero-exit',
    });
  });

  test('captures code 1 exits when the successful response evidence is missing', () => {
    expect(classifyOoEditorsExit({
      code: 1,
      isShuttingDown: false,
      isAppQuitting: false,
      stdout: [
        '[oo-editors:STARTUP] server running at http://localhost:38123/ version=1.0.37',
        '[oo-editors:CONVERT] x2t exited with code 0',
      ].join('\n'),
      stderr: '',
    })).toEqual({
      shouldCapture: true,
      reason: 'unexpected-non-zero-exit',
    });
  });

  test('captures healthcheck-only startup exits from issue 1770 without a cascade signal', () => {
    expect(classifyOoEditorsExit({
      code: 1,
      isShuttingDown: false,
      isAppQuitting: false,
      stdout: [
        '[oo-editors:SENTRY] initialized',
        '[oo-editors:STARTUP] version=1.0.37',
        '[oo-editors:STARTUP] FONT_DATA_DIR=C:\\Users\\Example\\AppData\\Roaming\\interpreter\\office-extension-fontdata',
        '[oo-editors:STARTUP] THEME_DIR=C:\\Users\\Example\\AppData\\Roaming\\interpreter\\oo-editors\\editors\\sdkjs\\slide\\themes',
        '[oo-editors:STARTUP] x2t=C:\\Users\\Example\\AppData\\Roaming\\interpreter\\oo-editors\\converter\\x2t.exe',
        '[oo-editors:STARTUP] server running at http://localhost:38123/ version=1.0.37',
        '[oo-editors:STARTUP] desktop stub injection enabled for all HTML files',
        '[oo-editors:STARTUP] static test directory at http://localhost:38123/static-test/',
        '[oo-editors:HTTP] 2026-04-29T07:54:40.113Z GET /healthcheck',
      ].join('\n'),
      stderr: '',
    })).toEqual({
      shouldCapture: true,
      reason: 'unexpected-non-zero-exit',
    });
  });

  test('captures code 1 exits when oo-editors wrote stderr', () => {
    expect(classifyOoEditorsExit({
      code: 1,
      isShuttingDown: false,
      isAppQuitting: false,
      stdout: [
        '[oo-editors:STARTUP] server running at http://localhost:38123/ version=1.0.37',
        '[oo-editors:CONVERT] x2t exited with code 0',
        '[oo-editors:CONVERT] sending 10382 bytes',
      ].join('\n'),
      stderr: '[oo-editors:PROCESS] uncaught exception: Error: write EPIPE',
    })).toEqual({
      shouldCapture: true,
      reason: 'unexpected-non-zero-exit',
    });
  });

  test('does not capture clean exits', () => {
    expect(shouldCapture({
      code: 0,
      isShuttingDown: false,
      isAppQuitting: false,
    })).toBe(false);
  });

  test('does not capture exits without exit code', () => {
    expect(shouldCapture({
      code: null,
      isShuttingDown: false,
      isAppQuitting: false,
    })).toBe(false);
  });

  test('does not capture non-zero exits during oo-editors shutdown', () => {
    expect(shouldCapture({
      code: 1,
      isShuttingDown: true,
      isAppQuitting: false,
    })).toBe(false);
  });

  test('does not capture forced-termination Windows exit code during oo-editors shutdown', () => {
    expect(classifyOoEditorsExit({
      code: OO_EDITORS_WINDOWS_FORCED_TERMINATION_EXIT_CODE,
      isShuttingDown: true,
      isAppQuitting: false,
    })).toEqual({
      shouldCapture: false,
      reason: 'shutdown-in-progress',
    });
  });

  test('does not capture non-zero exits while app is quitting', () => {
    expect(shouldCapture({
      code: 1,
      isShuttingDown: false,
      isAppQuitting: true,
    })).toBe(false);
  });

  test('does not capture forced-termination Windows exit code while app is quitting', () => {
    expect(classifyOoEditorsExit({
      code: OO_EDITORS_WINDOWS_FORCED_TERMINATION_EXIT_CODE,
      isShuttingDown: false,
      isAppQuitting: true,
    })).toEqual({
      shouldCapture: false,
      reason: 'app-quitting',
    });
  });

  test('does not capture non-zero exits during suppression window', () => {
    expect(shouldCapture({
      code: 1,
      isShuttingDown: false,
      isAppQuitting: false,
      nowMs: 1_000,
      suppressionWindow: createOoEditorsExitSuppressionWindow({
        reason: 'main-renderer-gone-cascade',
        nowMs: 0,
        durationMs: 2_000,
      }),
    })).toBe(false);
  });

  test('captures non-zero exits after suppression window', () => {
    expect(shouldCapture({
      code: 1,
      isShuttingDown: false,
      isAppQuitting: false,
      nowMs: 3_000,
      suppressionWindow: createOoEditorsExitSuppressionWindow({
        reason: 'main-renderer-gone-cascade',
        nowMs: 0,
        durationMs: 2_000,
      }),
    })).toBe(true);
  });

  test('does not capture forced-termination Windows exit code outside suppression windows', () => {
    expect(classifyOoEditorsExit({
      code: OO_EDITORS_WINDOWS_FORCED_TERMINATION_EXIT_CODE,
      isShuttingDown: false,
      isAppQuitting: false,
      nowMs: 10_000,
    })).toEqual({
      shouldCapture: false,
      reason: 'suppressed-windows-forced-termination-code',
    });
  });

  test('suppresses forced-termination Windows exits during main-renderer cascade windows', () => {
    expect(classifyOoEditorsExit({
      code: OO_EDITORS_WINDOWS_FORCED_TERMINATION_EXIT_CODE,
      isShuttingDown: false,
      isAppQuitting: false,
      nowMs: 3_000,
      suppressionWindow: createOoEditorsExitSuppressionWindow({
        reason: 'main-renderer-gone-cascade',
        nowMs: 1_000,
        durationMs: 5_000,
      }),
    })).toEqual({
      shouldCapture: false,
      reason: 'suppressed-windows-forced-termination-code',
    });
  });

  test('returns suppression-window decision reason', () => {
    expect(classifyOoEditorsExit({
      code: 1,
      isShuttingDown: false,
      isAppQuitting: false,
      nowMs: 500,
      suppressionWindow: createOoEditorsExitSuppressionWindow({
        reason: 'main-renderer-gone-cascade',
        nowMs: 0,
        durationMs: 1_000,
      }),
    })).toEqual({
      shouldCapture: false,
      reason: 'suppressed-after-main-renderer-gone-cascade',
    });
  });

  test('returns second-instance suppression-window decision reason', () => {
    expect(classifyOoEditorsExit({
      code: 1,
      isShuttingDown: false,
      isAppQuitting: false,
      nowMs: 500,
      suppressionWindow: createOoEditorsExitSuppressionWindow({
        reason: 'second-instance-handoff',
        nowMs: 0,
        durationMs: 1_000,
      }),
    })).toEqual({
      shouldCapture: false,
      reason: 'suppressed-after-second-instance-handoff',
    });
  });

  test('suppresses forced-termination Windows exits after app child-process-gone', () => {
    expect(classifyOoEditorsExit({
      code: OO_EDITORS_WINDOWS_FORCED_TERMINATION_EXIT_CODE,
      isShuttingDown: false,
      isAppQuitting: false,
      childProcessGoneSignal: { timestampMs: 1_000 },
      nowMs: 2_000,
    })).toEqual({
      shouldCapture: false,
      reason: 'suppressed-windows-forced-termination-code',
    });
  });

  test('suppresses non-forced exits within TTL of app child-process-gone', () => {
    expect(classifyOoEditorsExit({
      code: 1,
      isShuttingDown: false,
      isAppQuitting: false,
      childProcessGoneSignal: { timestampMs: 1_000 },
      nowMs: 2_000,
    })).toEqual({
      shouldCapture: false,
      reason: 'suppressed-after-app-child-process-gone',
    });
  });

  test('captures non-zero exits after child-process-gone TTL expires', () => {
    const signalMs = 1_000;
    expect(classifyOoEditorsExit({
      code: 1,
      isShuttingDown: false,
      isAppQuitting: false,
      childProcessGoneSignal: { timestampMs: signalMs },
      nowMs: signalMs + CHILD_PROCESS_GONE_SUPPRESSION_MS + 1,
    })).toEqual({
      shouldCapture: true,
      reason: 'unexpected-non-zero-exit',
    });
  });

  test('captures second-instance exits after suppression window expires', () => {
    expect(classifyOoEditorsExit({
      code: 1,
      isShuttingDown: false,
      isAppQuitting: false,
      nowMs: 2_500,
      suppressionWindow: createOoEditorsExitSuppressionWindow({
        reason: 'second-instance-handoff',
        nowMs: 0,
        durationMs: 1_000,
      }),
    })).toEqual({
      shouldCapture: true,
      reason: 'unexpected-non-zero-exit',
    });
  });

  test('returns app-quitting decision reason', () => {
    expect(classifyOoEditorsExit({
      code: 1,
      isShuttingDown: false,
      isAppQuitting: true,
    })).toEqual({
      shouldCapture: false,
      reason: 'app-quitting',
    });
  });

  test('returns unexpected-non-zero-exit when capture is required', () => {
    expect(classifyOoEditorsExit({
      code: 2,
      isShuttingDown: false,
      isAppQuitting: false,
      nowMs: 2_000,
    })).toEqual({
      shouldCapture: true,
      reason: 'unexpected-non-zero-exit',
    });
  });
});

describe('shouldTrackOoEditorsMainRendererGone', () => {
  test('tracks non-clean exits for trusted app renderer URLs', () => {
    expect(shouldTrackOoEditorsMainRendererGone({
      reason: 'crashed',
      rendererUrl: 'file:///Applications/Interpreter/dist/index.html',
    })).toBe(true);
  });

  test('ignores clean exits and non-app renderer URLs', () => {
    expect(shouldTrackOoEditorsMainRendererGone({
      reason: 'clean-exit',
      rendererUrl: 'file:///Applications/Interpreter/dist/index.html',
    })).toBe(false);

    expect(shouldTrackOoEditorsMainRendererGone({
      reason: 'crashed',
      rendererUrl: 'https://example.com/app',
    })).toBe(false);
  });
});

describe('classifyOoEditorsStderr', () => {
  test('captures unknown stderr error logs', () => {
    expect(classifyOoEditorsStderr('Fatal: converter crashed')).toEqual({
      action: 'capture',
      reason: 'unexpected-stderr-error',
    });
  });

  test('captures missing AllFonts.js ENOENT errors', () => {
    const message = "[API] Error overriding /sdkjs/common/AllFonts.js: [Error: ENOENT: no such file or directory]";
    expect(classifyOoEditorsStderr(message)).toEqual({
      action: 'capture',
      reason: 'unexpected-stderr-error',
    });
  });

  test('suppresses bare NotFoundError lines', () => {
    expect(classifyOoEditorsStderr('NotFoundError: Not Found')).toEqual({
      action: 'breadcrumb',
      reason: 'handled-request-not-found',
    });
  });

  test('suppresses the multiline sendFile NotFoundError stack from issue 881', () => {
    const message = `NotFoundError: Not Found
    at U0 (/Users/example/Library/Application Support/interpreter/oo-editors/server.js:40:76)
    at A.error (/Users/example/Library/Application Support/interpreter/oo-editors/server.js:30:57101)
    at A.pipe (/Users/example/Library/Application Support/interpreter/oo-editors/server.js:30:60292)
    at ud (/Users/example/Library/Application Support/interpreter/oo-editors/server.js:41:27788)
    at I.sendFile (/Users/example/Library/Application Support/interpreter/oo-editors/server.js:41:23018)`;
    expect(classifyOoEditorsStderr(message)).toEqual({
      action: 'breadcrumb',
      reason: 'handled-request-not-found',
    });
  });

  test('suppresses Chromium codesign_util.cc stderr noise', () => {
    const message = '[0503/184139.119408:ERROR:electron/shell/common/mac/codesign_util.cc:131] SecCodeCopyGuestWithAttributes: Error Domain=NSOSStatusErrorDomain Code=100002 "ENOENT: No such file or directory" (100002)';
    expect(classifyOoEditorsStderr(message)).toEqual({
      action: 'breadcrumb',
      reason: 'chromium-internal-log',
    });
  });

  test('suppresses other Chromium internal log patterns', () => {
    const message = '[0101/000000.000000:ERROR:gpu_process_host.cc:968] GPU process exited unexpectedly';
    expect(classifyOoEditorsStderr(message)).toEqual({
      action: 'breadcrumb',
      reason: 'chromium-internal-log',
    });
  });

  test('suppresses Chromium FATAL log patterns', () => {
    const message = '[0503/120000.000000:FATAL:some_module.cc:42] Check failed: something';
    expect(classifyOoEditorsStderr(message)).toEqual({
      action: 'breadcrumb',
      reason: 'chromium-internal-log',
    });
  });

  test('ignores non-error logs', () => {
    expect(classifyOoEditorsStderr('Server running at http://localhost:38123/')).toEqual({
      action: 'ignore',
      reason: 'non-error-log',
    });
  });
});
