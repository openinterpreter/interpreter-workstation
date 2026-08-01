import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  activateBrowserControlTab,
  buildBrowserControlStatus,
  clickBrowserControlPageElement,
  createResilientRelayRuntimeCdpLogger,
  createResilientRelayRuntimeLogger,
  drawBrowserControlPageTrace,
  formatOptionalBrowserExtensionRelayStartupFailureLog,
  getBrowserControlPageElementInventory,
  getBrowserControlStatus,
  hasRequiredRelayRuntimeLayout,
  ensureRelayListenAddressAvailableWithRetry,
  installRelayRuntimeFromBundledTree,
  isRelayListenAddressInUseError,
  isBrowserExtensionRelayReadyTimeoutError,
  resolveRelayReadyTimeoutMs,
  scrollBrowserControlPage,
  selectBrowserControlPageElement,
  setBrowserExtensionRelayLifecycleListener,
  startRelayServerWithAddressConflictRetry,
  typeBrowserControlPageElement,
  type BrowserExtensionRelayStatus,
  type RelayRuntimeServer,
} from './browserExtensionRelay';
import type { BrowserControlConnection } from '../../shared/types/browserControl';

const originalFetch = globalThis.fetch;
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'browser-extension-relay-test-'));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, contents: string = 'ok'): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
}

function makeListenError(port: number): NodeJS.ErrnoException {
  const error = new Error(
    `listen EADDRINUSE: address already in use 127.0.0.1:${port}`,
  ) as NodeJS.ErrnoException;
  error.code = 'EADDRINUSE';
  error.address = '127.0.0.1';
  error.port = port;
  return error;
}

function writeRelayBundledTree(
  runtimeDir: string,
  version: string,
  files: Record<string, string>,
  manifestContents?: string,
): void {
  const runtimeFiles: Record<string, string> = {
    'package.json': JSON.stringify({ version }),
    ...files,
  };
  const normalizedPaths = Object.keys(runtimeFiles)
    .sort((left, right) => left.localeCompare(right));
  const hash = createHash('sha256');
  let totalBytes = 0;

  for (const relativePath of normalizedPaths) {
    const fileContents = Buffer.from(runtimeFiles[relativePath], 'utf8');
    hash.update('F\0');
    hash.update(relativePath);
    hash.update('\0');
    hash.update(String(fileContents.byteLength));
    hash.update('\0');
    hash.update(fileContents);
    totalBytes += fileContents.byteLength;
  }

  const manifest = {
    schemaVersion: 1,
    packageVersion: version,
    fileCount: normalizedPaths.length,
    totalBytes,
    treeSha256: hash.digest('hex'),
  };

  for (const [relativePath, contents] of Object.entries(runtimeFiles)) {
    writeFile(path.join(runtimeDir, relativePath), contents);
  }
  writeFile(path.join(runtimeDir, 'runtime-manifest.json'), manifestContents ?? JSON.stringify(manifest));
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  setBrowserExtensionRelayLifecycleListener(null);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('formatOptionalBrowserExtensionRelayStartupFailureLog', () => {
  test('includes structured startup context when relay paths exist', () => {
    const status: BrowserExtensionRelayStatus = {
      phase: 'error',
      version: '1.2.3',
      runtimeDir: '/runtime/browser-extension-relay',
      relayLogPath: '/logs/browser-extension-relay.log',
      relayCdpLogPath: '/logs/browser-extension-relay-cdp.jsonl',
      ownsRelayProcess: false,
      lastError: 'relay exited',
    };

    expect(
      formatOptionalBrowserExtensionRelayStartupFailureLog(
        new Error('relay exited before readiness'),
        status,
      ),
    ).toBe(
      '[BrowserExtensionRelay] Optional startup failed; continuing without browser control. '
      + 'phase=error '
      + 'error="relay exited before readiness" '
      + 'runtimeDir=/runtime/browser-extension-relay '
      + 'relayLogPath=/logs/browser-extension-relay.log '
      + 'relayCdpLogPath=/logs/browser-extension-relay-cdp.jsonl',
    );
  });

  test('falls back to null placeholders when startup metadata is unavailable', () => {
    const status: BrowserExtensionRelayStatus = {
      phase: 'starting',
      version: null,
      runtimeDir: null,
      relayLogPath: null,
      relayCdpLogPath: null,
      ownsRelayProcess: false,
      lastError: null,
    };

    expect(
      formatOptionalBrowserExtensionRelayStartupFailureLog('spawn failed', status),
    ).toBe(
      '[BrowserExtensionRelay] Optional startup failed; continuing without browser control. '
      + 'phase=starting '
      + 'error="spawn failed" '
      + 'runtimeDir=null '
      + 'relayLogPath=null '
      + 'relayCdpLogPath=null',
    );
  });
});

describe('resolveRelayReadyTimeoutMs', () => {
  test('uses a longer default timeout when no override is provided', () => {
    expect(resolveRelayReadyTimeoutMs(undefined)).toBe(30_000);
  });

  test('accepts valid integer overrides', () => {
    expect(resolveRelayReadyTimeoutMs('45000')).toBe(45_000);
  });

  test('falls back to default timeout for invalid overrides', () => {
    expect(resolveRelayReadyTimeoutMs('0')).toBe(30_000);
    expect(resolveRelayReadyTimeoutMs('-2')).toBe(30_000);
    expect(resolveRelayReadyTimeoutMs('abc')).toBe(30_000);
  });
});

describe('setBrowserExtensionRelayLifecycleListener', () => {
  test('accepts null listeners for cleanup', () => {
    expect(() => {
      setBrowserExtensionRelayLifecycleListener(() => {});
      setBrowserExtensionRelayLifecycleListener(null);
    }).not.toThrow();
  });
});

describe('relay runtime loggers', () => {
  test('recreates the relay log directory before async runtime writes', async () => {
    const tempDir = makeTempDir();
    const relayLogPath = path.join(tempDir, 'logs', 'browser-extension-relay.log');
    const calls: unknown[][] = [];
    const logger = createResilientRelayRuntimeLogger({
      logFilePath: relayLogPath,
      log: async (...args: unknown[]) => {
        calls.push(args);
        writeFileSync(relayLogPath, 'log');
      },
      error: async (...args: unknown[]) => {
        calls.push(args);
        writeFileSync(relayLogPath, 'error');
      },
    });

    rmSync(path.dirname(relayLogPath), { recursive: true, force: true });

    await logger.log('started');
    await logger.error('failed');

    expect(calls).toEqual([['started'], ['failed']]);
    expect(readFileSync(relayLogPath, 'utf8')).toBe('error');
  });

  test('recreates the relay CDP log directory before runtime writes', () => {
    const tempDir = makeTempDir();
    const cdpLogPath = path.join(tempDir, 'logs', 'browser-extension-relay-cdp.jsonl');
    const entries: unknown[] = [];
    const logger = createResilientRelayRuntimeCdpLogger({
      logFilePath: cdpLogPath,
      log: (entry: unknown) => {
        entries.push(entry);
        writeFileSync(cdpLogPath, JSON.stringify(entry));
      },
    });

    rmSync(path.dirname(cdpLogPath), { recursive: true, force: true });

    logger.log({ method: 'Target.attachedToTarget' });

    expect(entries).toEqual([{ method: 'Target.attachedToTarget' }]);
    expect(readFileSync(cdpLogPath, 'utf8')).toBe('{"method":"Target.attachedToTarget"}');
  });

  test('swallows relay log write failures so logging cannot crash relay startup', async () => {
    const tempDir = makeTempDir();
    const relayLogPath = path.join(tempDir, 'logs', 'browser-extension-relay.log');
    const warnCalls: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnCalls.push(args);
    };
    const logger = createResilientRelayRuntimeLogger({
      logFilePath: relayLogPath,
      log: async () => {
        throw new Error('ENOENT: no such file or directory');
      },
      error: async () => {
        throw new Error('EACCES: permission denied');
      },
    });

    try {
      await expect(logger.log('started')).resolves.toBeUndefined();
      await expect(logger.error('failed')).resolves.toBeUndefined();
    } finally {
      console.warn = originalWarn;
    }

    expect(warnCalls).toHaveLength(2);
    expect(String(warnCalls[0]![0])).toContain('Relay log write failed');
    expect(String(warnCalls[0]![0])).toContain('ENOENT');
    expect(String(warnCalls[1]![0])).toContain('EACCES');
  });
});

