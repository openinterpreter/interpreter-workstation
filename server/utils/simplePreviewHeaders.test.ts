import { afterEach, describe, expect, test } from 'bun:test';
import http from 'node:http';
import {
  forwardedSimplePreviewHeaders,
  namespacedSimplePreviewSetCookie,
  namespacedSimplePreviewSetCookies,
  projectSimplePreviewCookies,
  SIMPLE_PREVIEW_COOKIE_PREFIX as PREFIX,
} from './simplePreviewHeaders';
import { startSimplePreviewProxy } from './simplePreviewProxy';

const UPSTREAM = '127.0.0.1:43811';

function names(headers: Array<[string, string]>): string[] {
  return headers.map(([name]) => name.toLowerCase());
}

describe('Simple preview forwarded headers', () => {
  test('never forwards the front\'s credentials or identity headers', () => {
    const forwarded = forwardedSimplePreviewHeaders([
      'Host', 'preview.example',
      'Authorization', 'Bearer front-session',
      'Proxy-Authorization', 'Basic abc',
      'Cookie', 'front_session=secret; other=1',
      'X-Forwarded-For', '203.0.113.9',
      'X-Forwarded-Host', 'preview.example',
      'X-Forwarded-Proto', 'https',
      'Forwarded', 'for=203.0.113.9',
      'X-Real-IP', '203.0.113.9',
      'X-Authenticated-User', 'someone@example.com',
      'X-Auth-Request-Email', 'someone@example.com',
      'X-Custom-Front-Token', 'secret',
      'Referer', 'https://preview.example/page',
      'Accept', 'text/html',
    ], UPSTREAM);
    expect(forwarded).toEqual([['Host', UPSTREAM], ['Accept', 'text/html']]);
  });

  test('forwards what a project server needs, naming the project server as Host and Origin', () => {
    const forwarded = forwardedSimplePreviewHeaders([
      'Host', 'preview.example',
      'Origin', 'https://preview.example',
      'Content-Type', 'application/json',
      'Content-Length', '2',
      'Accept-Language', 'en',
      'If-None-Match', '"abc"',
      'Range', 'bytes=0-9',
      'User-Agent', 'Browser',
      'Sec-Fetch-Site', 'same-origin',
      'Sec-CH-UA-Mobile', '?1',
      'Next-Action', 'abc123',
      'Next-Router-State-Tree', '%5B%5D',
      'RSC', '1',
      'x-nextjs-data', '1',
      'Upgrade', 'websocket',
      'Sec-WebSocket-Key', 'dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version', '13',
    ], UPSTREAM);
    expect(forwarded[0]).toEqual(['Host', UPSTREAM]);
    expect(forwarded).toContainEqual(['Origin', `http://${UPSTREAM}`]);
    expect(names(forwarded)).toEqual([
      'host', 'origin', 'content-type', 'content-length', 'accept-language', 'if-none-match', 'range',
      'user-agent', 'sec-fetch-site', 'sec-ch-ua-mobile', 'next-action', 'next-router-state-tree', 'rsc',
      'x-nextjs-data', 'upgrade', 'sec-websocket-key', 'sec-websocket-version',
    ]);
  });
});

