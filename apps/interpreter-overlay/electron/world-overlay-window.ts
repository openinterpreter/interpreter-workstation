import path from 'node:path';
import {
  windowBoundsByCgId,
  type WindowInfo,
} from '../runtime/infra/window-tracker.js';
import { INTERPRETER_OVERLAY_CHANNELS as CHANNELS } from './channels.js';
import { app, BrowserWindow, screen } from './electron-bridge.js';

const useBuiltRenderer = process.env.INTERPRETER_USE_BUILT_RENDERER === 'true';
const isDev = !app.isPackaged && process.env.NODE_ENV !== 'test' && !useBuiltRenderer;

interface WindowPinAddon {
  isAvailable: () => boolean;
  loadError: () => Error | null;
  pinAbove: (handle: Buffer, targetCgWindowId: number) => boolean;
  setWindowLevelNormal: (handle: Buffer) => boolean;
  getWindowNumber: (handle: Buffer) => number;
  describeZOrder?: (handle: Buffer) => {
    ok: boolean;
    worldWindowNumber: number;
    worldWindowLevel: number;
    worldIndexInOnScreenList: number;
    windowsAbove: { windowNumber: number; owner: string; layer: number }[];
  };
}

let cachedAddon: WindowPinAddon | null = null;
function loadAddon(): WindowPinAddon | null {
  if (cachedAddon) return cachedAddon;
  if (process.platform !== 'darwin' && process.platform !== 'win32') return null;

  // Prefer the prebuilt .node copied into dist-electron by the build pipeline
  // (so packaged/staged installs don't need node_modules layout). Fall back to
  // resolving via require('interpreter-window-pin') for source/dev runs where
  // pnpm has installed the workspace package into node_modules.
  const candidatePaths = [
    path.join(__dirname, '..', 'interpreter-overlay', 'native', 'window_pin.node'),
    path.join(__dirname, '..', '..', 'interpreter-overlay', 'native', 'window_pin.node'),
    path.join(process.resourcesPath ?? '', 'interpreter-overlay', 'native', 'window_pin.node'),
  ];
  let raw: {
    pinAbove: (handle: Buffer, id: number) => boolean;
    setWindowLevelNormal: (handle: Buffer) => boolean;
    getWindowNumber: (handle: Buffer) => number;
    describeZOrder?: (handle: Buffer) => unknown;
    platform: string;
  } | null = null;
  for (const candidate of candidatePaths) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
      raw = require(candidate);
      console.log('[WorldOverlayWindow] loaded window_pin.node from', candidate);
      break;
    } catch {
      // try next
    }
  }
  if (!raw) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
      const wrapper = require('interpreter-window-pin') as WindowPinAddon;
      cachedAddon = wrapper;
      if (!wrapper.isAvailable()) {
        console.warn('[WorldOverlayWindow] window-pin addon wrapper unavailable:', wrapper.loadError?.());
      }
      return wrapper;
    } catch (err) {
      console.warn('[WorldOverlayWindow] failed to load window-pin addon:', err);
      return null;
    }
  }

  const wrapped: WindowPinAddon = {
    isAvailable: () => raw!.platform === 'darwin' || raw!.platform === 'win32',
    loadError: () => null,
    pinAbove: (handle: Buffer, id: number) => Boolean(raw!.pinAbove(handle, id)),
    setWindowLevelNormal: (handle: Buffer) => Boolean(raw!.setWindowLevelNormal(handle)),
    getWindowNumber: (handle: Buffer) => Number(raw!.getWindowNumber(handle)),
    describeZOrder: raw!.describeZOrder
      ? (handle: Buffer) => raw!.describeZOrder!(handle) as ReturnType<NonNullable<WindowPinAddon['describeZOrder']>>
      : undefined,
  };
  cachedAddon = wrapped;
  return wrapped;
}

function getOverlayPreloadPath(): string {
  return path.join(__dirname, '..', 'apps', 'interpreter-overlay', 'renderer', 'preload.cjs');
}

function getWorldHtmlPath(): string {
  return path.join(__dirname, '..', '..', 'dist', 'apps', 'interpreter-overlay', 'renderer', 'world.html');
}

function getWorldDevUrl(): string {
  const vitePort = process.env.VITE_PORT || '5173';
  return `http://localhost:${vitePort}/apps/interpreter-overlay/renderer/world.html`;
}

export interface WorldPinTarget {
  pid: number;
  cgWindowId: number;
  ownerName?: string;
  title?: string;
  initialBounds: { x: number; y: number; width: number; height: number };
  initialOverlayBounds?: { x: number; y: number; width: number; height: number };
}

