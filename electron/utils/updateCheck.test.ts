import { describe, expect, test } from 'bun:test';
import { checkForUpdatesSafely } from './updateCheck';

describe('checkForUpdatesSafely', () => {
  async function flushUnhandledRejectionCheck(): Promise<void> {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  test('attaches a rejection handler to the detached download promise', async () => {
    let catchAttached = false;

    const updater = {
      async checkForUpdates() {
        return {
          downloadPromise: {
            catch(handler: (error: unknown) => void) {
              catchAttached = true;
              handler(new Error('ENOENT: app-update.yml missing'));
              return Promise.resolve();
            }
          } as unknown as Promise<unknown>
        };
      }
    };

    await checkForUpdatesSafely(updater);
    expect(catchAttached).toBe(true);
  });

  test('consumes detached real Promise rejections', async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const updater = {
        async checkForUpdates() {
          // electron-updater/out/AppUpdater.js `checkForUpdatesAndNotify` detaches
          // this promise via `void it.downloadPromise.then(...)` (no `.catch`).
          return {
            downloadPromise: Promise.reject(new Error('ENOENT: app-update.yml missing'))
          };
        }
      };

      await checkForUpdatesSafely(updater);
      await flushUnhandledRejectionCheck();
      expect(unhandledRejections).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  test('does nothing when download promise is missing', async () => {
    const updater = {
      async checkForUpdates() {
        return {};
      }
    };

    await expect(checkForUpdatesSafely(updater)).resolves.toBeUndefined();
  });

  test('propagates checkForUpdates failures to caller', async () => {
    const updater = {
      async checkForUpdates() {
        throw new Error('network unavailable');
      }
    };

    await expect(checkForUpdatesSafely(updater)).rejects.toThrow('network unavailable');
  });
});
