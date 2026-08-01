import { describe, expect, test } from 'bun:test';

import { reloadAndWaitForPageLoadSignals, waitForPageLoadSignals } from './helpers';

function createDeferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createTimeoutError(message: string): Error {
  const error = new Error(message);
  error.name = 'TimeoutError';
  return error;
}

describe('waitForPageLoadSignals', () => {
  test('starts DOM and network-idle waits together and tolerates network-idle timeout', async () => {
    const dom = createDeferred();
    const networkIdle = createDeferred();
    const calls: Array<{ state: string; timeout?: number }> = [];

    const page = {
      waitForLoadState(state: 'domcontentloaded' | 'networkidle', options?: { timeout?: number }) {
        calls.push({ state, timeout: options?.timeout });
        if (state === 'domcontentloaded') {
          return dom.promise;
        }
        return networkIdle.promise;
      },
    };

    const waitPromise = waitForPageLoadSignals(page as never, { networkIdleTimeoutMs: 3210 });

    expect(calls).toEqual([
      { state: 'domcontentloaded', timeout: undefined },
      { state: 'networkidle', timeout: 3210 },
    ]);

    dom.resolve();
    networkIdle.reject(createTimeoutError('network stayed busy'));

    await waitPromise;
  });

  test('rethrows non-timeout network-idle failures', async () => {
    const dom = createDeferred();
    const networkIdle = createDeferred();

    const page = {
      waitForLoadState(state: 'domcontentloaded' | 'networkidle') {
        return state === 'domcontentloaded' ? dom.promise : networkIdle.promise;
      },
    };

    const waitPromise = waitForPageLoadSignals(page as never);

    dom.resolve();
    networkIdle.reject(new Error('renderer crashed'));

    await expect(waitPromise).rejects.toThrow('renderer crashed');
  });
});

describe('reloadAndWaitForPageLoadSignals', () => {
  test('starts DOM and network-idle waits before reloading the page', async () => {
    const dom = createDeferred();
    const networkIdle = createDeferred();
    const calls: Array<{ type: string; state?: string; waitUntil?: string; timeout?: number }> = [];

    const page = {
      waitForLoadState(state: 'domcontentloaded' | 'networkidle', options?: { timeout?: number }) {
        calls.push({ type: 'waitForLoadState', state, timeout: options?.timeout });
        return state === 'domcontentloaded' ? dom.promise : networkIdle.promise;
      },
      reload(options?: { waitUntil?: string }) {
        calls.push({ type: 'reload', waitUntil: options?.waitUntil });
        return Promise.resolve();
      },
    };

    const reloadPromise = reloadAndWaitForPageLoadSignals(page as never, { networkIdleTimeoutMs: 2100 });

    expect(calls).toEqual([
      { type: 'waitForLoadState', state: 'domcontentloaded', timeout: undefined },
      { type: 'waitForLoadState', state: 'networkidle', timeout: 2100 },
      { type: 'reload', waitUntil: 'commit' },
    ]);

    dom.resolve();
    networkIdle.reject(createTimeoutError('network stayed busy'));

    await reloadPromise;
  });
});
