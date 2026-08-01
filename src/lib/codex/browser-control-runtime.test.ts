import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function runtimeModuleUrl(): string {
  return pathToFileURL(path.resolve(
    process.cwd(),
    'resources',
    'js-repl-runtime',
    'node_modules',
    'interpreter-browser-control',
    'index.js',
  )).href;
}

function createPageMock(url = 'https://example.test/', targetId = 'target-default') {
  const consoleHandlers: Array<(message: any) => void> = [];
  const calls: string[] = [];
  const locator = {
    ariaSnapshot: async () => '- document',
  };
  const page = {
    calls,
    mouse: {
      click: async () => calls.push('mouse.click'),
      dblclick: async () => calls.push('mouse.dblclick'),
      move: async () => calls.push('mouse.move'),
      down: async () => calls.push('mouse.down'),
      up: async () => calls.push('mouse.up'),
      wheel: async () => calls.push('mouse.wheel'),
    },
    keyboard: {
      down: async () => calls.push('keyboard.down'),
      up: async () => calls.push('keyboard.up'),
      press: async () => calls.push('keyboard.press'),
      type: async () => calls.push('keyboard.type'),
    },
    on: (event: string, handler: (message: any) => void) => {
      if (event === 'console') {
        consoleHandlers.push(handler);
      }
    },
    emitConsole: (message: any) => {
      for (const handler of consoleHandlers) {
        handler(message);
      }
    },
    targetId: () => targetId,
    url: () => url,
    title: async () => 'Example',
    goto: async () => calls.push('goto'),
    reload: async () => calls.push('reload'),
    goBack: async () => calls.push('back'),
    goForward: async () => calls.push('forward'),
    close: async () => calls.push('close'),
    locator: () => locator,
    frameLocator: () => 'frame-locator',
    getByLabel: () => 'label-locator',
    getByPlaceholder: () => 'placeholder-locator',
    getByRole: () => 'role-locator',
    getByTestId: () => 'testid-locator',
    getByText: () => 'text-locator',
    screenshot: async () => Buffer.from('image'),
    waitForLoadState: async () => calls.push('waitForLoadState'),
    waitForTimeout: async () => calls.push('waitForTimeout'),
    waitForURL: async () => calls.push('waitForURL'),
    evaluate: async () => '',
  };
  return page;
}

