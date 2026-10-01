import { execFileSync } from 'node:child_process';

type ServeStatus = {
  TCP?: Record<string, { HTTPS?: boolean }>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  AllowFunnel?: Record<string, boolean>;
};

/** Fail closed if a Serve mapping is missing, ambiguous or publicly exposed. */
export function privateServeForLoopback(status: unknown, endpoint: string, port: number): boolean {
  if (!status || typeof status !== 'object' || !Number.isInteger(port) || port < 1 || port > 65535) return false;
  let url: URL;
  try { url = new URL(endpoint); } catch { return false; }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.ts.net') || url.pathname !== '/' || url.search || url.hash) return false;
  const entry = status as ServeStatus;
  const listenPort = url.port || '443';
  const host = `${url.hostname}:${listenPort}`;
  const web = entry.Web?.[host];
  if (entry.AllowFunnel?.[host] === true || entry.TCP?.[listenPort]?.HTTPS !== true
      || !web || !web.Handlers || Object.keys(web.Handlers).length !== 1) return false;
  const handler = web.Handlers['/'];
  return handler?.Proxy === `http://127.0.0.1:${port}` || handler?.Proxy === `http://localhost:${port}`;
}

export function assertPrivateServe(endpoint: string, port: number): void {
  try {
    const output = execFileSync('tailscale', ['serve', 'status', '--json'], {
      encoding: 'utf8', timeout: 3000, maxBuffer: 128 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (privateServeForLoopback(JSON.parse(output) as unknown, endpoint, port)) return;
  } catch { /* Missing CLI, disconnected device, or invalid JSON all fail closed. */ }
  throw new Error('Private Tailscale Serve mapping is unavailable or unsafe');
}
