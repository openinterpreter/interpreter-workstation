import { afterEach, describe, expect, test } from 'bun:test';
import http from 'node:http';
import {
  forwardedSimplePreviewHeaders,
  namespacedSimplePreviewSetCookie,
  namespacedSimplePreviewSetCookies,
  projectSimplePreviewCookies,
  simplePreviewCookiePrefix,
  simplePreviewUpgradeResponseHead,
} from './simplePreviewHeaders';
import { startSimplePreviewProxy } from './simplePreviewProxy';

const UPSTREAM = '127.0.0.1:43811';
const SCOPE_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const SCOPE_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const A = simplePreviewCookiePrefix(SCOPE_A);
const B = simplePreviewCookiePrefix(SCOPE_B);

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
    ], UPSTREAM, SCOPE_A);
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
    ], UPSTREAM, SCOPE_A);
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
  test('a cookie scope is lowercase letters and digits of bounded length', () => {
    expect(A).toBe(`interpreter_preview_app_${SCOPE_A}_`);
    for (const invalid of ['', 'short', 'UPPERCASE1', 'has_underscore', 'has-dash-1', 'a'.repeat(65), 'a=b;c d']) {
      expect(() => simplePreviewCookiePrefix(invalid)).toThrow();
    }
  });

  test('a project cookie is stored under that project\'s namespace and confined to the preview host', () => {
    expect(namespacedSimplePreviewSetCookie('theme=dark; Path=/; HttpOnly', SCOPE_A))
      .toBe(`${A}theme=dark; Path=/; HttpOnly`);
    expect(namespacedSimplePreviewSetCookie('cart=a=b; Domain=example.com; Secure; SameSite=Lax', SCOPE_A))
      .toBe(`${A}cart=a=b; Secure; SameSite=Lax`);
    expect(namespacedSimplePreviewSetCookie('empty=', SCOPE_A)).toBe(`${A}empty=`);
    for (const unusable of ['=value', 'no-separator', 'bad name=1', 'a,b=1', '"q"=1']) {
      expect(namespacedSimplePreviewSetCookie(unusable, SCOPE_A)).toBeNull();
    }
    expect(namespacedSimplePreviewSetCookies(undefined, SCOPE_A)).toEqual([]);
    expect(namespacedSimplePreviewSetCookies(['a=1', '=bad', 'b=2; Domain=.example.com'], SCOPE_A))
      .toEqual([`${A}a=1`, `${A}b=2`]);
  });

  test('only cookies in the project\'s namespace are returned, under their original names', () => {
    expect(projectSimplePreviewCookies('front_session=secret; theme=dark', SCOPE_A)).toBeNull();
    expect(projectSimplePreviewCookies(`front_session=secret; ${A}theme=dark; other=1; ${A}cart=3`, SCOPE_A))
      .toBe('theme=dark; cart=3');
    expect(projectSimplePreviewCookies(`${A}=nameless; ${A}`, SCOPE_A)).toBeNull();
  });

  test('one project\'s cookies are never sent to another project', () => {
    // Project A stored a session cookie; the browser keeps it after project B is selected.
    const browserCookies = `${A}session=a-secret; ${B}theme=light`;
    expect(projectSimplePreviewCookies(browserCookies, SCOPE_B)).toBe('theme=light');
    expect(projectSimplePreviewCookies(browserCookies, SCOPE_A)).toBe('session=a-secret');
    const toB = forwardedSimplePreviewHeaders(['Cookie', browserCookies], UPSTREAM, SCOPE_B);
    expect(toB).toEqual([['Host', UPSTREAM], ['Cookie', 'theme=light']]);
    expect(JSON.stringify(toB)).not.toContain('a-secret');
    // A project cannot claim another project's namespace by naming a cookie after its prefix.
    expect(namespacedSimplePreviewSetCookie(`${A}session=forged`, SCOPE_B)).toBe(`${B}${A}session=forged`);
    expect(projectSimplePreviewCookies(`${B}${A}session=forged`, SCOPE_A)).toBeNull();
  });

  test('a project cannot obtain or replace a front cookie by choosing its name', () => {
    const stored = namespacedSimplePreviewSetCookie('front_session=attacker; Domain=example.com; Path=/', SCOPE_A);
    expect(stored).toBe(`${A}front_session=attacker; Path=/`);
    const browserCookies = `front_session=real-front-credential; ${A}front_session=attacker`;
    expect(projectSimplePreviewCookies(browserCookies, SCOPE_A)).toBe('front_session=attacker');
    const forwarded = forwardedSimplePreviewHeaders(['Cookie', browserCookies], UPSTREAM, SCOPE_A);
    expect(forwarded).toEqual([['Host', UPSTREAM], ['Cookie', 'front_session=attacker']]);
    expect(JSON.stringify(forwarded)).not.toContain('real-front-credential');
  });
});

