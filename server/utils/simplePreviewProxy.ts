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
 * The proxy always binds 127.0.0.1 and adds no authentication of its own.
 */
import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import {
  forwardedSimplePreviewHeaders,
  namespacedSimplePreviewSetCookies,
  simplePreviewCookiePrefix,
} from './simplePreviewHeaders';

export const SIMPLE_PREVIEW_PROXY_PORT_ENV = 'INTERPRETER_SIMPLE_PREVIEW_PROXY_PORT';
export const SIMPLE_PREVIEW_PUBLIC_ORIGIN_ENV = 'INTERPRETER_SIMPLE_PREVIEW_PUBLIC_ORIGIN';

const LOOPBACK_HOST = '127.0.0.1';
const UNAVAILABLE_MESSAGE = 'The interface project is not running.\n';
const HOP_BY_HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-connection']);

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

async function forwardRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  upstream: SimplePreviewUpstream,
): Promise<void> {
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
    response.writeHead(upstreamResponse.statusCode ?? 502, headers);
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
): Promise<void> {
  socket.on('error', () => socket.destroy());
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
    target.pipe(socket);
  });
  target.on('error', () => socket.destroy());
  target.on('close', () => socket.destroy());
  socket.on('close', () => target.destroy());
}

export async function startSimplePreviewProxy(options: {
  port: number;
  upstream: SimplePreviewUpstream;
}): Promise<SimplePreviewProxyHandle> {
  const server = http.createServer((request, response) => {
    void forwardRequest(request, response, options.upstream);
  });
  server.on('upgrade', (request, socket, head) => {
    void forwardUpgrade(request, socket, head, options.upstream);
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

/** Starts the preview proxy when the environment asks for it; otherwise returns null. */
export async function startSimplePreviewProxyFromEnvironment(
  upstream: SimplePreviewUpstream,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<SimplePreviewProxyHandle | null> {
  const port = parseSimplePreviewProxyPort(environment[SIMPLE_PREVIEW_PROXY_PORT_ENV]);
  const publicOrigin = parseSimplePreviewPublicOrigin(environment[SIMPLE_PREVIEW_PUBLIC_ORIGIN_ENV]);
  if (port === null) {
    if (publicOrigin) {
      throw new Error(`${SIMPLE_PREVIEW_PUBLIC_ORIGIN_ENV} requires ${SIMPLE_PREVIEW_PROXY_PORT_ENV}.`);
    }
    return null;
  }
  return startSimplePreviewProxy({ port, upstream });
}
