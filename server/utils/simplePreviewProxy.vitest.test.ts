import { afterEach, describe, expect, test } from 'vitest';
import net from 'node:net';
import { startSimplePreviewProxy, type SimplePreviewProxyHandle } from './simplePreviewProxy';

const closers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('No address');
  return address.port;
}

async function proxyTo(upstream: () => number | null): Promise<SimplePreviewProxyHandle> {
  const proxy = await startSimplePreviewProxy({
    port: 0,
    upstream: () => {
      const port = upstream();
      return port === null ? null : { port, cookieScope: 'testscope' };
    },
  });
  closers.push(() => proxy.close());
  return proxy;
}

/** Writes a raw upgrade request and resolves with the socket and the response head. */
function upgrade(port: number, origin: string) {
  return new Promise<{ socket: net.Socket; head: string }>((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let received = '';
    socket.on('error', reject);
    socket.on('connect', () => {
      socket.write([
        'GET /_next/webpack-hmr?page=1 HTTP/1.1',
        'Host: preview.example',
        `Origin: ${origin}`,
        'Authorization: Bearer front-session',
        'Cookie: front_session=secret',
        'X-Forwarded-For: 203.0.113.9',
        'X-Authenticated-User: someone@example.com',
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        '', '',
      ].join('\r\n'));
    });
    const onData = (chunk: Buffer) => {
      received += chunk.toString('latin1');
      const end = received.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.off('data', onData);
      resolve({ socket, head: received.slice(0, end) });
    };
    socket.on('data', onData);
  });
}

describe('Simple preview proxy WebSocket upgrades', () => {
  test('forwards an upgrade with the upstream Host and Origin', async () => {
    let upstreamHead = '';
    const upstream = net.createServer((socket) => {
      let buffered = '';
      const onData = (chunk: Buffer) => {
        buffered += chunk.toString('latin1');
        const end = buffered.indexOf('\r\n\r\n');
        if (end < 0) return;
        socket.off('data', onData);
        upstreamHead = buffered.slice(0, end);
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
        const rest = buffered.slice(end + 4);
        if (rest) socket.write(rest);
        socket.pipe(socket);
      };
      socket.on('data', onData);
      socket.on('error', () => socket.destroy());
    });
    const upstreamPort = await listen(upstream);
    const proxy = await proxyTo(() => upstreamPort);

    const { socket, head } = await upgrade(proxy.port, 'https://preview.example');
    closers.push(() => { socket.destroy(); });
    expect(head.split('\r\n')[0]).toBe('HTTP/1.1 101 Switching Protocols');
    expect(upstreamHead.split('\r\n')[0]).toBe('GET /_next/webpack-hmr?page=1 HTTP/1.1');
    expect(upstreamHead).toContain(`Host: 127.0.0.1:${upstreamPort}`);
    expect(upstreamHead).toContain(`Origin: http://127.0.0.1:${upstreamPort}`);
    expect(upstreamHead).not.toContain('preview.example');
    expect(upstreamHead).toContain('Upgrade: websocket');
    expect(upstreamHead).toContain('Connection: Upgrade');
    expect(upstreamHead).toContain('Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==');
    // The front's credentials and identity headers never reach the project server.
    expect(upstreamHead.toLowerCase()).not.toContain('authorization');
    expect(upstreamHead.toLowerCase()).not.toContain('cookie');
    expect(upstreamHead.toLowerCase()).not.toContain('x-forwarded-for');
    expect(upstreamHead.toLowerCase()).not.toContain('x-authenticated-user');
    expect(upstreamHead).not.toContain('front-session');

    const echoed = new Promise<string>((resolve) => socket.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8'))));
    socket.write('ping');
    expect(await echoed).toBe('ping');
  });

  /** A project server that answers any upgrade request with the given raw response head. */
  function answering(responseHead: string, echo: boolean) {
    return net.createServer((socket) => {
      let buffered = '';
      const onData = (chunk: Buffer) => {
        buffered += chunk.toString('latin1');
        if (buffered.indexOf('\r\n\r\n') < 0) return;
        socket.off('data', onData);
        socket.write(`${responseHead}\r\n\r\n`);
        if (echo) socket.pipe(socket);
        else socket.end('refused');
      };
      socket.on('data', onData);
      socket.on('error', () => socket.destroy());
    });
  }

  test('a cookie set on an accepted upgrade is stored under the project namespace, and traffic still flows', async () => {
    const upstreamPort = await listen(answering([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Set-Cookie: front_session=attacker; Domain=example.com; Path=/',
    ].join('\r\n'), true));
    const proxy = await proxyTo(() => upstreamPort);

    const { socket, head } = await upgrade(proxy.port, 'https://preview.example');
    closers.push(() => { socket.destroy(); });
    expect(head.split('\r\n')[0]).toBe('HTTP/1.1 101 Switching Protocols');
    expect(head).toContain('Upgrade: websocket');
    // The front's cookie name never reaches the browser unprefixed, and no Domain widens it.
    expect(head).toContain('Set-Cookie: interpreter_preview_app_testscope_front_session=attacker; Path=/');
    expect(head).not.toMatch(/Set-Cookie: front_session=/i);
    expect(head.toLowerCase()).not.toContain('domain=');

    const echoed = new Promise<string>((resolve) => socket.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8'))));
    socket.write('ping');
    expect(await echoed).toBe('ping');
  });

  test('a refused upgrade is answered by the proxy itself, without the project\'s headers or body', async () => {
    const upstreamPort = await listen(answering([
      'HTTP/1.1 403 Forbidden',
      'Set-Cookie: front_session=attacker; Path=/',
      'Content-Type: text/plain',
    ].join('\r\n'), false));
    const proxy = await proxyTo(() => upstreamPort);

    const received = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(proxy.port, '127.0.0.1');
      closers.push(() => { socket.destroy(); });
      let all = '';
      socket.on('error', reject);
      socket.on('connect', () => {
        socket.write([
          'GET /_next/webpack-hmr HTTP/1.1',
          'Host: preview.example',
          'Origin: https://preview.example',
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          '', '',
        ].join('\r\n'));
      });
      socket.on('data', (chunk: Buffer) => { all += chunk.toString('latin1'); });
      socket.on('close', () => resolve(all));
    });
    expect(received.split('\r\n')[0]).toBe('HTTP/1.1 502 Bad Gateway');
    expect(received.toLowerCase()).not.toContain('set-cookie');
    expect(received).not.toContain('attacker');
    expect(received).not.toContain('refused');
  });

  test('a malformed upgrade answer is refused rather than passed through', async () => {
    const upstreamPort = await listen(answering([
      'HTTP/1.1 101 Switching Protocols',
      'Set-Cookie: a=1',
      ' continued=front_session',
    ].join('\r\n'), true));
    const proxy = await proxyTo(() => upstreamPort);
    const { socket, head } = await upgrade(proxy.port, 'https://preview.example');
    closers.push(() => { socket.destroy(); });
    expect(head.split('\r\n')[0]).toBe('HTTP/1.1 502 Bad Gateway');
    expect(head.toLowerCase()).not.toContain('set-cookie');
  });

  test('answers 503 to an upgrade when no project server is running', async () => {
    const proxy = await proxyTo(() => null);
    const { socket, head } = await upgrade(proxy.port, 'https://preview.example');
    closers.push(() => { socket.destroy(); });
    expect(head.split('\r\n')[0]).toBe('HTTP/1.1 503 Service Unavailable');
  });
});
