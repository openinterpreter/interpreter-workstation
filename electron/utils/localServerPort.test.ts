import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';

import {
  listenOnAvailableLocalPort,
} from './localServerPort';

class FakeServer extends EventEmitter {
  readonly listenCalls: number[] = [];
  private boundPort: number | null = null;

  constructor(
    private readonly errorByPort: Map<number, NodeJS.ErrnoException>,
    private readonly assignedPort: number,
  ) {
    super();
  }

  listen(port: number, _host: string): void {
    this.listenCalls.push(port);
    const error = this.errorByPort.get(port);
    if (error) {
      queueMicrotask(() => this.emit('error', error));
      return;
    }

    this.boundPort = port === 0 ? this.assignedPort : port;
    queueMicrotask(() => this.emit('listening'));
  }

  address(): { address: string; family: 'IPv4'; port: number } | null {
    if (this.boundPort === null) {
      return null;
    }
    return {
      address: '127.0.0.1',
      family: 'IPv4',
      port: this.boundPort,
    };
  }
}

function makeListenError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe('listenOnAvailableLocalPort', () => {
  test('falls back to an OS-assigned port after the preferred range is unavailable', async () => {
    const preferredPorts = Array.from({ length: 20 }, (_, i) => 5177 + i);
    const server = new FakeServer(
      new Map(preferredPorts.map((port) => [port, makeListenError('EACCES')])),
      49231,
    );
    const retries: Array<{ port: number; code: string }> = [];

    const port = await listenOnAvailableLocalPort(server, '127.0.0.1', (retryPort, code) => {
      retries.push({ port: retryPort, code });
    });

    expect(port).toBe(49231);
    expect(server.listenCalls).toEqual([...preferredPorts, 0]);
    expect(retries).toHaveLength(20);
    expect(retries.every((retry) => retry.code === 'EACCES')).toBe(true);
    expect(server.listenerCount('error')).toBe(0);
    expect(server.listenerCount('listening')).toBe(0);
  });

  test('rejects non-port listen failures without trying another port', async () => {
    const server = new FakeServer(new Map([[5177, makeListenError('EINVAL')]]), 49231);

    await expect(listenOnAvailableLocalPort(server, '127.0.0.1')).rejects.toMatchObject({
      code: 'EINVAL',
    });
    expect(server.listenCalls).toEqual([5177]);
    expect(server.listenerCount('error')).toBe(0);
    expect(server.listenerCount('listening')).toBe(0);
  });
});