describe('isBrowserExtensionRelayReadyTimeoutError', () => {
  test('detects relay readiness timeout errors', () => {
    expect(
      isBrowserExtensionRelayReadyTimeoutError(
        new Error('[BrowserExtensionRelay] Timed out waiting for relay readiness after 30000ms. Check /tmp/relay.log'),
      ),
    ).toBeTrue();
  });

  test('ignores non-timeout relay startup errors', () => {
    expect(
      isBrowserExtensionRelayReadyTimeoutError(
        new Error('[BrowserExtensionRelay] Relay process exited before readiness. Check /tmp/relay.log'),
      ),
    ).toBeFalse();
  });
});

describe('isRelayListenAddressInUseError', () => {
  test('detects relay EADDRINUSE errors for the browser relay endpoint', () => {
    expect(
      isRelayListenAddressInUseError(makeListenError(19988)),
    ).toBeTrue();
  });

  test('ignores EADDRINUSE errors that are unrelated to the relay endpoint', () => {
    expect(
      isRelayListenAddressInUseError(makeListenError(3030)),
    ).toBeFalse();
  });

  test('ignores message-only errors that are not typed Node listen errors', () => {
    expect(
      isRelayListenAddressInUseError(
        new Error('listen EADDRINUSE: address already in use 127.0.0.1:19988'),
      ),
    ).toBeFalse();
  });
});

describe('startRelayServerWithAddressConflictRetry', () => {
  test('kills the stale listener and retries once after the first relay address conflict', async () => {
    const server: RelayRuntimeServer = {
      close() {},
      on() {},
      off() {},
    };
    const listenError = makeListenError(19988);
    const events: string[] = [];
    let attempts = 0;

    const result = await startRelayServerWithAddressConflictRetry({
      startRelayServer: async () => {
        attempts += 1;
        events.push(`start:${attempts}`);
        if (attempts === 1) {
          throw listenError;
        }
        return server;
      },
      handleInitialAddressConflict: async (error) => {
        events.push(`kill:${error.port}`);
      },
      handleRetryAddressConflict: async () => {
        events.push('blocked');
      },
    });

    expect(result).toEqual({ status: 'started', server });
    expect(events).toEqual(['start:1', 'kill:19988', 'start:2']);
  });

  test('returns blocked when the retry still hits the relay address conflict', async () => {
    const listenError = makeListenError(19988);
    const events: string[] = [];

    const result = await startRelayServerWithAddressConflictRetry({
      startRelayServer: async () => {
        events.push('start');
        throw listenError;
      },
      handleInitialAddressConflict: async () => {
        events.push('kill');
      },
      handleRetryAddressConflict: async (error) => {
        events.push(`blocked:${error.port}`);
      },
    });

    expect(result).toEqual({ status: 'blocked' });
    expect(events).toEqual(['start', 'kill', 'start', 'blocked:19988']);
  });

  test('throws non-relay startup errors without handling them as address conflicts', async () => {
    const startupError = new Error('relay module failed to load');
    const events: string[] = [];

    await expect(
      startRelayServerWithAddressConflictRetry({
        startRelayServer: async () => {
          throw startupError;
        },
        handleInitialAddressConflict: async () => {
          events.push('kill');
        },
        handleRetryAddressConflict: async () => {
          events.push('blocked');
        },
      }),
    ).rejects.toBe(startupError);
    expect(events).toEqual([]);
  });
});

