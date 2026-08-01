import type { BrowserWindow } from 'electron';
import type { UIPort } from '../../shared/ports.js';
import type { UIState } from '../../shared/types.js';
import { INTERPRETER_OVERLAY_CHANNELS as CHANNELS } from '../../electron/channels.js';
import type { OverlayWindow } from '../../electron/overlay-window.js';

export function createUIBridge(mainWindow: BrowserWindow, overlay?: OverlayWindow): UIPort {
  const acceptCallbacks: Array<() => void> = [];
  const acceptAllCallbacks: Array<() => void> = [];
  const acceptAllSessionCallbacks: Array<() => void> = [];
  const rejectCallbacks: Array<() => void> = [];

  return {
    set(state: UIState): void {
      if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
        return;
      }

      overlay?.showAtCursorDisplay();

      const sendState = () => {
        if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
          return;
        }

        mainWindow.webContents.send(CHANNELS.STATE, state);
      };

      if (mainWindow.webContents.isLoading()) {
        mainWindow.webContents.once('did-finish-load', sendState);
        return;
      }

      sendState();
    },

    blur(): void {
      overlay?.hide();
    },

    onAccept(cb: () => void): void {
      acceptCallbacks.push(cb);
    },

    onAcceptAll(cb: () => void): void {
      acceptAllCallbacks.push(cb);
    },

    onAcceptAllSession(cb: () => void): void {
      acceptAllSessionCallbacks.push(cb);
    },

    onReject(cb: () => void): void {
      rejectCallbacks.push(cb);
    },
  };
}