export class WorldOverlayWindow {
  private win: BrowserWindow | null = null;
  private isReady = false;
  private currentDisplay: Electron.Display | null = null;
  private addon: WindowPinAddon | null = loadAddon();
  private repinInterval: NodeJS.Timeout | null = null;
  private boundsInterval: NodeJS.Timeout | null = null;
  private boundsPollInFlight = false;
  private currentTarget: WorldPinTarget | null = null;
  private latestTargetBounds: WindowInfo['bounds'] | null = null;
  private onTargetMoved: ((bounds: WindowInfo['bounds'] | null) => void) | null = null;
  private latestState: unknown = null;
  private loadStarted = false;
  private hideFadeTimer: NodeJS.Timeout | null = null;
  private hideFadeInterval: NodeJS.Timeout | null = null;

  ensureCreated(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) {
      return this.win;
    }

    const windowOptions: Electron.BrowserWindowConstructorOptions = {
      title: 'Interpreter World Overlay',
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      focusable: false,
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
      acceptFirstMouse: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
        preload: getOverlayPreloadPath(),
      },
    };

    if (process.platform === 'darwin') {
      // Match the chrome overlay's fullscreen Space behavior. The native pinning
      // addon works with NSPanel because it resolves the backing NSWindow.
      windowOptions.type = 'panel';
    }

    const window = new BrowserWindow(windowOptions);

    if (process.platform === 'darwin' && this.addon?.isAvailable()) {
      try {
        const handle = window.getNativeWindowHandle();
        window.setAlwaysOnTop(true, 'screen-saver');
      } catch (err) {
        console.warn('[WorldOverlayWindow] setAlwaysOnTop failed:', err);
      }
    }

    window.setIgnoreMouseEvents(true);
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    this.win = window;
    this.currentDisplay = screen.getPrimaryDisplay();

    window.webContents.on('did-finish-load', () => {
      if (this.win === window) {
        this.isReady = true;
        console.log('[WorldOverlayWindow] did-finish-load', {
          url: window.webContents.getURL(),
        });
        this.repinNow();
        this.flushLatestState();
      }
    });
    window.webContents.on('dom-ready', () => {
      if (this.win === window) {
        this.flushLatestState();
      }
    });
    window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      console.error('[WorldOverlayWindow] did-fail-load', {
        errorCode,
        errorDescription,
        validatedURL,
      });
    });
    window.webContents.on('preload-error', (_event, preloadPath, error) => {
      console.error('[WorldOverlayWindow] preload-error', {
        preloadPath,
        error,
      });
    });
    window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      const prefix = level >= 2 ? '[WorldOverlayWindow][Renderer][WARN]' : '[WorldOverlayWindow][Renderer]';
      console.log(prefix, message, `${sourceId}:${line}`);
    });

    window.on('closed', () => {
      if (this.win === window) {
        this.win = null;
        this.isReady = false;
        this.loadStarted = false;
      }
    });

    this.ensureLoaded();

    return window;
  }

  private ensureLoaded(): void {
    const window = this.win;
    if (!window || window.isDestroyed() || this.loadStarted) {
      return;
    }
    this.loadStarted = true;
    const worldUrlOrPath = isDev ? getWorldDevUrl() : getWorldHtmlPath();
    console.log('[WorldOverlayWindow] loading renderer', {
      isDev,
      worldUrlOrPath,
      preload: getOverlayPreloadPath(),
    });
    if (isDev) {
      void window.loadURL(getWorldDevUrl()).catch((err) => {
        console.error('[WorldOverlayWindow] failed to load dev URL:', err);
      });
    } else {
      void window.loadFile(getWorldHtmlPath()).catch((err) => {
        console.error('[WorldOverlayWindow] failed to load world html:', err);
      });
    }
  }

  showOnDisplay(display: Electron.Display): void {
    const window = this.ensureCreated();
    this.cancelHideFade();
    this.currentDisplay = display;
    window.setBounds(display.bounds);
    window.setOpacity(1);
    window.setAlwaysOnTop(true, 'screen-saver');
    if (!window.isVisible()) {
      window.showInactive();
    }
  }

  prepareOnDisplay(display: Electron.Display): void {
    const window = this.ensureCreated();
    this.currentDisplay = display;
    window.setBounds(display.bounds);
  }

  private showOverTarget(bounds: WindowInfo['bounds']): void {
    const window = this.ensureCreated();
    this.cancelHideFade();
    this.currentDisplay = screen.getDisplayNearestPoint({
      x: Math.round(bounds.x + bounds.width / 2),
      y: Math.round(bounds.y + bounds.height / 2),
    });
    window.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(1, Math.round(bounds.width)),
      height: Math.max(1, Math.round(bounds.height)),
    });
    window.setOpacity(1);
    window.setAlwaysOnTop(true, 'screen-saver');
    if (!window.isVisible()) {
      window.showInactive();
    }
    this.repinNow();
  }

  hide(): void {
    this.cancelHideFade();
    if (this.win && !this.win.isDestroyed()) {
      this.win.hide();
      this.win.setOpacity(1);
    }
  }

  hideWithFade(durationMs: number): void {
    const window = this.win && !this.win.isDestroyed() ? this.win : null;
    if (!window || !window.isVisible() || durationMs <= 0) {
      this.hide();
      return;
    }

    this.cancelHideFade();
    window.setOpacity(1);
    const startedAt = Date.now();
    const tick = () => {
      if (!this.win || this.win.isDestroyed()) {
        this.cancelHideFade();
        return;
      }
      const progress = Math.min(1, (Date.now() - startedAt) / durationMs);
      this.win.setOpacity(Math.max(0, 1 - progress));
      if (progress >= 1) {
        this.cancelHideFade();
        this.win.hide();
        this.win.setOpacity(1);
      }
    };
    tick();
    this.hideFadeInterval = setInterval(tick, 16);
    this.hideFadeTimer = setTimeout(() => {
      if (!this.win || this.win.isDestroyed()) {
        this.cancelHideFade();
        return;
      }
      this.cancelHideFade();
      this.win.hide();
      this.win.setOpacity(1);
    }, durationMs + 80);
  }

  private cancelHideFade(): void {
    if (this.hideFadeTimer) {
      clearTimeout(this.hideFadeTimer);
      this.hideFadeTimer = null;
    }
    if (this.hideFadeInterval) {
      clearInterval(this.hideFadeInterval);
      this.hideFadeInterval = null;
    }
  }

  setOpacity(value: number): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.setOpacity(value);
    }
  }

  isVisible(): boolean {
    return !!this.win && !this.win.isDestroyed() && this.win.isVisible();
  }

  isWindowReady(): boolean {
    return this.isReady && !!this.win && !this.win.isDestroyed();
  }

  getWindow(): BrowserWindow | null {
    return this.win;
  }

  getCurrentTarget(): WorldPinTarget | null {
    return this.currentTarget;
  }

  getLatestTargetBounds(): WindowInfo['bounds'] | null {
    return this.latestTargetBounds;
  }

  // Send the same overlay state firehose to the world renderer too.
  send<TState>(state: TState): void {
    this.latestState = state;
    this.flushLatestState();
  }

  private flushLatestState(): void {
    const win = this.win;
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
      return;
    }
    if (win.webContents.isLoading() || !this.latestState) {
      return;
    }
    win.webContents.send(CHANNELS.STATE, this.latestState);
  }

  setTargetMovedListener(listener: ((bounds: WindowInfo['bounds'] | null) => void) | null): void {
    this.onTargetMoved = listener;
  }

  isNativePinAvailable(): boolean {
    return this.addon?.isAvailable() === true;
  }

  getDebugSnapshot(): {
    nativePinAvailable: boolean;
    currentTarget: WorldPinTarget | null;
    latestTargetBounds: WindowInfo['bounds'] | null;
    isReady: boolean;
    isVisible: boolean;
    opacity: number | null;
    url: string | null;
    isLoading: boolean | null;
    zOrder: unknown;
  } {
    let zOrder: unknown = null;
    if (this.win && !this.win.isDestroyed() && this.addon?.describeZOrder) {
      try {
        zOrder = this.addon.describeZOrder(this.win.getNativeWindowHandle());
      } catch (err) {
        zOrder = { error: err instanceof Error ? err.message : String(err) };
      }
    }
    return {
      nativePinAvailable: this.isNativePinAvailable(),
      currentTarget: this.currentTarget ? { ...this.currentTarget } : null,
      latestTargetBounds: this.latestTargetBounds ? { ...this.latestTargetBounds } : null,
      isReady: this.isReady,
      isVisible: this.win && !this.win.isDestroyed() ? this.win.isVisible() : false,
      opacity: this.win && !this.win.isDestroyed() ? this.win.getOpacity() : null,
      url: this.win && !this.win.isDestroyed() && !this.win.webContents.isDestroyed()
        ? this.win.webContents.getURL()
        : null,
      isLoading: this.win && !this.win.isDestroyed() && !this.win.webContents.isDestroyed()
        ? this.win.webContents.isLoading()
        : null,
      zOrder,
    };
  }

  pinTo(target: WorldPinTarget): boolean {
    if (process.platform !== 'darwin' && process.platform !== 'win32') {
      return false;
    }
    if (!this.isNativePinAvailable()) {
      console.warn('[WorldOverlayWindow] native window pinning unavailable; refusing to enable world overlay', this.addon?.loadError?.());
      return false;
    }
    this.currentTarget = target;
    this.latestTargetBounds = { ...target.initialBounds };
    const window = this.ensureCreated();

    this.showOverTarget(target.initialOverlayBounds ?? target.initialBounds);

    this.startWatching(target.cgWindowId);
    this.startRepinLoop();
    return this.isReady ? this.repinNow() : true;
  }

  unpin(fadeMs = 0): void {
    this.stopRepinLoop();
    this.stopWatching();
    this.currentTarget = null;
    this.latestTargetBounds = null;
    if (this.win && !this.win.isDestroyed() && this.addon?.isAvailable()) {
      try {
        this.addon.setWindowLevelNormal(this.win.getNativeWindowHandle());
      } catch (err) {
        console.warn('[WorldOverlayWindow] failed to restore normal window level before unpin:', err);
      }
    }
    if (fadeMs > 0) {
      this.hideWithFade(fadeMs);
    } else {
      this.hide();
    }
  }

  private startWatching(cgWindowId: number): void {
    this.stopWatching();
    let calibratedInitialBounds = false;
    const poll = async () => {
      if (this.boundsPollInFlight) return;
      this.boundsPollInFlight = true;
      try {
        const windowInfo = await windowBoundsByCgId(cgWindowId);
        const nextBounds = windowInfo?.bounds ?? null;
        if (!nextBounds) {
          console.warn('[WorldOverlayWindow] tracker returned no bounds; preserving previous world overlay target bounds');
          calibratedInitialBounds = true;
          return;
        }
        const previous = this.latestTargetBounds;
        const changed = (
          !previous
          || previous.x !== nextBounds.x
          || previous.y !== nextBounds.y
          || previous.width !== nextBounds.width
          || previous.height !== nextBounds.height
        );
        if (changed) {
          if (!calibratedInitialBounds && nextBounds && this.currentTarget) {
            // Windows can report the target bounds through two different
            // native paths during the initial pin handoff. Treat the first
            // tracker value as the movement baseline, not as a real window
            // move, so the user-selected scope does not jump after mouse-up.
            this.currentTarget = {
              ...this.currentTarget,
              initialBounds: { ...nextBounds },
            };
            this.latestTargetBounds = nextBounds;
            calibratedInitialBounds = true;
            return;
          }
          calibratedInitialBounds = true;
          this.latestTargetBounds = nextBounds;
          if (nextBounds) {
            const overlayBounds = this.currentTarget?.initialOverlayBounds;
            if (overlayBounds && this.currentTarget) {
              this.showOverTarget({
                x: overlayBounds.x + (nextBounds.x - this.currentTarget.initialBounds.x),
                y: overlayBounds.y + (nextBounds.y - this.currentTarget.initialBounds.y),
                width: overlayBounds.width,
                height: overlayBounds.height,
              });
            } else {
              this.showOverTarget(nextBounds);
            }
          }
          this.onTargetMoved?.(nextBounds);
        }
        calibratedInitialBounds = true;
      } catch (err) {
        console.warn('[WorldOverlayWindow] tracker error:', err);
      } finally {
        this.boundsPollInFlight = false;
      }
    };
    this.boundsInterval = setInterval(() => {
      void poll();
    }, 33);
    void poll();
  }

  private stopWatching(): void {
    if (this.boundsInterval) {
      clearInterval(this.boundsInterval);
      this.boundsInterval = null;
    }
    this.boundsPollInFlight = false;
  }

  private startRepinLoop(): void {
    if (this.repinInterval) return;
    this.repinInterval = setInterval(() => this.repinNow(), 16);
  }

  private stopRepinLoop(): void {
    if (this.repinInterval) {
      clearInterval(this.repinInterval);
      this.repinInterval = null;
    }
  }

  private repinNow(): boolean {
    if (!this.win || this.win.isDestroyed()) return false;
    if (!this.isReady) return false;
    if (!this.addon || !this.addon.isAvailable()) return false;
    if (!this.currentTarget) return false;
    try {
      const handle = this.win.getNativeWindowHandle();
      const pinned = this.addon.pinAbove(handle, this.currentTarget.cgWindowId);
      this.win.setAlwaysOnTop(true, 'screen-saver');
      this.win.moveTop();
      return pinned;
    } catch (err) {
      console.warn('[WorldOverlayWindow] pinAbove failed:', err);
      return false;
    }
  }

  destroy(): void {
    this.unpin();
    if (this.win && !this.win.isDestroyed()) {
      this.win.destroy();
    }
    this.win = null;
    this.isReady = false;
    this.loadStarted = false;
  }
}