describe('ensureRelayListenAddressAvailableWithRetry', () => {
  test('clears a stale relay listener before allowing startup', async () => {
    const events: string[] = [];
    let attempts = 0;

    const result = await ensureRelayListenAddressAvailableWithRetry({
      checkRelayListenAddressAvailable: async () => {
        attempts += 1;
        events.push(`check:${attempts}`);
        return attempts > 1;
      },
      handleInitialAddressConflict: async (error) => {
        events.push(`kill:${error.port}`);
      },
      handleRetryAddressConflict: async () => {
        events.push('blocked');
      },
    });

    expect(result).toEqual({ status: 'available' });
    expect(events).toEqual(['check:1', 'kill:19988', 'check:2']);
  });

  test('returns blocked when the relay address is still occupied after retry', async () => {
    const events: string[] = [];

    const result = await ensureRelayListenAddressAvailableWithRetry({
      checkRelayListenAddressAvailable: async () => {
        events.push('check');
        return false;
      },
      handleInitialAddressConflict: async () => {
        events.push('kill');
      },
      handleRetryAddressConflict: async (error) => {
        events.push(`blocked:${error.port}`);
      },
    });

    expect(result).toEqual({ status: 'blocked' });
    expect(events).toEqual(['check', 'kill', 'check', 'blocked:19988']);
  });
});

describe('buildBrowserControlStatus', () => {
  test('treats an observed relay as ready and clears stale errors', () => {
    const status: BrowserExtensionRelayStatus = {
      phase: 'error',
      version: '1.2.3',
      runtimeDir: '/runtime/browser-extension-relay',
      relayLogPath: '/logs/browser-extension-relay.log',
      relayCdpLogPath: '/logs/browser-extension-relay-cdp.jsonl',
      ownsRelayProcess: false,
      lastError: 'old startup error',
    };

    const connections: BrowserControlConnection[] = [
      {
        extensionId: 'ext-1',
        stableKey: 'chrome-main',
        profileId: 'chrome-main',
        browserName: 'chrome',
        version: '0.3.0',
        activeSessions: 2,
        targets: [],
        browserWindows: [],
        focusedWindowId: null,
        activeTabRef: null,
        focusedWindow: null,
        activeTab: null,
      },
    ];

    expect(buildBrowserControlStatus(status, '1.2.4', connections)).toEqual({
      relay: {
        ...status,
        phase: 'ready',
        version: '1.2.4',
        lastError: null,
        reachable: true,
        endpoint: 'http://127.0.0.1:19988',
      },
      connections,
      profiles: [
        {
          profileId: 'chrome-main',
          policyProfileId: 'chrome-main',
          browserName: 'chrome',
          browserChannel: null,
          profileName: 'chrome-main',
          profilePath: '',
          userDataDir: '',
          extensionId: 'ext-1',
          stableKey: 'chrome-main',
          connectionState: 'connected',
          activeSessions: 2,
          windowCount: 0,
          tabCount: 0,
        },
      ],
      connectedBrowsers: 1,
      activeSessions: 2,
    });
  });
});

