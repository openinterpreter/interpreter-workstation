/**
 * Simple preview origin.
 *
 * A Simple project's Next.js dev server listens on a dynamic loopback port and
 * has no base path, so it cannot be mounted under the sidecar's own origin.
 * When an operator sets INTERPRETER_SIMPLE_PREVIEW_PROXY_PORT, the sidecar
 * listens on that fixed loopback port and forwards every request and WebSocket
 * upgrade to the running project server. An authenticated HTTPS front can then
 * give the preview its own public origin (INTERPRETER_SIMPLE_PREVIEW_PUBLIC_ORIGIN).
 *
 * The proxy always binds 127.0.0.1. With a public origin it requires access:
 * the shell's runtime URL carries a short-lived, single-use signed ticket,
 * which the proxy exchanges for its own partitioned cookie (the shell's cookie
 * is not sent to another origin inside a frame). Without a public origin it
 * adds no authentication, so loopback use is unchanged.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { SIMPLE_PREVIEW_TICKET_PARAM } from '../../shared/simplePreview';
import {
  DEVICE_GATEWAY_PUBLIC_ORIGIN_ENV,
  parseDeviceGatewayPublicOrigin,
} from '../deviceConnections/deviceGateway';
import {
  forwardedSimplePreviewHeaders,
  namespacedSimplePreviewSetCookies,
  simplePreviewCookiePrefix,
  simplePreviewUpgradeResponseHead,
} from './simplePreviewHeaders';

export const SIMPLE_PREVIEW_PROXY_PORT_ENV = 'INTERPRETER_SIMPLE_PREVIEW_PROXY_PORT';
export const SIMPLE_PREVIEW_PUBLIC_ORIGIN_ENV = 'INTERPRETER_SIMPLE_PREVIEW_PUBLIC_ORIGIN';
export const SIMPLE_PREVIEW_COOKIE = 'interpreter_preview_session';
export const SIMPLE_PREVIEW_TICKET_SECONDS = 30;
export const SIMPLE_PREVIEW_COOKIE_SECONDS = 12 * 60 * 60;
/** Used tickets remembered until they expire; past this, new tickets are refused. */
export const MAX_REMEMBERED_PREVIEW_TICKETS = 10_000;

const LOOPBACK_HOST = '127.0.0.1';
const UNAVAILABLE_MESSAGE = 'The interface project is not running.\n';
const HOP_BY_HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-connection']);
const MAX_UPGRADE_RESPONSE_HEAD_BYTES = 64 * 1024;

/**
 * Access control for a publicly reachable preview. `subject` names who the
 * ticket was issued to (for example a paired device); a subject that is no
 * longer active is refused even with an unexpired ticket or cookie.
 */
export type SimplePreviewAccess = {
  signingKey: string;
  isSubjectActive?: (subject: string) => boolean | Promise<boolean>;
  now?: () => number;
};

type TokenKind = 't1' | 'p1';

function tokenSignature(payload: string, signingKey: string): string {
  return createHmac('sha256', signingKey).update(payload).digest('base64url');
}

function createToken(kind: TokenKind, subject: string, seconds: number, signingKey: string, now: number): string {
  const expiresAt = Math.floor(now / 1000) + seconds;
  const nonce = randomBytes(12).toString('base64url');
  const payload = `${kind}.${Buffer.from(subject, 'utf8').toString('base64url')}.${expiresAt}.${nonce}`;
  return `${payload}.${tokenSignature(payload, signingKey)}`;
}

/** Nonces of tickets already exchanged, with their expiry (seconds). */
const usedTickets = new Map<string, number>();

/** Marks a ticket used; false when it was used before or no more can be remembered. */
function consumeTicket(nonce: string, expiresAt: number, nowSeconds: number): boolean {
  if (usedTickets.has(nonce)) return false;
  if (usedTickets.size >= MAX_REMEMBERED_PREVIEW_TICKETS) {
    for (const [used, expiry] of usedTickets) {
      if (expiry <= nowSeconds) usedTickets.delete(used);
    }
    if (usedTickets.size >= MAX_REMEMBERED_PREVIEW_TICKETS) return false;
  }
  usedTickets.set(nonce, expiresAt);
  return true;
}

type VerifiedToken = { subject: string; nonce: string; expiresAt: number; nowSeconds: number };

