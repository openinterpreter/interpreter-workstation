interface ClassifyMainWindowLoadFailureInput {
  error: unknown;
  isQuitting: boolean;
  hasLiveMainWindow: boolean;
}

interface MainWindowLoadRecoveryWebContents {
  getURL(): string;
  isDestroyed?(): boolean;
  on(event: 'did-finish-load' | 'did-fail-load', listener: (...args: any[]) => void): this;
  removeListener(event: 'did-finish-load' | 'did-fail-load', listener: (...args: any[]) => void): this;
}

interface MainWindowLoadRecoveryWindow {
  isDestroyed(): boolean;
  on(event: 'closed', listener: () => void): this;
  removeListener(event: 'closed', listener: () => void): this;
  webContents: MainWindowLoadRecoveryWebContents;
}

type MainWindowLoadFailureReason =
  | 'teardown-load-abort'
  | 'unexpected-load-failure';

export type MainWindowLoadRecoveryResult =
  | 'recovered'
  | 'failed'
  | 'timed-out'
  | 'window-destroyed';

export interface MainWindowLoadFailureDecision {
  shouldAbortWindowInitialization: boolean;
  reason: MainWindowLoadFailureReason;
  message: string;
}

const MAIN_WINDOW_LOAD_ABORT_MESSAGES = [
  'ERR_FAILED (-2) loading',
  'ERR_ABORTED (-3) loading',
] as const;

function getLoadFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '');
}

function isMainWindowLoadAbortMessage(message: string): boolean {
  return MAIN_WINDOW_LOAD_ABORT_MESSAGES.some((pattern) => message.includes(pattern));
}

export function isMainWindowLoadAbortError(error: unknown): boolean {
  return isMainWindowLoadAbortMessage(getLoadFailureMessage(error));
}

function isWindowUnavailable(window: MainWindowLoadRecoveryWindow): boolean {
  return window.isDestroyed() || window.webContents.isDestroyed?.() === true;
}

export function waitForMainWindowLoadRecovery({
  window,
  expectedUrl,
  timeoutMs = 10_000,
}: {
  window: MainWindowLoadRecoveryWindow;
  expectedUrl: string;
  timeoutMs?: number;
}): Promise<MainWindowLoadRecoveryResult> {
  if (isWindowUnavailable(window)) {
    return Promise.resolve('window-destroyed');
  }

  return new Promise((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      window.removeListener('closed', onClosed);
      window.webContents.removeListener('did-finish-load', onDidFinishLoad);
      window.webContents.removeListener('did-fail-load', onDidFailLoad);
    };

    const settle = (result: MainWindowLoadRecoveryResult) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };

    const onClosed = () => {
      settle('window-destroyed');
    };

    const onDidFinishLoad = () => {
      settle('recovered');
    };

    const onDidFailLoad = (
      _event: unknown,
      errorCode: number,
      errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean,
    ) => {
      if (!isMainFrame || validatedURL !== expectedUrl) {
        return;
      }

      const message = `${errorDescription} (${errorCode}) loading '${validatedURL}'`;
      if (isMainWindowLoadAbortMessage(message)) {
        return;
      }

      settle('failed');
    };

    window.on('closed', onClosed);
    window.webContents.on('did-finish-load', onDidFinishLoad);
    window.webContents.on('did-fail-load', onDidFailLoad);

    timeoutId = setTimeout(() => {
      if (isWindowUnavailable(window)) {
        settle('window-destroyed');
        return;
      }

      if (window.webContents.getURL() === expectedUrl) {
        settle('recovered');
        return;
      }

      settle('timed-out');
    }, timeoutMs);
    timeoutId.unref?.();
  });
}

export function classifyMainWindowLoadFailure({
  error,
  isQuitting,
  hasLiveMainWindow,
}: ClassifyMainWindowLoadFailureInput): MainWindowLoadFailureDecision {
  const message = getLoadFailureMessage(error);
  const isAbortMessage = isMainWindowLoadAbortMessage(message);

  if (isAbortMessage && (isQuitting || !hasLiveMainWindow)) {
    return {
      shouldAbortWindowInitialization: true,
      reason: 'teardown-load-abort',
      message,
    };
  }

  return {
    shouldAbortWindowInitialization: false,
    reason: 'unexpected-load-failure',
    message,
  };
}
