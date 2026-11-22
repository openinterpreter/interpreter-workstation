import { afterEach, describe, expect, test } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import {
  DEVICE_SESSION_COOKIE,
  DEVICE_SESSION_SECONDS,
  parseDeviceGatewayPort,
  parseDeviceGatewayPublicOrigin,
  startDeviceGateway,
  startDeviceGatewayFromEnvironment,
} from './deviceGateway';
import { DeviceRegistry, type PairedDevice } from './deviceRegistry';
import { CLIENT_DEVICE_HEADER, DEVICE_GATEWAY_TOKEN_HEADER, getDeviceGatewayToken } from './gatewayTrust';

const PUBLIC_ORIGIN = 'https://devices.example';
const closers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

type Seen = { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string };

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('No address');
  return address.port;
}

/** Stands in for the app server's loopback listener. */
async function startUpstream() {
  const seen: Seen[] = [];
  const upgrades: http.IncomingHttpHeaders[] = [];
  let releaseEvents: (() => void) | null = null;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      seen.push({ method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
      if (request.url === '/api/events') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        response.write('event: ready\ndata: one\n\n');
        releaseEvents = () => response.end('event: done\ndata: two\n\n');
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  server.on('upgrade', (request, socket) => {
    upgrades.push(request.headers);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.pipe(socket);
    socket.on('error', () => socket.destroy());
  });
  const port = await listen(server);
  return { port, seen, upgrades, releaseEvents: () => releaseEvents?.() };
}

async function startTestGateway(access: 'read-write' | 'read-only' = 'read-write') {
  const upstream = await startUpstream();
  let stored: PairedDevice[] = [];
  const registry = new DeviceRegistry({ read: async () => stored, write: async (devices) => { stored = devices; } });
  const gateway = await startDeviceGateway({
    port: 0,
    upstreamOrigin: `http://127.0.0.1:${upstream.port}`,
    publicOrigin: PUBLIC_ORIGIN,
    access: () => access,
    devices: registry,
    gatewayToken: getDeviceGatewayToken(),
  });
  closers.push(() => gateway.close());
  return { gateway, upstream, registry };
}

function send(port: number, options: { method?: string; path?: string; headers?: Record<string, string>; body?: string }) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      method: options.method ?? 'GET',
      path: options.path ?? '/',
      headers: options.headers,
      agent: false,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('error', reject);
    request.end(options.body);
  });
}

