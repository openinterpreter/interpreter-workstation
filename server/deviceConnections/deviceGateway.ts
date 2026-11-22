/**
 * Device gateway: the listener a paired phone or other device reaches.
 *
 * It is a second loopback listener in the app server process, started only
 * when INTERPRETER_DEVICE_GATEWAY_PORT is set. An HTTPS tunnel or reverse proxy
 * maps INTERPRETER_DEVICE_GATEWAY_PUBLIC_ORIGIN to it. The main listener and
 * its policy are unchanged.
 *
 * - `/pair` and `/pair.js` are public. The script reads the one-time code from
 *   the URL fragment (never sent to a server), exchanges it at the claim
 *   endpoint for an HttpOnly device cookie, and opens the normal shell.
 * - Every other request needs a valid, unrevoked device cookie, else 401.
 *   State-changing requests and WebSocket upgrades also need the public
 *   Origin.
 * - Authenticated requests, SSE, and upgrades are streamed to the app server
 *   over loopback with the device id and a per-process trust token. Client
 *   copies of those headers are removed.
 */
import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import type {
  WorkstationAccess,
  WorkstationConnectionDescriptor,
} from '../../shared/types/workstationConnection';
import { CLIENT_DEVICE_HEADER, DEVICE_GATEWAY_TOKEN_HEADER } from './gatewayTrust';
import type { DeviceSummary } from './deviceRegistry';

export const DEVICE_GATEWAY_PORT_ENV = 'INTERPRETER_DEVICE_GATEWAY_PORT';
export const DEVICE_GATEWAY_PUBLIC_ORIGIN_ENV = 'INTERPRETER_DEVICE_GATEWAY_PUBLIC_ORIGIN';
export const DEVICE_SESSION_COOKIE = 'interpreter_device_session';
export const DEVICE_CLAIM_PATH = '/api/device-connections/claim';
/** Browsers cap cookie lifetime at 400 days. */
export const DEVICE_SESSION_SECONDS = 400 * 24 * 60 * 60;

const LOOPBACK_HOST = '127.0.0.1';
const MAX_CLAIM_BODY_BYTES = 4096;
const HOP_BY_HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade']);
const CLIENT_SUPPLIED_HEADERS = new Set([
  CLIENT_DEVICE_HEADER,
  DEVICE_GATEWAY_TOKEN_HEADER,
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-for',
  'forwarded',
]);

export type DeviceGatewayDevices = {
  claim: (code: unknown) => Promise<{ device: DeviceSummary; credential: string } | null>;
  authenticate: (credential: string | null) => Promise<DeviceSummary | null>;
  revoke: (id: string) => Promise<boolean>;
};

export type DeviceGatewayOptions = {
  /** Loopback port to listen on; 0 picks a free port. */
  port: number;
  /** The app server's loopback origin, for example `http://127.0.0.1:5177`. */
  upstreamOrigin: string | (() => string);
  publicOrigin: string;
  access: () => WorkstationAccess;
  devices: DeviceGatewayDevices;
  gatewayToken: string;
};

export type DeviceGatewayHandle = {
  host: string;
  port: number;
  close: () => Promise<void>;
};

export function parseDeviceGatewayPort(value: string | undefined): number | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const port = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${DEVICE_GATEWAY_PORT_ENV} must be a TCP port number.`);
  }
  return port;
}

export function parseDeviceGatewayPublicOrigin(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`${DEVICE_GATEWAY_PUBLIC_ORIGIN_ENV} must be an absolute https:// origin.`);
  }
  if (url.protocol !== 'https:' || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${DEVICE_GATEWAY_PUBLIC_ORIGIN_ENV} must be an absolute https:// origin.`);
  }
  return url.origin;
}

/** The normal shell URL a paired device opens after pairing. */
export function deviceShellPath(access: WorkstationAccess): string {
  return `/?surface=workstation&access=${access}&auth=password`;
}

