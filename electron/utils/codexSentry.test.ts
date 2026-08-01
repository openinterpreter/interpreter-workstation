import { describe, expect, test } from 'bun:test';
import type { ErrorEvent, EventHint } from '@sentry/node';

import {
  buildMainProcessFatalErrorHandler,
  configureMainProcessSentryIntegrations,
  getMainProcessBeforeSendTelemetry,
  sanitizeCodexSentryEvent,
} from './codexSentry';

describe('configureMainProcessSentryIntegrations', () => {
  test('replaces crash-stack and rejection integrations and removes auto native minidumps', () => {
    const integrations = [
      { name: 'SentryMinidump' },
      { name: 'ElectronBreadcrumbs' },
      { name: 'RendererEventLoopBlock' },
      { name: 'OnUnhandledRejection' },
      { name: 'GpuContext' },
    ];
    const rejectionReplacement = { name: 'OnUnhandledRejection' };
    const rendererReplacement = { name: 'RendererEventLoopBlock' };
    let receivedRejectionOptions:
      | {
        ignore: readonly { message?: RegExp | string; name?: RegExp | string }[];
        mode: 'none' | 'strict' | 'warn';
      }
      | undefined;
    let receivedRendererOptions:
      | {
        captureNativeStacktrace: boolean;
      }
      | undefined;

    expect(
      configureMainProcessSentryIntegrations(
        integrations,
        (options) => {
          receivedRejectionOptions = options;
          return rejectionReplacement;
        },
        [{ message: /codex app-server exited/i }],
        (options) => {
          receivedRendererOptions = options;
          return rendererReplacement;
        },
      ),
    ).toEqual([
      { name: 'ElectronBreadcrumbs' },
      rendererReplacement,
      rejectionReplacement,
    ]);
    expect(receivedRejectionOptions).toEqual({
      ignore: [{ message: /codex app-server exited/i }],
      mode: 'none',
    });
    expect(receivedRendererOptions).toEqual({
      captureNativeStacktrace: true,
    });
  });

  test('appends replacement integrations when the defaults are absent', () => {
    const rejectionReplacement = { name: 'OnUnhandledRejection' };
    const rendererReplacement = { name: 'RendererEventLoopBlock' };

    expect(
      configureMainProcessSentryIntegrations(
        [{ name: 'ElectronBreadcrumbs' }],
        () => rejectionReplacement,
        [],
        () => rendererReplacement,
      ),
    ).toEqual([
      { name: 'ElectronBreadcrumbs' },
      rendererReplacement,
      rejectionReplacement,
    ]);
  });
});

describe('buildMainProcessFatalErrorHandler', () => {
  test('logs and exits after a fatal uncaught exception', () => {
    const loggedArgs: unknown[][] = [];
    const exitCodes: number[] = [];
    const error = new Error('fatal main-process error');

    const handler = buildMainProcessFatalErrorHandler({
      exitProcess: (code) => {
        exitCodes.push(code);
      },
      logBootstrapError: (...args) => {
        loggedArgs.push(args);
      },
    });

    handler(error);

    expect(loggedArgs).toEqual([
      ['[Main] Uncaught exception:', error],
    ]);
    expect(exitCodes).toEqual([1]);
  });
});

describe('getMainProcessBeforeSendTelemetry', () => {
  test('reconstructs an Error for Sentry-owned unhandled rejection events with stack frames', () => {
    const event: ErrorEvent = {
      type: undefined,
      extra: {
        codex_raw_exit_message: 'raw codex exit payload',
      },
      exception: {
        values: [{
          mechanism: {
            type: 'auto.node.onunhandledrejection',
          },
          stacktrace: {
            frames: [{
              colno: 4,
              filename: '/tmp/app.ts',
              function: 'runTask',
              lineno: 12,
            }],
          },
          type: 'Error',
          value: 'rejected',
        }],
      },
    };

    const telemetry = getMainProcessBeforeSendTelemetry(event);

    expect(telemetry?.context).toEqual({ source: 'main' });
    expect(telemetry?.errorType).toBe('unhandled_rejection');
    expect(telemetry?.error).toBeInstanceOf(Error);
    if (!(telemetry?.error instanceof Error)) {
      throw new Error('expected telemetry error to be an Error instance');
    }
    expect(telemetry.error.message).toBe('raw codex exit payload');
    expect(telemetry.error.stack).toContain('runTask (/tmp/app.ts:12:4)');
  });

  test('falls back to a string when the rejection event has no captured stack', () => {
    const event: ErrorEvent = {
      type: undefined,
      exception: {
        values: [{
          mechanism: {
            type: 'auto.node.onunhandledrejection',
          },
          type: 'Error',
          value: 'rejected',
        }],
      },
    };

    expect(getMainProcessBeforeSendTelemetry(event)).toEqual({
      context: { source: 'main' },
      error: 'rejected',
      errorType: 'unhandled_rejection',
    });
  });

  test('returns null for non-rejection events', () => {
    const event: ErrorEvent = {
      type: undefined,
      exception: {
        values: [{
          mechanism: {
            type: 'generic',
          },
          type: 'Error',
          value: 'boom',
        }],
      },
    };

    expect(getMainProcessBeforeSendTelemetry(event)).toBeNull();
  });
});

