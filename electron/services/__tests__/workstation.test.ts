import { afterEach, describe, mock, test } from 'bun:test';
import assert from 'node:assert/strict';

import { IPC_CHANNELS } from '../../ipc/registry';

const browserWindowStub = {
  fromId: (_windowId: number) => null,
  getAllWindows: () => [],
  getFocusedWindow: () => null,
};

mock.module('../workstationElectronBridge', () => ({
  BrowserWindow: browserWindowStub,
}));

const { WorkstationService } = await import('../workstation');

interface MockWindowListeners {
  'did-start-navigation'?: (_event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void;
  'did-finish-load'?: () => void;
}

const originalBrowserWindowStatics = {
  fromId: browserWindowStub.fromId,
  getAllWindows: browserWindowStub.getAllWindows,
  getFocusedWindow: browserWindowStub.getFocusedWindow,
};

function restoreBrowserWindowStatics(): void {
  Object.assign(browserWindowStub, originalBrowserWindowStatics);
}

function mockBrowserWindowStatics(overrides: Partial<typeof originalBrowserWindowStatics>): void {
  Object.assign(browserWindowStub, overrides);
}

function mockBrowserWindowRegistry(
  windows: Array<{ id: number; isDestroyed: () => boolean }>,
  options?: {
    allWindows?: Array<{ id: number; isDestroyed: () => boolean }>;
    focusedWindow?: { id: number; isDestroyed: () => boolean } | null;
  }
): void {
  const windowsById = new Map(windows.map((window) => [window.id, window]));

  mockBrowserWindowStatics({
    fromId: (windowId: number) => windowsById.get(windowId) ?? null,
    getAllWindows: () => options?.allWindows ?? windows,
    getFocusedWindow: () => options?.focusedWindow ?? null,
  });
}

function createMockWindow(windowId: number) {
  const listeners: MockWindowListeners = {};
  const sendCalls: Array<{ channel: string; payload: unknown }> = [];

  const window = {
    id: windowId,
    isDestroyed: () => false,
    webContents: {
      on: (event: keyof MockWindowListeners, listener: MockWindowListeners[keyof MockWindowListeners]) => {
        listeners[event] = listener as never;
      },
      send: (channel: string, payload: unknown) => {
        sendCalls.push({ channel, payload });
      },
    },
  };

  return { window, listeners, sendCalls };
}

afterEach(() => {
  restoreBrowserWindowStatics();
});

describe('WorkstationService readiness gating', () => {
  test('keeps queued workstation IPC gated until the renderer explicitly reports ready', () => {
    const service = new WorkstationService();
    const { window, listeners, sendCalls } = createMockWindow(1);
    mockBrowserWindowRegistry([window], { focusedWindow: window });

    service.setMainWindow(window);
    service.openFile('/tmp/startup.md');

    assert.equal(sendCalls.length, 0);
    assert.equal(typeof listeners['did-start-navigation'], 'function');
    assert.equal(listeners['did-finish-load'], undefined);

    service.markRendererReady(window.id);

    assert.deepEqual(sendCalls, [
      {
        channel: IPC_CHANNELS.WORKSTATION_OPEN_FILE,
        payload: { path: '/tmp/startup.md', page: undefined, origin: undefined },
      },
    ]);
  });

  test('queues workstation IPC again after a full navigation until the renderer re-registers listeners', () => {
    const service = new WorkstationService();
    const { window, listeners, sendCalls } = createMockWindow(1);
    mockBrowserWindowRegistry([window], { focusedWindow: window });

    service.setMainWindow(window);
    service.markRendererReady(window.id);

    service.openUrl('https://example.com', 'browser-startup');
    assert.equal(sendCalls.length, 1);

    listeners['did-start-navigation']?.({}, 'https://reload.test', false, true);
    service.toggleSidebar('left', false);

    assert.equal(sendCalls.length, 1);

    service.markRendererReady(window.id);

    assert.deepEqual(sendCalls[1], {
      channel: IPC_CHANNELS.WORKSTATION_TOGGLE_SIDEBAR,
      payload: { side: 'left', open: false },
    });
  });

  test('queues tab creation until the renderer is ready again', () => {
    const service = new WorkstationService();
    const { window, listeners, sendCalls } = createMockWindow(1);
    mockBrowserWindowRegistry([window], { focusedWindow: window });

    service.setMainWindow(window);
    service.markRendererReady(window.id);

    listeners['did-start-navigation']?.({}, 'https://reload.test', false, true);
    service.openNewTab();

    assert.equal(sendCalls.length, 0);

    service.markRendererReady(window.id);

    assert.deepEqual(sendCalls[0], {
      channel: IPC_CHANNELS.TAB_NEW,
      payload: undefined,
    });
  });

  test('targets the requested window when opening a new tab explicitly', () => {
    const service = new WorkstationService();
    const firstWindow = createMockWindow(1);
    const secondWindow = createMockWindow(2);
    mockBrowserWindowRegistry([firstWindow.window, secondWindow.window], {
      focusedWindow: firstWindow.window,
    });

    service.setMainWindow(firstWindow.window);
    service.registerWindow(secondWindow.window);
    service.markRendererReady(firstWindow.window.id);
    service.markRendererReady(secondWindow.window.id);

    service.openNewTab({ windowId: secondWindow.window.id });

    assert.equal(firstWindow.sendCalls.length, 0);
    assert.deepEqual(secondWindow.sendCalls[0], {
      channel: IPC_CHANNELS.TAB_NEW,
      payload: undefined,
    });
  });

  test('keeps the renderer ready during iframe navigations', () => {
    const service = new WorkstationService();
    const { window, listeners, sendCalls } = createMockWindow(1);
    mockBrowserWindowRegistry([window], { focusedWindow: window });

    service.setMainWindow(window);
    service.markRendererReady(window.id);

    listeners['did-start-navigation']?.({}, 'http://localhost:38123/open', false, false);
    service.sendToMainRendererWhenReady(IPC_CHANNELS.FILE_REFRESHED, { filePath: '/tmp/report.xlsx' });

    assert.deepEqual(sendCalls[0], {
      channel: IPC_CHANNELS.FILE_REFRESHED,
      payload: { filePath: '/tmp/report.xlsx' },
    });
  });

  test('does not promote non-workstation BrowserWindow instances when the primary window closes', () => {
    const service = new WorkstationService();
    const { window: mainWindow } = createMockWindow(1);
    const hiddenUtilityWindow = {
      id: 99,
      isDestroyed: () => false,
    };

    mockBrowserWindowRegistry([mainWindow, hiddenUtilityWindow], {
      allWindows: [hiddenUtilityWindow],
      focusedWindow: hiddenUtilityWindow,
    });

    service.setMainWindow(mainWindow);
    service.unregisterWindow(mainWindow.id);

    assert.equal(service.getMainWindow(), null);
  });
});