describe('interpreter-browser-control runtime', () => {
  test('installs Browser Use-shaped globals and raw Playwright handles', async () => {
    const { setupInterpreterBrowserControl } = await import(`${runtimeModuleUrl()}?test=${Date.now()}`);
    const globals: any = {
      console,
      selectedBrowserSessionId: 'session-a',
    };

    const runtime = await setupInterpreterBrowserControl({ globals });
    const page = createPageMock('https://example.test/', 'target-1');
    runtime.ensureContext = async () => ({
      pages: () => [page],
      newPage: async () => page,
    });

    globals.page = await globals.ensurePage();
    globals.tab = await globals.agent.browser.tabs.selected();

    expect(globals.agent.browser.tabs.list).toBeFunction();
    expect(globals.agent.browser.user.openTabs).toBeFunction();
    expect(globals.tab.playwright.domSnapshot).toBeFunction();
    expect(globals.tab.cua.get_visible_screenshot).toBeFunction();
    expect(globals.playwright.chromium).toBe(globals.chromium);
    expect(await globals.tab.playwright.domSnapshot()).toBe('- document');
    expect(await globals.agent.browser.tabs.list()).toEqual([
      { id: 'page-1', title: 'Example', url: 'https://example.test/' },
    ]);
  });

  test('captures console logs through tab.dev.logs', async () => {
    const { setupInterpreterBrowserControl } = await import(`${runtimeModuleUrl()}?test=${Date.now()}`);
    const globals: any = { console };
    const runtime = await setupInterpreterBrowserControl({ globals, sessionId: 'session-a' });
    const page = createPageMock('https://example.test/', 'target-1');
    runtime.ensureContext = async () => ({ pages: () => [page] });

    const tab = await globals.agent.browser.tabs.selected();
    page.emitConsole({
      type: () => 'error',
      text: () => 'failed',
      location: () => ({ url: 'https://example.test/script.js' }),
    });

    expect(await tab.dev.logs({ levels: ['error'] })).toMatchObject([
      {
        level: 'error',
        message: 'failed',
        url: 'https://example.test/script.js',
      },
    ]);
  });

  test('normalizes workstation browser tab ids before connecting over CDP', async () => {
    const { setupInterpreterBrowserControl } = await import(`${runtimeModuleUrl()}?test=${Date.now()}`);
    const globals: any = {
      console,
      selectedBrowserSessionId: 'install:install-1:target-1',
    };
    const runtime: any = await setupInterpreterBrowserControl({ globals });
    const page = createPageMock('https://example.test/', 'target-1');
    let cdpUrl = '';

    runtime.status = async () => ({
      extensions: [
        {
          extensionId: 'ext-1',
          stableKey: 'install:install-1',
          targets: [{ tabRef: 'install:install-1:target-1', targetId: 'target-1', type: 'page', title: 'Example', url: 'https://example.test/' }],
        },
      ],
    });
    runtime.importChromium = async () => ({
      connectOverCDP: async (url: string) => {
        cdpUrl = url;
        return {
          isConnected: () => true,
          contexts: () => [{ pages: () => [page] }],
        };
      },
    });
    runtime.browser = undefined;
    runtime.context = undefined;

    await runtime.ensurePage();

    expect(globals.selectedBrowserSessionId).toBe('install:install-1');
    expect(cdpUrl).toContain('extensionId=install%3Ainstall-1');
    expect(cdpUrl).not.toContain('target-1');
  });

  test('resolves chrome-tab refs and selects the matching controllable Playwright page', async () => {
    const { setupInterpreterBrowserControl } = await import(`${runtimeModuleUrl()}?test=${Date.now()}`);
    const globals: any = {
      console,
      selectedBrowserSessionId: 'install:install-1:chrome-tab:201',
    };
    const runtime: any = await setupInterpreterBrowserControl({ globals });
    const requestedPage = createPageMock('https://example.test/requested', 'target-1');
    const otherPage = createPageMock('https://example.test/other', 'target-2');
    let cdpUrl = '';

    runtime.status = async () => ({
      extensions: [
        {
          extensionId: 'ext-1',
          stableKey: 'install:install-1',
          targets: [
            { targetId: 'target-1', type: 'page', title: 'Requested', url: 'https://example.test/requested' },
            { targetId: 'target-2', type: 'page', title: 'Other', url: 'https://example.test/other' },
          ],
          browserTabs: {
            windows: [
              {
                tabs: [
                  {
                    chromeTabId: 201,
                    url: 'https://example.test/requested',
                    targetId: 'target-1',
                  },
                ],
              },
            ],
          },
        },
      ],
    });
    runtime.importChromium = async () => ({
      connectOverCDP: async (url: string) => {
        cdpUrl = url;
        return {
          isConnected: () => true,
          contexts: () => [{ pages: () => [otherPage, requestedPage] }],
        };
      },
    });
    runtime.browser = undefined;
    runtime.context = undefined;

    await expect(runtime.ensurePage()).resolves.toBe(requestedPage);

    expect(globals.selectedBrowserSessionId).toBe('install:install-1');
    expect(globals.selectedBrowserTargetId).toBe('target-1');
    expect(cdpUrl).toContain('extensionId=install%3Ainstall-1');
    expect(cdpUrl).not.toContain('chrome-tab');
  });

  test('claims observable chrome-tab refs before selecting the matching Playwright page', async () => {
    const { setupInterpreterBrowserControl } = await import(`${runtimeModuleUrl()}?test=${Date.now()}`);
    const globals: any = {
      console,
      selectedBrowserSessionId: 'install:install-1:chrome-tab:201',
    };
    const runtime: any = await setupInterpreterBrowserControl({ globals });
    const requestedPage = createPageMock('https://example.test/requested', 'target-1');
    const claimCalls: Array<{ sessionId: string; chromeTabId: number; url?: string }> = [];
    let statusCalls = 0;
    let cdpUrl = '';

    runtime.status = async () => {
      statusCalls += 1;
      const targetId = statusCalls === 1 ? undefined : 'target-1';
      return {
        extensions: [
          {
            extensionId: 'ext-1',
            stableKey: 'install:install-1',
            targets: targetId
              ? [{ targetId, type: 'page', title: 'Requested', url: 'https://example.test/requested' }]
              : [],
            browserTabs: {
              windows: [
                {
                  tabs: [
                    {
                      chromeTabId: 201,
                      url: 'https://example.test/requested',
                      ...(targetId ? { targetId } : {}),
                    },
                  ],
                },
              ],
            },
          },
        ],
      };
    };
    runtime.claimBrowserTab = async (selection: { sessionId: string; chromeTabId: number; url?: string }) => {
      claimCalls.push(selection);
    };
    runtime.importChromium = async () => ({
      connectOverCDP: async (url: string) => {
        cdpUrl = url;
        return {
          isConnected: () => true,
          contexts: () => [{ pages: () => [requestedPage] }],
        };
      },
    });
    runtime.browser = undefined;
    runtime.context = undefined;

    await expect(runtime.ensurePage()).resolves.toBe(requestedPage);

    expect(claimCalls).toEqual([{
      sessionId: 'install:install-1',
      chromeTabId: 201,
      url: 'https://example.test/requested',
    }]);
    expect(globals.selectedBrowserSessionId).toBe('install:install-1');
    expect(globals.selectedBrowserTargetId).toBe('target-1');
    expect(cdpUrl).toContain('extensionId=install%3Ainstall-1');
  });

  test('fails loudly when a requested chrome-tab ref is not controllable through Playwright', async () => {
    const { setupInterpreterBrowserControl } = await import(`${runtimeModuleUrl()}?test=${Date.now()}`);
    const globals: any = {
      console,
      selectedBrowserSessionId: 'install:install-1:chrome-tab:201',
    };
    const runtime: any = await setupInterpreterBrowserControl({ globals });
    const otherPage = createPageMock('https://example.test/other', 'target-2');

    runtime.status = async () => ({
      extensions: [
        {
          extensionId: 'ext-1',
          stableKey: 'install:install-1',
          targets: [
            { targetId: 'target-2', type: 'page', title: 'Other', url: 'https://example.test/other' },
          ],
          browserTabs: {
            windows: [
              {
                tabs: [
                  {
                    chromeTabId: 201,
                    url: 'https://example.test/requested',
                  },
                ],
              },
            ],
          },
        },
      ],
    });
    runtime.importChromium = async () => ({
      connectOverCDP: async () => ({
        isConnected: () => true,
        contexts: () => [{ pages: () => [otherPage] }],
      }),
    });
    runtime.claimBrowserTab = async () => {};
    runtime.browser = undefined;
    runtime.context = undefined;

    await expect(runtime.ensurePage()).rejects.toThrow(
      'the requested tab is not controllable through Playwright',
    );
  });
});
