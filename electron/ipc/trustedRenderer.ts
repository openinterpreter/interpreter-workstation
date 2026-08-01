const TRUSTED_DEV_RENDERER_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
]);

const TRUSTED_DEV_RENDERER_PORT_START = 5173;
const TRUSTED_DEV_RENDERER_PORT_END = 5193;

export function isTrustedAppRendererUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  if (parsed.protocol === 'file:') {
    return parsed.hostname === '' || parsed.hostname === 'localhost';
  }

  if (parsed.protocol !== 'http:') {
    return false;
  }

  if (parsed.username !== '' || parsed.password !== '') {
    return false;
  }

  if (!TRUSTED_DEV_RENDERER_HOSTS.has(parsed.hostname)) {
    return false;
  }

  const port = Number(parsed.port);
  if (!Number.isInteger(port)) {
    return false;
  }

  return port >= TRUSTED_DEV_RENDERER_PORT_START && port <= TRUSTED_DEV_RENDERER_PORT_END;
}

export function isTrustedFileIpcFrame(frameUrl: string, isMainFrame: boolean): boolean {
  if (!isMainFrame) {
    return false;
  }

  return isTrustedAppRendererUrl(frameUrl);
}

export function assertTrustedFileIpcFrame(frameUrl: string, isMainFrame: boolean): void {
  if (isTrustedFileIpcFrame(frameUrl, isMainFrame)) {
    return;
  }

  throw new Error(`Access denied: privileged file IPC requires the app main frame (got ${frameUrl || 'unknown'})`);
}
