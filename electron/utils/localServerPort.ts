import type { AddressInfo } from 'node:net';

const PREFERRED_SERVER_PORT_START = 5177;
const PREFERRED_SERVER_PORT_COUNT = 20;
const EPHEMERAL_SERVER_PORT = 0;

type LocalServerLike = {
  address: () => string | AddressInfo | null;
  listen: (port: number, host: string) => unknown;
  off: {
    (event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown;
    (event: 'listening', listener: () => void): unknown;
  };
  once: {
    (event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown;
    (event: 'listening', listener: () => void): unknown;
  };
};

function getLocalServerPortCandidates(): number[] {
  return [
    ...Array.from({ length: PREFERRED_SERVER_PORT_COUNT }, (_, i) => PREFERRED_SERVER_PORT_START + i),
    EPHEMERAL_SERVER_PORT,
  ];
}

function resolveListeningServerPort(address: string | AddressInfo | null, requestedPort: number): number {
  if (typeof address === 'object' && address !== null && Number.isInteger(address.port) && address.port > 0) {
    return address.port;
  }
  return requestedPort;
}

export function listenOnAvailableLocalPort(
  server: LocalServerLike,
  host: string,
  onRetry: (port: number, code: string) => void = () => {},
): Promise<number> {
  const ports = getLocalServerPortCandidates();

  return new Promise((resolve, reject) => {
    let portIndex = 0;

    const tryListen = () => {
      if (portIndex >= ports.length) {
        reject(new Error('No available port for local server'));
        return;
      }

      const requestedPort = ports[portIndex];
      const cleanup = () => {
        server.off('error', handleListenError);
        server.off('listening', handleListening);
      };
      const handleListenError = (err: NodeJS.ErrnoException) => {
        cleanup();
        if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
          onRetry(requestedPort, err.code);
          portIndex += 1;
          tryListen();
          return;
        }
        reject(err);
      };
      const handleListening = () => {
        cleanup();
        resolve(resolveListeningServerPort(server.address(), requestedPort));
      };

      server.once('error', handleListenError);
      server.once('listening', handleListening);
      server.listen(requestedPort, host);
    };

    tryListen();
  });
}
