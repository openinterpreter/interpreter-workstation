/**
 * Server Port Utility
 *
 * Stores and retrieves the server port without circular dependencies.
 */

let serverPort = 0;

export function setServerPort(port: number): void {
  serverPort = port;
}

export function getServerPort(): number {
  return serverPort || 5177; // Default to 5177 if not set
}
