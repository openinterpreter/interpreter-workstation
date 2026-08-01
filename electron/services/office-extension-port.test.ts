import { describe, expect, test } from 'bun:test';
import * as net from 'node:net';
import { ensurePortAvailableForStartup, isPortAvailableForDefaultListen } from './office-extension-port';

interface TestListener {
  server: net.Server;
  port: number;
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function getListeningPort(server: net.Server): number {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('failed to read test listener port');
  }
  return address.port;
}

async function startListener(
  options: net.ListenOptions,
  unsupportedErrorCodes: readonly string[] = []
): Promise<TestListener | null> {
  const server = net.createServer();
  const started = await new Promise<boolean>((resolve, reject): void => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code && unsupportedErrorCodes.includes(error.code)) {
        resolve(false);
        return;
      }
      reject(error);
    });
    server.listen(options, () => {
      resolve(true);
    });
  });

  if (!started) {
    return null;
  }

  return { server, port: getListeningPort(server) };
}

async function reserveAvailablePort(): Promise<number> {
  const listener = await startListener({ port: 0 });
  if (!listener) {
    throw new Error('failed to reserve test port');
  }

  try {
    return listener.port;
  } finally {
    await closeServer(listener.server);
  }
}

async function canListenWithDefaultHost(port: number): Promise<boolean> {
  const listener = await startListener({ port }, ['EADDRINUSE', 'EACCES']);
  if (!listener) {
    return false;
  }
  await closeServer(listener.server);
  return true;
}