function safeEqual(actual: string, expected: string): boolean {
  const actualHash = createHash('sha256').update(actual).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

async function verifyToken(
  kind: TokenKind,
  value: string | null,
  access: SimplePreviewAccess,
): Promise<VerifiedToken | null> {
  if (!value) return null;
  const match = /^(t1|p1)\.([A-Za-z0-9_-]{1,256})\.(\d{1,12})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!match || match[1] !== kind) return null;
  const payload = `${match[1]}.${match[2]}.${match[3]}.${match[4]}`;
  if (!safeEqual(match[5], tokenSignature(payload, access.signingKey))) return null;
  const now = access.now?.() ?? Date.now();
  const nowSeconds = Math.floor(now / 1000);
  const expiresAt = Number(match[3]);
  if (expiresAt <= nowSeconds) return null;
  const subject = Buffer.from(match[2], 'base64url').toString('utf8');
  if (access.isSubjectActive && !(await access.isSubjectActive(subject))) return null;
  return { subject, nonce: match[4], expiresAt, nowSeconds };
}

/** A short-lived, single-use ticket the preview origin exchanges for its own cookie. */
export function createSimplePreviewTicket(subject: string, signingKey: string, now = Date.now()): string {
  return createToken('t1', subject, SIMPLE_PREVIEW_TICKET_SECONDS, signingKey, now);
}

/** Adds a preview ticket to a public runtime URL. */
export function withSimplePreviewTicket(runtimeUrl: string, ticket: string): string {
  const url = new URL(runtimeUrl);
  url.searchParams.set(SIMPLE_PREVIEW_TICKET_PARAM, ticket);
  return url.toString();
}

