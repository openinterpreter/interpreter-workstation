import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { http as mockHttp, passthrough } from 'msw';
import { server as mockServer } from '../../tests/setup/msw-server';

// These tests talk to real listeners on loopback; let those requests through
// the suite-wide request mock, which otherwise rejects anything unhandled.
// The mock names a request by its Host header or by a path that begins with
// two slashes, so the public names these tests send to loopback pass too.
beforeEach(() => {
  mockServer.use(mockHttp.all(/^http:\/\/(127\.0\.0\.1:\d+|preview\.example|evil\.example)\//, () => passthrough()));
});
import {
  SIMPLE_PREVIEW_COOKIE,
  SIMPLE_PREVIEW_TICKET_SECONDS,
  createSimplePreviewTicket,
  startSimplePreviewProxy,
  startSimplePreviewProxyFromEnvironment,
  withSimplePreviewTicket,
  type SimplePreviewProxyHandle,
} from './simplePreviewProxy';
import { SIMPLE_PREVIEW_TICKET_PARAM } from '../../shared/simplePreview';

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

const SIGNING_KEY = 'preview-signing-key-for-tests-0123456789';

function get(port: number, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path, headers, agent: false }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('error', reject);
    request.end();
  });
}

async function protectedProxy(activeSubjects: Set<string>) {
  const seen: string[] = [];
  const upstream = http.createServer((request, response) => {
    seen.push(request.url ?? '');
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('project');
  });
  upstream.on('upgrade', (_request, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('error', () => socket.destroy());
    closers.push(() => { socket.destroy(); });
  });
  const upstreamPort = await listen(upstream);
  const proxy = await startSimplePreviewProxy({
    port: 0,
    upstream: () => ({ port: upstreamPort, cookieScope: 'testscope' }),
    access: { signingKey: SIGNING_KEY, isSubjectActive: (subject) => activeSubjects.has(subject) },
  });
  closers.push(() => proxy.close());
  return { proxy, seen };
}

