import { describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  APP_LIFECYCLE_EVENT_NAMES,
  registerElectronAppLifecycle,
  type ElectronAppLifecycleDependencies,
} from './electron-lifecycle';

class FakeApp extends EventEmitter {
  public packaged = false;
  public ready = false;
  public name = 'Interpreter';
  public version = '1.2.3';
  public quitCalls = 0;
  public exitCodes: number[] = [];

  isPackaged = this.packaged;

  isReady(): boolean {
    return this.ready;
  }

  getName(): string {
    return this.name;
  }

  getVersion(): string {
    return this.version;
  }

  quit(): void {
    this.quitCalls += 1;
  }

  exit(code: number): void {
    this.exitCodes.push(code);
  }
}

type FakeWindow = {
  id: number;
  destroyed?: boolean;
  visible?: boolean;
  focused?: boolean;
  minimized?: boolean;
  title?: string;
  url?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  osProcessId?: number;
  type?: string;
  isDestroyed(): boolean;
  isVisible(): boolean;
  isFocused(): boolean;
  isMinimized(): boolean;
  getTitle(): string;
  getBounds(): { x: number; y: number; width: number; height: number };
  webContents: {
    id: number;
    isDestroyed(): boolean;
    mainFrame: {
      frameToken: string;
      frameTreeNodeId: number;
      name: string;
      origin: string;
      osProcessId: number;
      processId: number;
      routingId: number;
      url: string;
    };
    getType(): string;
    getTitle(): string;
    getURL(): string;
    getOSProcessId(): number;
  };
};

function createFakeWindow(id: number, overrides: Partial<FakeWindow> = {}): FakeWindow {
  const url = overrides.url ?? `https://example.com/window-${id}`;
  const title = overrides.title ?? `Window ${id}`;
  const bounds = overrides.bounds ?? { x: 10, y: 20, width: 1280, height: 720 };
  const focused = overrides.focused ?? false;
  const visible = overrides.visible ?? true;
  const minimized = overrides.minimized ?? false;
  const destroyed = overrides.destroyed ?? false;
  const osProcessId = overrides.osProcessId ?? 9000 + id;
  const type = overrides.type ?? 'window';

  return {
    id,
    destroyed,
    visible,
    focused,
    minimized,
    title,
    url,
    bounds,
    osProcessId,
    type,
    isDestroyed: () => destroyed,
    isVisible: () => visible,
    isFocused: () => focused,
    isMinimized: () => minimized,
    getTitle: () => title,
    getBounds: () => bounds,
    webContents: {
      id: 1000 + id,
      isDestroyed: () => destroyed,
      mainFrame: {
        frameToken: `frame-token-${id}`,
        frameTreeNodeId: 7000 + id,
        name: `main-frame-${id}`,
        origin: 'https://example.com',
        osProcessId,
        processId: 8000 + id,
        routingId: 6000 + id,
        url,
      },
      getType: () => type,
      getTitle: () => `${title} WebContents`,
      getURL: () => url,
      getOSProcessId: () => osProcessId,
    },
  };
}

function createDependencies(
  overrides: Partial<ElectronAppLifecycleDependencies> = {},
): {
  app: FakeApp;
  breadcrumbs: Array<Record<string, unknown>>;
  cleanup: ReturnType<typeof mock>;
  createWindow: ReturnType<typeof mock>;
  handleDeepLink: ReturnType<typeof mock>;
  handleExternalAskPaths: ReturnType<typeof mock>;
  handleExternalOpenPath: ReturnType<typeof mock>;
  noteAppChildProcessGone: ReturnType<typeof mock>;
  noteMainWindowRendererGone: ReturnType<typeof mock>;
  noteSecondInstanceHandoff: ReturnType<typeof mock>;
  showMainWindow: ReturnType<typeof mock>;
  deps: ElectronAppLifecycleDependencies;
  mainWindow: FakeWindow;
  focusedWindow: FakeWindow;
} {
  const app = new FakeApp();
  const breadcrumbs: Array<Record<string, unknown>> = [];
  const cleanup = mock(async () => {});
  const createWindowMock = mock(async () => {});
  const handleDeepLink = mock(() => {});
  const handleExternalAskPaths = mock(async () => {});
  const handleExternalOpenPath = mock(async () => {});
  const noteAppChildProcessGone = mock(() => {});
  const noteMainWindowRendererGone = mock(async () => {});
  const noteSecondInstanceHandoff = mock(() => {});
  const showMainWindow = mock(() => {});
  const mainWindow = createFakeWindow(1, { focused: true, title: 'Main Window' });
  const focusedWindow = mainWindow;

  const deps: ElectronAppLifecycleDependencies = {
    app,
    addBreadcrumb: (breadcrumb) => {
      breadcrumbs.push(breadcrumb as Record<string, unknown>);
    },
    canHandleActivate: () => true,
    cleanup,
    createWindow: createWindowMock,
    customProtocol: 'workstation',
    findExternalAskTargetsInArgv: (argv) => {
      const askIndex = argv.indexOf('--ask');
      return askIndex === -1 ? [] : argv.slice(askIndex + 1);
    },
    findExternalOpenTargetInArgv: (argv) => {
      const target = argv.find((value) => value.startsWith('/'));
      return target ? { kind: 'file', path: target } : null;
    },
    getAllWindows: () => [mainWindow],
    getFocusedWindow: () => focusedWindow,
    getMainWindow: () => mainWindow,
    getMainWindowLaunchState: () => null,
    getQuitState: () => ({
      appReady: true,
      isQuitting: false,
      isUpdating: false,
    }),
    getUserSuppliedArgv: (argv) => argv.slice(1),
    handleDeepLink,
    handleExternalAskPaths,
    handleExternalOpenPath,
    isOverlayVisible: () => false,
    logger: console,
    noteAppChildProcessGone,
    noteMainWindowRendererGone,
    noteSecondInstanceHandoff,
    shouldQuitWhenAllWindowsClosed: () => false,
    shouldTrackOoEditorsMainRendererGone: () => false,
    showMainWindow,
    ...overrides,
  };

  return {
    app,
    breadcrumbs,
    cleanup,
    createWindow: createWindowMock,
    handleExternalAskPaths,
    handleDeepLink,
    handleExternalOpenPath,
    noteAppChildProcessGone,
    noteMainWindowRendererGone,
    noteSecondInstanceHandoff,
    showMainWindow,
    deps,
    mainWindow,
    focusedWindow,
  };
}