function cookieValue(request: http.IncomingMessage, name: string): string | null {
  const header = request.headers.cookie;
  if (!header) return null;
  for (const item of header.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(item.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

type PreviewAuthorization =
  | { allowed: false }
  | { allowed: true; strippedUrl: string | null; cookie: string | null };

/**
 * Accepts a valid ticket (issuing a cookie) or a valid cookie. `strippedUrl`
 * is set when the request carried a ticket parameter that must be removed.
 */
async function authorizePreviewRequest(
  request: http.IncomingMessage,
  access: SimplePreviewAccess,
): Promise<PreviewAuthorization> {
  const url = new URL(request.url ?? '/', 'http://preview.invalid');
  const ticket = url.searchParams.get(SIMPLE_PREVIEW_TICKET_PARAM);
  let strippedUrl: string | null = null;
  if (ticket !== null) {
    url.searchParams.delete(SIMPLE_PREVIEW_TICKET_PARAM);
    // Collapse leading slashes so the redirect can never be scheme-relative.
    strippedUrl = `/${url.pathname.replace(/^[/\\]+/, '')}${url.search}`;
    const verified = await verifyToken('t1', ticket, access);
    if (verified && consumeTicket(verified.nonce, verified.expiresAt, verified.nowSeconds)) {
      const now = access.now?.() ?? Date.now();
      return {
        allowed: true,
        strippedUrl,
        cookie: createToken('p1', verified.subject, SIMPLE_PREVIEW_COOKIE_SECONDS, access.signingKey, now),
      };
    }
  }
  const verified = await verifyToken('p1', cookieValue(request, SIMPLE_PREVIEW_COOKIE), access);
  return verified ? { allowed: true, strippedUrl, cookie: null } : { allowed: false };
}

function previewCookieHeader(value: string): string {
  // The preview is framed by the shell on another origin; only a partitioned
  // SameSite=None cookie is sent back to it from inside that frame.
  return `${SIMPLE_PREVIEW_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=${SIMPLE_PREVIEW_COOKIE_SECONDS}`;
}

function respondUnauthorized(response: http.ServerResponse): void {
  response.writeHead(401, { 'Cache-Control': 'no-store', 'Content-Length': '0' });
  response.end();
}

function exactOriginRequired(request: http.IncomingMessage, origin: string): boolean {
  return request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS'
    && request.headers.origin !== origin;
}

/**
 * The running project server: its loopback port and a cookie scope that is
 * stable for that project and differs between projects.
 */
export type SimplePreviewUpstreamTarget = { port: number; cookieScope: string };

/** Resolves the running project server, or null when none is running. */
export type SimplePreviewUpstream = () =>
  Promise<SimplePreviewUpstreamTarget | null> | SimplePreviewUpstreamTarget | null;

export type SimplePreviewProxyHandle = {
  host: string;
  port: number;
  close: () => Promise<void>;
};

export function parseSimplePreviewProxyPort(value: string | undefined): number | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const port = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${SIMPLE_PREVIEW_PROXY_PORT_ENV} must be a TCP port number.`);
  }
  return port;
}

export function parseSimplePreviewPublicOrigin(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`${SIMPLE_PREVIEW_PUBLIC_ORIGIN_ENV} must be an absolute https:// origin.`);
  }
  if (url.protocol !== 'https:' || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${SIMPLE_PREVIEW_PUBLIC_ORIGIN_ENV} must be an absolute https:// origin.`);
  }
  return url.origin;
}

function isLoopbackHost(value: string | undefined): boolean {
  const host = value?.split(',')[0]?.trim().toLowerCase();
  if (!host) return true;
  const hostname = host.startsWith('[')
    ? host.slice(1, host.indexOf(']'))
    : host.replace(/:\d+$/, '');
  return hostname === 'localhost' || hostname === '::1' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

/**
 * Returns the runtime URL a renderer should load. A request that reached the
 * sidecar on a loopback Host (Electron, or a browser on the same computer)
 * keeps the real loopback URL. A request from another device receives the
 * configured public preview origin, but only when both preview variables are
 * set; otherwise the URL is returned unchanged.
 */
export function resolveSimplePreviewRuntimeUrl(
  runtimeUrl: string | null | undefined,
  request: { host?: string; forwardedHost?: string },
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!runtimeUrl) return runtimeUrl ?? null;
  let publicOrigin: string | null;
  try {
    if (parseSimplePreviewProxyPort(environment[SIMPLE_PREVIEW_PROXY_PORT_ENV]) === null) return runtimeUrl;
    publicOrigin = parseSimplePreviewPublicOrigin(environment[SIMPLE_PREVIEW_PUBLIC_ORIGIN_ENV]);
  } catch {
    return runtimeUrl;
  }
  if (!publicOrigin) return runtimeUrl;
  if (isLoopbackHost(request.host) && isLoopbackHost(request.forwardedHost)) return runtimeUrl;
  const source = new URL(runtimeUrl);
  const path = source.pathname === '/' ? '' : source.pathname;
  return `${publicOrigin}${path}${source.search}${source.hash}`;
}

// Only allowlisted headers and the project's own cookies go upstream; the
// front's credentials and identity headers never reach a project server.
function requestHeaders(rawHeaders: string[], upstreamHost: string, cookieScope: string): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of forwardedSimplePreviewHeaders(rawHeaders, upstreamHost, cookieScope)) {
    const lower = name.toLowerCase();
    if (lower === 'upgrade') continue; // Only an upgrade request carries it.
    const existing = headers[lower];
    headers[lower] = existing === undefined
      ? value
      : Array.isArray(existing) ? [...existing, value] : [String(existing), value];
  }
  return headers;
}

function upgradeRequestHead(request: http.IncomingMessage, upstreamHost: string, cookieScope: string): string {
  const lines = [`${request.method ?? 'GET'} ${request.url ?? '/'} HTTP/1.1`];
  for (const [name, value] of forwardedSimplePreviewHeaders(request.rawHeaders, upstreamHost, cookieScope)) {
    lines.push(`${name}: ${value}`);
  }
  lines.push('Connection: Upgrade');
  return `${lines.join('\r\n')}\r\n\r\n`;
}

// A target without a usable port or cookie scope is treated as no target, so
// a project is never served without its own cookie namespace.
async function resolveUpstream(upstream: SimplePreviewUpstream): Promise<SimplePreviewUpstreamTarget | null> {
  try {
    const target = await upstream();
    if (!target || !Number.isInteger(target.port) || target.port <= 0) return null;
    simplePreviewCookiePrefix(target.cookieScope);
    return { port: target.port, cookieScope: target.cookieScope };
  } catch {
    return null;
  }
}

function respondUnavailable(response: http.ServerResponse): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(503, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(UNAVAILABLE_MESSAGE);
}

