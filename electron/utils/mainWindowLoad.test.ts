import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import {
  classifyMainWindowLoadFailure,
  waitForMainWindowLoadRecovery,
} from './mainWindowLoad';

class FakeWebContents extends EventEmitter {
  constructor(private currentUrl: string = 'about:blank') {
    super();
  }

  getURL(): string {
    return this.currentUrl;
  }

  setURL(nextUrl: string): void {
    this.currentUrl = nextUrl;
  }
}

class FakeWindow extends EventEmitter {
  private destroyed = false;
  readonly webContents: FakeWebContents;

  constructor(initialUrl?: string) {
    super();
    this.webContents = new FakeWebContents(initialUrl);
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  close(): void {
    this.destroyed = true;
    this.emit('closed');
  }
}

describe('classifyMainWindowLoadFailure', () => {
  test('aborts window initialization for teardown load failures while app is quitting', () => {
    expect(classifyMainWindowLoadFailure({
      error: new Error("ERR_FAILED (-2) loading 'file:///dist/index.html'"),
      isQuitting: true,
      hasLiveMainWindow: false,
    })).toEqual({
      shouldAbortWindowInitialization: true,
      reason: 'teardown-load-abort',
      message: "ERR_FAILED (-2) loading 'file:///dist/index.html'",
    });
  });

  test('aborts window initialization for renderer aborts after the main window is gone', () => {
    expect(classifyMainWindowLoadFailure({
      error: new Error("ERR_ABORTED (-3) loading 'http://localhost:5173'"),
      isQuitting: false,
      hasLiveMainWindow: false,
    })).toEqual({
      shouldAbortWindowInitialization: true,
      reason: 'teardown-load-abort',
      message: "ERR_ABORTED (-3) loading 'http://localhost:5173'",
    });
  });

  test('does not treat load aborts as benign while the main window is still alive', () => {
    expect(classifyMainWindowLoadFailure({
      error: new Error("ERR_FAILED (-2) loading 'file:///dist/index.html'"),
      isQuitting: false,
      hasLiveMainWindow: true,
    })).toEqual({
      shouldAbortWindowInitialization: false,
      reason: 'unexpected-load-failure',
      message: "ERR_FAILED (-2) loading 'file:///dist/index.html'",
    });
  });

  test('does not hide unrelated startup failures', () => {
    expect(classifyMainWindowLoadFailure({
      error: new Error('ENOENT: no such file or directory'),
      isQuitting: true,
      hasLiveMainWindow: false,
    })).toEqual({
      shouldAbortWindowInitialization: false,
      reason: 'unexpected-load-failure',
      message: 'ENOENT: no such file or directory',
    });
  });
});

describe('waitForMainWindowLoadRecovery', () => {
  test('recovers when the renderer finishes loading after an abort', async () => {
    const window = new FakeWindow();
    const expectedUrl = 'http://localhost:5173/';

    const recovery = waitForMainWindowLoadRecovery({
      window,
      expectedUrl,
      timeoutMs: 100,
    });

    queueMicrotask(() => {
      window.webContents.setURL(expectedUrl);
      window.webContents.emit('did-finish-load');
    });

    expect(await recovery).toBe('recovered');
  });

  test('ignores repeated abort did-fail-load events while waiting for recovery', async () => {
    const window = new FakeWindow();
    const expectedUrl = 'http://localhost:5173/';

    const recovery = waitForMainWindowLoadRecovery({
      window,
      expectedUrl,
      timeoutMs: 100,
    });

    queueMicrotask(() => {
      window.webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', expectedUrl, true);
      window.webContents.setURL(expectedUrl);
      window.webContents.emit('did-finish-load');
    });

    expect(await recovery).toBe('recovered');
  });

  test('fails on a non-abort main-frame load error for the expected url', async () => {
    const window = new FakeWindow();
    const expectedUrl = 'http://localhost:5173/';

    const recovery = waitForMainWindowLoadRecovery({
      window,
      expectedUrl,
      timeoutMs: 100,
    });

    queueMicrotask(() => {
      window.webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', expectedUrl, true);
    });

    expect(await recovery).toBe('failed');
  });

  test('times out when no recovery event arrives', async () => {
    const window = new FakeWindow();

    expect(await waitForMainWindowLoadRecovery({
      window,
      expectedUrl: 'http://localhost:5173/',
      timeoutMs: 10,
    })).toBe('timed-out');
  });

  test('returns window-destroyed when the window closes while waiting', async () => {
    const window = new FakeWindow();

    const recovery = waitForMainWindowLoadRecovery({
      window,
      expectedUrl: 'http://localhost:5173/',
      timeoutMs: 100,
    });

    queueMicrotask(() => {
      window.close();
    });

    expect(await recovery).toBe('window-destroyed');
  });
});
