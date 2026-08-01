import { describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';

const display = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1200, height: 800 },
};

class FakeWebContents extends EventEmitter {
  destroyed = false;
  loading = false;

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isLoading(): boolean {
    return this.loading;
  }

  getURL(): string {
    return 'file:///overlay.html';
  }

  focus(): void {}

  send(): void {}

  paste(): void {}

  selectAll(): void {}

  sendInputEvent(): void {}
}

class FakeBrowserWindow extends EventEmitter {
  destroyed = false;
  visible = false;
  bounds: Electron.Rectangle = display.bounds;
  focusable = true;
  ignoreMouseEvents: { ignore: boolean; options?: { forward?: boolean } } | null = null;
  opacity = 1;
  webContents = new FakeWebContents();

  setContentProtection(): void {}

  setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void {
    this.ignoreMouseEvents = { ignore, options };
  }

  setVisibleOnAllWorkspaces(): void {}

  setAlwaysOnTop(): void {}

  setBounds(bounds: Electron.Rectangle): void {
    this.bounds = bounds;
  }

  getBounds(): Electron.Rectangle {
    return this.bounds;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isVisible(): boolean {
    return this.visible;
  }

  isFocusable(): boolean {
    return this.focusable;
  }

  setFocusable(focusable: boolean): void {
    this.focusable = focusable;
  }

  showInactive(): void {
    this.visible = true;
  }

  moveTop(): void {}

  focus(): void {}

  hide(): void {
    this.visible = false;
  }

  close(): void {
    this.destroy();
  }

  destroy(): void {
    this.destroyed = true;
    this.emit('closed');
  }

  getOpacity(): number {
    return this.opacity;
  }

  setOpacity(opacity: number): void {
    this.opacity = opacity;
  }

  loadFile(): Promise<void> {
    return Promise.resolve();
  }

  loadURL(): Promise<void> {
    return Promise.resolve();
  }
}

mock.module('./electron-bridge.js', () => ({
  app: {
    focus: mock(),
    isPackaged: true,
  },
  BrowserWindow: FakeBrowserWindow,
  clipboard: {
    writeText: mock(),
  },
  ipcMain: {
    on: mock(),
  },
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => display,
    getPrimaryDisplay: () => display,
  },
}));

mock.module('electron', () => ({
  app: {
    focus: mock(),
    isPackaged: true,
  },
  BrowserWindow: FakeBrowserWindow,
  clipboard: {
    writeText: mock(),
  },
  ipcMain: {
    on: mock(),
  },
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => display,
    getPrimaryDisplay: () => display,
  },
}));

mock.module('./world-overlay-window.js', () => ({
  WorldOverlayWindow: class {
    destroy(): void {}
    setOpacity(): void {}
    prepareOnDisplay(): void {}
    pinTo(): boolean { return false; }
    unpin(): void {}
    getDebugSnapshot(): Record<string, never> { return {}; }
    send(): void {}
    setTargetMovedListener(): void {}
  },
}));

const { OverlayWindow } = await import('./overlay-window');

describe('OverlayWindow', () => {
  test('created window starts click-through', () => {
    const overlay = new OverlayWindow();
    const window = overlay.create() as unknown as FakeBrowserWindow;

    expect(window.ignoreMouseEvents).toEqual({ ignore: true, options: undefined });
  });

  test('discards a dead renderer window and reports non-clean exits', () => {
    const rendererGoneDetails = {
      exitCode: -536870904,
      reason: 'oom',
    } as Electron.RenderProcessGoneDetails;
    const handledDetails: Electron.RenderProcessGoneDetails[] = [];
    const overlay = new OverlayWindow((details) => handledDetails.push(details));

    const firstWindow = overlay.create() as unknown as FakeBrowserWindow;
    firstWindow.webContents.emit('render-process-gone', {}, rendererGoneDetails);

    expect(firstWindow.destroyed).toBe(true);
    expect(overlay.isDestroyed()).toBe(true);
    expect(handledDetails).toEqual([rendererGoneDetails]);

    const secondWindow = overlay.create() as unknown as FakeBrowserWindow;
    expect(secondWindow).not.toBe(firstWindow);
  });

  test('does not report clean renderer exits for recovery', () => {
    const rendererGoneDetails = {
      exitCode: 0,
      reason: 'clean-exit',
    } as Electron.RenderProcessGoneDetails;
    const onRendererGone = mock();
    const overlay = new OverlayWindow(onRendererGone);

    const window = overlay.create() as unknown as FakeBrowserWindow;
    window.webContents.emit('render-process-gone', {}, rendererGoneDetails);

    expect(window.destroyed).toBe(true);
    expect(onRendererGone).not.toHaveBeenCalled();
  });

  test('hide keeps macOS renderer prewarmed at zero opacity', () => {
    if (process.platform !== 'darwin') {
      return;
    }

    const overlay = new OverlayWindow();
    const window = overlay.create() as unknown as FakeBrowserWindow;

    overlay.hide();

    expect(window.visible).toBe(true);
    expect(window.focusable).toBe(false);
    expect(window.opacity).toBe(0);
    expect(window.ignoreMouseEvents).toEqual({ ignore: true, options: { forward: true } });
    expect(window.bounds).toEqual(display.bounds);
  });

  test('disabled mouse events keep forwarded movement for renderer hover hit testing', () => {
    const overlay = new OverlayWindow();
    const window = overlay.create() as unknown as FakeBrowserWindow;

    overlay.disableMouseEvents();

    expect(window.ignoreMouseEvents).toEqual({ ignore: true, options: { forward: true } });
  });
});