describe('Simple preview project cookies', () => {
  test('a project cookie is stored under the project namespace and confined to the preview host', () => {
    expect(namespacedSimplePreviewSetCookie('theme=dark; Path=/; HttpOnly'))
      .toBe(`${PREFIX}theme=dark; Path=/; HttpOnly`);
    expect(namespacedSimplePreviewSetCookie('cart=a=b; Domain=example.com; Secure; SameSite=Lax'))
      .toBe(`${PREFIX}cart=a=b; Secure; SameSite=Lax`);
    expect(namespacedSimplePreviewSetCookie('empty=')).toBe(`${PREFIX}empty=`);
    for (const unusable of ['=value', 'no-separator', 'bad name=1', 'a,b=1', '"q"=1']) {
      expect(namespacedSimplePreviewSetCookie(unusable)).toBeNull();
    }
    expect(namespacedSimplePreviewSetCookies(undefined)).toEqual([]);
    expect(namespacedSimplePreviewSetCookies(['a=1', '=bad', 'b=2; Domain=.example.com']))
      .toEqual([`${PREFIX}a=1`, `${PREFIX}b=2`]);
  });

  test('only cookies in the project namespace are returned, under their original names', () => {
    expect(projectSimplePreviewCookies('front_session=secret; theme=dark')).toBeNull();
    expect(projectSimplePreviewCookies(`front_session=secret; ${PREFIX}theme=dark; other=1; ${PREFIX}cart=3`))
      .toBe('theme=dark; cart=3');
    expect(projectSimplePreviewCookies(`${PREFIX}=nameless; ${PREFIX}`)).toBeNull();
  });

  test('a project cannot obtain or replace a front cookie by choosing its name', () => {
    // The project sets a cookie named exactly like the front's session cookie.
    const stored = namespacedSimplePreviewSetCookie('front_session=attacker; Domain=example.com; Path=/');
    expect(stored).toBe(`${PREFIX}front_session=attacker; Path=/`);
    // The browser now holds both; only the project's own value goes back to it.
    const browserCookies = `front_session=real-front-credential; ${PREFIX}front_session=attacker`;
    expect(projectSimplePreviewCookies(browserCookies)).toBe('front_session=attacker');
    const forwarded = forwardedSimplePreviewHeaders(['Cookie', browserCookies], UPSTREAM);
    expect(forwarded).toEqual([['Host', UPSTREAM], ['Cookie', 'front_session=attacker']]);
    expect(JSON.stringify(forwarded)).not.toContain('real-front-credential');
  });
});

describe('Simple preview proxy request forwarding', () => {
  const closers: Array<() => Promise<void> | void> = [];
  afterEach(async () => { while (closers.length) await closers.pop()!(); });

  test('withholds front credentials even when the project names a cookie after the front\'s', async () => {
    const seen: http.IncomingHttpHeaders[] = [];
    const upstream = http.createServer((request, response) => {
      seen.push(request.headers);
      request.resume();
      request.on('end', () => {
        response.writeHead(200, {
          // A hostile project tries to claim the front's cookie name and widen its scope.
          'Set-Cookie': ['front_session=attacker; Domain=example.com; Path=/', 'theme=dark; Path=/'],
          'Content-Type': 'text/plain',
        });
        response.end('ok');
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startSimplePreviewProxy({ port: 0, upstream: () => upstreamPort });
    closers.push(() => proxy.close());

    const send = (cookie: string) => new Promise<{ status: number; setCookie: string[] }>((resolve, reject) => {
      const request = http.request({
        host: '127.0.0.1',
        port: proxy.port,
        path: '/',
        agent: false,
        headers: {
          Host: 'preview.example',
          Authorization: 'Bearer front-session',
          Cookie: cookie,
          'X-Forwarded-For': '203.0.113.9',
          'X-Authenticated-User': 'someone@example.com',
          Accept: 'text/html',
        },
      }, (response) => {
        response.resume();
        response.on('end', () => resolve({
          status: response.statusCode ?? 0,
          setCookie: response.headers['set-cookie'] ?? [],
        }));
      });
      request.on('error', reject);
      request.end();
    });

    const first = await send('front_session=real-front-credential');
    expect(first.status).toBe(200);
    // What the browser is told to store never uses the front's cookie name or a Domain.
    expect(first.setCookie).toEqual([`${PREFIX}front_session=attacker; Path=/`, `${PREFIX}theme=dark; Path=/`]);
    const second = await send(
      `front_session=real-front-credential; ${PREFIX}front_session=attacker; ${PREFIX}theme=dark`,
    );
    expect(second.status).toBe(200);

    for (const headers of seen) {
      expect(headers.host).toBe(`127.0.0.1:${upstreamPort}`);
      expect(headers.authorization).toBeUndefined();
      expect(headers['x-forwarded-for']).toBeUndefined();
      expect(headers['x-authenticated-user']).toBeUndefined();
      expect(headers.accept).toBe('text/html');
      expect(JSON.stringify(headers)).not.toContain('real-front-credential');
    }
    expect(seen[0].cookie).toBeUndefined();
    expect(seen[1].cookie).toBe('front_session=attacker; theme=dark');
  });
});