describe('getBrowserControlStatus', () => {
  test('returns stable tab refs for every target from aggregated extension status', async () => {
    globalThis.fetch = (async (input) => {
      const url = String(input);

      if (url.endsWith('/version')) {
        return new Response(JSON.stringify({ version: '2.0.0' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.endsWith('/extensions/status')) {
        return new Response(JSON.stringify({
          extensions: [
            {
              extensionId: 'extension-1',
              stableKey: 'browser:profile-1',
              browser: 'chrome',
              activeTargets: 2,
              playwriterVersion: '0.4.0',
              targets: [
                {
                  targetId: 'target-1',
                  type: 'page',
                  title: 'Docs',
                  url: 'https://example.com/docs',
                  shareSource: 'user',
                },
                {
                  targetId: 'target-2',
                  type: 'page',
                  title: 'App',
                  url: 'https://example.com/app',
                  shareSource: 'agent-created',
                },
              ],
              browserTabs: {
                windows: [
                  {
                    windowId: 101,
                    focused: true,
                    type: 'normal',
                    state: 'normal',
                    tabs: [
                      {
                        chromeTabId: 201,
                        windowId: 101,
                        index: 0,
                        active: true,
                        highlighted: true,
                        pinned: false,
                        title: 'Docs',
                        url: 'https://example.com/docs',
                        status: 'complete',
                        controlState: 'controllable',
                        controlStateDetail: 'connected',
                        shared: true,
                        shareState: 'connected',
                        targetId: 'target-1',
                        sessionId: 'pw-tab-1',
                      },
                      {
                        chromeTabId: 202,
                        windowId: 101,
                        index: 1,
                        active: false,
                        highlighted: false,
                        pinned: false,
                        title: 'Unshared',
                        url: 'https://example.com/unshared',
                        status: 'complete',
                        controlState: 'observable',
                        shared: false,
                      },
                    ],
                  },
                ],
              },
            },
          ],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    await expect(getBrowserControlStatus()).resolves.toMatchObject({
      connections: [
        {
          extensionId: 'extension-1',
          stableKey: 'browser:profile-1',
          profileId: 'browser:profile-1',
          browserName: 'chrome',
          activeSessions: 2,
          focusedWindowId: 101,
          activeTabRef: 'browser:profile-1:chrome-tab:201',
          focusedWindow: {
            windowId: 101,
            focused: true,
          },
          activeTab: {
            tabRef: 'browser:profile-1:chrome-tab:201',
            chromeTabId: 201,
            windowId: 101,
            title: 'Docs',
          },
          targets: [
            {
              tabRef: 'browser:profile-1:target-1',
              targetId: 'target-1',
              title: 'Docs',
            },
            {
              tabRef: 'browser:profile-1:target-2',
              targetId: 'target-2',
              title: 'App',
            },
          ],
          browserWindows: [
            {
              windowId: 101,
              focused: true,
              type: 'normal',
              state: 'normal',
              tabs: [
                {
                  tabRef: 'browser:profile-1:chrome-tab:201',
                  chromeTabId: 201,
                  windowId: 101,
                  index: 0,
                  active: true,
                  highlighted: true,
                  pinned: false,
                  title: 'Docs',
                  url: 'https://example.com/docs',
                  status: 'complete',
                  controlState: 'controllable',
                  controlStateDetail: 'connected',
                  targetId: 'target-1',
                  sessionId: 'pw-tab-1',
                },
                {
                  tabRef: 'browser:profile-1:chrome-tab:202',
                  chromeTabId: 202,
                  windowId: 101,
                  index: 1,
                  active: false,
                  highlighted: false,
                  pinned: false,
                  title: 'Unshared',
                  url: 'https://example.com/unshared',
                  status: 'complete',
                  controlState: 'observable',
                },
              ],
            },
          ],
        },
      ],
      connectedBrowsers: 1,
      activeSessions: 2,
    });
  });

  test('reads and normalizes bounded page element inventory for a browser tab ref', async () => {
    globalThis.fetch = (async (input, init) => {
      const url = String(input);

      if (url.endsWith('/extensions/status')) {
        return new Response(JSON.stringify({
          extensions: [
            {
              extensionId: 'extension-1',
              stableKey: 'install:profile-1',
              browser: 'chrome',
              activeTargets: 0,
              playwriterVersion: '0.4.0',
              targets: [],
              browserTabs: {
                windows: [
                  {
                    windowId: 101,
                    focused: true,
                    type: 'normal',
                    state: 'normal',
                    tabs: [
                      {
                        chromeTabId: 201,
                        windowId: 101,
                        index: 0,
                        active: true,
                        highlighted: true,
                        pinned: false,
                        title: 'Docs',
                        url: 'https://example.com/docs',
                        status: 'complete',
                        controlState: 'observable',
                        shared: false,
                      },
                    ],
                  },
                ],
              },
            },
          ],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.endsWith('/extension/page-elements')) {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({
          extensionId: 'install:profile-1',
          chromeTabId: 201,
          maxElements: 2,
        });
        return new Response(JSON.stringify({
          success: true,
          chromeTabId: 201,
          frames: [
            {
              frameId: 0,
              chromeDocumentId: 'document-1',
              url: 'https://example.com/docs',
              documentRevision: 'rev-1',
              viewport: {
                width: 1280,
                height: 720,
                scrollX: 0,
                scrollY: 25,
                devicePixelRatio: 2,
                screenBounds: { x: 100, y: 140, width: 1280, height: 720 },
              },
              selectionText: 'Selected paragraph text',
              elements: [
                {
                  refId: 'browser-element:rev-1:0',
                  index: 0,
                  tagName: 'button',
                  role: 'button',
                  name: 'Save',
                  text: 'Save',
                  value: null,
                  inputType: null,
                  checked: null,
                  disabled: false,
                  editable: false,
                  clickable: true,
                  bounds: { x: 10, y: 20, width: 80, height: 32 },
                },
                {
                  refId: 'browser-element:rev-1:bad',
                  index: 1,
                  tagName: 'button',
                  role: 'button',
                  bounds: { x: 0, y: 0, width: 0, height: 0 },
                },
                {
                  refId: 'browser-element:rev-1:1',
                  index: 2,
                  tagName: 'input',
                  role: 'textbox',
                  name: 'Email',
                  text: '',
                  value: 'person@example.com',
                  inputType: 'email',
                  checked: null,
                  disabled: false,
                  editable: true,
                  clickable: true,
                  bounds: { x: 20, y: 80, width: 240, height: 28 },
                },
                {
                  refId: 'browser-element:rev-1:2',
                  index: 3,
                  tagName: 'a',
                  role: 'link',
                  name: 'More',
                  text: 'More',
                  value: null,
                  inputType: null,
                  checked: null,
                  disabled: false,
                  editable: false,
                  clickable: true,
                  bounds: { x: 30, y: 120, width: 70, height: 20 },
                },
              ],
            },
          ],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    await expect(getBrowserControlPageElementInventory({
      tabRef: 'install:profile-1:chrome-tab:201',
      maxElementsPerFrame: 2,
    })).resolves.toEqual({
      tabRef: 'install:profile-1:chrome-tab:201',
      chromeTabId: 201,
      browserProfilePolicyId: 'install:profile-1',
      origin: 'https://example.com',
      frames: [
        {
          frameId: 0,
          chromeDocumentId: 'document-1',
          url: 'https://example.com/docs',
          documentRevision: 'rev-1',
          viewport: {
            width: 1280,
            height: 720,
            scrollX: 0,
            scrollY: 25,
            devicePixelRatio: 2,
            screenBounds: { x: 100, y: 140, width: 1280, height: 720 },
          },
          selectionText: 'Selected paragraph text',
          totalElementCount: 3,
          returnedElementCount: 2,
          truncatedElementCount: 1,
          elements: [
            {
              refId: 'browser-element:rev-1:0',
              index: 0,
              tagName: 'button',
              role: 'button',
              name: 'Save',
              text: 'Save',
              value: null,
              inputType: null,
              checked: null,
              disabled: false,
              editable: false,
              clickable: true,
              bounds: { x: 10, y: 20, width: 80, height: 32 },
            },
            {
              refId: 'browser-element:rev-1:1',
              index: 2,
              tagName: 'input',
              role: 'textbox',
              name: 'Email',
              text: '',
              value: 'person@example.com',
              inputType: 'email',
              checked: null,
              disabled: false,
              editable: true,
              clickable: true,
              bounds: { x: 20, y: 80, width: 240, height: 28 },
            },
          ],
        },
      ],
    });
  });

  test('activates an observed browser tab by stable tab ref', async () => {
    globalThis.fetch = (async (input, init) => {
      const url = String(input);

      if (url.endsWith('/extensions/status')) {
        return new Response(JSON.stringify({
          extensions: [
            {
              extensionId: 'extension-1',
              stableKey: 'install:profile-1',
              browser: 'chrome',
              activeTargets: 0,
              playwriterVersion: '0.4.0',
              targets: [],
              browserTabs: {
                windows: [
                  {
                    windowId: 101,
                    focused: false,
                    type: 'normal',
                    state: 'normal',
                    tabs: [
                      {
                        chromeTabId: 201,
                        windowId: 101,
                        index: 0,
                        active: false,
                        highlighted: false,
                        pinned: false,
                        title: 'Docs',
                        url: 'https://example.com/docs',
                        status: 'complete',
                        shared: false,
                      },
                    ],
                  },
                ],
              },
            },
          ],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.endsWith('/extension/activate-tab')) {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({
          extensionId: 'install:profile-1',
          chromeTabId: 201,
          windowId: 101,
        });
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    await expect(activateBrowserControlTab({
      tabRef: 'install:profile-1:chrome-tab:201',
    })).resolves.toEqual({ success: true });
  });

  test('draws a page trace for an observed browser tab ref', async () => {
    globalThis.fetch = (async (input, init) => {
      const url = String(input);

      if (url.endsWith('/extensions/status')) {
        return new Response(JSON.stringify({
          extensions: [
            {
              extensionId: 'extension-1',
              stableKey: 'install:profile-1',
              browser: 'chrome',
              activeTargets: 0,
              playwriterVersion: '0.4.0',
              targets: [],
              browserTabs: {
                windows: [
                  {
                    windowId: 101,
                    focused: true,
                    type: 'normal',
                    state: 'normal',
                    tabs: [
                      {
                        chromeTabId: 201,
                        windowId: 101,
                        index: 0,
                        active: true,
                        highlighted: true,
                        pinned: false,
                        title: 'Docs',
                        url: 'https://example.com/docs',
                        status: 'complete',
                        shared: false,
                      },
                    ],
                  },
                ],
              },
            },
          ],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.endsWith('/extension/page-trace')) {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({
          extensionId: 'install:profile-1',
          chromeTabId: 201,
          frameId: 0,
          refId: 'browser-element:rev-1:0',
          durationMs: 1200,
        });
        return new Response(JSON.stringify({
          success: true,
          chromeTabId: 201,
          frameId: 0,
          refId: 'browser-element:rev-1:0',
          bounds: { x: 10, y: 20, width: 80, height: 32 },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    await expect(drawBrowserControlPageTrace({
      tabRef: 'install:profile-1:chrome-tab:201',
      frameId: 0,
      refId: 'browser-element:rev-1:0',
      durationMs: 1200,
    })).resolves.toEqual({
      tabRef: 'install:profile-1:chrome-tab:201',
      chromeTabId: 201,
      frameId: 0,
      refId: 'browser-element:rev-1:0',
      bounds: { x: 10, y: 20, width: 80, height: 32 },
    });
  });

  test('clicks a page element for an observed browser tab ref', async () => {
    globalThis.fetch = (async (input, init) => {
      const url = String(input);

      if (url.endsWith('/extensions/status')) {
        return new Response(JSON.stringify({
          extensions: [
            {
              extensionId: 'extension-1',
              stableKey: 'install:profile-1',
              browser: 'chrome',
              activeTargets: 0,
              playwriterVersion: '0.4.0',
              targets: [],
              browserTabs: {
                windows: [
                  {
                    windowId: 101,
                    focused: true,
                    type: 'normal',
                    state: 'normal',
                    tabs: [
                      {
                        chromeTabId: 201,
                        windowId: 101,
                        index: 0,
                        active: true,
                        highlighted: true,
                        pinned: false,
                        title: 'Docs',
                        url: 'https://example.com/docs',
                        status: 'complete',
                        shared: false,
                      },
                    ],
                  },
                ],
              },
            },
          ],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.endsWith('/extension/page-click')) {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({
          extensionId: 'install:profile-1',
          chromeTabId: 201,
          frameId: 0,
          refId: 'browser-element:rev-1:0',
          durationMs: 1200,
        });
        return new Response(JSON.stringify({
          success: true,
          chromeTabId: 201,
          frameId: 0,
          refId: 'browser-element:rev-1:0',
          bounds: { x: 10, y: 20, width: 80, height: 32 },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    await expect(clickBrowserControlPageElement({
      tabRef: 'install:profile-1:chrome-tab:201',
      frameId: 0,
      refId: 'browser-element:rev-1:0',
      durationMs: 1200,
    })).resolves.toEqual({
      tabRef: 'install:profile-1:chrome-tab:201',
      chromeTabId: 201,
      frameId: 0,
      refId: 'browser-element:rev-1:0',
      bounds: { x: 10, y: 20, width: 80, height: 32 },
    });
  });

  test('types into a page element for an observed browser tab ref', async () => {
    globalThis.fetch = (async (input, init) => {
      const url = String(input);

      if (url.endsWith('/extensions/status')) {
        return new Response(JSON.stringify({
          extensions: [
            {
              extensionId: 'extension-1',
              stableKey: 'install:profile-1',
              browser: 'chrome',
              activeTargets: 0,
              playwriterVersion: '0.4.0',
              targets: [],
              browserTabs: {
                windows: [
                  {
                    windowId: 101,
                    focused: true,
                    type: 'normal',
                    state: 'normal',
                    tabs: [
                      {
                        chromeTabId: 201,
                        windowId: 101,
                        index: 0,
                        active: true,
                        highlighted: true,
                        pinned: false,
                        title: 'Docs',
                        url: 'https://example.com/docs',
                        status: 'complete',
                        shared: false,
                      },
                    ],
                  },
                ],
              },
            },
          ],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.endsWith('/extension/page-type')) {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({
          extensionId: 'install:profile-1',
          chromeTabId: 201,
          frameId: 0,
          refId: 'browser-element:rev-1:0',
          text: 'Ada Lovelace',
          durationMs: 1200,
        });
        return new Response(JSON.stringify({
          success: true,
          chromeTabId: 201,
          frameId: 0,
          refId: 'browser-element:rev-1:0',
          value: 'Ada Lovelace',
          bounds: { x: 10, y: 20, width: 80, height: 32 },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    await expect(typeBrowserControlPageElement({
      tabRef: 'install:profile-1:chrome-tab:201',
      frameId: 0,
      refId: 'browser-element:rev-1:0',
      text: 'Ada Lovelace',
      durationMs: 1200,
    })).resolves.toEqual({
      tabRef: 'install:profile-1:chrome-tab:201',
      chromeTabId: 201,
      frameId: 0,
      refId: 'browser-element:rev-1:0',
      value: 'Ada Lovelace',
      bounds: { x: 10, y: 20, width: 80, height: 32 },
    });
  });

  test('selects a page element option for an observed browser tab ref', async () => {
    globalThis.fetch = (async (input, init) => {
      const url = String(input);

      if (url.endsWith('/extensions/status')) {
        return new Response(JSON.stringify({
          extensions: [
            {
              extensionId: 'extension-1',
              stableKey: 'install:profile-1',
              browser: 'chrome',
              activeTargets: 0,
              playwriterVersion: '0.4.0',
              targets: [],
              browserTabs: {
                windows: [
                  {
                    windowId: 101,
                    focused: true,
                    type: 'normal',
                    state: 'normal',
                    tabs: [
                      {
                        chromeTabId: 201,
                        windowId: 101,
                        index: 0,
                        active: true,
                        highlighted: true,
                        pinned: false,
                        title: 'Docs',
                        url: 'https://example.com/docs',
                        status: 'complete',
                        shared: false,
                      },
                    ],
                  },
                ],
              },
            },
          ],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.endsWith('/extension/page-select')) {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({
          extensionId: 'install:profile-1',
          chromeTabId: 201,
          frameId: 0,
          refId: 'browser-element:rev-1:0',
          value: 'operations',
          durationMs: 1200,
        });
        return new Response(JSON.stringify({
          success: true,
          chromeTabId: 201,
          frameId: 0,
          refId: 'browser-element:rev-1:0',
          value: 'operations',
          bounds: { x: 10, y: 20, width: 80, height: 32 },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    await expect(selectBrowserControlPageElement({
      tabRef: 'install:profile-1:chrome-tab:201',
      frameId: 0,
      refId: 'browser-element:rev-1:0',
      value: 'operations',
      durationMs: 1200,
    })).resolves.toEqual({
      tabRef: 'install:profile-1:chrome-tab:201',
      chromeTabId: 201,
      frameId: 0,
      refId: 'browser-element:rev-1:0',
      value: 'operations',
      bounds: { x: 10, y: 20, width: 80, height: 32 },
    });
  });

  test('scrolls a page frame for an observed browser tab ref', async () => {
    globalThis.fetch = (async (input, init) => {
      const url = String(input);

      if (url.endsWith('/extensions/status')) {
        return new Response(JSON.stringify({
          extensions: [
            {
              extensionId: 'extension-1',
              stableKey: 'install:profile-1',
              browser: 'chrome',
              activeTargets: 0,
              playwriterVersion: '0.4.0',
              targets: [],
              browserTabs: {
                windows: [
                  {
                    windowId: 101,
                    focused: true,
                    type: 'normal',
                    state: 'normal',
                    tabs: [
                      {
                        chromeTabId: 201,
                        windowId: 101,
                        index: 0,
                        active: true,
                        highlighted: true,
                        pinned: false,
                        title: 'Docs',
                        url: 'https://example.com/docs',
                        status: 'complete',
                        shared: false,
                      },
                    ],
                  },
                ],
              },
            },
          ],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.endsWith('/extension/page-scroll')) {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({
          extensionId: 'install:profile-1',
          chromeTabId: 201,
          frameId: 0,
          deltaX: 0,
          deltaY: 700,
        });
        return new Response(JSON.stringify({
          success: true,
          chromeTabId: 201,
          frameId: 0,
          scrollX: 0,
          scrollY: 700,
          viewport: { width: 1280, height: 720 },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    await expect(scrollBrowserControlPage({
      tabRef: 'install:profile-1:chrome-tab:201',
      frameId: 0,
      deltaX: 0,
      deltaY: 700,
    })).resolves.toEqual({
      tabRef: 'install:profile-1:chrome-tab:201',
      chromeTabId: 201,
      frameId: 0,
      scrollX: 0,
      scrollY: 700,
      viewport: { width: 1280, height: 720 },
    });
  });

  test('falls back to the single-extension endpoint when aggregated status is unavailable', async () => {
    globalThis.fetch = (async (input) => {
      const url = String(input);

      if (url.endsWith('/version')) {
        return new Response(JSON.stringify({ version: '2.0.0' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.endsWith('/extensions/status')) {
        return new Response('missing', { status: 404 });
      }

      if (url.endsWith('/extension/status')) {
        return new Response(JSON.stringify({
          connected: true,
          browser: 'chrome',
          activeTargets: 3,
          playwriterVersion: '0.4.0',
          targets: [
            {
              targetId: 'tab-1',
              type: 'page',
              title: 'Interpreter Docs',
              url: 'https://example.com/docs',
              shareSource: 'user',
            },
          ],
          browserTabs: {
            windows: [
              {
                windowId: 301,
                focused: false,
                type: 'normal',
                state: 'maximized',
                tabs: [
                  {
                    chromeTabId: 401,
                    windowId: 301,
                    index: 0,
                    active: true,
                    highlighted: true,
                    pinned: false,
                    title: 'Interpreter Docs',
                    url: 'https://example.com/docs',
                    status: 'complete',
                    shared: true,
                    shareState: 'connected',
                    targetId: 'tab-1',
                    sessionId: 'pw-tab-1',
                  },
                ],
              },
            ],
          },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    await expect(getBrowserControlStatus()).resolves.toMatchObject({
      relay: {
        phase: 'ready',
        version: '2.0.0',
        runtimeDir: null,
        relayLogPath: null,
        relayCdpLogPath: null,
        ownsRelayProcess: false,
        lastError: null,
        reachable: true,
        endpoint: 'http://127.0.0.1:19988',
      },
      connections: [
        {
          extensionId: 'default',
          stableKey: null,
          profileId: 'default',
          browserName: 'chrome',
          version: '0.4.0',
          activeSessions: 3,
          focusedWindowId: null,
          activeTabRef: 'default:chrome-tab:401',
          focusedWindow: null,
          activeTab: {
            tabRef: 'default:chrome-tab:401',
            chromeTabId: 401,
            windowId: 301,
            index: 0,
            active: true,
            highlighted: true,
            pinned: false,
            title: 'Interpreter Docs',
            url: 'https://example.com/docs',
            status: 'complete',
            controlState: 'controllable',
            controlStateDetail: 'connected',
            targetId: 'tab-1',
            sessionId: 'pw-tab-1',
          },
          targets: [
            {
              tabRef: 'default:tab-1',
              targetId: 'tab-1',
              type: 'page',
              title: 'Interpreter Docs',
              url: 'https://example.com/docs',
              controlSource: 'user',
            },
          ],
          browserWindows: [
            {
              windowId: 301,
              focused: false,
              type: 'normal',
              state: 'maximized',
              tabs: [
                {
                  tabRef: 'default:chrome-tab:401',
                  chromeTabId: 401,
                  windowId: 301,
                  index: 0,
                  active: true,
                  highlighted: true,
                  pinned: false,
                  title: 'Interpreter Docs',
                  url: 'https://example.com/docs',
                  status: 'complete',
                  controlState: 'controllable',
                  controlStateDetail: 'connected',
                  targetId: 'tab-1',
                  sessionId: 'pw-tab-1',
                },
              ],
            },
          ],
        },
      ],
      connectedBrowsers: 1,
      activeSessions: 3,
    });
  });
});

describe('bundled relay runtime contract', () => {
  test('requires bundled hono before treating a relay runtime as valid', () => {
    const runtimeDir = makeTempDir();

    for (const relativePath of [
      'package.json',
      'runtime-manifest.json',
      'dist/start-relay-server.js',
      'dist/extension/manifest.json',
    ]) {
      writeFile(path.join(runtimeDir, relativePath));
    }

    expect(hasRequiredRelayRuntimeLayout(runtimeDir)).toBeFalse();

    writeFile(path.join(runtimeDir, 'node_modules', 'hono', 'package.json'));

    expect(hasRequiredRelayRuntimeLayout(runtimeDir)).toBeTrue();
  });

  test('installs a bundled relay runtime into a versioned runtime dir', async () => {
    const bundledRuntimeDir = makeTempDir();
    const installRoot = makeTempDir();
    const staleVersionDir = path.join(installRoot, '0.0.1');
    mkdirSync(staleVersionDir, { recursive: true });
    writeFileSync(path.join(staleVersionDir, 'stale.txt'), 'stale');

    writeRelayBundledTree(bundledRuntimeDir, '1.2.3', {
      'dist/start-relay-server.js': 'export {};',
      'dist/extension/manifest.json': '{"manifest_version":3}',
      'node_modules/hono/package.json': '{"name":"hono"}',
    });

    const installed = await installRelayRuntimeFromBundledTree(bundledRuntimeDir, installRoot);

    expect(installed.version).toBe('1.2.3');
    expect(installed.runtimeDir).toBe(path.join(installRoot, '1.2.3'));
    expect(hasRequiredRelayRuntimeLayout(installed.runtimeDir)).toBeTrue();
    expect(readFileSync(path.join(installed.runtimeDir, 'package.json'), 'utf8')).toContain('"1.2.3"');
    expect(existsSync(staleVersionDir)).toBeFalse();

    const reused = await installRelayRuntimeFromBundledTree(bundledRuntimeDir, installRoot);
    expect(reused).toEqual(installed);
  });

  test('reinstalls a versioned runtime when the installed tree is tampered', async () => {
    const bundledRuntimeDir = makeTempDir();
    const installRoot = makeTempDir();

    writeRelayBundledTree(bundledRuntimeDir, '1.2.3', {
      'dist/start-relay-server.js': 'export const healthy = true;',
      'dist/extension/manifest.json': '{"manifest_version":3}',
      'node_modules/hono/package.json': '{"name":"hono"}',
    });

    const installed = await installRelayRuntimeFromBundledTree(bundledRuntimeDir, installRoot);
    writeFileSync(
      path.join(installed.runtimeDir, 'dist', 'start-relay-server.js'),
      'export const healthy = false;',
    );

    const reinstalled = await installRelayRuntimeFromBundledTree(bundledRuntimeDir, installRoot);

    expect(reinstalled).toEqual(installed);
    expect(
      readFileSync(path.join(installed.runtimeDir, 'dist', 'start-relay-server.js'), 'utf8'),
    ).toBe('export const healthy = true;');
  });

  test('replaces a versioned runtime when stale files remain in the installed tree', async () => {
    const bundledRuntimeDir = makeTempDir();
    const installRoot = makeTempDir();

    writeRelayBundledTree(bundledRuntimeDir, '1.2.3', {
      'dist/start-relay-server.js': 'export const healthy = true;',
      'dist/extension/manifest.json': '{"manifest_version":3}',
      'node_modules/hono/package.json': '{"name":"hono"}',
    });

    const installed = await installRelayRuntimeFromBundledTree(bundledRuntimeDir, installRoot);
    writeFile(path.join(installed.runtimeDir, 'dist', 'stale-child-entry.js'), 'stale');

    const reinstalled = await installRelayRuntimeFromBundledTree(bundledRuntimeDir, installRoot);

    expect(reinstalled).toEqual(installed);
    expect(existsSync(path.join(installed.runtimeDir, 'dist', 'stale-child-entry.js'))).toBeFalse();
    expect(hasRequiredRelayRuntimeLayout(installed.runtimeDir)).toBeTrue();
  });

  test('repairs an incomplete versioned runtime before startup', async () => {
    const bundledRuntimeDir = makeTempDir();
    const installRoot = makeTempDir();
    const incompleteRuntimeDir = path.join(installRoot, '1.2.3');

    writeRelayBundledTree(bundledRuntimeDir, '1.2.3', {
      'dist/start-relay-server.js': 'export const healthy = true;',
      'dist/extension/manifest.json': '{"manifest_version":3}',
      'node_modules/hono/package.json': '{"name":"hono"}',
    });
    writeFile(path.join(incompleteRuntimeDir, 'package.json'), '{"version":"1.2.3"}');

    const installed = await installRelayRuntimeFromBundledTree(bundledRuntimeDir, installRoot);

    expect(installed.runtimeDir).toBe(incompleteRuntimeDir);
    expect(hasRequiredRelayRuntimeLayout(incompleteRuntimeDir)).toBeTrue();
    expect(
      readFileSync(path.join(incompleteRuntimeDir, 'dist', 'start-relay-server.js'), 'utf8'),
    ).toBe('export const healthy = true;');
  });

  test('ignores stale bundled runtime-manifest.json when the bundled tree itself is intact', async () => {
    const bundledRuntimeDir = makeTempDir();
    const installRoot = makeTempDir();

    writeRelayBundledTree(
      bundledRuntimeDir,
      '1.2.3',
      {
        'dist/start-relay-server.js': 'export const healthy = true;',
        'dist/extension/manifest.json': '{"manifest_version":3}',
        'node_modules/hono/package.json': '{"name":"hono"}',
      },
      JSON.stringify({
        schemaVersion: 1,
        packageVersion: '1.2.3',
        fileCount: 999,
        totalBytes: 999,
        treeSha256: '0'.repeat(64),
      }),
    );

    const installed = await installRelayRuntimeFromBundledTree(bundledRuntimeDir, installRoot);

    expect(installed.version).toBe('1.2.3');
    expect(hasRequiredRelayRuntimeLayout(installed.runtimeDir)).toBeTrue();
    expect(
      readFileSync(path.join(installed.runtimeDir, 'dist', 'start-relay-server.js'), 'utf8'),
    ).toBe('export const healthy = true;');
  });
});
