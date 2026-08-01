import path from 'node:path';
import { INTERPRETER_OVERLAY_CHANNELS as CHANNELS } from './channels.js';
import { app, BrowserWindow, ipcMain, screen } from './electron-bridge.js';
import { WorldOverlayWindow, type WorldPinTarget } from './world-overlay-window.js';

export type OverlayMode = 'production' | 'debug';
export type OverlayRendererGoneHandler = (details: Electron.RenderProcessGoneDetails) => void;

const useBuiltRenderer = process.env.INTERPRETER_USE_BUILT_RENDERER === 'true';
const isDev = !app.isPackaged && process.env.NODE_ENV !== 'test' && !useBuiltRenderer;
const shouldProtectOverlayContent = process.env.FORM_TESTS_MODE !== 'true';

function getOverlayPreloadPath(): string {
  return path.join(__dirname, '..', 'apps', 'interpreter-overlay', 'renderer', 'preload.cjs');
}

function getOverlayHtmlPath(mode: OverlayMode): string {
  const htmlFileName = mode === 'debug' ? 'debug.html' : 'overlay.html';
  return path.join(__dirname, '..', '..', 'dist', 'apps', 'interpreter-overlay', 'renderer', htmlFileName);
}

function getOverlayDevUrl(): string {
  const vitePort = process.env.VITE_PORT || '5173';
  return `http://localhost:${vitePort}/apps/interpreter-overlay/renderer/overlay.html`;
}

export class OverlayWindow {
  private captureSuppressionDepth = 0;
  private captureRestoreOpacity: number | null = null;
  private captureRestoreVisible = false;
  private captureRestoreBounds: Electron.Rectangle | null = null;
  private captureRestoreShouldRemainVisible = false;
  private win: BrowserWindow | null = null;
  private isReady = false;
  private currentDisplay: Electron.Display | null = null;
  private mode: OverlayMode = 'production';
  private shouldRemainVisible = false;
  private visibilityKeepalive: NodeJS.Timeout | null = null;
  private worldWindow = new WorldOverlayWindow();
  private static ipcHandlersRegistered = false;

  constructor(private readonly onRendererGone?: OverlayRendererGoneHandler) {}

  private destroyCurrentWindow(): void {
    this.shouldRemainVisible = false;
    this.stopVisibilityKeepalive();

    const window = this.win;
    this.win = null;
    this.isReady = false;

    if (!window || window.isDestroyed()) {
      return;
    }

    window.destroy();
  }

  create(mode: OverlayMode = 'production'): BrowserWindow {
    if (this.win && this.mode !== mode) {
      this.destroyCurrentWindow();
    }

    if (this.win) {
      return this.win;
    }

    this.mode = mode;

    const windowOptions: Electron.BrowserWindowConstructorOptions = {
      title: 'Interpreter Overlay',
      frame: false,
      transparent: mode === 'production',
      backgroundColor: mode === 'debug' ? '#FFFFFF' : undefined,
      opacity: mode === 'debug' ? 1.0 : undefined,
      alwaysOnTop: true,
      acceptFirstMouse: true,
      focusable: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      autoHideMenuBar: true,
      hasShadow: false,
      roundedCorners: false,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
        preload: getOverlayPreloadPath(),
      },
    };

    if (process.platform === 'darwin') {
      // NSPanel (non-activating) so the overlay can receive keyboard focus
      // without activating the app — otherwise macOS switches Spaces away from
      // the user's current fullscreen app when we steal focus.
      windowOptions.type = 'panel';
    }

    const window = new BrowserWindow(windowOptions);
    this.win = window;
    window.setContentProtection(shouldProtectOverlayContent);
    window.on('focus', () => {
      console.log('[OverlayWindow] focus');
    });
    window.on('blur', () => {
      console.log('[OverlayWindow] blur');
    });
    window.on('show', () => {
      console.log('[OverlayWindow] show');
    });
    window.on('hide', () => {
      console.log('[OverlayWindow] hide', { shouldRemainVisible: this.shouldRemainVisible });
      if (!this.shouldRemainVisible) {
        return;
      }

      const display = this.currentDisplay ?? screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      setTimeout(() => {
        if (this.win !== window || window.isDestroyed() || !this.shouldRemainVisible) {
          return;
        }

        this.showOnDisplay(display);
      }, 0);
    });
    window.setIgnoreMouseEvents(true);
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    window.setAlwaysOnTop(true, 'screen-saver');
    this.currentDisplay = screen.getPrimaryDisplay();

    if (isDev) {
      void window.loadURL(getOverlayDevUrl()).catch((error) => {
        console.error('[OverlayWindow] Failed to load overlay dev URL:', error);
      });
    } else {
      void window.loadFile(getOverlayHtmlPath(mode)).catch((error) => {
        console.error('[OverlayWindow] Failed to load overlay HTML:', error);
      });
    }

