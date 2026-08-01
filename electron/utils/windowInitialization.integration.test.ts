import { describe, expect, mock, test } from 'bun:test';

import { initializeCreatedWindow } from './windowInitialization';

function createWindow({
  setZoomFactorError,
  maximizeError,
  contentsDestroyCheckError,
  windowOffError,
  contentsOffError,
  windowDestroyed = false,
  contentsDestroyed = false,
}: {
  setZoomFactorError?: unknown;
  maximizeError?: unknown;
  contentsDestroyCheckError?: unknown;
  windowOffError?: unknown;
  contentsOffError?: unknown;
  windowDestroyed?: boolean;
  contentsDestroyed?: boolean;
} = {}) {
  const listeners = {
    closed: new Set<() => void>(),
    destroyed: new Set<() => void>(),
  };

  return {
    getListenerCounts: () => ({
      closed: listeners.closed.size,
      destroyed: listeners.destroyed.size,
    }),
    isDestroyed: () => windowDestroyed,
    once: (event: 'closed', listener: () => void) => {
      listeners[event].add(listener);
    },
    off: (event: 'closed', listener: () => void) => {
      if (windowOffError) {
        throw windowOffError;
      }
      listeners[event].delete(listener);
    },
    emitClosed: () => {
      for (const listener of listeners.closed) {
        listener();
      }
    },
    maximize: mock(() => {
      if (maximizeError) {
        throw maximizeError;
      }
    }),
    webContents: {
      isDestroyed: () => {
        if (contentsDestroyCheckError) {
          throw contentsDestroyCheckError;
        }
        return contentsDestroyed;
      },
      once: (event: 'destroyed', listener: () => void) => {
        listeners[event].add(listener);
      },
      off: (event: 'destroyed', listener: () => void) => {
        if (contentsOffError) {
          throw contentsOffError;
        }
        listeners[event].delete(listener);
      },
      emitDestroyed: () => {
        for (const listener of listeners.destroyed) {
          listener();
        }
      },
      setZoomFactor: mock((_factor: number) => {
        if (setZoomFactorError) {
          throw setZoomFactorError;
        }
      }),
    },
  };
}

