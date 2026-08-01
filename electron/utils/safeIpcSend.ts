import type { BrowserWindow, WebContents, WebFrameMain } from 'electron';

type WebFrameLike = Pick<WebFrameMain, 'isDestroyed' | 'detached' | 'send'>;

type WebContentsLike = {
  isDestroyed: WebContents['isDestroyed'];
  isCrashed?: WebContents['isCrashed'];
  readonly mainFrame: WebFrameLike;
};

type BrowserWindowLike = {
  isDestroyed: BrowserWindow['isDestroyed'];
  webContents: WebContentsLike;
};

const DISPOSED_FRAME_ERROR_FRAGMENT = 'Render frame was disposed before WebFrameMain could be accessed';

function getErrorMessage(error: unknown): string | null {
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object') return null;
  const candidate = (error as { message?: unknown }).message;
  return typeof candidate === 'string' ? candidate : null;
}

function isDisposedFrameRace(error: unknown): boolean {
  const message = getErrorMessage(error);
  return Boolean(message && message.includes(DISPOSED_FRAME_ERROR_FRAGMENT));
}

/**
 * Sends IPC only when a BrowserWindow's main frame is still alive.
 * Returns false when sending is not possible and never throws.
 */
export function sendToWindow(window: BrowserWindowLike, channel: string, ...args: unknown[]): boolean {
  try {
    if (window.isDestroyed()) return false;

    const contents = window.webContents;
    if (contents.isDestroyed()) return false;
    if (typeof contents.isCrashed === 'function' && contents.isCrashed()) return false;

    const mainFrame = contents.mainFrame;
    if (mainFrame.isDestroyed() || mainFrame.detached) return false;

    mainFrame.send(channel, ...args);
    return true;
  } catch (error) {
    if (!isDisposedFrameRace(error)) {
      console.error('[IPC] Unexpected sendToWindow failure:', channel, error);
    }
    return false;
  }
}