/** Adds `frame-ancestors <origin>` so only the shell origin can frame the preview. */
function withFrameAncestors(headers: http.IncomingHttpHeaders, frameAncestor: string | null): http.OutgoingHttpHeaders {
  if (!frameAncestor) return headers;
  const policy = `frame-ancestors ${frameAncestor}`;
  const existing = headers['content-security-policy'];
  return {
    ...headers,
    // Several policies in one header value are all enforced, like separate headers.
    'content-security-policy': [
      ...(existing === undefined ? [] : Array.isArray(existing) ? existing : [existing]),
      policy,
    ].join(', '),
  };
}

async function forwardRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  upstream: SimplePreviewUpstream,
  access: SimplePreviewAccess | null,
  frameAncestor: string | null,
  publicOrigin: string | null,
): Promise<void> {
  if (access) {
    if (publicOrigin && exactOriginRequired(request, publicOrigin)) {
      request.resume();
      response.writeHead(403, { 'Cache-Control': 'no-store', 'Content-Length': '0' });
      response.end();
      return;
    }
    const authorization = await authorizePreviewRequest(request, access);
    if (!authorization.allowed) {
      request.resume();
      respondUnauthorized(response);
      return;
    }
    if (authorization.strippedUrl !== null) {
      request.resume();
      response.writeHead(302, {
        Location: authorization.strippedUrl,
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'Content-Length': '0',
        ...(authorization.cookie ? { 'Set-Cookie': previewCookieHeader(authorization.cookie) } : {}),
      });
      response.end();
      return;
    }
  }
  const target = await resolveUpstream(upstream);
  if (target === null) {
    request.resume();
    respondUnavailable(response);
    return;
  }
  const { port, cookieScope } = target;
  const upstreamHost = `${LOOPBACK_HOST}:${port}`;
  const proxied = http.request({
    host: LOOPBACK_HOST,
    port,
    method: request.method,
    path: request.url,
    headers: requestHeaders(request.rawHeaders, upstreamHost, cookieScope),
  }, (upstreamResponse) => {
    const headers = { ...upstreamResponse.headers };
    // Project cookies are stored under that project's own namespace (see simplePreviewHeaders).
    const setCookies = namespacedSimplePreviewSetCookies(headers['set-cookie'], cookieScope);
    if (setCookies.length > 0) headers['set-cookie'] = setCookies;
    else delete headers['set-cookie'];
    for (const name of HOP_BY_HOP_HEADERS) delete headers[name];
    response.writeHead(upstreamResponse.statusCode ?? 502, withFrameAncestors(headers, frameAncestor));
    upstreamResponse.pipe(response);
  });
  proxied.on('error', () => respondUnavailable(response));
  response.on('close', () => {
    if (!response.writableFinished) proxied.destroy();
  });
  request.pipe(proxied);
}