const PAIR_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Connect to Interpreter</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;font-family:system-ui,-apple-system,sans-serif;color:#202123;background:#fff}
@media (prefers-color-scheme:dark){body{color:#f5f5f5;background:#1a1a1a}}
p{max-width:22rem;text-align:center;line-height:1.5}
</style>
</head>
<body>
<p id="status" role="status">Connecting this device…</p>
<script src="/pair.js"></script>
</body>
</html>
`;

const PAIR_SCRIPT = `(async () => {
  const status = document.getElementById('status');
  const code = new URLSearchParams(location.hash.slice(1)).get('code');
  history.replaceState(null, '', location.pathname);
  if (!code) {
    status.textContent = 'This link is incomplete. Ask your Workstation for a new link.';
    return;
  }
  try {
    const response = await fetch(${JSON.stringify(DEVICE_CLAIM_PATH)}, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const payload = response.ok ? await response.json().catch(() => null) : null;
    if (!payload || typeof payload.location !== 'string') {
      status.textContent = 'This link has expired or was already used. Ask your Workstation for a new link.';
      return;
    }
    location.replace(payload.location);
  } catch {
    status.textContent = 'Could not reach your Workstation. Check the connection and open the link again.';
  }
})();
`;

function pathOf(request: http.IncomingMessage): string {
  try {
    return new URL(request.url ?? '/', 'http://gateway.invalid').pathname;
  } catch {
    return '/';
  }
}

function isSafeMethod(method: string | undefined): boolean {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
}

function cookieValue(header: string | undefined, name: string): string | null {
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

/** The Cookie header without the device credential, or null when nothing remains. */
function cookiesWithoutDeviceSession(header: string): string | null {
  const remaining = header
    .split(';')
    .map((item) => item.trim())
    .filter((item) => item && item.split('=')[0]?.trim() !== DEVICE_SESSION_COOKIE);
  return remaining.length > 0 ? remaining.join('; ') : null;
}

function send(
  response: http.ServerResponse,
  status: number,
  body = '',
  headers: http.OutgoingHttpHeaders = {},
): void {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  response.end(body);
}

function sendJson(response: http.ServerResponse, status: number, value: unknown, headers: http.OutgoingHttpHeaders = {}): void {
  send(response, status, JSON.stringify(value), { 'Content-Type': 'application/json; charset=utf-8', ...headers });
}

function readBody(request: http.IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        finish(null);
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    request.on('error', () => finish(null));
  });
}

function sessionCookie(credential: string): string {
  return `${DEVICE_SESSION_COOKIE}=${encodeURIComponent(credential)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${DEVICE_SESSION_SECONDS}`;
}

const CLEARED_SESSION_COOKIE = `${DEVICE_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

type Upstream = { hostname: string; port: number; host: string };

function resolveUpstream(origin: string): Upstream {
  const url = new URL(origin);
  return {
    hostname: url.hostname.replace(/^\[|\]$/g, ''),
    port: Number(url.port || 80),
    host: url.host,
  };
}

/**
 * Headers for the app server: client copies of gateway and forwarding
 * headers are dropped, the device credential is removed, and the trusted
 * device identity and public host are added.
 */
function forwardedHeaderPairs(
  rawHeaders: string[],
  options: { upstream: Upstream; publicOrigin: string; deviceId: string; gatewayToken: string; keepHopByHop: boolean },
): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const lower = name.toLowerCase();
    const value = rawHeaders[index + 1];
    if (lower === 'host' || CLIENT_SUPPLIED_HEADERS.has(lower)) continue;
    if (!options.keepHopByHop && HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (lower === 'cookie') {
      const cookies = cookiesWithoutDeviceSession(value);
      if (cookies) pairs.push([name, cookies]);
      continue;
    }
    pairs.push([name, value]);
  }
  pairs.push(['Host', options.upstream.host]);
  pairs.push(['X-Forwarded-Host', new URL(options.publicOrigin).host]);
  pairs.push(['X-Forwarded-Proto', 'https']);
  pairs.push([DEVICE_GATEWAY_TOKEN_HEADER, options.gatewayToken]);
  pairs.push([CLIENT_DEVICE_HEADER, options.deviceId]);
  return pairs;
}

function headerObject(pairs: Array<[string, string]>): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of pairs) {
    const lower = name.toLowerCase();
    const existing = headers[lower];
    headers[lower] = existing === undefined
      ? value
      : Array.isArray(existing) ? [...existing, value] : [String(existing), value];
  }
  return headers;
}

function upstreamOf(options: DeviceGatewayOptions): Upstream {
  return resolveUpstream(typeof options.upstreamOrigin === 'function'
    ? options.upstreamOrigin()
    : options.upstreamOrigin);
}

function forwardRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: DeviceGatewayOptions,
  device: DeviceSummary,
): void {
  const upstream = upstreamOf(options);
  const proxied = http.request({
    host: upstream.hostname,
    port: upstream.port,
    method: request.method,
    path: request.url,
    headers: headerObject(forwardedHeaderPairs(request.rawHeaders, {
      upstream,
      publicOrigin: options.publicOrigin,
      deviceId: device.id,
      gatewayToken: options.gatewayToken,
      keepHopByHop: false,
    })),
  }, (upstreamResponse) => {
    const headers = { ...upstreamResponse.headers };
    for (const name of HOP_BY_HOP_HEADERS) delete headers[name];
    response.writeHead(upstreamResponse.statusCode ?? 502, headers);
    response.flushHeaders();
    upstreamResponse.pipe(response);
  });
  proxied.on('error', () => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    send(response, 502);
  });
  response.on('close', () => {
    if (!response.writableFinished) proxied.destroy();
  });
  request.pipe(proxied);
}

