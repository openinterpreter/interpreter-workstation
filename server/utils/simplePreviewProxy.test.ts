import { afterEach, describe, expect, test } from 'bun:test';
import http from 'node:http';
import net from 'node:net';
import {
  parseSimplePreviewProxyPort,
  parseSimplePreviewPublicOrigin,
  resolveSimplePreviewRuntimeUrl,
  startSimplePreviewProxy,
  startSimplePreviewProxyFromEnvironment,
  type SimplePreviewProxyHandle,
} from './simplePreviewProxy';
import { getServerLocalOrigin, setServerHost, setServerPort } from './serverPort';

const closers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (closers.length) await closers.pop()!();
  setServerHost('127.0.0.1');
  setServerPort(0);
});

async function listen(server: http.Server | net.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('No address');
  return address.port;
}

async function proxyTo(upstream: () => number | null): Promise<SimplePreviewProxyHandle> {
  const proxy = await startSimplePreviewProxy({ port: 0, upstream });
  closers.push(() => proxy.close());
  return proxy;
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

describe('Simple preview proxy', () => {
  test('binds loopback and forwards a request with the upstream Host and Origin', async () => {
    let seen: { method?: string; url?: string; host?: string; origin?: string; body?: string } = {};
    const upstream = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        seen = {
          method: request.method,
          url: request.url,
          host: request.headers.host,
          origin: request.headers.origin,
          body: Buffer.concat(chunks).toString('utf8'),
        };
        response.writeHead(201, { 'Content-Type': 'text/plain', 'X-Upstream': 'project' });
        response.end('from project');
      });
    });
    const upstreamPort = await listen(upstream);
    const proxy = await proxyTo(() => upstreamPort);

    expect(proxy.host).toBe('127.0.0.1');
    const response = await send(proxy.port, {
      method: 'POST',
      path: '/api/health?x=1',
      headers: { Host: 'preview.example', Origin: 'https://preview.example', 'Content-Type': 'text/plain' },
      body: 'hello',
    });

    expect(response.status).toBe(201);
    expect(response.headers['x-upstream']).toBe('project');
    expect(response.body).toBe('from project');
    expect(seen).toEqual({
      method: 'POST',
      url: '/api/health?x=1',
      host: `127.0.0.1:${upstreamPort}`,
      origin: `http://127.0.0.1:${upstreamPort}`,
      body: 'hello',
    });
  });

  // WebSocket upgrades are covered in simplePreviewProxy.vitest.test.ts, which
  // runs on Node, the runtime the standalone sidecar uses for this proxy.
  test('answers 503 when no project server is running', async () => {
    const proxy = await proxyTo(() => null);
    const response = await send(proxy.port, { path: '/' });
    expect(response.status).toBe(503);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain('not running');
  });

  test('starts only when the port variable is set and validates both variables', async () => {
    await expect(startSimplePreviewProxyFromEnvironment(() => null, {})).resolves.toBeNull();
    await expect(startSimplePreviewProxyFromEnvironment(() => null, {
      INTERPRETER_SIMPLE_PREVIEW_PUBLIC_ORIGIN: 'https://preview.example',
    })).rejects.toThrow('requires INTERPRETER_SIMPLE_PREVIEW_PROXY_PORT');
    expect(() => parseSimplePreviewProxyPort('80a')).toThrow();
    expect(() => parseSimplePreviewProxyPort('70000')).toThrow();
    expect(parseSimplePreviewProxyPort('5178')).toBe(5178);
    expect(() => parseSimplePreviewPublicOrigin('http://preview.example')).toThrow();
    expect(() => parseSimplePreviewPublicOrigin('https://preview.example/app')).toThrow();
    expect(parseSimplePreviewPublicOrigin('https://preview.example/')).toBe('https://preview.example');
  });
});

describe('Simple preview runtime URL', () => {
  const runtimeUrl = 'http://127.0.0.1:43811';
  const both = {
    INTERPRETER_SIMPLE_PREVIEW_PROXY_PORT: '5178',
    INTERPRETER_SIMPLE_PREVIEW_PUBLIC_ORIGIN: 'https://preview.example',
  };

  test('is rewritten only for a non-loopback Host when both variables are set', () => {
    expect(resolveSimplePreviewRuntimeUrl(runtimeUrl, { host: 'shell.example' }, both)).toBe('https://preview.example');
    expect(resolveSimplePreviewRuntimeUrl(runtimeUrl, { host: '127.0.0.1:5177', forwardedHost: 'shell.example' }, both))
      .toBe('https://preview.example');
    for (const host of ['127.0.0.1:5177', 'localhost:5177', '[::1]:5177', undefined]) {
      expect(resolveSimplePreviewRuntimeUrl(runtimeUrl, { host }, both)).toBe(runtimeUrl);
    }
    expect(resolveSimplePreviewRuntimeUrl(runtimeUrl, { host: 'shell.example' }, {
      INTERPRETER_SIMPLE_PREVIEW_PROXY_PORT: '5178',
    })).toBe(runtimeUrl);
    expect(resolveSimplePreviewRuntimeUrl(runtimeUrl, { host: 'shell.example' }, {
      INTERPRETER_SIMPLE_PREVIEW_PUBLIC_ORIGIN: 'https://preview.example',
    })).toBe(runtimeUrl);
    expect(resolveSimplePreviewRuntimeUrl(null, { host: 'shell.example' }, both)).toBeNull();
  });

  test('preserves the path and query the runtime URL carried', () => {
    expect(resolveSimplePreviewRuntimeUrl(`${runtimeUrl}/app?windowSessionKey=ws_1#top`, { host: 'shell.example' }, both))
      .toBe('https://preview.example/app?windowSessionKey=ws_1#top');
  });
});

describe('sidecar local origin', () => {
  test('is derived from the listening address, not from a request', () => {
    setServerPort(5177);
    expect(getServerLocalOrigin()).toBe('http://127.0.0.1:5177');
    setServerHost('0.0.0.0');
    expect(getServerLocalOrigin()).toBe('http://127.0.0.1:5177');
    setServerHost('::');
    expect(getServerLocalOrigin()).toBe('http://[::1]:5177');
    setServerHost('10.0.0.5');
    expect(getServerLocalOrigin()).toBe('http://10.0.0.5:5177');
  });
});