    window.webContents.on('did-finish-load', () => {
      if (this.win === window) {
        this.isReady = true;
      }
    });

    window.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
      console.error('[OverlayWindow] WebContents failed to load:', errorCode, errorDescription);
    });

    window.webContents.on('render-process-gone', (_event, details) => {
      console.error('[OverlayWindow] Renderer process gone:', details);
      if (this.win !== window) {
        return;
      }

      this.win = null;
      this.isReady = false;
      if (!window.isDestroyed()) {
        window.destroy();
      }

      if (details.reason === 'clean-exit') {
        return;
      }

      this.onRendererGone?.(details);
    });

    window.webContents.on('preload-error', (_event, preloadPath, error) => {
      console.error('[OverlayWindow] Preload error:', { preloadPath, error });
    });

    window.webContents.on('unresponsive', () => {
      console.error('[OverlayWindow] Renderer became unresponsive');
    });

    window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      const levelMap: Record<number, string> = {
        0: '[InterpreterOverlay][Renderer][LOG]',
        1: '[InterpreterOverlay][Renderer][WARN]',
        2: '[InterpreterOverlay][Renderer][ERROR]',
      };
      const prefix = levelMap[level] || '[InterpreterOverlay][Renderer]';
      console.log(`${prefix} ${message} (${sourceId}:${line})`);
    });

    if (!OverlayWindow.ipcHandlersRegistered) {
      ipcMain.on(CHANNELS.SET_IGNORE_MOUSE_EVENTS, (event, ignore: boolean, options?: { forward?: boolean }) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        window?.setIgnoreMouseEvents(ignore, options);
      });

      OverlayWindow.ipcHandlersRegistered = true;
    }

    window.on('closed', () => {
      if (this.win === window) {
        this.win = null;
        this.isReady = false;
      }
    });

    return window;
  }

  showOnDisplay(display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())): void {
    const window = this.create();
    if (this.captureSuppressionDepth > 0) {
      this.currentDisplay = display;
      return;
    }

    this.shouldRemainVisible = true;
    this.startVisibilityKeepalive();
    this.currentDisplay = display;
    const currentBounds = window.getBounds();
    const alreadyCoversDisplay = (
      currentBounds.x === display.bounds.x
      && currentBounds.y === display.bounds.y
      && currentBounds.width === display.bounds.width
      && currentBounds.height === display.bounds.height
    );
    if (window.isVisible() && alreadyCoversDisplay) {
      return;
    }
    window.setBounds(display.bounds);
    console.log('[OverlayWindow] showOnDisplay', {
      displayId: display.id,
      focusable: window.isFocusable(),
      visible: window.isVisible(),
    });

    if (window.isVisible()) {
      window.setOpacity(1);
      window.moveTop();
      return;
    }

    if (this.isReady) {
      window.setOpacity(1);
      if (window.isFocusable()) {
        window.show();
      } else {
        window.showInactive();
      }
      window.moveTop();
      return;
    }

    if (!window.webContents.isLoading()) {
      this.isReady = true;
      window.setOpacity(1);
      if (window.isFocusable()) {
        window.show();
      } else {
        window.showInactive();
      }
      window.moveTop();
      return;
    }

    window.webContents.once('dom-ready', () => {
      if (this.captureSuppressionDepth > 0) {
        return;
      }

      window.setOpacity(1);
      if (window.isFocusable()) {
        window.show();
      } else {
        window.showInactive();
      }
      window.moveTop();
    });
  }

  hide(): void {
    this.shouldRemainVisible = false;
    this.stopVisibilityKeepalive();
    if (!this.win || this.win.isDestroyed()) {
      return;
    }

    if (process.platform === 'darwin' || process.platform === 'win32') {
      const display = this.currentDisplay ?? screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      this.win.setBounds(display.bounds);
      this.win.setIgnoreMouseEvents(true, { forward: true });
      this.win.setFocusable(false);
      this.win.setOpacity(0);
      if (!this.win.isVisible()) {
        this.win.showInactive();
      }
      return;
    }

    this.win.hide();
  }

  showAtCursorDisplay(): void {
    this.showOnDisplay(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()));
  }

  focus(): void {
    if (this.win && !this.win.isDestroyed()) {
      if (this.captureSuppressionDepth > 0) {
        return;
      }

      // Do NOT call app.focus({ steal: true }) on macOS — it activates the
      // Electron app and yanks the user out of whatever fullscreen Space they
      // were in. The overlay window is an NSPanel on macOS, so it can take key
      // focus directly without activating the app.
      //
      // Windows has a similar failure mode for the desktop overlay: activating
      // the app can bring the main Interpreter window in front of the external
      // app the user selected, so the next screenshot/action targets
      // Interpreter instead of the desktop form. Focus the overlay window
      // directly there and leave the previous foreground window stack intact.
      if (process.platform === 'linux') {
        app.focus({ steal: true });
      }
      if (!this.win.isVisible()) {
        if (this.win.isFocusable()) {
          this.win.show();
        } else {
          this.win.showInactive();
        }
      }
      this.win.setOpacity(1);
      this.win.moveTop();
      this.win.focus();
      this.win.webContents.focus();
    }
  }

  requestInputFocus(): void {
    if (!this.win || this.win.isDestroyed() || this.win.webContents.isDestroyed()) {
      return;
    }

    const sendRequest = () => {
      if (!this.win || this.win.isDestroyed() || this.win.webContents.isDestroyed()) {
        return;
      }

      this.win.webContents.send(CHANNELS.REQUEST_INPUT_FOCUS);
    };

    if (this.win.webContents.isLoading()) {
      this.win.webContents.once('did-finish-load', sendRequest);
      return;
    }

    sendRequest();
  }

  pasteIntoInput(): void {
    if (!this.win || this.win.isDestroyed() || this.win.webContents.isDestroyed()) {
      return;
    }

    this.focus();
    this.requestInputFocus();
    setTimeout(() => {
      if (!this.win || this.win.isDestroyed() || this.win.webContents.isDestroyed()) {
        return;
      }
      this.win.webContents.paste();
    }, 40);
  }

  replaceInputWithClipboard(): void {
    if (!this.win || this.win.isDestroyed() || this.win.webContents.isDestroyed()) {
      return;
    }

    this.focus();
    this.requestInputFocus();
    setTimeout(() => {
      if (!this.win || this.win.isDestroyed() || this.win.webContents.isDestroyed()) {
        return;
      }
      this.win.webContents.selectAll();
      this.win.webContents.paste();
    }, 80);
  }

  pressEnterInInput(): void {
    if (!this.win || this.win.isDestroyed() || this.win.webContents.isDestroyed()) {
      return;
    }

    this.focus();
    this.requestInputFocus();
    setTimeout(() => {
      if (!this.win || this.win.isDestroyed() || this.win.webContents.isDestroyed()) {
        return;
      }
      this.win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      this.win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    }, 40);
  }

  async suppressForCapture(): Promise<void> {
    if (!this.win || this.win.isDestroyed()) {
      return;
    }

    this.captureSuppressionDepth += 1;
    if (this.captureSuppressionDepth > 1) {
      return;
    }

    if (process.platform !== 'darwin') {
      this.captureRestoreVisible = this.win.isVisible();
      this.captureRestoreShouldRemainVisible = this.shouldRemainVisible;
      this.captureRestoreOpacity = this.win.getOpacity();
      this.captureRestoreBounds = this.win.getBounds();
      const display = this.currentDisplay ?? screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      this.shouldRemainVisible = false;
      this.stopVisibilityKeepalive();
      this.win.setIgnoreMouseEvents(true);
      if (process.platform === 'win32') {
        this.win.hide();
      } else {
        this.win.setOpacity(0);
        this.win.setBounds({
          x: display.bounds.x,
          y: display.bounds.y,
          width: 1,
          height: 1,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 900));
      return;
    }

    this.captureRestoreOpacity = this.win.getOpacity();
    this.win.setOpacity(0);
    await new Promise((resolve) => setTimeout(resolve, 34));
  }

  async restoreAfterCapture(): Promise<void> {
    if (!this.win || this.win.isDestroyed() || this.captureSuppressionDepth <= 0) {
      return;
    }

    this.captureSuppressionDepth -= 1;
    if (this.captureSuppressionDepth > 0) {
      return;
    }

    if (process.platform !== 'darwin') {
      const shouldShow = this.captureRestoreVisible || this.captureRestoreShouldRemainVisible;
      const restoreBounds = this.captureRestoreBounds;
      this.captureRestoreVisible = false;
      this.captureRestoreShouldRemainVisible = false;
      this.captureRestoreBounds = null;
      const restoreOpacity = this.captureRestoreOpacity ?? 1;
      this.captureRestoreOpacity = null;
      if (shouldShow) {
        this.shouldRemainVisible = true;
        this.startVisibilityKeepalive();
      }
      if (restoreBounds) {
        this.win.setBounds(restoreBounds);
      } else if (this.currentDisplay) {
        this.win.setBounds(this.currentDisplay.bounds);
      }
      this.win.setOpacity(restoreOpacity);
      if (shouldShow && !this.win.isVisible()) {
        this.showOnDisplay(this.currentDisplay ?? undefined);
      }
      return;
    }

    const restoreOpacity = this.captureRestoreOpacity ?? 1;
    this.captureRestoreOpacity = null;
    this.win.setOpacity(restoreOpacity);
  }

  setFocusable(focusable: boolean): void {
    if (this.win && !this.win.isDestroyed()) {
      console.log('[OverlayWindow] setFocusable', { focusable });
      this.win.setFocusable(focusable);
    }
  }

  enableMouseEvents(): void {
    if (this.win && !this.win.isDestroyed()) {
      if (this.captureSuppressionDepth === 0 && this.win.getOpacity() === 0) {
        this.win.setOpacity(this.captureRestoreOpacity ?? 1);
        this.captureRestoreOpacity = null;
      }
      this.win.setIgnoreMouseEvents(false);
    }
  }

  disableMouseEvents(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.setIgnoreMouseEvents(true, { forward: true });
    }
  }

  getWindow(): BrowserWindow | null {
    return this.win;
  }

  isVisible(): boolean {
    return !!this.win && !this.win.isDestroyed() && this.win.isVisible();
  }

  isDestroyed(): boolean {
    return !this.win || this.win.isDestroyed();
  }

  isWindowReady(): boolean {
    return this.isReady && !!this.win && !this.win.isDestroyed();
  }

  isWebContentsLoading(): boolean {
    return !!this.win
      && !this.win.isDestroyed()
      && !this.win.webContents.isDestroyed()
      && this.win.webContents.isLoading();
  }

  isCaptureSuppressed(): boolean {
    return this.captureSuppressionDepth > 0;
  }

  getCurrentDisplay(): Electron.Display | null {
    return this.currentDisplay;
  }

  close(): void {
    this.shouldRemainVisible = false;
    this.stopVisibilityKeepalive();
    this.worldWindow.destroy();
    if (this.win && !this.win.isDestroyed()) {
      this.win.close();
    }
    this.win = null;
    this.isReady = false;
  }

  // -- World overlay (pinned above target window) ---------------------------

  prepareWorldOnDisplay(display: Electron.Display): void {
    this.worldWindow.prepareOnDisplay(display);
  }

  pinWorldTo(target: WorldPinTarget): boolean {
    return this.worldWindow.pinTo(target);
  }

  unpinWorld(fadeMs = 0): void {
    this.worldWindow.unpin(fadeMs);
  }

  getWorldWindow(): WorldOverlayWindow {
    return this.worldWindow;
  }

  sendWorldState<T>(state: T): void {
    this.worldWindow.send(state);
  }

  setWorldTargetMovedListener(listener: ((bounds: { x: number; y: number; width: number; height: number } | null) => void) | null): void {
    this.worldWindow.setTargetMovedListener(listener);
  }

  recreate(mode: OverlayMode = this.mode): BrowserWindow {
    this.destroyCurrentWindow();
    return this.create(mode);
  }

  async waitUntilReady(timeoutMs = 3000): Promise<boolean> {
    const window = this.win;
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
      return false;
    }

    if (this.isReady && !window.webContents.isLoading()) {
      return true;
    }

    if (!window.webContents.isLoading() && window.webContents.getURL()) {
      this.isReady = true;
      return true;
    }

    return new Promise<boolean>((resolve) => {
      let settled = false;
      let timeout: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (timeout !== null) {
          clearTimeout(timeout);
          timeout = null;
        }
        if (!window.isDestroyed()) {
          if (!window.webContents.isDestroyed()) {
            window.webContents.off('did-finish-load', onFinish);
            window.webContents.off('did-fail-load', onFail);
            window.webContents.off('render-process-gone', onFail);
          }
          window.off('closed', onFail);
        }
      };

      const finish = (ready: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(ready);
      };

      const onFinish = () => finish(this.win === window && !window.isDestroyed());
      const onFail = () => finish(false);

      window.webContents.once('did-finish-load', onFinish);
      window.webContents.once('did-fail-load', onFail);
      window.webContents.once('render-process-gone', onFail);
      window.once('closed', onFail);
      timeout = setTimeout(() => finish(false), timeoutMs);
    });
  }

  private startVisibilityKeepalive(): void {
    if (this.visibilityKeepalive) {
      return;
    }

    this.visibilityKeepalive = setInterval(() => {
      if (!this.shouldRemainVisible || !this.win || this.win.isDestroyed()) {
        this.stopVisibilityKeepalive();
        return;
      }

      if (this.win.isVisible()) {
        return;
      }

      const display = this.currentDisplay ?? screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      console.log('[OverlayWindow] keepalive re-show', { displayId: display.id });
      this.showOnDisplay(display);
    }, 16);
  }

  private stopVisibilityKeepalive(): void {
    if (!this.visibilityKeepalive) {
      return;
    }

    clearInterval(this.visibilityKeepalive);
    this.visibilityKeepalive = null;
  }
}