describe('Simple preview proxy access for a public origin', () => {
  test('exchanges a ticket for a partitioned cookie, then admits the cookie', async () => {
    const { proxy, seen } = await protectedProxy(new Set(['device:dev_abcdefghijklmnop']));
    const ticket = createSimplePreviewTicket('device:dev_abcdefghijklmnop', SIGNING_KEY);
    const ticketed = new URL(withSimplePreviewTicket('https://preview.example/app?windowSessionKey=ws_1', ticket));

    const exchange = await get(proxy.port, `${ticketed.pathname}${ticketed.search}`);
    expect(exchange.status).toBe(302);
    expect(exchange.headers.location).toBe('/app?windowSessionKey=ws_1');
    const setCookie = exchange.headers['set-cookie']?.[0] ?? '';
    expect(setCookie.startsWith(`${SIMPLE_PREVIEW_COOKIE}=`)).toBe(true);
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=None', 'Partitioned', 'Path=/']) {
      expect(setCookie).toContain(attribute);
    }
    expect(seen).toHaveLength(0);

    const cookie = setCookie.split(';')[0];
    const page = await get(proxy.port, '/app?windowSessionKey=ws_1', { Cookie: cookie });
    expect(page.status).toBe(200);
    expect(page.body).toBe('project');
    expect(seen).toEqual(['/app?windowSessionKey=ws_1']);

    const ws = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(proxy.port, '127.0.0.1');
      closers.push(() => { socket.destroy(); });
      socket.on('error', reject);
      socket.on('connect', () => socket.write([
        'GET /_next/webpack-hmr HTTP/1.1', 'Host: preview.example', `Cookie: ${cookie}`,
        'Connection: Upgrade', 'Upgrade: websocket', '', '',
      ].join('\r\n')));
      socket.once('data', (chunk: Buffer) => resolve(chunk.toString('latin1').split('\r\n')[0]));
    });
    expect(ws).toBe('HTTP/1.1 101 Switching Protocols');
  });

  test('answers 401 without a ticket or cookie, with a forged ticket, or for a revoked subject', async () => {
    const active = new Set(['device:dev_abcdefghijklmnop']);
    const { proxy, seen } = await protectedProxy(active);
    expect((await get(proxy.port, '/')).status).toBe(401);

    const forged = createSimplePreviewTicket('device:dev_abcdefghijklmnop', 'another-key-0123456789abcdef');
    expect((await get(proxy.port, `/?${SIMPLE_PREVIEW_TICKET_PARAM}=${forged}`)).status).toBe(401);

    const expired = createSimplePreviewTicket('device:dev_abcdefghijklmnop', SIGNING_KEY, Date.now() - 10 * 60_000);
    expect((await get(proxy.port, `/?${SIMPLE_PREVIEW_TICKET_PARAM}=${expired}`)).status).toBe(401);

    const ticket = createSimplePreviewTicket('device:dev_abcdefghijklmnop', SIGNING_KEY);
    const exchange = await get(proxy.port, `/?${SIMPLE_PREVIEW_TICKET_PARAM}=${ticket}`);
    const cookie = (exchange.headers['set-cookie']?.[0] ?? '').split(';')[0];
    active.clear();
    expect((await get(proxy.port, '/', { Cookie: cookie })).status).toBe(401);

    const ws = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(proxy.port, '127.0.0.1');
      closers.push(() => { socket.destroy(); });
      socket.on('error', reject);
      socket.on('connect', () => socket.write([
        'GET /_next/webpack-hmr HTTP/1.1', 'Host: preview.example',
        'Connection: Upgrade', 'Upgrade: websocket', '', '',
      ].join('\r\n')));
      socket.once('data', (chunk: Buffer) => resolve(chunk.toString('latin1').split('\r\n')[0]));
    });
    expect(ws).toBe('HTTP/1.1 401 Unauthorized');
    expect(seen).toHaveLength(0);
  });

  test('accepts a ticket once and only for thirty seconds', async () => {
    expect(SIMPLE_PREVIEW_TICKET_SECONDS).toBe(30);
    const { proxy } = await protectedProxy(new Set(['device:dev_abcdefghijklmnop']));
    const ticket = createSimplePreviewTicket('device:dev_abcdefghijklmnop', SIGNING_KEY);
    const first = await get(proxy.port, `/?${SIMPLE_PREVIEW_TICKET_PARAM}=${ticket}`);
    expect(first.status).toBe(302);
    expect(first.headers['set-cookie']).toBeDefined();
    const replay = await get(proxy.port, `/?${SIMPLE_PREVIEW_TICKET_PARAM}=${ticket}`);
    expect(replay.status).toBe(401);
    expect(replay.headers['set-cookie']).toBeUndefined();

    const stale = createSimplePreviewTicket('device:dev_abcdefghijklmnop', SIGNING_KEY, Date.now() - 31_000);
    expect((await get(proxy.port, `/?${SIMPLE_PREVIEW_TICKET_PARAM}=${stale}`)).status).toBe(401);
  });

  test('never redirects to a scheme-relative location after removing the ticket', async () => {
    const { proxy } = await protectedProxy(new Set(['device:dev_abcdefghijklmnop']));
    for (const path of ['/.//evil.example/x', '//evil.example/x', '/a/..//evil.example']) {
      const ticket = createSimplePreviewTicket('device:dev_abcdefghijklmnop', SIGNING_KEY);
      const response = await get(proxy.port, `${path}?${SIMPLE_PREVIEW_TICKET_PARAM}=${ticket}`);
      expect(response.status).toBe(302);
      const location = String(response.headers.location);
      expect(location.startsWith('/')).toBe(true);
      expect(location.startsWith('//')).toBe(false);
    }
  });

  test('lets only the device gateway origin frame the preview', async () => {
    const upstream = http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<p>project</p>');
    });
    const upstreamPort = await listen(upstream);
    const proxy = await startSimplePreviewProxy({
      port: 0,
      upstream: () => ({ port: upstreamPort, cookieScope: 'testscope' }),
      access: { signingKey: SIGNING_KEY, isSubjectActive: () => true },
      frameAncestorOrigin: 'https://workstation.example',
    });
    closers.push(() => proxy.close());
    const exchange = await get(proxy.port, `/?${SIMPLE_PREVIEW_TICKET_PARAM}=${createSimplePreviewTicket('device:dev_abcdefghijklmnop', SIGNING_KEY)}`);
    const cookie = (exchange.headers['set-cookie']?.[0] ?? '').split(';')[0];
    const page = await get(proxy.port, '/', { Cookie: cookie });
    expect(page.status).toBe(200);
    expect(page.headers['content-security-policy']).toBe('frame-ancestors https://workstation.example');
    expect(page.headers['x-frame-options']).toBeUndefined();
  });

  test('refuses to start for a public origin without access control', async () => {
    await expect(startSimplePreviewProxyFromEnvironment(() => null, {
      INTERPRETER_SIMPLE_PREVIEW_PROXY_PORT: '5178',
      INTERPRETER_SIMPLE_PREVIEW_PUBLIC_ORIGIN: 'https://preview.example',
    })).rejects.toThrow('requires preview access control');
  });
});