async function pair(port: number, registry: DeviceRegistry, label = 'Phone') {
  const { code } = registry.createPairingCode({ label });
  const response = await send(port, {
    method: 'POST',
    path: '/api/device-connections/claim',
    headers: { Origin: PUBLIC_ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const setCookie = response.headers['set-cookie']?.[0] ?? '';
  return { response, setCookie, cookie: setCookie.split(';')[0], code };
}

function rawUpgrade(port: number, headers: string[]) {
  return new Promise<{ socket: net.Socket; head: string }>((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let received = '';
    socket.on('error', reject);
    socket.on('connect', () => {
      socket.write([
        'GET /api/socket HTTP/1.1',
        'Host: devices.example',
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        ...headers,
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

describe('device gateway pairing', () => {
  test('serves the pairing page without a session and keeps the code out of requests', async () => {
    const { gateway } = await startTestGateway();
    const page = await send(gateway.port, { path: '/pair' });
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.body).toContain('/pair.js');
    const script = await send(gateway.port, { path: '/pair.js' });
    expect(script.status).toBe(200);
    expect(script.body).toContain('location.hash');
    expect(script.body).toContain('/api/device-connections/claim');
  });

  test('exchanges a code once for a long-lived HttpOnly, Secure, SameSite=Lax device cookie', async () => {
    const { gateway, registry } = await startTestGateway('read-write');
    const { response, setCookie, code } = await pair(gateway.port, registry);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ location: '/?surface=workstation&access=read-write&auth=password' });
    expect(setCookie.startsWith(`${DEVICE_SESSION_COOKIE}=dev_`)).toBe(true);
    for (const attribute of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax', `Max-Age=${DEVICE_SESSION_SECONDS}`]) {
      expect(setCookie).toContain(attribute);
    }

    const reused = await send(gateway.port, {
      method: 'POST',
      path: '/api/device-connections/claim',
      headers: { Origin: PUBLIC_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(reused.status).toBe(401);
    expect(reused.headers['set-cookie']).toBeUndefined();
  });

  test('refuses a claim from another origin', async () => {
    const { gateway, registry } = await startTestGateway();
    const { code } = registry.createPairingCode();
    const response = await send(gateway.port, {
      method: 'POST',
      path: '/api/device-connections/claim',
      headers: { Origin: 'https://elsewhere.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(response.status).toBe(403);
    expect(await registry.claim(code)).not.toBeNull();
  });
});

describe('device gateway access', () => {
  test('answers 401 with no detail without a valid device session', async () => {
    const { gateway, upstream } = await startTestGateway();
    const cases: Array<Record<string, string>> = [
      {},
      { Cookie: `${DEVICE_SESSION_COOKIE}=dev_abcdefghijklmnop.${'A'.repeat(43)}` },
    ];
    for (const headers of cases) {
      const response = await send(gateway.port, { path: '/api/read', headers });
      expect(response.status).toBe(401);
      expect(response.body).toBe('');
    }
    expect((await send(gateway.port, { path: '/' })).status).toBe(401);
    expect(upstream.seen).toHaveLength(0);
  });

  test('forwards with the trusted device header and strips client-supplied identity', async () => {
    const { gateway, upstream, registry } = await startTestGateway();
    const { cookie } = await pair(gateway.port, registry);
    const deviceId = (await registry.list())[0].id;

    const response = await send(gateway.port, {
      path: '/api/read?x=1',
      headers: {
        Host: 'devices.example',
        Cookie: `${cookie}; theme=dark`,
        [CLIENT_DEVICE_HEADER]: 'dev_spoofedspoofed',
        [DEVICE_GATEWAY_TOKEN_HEADER]: 'spoofed',
        'X-Forwarded-Host': 'attacker.example',
      },
    });
    expect(response.status).toBe(200);
    const seen = upstream.seen.at(-1)!;
    expect(seen.url).toBe('/api/read?x=1');
    expect(seen.headers[CLIENT_DEVICE_HEADER]).toBe(deviceId);
    expect(seen.headers[DEVICE_GATEWAY_TOKEN_HEADER]).toBe(getDeviceGatewayToken());
    expect(seen.headers['x-forwarded-host']).toBe('devices.example');
    expect(seen.headers['x-forwarded-proto']).toBe('https');
    expect(seen.headers.host).toBe(`127.0.0.1:${upstream.port}`);
    expect(seen.headers.cookie).toBe('theme=dark');
  });

  test('requires the public Origin for state-changing requests', async () => {
    const { gateway, upstream, registry } = await startTestGateway();
    const { cookie } = await pair(gateway.port, registry);
    const missing = await send(gateway.port, { method: 'POST', path: '/api/write', headers: { Cookie: cookie } });
    expect(missing.status).toBe(403);
    const foreign = await send(gateway.port, {
      method: 'POST', path: '/api/write', headers: { Cookie: cookie, Origin: 'https://elsewhere.example' },
    });
    expect(foreign.status).toBe(403);
    expect(upstream.seen).toHaveLength(0);

    const allowed = await send(gateway.port, {
      method: 'POST',
      path: '/api/write',
      headers: { Cookie: cookie, Origin: PUBLIC_ORIGIN, 'Content-Type': 'application/json' },
      body: '{"message":"hello"}',
    });
    expect(allowed.status).toBe(200);
    expect(upstream.seen.at(-1)).toMatchObject({ method: 'POST', body: '{"message":"hello"}' });
  });

  test('answers the connection descriptor so the normal shell mounts without a password form', async () => {
    const { gateway, upstream, registry } = await startTestGateway('read-only');
    const { cookie } = await pair(gateway.port, registry);
    const response = await send(gateway.port, { path: '/api/workstation-connection', headers: { Cookie: cookie } });
    expect(JSON.parse(response.body)).toEqual({
      schemaVersion: 1,
      host: 'remote',
      access: 'read-only',
      authentication: { method: 'password', required: true, authenticated: true },
    });
    expect(upstream.seen).toHaveLength(0);
  });

  test('refuses a revoked device, including after signing out on the device', async () => {
    const { gateway, registry } = await startTestGateway();
    const first = await pair(gateway.port, registry);
    expect((await send(gateway.port, { path: '/api/read', headers: { Cookie: first.cookie } })).status).toBe(200);
    await registry.revoke((await registry.list())[0].id);
    expect((await send(gateway.port, { path: '/api/read', headers: { Cookie: first.cookie } })).status).toBe(401);

    const second = await pair(gateway.port, registry);
    const signOut = await send(gateway.port, {
      method: 'DELETE',
      path: '/api/workstation-connection/session',
      headers: { Cookie: second.cookie, Origin: PUBLIC_ORIGIN },
    });
    expect(signOut.status).toBe(200);
    expect(signOut.headers['set-cookie']?.[0]).toContain('Max-Age=0');
    expect(await registry.list()).toEqual([]);
    expect((await send(gateway.port, { path: '/api/read', headers: { Cookie: second.cookie } })).status).toBe(401);
  });

  test('streams server-sent events before the upstream response ends', async () => {
    const { gateway, upstream, registry } = await startTestGateway();
    const { cookie } = await pair(gateway.port, registry);
    const firstChunk = await new Promise<{ status: number; type: string | undefined; chunk: string }>((resolve, reject) => {
      const request = http.request({
        host: '127.0.0.1', port: gateway.port, path: '/api/events', headers: { Cookie: cookie }, agent: false,
      }, (response) => {
        response.once('data', (chunk: Buffer) => {
          resolve({ status: response.statusCode ?? 0, type: response.headers['content-type'], chunk: chunk.toString('utf8') });
          upstream.releaseEvents();
          response.resume();
        });
      });
      request.on('error', reject);
      request.end();
    });
    expect(firstChunk.status).toBe(200);
    expect(firstChunk.type).toBe('text/event-stream');
    expect(firstChunk.chunk).toContain('data: one');
  });

  test('passes an authenticated WebSocket upgrade from the public origin and refuses others', async () => {
    const { gateway, upstream, registry } = await startTestGateway();
    const { cookie } = await pair(gateway.port, registry);
    const deviceId = (await registry.list())[0].id;

    const accepted = await rawUpgrade(gateway.port, [`Origin: ${PUBLIC_ORIGIN}`, `Cookie: ${cookie}`, `${CLIENT_DEVICE_HEADER}: dev_spoofedspoofed`]);
    closers.push(() => { accepted.socket.destroy(); });
    expect(accepted.head.split('\r\n')[0]).toBe('HTTP/1.1 101 Switching Protocols');
    expect(upstream.upgrades.at(-1)?.[CLIENT_DEVICE_HEADER]).toBe(deviceId);
    expect(upstream.upgrades.at(-1)?.upgrade).toBe('websocket');
    const echoed = new Promise<string>((resolve) => accepted.socket.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8'))));
    accepted.socket.write('ping');
    expect(await echoed).toBe('ping');

    const anonymous = await rawUpgrade(gateway.port, [`Origin: ${PUBLIC_ORIGIN}`]);
    closers.push(() => { anonymous.socket.destroy(); });
    expect(anonymous.head.split('\r\n')[0]).toBe('HTTP/1.1 401 Unauthorized');

    const foreign = await rawUpgrade(gateway.port, ['Origin: https://elsewhere.example', `Cookie: ${cookie}`]);
    closers.push(() => { foreign.socket.destroy(); });
    expect(foreign.head.split('\r\n')[0]).toBe('HTTP/1.1 403 Forbidden');
    expect(upstream.upgrades).toHaveLength(1);
  });

  test('leaves the app server loopback listener unchanged', async () => {
    const { gateway, upstream, registry } = await startTestGateway();
    await pair(gateway.port, registry);
    const direct = await send(upstream.port, { path: '/api/read' });
    expect(direct.status).toBe(200);
    expect(upstream.seen.at(-1)?.headers[CLIENT_DEVICE_HEADER]).toBeUndefined();
    expect(gateway.host).toBe('127.0.0.1');
  });
});

describe('device gateway configuration', () => {
  test('starts only when configured and requires both variables', async () => {
    const dependencies = {
      upstreamOrigin: 'http://127.0.0.1:1',
      access: () => 'read-write' as const,
      devices: new DeviceRegistry({ read: async () => [], write: async () => undefined }),
      gatewayToken: getDeviceGatewayToken(),
    };
    await expect(startDeviceGatewayFromEnvironment(dependencies, {})).resolves.toBeNull();
    await expect(startDeviceGatewayFromEnvironment(dependencies, { INTERPRETER_DEVICE_GATEWAY_PORT: '5179' }))
      .rejects.toThrow('requires INTERPRETER_DEVICE_GATEWAY_PUBLIC_ORIGIN');
    await expect(startDeviceGatewayFromEnvironment(dependencies, { INTERPRETER_DEVICE_GATEWAY_PUBLIC_ORIGIN: PUBLIC_ORIGIN }))
      .rejects.toThrow('requires INTERPRETER_DEVICE_GATEWAY_PORT');
    expect(() => parseDeviceGatewayPort('51x')).toThrow();
    expect(() => parseDeviceGatewayPublicOrigin('http://devices.example')).toThrow();
    expect(parseDeviceGatewayPublicOrigin('https://devices.example/')).toBe(PUBLIC_ORIGIN);
  });
});
