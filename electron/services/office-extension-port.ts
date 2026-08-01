import * as net from 'node:net';

interface EnsurePortAvailableOptions {
  checkPort: (port: number) => Promise<boolean>;
  killProcessOnPort: (port: number, options?: { waitForPortReleaseMs?: number }) => Promise<void>;
  killBeforeCheck?: boolean;
  onPortConflict?: (attempt: number, maxAttempts: number) => void;
}

const UNSUPPORTED_LISTEN_ERROR_CODES = new Set(['EAFNOSUPPORT', 'EADDRNOTAVAIL']);

function isUnsupportedListenError(error: unknown): error is NodeJS.ErrnoException {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return false;
  }

  const code = (error as NodeJS.ErrnoException).code;
  return Boolean(
    typeof code === 'string'
    && UNSUPPORTED_LISTEN_ERROR_CODES.has(code)
  );
}

function canListen(options: net.ListenOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', (error) => {
      resolve(isUnsupportedListenError(error));
    });

    server.once('listening', () => {
      server.close(() => {
        resolve(true);
      });
    });

    server.listen(options);
  });
}

export async function isPortAvailableForDefaultListen(port: number): Promise<boolean> {
  if (!(await canListen({ port }))) {
    return false;
  }

  return canListen({ port, host: '::', ipv6Only: true });
}

export async function ensurePortAvailableForStartup(
  port: number,
  options: EnsurePortAvailableOptions,
  maxAttempts: number = 3
): Promise<void> {
  if (options.killBeforeCheck) {
    await options.killProcessOnPort(port, { waitForPortReleaseMs: 0 });
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const portAvailable = await options.checkPort(port);
    if (portAvailable) {
      return;
    }

    options.onPortConflict?.(attempt, maxAttempts);
    await options.killProcessOnPort(port);
  }

  const portAvailableAfterFinalAttempt = await options.checkPort(port);
  if (portAvailableAfterFinalAttempt) {
    return;
  }

  throw new Error(`Port ${port} is still in use after ${maxAttempts} attempts`);
}
