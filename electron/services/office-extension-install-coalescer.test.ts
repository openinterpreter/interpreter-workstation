import { describe, expect, test } from 'bun:test';

import { createOfficeExtensionInstallCoalescer } from './office-extension-install-coalescer';

describe('createOfficeExtensionInstallCoalescer', () => {
  test('coalesces concurrent installs for the same target dir', async () => {
    const runInstall = createOfficeExtensionInstallCoalescer();
    let installCount = 0;
    let resolveInstall!: () => void;
    const installPromise = new Promise<void>((resolve) => {
      resolveInstall = resolve;
    });

    const first = runInstall('/tmp/oo-editors', async () => {
      installCount += 1;
      await installPromise;
    });
    const second = runInstall('/tmp/oo-editors', async () => {
      installCount += 1;
    });

    expect(installCount).toBe(1);

    resolveInstall();
    await Promise.all([first, second]);

    expect(installCount).toBe(1);
  });

  test('does not coalesce installs for different target dirs', async () => {
    const runInstall = createOfficeExtensionInstallCoalescer();
    let installCount = 0;

    await Promise.all([
      runInstall('/tmp/oo-editors-a', async () => {
        installCount += 1;
      }),
      runInstall('/tmp/oo-editors-b', async () => {
        installCount += 1;
      }),
    ]);

    expect(installCount).toBe(2);
  });
});
