import { describe, expect, test } from 'bun:test';
import { performUpdateSwap, type UpdateSwapDeps } from './office-extension-update';

function createDeferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve: () => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createDeps(overrides: Partial<UpdateSwapDeps> = {}): { deps: UpdateSwapDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: UpdateSwapDeps = {
    getStartupPromise: () => null,
    hasServerProcess: () => false,
    isStarting: () => false,
    isServerRunning: async () => false,
    shutdown: async () => {
      calls.push('shutdown');
    },
    swap: () => {
      calls.push('swap');
    },
    restart: async () => {
      calls.push('restart');
    },
    ...overrides,
  };
  return { deps, calls };
}

describe('performUpdateSwap', () => {
  test('should await startupPromise before calling swap', async () => {
    const deferred = createDeferred();
    let startupPromise: Promise<void> | null = deferred.promise;
    const { deps, calls } = createDeps({
      getStartupPromise: () => startupPromise,
    });

    const updatePromise = performUpdateSwap(deps);
    await Promise.resolve();
    expect(calls).toEqual([]);

    startupPromise = null;
    deferred.resolve();
    await updatePromise;
    expect(calls).toEqual(['swap']);
  });

  test('should proceed with swap when startupPromise rejects', async () => {
    const deferred = createDeferred();
    let startupPromise: Promise<void> | null = deferred.promise;
    const { deps, calls } = createDeps({
      getStartupPromise: () => startupPromise,
    });

    const updatePromise = performUpdateSwap(deps);
    startupPromise = null;
    deferred.reject(new Error('startup failed'));
    await updatePromise;

    expect(calls).toEqual(['swap']);
  });

  test('should detect active server via hasServerProcess', async () => {
    const { deps, calls } = createDeps({
      hasServerProcess: () => true,
    });

    const result = await performUpdateSwap(deps);

    expect(result.wasActive).toBe(true);
    expect(calls).toEqual(['shutdown', 'swap', 'restart']);
  });

  test('should detect active server via isStarting', async () => {
    const { deps, calls } = createDeps({
      isStarting: () => true,
    });

    const result = await performUpdateSwap(deps);

    expect(result.wasActive).toBe(true);
    expect(calls).toEqual(['shutdown', 'swap', 'restart']);
  });

  test('should detect active server via startupPromise', async () => {
    const { deps, calls } = createDeps({
      getStartupPromise: () => Promise.resolve(),
    });

    const result = await performUpdateSwap(deps);

    expect(result.wasActive).toBe(true);
    expect(calls).toEqual(['shutdown', 'swap', 'restart']);
  });

  test('should detect active server via isServerRunning', async () => {
    const { deps, calls } = createDeps({
      isServerRunning: async () => true,
    });

    const result = await performUpdateSwap(deps);

    expect(result.wasActive).toBe(true);
    expect(calls).toEqual(['shutdown', 'swap', 'restart']);
  });

  test('should skip shutdown and restart when nothing is active', async () => {
    const { deps, calls } = createDeps();

    const result = await performUpdateSwap(deps);

    expect(result.wasActive).toBe(false);
    expect(calls).toEqual(['swap']);
  });

  test('should always call swap regardless of active state', async () => {
    const inactive = createDeps();
    await performUpdateSwap(inactive.deps);

    const active = createDeps({ hasServerProcess: () => true });
    await performUpdateSwap(active.deps);

    expect(inactive.calls).toContain('swap');
    expect(active.calls).toContain('swap');
  });

  test('should call shutdown then swap then restart when active', async () => {
    const { deps, calls } = createDeps({
      hasServerProcess: () => true,
    });

    await performUpdateSwap(deps);

    expect(calls).toEqual(['shutdown', 'swap', 'restart']);
  });

  test('should not call restart when shutdown throws', async () => {
    const calls: string[] = [];
    const { deps } = createDeps({
      hasServerProcess: () => true,
      shutdown: async () => {
        calls.push('shutdown');
        throw new Error('shutdown failed');
      },
      swap: () => {
        calls.push('swap');
      },
      restart: async () => {
        calls.push('restart');
      },
    });

    await expect(performUpdateSwap(deps)).rejects.toThrow('shutdown failed');
    expect(calls).toEqual(['shutdown']);
  });

  test('should retry swap when recoverFromSwapError returns true', async () => {
    const calls: string[] = [];
    let swapCalls = 0;
    const { deps } = createDeps({
      hasServerProcess: () => true,
      shutdown: async () => {
        calls.push('shutdown');
      },
      swap: async () => {
        swapCalls += 1;
        calls.push(`swap-${swapCalls}`);
        if (swapCalls === 1) {
          const error = new Error('busy') as Error & { code?: string };
          error.code = 'EBUSY';
          throw error;
        }
      },
      recoverFromSwapError: async () => {
        calls.push('recover');
        return true;
      },
      maxSwapAttempts: 2,
      restart: async () => {
        calls.push('restart');
      },
    });

    await performUpdateSwap(deps);
    expect(calls).toEqual(['shutdown', 'swap-1', 'recover', 'swap-2', 'restart']);
  });

  test('should throw swap error when recoverFromSwapError returns false', async () => {
    const calls: string[] = [];
    let swapCalls = 0;
    const { deps } = createDeps({
      swap: async () => {
        swapCalls += 1;
        calls.push(`swap-${swapCalls}`);
        throw new Error('busy');
      },
      recoverFromSwapError: async () => {
        calls.push('recover');
        return false;
      },
      maxSwapAttempts: 2,
    });

    await expect(performUpdateSwap(deps)).rejects.toThrow('busy');
    expect(calls).toEqual(['swap-1', 'recover']);
  });
});