describe('registerElectronAppLifecycle', () => {
  test('registers every event in APP_LIFECYCLE_EVENT_NAMES', () => {
    const { app, deps } = createDependencies();

    registerElectronAppLifecycle(deps);

    expect(app.eventNames().sort()).toEqual([...APP_LIFECYCLE_EVENT_NAMES].sort());
  });

  test('matches the Electron App.on() event surface shipped in node_modules', () => {
    const electronTypesPath = path.join(process.cwd(), 'node_modules/electron/electron.d.ts');
    const electronTypes = readFileSync(electronTypesPath, 'utf8');
    const appBlockMatch = electronTypes.match(
      /interface App extends NodeJS\.EventEmitter \{([\s\S]*?)^\s{2}interface /m,
    );

    if (!appBlockMatch?.[1]) {
      throw new Error('Failed to locate Electron App interface in node_modules/electron/electron.d.ts');
    }

    const eventNames = [...appBlockMatch[1].matchAll(/on\(event: '([^']+)'/g)]
      .map((match) => match[1])
      .sort();

    expect(eventNames).toEqual([...APP_LIFECYCLE_EVENT_NAMES].sort());
  });

  test('records rich second-instance breadcrumbs and routes deep links plus external opens', async () => {
    const {
      app,
      breadcrumbs,
      deps,
      handleDeepLink,
      handleExternalOpenPath,
      noteSecondInstanceHandoff,
      showMainWindow,
    } = createDependencies();

    registerElectronAppLifecycle(deps);

    app.emit(
      'second-instance',
      { defaultPrevented: false },
      ['electron', 'app', 'workstation://auth/callback?code=secret', '/tmp/report.md'],
      '/tmp',
      { source: 'shell' },
    );

    expect(noteSecondInstanceHandoff).toHaveBeenCalledTimes(1);
    expect(handleDeepLink).toHaveBeenCalledWith('workstation://auth/callback?code=secret');
    expect(handleExternalOpenPath).toHaveBeenCalledWith('/tmp/report.md');
    expect(showMainWindow).not.toHaveBeenCalled();
    expect(breadcrumbs.at(-1)).toMatchObject({
      category: 'app.lifecycle',
      message: 'second-instance',
      level: 'info',
    });
    expect((breadcrumbs.at(-1)?.data as Record<string, unknown>)?.workingDirectory).toBe('/tmp');
    expect((breadcrumbs.at(-1)?.data as Record<string, unknown>)?.deepLink).toMatchObject({
      protocol: 'workstation:',
      pathname: '/callback',
      searchKeys: ['code'],
    });
    expect((breadcrumbs.at(-1)?.data as Record<string, unknown>)?.externalOpenTarget).toEqual({
      kind: 'file',
      path: '/tmp/report.md',
    });
  });

  test('routes second-instance ask requests without also opening the first file', async () => {
    const {
      app,
      breadcrumbs,
      deps,
      handleExternalAskPaths,
      handleExternalOpenPath,
      showMainWindow,
    } = createDependencies();

    registerElectronAppLifecycle(deps);

    app.emit(
      'second-instance',
      { defaultPrevented: false },
      ['electron', 'app', '--ask', '/tmp/a.txt', '/tmp/b.txt'],
      '/tmp',
      { source: 'shell' },
    );

    expect(handleExternalAskPaths).toHaveBeenCalledWith(['/tmp/a.txt', '/tmp/b.txt']);
    expect(handleExternalOpenPath).not.toHaveBeenCalled();
    expect(showMainWindow).not.toHaveBeenCalled();
    expect((breadcrumbs.at(-1)?.data as Record<string, unknown>)?.externalAskTargetCount).toBe(2);
  });

  test('does not create a window from activate before startup is ready', async () => {
    const { app, breadcrumbs, createWindow, deps, showMainWindow } = createDependencies({
      canHandleActivate: () => false,
    });

    registerElectronAppLifecycle(deps);

    app.emit('activate', { defaultPrevented: false }, false);
    await Promise.resolve();

    expect(createWindow).not.toHaveBeenCalled();
    expect(showMainWindow).not.toHaveBeenCalled();
    expect(breadcrumbs.at(-1)).toMatchObject({
      category: 'app.lifecycle',
      message: 'activate',
      data: {
        canHandleActivate: false,
        hasVisibleWindows: false,
      },
    });
  });

  test('prevents default and performs cleanup on before-quit when app is active', async () => {
    const { app, breadcrumbs, cleanup, deps } = createDependencies();
    const preventDefault = mock(() => {});

    registerElectronAppLifecycle(deps);

    app.emit('before-quit', {
      defaultPrevented: false,
      preventDefault,
    });
    await Promise.resolve();

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(app.quitCalls).toBe(1);
    expect(app.exitCodes).toEqual([]);
    expect(breadcrumbs.at(-2)).toMatchObject({
      category: 'app.lifecycle',
      message: 'before-quit',
    });
    expect(breadcrumbs.at(-1)).toMatchObject({
      category: 'app.lifecycle',
      message: 'app.quit',
      data: {
        sourceEvent: 'before-quit',
      },
    });
  });

  test('prevents default and performs cleanup on will-quit when app is active', async () => {
    const { app, breadcrumbs, cleanup, deps } = createDependencies();
    const preventDefault = mock(() => {});

    registerElectronAppLifecycle(deps);

    app.emit('will-quit', {
      defaultPrevented: false,
      preventDefault,
    });
    await Promise.resolve();

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(app.quitCalls).toBe(1);
    expect(app.exitCodes).toEqual([]);
    expect(breadcrumbs.at(-2)).toMatchObject({
      category: 'app.lifecycle',
      message: 'will-quit',
    });
    expect(breadcrumbs.at(-1)).toMatchObject({
      category: 'app.lifecycle',
      message: 'app.quit',
      data: {
        sourceEvent: 'will-quit',
      },
    });
  });

  test('tracks non-clean child process exits and raises warning breadcrumbs', () => {
    const { app, breadcrumbs, deps, noteAppChildProcessGone } = createDependencies();

    registerElectronAppLifecycle(deps);

    app.emit('child-process-gone', { defaultPrevented: false }, {
      type: 'Utility',
      reason: 'crashed',
      exitCode: 99,
      name: 'oo-editors',
      serviceName: 'OfficeExtension',
    });

    expect(noteAppChildProcessGone).toHaveBeenCalledTimes(1);
    expect(breadcrumbs.at(-1)).toMatchObject({
      category: 'app.lifecycle',
      message: 'child-process-gone',
      level: 'warning',
      data: {
        exitCode: 99,
        name: 'oo-editors',
        reason: 'crashed',
        serviceName: 'OfficeExtension',
        type: 'Utility',
      },
    });
  });

  test('does not flag clean child process exits for oo-editors suppression', () => {
    const { app, deps, noteAppChildProcessGone } = createDependencies();

    registerElectronAppLifecycle(deps);

    app.emit('child-process-gone', { defaultPrevented: false }, {
      type: 'Utility',
      reason: 'clean-exit',
      exitCode: 0,
      name: 'oo-editors',
      serviceName: 'OfficeExtension',
    });

    expect(noteAppChildProcessGone).not.toHaveBeenCalled();
  });

  test('captures main window launch state for render launch failures', async () => {
    const mainWindowLaunchState = {
      currentUrl: 'http://127.0.0.1:5177',
      lastEvent: 'did-start-loading',
      loadTarget: 'built-server-url',
      sessionKey: 'ws_test123',
      updatedAt: '2026-04-13T12:00:00.000Z',
      webContentsId: 1001,
      windowId: 1,
    };
    const { app, breadcrumbs, deps, noteMainWindowRendererGone } = createDependencies({
      getMainWindowLaunchState: () => mainWindowLaunchState,
      shouldTrackOoEditorsMainRendererGone: () => true,
    });

    registerElectronAppLifecycle(deps);

    app.emit('render-process-gone', { defaultPrevented: false }, deps.getMainWindow()!.webContents, {
      exitCode: 63,
      reason: 'launch-failed',
    });
    await Promise.resolve();

    expect(noteMainWindowRendererGone).toHaveBeenCalledTimes(1);
    expect(breadcrumbs.at(-1)).toMatchObject({
      category: 'app.lifecycle',
      message: 'render-process-gone',
      level: 'warning',
      data: {
        exitCode: 63,
        isMainWindowProcess: true,
        mainWindowLaunchState,
        reason: 'launch-failed',
        webContents: {
          mainFrame: {
            detached: null,
            frameToken: 'frame-token-1',
            frameTreeNodeId: 7001,
            name: 'main-frame-1',
            origin: 'https://example.com',
            osProcessId: 9001,
            processId: 8001,
            routingId: 6001,
            url: {
              displayUrl: 'https://example.com/window-1',
              hasHash: false,
              hasPassword: false,
              hasUsername: false,
              host: 'example.com',
              pathname: '/window-1',
              protocol: 'https:',
              searchKeys: [],
            },
            visibilityState: null,
          },
        },
      },
    });
  });

  test('handles disposed mainFrame getters during render-process-gone serialization', () => {
    const { app, breadcrumbs, deps } = createDependencies();
    const webContents = deps.getMainWindow()!.webContents as Record<string, unknown>;

    Object.defineProperty(webContents, 'mainFrame', {
      configurable: true,
      get: () => {
        throw new Error('Render frame was disposed before WebFrameMain could be accessed');
      },
    });

    registerElectronAppLifecycle(deps);

    expect(() => {
      app.emit('render-process-gone', { defaultPrevented: false }, webContents, {
        exitCode: 9,
        reason: 'killed',
      });
    }).not.toThrow();

    expect(breadcrumbs.at(-1)).toMatchObject({
      category: 'app.lifecycle',
      message: 'render-process-gone',
      data: {
        webContents: {
          mainFrame: null,
        },
      },
    });
  });

  test('handles disposed WebFrameMain property getters during render-process-gone serialization', () => {
    const { app, breadcrumbs, deps } = createDependencies();
    const webContents = deps.getMainWindow()!.webContents;
    const mainFrame = webContents.mainFrame as Record<string, unknown>;
    const disposedFrameError = new Error('Render frame was disposed before WebFrameMain could be accessed');

    for (const property of [
      'detached',
      'frameToken',
      'frameTreeNodeId',
      'name',
      'origin',
      'osProcessId',
      'processId',
      'routingId',
      'url',
      'visibilityState',
    ]) {
      Object.defineProperty(mainFrame, property, {
        configurable: true,
        get: () => {
          throw disposedFrameError;
        },
      });
    }

    registerElectronAppLifecycle(deps);

    expect(() => {
      app.emit('render-process-gone', { defaultPrevented: false }, webContents, {
        exitCode: 9,
        reason: 'oom',
      });
    }).not.toThrow();

    expect(breadcrumbs.at(-1)).toMatchObject({
      category: 'app.lifecycle',
      message: 'render-process-gone',
      data: {
        webContents: {
          mainFrame: {
            detached: null,
            frameToken: null,
            frameTreeNodeId: null,
            name: null,
            origin: null,
            osProcessId: null,
            processId: null,
            routingId: null,
            url: null,
            visibilityState: null,
          },
        },
      },
    });
  });


  test('logs structured details for non-clean child process exits', () => {
    const loggerError = mock(() => {});
    const { app, deps } = createDependencies({
      logger: { ...console, error: loggerError },
    });

    registerElectronAppLifecycle(deps);

    app.emit('child-process-gone', { defaultPrevented: false }, {
      type: 'Utility',
      reason: 'crashed',
      exitCode: 99,
      name: 'oo-editors',
      serviceName: 'OfficeExtension',
    });

    expect(loggerError).toHaveBeenCalledWith('[AppLifecycle] child-process-gone', {
      exitCode: 99,
      name: 'oo-editors',
      reason: 'crashed',
      serviceName: 'OfficeExtension',
      type: 'Utility',
    });
  });

  test('quits on window-all-closed when configured to do so', () => {
    const { app, breadcrumbs, deps } = createDependencies({
      shouldQuitWhenAllWindowsClosed: () => true,
    });

    registerElectronAppLifecycle(deps);
    app.emit('window-all-closed');

    expect(app.quitCalls).toBe(1);
    expect(breadcrumbs.at(-2)).toMatchObject({
      message: 'window-all-closed',
    });
    expect(breadcrumbs.at(-1)).toMatchObject({
      message: 'app.quit',
      data: {
        sourceEvent: 'window-all-closed',
      },
    });
  });
});