describe('ensurePortAvailableForStartup', () => {
  test('returns immediately when port is available', async () => {
    let checkCount = 0;

    await ensurePortAvailableForStartup(
      38123,
      {
        checkPort: async () => {
          checkCount += 1;
          return true;
        },
        killProcessOnPort: async () => {
          throw new Error('kill should not be called');
        },
      },
      3
    );

    expect(checkCount).toBe(1);
  });

  test('kills the port before checking when startup requires a fresh listener', async () => {
    const killCalls: Array<{ port: number; waitForPortReleaseMs?: number }> = [];
    let checkCount = 0;

    await ensurePortAvailableForStartup(
      38123,
      {
        killBeforeCheck: true,
        checkPort: async () => {
          checkCount += 1;
          return true;
        },
        killProcessOnPort: async (port, options) => {
          killCalls.push({ port, waitForPortReleaseMs: options?.waitForPortReleaseMs });
        },
      },
      3
    );

    expect(killCalls).toEqual([{ port: 38123, waitForPortReleaseMs: 0 }]);
    expect(checkCount).toBe(1);
  });

  test('does not report a conflict for the pre-check kill when the port is free afterward', async () => {
    const conflicts: string[] = [];

    await ensurePortAvailableForStartup(
      38123,
      {
        killBeforeCheck: true,
        checkPort: async () => true,
        killProcessOnPort: async () => {},
        onPortConflict: (attempt, maxAttempts) => {
          conflicts.push(`${attempt}/${maxAttempts}`);
        },
      },
      3
    );

    expect(conflicts).toEqual([]);
  });

  test('keeps retrying after pre-check kill when the port is still occupied', async () => {
    const killCalls: Array<{ port: number; waitForPortReleaseMs?: number }> = [];
    const conflicts: string[] = [];
    let checkCount = 0;

    await ensurePortAvailableForStartup(
      38123,
      {
        killBeforeCheck: true,
        checkPort: async () => {
          checkCount += 1;
          return checkCount >= 3;
        },
        killProcessOnPort: async (port, options) => {
          killCalls.push({ port, waitForPortReleaseMs: options?.waitForPortReleaseMs });
        },
        onPortConflict: (attempt, maxAttempts) => {
          conflicts.push(`${attempt}/${maxAttempts}`);
        },
      },
      2
    );

    expect(killCalls).toEqual([
      { port: 38123, waitForPortReleaseMs: 0 },
      { port: 38123, waitForPortReleaseMs: undefined },
      { port: 38123, waitForPortReleaseMs: undefined },
    ]);
    expect(conflicts).toEqual(['1/2', '2/2']);
    expect(checkCount).toBe(3);
  });

  test('propagates pre-check kill failures before probing the port', async () => {
    let checkCount = 0;

    await expect(
      ensurePortAvailableForStartup(
        38123,
        {
          killBeforeCheck: true,
          checkPort: async () => {
            checkCount += 1;
            return true;
          },
          killProcessOnPort: async () => {
            throw new Error('kill failed');
          },
        },
        3
      )
    ).rejects.toThrow('kill failed');

    expect(checkCount).toBe(0);
  });

  test('does not throw when final kill frees the port', async () => {
    let checkCount = 0;
    let killCount = 0;

    await ensurePortAvailableForStartup(
      38123,
      {
        checkPort: async () => {
          checkCount += 1;
          return checkCount >= 4;
        },
        killProcessOnPort: async () => {
          killCount += 1;
        },
      },
      3
    );

    expect(killCount).toBe(3);
    expect(checkCount).toBe(4);
  });

  test('uses the final check when max attempts is zero', async () => {
    const conflicts: string[] = [];
    let checkCount = 0;
    let killCount = 0;

    await ensurePortAvailableForStartup(
      38123,
      {
        checkPort: async () => {
          checkCount += 1;
          return true;
        },
        killProcessOnPort: async () => {
          killCount += 1;
        },
        onPortConflict: (attempt, maxAttempts) => {
          conflicts.push(`${attempt}/${maxAttempts}`);
        },
      },
      0
    );

    expect(checkCount).toBe(1);
    expect(killCount).toBe(0);
    expect(conflicts).toEqual([]);
  });

  test('retries startup after the oo-editors EADDRINUSE report from issue 1786', async () => {
    const killedPorts: number[] = [];
    const conflicts: string[] = [];
    let checkCount = 0;

    await ensurePortAvailableForStartup(
      38123,
      {
        checkPort: async () => {
          checkCount += 1;
          return checkCount >= 2;
        },
        killProcessOnPort: async (port) => {
          killedPorts.push(port);
        },
        onPortConflict: (attempt, maxAttempts) => {
          conflicts.push(`${attempt}/${maxAttempts}`);
        },
      },
      3
    );

    expect(killedPorts).toEqual([38123]);
    expect(conflicts).toEqual(['1/3']);
  });

  test('throws when port remains unavailable after all attempts', async () => {
    let killCount = 0;
    let checkCount = 0;

    await expect(
      ensurePortAvailableForStartup(
        38123,
        {
          checkPort: async () => {
            checkCount += 1;
            return false;
          },
          killProcessOnPort: async () => {
            killCount += 1;
          },
        },
        3
      )
    ).rejects.toThrow('Port 38123 is still in use after 3 attempts');

    expect(killCount).toBe(3);
    expect(checkCount).toBe(4);
  });
});

describe('isPortAvailableForDefaultListen', () => {
  test('returns true when the port is free', async () => {
    const port = await reserveAvailablePort();
    await expect(isPortAvailableForDefaultListen(port)).resolves.toBe(true);
  });

  test('returns false when an IPv6-only listener already occupies the port', async () => {
    const listener = await startListener({ port: 0, host: '::', ipv6Only: true }, ['EAFNOSUPPORT']);
    if (!listener) {
      return;
    }

    try {
      await expect(isPortAvailableForDefaultListen(listener.port)).resolves.toBe(false);
    } finally {
      await closeServer(listener.server);
    }
  });

  test('returns false when a default listener already occupies the port', async () => {
    const listener = await startListener({ port: 0 });
    if (!listener) {
      return;
    }

    try {
      await expect(isPortAvailableForDefaultListen(listener.port)).resolves.toBe(false);
    } finally {
      await closeServer(listener.server);
    }
  });

  test('matches default listen semantics when IPv4 localhost already occupies the port', async () => {
    const listener = await startListener({ port: 0, host: '127.0.0.1' }, ['EADDRNOTAVAIL']);
    if (!listener) {
      return;
    }

    try {
      if (!(await canListenWithDefaultHost(listener.port))) {
        return;
      }

      await expect(isPortAvailableForDefaultListen(listener.port)).resolves.toBe(true);
    } finally {
      await closeServer(listener.server);
    }
  });
});
