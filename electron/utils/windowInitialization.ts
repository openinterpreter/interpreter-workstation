import { clampZoomFactor } from './zoom';

export type WindowInitializationResult = 'initialized' | 'aborted-during-teardown';
type WindowTeardownEvent = 'closed' | 'destroyed';

interface WindowTeardownState {
  dispose(): void;
  isTornDown(): boolean;
}

interface WindowTeardownEmitter {
  once?(event: WindowTeardownEvent, listener: () => void): void;
  off?(event: WindowTeardownEvent, listener: () => void): void;
  removeListener?(event: WindowTeardownEvent, listener: () => void): void;
}

interface WindowInitializationWebContents {
  isDestroyed?(): boolean;
  setZoomFactor(zoomFactor: number): void;
  once?(event: 'destroyed', listener: () => void): void;
  off?(event: 'destroyed', listener: () => void): void;
  removeListener?(event: 'destroyed', listener: () => void): void;
}

export interface WindowInitializationWindow {
  isDestroyed(): boolean;
  maximize(): void;
  webContents: WindowInitializationWebContents;
  once?(event: 'closed', listener: () => void): void;
  off?(event: 'closed', listener: () => void): void;
  removeListener?(event: 'closed', listener: () => void): void;
}

interface WindowInitializationDependencies<TWindow extends WindowInitializationWindow> {
  abortInitialization(): Promise<void>;
  getZoomFactor(): Promise<number>;
  loadContent(window: TWindow): Promise<'loaded' | 'aborted-during-teardown'>;
  maximize: boolean;
  registerWindow(window: TWindow): void;
}

function detachListener(
  target: WindowTeardownEmitter,
  event: WindowTeardownEvent,
  listener: () => void,
): void {
  const remover = typeof target.off === 'function'
    ? target.off.bind(target)
    : typeof target.removeListener === 'function'
      ? target.removeListener.bind(target)
      : null;
  if (!remover) {
    return;
  }

  try {
    remover(event, listener);
  } catch (error) {
    if (isDestroyedObjectError(error)) {
      return;
    }
    throw error;
  }
}

function isDestroyedObjectError(error: unknown): boolean {
  return error instanceof TypeError && error.message === 'Object has been destroyed';
}

/*
 * We track teardown explicitly instead of relying on "Object has been destroyed"
 * exceptions. Electron's guidance is to stop using a BrowserWindow after
 * 'closed', and to treat webContents 'destroyed' / isDestroyed() as separate
 * lifecycle checks:
 * - https://www.electronjs.org/docs/latest/api/browser-window#event-closed
 * - https://www.electronjs.org/docs/latest/api/web-contents#event-destroyed
 * - https://www.electronjs.org/docs/latest/api/web-contents#contentsisdestroyed
 *
 * Larger Electron apps use the same pattern:
 * - Signal tracks a destroyed flag around async window loading:
 *   https://github.com/signalapp/Signal-Desktop/blob/60a1e125452ee672d8747564d0055d5bfec9f679/app/main.main.ts#L643-L668
 * - VS Code guards both BrowserWindow and webContents before sending IPC:
 *   https://github.com/microsoft/vscode/blob/6a3da5ff32ef69f298df261d51c352c108d1afca/src/vs/platform/windows/electron-main/windowImpl.ts#L1570-L1579
 * - Joplin documents the same double-guard because the window and webContents
 *   can be destroyed independently:
 *   https://github.com/laurent22/joplin/blob/94560fb340a08d4b83274a1dbdfa06d964ae720f/packages/app-desktop/ElectronAppWrapper.ts#L510-L513
 *
 * That is why initialization listens for both 'closed' and 'destroyed' and
 * converts any mid-flight teardown into a typed abort path.
 */
function trackWindowTeardown(window: WindowInitializationWindow): WindowTeardownState {
  let tornDown = false;
  const markTornDown = () => {
    tornDown = true;
  };

  window.once?.('closed', markTornDown);
  window.webContents.once?.('destroyed', markTornDown);

  return {
    dispose() {
      detachListener(window, 'closed', markTornDown);
      detachListener(window.webContents, 'destroyed', markTornDown);
    },
    isTornDown() {
      return tornDown;
    },
  };
}

function isWindowUnavailable(
  window: WindowInitializationWindow,
  teardown: WindowTeardownState,
): boolean {
  if (teardown.isTornDown()) {
    return true;
  }

  if (window.isDestroyed()) {
    return true;
  }

  try {
    return window.webContents.isDestroyed?.() === true;
  } catch {
    return teardown.isTornDown();
  }
}

export async function initializeCreatedWindow<TWindow extends WindowInitializationWindow>(
  window: TWindow,
  deps: WindowInitializationDependencies<TWindow>,
): Promise<WindowInitializationResult> {
  const teardown = trackWindowTeardown(window);
  const abortForTeardown = async (): Promise<WindowInitializationResult> => {
    await deps.abortInitialization();
    return 'aborted-during-teardown';
  };

  try {
    if (isWindowUnavailable(window, teardown)) {
      return abortForTeardown();
    }

    const savedZoomFactor = clampZoomFactor(await deps.getZoomFactor());
    try {
      window.webContents.setZoomFactor(savedZoomFactor);
    } catch (error) {
      if (isWindowUnavailable(window, teardown)) {
        return abortForTeardown();
      }
      throw error;
    }

    let loadResult: 'loaded' | 'aborted-during-teardown';
    try {
      loadResult = await deps.loadContent(window);
    } catch (error) {
      if (isWindowUnavailable(window, teardown)) {
        return abortForTeardown();
      }
      throw error;
    }
    if (loadResult === 'aborted-during-teardown') {
      return abortForTeardown();
    }

    if (isWindowUnavailable(window, teardown)) {
      return abortForTeardown();
    }

    if (deps.maximize) {
      try {
        window.maximize();
      } catch (error) {
        if (isWindowUnavailable(window, teardown)) {
          return abortForTeardown();
        }
        throw error;
      }
    }

    try {
      deps.registerWindow(window);
    } catch (error) {
      if (isWindowUnavailable(window, teardown)) {
        return abortForTeardown();
      }
      throw error;
    }

    return 'initialized';
  } finally {
    teardown.dispose();
  }
}
