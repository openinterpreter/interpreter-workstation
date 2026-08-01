import http from 'node:http';
import { unlinkSync } from 'node:fs';
import { getInterpreterCliSocketPath } from './interpreterCliRuntime';

// A stale unix socket node must be removed before listen() (otherwise EADDRINUSE).
// rmSync routes through rimraf (lstat -> rmdir -> readdir); under concurrent startup on
// the shared fixed socket path, that multi-syscall window can readdir a node that is no
// longer a directory and throw ENOTDIR. unlinkSync removes the node in a single syscall.
// ENOENT (already gone) is the only benign case; anything else (EACCES, EPERM) must surface.
export function unlinkSocketIfPresent(socketPath: string): void {
  try {
    unlinkSync(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

export interface InterpreterCliSocketServerHandle {
  socketPath: string;
  close: () => Promise<void>;
}

export async function startInterpreterCliSocketServer(
  listener: http.RequestListener,
  port: number,
): Promise<InterpreterCliSocketServerHandle | null> {
  if (process.platform === 'win32') {
    return null;
  }

  const socketPath = getInterpreterCliSocketPath(port);
  unlinkSocketIfPresent(socketPath);

  if ('Bun' in globalThis) {
    const server = (globalThis as {
      Bun?: {
        serve: (options: {
          unix: string;
          fetch: (request: Request) => Promise<Response>;
        }) => { stop: (closeActiveConnections?: boolean) => void };
      };
    }).Bun?.serve({
      unix: socketPath,
      fetch: async (request: Request) => {
        const requestUrl = new URL(request.url);
        const targetUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, `http://127.0.0.1:${port}`);
        const init: RequestInit = {
          method: request.method,
          headers: request.headers,
        };
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          init.body = await request.arrayBuffer();
        }
        const response = await fetch(targetUrl, init);
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      },
    });

    if (!server) {
      throw new Error('Failed to start Bun interpreter CLI socket server.');
    }

    return {
      socketPath,
      close: async () => {
        server.stop(true);
        unlinkSocketIfPresent(socketPath);
      },
    };
  }

  const server = http.createServer(listener);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  return {
    socketPath,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      unlinkSocketIfPresent(socketPath);
    },
  };
}