describe('sanitizeCodexSentryEvent', () => {
  const badDecryptMessage =
    '148692032:error:1e000065:Cipher functions:OPENSSL_internal:BAD_DECRYPT:..\\..\\third_party\\boringssl\\src\\crypto\\fipsmodule\\cipher\\e_aes.cc.inc:839:\n';
  const badDecryptDisplayMessage = 'electron browser process boringssl bad decrypt';

  function nativeMinidumpEvent(options: {
    electronContext?: Record<string, unknown>;
    exceptionValue?: string;
    frameworkProcess?: string;
    process: string;
    reason?: string;
  }): ErrorEvent {
    return {
      type: undefined,
      level: 'fatal',
      platform: 'native',
      ...(options.electronContext
        ? { contexts: { electron: options.electronContext } }
        : {}),
      ...(options.exceptionValue
        ? {
            exception: {
              values: [{
                type: options.exceptionValue,
                value: options.exceptionValue,
              }],
            },
          }
        : {}),
      tags: {
        'event.environment': 'native',
        'event.origin': 'electron',
        'event.process': options.process,
        ...(options.reason ? { 'exit.reason': options.reason } : {}),
        mechanism: 'minidump',
      },
      ...(options.frameworkProcess
        ? {
            contexts: {
              'Electron Framework': {
                process_type: options.frameworkProcess,
              },
            },
          }
        : {}),
    };
  }

  function unknownProcessDyldMinidumpEvent(annotation: string): ErrorEvent {
    const event = nativeMinidumpEvent({ process: 'unknown' });
    event.contexts = {
      dyld: {
        annotations: [annotation],
        type: 'default',
      },
    };

    return event;
  }

  function windowsOnboardingVideoMinidumpEvent(options: {
    exceptionValue: string;
    exitCode?: number;
    videoName?: string;
  }): ErrorEvent {
    return {
      type: undefined,
      level: 'fatal',
      platform: 'native',
      exception: {
        values: [{
          type: options.exceptionValue,
          value: options.exceptionValue,
        }],
      },
      contexts: {
        electron: {
          crashed_url: 'app:///dist/index.html',
          'crashpad.platform': 'win32',
          'crashpad.process_type': 'renderer',
          'crashpad.subresource_url': `https://www.openinterpreter.com/videos/demos/${options.videoName ?? 'markdown.mp4'}`,
          details: {
            exitCode: options.exitCode ?? -1073741819,
            reason: 'crashed',
          },
          type: 'default',
        },
      },
      tags: {
        'event.environment': 'native',
        'event.origin': 'electron',
        'event.process': 'renderer',
        'exit.reason': 'crashed',
        mechanism: 'minidump',
      },
    };
  }

  function browserBadDecryptEvent(options: {
    includeGroupingFields?: boolean;
    process?: string;
  } = {}): ErrorEvent {
    const event: ErrorEvent = {
      type: undefined,
      level: 'fatal',
      platform: 'node',
      exception: {
        values: [{ type: 'Error', value: badDecryptMessage }],
      },
      tags: {
        'event.environment': 'javascript',
        'event.origin': 'electron',
        'event.process': options.process ?? 'browser',
        mechanism: 'generic',
      },
    };

    if (options.includeGroupingFields ?? true) {
      event.logentry = { message: badDecryptMessage };
      event.transaction = badDecryptMessage;
    }

    return event;
  }

  test('drops external GlobalAttentionWindow minidump events even when the helper image is not first', () => {
    const event: ErrorEvent = {
      type: undefined,
      debug_meta: {
        images: [
          {
            code_file: '/usr/lib/libobjc.A.dylib',
            debug_id: 'objc',
            type: 'sourcemap',
          },
          {
            code_file: '/Users/alice/workspace/.mcp/attention-popup/GlobalAttentionWindow.app/Contents/MacOS/GlobalAttentionWindow',
            debug_id: 'helper',
            type: 'sourcemap',
          },
        ],
      },
      tags: {
        mechanism: 'minidump',
      },
    };

    expect(sanitizeCodexSentryEvent(event, undefined)).toBeNull();
  });

  test('keeps unrelated minidump events', () => {
    const event: ErrorEvent = {
      type: undefined,
      debug_meta: {
        images: [{
          code_file: '/Applications/Interpreter.app/Contents/MacOS/Interpreter',
          debug_id: 'interpreter',
          type: 'sourcemap',
        }],
      },
      tags: {
        mechanism: 'minidump',
      },
    };

    expect(sanitizeCodexSentryEvent(event, undefined)).toBe(event);
  });

  test('keeps and normalizes Electron browser BoringSSL bad decrypt events', () => {
    const event = browserBadDecryptEvent();

    const sanitized = sanitizeCodexSentryEvent(event, undefined);

    expect(sanitized).toBe(event);
    expect(sanitized?.exception?.values?.[0]?.value).toBe(
      badDecryptDisplayMessage,
    );
    expect(sanitized?.message).toBe(badDecryptDisplayMessage);
    expect(sanitized?.logentry?.message).toBe(badDecryptDisplayMessage);
    expect(sanitized?.transaction).toBe(badDecryptDisplayMessage);
    expect(sanitized?.extra?.electron_raw_bad_decrypt_message).toBe(badDecryptMessage);
    expect(sanitized?.contexts?.electronDiagnostic).toEqual({
      errorFamily: 'browser_boringssl_bad_decrypt',
      sanitized: true,
    });
    expect(sanitized?.tags?.['electron.error.family']).toBe('browser_boringssl_bad_decrypt');
    expect(sanitized?.tags?.['electron.error.sanitized']).toBe('true');
    expect(sanitized?.fingerprint).toEqual([
      'electron-browser',
      'boringssl-bad-decrypt',
    ]);
  });

  test('does not normalize non-browser BoringSSL bad decrypt events', () => {
    const event = browserBadDecryptEvent({
      includeGroupingFields: false,
      process: 'renderer',
    });

    expect(sanitizeCodexSentryEvent(event, undefined)).toBe(event);
    expect(event.message).toBeUndefined();
    expect(event.fingerprint).toBeUndefined();
  });

  test('drops renderer native crashes for packaged sound subresources before Sentry symbolication', () => {
    const event: ErrorEvent = {
      type: undefined,
      level: 'fatal',
      platform: 'native',
      contexts: {
        electron: {
          'crashpad.process_type': 'renderer',
          'crashpad.subresource_url': 'file:///C:/Program%20Files/Interpreter/resources/app.asar/dist/sounds/chirp.wav',
          details: {
            exitCode: -1073741819,
            reason: 'crashed',
          },
          type: 'default',
        },
      },
      tags: {
        'event.environment': 'native',
        'event.process': 'renderer',
        'exit.reason': 'crashed',
      },
    };

    expect(sanitizeCodexSentryEvent(event, undefined)).toBeNull();
  });

  test('drops renderer native crashes for inline WAV data URL subresources before Sentry symbolication', () => {
    const event: ErrorEvent = {
      type: undefined,
      level: 'fatal',
      platform: 'native',
      contexts: {
        electron: {
          'crashpad.process_type': 'renderer',
          'crashpad.subresource_url': 'data:audio/wav;base64,UklGRs6dJwBXQVZFZm10IA==',
          details: {
            exitCode: -1073741819,
            reason: 'crashed',
          },
          type: 'default',
        },
      },
      tags: {
        'event.environment': 'native',
        'event.process': 'renderer',
        'exit.reason': 'crashed',
      },
    };

    expect(sanitizeCodexSentryEvent(event, undefined)).toBeNull();
  });

  test('keeps renderer native crashes when subresource is not a packaged sound', () => {
    const event: ErrorEvent = {
      type: undefined,
      level: 'fatal',
      platform: 'native',
      contexts: {
        electron: {
          'crashpad.process_type': 'renderer',
          'crashpad.subresource_url': 'https://example.com/api/chat',
          details: {
            exitCode: -1073741819,
            reason: 'crashed',
          },
          type: 'default',
        },
      },
      tags: {
        'event.environment': 'native',
        'event.process': 'renderer',
        'exit.reason': 'crashed',
      },
    };

    expect(sanitizeCodexSentryEvent(event, undefined)).toBe(event);
  });

  test('tags support issue 2038 Linux renderer partition allocator OOM minidumps instead of dropping them', () => {
    const event: ErrorEvent = {
      type: undefined,
      level: 'fatal',
      platform: 'native',
      contexts: {
        electron: {
          crashed_url: 'app:///dist/index.html',
          'crashpad.platform': 'linux',
          'crashpad.process_type': 'renderer',
          'crashpad.ptype': 'renderer',
          details: {
            exitCode: 133,
            reason: 'crashed',
          },
          type: 'default',
        },
      },
      tags: {
        'event.environment': 'native',
        'event.origin': 'electron',
        'event.process': 'renderer',
        'exit.reason': 'crashed',
        mechanism: 'minidump',
      },
    };

    const result = sanitizeCodexSentryEvent(event, undefined);
    expect(result).not.toBeNull();
    expect(result?.tags?.['crash.category']).toBe('renderer-oom');
  });

  test('tags support issues 1961, 1962, 1998, 1999, 2024, and 2025 macOS renderer partition allocator OOM minidumps', () => {
    const event: ErrorEvent = {
      type: undefined,
      level: 'fatal',
      platform: 'native',
      exception: {
        values: [{
          type: 'Fatal Error: EXC_BREAKPOINT / EXC_ARM_BREAKPOINT / 0x1146986cc',
          value: 'Fatal Error: EXC_BREAKPOINT / EXC_ARM_BREAKPOINT / 0x1146986cc',
        }],
      },
      contexts: {
        electron: {
          crashed_url: 'app:///dist/index.html',
          'crashpad.platform': 'darwin',
          'crashpad.process_type': 'renderer',
          'crashpad.ptype': 'renderer',
          details: {
            exitCode: 5,
            reason: 'crashed',
          },
          type: 'default',
        },
      },
      tags: {
        'event.environment': 'native',
        'event.origin': 'electron',
        'event.process': 'renderer',
        'exit.reason': 'crashed',
        mechanism: 'minidump',
      },
    };

    const result = sanitizeCodexSentryEvent(event, undefined);
    expect(result).not.toBeNull();
    expect(result?.tags?.['crash.category']).toBe('renderer-oom');
  });

  test('keeps non-linux/darwin renderer minidumps with the same signature', () => {
    const event: ErrorEvent = {
      type: undefined,
      level: 'fatal',
      platform: 'native',
      contexts: {
        electron: {
          crashed_url: 'app:///dist/index.html',
          'crashpad.platform': 'win32',
          'crashpad.process_type': 'renderer',
          'crashpad.ptype': 'renderer',
          details: {
            exitCode: 133,
            reason: 'crashed',
          },
          type: 'default',
        },
      },
      tags: {
        'event.environment': 'native',
        'event.origin': 'electron',
        'event.process': 'renderer',
        'exit.reason': 'crashed',
        mechanism: 'minidump',
      },
    };

    expect(sanitizeCodexSentryEvent(event, undefined)).toBe(event);
  });

  const droppedWindowsOnboardingVideoMinidumps = [
    /*
    Sentry issues 7456212831 / ELECTRON-CM and 7469284349 / ELECTRON-DG have
    generic-looking access-violation titles after server symbolication. The full
    Sentry CLI payloads include the markdown onboarding demo video subresource
    plus exitCode=-1073741819, so these belong to the onboarding-video drop gate
    rather than the generic nativeIssueScenarios table below.
    */
    {
      exceptionValue: 'Fatal Error: EXCEPTION_ACCESS_VIOLATION_READ / 0xe01513c0',
      issues: '1964 / ELECTRON-CM',
    },
    {
      exceptionValue: 'Fatal Error: EXCEPTION_ACCESS_VIOLATION_READ / 0x23bf0740c1d8',
      issues: '1970 / ELECTRON-DG',
    },
    {
      exceptionValue: 'Fatal Error: EXCEPTION_ACCESS_VIOLATION_WRITE / 0x100',
      issues: '1909, 1910, 1986, and 1987',
    },
    {
      exceptionValue: 'Fatal Error: EXCEPTION_ACCESS_VIOLATION_READ / 0x15d',
      issues: '2073 and 2074',
    },
    {
      exceptionValue: 'Fatal Error: EXCEPTION_ACCESS_VIOLATION_WRITE / 0x7ff77f971b78',
      issues: '2077 and 2080',
    },
    {
      exceptionValue: 'Fatal Error: EXCEPTION_ACCESS_VIOLATION_WRITE / 0x0',
      issues: '2078 and 2079',
    },
    {
      exceptionValue: 'Fatal Error: EXCEPTION_ACCESS_VIOLATION_READ / 0x22209000000',
      issues: '2081 and 2082',
    },
  ] as const;

  for (const scenario of droppedWindowsOnboardingVideoMinidumps) {
    test(`drops Windows renderer onboarding video minidumps for support issues ${scenario.issues} before Sentry symbolication`, () => {
      const event = windowsOnboardingVideoMinidumpEvent({
        exceptionValue: scenario.exceptionValue,
        videoName: 'excel.mp4',
      });

      expect(sanitizeCodexSentryEvent(event, undefined)).toBeNull();
    });
  }

  test('drops Windows renderer onboarding video Object::GetPrototypeChainRootMap minidumps for support issues 1980 and 1981', () => {
    const event = windowsOnboardingVideoMinidumpEvent({
      exceptionValue: 'Fatal Error: EXCEPTION_ACCESS_VIOLATION_READ / 0x3920f01a8e4',
    });

    expect(sanitizeCodexSentryEvent(event, undefined)).toBeNull();
  });

  test('drops Windows renderer onboarding video Factory::NewForeign minidumps for support issues 1982 and 1983', () => {
    const event = windowsOnboardingVideoMinidumpEvent({
      exceptionValue: 'Fatal Error: EXCEPTION_ACCESS_VIOLATION_READ / 0xffffffffffffffff',
    });

    expect(sanitizeCodexSentryEvent(event, undefined)).toBeNull();
  });

  test('tags Windows renderer onboarding video breakpoint minidumps for support issues 1959 and 1960', () => {
    const event = windowsOnboardingVideoMinidumpEvent({
      exceptionValue: 'Fatal Error: EXCEPTION_BREAKPOINT / 0x7ff668bf3f29',
      exitCode: -2147483645,
      videoName: 'excel.mp4',
    });

    const sanitized = sanitizeCodexSentryEvent(event, undefined);

    expect(sanitized).toBe(event);
    expect(sanitized?.tags?.['crash.category']).toBe('renderer-onboarding-video');
    expect(sanitized?.tags?.['crash.signal']).toBe('breakpoint');
    expect(sanitized?.tags?.['crash.process']).toBe('renderer');
    expect(sanitized?.tags?.['onboarding.demo_video']).toBe('excel.mp4');
    expect(sanitized?.fingerprint).toBeUndefined();
  });

  test('tags Windows renderer onboarding video breakpoint minidumps for support issues 2083 and 2084', () => {
    const event = windowsOnboardingVideoMinidumpEvent({
      exceptionValue: 'Fatal Error: EXCEPTION_BREAKPOINT / 0x7ff77c20e82c',
      exitCode: -2147483645,
      videoName: 'excel.mp4',
    });

    const sanitized = sanitizeCodexSentryEvent(event, undefined);

    expect(sanitized).toBe(event);
    expect(sanitized?.tags?.['crash.category']).toBe('renderer-onboarding-video');
    expect(sanitized?.tags?.['crash.signal']).toBe('breakpoint');
    expect(sanitized?.tags?.['crash.process']).toBe('renderer');
    expect(sanitized?.tags?.['onboarding.demo_video']).toBe('excel.mp4');
    expect(sanitized?.fingerprint).toBeUndefined();
  });

  test('tags support issues 1978 and 1979 Windows renderer onboarding video priv-instruction minidumps', () => {
    const event: ErrorEvent = {
      type: undefined,
      level: 'fatal',
      platform: 'native',
      exception: {
        values: [{
          type: 'EXCEPTION_PRIV_INSTRUCTION / 0x7ff728ac2002',
          value: 'Fatal Error: EXCEPTION_PRIV_INSTRUCTION / 0x7ff728ac2002',
        }],
      },
      contexts: {
        electron: {
          crashed_url: 'app:///dist/index.html',
          'crashpad.platform': 'win32',
          'crashpad.process_type': 'renderer',
          'crashpad.subresource_url': 'https://www.openinterpreter.com/videos/demos/excel.mp4',
          details: {
            exitCode: -1073741674,
            reason: 'crashed',
          },
          type: 'default',
        },
      },
      tags: {
        'event.environment': 'native',
        'event.origin': 'electron',
        'event.process': 'renderer',
        'exit.reason': 'crashed',
        mechanism: 'minidump',
      },
    };

    const sanitized = sanitizeCodexSentryEvent(event, undefined);

    expect(sanitized).toBe(event);
    expect(sanitized?.tags?.['crash.category']).toBe('renderer-onboarding-video');
    expect(sanitized?.tags?.['crash.signal']).toBe('priv-instruction');
    expect(sanitized?.tags?.['crash.process']).toBe('renderer');
    expect(sanitized?.tags?.['onboarding.demo_video']).toBe('excel.mp4');
    expect(sanitized?.fingerprint).toBeUndefined();
  });

  test('keeps Windows renderer crashes for non-onboarding remote video minidumps', () => {
    const event: ErrorEvent = {
      type: undefined,
      level: 'fatal',
      platform: 'native',
      contexts: {
        electron: {
          crashed_url: 'app:///dist/index.html',
          'crashpad.platform': 'win32',
          'crashpad.process_type': 'renderer',
          'crashpad.subresource_url': 'https://example.com/video.mp4',
          details: {
            exitCode: -1073741819,
            reason: 'crashed',
          },
          type: 'default',
        },
      },
      tags: {
        'event.environment': 'native',
        'event.origin': 'electron',
        'event.process': 'renderer',
        'exit.reason': 'crashed',
        mechanism: 'minidump',
      },
    };

    expect(sanitizeCodexSentryEvent(event, undefined)).toBe(event);
  });

  test('tags Chromium disk allocator corruption renderer minidumps for support issues 2046 and 2047', () => {
    const event = nativeMinidumpEvent({
      electronContext: {
        crashed_url: 'app:///dist/index.html',
        'crashpad.LOG_FATAL': 'disk_data_allocator.cc:214: Check failed: . Likely file corruption.: The device is not ready. (0x15)\n',
        'crashpad.platform': 'win32',
        'crashpad.process_type': 'renderer',
        details: {
          exitCode: -2147483645,
          reason: 'crashed',
        },
        type: 'default',
      },
      exceptionValue: 'Fatal Error: EXCEPTION_BREAKPOINT / 0x7ff6fb2a9c0c',
      process: 'renderer',
      reason: 'crashed',
    });

    const sanitized = sanitizeCodexSentryEvent(event, undefined);

    expect(sanitized).toBe(event);
    expect(sanitized?.tags?.['crash.category']).toBe('renderer-disk-cache-corruption');
    expect(sanitized?.tags?.['crash.signal']).toBe('breakpoint');
    expect(sanitized?.tags?.['crash.process']).toBe('renderer');
    expect(sanitized?.tags?.['chromium.failure']).toBe('disk-data-allocator-corruption');
    expect(sanitized?.fingerprint).toBeUndefined();
  });

  test('keeps Chromium fatal renderer minidumps generic without the disk allocator corruption log', () => {
    const event = nativeMinidumpEvent({
      electronContext: {
        crashed_url: 'app:///dist/index.html',
        'crashpad.LOG_FATAL': 'logging.cc: Fatal renderer error without disk allocator evidence',
        'crashpad.platform': 'win32',
        'crashpad.process_type': 'renderer',
        details: {
          exitCode: -2147483645,
          reason: 'crashed',
        },
        type: 'default',
      },
      exceptionValue: 'Fatal Error: EXCEPTION_BREAKPOINT / 0x7ff6fb2a9c0c',
      process: 'renderer',
      reason: 'crashed',
    });

    const sanitized = sanitizeCodexSentryEvent(event, undefined);

    expect(sanitized).toBe(event);
    expect(sanitized?.tags?.['crash.category']).toBe('native-breakpoint');
    expect(sanitized?.tags?.['chromium.failure']).toBeUndefined();
    expect(sanitized?.fingerprint).toBeUndefined();
  });

  test('drops external Python PDFKit LaunchServices minidumps before Sentry symbolication', () => {
    const event: ErrorEvent = {
      type: undefined,
      level: 'fatal',
      platform: 'native',
      contexts: {
        HIServices: {
          annotations: [
            '_RegisterApplication(), unable to get application ASN from launchservicesd, and this application requires an ASN, so aborting.',
          ],
          type: 'default',
        },
        LaunchServices: {
          annotations: [
            '<rdar://problem/28724618> Process unable to create connection because the sandbox denied the right to lookup com.apple.coreservices.launchservicesd and so this process cannot talk to launchservicesd.',
          ],
          type: 'default',
        },
      },
      debug_meta: {
        images: [
          {
            code_file: '/Library/Frameworks/Python.framework/Versions/3.11/Resources/Python.app/Contents/MacOS/Python',
            debug_id: 'python',
            type: 'macho',
          },
          {
            code_file: '/System/Library/Frameworks/PDFKit.framework/Versions/A/PDFKit',
            debug_id: 'pdfkit',
            type: 'macho',
          },
        ],
      },
      tags: {
        'event.environment': 'native',
        'event.origin': 'electron',
        'event.process': 'unknown',
        mechanism: 'minidump',
      },
    };

    expect(sanitizeCodexSentryEvent(event, undefined)).toBeNull();
  });

  test('keeps unknown native minidumps without the external Python PDFKit evidence pair', () => {
    const event: ErrorEvent = {
      type: undefined,
      level: 'fatal',
      platform: 'native',
      contexts: {
        LaunchServices: {
          annotations: [
            '<rdar://problem/28724618> Process unable to create connection because the sandbox denied the right to lookup com.apple.coreservices.launchservicesd and so this process cannot talk to launchservicesd.',
          ],
          type: 'default',
        },
      },
      debug_meta: {
        images: [{
          code_file: '/Applications/Interpreter.app/Contents/MacOS/Interpreter',
          debug_id: 'interpreter',
          type: 'macho',
        }],
      },
      tags: {
        'event.environment': 'native',
        'event.origin': 'electron',
        'event.process': 'unknown',
        mechanism: 'minidump',
      },
    };

    expect(sanitizeCodexSentryEvent(event, undefined)).toBe(event);
  });

  test('drops external Python malloc abort minidumps for support issues 2088 and 2089', () => {
    const event = nativeMinidumpEvent({
      exceptionValue: 'Fatal Error: unknown 0x00000000 / 0x00000000 / 0x18e28a5e8',
      process: 'unknown',
    });
    event.contexts = {
      'libsystem_malloc.dylib': {
        annotations: [
          'Python(4256,0x16f0a3000) malloc: *** error for object 0x815760300: pointer being freed was not allocated\n',
        ],
        type: 'crashpad',
      },
    };

    expect(sanitizeCodexSentryEvent(event, undefined)).toBeNull();
  });

  test('keeps unknown native minidumps without external Python malloc evidence', () => {
    const event = nativeMinidumpEvent({
      exceptionValue: 'Fatal Error: unknown 0x00000000 / 0x00000000 / 0x18e28a5e8',
      process: 'unknown',
    });
    event.contexts = {
      'libsystem_c.dylib': {
        annotations: ['abort() called'],
        type: 'crashpad',
      },
    };

    expect(sanitizeCodexSentryEvent(event, undefined)).toBe(event);
  });

  test('drops external Homebrew Node dyld abort minidumps for support issues 1990 and 1991', () => {
    const event = unknownProcessDyldMinidumpEvent(
      'Library not loaded: /usr/local/opt/llhttp/lib/libllhttp.9.3.dylib\n  Referenced from: <A0DF5AD0-3FEA-30D1-8256-FA126780028C> /usr/local/Cellar/node/25.9.0_1/bin/node\n  Reason: tried: \'/usr/local/opt/llhttp/lib/libllhttp.9.3.dylib\' (no such file)',
    );

    expect(sanitizeCodexSentryEvent(event, undefined)).toBeNull();
  });

  test('keeps unrelated unknown-process dyld minidumps', () => {
    const event = unknownProcessDyldMinidumpEvent(
      'Library not loaded: /Applications/Interpreter.app/Contents/Frameworks/Example.framework/Example',
    );

    expect(sanitizeCodexSentryEvent(event, undefined)).toBe(event);
  });

  test('drops oo-editors macOS codesign ENOENT stderr reports mirrored from issue 1859', () => {
    const message = 'oo-editors stderr: [0503/184139.119408:ERROR:electron/shell/common/mac/codesign_util.cc:131] SecCodeCopyGuestWithAttributes: Error Domain=NSOSStatusErrorDomain Code=100002 "ENOENT: No such file or directory" (100002)';
    const event: ErrorEvent = {
      type: undefined,
      level: 'error',
      platform: 'node',
      message,
      tags: {
        'event.origin': 'electron',
        'event.process': 'browser',
      },
    };

    expect(sanitizeCodexSentryEvent(event, undefined)).toBeNull();
  });

  test('keeps unrelated oo-editors stderr reports', () => {
    const event: ErrorEvent = {
      type: undefined,
      level: 'error',
      platform: 'node',
      message: 'oo-editors stderr: failed to start document bridge',
      tags: {
        'event.origin': 'electron',
        'event.process': 'browser',
      },
    };

    expect(sanitizeCodexSentryEvent(event, undefined)).toBe(event);
  });

  test('normalizes browser-process BoringSSL BAD_DECRYPT fatals for support issue 2045', () => {
    const event: ErrorEvent = {
      type: undefined,
      level: 'fatal',
      platform: 'node',
      exception: {
        values: [{
          type: 'Error',
          value: '148692032:error:1e000065:Cipher functions:OPENSSL_internal:BAD_DECRYPT:..\\..\\third_party\\boringssl\\src\\crypto\\fipsmodule\\cipher\\e_aes.cc.inc:839:',
        }],
      },
      tags: {
        'event.environment': 'javascript',
        'event.origin': 'electron',
        'event.process': 'browser',
        mechanism: 'generic',
      },
    };

    const sanitized = sanitizeCodexSentryEvent(event, undefined);

    expect(sanitized).toBe(event);
    expect(sanitized?.exception?.values?.[0]?.value).toBe(badDecryptDisplayMessage);
    expect(sanitized?.message).toBe(badDecryptDisplayMessage);
    expect(sanitized?.extra?.electron_raw_bad_decrypt_message).toBe(
      '148692032:error:1e000065:Cipher functions:OPENSSL_internal:BAD_DECRYPT:..\\..\\third_party\\boringssl\\src\\crypto\\fipsmodule\\cipher\\e_aes.cc.inc:839:',
    );
    expect(sanitized?.tags?.['crash.category']).toBe('browser-boringssl-bad-decrypt');
    expect(sanitized?.tags?.['crash.process']).toBe('browser');
    expect(sanitized?.fingerprint).toEqual([
      'electron-browser',
      'boringssl-bad-decrypt',
    ]);
  });

  test('keeps BoringSSL BAD_DECRYPT reports outside the browser process unclassified', () => {
    const event: ErrorEvent = {
      type: undefined,
      level: 'fatal',
      platform: 'node',
      message: '148692032:error:1e000065:Cipher functions:OPENSSL_internal:BAD_DECRYPT:..\\..\\third_party\\boringssl\\src\\crypto\\fipsmodule\\cipher\\e_aes.cc.inc:839:',
      tags: {
        'event.environment': 'javascript',
        'event.origin': 'electron',
        'event.process': 'renderer',
        mechanism: 'generic',
      },
    };

    const sanitized = sanitizeCodexSentryEvent(event, undefined);

    expect(sanitized).toBe(event);
    expect(sanitized?.tags?.['crash.category']).toBeUndefined();
    expect(sanitized?.fingerprint).toBeUndefined();
  });

  test('drops Electron GPU process abnormal-exit warnings', () => {
    const event: ErrorEvent = {
      type: undefined,
      level: 'warning',
      message: "'GPU' process exited with 'abnormal-exit'",
      tags: {
        'event.environment': 'javascript',
        'event.origin': 'electron',
        'event.process': 'GPU',
        level: 'warning',
      },
    };

    expect(sanitizeCodexSentryEvent(event, undefined)).toBeNull();
  });

  test('keeps other Electron GPU process warnings', () => {
    const event: ErrorEvent = {
      type: undefined,
      level: 'warning',
      message: 'GPU feature status changed',
      tags: {
        'event.environment': 'javascript',
        'event.origin': 'electron',
        'event.process': 'GPU',
        level: 'warning',
      },
    };

    expect(sanitizeCodexSentryEvent(event, undefined)).toBe(event);
  });

  test('tags unhandled Electron native minidumps by signal and process', () => {
    const event: ErrorEvent = {
      type: undefined,
      level: 'fatal',
      platform: 'native',
      exception: {
        values: [{
          type: 'EXCEPTION_ACCESS_VIOLATION_READ / 0xa8c05cc0000',
          value: 'Fatal Error: EXCEPTION_ACCESS_VIOLATION_READ / 0xa8c05cc0000',
        }],
      },
      tags: {
        'event.environment': 'native',
        'event.origin': 'electron',
        'event.process': 'renderer',
        mechanism: 'minidump',
      },
    };

    const sanitized = sanitizeCodexSentryEvent(event, undefined);

    expect(sanitized).toBe(event);
    expect(sanitized?.tags?.['crash.category']).toBe('native-access-violation');
    expect(sanitized?.tags?.['crash.signal']).toBe('access-violation');
    expect(sanitized?.tags?.['crash.process']).toBe('renderer');
    expect(sanitized?.fingerprint).toBeUndefined();
  });

  const nativeIssueScenarios = [
    {
      expectedCategory: 'native-unknown',
      expectedProcess: 'unknown',
      expectedSignal: 'unknown',
      issue: 'openinterpreter/iworkstation-issues#1293 / ELECTRON-9Q',
      process: 'unknown',
      title: '__pthread_kill',
      value: 'Fatal Error: unknown 0x00000000 / 0x00000000 / 0x1834445e8',
    },
    {
      expectedCategory: 'gpu-process-crash',
      expectedProcess: 'gpu',
      expectedSignal: 'unknown',
      issue: 'openinterpreter/iworkstation-issues#1241',
      process: 'gpu',
      title: 'glStartTilingQCOM',
      value: undefined,
    },
    {
      expectedCategory: 'gpu-process-crash',
      expectedProcess: 'gpu',
      expectedSignal: 'unknown',
      issue: 'openinterpreter/iworkstation-issues#2075 / ELECTRON-EX',
      process: 'gpu',
      title: 'crash_reporter::DumpWithoutCrashing',
      value: 'Fatal Error: Simulated Exception / 0x7ff62835cac7',
    },
    {
      expectedCategory: 'renderer-oom',
      expectedProcess: 'renderer',
      expectedSignal: 'oom',
      issue: 'openinterpreter/iworkstation-issues#2070 and #2071 / ELECTRON-EV',
      process: 'renderer',
      title: 'RaiseException',
      value: 'Fatal Error: Out of Memory / 0x7ff9828073fa',
    },
    {
      expectedCategory: 'native-exc-bad-instruction',
      expectedProcess: 'browser',
      expectedSignal: 'exc-bad-instruction',
      issue: 'openinterpreter/iworkstation-issues#2068 / ELECTRON-ET',
      process: 'browser',
      title: 'electron::ElectronBrowserClient::AppendExtraCommandLineSwitches',
      value: 'Fatal Error: EXC_BAD_INSTRUCTION / EXC_I386_INVOP / 0x11a06f23d',
    },
    {
      expectedCategory: 'native-exc-bad-access',
      expectedProcess: 'unknown',
      expectedSignal: 'exc-bad-access',
      issue: 'openinterpreter/iworkstation-issues#2064 and #2065 / ELECTRON-ER',
      process: 'unknown',
      title: '__pthread_kill',
      value: 'Fatal Error: EXC_BAD_ACCESS / KERN_INVALID_ADDRESS / 0xffff00000010',
    },
    {
      expectedCategory: 'native-access-violation',
      expectedProcess: 'browser',
      expectedSignal: 'access-violation',
      issue: 'openinterpreter/iworkstation-issues#2041 and #2042 / ELECTRON-EH',
      process: 'browser',
      title: 'ATL::CComPtrBase<T>::~CComPtrBase<T>',
      value: 'Fatal Error: EXCEPTION_ACCESS_VIOLATION_READ / 0x7ff80129d1c0',
    },
    {
      expectedCategory: 'renderer-oom',
      expectedProcess: 'renderer',
      expectedSignal: 'oom',
      issue: 'openinterpreter/iworkstation-issues#1939 / ELECTRON-CX',
      process: 'renderer',
      reason: 'oom',
      title: 'RaiseException',
      value: 'Fatal Error: Out of Memory / 0x7ff8e45f5339',
    },
    {
      expectedCategory: 'renderer-oom',
      expectedProcess: 'renderer',
      expectedSignal: 'oom',
      issue: 'openinterpreter/iworkstation-issues#2029 / ELECTRON-DH',
      process: 'renderer',
      reason: 'oom',
      title: 'RaiseException',
      value: 'Fatal Error: Out of Memory / 0x7ffa33f9fe0a',
    },
    {
      expectedCategory: 'native-sigsegv',
      expectedProcess: 'browser',
      expectedSignal: 'sigsegv',
      issue: 'openinterpreter/iworkstation-issues#1950 and #1951 / ELECTRON-DQ',
      process: 'browser',
      title: 'google::OpenObjectFileContainingPcAndGetStartAddress',
      value: 'Fatal Error: SIGSEGV / SEGV_MAPERR / 0xffffffffffffffff',
    },
    {
      expectedCategory: 'native-access-violation',
      expectedProcess: 'renderer',
      expectedSignal: 'access-violation',
      issue: 'openinterpreter/iworkstation-issues#1942 and #1943 / ELECTRON-DN',
      process: 'renderer',
      title: '`anonymous namespace\'::V8FatalErrorCallback',
      value: 'Fatal Error: EXCEPTION_ACCESS_VIOLATION_WRITE / 0x0',
    },
    {
      expectedCategory: 'renderer-oom',
      expectedProcess: 'renderer',
      expectedSignal: 'oom',
      issue: 'openinterpreter/iworkstation-issues#1272',
      process: 'renderer',
      title: 'Out of Memory',
      value: 'Fatal Error: Out of Memory / 0x7ff8a0ab782a',
    },
    {
      expectedCategory: 'renderer-oom',
      expectedProcess: 'renderer',
      expectedSignal: 'oom',
      issue: 'ELECTRON-AC',
      process: 'renderer',
      title: 'Out of Memory',
      value: 'Fatal Error: Out of Memory / 0x7ffa84e8055c',
    },
    {
      expectedCategory: 'process-oom',
      expectedProcess: 'utility',
      expectedSignal: 'oom',
      issue: 'openinterpreter/iworkstation-issues#1557 / ELECTRON-AV',
      process: 'utility',
      title: 'RaiseException',
      value: 'Fatal Error: Out of Memory / 0x7ffa76ff5369',
    },
    {
      expectedCategory: 'process-oom',
      expectedProcess: 'gpu',
      expectedSignal: 'oom',
      issue: 'openinterpreter/iworkstation-issues#1639 / ELECTRON-8D',
      process: 'gpu',
      title: 'RaiseException',
      value: 'Fatal Error: Out of Memory / 0x7ffeb89179da',
    },
    {
      expectedCategory: 'native-exc-bad-access',
      expectedProcess: 'browser',
      expectedSignal: 'exc-bad-access',
      issue: 'openinterpreter/iworkstation-issues#1248',
      process: 'browser',
      title: 'EXC_BAD_ACCESS',
      value: 'Fatal Error: EXC_BAD_ACCESS / KERN_PROTECTION_FAILURE / 0x13ca46c48',
    },
    {
      expectedCategory: 'native-unknown',
      expectedProcess: 'browser',
      expectedSignal: 'unknown',
      issue: 'openinterpreter/iworkstation-issues#1226',
      process: 'browser',
      title: 'Simulated Exception',
      value: 'Fatal Error: Simulated Exception / 0x113a4fb6c',
    },
    {
      expectedCategory: 'native-sigsegv',
      expectedProcess: 'browser',
      expectedSignal: 'sigsegv',
      issue: 'openinterpreter/iworkstation-issues#1196',
      process: 'browser',
      title: 'ui::XdgToplevel::SurfaceMove',
      value: 'Fatal Error: SIGSEGV / SEGV_MAPERR / 0x8',
    },
    {
      expectedCategory: 'native-sigsegv',
      expectedProcess: 'browser',
      expectedSignal: 'sigsegv',
      issue: 'openinterpreter/iworkstation-issues#1566 / ELECTRON-8H',
      process: 'browser',
      title: 'uv__loop_interrupt',
      value: 'Fatal Error: SIGSEGV / SI_KERNEL / 0x0',
    },
    {
      expectedCategory: 'native-sigsegv',
      expectedProcess: 'renderer',
      expectedSignal: 'sigsegv',
      issue: 'ELECTRON-9V',
      process: 'renderer',
      title: 'SIGSEGV',
      value: 'Fatal Error: SIGSEGV / SEGV_MAPERR / 0x60ce00000000',
    },
    {
      expectedCategory: 'native-breakpoint',
      expectedProcess: 'browser',
      expectedSignal: 'breakpoint',
      issue: 'openinterpreter/iworkstation-issues#1227',
      process: 'browser',
      title: 'crash_reporter::DumpWithoutCrashing',
      value: 'Fatal Error: EXCEPTION_BREAKPOINT / 0x80000003',
    },
    {
      expectedCategory: 'native-sigtrap',
      expectedProcess: 'browser',
      expectedSignal: 'sigtrap',
      issue: 'openinterpreter/iworkstation-issues#1201 / ELECTRON-AB',
      process: 'browser',
      title: 'SIGTRAP',
      value: 'Fatal Error: SIGTRAP / SI_KERNEL / 0x0',
    },
    {
      expectedCategory: 'native-sigtrap',
      expectedProcess: 'browser',
      expectedSignal: 'sigtrap',
      issue: 'openinterpreter/iworkstation-issues#1767',
      process: 'browser',
      title: 'SIGTRAP',
      value: 'Fatal Error: SIGTRAP / SI_KERNEL / 0x0',
    },
    {
      expectedCategory: 'native-exc-bad-access',
      expectedProcess: 'browser',
      expectedSignal: 'exc-bad-access',
      issue: 'openinterpreter/iworkstation-issues#1768',
      process: 'browser',
      title: 'EXC_BAD_ACCESS',
      value: 'Fatal Error: EXC_BAD_ACCESS / EXC_I386_GPFLT / 0x1149d7b30',
    },
    {
      expectedCategory: 'native-breakpoint',
      expectedProcess: 'renderer',
      expectedSignal: 'breakpoint',
      issue: 'openinterpreter/iworkstation-issues#1802 / ELECTRON-C9',
      process: 'renderer',
      title: 'v8::internal::Scavenger::Process',
      value: 'Fatal Error: EXCEPTION_BREAKPOINT / 0x7ff7671329c1',
    },
    {
      expectedCategory: 'native-access-violation',
      expectedProcess: 'renderer',
      expectedSignal: 'access-violation',
      issue: 'openinterpreter/iworkstation-issues#1804 / ELECTRON-CA',
      process: 'renderer',
      title: 'RtlpQueryProcessDebugInformationRemote',
      value: 'Fatal Error: EXCEPTION_ACCESS_VIOLATION_READ / 0x15ffe3c0040',
    },
    {
      expectedCategory: 'native-access-violation',
      expectedProcess: 'renderer',
      expectedSignal: 'access-violation',
      issue: 'openinterpreter/iworkstation-issues#1814 / ELECTRON-CB',
      process: 'renderer',
      title: 'Builtins_CreateDataProperty',
      value: 'Fatal Error: EXCEPTION_ACCESS_VIOLATION_WRITE / 0x108107780b38',
    },
    {
      expectedCategory: 'native-access-violation',
      expectedProcess: 'renderer',
      expectedSignal: 'access-violation',
      issue: 'openinterpreter/iworkstation-issues#1818 / ELECTRON-CC',
      process: 'renderer',
      title: 'v8::internal::UnifiedHeapMarkingVisitorBase::Visit',
      value: 'Fatal Error: EXCEPTION_ACCESS_VIOLATION_READ / 0x4d3c0d3c3354',
    },
    {
      expectedCategory: 'native-access-violation',
      expectedProcess: 'renderer',
      expectedSignal: 'access-violation',
      issue: 'openinterpreter/iworkstation-issues#2044 / ELECTRON-CD',
      process: 'renderer',
      title: 'v8::internal::UnifiedHeapMarkingVisitorBase::Visit',
      value: 'Fatal Error: EXCEPTION_ACCESS_VIOLATION_READ / 0x2200002c',
    },
    {
      expectedCategory: 'native-exc-breakpoint',
      expectedProcess: 'unknown',
      expectedSignal: 'exc-breakpoint',
      issue: 'openinterpreter/iworkstation-issues#1823 / ELECTRON-CF',
      process: 'unknown',
      title: 'EXC_BREAKPOINT',
      value: 'Fatal Error: EXC_BREAKPOINT / EXC_I386_BPT / 0x1062532b4',
    },
    {
      expectedCategory: 'native-access-violation',
      expectedProcess: 'browser',
      expectedSignal: 'access-violation',
      issue: 'openinterpreter/iworkstation-issues#1834 and #1897 / ELECTRON-CH',
      process: 'browser',
      title: 'RtlDispatchAPC',
      value: 'Fatal Error: EXCEPTION_ACCESS_VIOLATION_READ / 0x267aaf23060',
    },
    {
      expectedCategory: 'native-access-violation',
      expectedProcess: 'renderer',
      expectedSignal: 'access-violation',
      issue: 'openinterpreter/iworkstation-issues#1836 / ELECTRON-CI',
      process: 'renderer',
      title: 'Builtins_RecordWriteSaveFP',
      value: 'Fatal Error: EXCEPTION_ACCESS_VIOLATION_READ / 0x48',
    },
    {
      expectedCategory: 'native-access-violation',
      expectedProcess: 'renderer',
      expectedSignal: 'access-violation',
      issue: 'openinterpreter/iworkstation-issues#1845 / ELECTRON-CJ',
      process: 'renderer',
      title: 'v8::internal::MarkCompactCollector::IsUnmarkedHeapObject',
      value: 'Fatal Error: EXCEPTION_ACCESS_VIOLATION_READ / 0xa8c05cc0000',
    },
    {
      expectedCategory: 'native-access-violation',
      expectedProcess: 'browser',
      expectedSignal: 'access-violation',
      issue: 'openinterpreter/iworkstation-issues#1849 / ELECTRON-CK',
      process: 'browser',
      title: 'strlen$thunk$10150925376295766583',
      value: 'Fatal Error: EXCEPTION_ACCESS_VIOLATION_READ / 0xa81c3430',
    },
    {
      expectedCategory: 'native-access-violation',
      expectedProcess: 'renderer',
      expectedSignal: 'access-violation',
      issue: 'openinterpreter/iworkstation-issues#1856 and #1898 / ELECTRON-CL',
      process: 'renderer',
      title: 'Builtins_CreateDataProperty',
      value: 'Fatal Error: EXCEPTION_ACCESS_VIOLATION_WRITE / 0xac30798baec',
    },
    {
      expectedCategory: 'native-access-violation',
      expectedProcess: 'renderer',
      expectedSignal: 'access-violation',
      issue: 'openinterpreter/iworkstation-issues#1870 and #1871 / ELECTRON-CX',
      process: 'renderer',
      title: 'blink::JSEventListener::Matches',
      value: 'Fatal Error: EXCEPTION_ACCESS_VIOLATION_READ / 0xffffffffffffffff',
    },
    {
      expectedCategory: 'native-access-violation',
      expectedProcess: 'renderer',
      expectedSignal: 'access-violation',
      issue: 'openinterpreter/iworkstation-issues#1872 and #1873 / ELECTRON-CZ',
      process: 'renderer',
      title: 'v8::internal::FastGetOwnValuesOrEntries',
      value: 'Fatal Error: EXCEPTION_ACCESS_VIOLATION_WRITE / 0x28e00005580',
    },
    {
      expectedCategory: 'native-sigtrap',
      expectedProcess: 'browser',
      expectedSignal: 'sigtrap',
      issue: 'openinterpreter/iworkstation-issues#1875 and #1876 / ELECTRON-D1',
      process: 'browser',
      title: 'ui::ResourceBundle::GetLocalizedString',
      value: 'Fatal Error: SIGTRAP / SI_KERNEL / 0x0',
    },
    {
      expectedCategory: 'native-sigsegv',
      expectedProcess: 'browser',
      expectedSignal: 'sigsegv',
      issue: 'openinterpreter/iworkstation-issues#1877 / ELECTRON-D2',
      process: 'browser',
      title: 'base::MessagePumpGlib::Run',
      value: 'Fatal Error: SIGSEGV / SEGV_MAPERR / 0x48',
    },
    {
      expectedCategory: 'native-sigsegv',
      expectedProcess: 'browser',
      expectedSignal: 'sigsegv',
      issue: 'openinterpreter/iworkstation-issues#1884 and #1885 / ELECTRON-D3',
      process: 'browser',
      title: 'uv_close',
      value: 'Fatal Error: SIGSEGV / SEGV_MAPERR / 0x168',
    },
    {
      expectedCategory: 'native-sigsegv',
      expectedProcess: 'browser',
      expectedSignal: 'sigsegv',
      issue: 'openinterpreter/iworkstation-issues#1988 and #1989 / ELECTRON-E3',
      process: 'browser',
      title: 'electron::ClientFrameViewLinux::ClientFrameViewLinux',
      value: 'Fatal Error: SIGSEGV / SEGV_MAPERR / 0x0',
    },
    {
      expectedCategory: 'utility-process-crash',
      expectedProcess: 'utility',
      expectedSignal: 'sigbus',
      issue: 'openinterpreter/iworkstation-issues#1895 and #1896 / ELECTRON-D7',
      process: 'utility',
      title: 'std::__Cr::vector<T>::__destroy_vector::operator()',
      value: 'Fatal Error: SIGBUS / BUS_ADRERR / 0x560a0b094450',
    },
    {
      expectedCategory: 'native-access-violation',
      expectedProcess: 'renderer',
      expectedSignal: 'access-violation',
      issue: 'openinterpreter/iworkstation-issues#1899 and #1900 / ELECTRON-D8',
      process: 'renderer',
      title: 'v8::internal::Object::GetPrototypeChainRootMap',
      value: 'Fatal Error: EXCEPTION_ACCESS_VIOLATION_READ / 0x2290f01a8e4',
    },
    {
      expectedCategory: 'native-exc-bad-instruction',
      expectedProcess: 'unknown',
      expectedSignal: 'exc-bad-instruction',
      issue: 'openinterpreter/iworkstation-issues#1901 and #1902 / ELECTRON-D9',
      process: 'unknown',
      title: 'EXC_BAD_INSTRUCTION',
      value: 'Fatal Error: EXC_BAD_INSTRUCTION / EXC_I386_INVOP / 0x10491ed9d',
    },
    {
      expectedCategory: 'native-exc-bad-access',
      expectedProcess: 'unknown',
      expectedSignal: 'exc-bad-access',
      issue: 'openinterpreter/iworkstation-issues#2048 / ELECTRON-EK',
      process: 'unknown',
      title: 'sqlite3DbMallocRawNNTyped',
      value: 'Fatal Error: EXC_BAD_ACCESS / KERN_INVALID_ADDRESS / 0x636170736b726f77',
    },
    {
      expectedCategory: 'native-access-violation',
      expectedProcess: 'renderer',
      expectedSignal: 'access-violation',
      issue: 'openinterpreter/iworkstation-issues#1905 and #1906 / ELECTRON-DB',
      process: 'renderer',
      title: 'memcpy',
      value: 'Fatal Error: EXCEPTION_ACCESS_VIOLATION_READ / 0xffffffffffffffff',
    },
    {
      expectedCategory: 'utility-process-crash',
      expectedProcess: 'utility',
      expectedSignal: 'breakpoint',
      issue: 'openinterpreter/iworkstation-issues#1907 and #1908 / ELECTRON-DC',
      process: 'utility',
      title: 'chrome::HandleDelayLoadFailureCommon',
      value: 'Fatal Error: EXCEPTION_BREAKPOINT / 0x7ff69e5c5831',
    },
    {
      expectedCategory: 'native-cpp-exception',
      expectedProcess: 'browser',
      expectedSignal: 'cpp-exception',
      issue: 'openinterpreter/iworkstation-issues#1913 and #1914 / ELECTRON-DE',
      process: 'browser',
      title: 'RaiseException',
      value: 'Fatal Error: Unhandled C++ Exception / 0x7ffc722273fa',
    },
    {
      expectedCategory: 'native-breakpoint',
      expectedProcess: 'browser',
      expectedSignal: 'breakpoint',
      issue: 'openinterpreter/iworkstation-issues#1921 and #1922 / ELECTRON-DF',
      process: 'browser',
      title: 'wil::details::DebugBreak',
      value: 'Fatal Error: EXCEPTION_BREAKPOINT / 0x7ff8e46b9a42',
    },
    {
      expectedCategory: 'browser-oom',
      expectedProcess: 'browser',
      expectedSignal: 'oom',
      issue: 'openinterpreter/iworkstation-issues#1925 / ELECTRON-DH',
      process: 'browser',
      title: 'RaiseException',
      value: 'Fatal Error: Out of Memory / 0x7ffbec80055c',
    },
    {
      expectedCategory: 'renderer-oom',
      expectedProcess: 'renderer',
      expectedSignal: 'oom',
      issue: 'openinterpreter/iworkstation-issues#1926 / ELECTRON-DJ',
      process: 'renderer',
      title: 'RaiseException',
      value: 'Fatal Error: Out of Memory / 0x7ffbec80055c',
    },
    {
      expectedCategory: 'browser-oom',
      expectedProcess: 'browser',
      expectedSignal: 'oom',
      issue: 'openinterpreter/iworkstation-issues#1930 / ELECTRON-DK',
      process: 'browser',
      title: 'RaiseException',
      value: 'Fatal Error: Out of Memory / 0x7ff87c1b1eea',
    },
    {
      expectedCategory: 'browser-oom',
      expectedProcess: 'browser',
      expectedSignal: 'oom',
      issue: 'openinterpreter/iworkstation-issues#2020 / ELECTRON-EC',
      process: 'browser',
      title: 'RaiseException',
      value: 'Fatal Error: Out of Memory / 0x7fffcf73fe0a',
    },
    {
      expectedCategory: 'native-sigabrt',
      expectedProcess: 'browser',
      expectedSignal: 'sigabrt',
      issue: 'openinterpreter/iworkstation-issues#2026 and #2027 / ELECTRON-EF',
      process: 'browser',
      title: 'node::PrincipalRealm::messaging_deserialize_create_object',
      value: 'Fatal Error: SIGABRT / 0x0',
    },
    {
      expectedCategory: 'native-exc-bad-access',
      expectedProcess: 'renderer',
      expectedSignal: 'exc-bad-access',
      issue: 'openinterpreter/iworkstation-issues#1934 / ELECTRON-DM',
      process: 'renderer',
      title: 'v8::internal::Execution::Call',
      value: 'Fatal Error: EXC_BAD_ACCESS / KERN_PROTECTION_FAILURE / 0x3b8207bd0282',
    },
    {
      expectedCategory: 'native-breakpoint',
      expectedProcess: 'renderer',
      expectedSignal: 'breakpoint',
      issue: 'openinterpreter/iworkstation-issues#1959 and #1960 / ELECTRON-DV',
      process: 'renderer',
      title: 'v8::internal::Heap::FindCodeForInnerPointer',
      value: 'Fatal Error: EXCEPTION_BREAKPOINT / 0x7ff785b83f29',
    },
    {
      expectedCategory: 'native-access-violation',
      expectedProcess: 'renderer',
      expectedSignal: 'access-violation',
      issue: 'openinterpreter/iworkstation-issues#1993 and #1994 / ELECTRON-E5',
      process: 'renderer',
      title: 'Builtins_InterpreterEntryTrampoline',
      value: 'Fatal Error: EXCEPTION_ACCESS_VIOLATION_READ / 0x17f078069e8',
    },
    {
      expectedCategory: 'native-access-violation',
      expectedProcess: 'renderer',
      expectedSignal: 'access-violation',
      issue: 'openinterpreter/iworkstation-issues#1995 / ELECTRON-E6',
      process: 'renderer',
      title: 'v8::internal::Sweeper::LocalSweeper::ParallelSweepPage',
      value: 'Fatal Error: EXCEPTION_ACCESS_VIOLATION_WRITE / 0x8000000',
    },
    {
      expectedCategory: 'native-access-violation',
      expectedProcess: 'renderer',
      expectedSignal: 'access-violation',
      issue: 'openinterpreter/iworkstation-issues#1973 and #1974 / ELECTRON-DY',
      process: 'renderer',
      title: 'v8::internal::ThreadIsolation::RegisterInstructionStreamAllocation',
      value: 'Fatal Error: EXCEPTION_ACCESS_VIOLATION_READ / 0xffffffffffffffff',
    },
    {
      expectedCategory: 'native-access-violation',
      expectedProcess: 'renderer',
      expectedSignal: 'access-violation',
      issue: 'openinterpreter/iworkstation-issues#1769',
      process: 'renderer',
      title: 'EXCEPTION_ACCESS_VIOLATION_READ',
      value: 'Fatal Error: EXCEPTION_ACCESS_VIOLATION_READ / 0x64',
    },
    {
      expectedCategory: 'native-access-violation',
      expectedProcess: 'browser',
      expectedSignal: 'access-violation',
      issue: 'openinterpreter/iworkstation-issues#1775',
      process: 'browser',
      title: 'EXCEPTION_ACCESS_VIOLATION_READ',
      value: 'Fatal Error: EXCEPTION_ACCESS_VIOLATION_READ / 0x22ba42db060',
    },
    {
      expectedCategory: 'native-access-violation',
      expectedProcess: 'renderer',
      expectedSignal: 'access-violation',
      issue: 'openinterpreter/iworkstation-issues#1776',
      process: 'renderer',
      title: 'EXCEPTION_ACCESS_VIOLATION_READ',
      value: 'Fatal Error: EXCEPTION_ACCESS_VIOLATION_READ / 0x30700308113',
    },
    {
      expectedCategory: 'native-breakpoint',
      expectedProcess: 'renderer',
      expectedSignal: 'breakpoint',
      issue: 'openinterpreter/iworkstation-issues#1781',
      process: 'renderer',
      title: 'EXCEPTION_BREAKPOINT',
      value: 'Fatal Error: EXCEPTION_BREAKPOINT / 0x7ff79e40a552',
    },
    {
      expectedCategory: 'native-sigtrap',
      expectedProcess: 'browser',
      expectedSignal: 'sigtrap',
      issue: 'openinterpreter/iworkstation-issues#1784',
      process: 'browser',
      title: 'SIGTRAP',
      value: 'Fatal Error: SIGTRAP / SI_KERNEL / 0x0',
    },
    {
      expectedCategory: 'native-access-violation',
      expectedProcess: 'renderer',
      expectedSignal: 'access-violation',
      issue: 'openinterpreter/iworkstation-issues#1788',
      process: 'renderer',
      title: 'EXCEPTION_ACCESS_VIOLATION_READ',
      value: 'Fatal Error: EXCEPTION_ACCESS_VIOLATION_READ / 0x39700300000',
    },
    {
      expectedCategory: 'native-sigtrap',
      expectedProcess: 'browser',
      expectedSignal: 'sigtrap',
      issue: 'openinterpreter/iworkstation-issues#1795',
      process: 'browser',
      title: 'SIGTRAP',
      value: 'Fatal Error: SIGTRAP / SI_KERNEL / 0x0',
    },
    {
      expectedCategory: 'gpu-process-crash',
      expectedProcess: 'gpu',
      expectedSignal: 'sigsegv',
      issue: 'openinterpreter/iworkstation-issues#1796',
      process: 'gpu',
      title: 'SIGSEGV',
      value: 'Fatal Error: SIGSEGV / SEGV_MAPERR / 0xd8',
    },
    {
      expectedCategory: 'native-sigabrt',
      expectedProcess: 'browser',
      expectedSignal: 'sigabrt',
      issue: 'openinterpreter/iworkstation-issues#1683 / ELECTRON-BF',
      process: 'browser',
      title: 'uv_run',
      value: 'Fatal Error: SIGABRT / 0x0',
    },
    {
      expectedCategory: 'utility-process-crash',
      expectedProcess: 'utility',
      expectedSignal: 'sigbus',
      issue: 'ELECTRON-AQ',
      process: 'utility',
      title: 'SIGBUS',
      value: 'Fatal Error: SIGBUS / BUS_ADRERR / 0x5b8c6c1cc6b0',
    },
    {
      expectedCategory: 'native-access-violation',
      expectedProcess: 'renderer',
      expectedSignal: 'access-violation',
      issue: 'openinterpreter/iworkstation-issues#1105',
      process: 'renderer',
      title: '_tailMerge_bcryptprimitives.dll',
      value: 'Fatal Error: EXCEPTION_ACCESS_VIOLATION_READ / 0x0000000000000000',
    },
    {
      expectedCategory: 'native-access-violation',
      expectedProcess: 'renderer',
      expectedSignal: 'access-violation',
      issue: 'openinterpreter/iworkstation-issues#1996 / ELECTRON-E6',
      process: 'renderer',
      title: 'v8::internal::Sweeper::LocalSweeper::ParallelSweepPage',
      value: 'Fatal Error: EXCEPTION_ACCESS_VIOLATION_WRITE / 0x8000000',
    },
    {
      expectedCategory: 'native-unknown',
      expectedProcess: 'browser',
      expectedSignal: 'unknown',
      issue: 'openinterpreter/iworkstation-issues#1997 / ELECTRON-E7',
      frameworkProcess: 'browser',
      process: 'unknown',
      title: '__pthread_kill',
      value: 'Fatal Error: unknown 0x00000000 / 0x00000000 / 0x1834e75b0',
    },
    {
      expectedCategory: 'native-access-violation',
      expectedProcess: 'renderer',
      expectedSignal: 'access-violation',
      issue: 'openinterpreter/iworkstation-issues#2085 and #2086 / ELECTRON-F1',
      process: 'renderer',
      title: 'v8::internal::JSObjectWalkVisitor::StructureWalk',
      value: 'Fatal Error: EXCEPTION_ACCESS_VIOLATION_READ / 0xf20b71011a',
    },
    {
      expectedCategory: 'gpu-process-crash',
      expectedProcess: 'gpu',
      expectedSignal: 'sigsegv',
      issue: 'openinterpreter/iworkstation-issues#2102 and #2103 / ELECTRON-F3',
      process: 'gpu',
      title: 'glStartTilingQCOM',
      value: 'Fatal Error: SIGSEGV / SEGV_MAPERR / 0x8',
    },
    {
      expectedCategory: 'native-sigabrt',
      expectedProcess: 'browser',
      expectedSignal: 'sigabrt',
      issue: 'openinterpreter/iworkstation-issues#2105 and #2106 / ELECTRON-F4',
      process: 'browser',
      title: 'uv__io_poll',
      value: 'Fatal Error: SIGABRT / 0x0',
    },
  ] as const;

  for (const scenario of nativeIssueScenarios) {
    test(`tags ${scenario.issue} ${scenario.title} as ${scenario.expectedCategory}`, () => {
      const event = nativeMinidumpEvent({
        exceptionValue: scenario.value,
        frameworkProcess: 'frameworkProcess' in scenario ? scenario.frameworkProcess : undefined,
        process: scenario.process,
        reason: 'reason' in scenario ? scenario.reason : undefined,
      });

      const sanitized = sanitizeCodexSentryEvent(event, undefined);

      expect(sanitized).toBe(event);
      expect(sanitized?.tags?.['crash.category']).toBe(scenario.expectedCategory);
      expect(sanitized?.tags?.['crash.signal']).toBe(scenario.expectedSignal);
      expect(sanitized?.tags?.['crash.process']).toBe(scenario.expectedProcess);
      expect(sanitized?.fingerprint).toBeUndefined();
    });
  }

  test('tags older Windows renderer RaiseException OOM support mirrors as renderer OOM', () => {
    const event = nativeMinidumpEvent({
      exceptionValue: 'Fatal Error: EXCEPTION_ACCESS_VIOLATION_READ / 0xffffffffffffffff',
      process: 'renderer',
      reason: 'oom',
    });

    const sanitized = sanitizeCodexSentryEvent(event, undefined);

    expect(sanitized).toBe(event);
    expect(sanitized?.tags?.['crash.category']).toBe('renderer-oom');
    expect(sanitized?.tags?.['crash.signal']).toBe('oom');
    expect(sanitized?.tags?.['crash.process']).toBe('renderer');
    expect(sanitized?.fingerprint).toBeUndefined();
  });

  test('tags support issues 1903 and 1904 Windows renderer RaiseException OOM as renderer OOM', () => {
    const event = nativeMinidumpEvent({
      exceptionValue: 'Fatal Error: Out of Memory / 0x7ffd2d4e01fc',
      process: 'renderer',
      reason: 'oom',
    });

    const sanitized = sanitizeCodexSentryEvent(event, undefined);

    expect(sanitized).toBe(event);
    expect(sanitized?.tags?.['crash.category']).toBe('renderer-oom');
    expect(sanitized?.tags?.['crash.signal']).toBe('oom');
    expect(sanitized?.tags?.['crash.process']).toBe('renderer');
    expect(sanitized?.fingerprint).toBeUndefined();
  });

  test('does not label non-renderer oom exits as renderer oom', () => {
    const event = nativeMinidumpEvent({
      exceptionValue: 'Fatal Error: Out of Memory / 0x7ffa76ff5369',
      process: 'utility',
      reason: 'oom',
    });

    const sanitized = sanitizeCodexSentryEvent(event, undefined);

    expect(sanitized).toBe(event);
    expect(sanitized?.tags?.['crash.category']).toBe('process-oom');
    expect(sanitized?.tags?.['crash.signal']).toBe('oom');
    expect(sanitized?.tags?.['crash.process']).toBe('utility');
    expect(sanitized?.fingerprint).toBeUndefined();
  });

  test('leaves native fatal events without minidump mechanism untouched', () => {
    const event: ErrorEvent = {
      type: undefined,
      level: 'fatal',
      platform: 'native',
      exception: {
        values: [{
          type: 'EXCEPTION_ACCESS_VIOLATION_READ / 0xa8c05cc0000',
          value: 'Fatal Error: EXCEPTION_ACCESS_VIOLATION_READ / 0xa8c05cc0000',
        }],
      },
      tags: {
        'event.environment': 'native',
        'event.origin': 'electron',
        'event.process': 'renderer',
      },
    };

    const sanitized = sanitizeCodexSentryEvent(event, undefined);

    expect(sanitized).toBe(event);
    expect(sanitized?.tags?.['crash.category']).toBeUndefined();
    expect(sanitized?.fingerprint).toBeUndefined();
  });

  test('drops browser-extension relay ECONNRESET browser-process noise', () => {
    const event: ErrorEvent = {
      type: undefined,
      breadcrumbs: [
        {
          category: 'browser-extension-relay',
          level: 'info',
          message: 'relay ready',
        },
        {
          category: 'http',
          data: {
            url: 'http://127.0.0.1:19988/version',
          },
          level: 'info',
        },
      ],
      exception: {
        values: [{ type: 'Error', value: 'read ECONNRESET' }],
      },
      tags: {
        'event.process': 'browser',
      },
    };

    expect(sanitizeCodexSentryEvent(event, undefined)).toBeNull();
  });

  test('keeps ECONNRESET reports without browser-extension relay evidence', () => {
    const event: ErrorEvent = {
      type: undefined,
      breadcrumbs: [
        {
          category: 'http',
          data: {
            url: 'https://api.example.com/version',
          },
          level: 'info',
        },
      ],
      exception: {
        values: [{ type: 'Error', value: 'read ECONNRESET' }],
      },
      tags: {
        'event.process': 'browser',
      },
    };

    expect(sanitizeCodexSentryEvent(event, undefined)).toBe(event);
  });

  test('keeps relay ECONNRESET reports outside the browser process', () => {
    const event: ErrorEvent = {
      type: undefined,
      breadcrumbs: [
        {
          category: 'http',
          data: {
            url: 'http://127.0.0.1:19988/extensions/status',
          },
          level: 'info',
        },
      ],
      exception: {
        values: [{ type: 'Error', value: 'read ECONNRESET' }],
      },
      tags: {
        'event.process': 'renderer',
      },
    };

    expect(sanitizeCodexSentryEvent(event, undefined)).toBe(event);
  });

  test('groups support issue 1971 browser-process BoringSSL BAD_DECRYPT fatals under a stable fingerprint', () => {
    const rawMessage = '148692032:error:1e000065:Cipher functions:OPENSSL_internal:BAD_DECRYPT:..\\..\\third_party\\boringssl\\src\\crypto\\fipsmodule\\cipher\\e_aes.cc.inc:839:\n';
    const event: ErrorEvent = {
      type: undefined,
      level: 'fatal',
      platform: 'node',
      exception: {
        values: [{ type: 'Error', value: rawMessage }],
      },
      logentry: {
        message: rawMessage,
      },
      tags: {
        'event.origin': 'electron',
        'event.process': 'browser',
      },
    };

    const sanitized = sanitizeCodexSentryEvent(event, undefined);

    expect(sanitized).toBe(event);
    expect(sanitized?.exception?.values?.[0]?.value).toBe('electron main process BoringSSL BAD_DECRYPT');
    expect(sanitized?.message).toBe('electron main process BoringSSL BAD_DECRYPT');
    expect(sanitized?.logentry?.message).toBe('electron main process BoringSSL BAD_DECRYPT');
    expect(sanitized?.tags?.['crash.category']).toBe('main-process-boringssl-bad-decrypt');
    expect(sanitized?.tags?.['crash.signal']).toBe('bad-decrypt');
    expect(sanitized?.tags?.['crash.process']).toBe('browser');
    expect(sanitized?.fingerprint).toEqual(['electron-main', 'boringssl-bad-decrypt']);
    expect(sanitized?.extra?.boringSslBadDecryptRawMessage).toBe(rawMessage);
  });

  test('surfaces a stderr preview for generic exits', () => {
    const rawMessage = 'codex app-server exited (1): stderr: failed to bind stdio bridge on startup';
    const event: ErrorEvent = {
      type: undefined,
      exception: {
        values: [{ type: 'Error', value: rawMessage }],
      },
    };

    const sanitized = sanitizeCodexSentryEvent(event, {
      originalException: new Error(rawMessage),
    });

    expect(sanitized?.exception?.values?.[0]?.value).toBe(
      'codex app-server exited (1): generic_exit [failed to bind stdio bridge on startup]',
    );
    expect(sanitized?.message).toBe(
      'codex app-server exited (1): generic_exit [failed to bind stdio bridge on startup]',
    );
    expect(sanitized?.contexts?.codex).toEqual({
      detailPreview: 'failed to bind stdio bridge on startup',
      detailSource: 'stderr',
      errorFamily: 'generic_exit',
      exitCode: '1',
      sanitized: true,
    });
    expect(sanitized?.fingerprint).toEqual([
      'codex-app-server',
      'generic_exit',
      '1',
    ]);
  });

  test('surfaces a stdout preview for generic exits', () => {
    const rawMessage = 'codex app-server exited (1): stdout: child exited before initialize';
    const event: ErrorEvent = {
      type: undefined,
      exception: {
        values: [{ type: 'Error', value: rawMessage }],
      },
    };

    const sanitized = sanitizeCodexSentryEvent(event, {
      originalException: new Error(rawMessage),
    });

    expect(sanitized?.message).toBe(
      'codex app-server exited (1): generic_exit [child exited before initialize]',
    );
    expect(sanitized?.contexts?.codex).toEqual({
      detailPreview: 'child exited before initialize',
      detailSource: 'stdout',
      errorFamily: 'generic_exit',
      exitCode: '1',
      sanitized: true,
    });
  });

  test('classifies provider-overloaded previews and assigns a stable fingerprint', () => {
    const rawMessage = 'codex app-server exited (1073807364): stdout: internal_server_error';

    const event: ErrorEvent = {
      type: undefined,
      exception: {
        values: [{ type: 'Error', value: rawMessage }],
      },
    };
    const hint: EventHint = {
      originalException: new Error(rawMessage),
    };

    const sanitized = sanitizeCodexSentryEvent(event, hint);

    expect(sanitized?.exception?.values?.[0]?.value).toBe(
      'codex app-server exited (1073807364): provider_overloaded',
    );
    expect(sanitized?.message).toBe('codex app-server exited (1073807364): provider_overloaded');
    expect(sanitized?.fingerprint).toEqual([
      'codex-app-server',
      'provider_overloaded',
      '1073807364',
    ]);
    expect(sanitized?.tags?.['codex.error.family']).toBe('provider_overloaded');
    expect(sanitized?.tags?.['codex.detail_source']).toBe('stdout');
    expect(sanitized?.tags?.['codex.exit_code']).toBe('1073807364');
    expect(sanitized?.tags?.['codex.sanitized']).toBe('true');
    expect(sanitized?.extra?.codex_raw_exit_message).toBe(rawMessage);
    expect(sanitized?.contexts?.codex).toEqual({
      detailPreview: 'internal_server_error',
      detailSource: 'stdout',
      errorFamily: 'provider_overloaded',
      exitCode: '1073807364',
      sanitized: true,
    });
  });

  test('classifies null-code app-server exits under a stable generic fingerprint', () => {
    const rawMessage = 'codex app-server exited (null): generic_exit';
    const event: ErrorEvent = {
      type: undefined,
      exception: {
        values: [{ type: 'Error', value: rawMessage }],
      },
    };

    const sanitized = sanitizeCodexSentryEvent(event, {
      originalException: new Error(rawMessage),
    });

    expect(sanitized?.message).toBe('codex app-server exited (null): generic_exit');
    expect(sanitized?.fingerprint).toEqual([
      'codex-app-server',
      'generic_exit',
      'null',
    ]);
    expect(sanitized?.tags?.['codex.error.family']).toBe('generic_exit');
    expect(sanitized?.tags?.['codex.exit_code']).toBe('null');
  });

  test('classifies memory allocation failures', () => {
    const rawMessage = 'codex app-server exited (3221226505): memory allocation of 1802240 bytes failed';
    const event: ErrorEvent = {
      type: undefined,
      exception: {
        values: [{ type: 'Error', value: rawMessage }],
      },
    };

    const sanitized = sanitizeCodexSentryEvent(event, {
      originalException: new Error(rawMessage),
    });

    expect(sanitized?.exception?.values?.[0]?.value).toBe(
      'codex app-server exited (3221226505): memory_allocation_failed',
    );
    expect(sanitized?.fingerprint).toEqual([
      'codex-app-server',
      'memory_allocation_failed',
      '3221226505',
    ]);
  });

  test('classifies thread not found errors', () => {
    const rawMessage = 'thread not found: 019d4723-5e31-7f71-8300-b50e3ab3de6d';
    const event: ErrorEvent = {
      type: undefined,
      exception: {
        values: [{ type: 'Error', value: rawMessage }],
      },
    };

    const sanitized = sanitizeCodexSentryEvent(event, {
      originalException: new Error(rawMessage),
    });

    expect(sanitized?.exception?.values?.[0]?.value).toBe('codex thread unavailable');
    expect(sanitized?.fingerprint).toEqual([
      'codex-app-server',
      'thread_unavailable',
      'none',
    ]);
    expect(sanitized?.tags?.['codex.error.family']).toBe('thread_unavailable');
  });

  test('leaves non-codex events untouched', () => {
    const event: ErrorEvent = {
      type: undefined,
      exception: {
        values: [{ type: 'TypeError', value: 'Cannot read properties of undefined' }],
      },
    };

    expect(sanitizeCodexSentryEvent(event, undefined)).toBe(event);
  });
});
