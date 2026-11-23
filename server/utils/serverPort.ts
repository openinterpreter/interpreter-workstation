/**
 * Server Port Utility
 *
 * Stores and retrieves the server port without circular dependencies.
 */

let serverPort = 0;
let serverHost = '127.0.0.1';

export function setServerPort(port: number): void {
  serverPort = port;
}

export function getServerPort(): number {
  return serverPort || 5177; // Default to 5177 if not set
}

/** Records the address the server binds. Defaults to loopback. */
export function setServerHost(host: string): void {
  serverHost = host.trim() || '127.0.0.1';
}

/**
 * The origin that local child processes use to reach this server. It is
 * derived from the listening address, never from a request's Host header, so
 * a browser reaching the server through another name cannot redirect them.
 */
export function getServerLocalOrigin(): string {
  const host = serverHost.replace(/^\[|\]$/g, '');
  const reachable = host === '0.0.0.0' || host === 'localhost'
    ? '127.0.0.1'
    : host === '::'
      ? '[::1]'
      : host.includes(':') ? `[${host}]` : host;
  return `http://${reachable}:${getServerPort()}`;
}