async function forwardUpgrade(
  request: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  upstream: SimplePreviewUpstream,
  access: SimplePreviewAccess | null,
  publicOrigin: string | null,
): Promise<void> {
  socket.on('error', () => socket.destroy());
  if (access) {
    if (request.headers.origin !== publicOrigin) {
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n', () => socket.destroy());
      return;
    }
    const authorization = await authorizePreviewRequest(request, access);
    if (!authorization.allowed) {
      // Nothing reads this socket again, so close it once the refusal is
      // written instead of waiting for the other side to finish.
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n', () => socket.destroy());
      return;
    }
    if (authorization.strippedUrl !== null) request.url = authorization.strippedUrl;
  }
  const resolved = await resolveUpstream(upstream);
  if (resolved === null) {
    const body = Buffer.from(UNAVAILABLE_MESSAGE);
    socket.end(
      'HTTP/1.1 503 Service Unavailable\r\n'
      + 'Content-Type: text/plain; charset=utf-8\r\n'
      + `Content-Length: ${body.length}\r\n`
      + 'Connection: close\r\n\r\n'
      + UNAVAILABLE_MESSAGE,
    );
    return;
  }
  const { port, cookieScope } = resolved;
  const upstreamHost = `${LOOPBACK_HOST}:${port}`;
  const target = net.connect(port, LOOPBACK_HOST);
  target.on('connect', () => {
    target.write(upgradeRequestHead(request, upstreamHost, cookieScope));
    if (head.length > 0) target.write(head);
    socket.pipe(target);
    // The project's answer to the upgrade is an HTTP response head like any
    // other. Its headers are rewritten before anything reaches the browser,
    // so a cookie set there lands in the project's own namespace too; only
    // after an accepted upgrade are the raw bytes piped.
    let pending = Buffer.alloc(0);
    const onHead = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      const end = pending.indexOf('\r\n\r\n');
      if (end < 0) {
        if (pending.length > MAX_UPGRADE_RESPONSE_HEAD_BYTES) {
          target.off('data', onHead);
          target.destroy();
          socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
        }
        return;
      }
      target.off('data', onHead);
      const rewritten = simplePreviewUpgradeResponseHead(pending.subarray(0, end).toString('latin1'), cookieScope);
      // Anything but an accepted upgrade is answered by the proxy itself and
      // the connection is closed. Passing a refusal through would leave an
      // ordinary HTTP connection open to the project server with no header
      // filtering on whatever followed.
      if (rewritten === null || !/^HTTP\/1\.[01] 101(?: |$)/.test(rewritten)) {
        target.destroy();
        socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
        return;
      }
      socket.write(Buffer.from(`${rewritten}\r\n\r\n`, 'latin1'));
      const rest = pending.subarray(end + 4);
      if (rest.length > 0) socket.write(rest);
      target.pipe(socket);
    };
    target.on('data', onHead);
  });
  target.on('error', () => socket.destroy());
  target.on('close', () => socket.destroy());
  socket.on('close', () => target.destroy());
}

export async function startSimplePreviewProxy(options: {
  port: number;
  upstream: SimplePreviewUpstream;
  /** Required for a publicly reachable preview; omitted for loopback-only use. */
  access?: SimplePreviewAccess | null;
  /** Exact origin required for state changes and connection upgrades. */
  publicOrigin?: string | null;
  /** The only origin allowed to frame the preview (the device gateway's public origin). */
  frameAncestorOrigin?: string | null;
}): Promise<SimplePreviewProxyHandle> {
  const access = options.access ?? null;
  const publicOrigin = options.publicOrigin ?? null;
  if (access && !publicOrigin) throw new Error('Public preview access requires its exact origin.');
  const frameAncestor = options.frameAncestorOrigin ?? null;
  const server = http.createServer((request, response) => {
    void forwardRequest(request, response, options.upstream, access, frameAncestor, publicOrigin);
  });
  server.on('upgrade', (request, socket, head) => {
    void forwardUpgrade(request, socket, head, options.upstream, access, publicOrigin);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, LOOPBACK_HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  return {
    host: typeof address === 'object' && address ? address.address : LOOPBACK_HOST,
    port: typeof address === 'object' && address ? address.port : options.port,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}

/**
 * Starts the preview proxy when the environment asks for it; otherwise returns
 * null. A public origin requires `access`, which is resolved only then.
 */
export async function startSimplePreviewProxyFromEnvironment(
  upstream: SimplePreviewUpstream,
  environment: NodeJS.ProcessEnv = process.env,
  access?: () => Promise<SimplePreviewAccess> | SimplePreviewAccess,
): Promise<SimplePreviewProxyHandle | null> {
  const port = parseSimplePreviewProxyPort(environment[SIMPLE_PREVIEW_PROXY_PORT_ENV]);
  const publicOrigin = parseSimplePreviewPublicOrigin(environment[SIMPLE_PREVIEW_PUBLIC_ORIGIN_ENV]);
  if (port === null) {
    if (publicOrigin) {
      throw new Error(`${SIMPLE_PREVIEW_PUBLIC_ORIGIN_ENV} requires ${SIMPLE_PREVIEW_PROXY_PORT_ENV}.`);
    }
    return null;
  }
  if (publicOrigin && !access) {
    throw new Error(`${SIMPLE_PREVIEW_PUBLIC_ORIGIN_ENV} requires preview access control.`);
  }
  return startSimplePreviewProxy({
    port,
    upstream,
    access: publicOrigin && access ? await access() : null,
    publicOrigin,
    frameAncestorOrigin: publicOrigin
      ? parseDeviceGatewayPublicOrigin(environment[DEVICE_GATEWAY_PUBLIC_ORIGIN_ENV])
      : null,
  });
}