describe('Simple preview upgrade response head', () => {
  test('moves a cookie set on an accepted upgrade into the project namespace', () => {
    const head = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=',
      'Set-Cookie: front_session=attacker; Domain=example.com; Path=/',
      'set-cookie: theme=dark',
    ].join('\r\n');
    expect(simplePreviewUpgradeResponseHead(head, SCOPE_A)).toBe([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=',
      `Set-Cookie: ${A}front_session=attacker; Path=/`,
      `Set-Cookie: ${A}theme=dark`,
    ].join('\r\n'));
  });

  test('rewrites cookies whatever the status and drops unusable ones', () => {
    const rewritten = simplePreviewUpgradeResponseHead(
      ['HTTP/1.1 403 Forbidden', 'Set-Cookie: front_session=attacker', 'Set-Cookie: =bad', 'Content-Length: 0'].join('\r\n'),
      SCOPE_A,
    );
    expect(rewritten).toBe(['HTTP/1.1 403 Forbidden', `Set-Cookie: ${A}front_session=attacker`, 'Content-Length: 0'].join('\r\n'));
  });

  test('refuses a head it cannot rewrite safely', () => {
    for (const head of [
      'not http',
      'HTTP/1.1 101 Switching Protocols\r\nSet-Cookie: a=1\r\n continued=front_session',
      'HTTP/1.1 101 Switching Protocols\r\n\tfolded: x',
      'HTTP/1.1 101 Switching Protocols\r\nno separator here',
      'HTTP/1.1 101 Switching Protocols\r\nbad name: value',
      'HTTP/1.1 101 Switching Protocols\r\n: nameless',
    ]) {
      expect(simplePreviewUpgradeResponseHead(head, SCOPE_A)).toBeNull();
    }
  });
});

describe('Simple preview proxy request forwarding', () => {
  const closers: Array<() => Promise<void> | void> = [];
  afterEach(async () => { while (closers.length) await closers.pop()!(); });

  async function startUpstream(setCookie: string[]) {
    const seen: http.IncomingHttpHeaders[] = [];
    const server = http.createServer((request, response) => {
      seen.push(request.headers);
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'Set-Cookie': setCookie, 'Content-Type': 'text/plain' });
        response.end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return { port: (server.address() as { port: number }).port, seen };
  }

  function send(port: number, cookie: string) {
    return new Promise<{ status: number; setCookie: string[] }>((resolve, reject) => {
      const request = http.request({
        host: '127.0.0.1',
        port,
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
  }

  test('withholds front credentials even when the project names a cookie after the front\'s', async () => {
    const upstream = await startUpstream(['front_session=attacker; Domain=example.com; Path=/', 'theme=dark; Path=/']);
    const proxy = await startSimplePreviewProxy({
      port: 0, upstream: () => ({ port: upstream.port, cookieScope: SCOPE_A }),
    });
    closers.push(() => proxy.close());

    const first = await send(proxy.port, 'front_session=real-front-credential');
    expect(first.status).toBe(200);
    expect(first.setCookie).toEqual([`${A}front_session=attacker; Path=/`, `${A}theme=dark; Path=/`]);
    const second = await send(proxy.port, `front_session=real-front-credential; ${A}front_session=attacker; ${A}theme=dark`);
    expect(second.status).toBe(200);

    for (const headers of upstream.seen) {
      expect(headers.host).toBe(`127.0.0.1:${upstream.port}`);
      expect(headers.authorization).toBeUndefined();
      expect(headers['x-forwarded-for']).toBeUndefined();
      expect(headers['x-authenticated-user']).toBeUndefined();
      expect(headers.accept).toBe('text/html');
      expect(JSON.stringify(headers)).not.toContain('real-front-credential');
    }
    expect(upstream.seen[0].cookie).toBeUndefined();
    expect(upstream.seen[1].cookie).toBe('front_session=attacker; theme=dark');
  });

  test('after the selected project changes, the new project never receives the previous project\'s cookies', async () => {
    const projectA = await startUpstream(['session=a-secret; Path=/']);
    const projectB = await startUpstream(['theme=light; Path=/']);
    let selected = { port: projectA.port, cookieScope: SCOPE_A };
    const proxy = await startSimplePreviewProxy({ port: 0, upstream: () => selected });
    closers.push(() => proxy.close());

    const fromA = await send(proxy.port, '');
    expect(fromA.setCookie).toEqual([`${A}session=a-secret; Path=/`]);

    selected = { port: projectB.port, cookieScope: SCOPE_B };
    // The browser still holds project A's cookie on the shared preview origin.
    const fromB = await send(proxy.port, `${A}session=a-secret`);
    expect(fromB.setCookie).toEqual([`${B}theme=light; Path=/`]);
    expect(projectB.seen).toHaveLength(1);
    expect(projectB.seen[0].cookie).toBeUndefined();
    expect(JSON.stringify(projectB.seen[0])).not.toContain('a-secret');

    await send(proxy.port, `${A}session=a-secret; ${B}theme=light`);
    expect(projectB.seen[1].cookie).toBe('theme=light');
  });

  test('refuses to serve a project that has no usable cookie scope', async () => {
    const upstream = await startUpstream([]);
    const proxy = await startSimplePreviewProxy({
      port: 0, upstream: () => ({ port: upstream.port, cookieScope: 'Not A Scope' }),
    });
    closers.push(() => proxy.close());
    expect((await send(proxy.port, '')).status).toBe(503);
    expect(upstream.seen).toHaveLength(0);
  });
});
