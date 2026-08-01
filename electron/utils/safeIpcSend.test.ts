import { describe, expect, test } from 'bun:test';
import { sendToWindow } from './safeIpcSend';

const disposedFrameError = new Error(
  'Render frame was disposed before WebFrameMain could be accessed'
);

function createWindow({
  windowDestroyed = false,
  contentsDestroyed = false,
  crashed = false,
  frameDestroyed = false,
  detached = false,
  getterError,
  sendError,
}: {
  windowDestroyed?: boolean;
  contentsDestroyed?: boolean;
  crashed?: boolean;
  frameDestroyed?: boolean;
  detached?: boolean;
  getterError?: unknown;
  sendError?: unknown;
} = {}) {
  const sendCalls: Array<{ channel: string; args: unknown[] }> = [];

  const mainFrame = {
    isDestroyed: () => frameDestroyed,
    detached,
    send: (channel: string, ...args: unknown[]) => {
      if (sendError) throw sendError;
      sendCalls.push({ channel, args });
    },
  };

  const webContents = {
    isDestroyed: () => contentsDestroyed,
    isCrashed: () => crashed,
    get mainFrame() {
      if (getterError) throw getterError;
      return mainFrame;
    },
  };

  const win = {
    isDestroyed: () => windowDestroyed,
    webContents,
  };

  return { win, sendCalls };
}

describe('sendToWindow', () => {
  test('sends when window and main frame are alive', () => {
    const { win, sendCalls } = createWindow();
    const sent = sendToWindow(win, 'workspace:files-changed', { eventType: 'change' });
    expect(sent).toBe(true);
    expect(sendCalls).toEqual([
      { channel: 'workspace:files-changed', args: [{ eventType: 'change' }] },
    ]);
  });

  test('returns false when window is destroyed', () => {
    const { win, sendCalls } = createWindow({ windowDestroyed: true });
    expect(sendToWindow(win, 'x')).toBe(false);
    expect(sendCalls).toHaveLength(0);
  });

  test('returns false when webContents is destroyed or crashed', () => {
    expect(sendToWindow(createWindow({ contentsDestroyed: true }).win, 'x')).toBe(false);
    expect(sendToWindow(createWindow({ crashed: true }).win, 'x')).toBe(false);
  });

  test('returns false when main frame is detached or destroyed', () => {
    expect(sendToWindow(createWindow({ detached: true }).win, 'x')).toBe(false);
    expect(sendToWindow(createWindow({ frameDestroyed: true }).win, 'x')).toBe(false);
  });

  test('returns false for disposed-frame race while reading mainFrame', () => {
    const { win, sendCalls } = createWindow({ getterError: disposedFrameError });
    expect(sendToWindow(win, 'x')).toBe(false);
    expect(sendCalls).toHaveLength(0);
  });

  test('returns false for disposed-frame race while sending', () => {
    const { win, sendCalls } = createWindow({ sendError: disposedFrameError });
    expect(sendToWindow(win, 'x')).toBe(false);
    expect(sendCalls).toHaveLength(0);
  });

  test('returns false and logs for unexpected getter/send errors', () => {
    const getterFailure = new Error('unexpected getter failure');
    const sendFailure = new Error('unexpected send failure');
    const logged: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };

    try {
      expect(sendToWindow(createWindow({ getterError: getterFailure }).win, 'x')).toBe(false);
      expect(sendToWindow(createWindow({ sendError: sendFailure }).win, 'x')).toBe(false);
      expect(logged).toHaveLength(2);
    } finally {
      console.error = originalConsoleError;
    }
  });
});