async function handleClaim(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: DeviceGatewayOptions,
): Promise<void> {
  if (request.method !== 'POST') {
    request.resume();
    send(response, 405, '', { Allow: 'POST' });
    return;
  }
  if (request.headers.origin !== options.publicOrigin) {
    request.resume();
    send(response, 403);
    return;
  }
  const body = await readBody(request, MAX_CLAIM_BODY_BYTES);
  let code: unknown = null;
  try {
    code = body ? (JSON.parse(body) as { code?: unknown })?.code : null;
  } catch {
    code = null;
  }
  const claimed = await options.devices.claim(code);
  if (!claimed) {
    send(response, 401);
    return;
  }
  sendJson(response, 200, { location: deviceShellPath(options.access()) }, {
    'Set-Cookie': sessionCookie(claimed.credential),
  });
}

function connectionDescriptor(access: WorkstationAccess): WorkstationConnectionDescriptor {
  // A paired device holds a host-issued session, so the shell mounts exactly
  // as it does after a password sign-in.
  return {
    schemaVersion: 1,
    host: 'remote',
    access,
    authentication: { method: 'password', required: true, authenticated: true },
  };
}

async function handleRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: DeviceGatewayOptions,
): Promise<void> {
  const path = pathOf(request);
  if (path === '/pair' && isSafeMethod(request.method)) {
    request.resume();
    send(response, 200, PAIR_PAGE, {
      'Content-Type': 'text/html; charset=utf-8',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    return;
  }
  if (path === '/pair.js' && isSafeMethod(request.method)) {
    request.resume();
    send(response, 200, PAIR_SCRIPT, { 'Content-Type': 'application/javascript; charset=utf-8' });
    return;
  }
  if (path === DEVICE_CLAIM_PATH) {
    await handleClaim(request, response, options);
    return;
  }

  const device = await options.devices.authenticate(cookieValue(request.headers.cookie, DEVICE_SESSION_COOKIE));
  if (!device) {
    request.resume();
    send(response, 401);
    return;
  }
  if (!isSafeMethod(request.method) && request.headers.origin !== options.publicOrigin) {
    request.resume();
    send(response, 403);
    return;
  }

  if (path === '/api/workstation-connection') {
    request.resume();
    if (request.method === 'GET' || request.method === 'HEAD') {
      sendJson(response, 200, connectionDescriptor(options.access()));
    } else {
      send(response, 405);
    }
    return;
  }
  if (path === '/api/workstation-connection/session') {
    request.resume();
    if (request.method === 'DELETE') {
      // Signing out on a paired device disconnects that device.
      await options.devices.revoke(device.id);
      sendJson(response, 200, { success: true }, { 'Set-Cookie': CLEARED_SESSION_COOKIE });
    } else {
      send(response, 404);
    }
    return;
  }

  forwardRequest(request, response, options, device);
}

function rejectUpgrade(socket: Duplex, status: '401 Unauthorized' | '403 Forbidden'): void {
  socket.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
}

async function handleUpgrade(
  request: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  options: DeviceGatewayOptions,
): Promise<void> {
  socket.on('error', () => socket.destroy());
  const device = await options.devices.authenticate(cookieValue(request.headers.cookie, DEVICE_SESSION_COOKIE));
  if (!device) {
    rejectUpgrade(socket, '401 Unauthorized');
    return;
  }
  if (request.headers.origin !== options.publicOrigin) {
    rejectUpgrade(socket, '403 Forbidden');
    return;
  }
  const upstream = upstreamOf(options);
  const pairs = forwardedHeaderPairs(request.rawHeaders, {
    upstream,
    publicOrigin: options.publicOrigin,
    deviceId: device.id,
    gatewayToken: options.gatewayToken,
    keepHopByHop: true,
  });
  const lines = [`${request.method ?? 'GET'} ${request.url ?? '/'} HTTP/1.1`, ...pairs.map(([name, value]) => `${name}: ${value}`)];
  const target = net.connect(upstream.port, upstream.hostname);
  target.on('connect', () => {
    target.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length > 0) target.write(head);
    socket.pipe(target);
    target.pipe(socket);
  });
  target.on('error', () => socket.destroy());
  target.on('close', () => socket.destroy());
  socket.on('close', () => target.destroy());
}

export async function startDeviceGateway(options: DeviceGatewayOptions): Promise<DeviceGatewayHandle> {
  const server = http.createServer((request, response) => {
    handleRequest(request, response, options).catch(() => {
      if (response.headersSent) response.destroy();
      else send(response, 500);
    });
  });
  server.on('upgrade', (request, socket, head) => {
    handleUpgrade(request, socket, head, options).catch(() => socket.destroy());
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
 * Starts the gateway when INTERPRETER_DEVICE_GATEWAY_PORT is set; otherwise
 * returns null. A port without a public origin, or an origin without a port,
 * is a configuration error.
 */
export async function startDeviceGatewayFromEnvironment(
  dependencies: Omit<DeviceGatewayOptions, 'port' | 'publicOrigin'>,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<(DeviceGatewayHandle & { publicOrigin: string }) | null> {
  const port = parseDeviceGatewayPort(environment[DEVICE_GATEWAY_PORT_ENV]);
  const publicOrigin = parseDeviceGatewayPublicOrigin(environment[DEVICE_GATEWAY_PUBLIC_ORIGIN_ENV]);
  if (port === null) {
    if (publicOrigin) throw new Error(`${DEVICE_GATEWAY_PUBLIC_ORIGIN_ENV} requires ${DEVICE_GATEWAY_PORT_ENV}.`);
    return null;
  }
  if (!publicOrigin) throw new Error(`${DEVICE_GATEWAY_PORT_ENV} requires ${DEVICE_GATEWAY_PUBLIC_ORIGIN_ENV}.`);
  const handle = await startDeviceGateway({ ...dependencies, port, publicOrigin });
  return { ...handle, publicOrigin };
}