describe('initializeCreatedWindow integration', () => {
  test('aborts initialization and runs cleanup once for explicit teardown races', async () => {
    const destroyedError = new Error('Object has been destroyed');

    for (const scenario of [
      {
        name: 'setZoomFactor',
        window: createWindow({ setZoomFactorError: destroyedError, contentsDestroyed: true }),
        loadContent: mock(async () => 'loaded' as const),
        registerWindow: mock(() => {}),
      },
      {
        name: 'maximize',
        window: createWindow({ maximizeError: destroyedError, windowDestroyed: true }),
        loadContent: mock(async () => 'loaded' as const),
        registerWindow: mock(() => {}),
      },
      {
        name: 'registerWindow',
        window: createWindow({ windowDestroyed: true }),
        loadContent: mock(async () => 'loaded' as const),
        registerWindow: mock(() => {
          throw destroyedError;
        }),
      },
      {
        name: 'loadContent',
        window: createWindow(),
        loadContent: mock(async () => 'aborted-during-teardown' as const),
        registerWindow: mock(() => {}),
      },
    ]) {
      const abortInitialization = mock(async () => {});
      const getZoomFactor = mock(async () => 1);

      const result = await initializeCreatedWindow(scenario.window, {
        abortInitialization,
        getZoomFactor,
        loadContent: scenario.loadContent,
        maximize: true,
        registerWindow: scenario.registerWindow,
      });

      expect(result, scenario.name).toBe('aborted-during-teardown');
      expect(abortInitialization, scenario.name).toHaveBeenCalledTimes(1);
    }
  });

  test('does not treat error text alone as teardown', async () => {
    const destroyedError = new Error('Object has been destroyed');

    await expect(
      initializeCreatedWindow(createWindow({ setZoomFactorError: destroyedError }), {
        abortInitialization: mock(async () => {}),
        getZoomFactor: mock(async () => 1),
        loadContent: mock(async () => 'loaded' as const),
        maximize: true,
        registerWindow: mock(() => {}),
      }),
    ).rejects.toThrow('Object has been destroyed');
  });

  test('aborts when content loading throws after teardown starts', async () => {
    const destroyedError = new Error('Object has been destroyed');
    const window = createWindow();
    const abortInitialization = mock(async () => {});
    const registerWindow = mock(() => {});

    const result = await initializeCreatedWindow(window, {
      abortInitialization,
      getZoomFactor: mock(async () => 1),
      loadContent: mock(async () => {
        window.emitClosed();
        throw destroyedError;
      }),
      maximize: true,
      registerWindow,
    });

    expect(result).toBe('aborted-during-teardown');
    expect(abortInitialization).toHaveBeenCalledTimes(1);
    expect(registerWindow).not.toHaveBeenCalled();
    expect(window.maximize).not.toHaveBeenCalled();
    expect(window.getListenerCounts()).toEqual({ closed: 0, destroyed: 0 });
  });

  test('aborts packaged index load failures only after observable teardown starts', async () => {
    for (const scenario of [
      {
        name: 'closed-window',
        message: "ERR_FAILED (-2) loading 'file:///C:/Program Files/Interpreter/resources/app.asar/dist/index.html'",
        emitTeardown: (window: ReturnType<typeof createWindow>) => window.emitClosed(),
      },
      {
        name: 'destroyed-web-contents',
        message: "ERR_ABORTED (-3) loading 'file:///opt/Interpreter/resources/app.asar/dist/index.html'",
        emitTeardown: (window: ReturnType<typeof createWindow>) => window.webContents.emitDestroyed(),
      },
    ]) {
      const window = createWindow();
      const abortInitialization = mock(async () => {});
      const registerWindow = mock(() => {});

      const result = await initializeCreatedWindow(window, {
        abortInitialization,
        getZoomFactor: mock(async () => 1),
        loadContent: mock(async () => {
          scenario.emitTeardown(window);
          throw new Error(scenario.message);
        }),
        maximize: true,
        registerWindow,
      });

      expect(result, scenario.name).toBe('aborted-during-teardown');
      expect(abortInitialization, scenario.name).toHaveBeenCalledTimes(1);
      expect(registerWindow, scenario.name).not.toHaveBeenCalled();
      expect(window.maximize, scenario.name).not.toHaveBeenCalled();
      expect(window.getListenerCounts(), scenario.name).toEqual({ closed: 0, destroyed: 0 });
    }
  });

  test('keeps non-teardown load failures loud and cleans listeners', async () => {
    const loadFailure = new Error(
      "ERR_FAILED (-2) loading 'file:///Applications/Interpreter.app/Contents/Resources/app.asar/dist/index.html'",
    );
    const window = createWindow();
    const abortInitialization = mock(async () => {});
    const registerWindow = mock(() => {});

    await expect(
      initializeCreatedWindow(window, {
        abortInitialization,
        getZoomFactor: mock(async () => 1),
        loadContent: mock(async () => {
          throw loadFailure;
        }),
        maximize: true,
        registerWindow,
      }),
    ).rejects.toBe(loadFailure);

    expect(abortInitialization).not.toHaveBeenCalled();
    expect(registerWindow).not.toHaveBeenCalled();
    expect(window.maximize).not.toHaveBeenCalled();
    expect(window.getListenerCounts()).toEqual({ closed: 0, destroyed: 0 });
  });

  test('cleans teardown listeners after successful initialization', async () => {
    const window = createWindow();
    const registerWindow = mock(() => {});

    const result = await initializeCreatedWindow(window, {
      abortInitialization: mock(async () => {}),
      getZoomFactor: mock(async () => 1.25),
      loadContent: mock(async () => 'loaded' as const),
      maximize: true,
      registerWindow,
    });

    expect(result).toBe('initialized');
    expect(window.webContents.setZoomFactor).toHaveBeenCalledWith(1.25);
    expect(window.maximize).toHaveBeenCalledTimes(1);
    expect(registerWindow).toHaveBeenCalledWith(window);
    expect(window.getListenerCounts()).toEqual({ closed: 0, destroyed: 0 });
  });

  test('uses explicit destroyed event when liveness probes throw during teardown', async () => {
    const window = createWindow({
      contentsDestroyCheckError: new Error('probe exploded'),
      setZoomFactorError: new Error('setZoom exploded'),
    });

    const getZoomFactor = mock(async () => {
      window.webContents.emitDestroyed();
      return 1;
    });

    const result = await initializeCreatedWindow(window, {
      abortInitialization: mock(async () => {}),
      getZoomFactor,
      loadContent: mock(async () => 'loaded' as const),
      maximize: true,
      registerWindow: mock(() => {}),
    });

    expect(result).toBe('aborted-during-teardown');
  });

  test('ignores destroyed-object errors while detaching teardown listeners for support issue 1949', async () => {
    const window = createWindow({
      windowOffError: new TypeError('Object has been destroyed'),
      contentsOffError: new TypeError('Object has been destroyed'),
    });
    const registerWindow = mock(() => {});

    const result = await initializeCreatedWindow(window, {
      abortInitialization: mock(async () => {}),
      getZoomFactor: mock(async () => 1),
      loadContent: mock(async () => 'loaded' as const),
      maximize: false,
      registerWindow,
    });

    expect(result).toBe('initialized');
    expect(registerWindow).toHaveBeenCalledTimes(1);
  });

  test('rethrows non-destroyed listener cleanup errors', async () => {
    await expect(
      initializeCreatedWindow(createWindow({ windowOffError: new Error('listener-detach-failed') }), {
        abortInitialization: mock(async () => {}),
        getZoomFactor: mock(async () => 1),
        loadContent: mock(async () => 'loaded' as const),
        maximize: false,
        registerWindow: mock(() => {}),
      }),
    ).rejects.toThrow('listener-detach-failed');
  });
});
