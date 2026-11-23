const TRUSTED_DEV_RENDERER_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
]);

const TRUSTED_DEV_RENDERER_PORT_START = 5173;
const TRUSTED_DEV_RENDERER_PORT_END = 5193;

/** Express accepts trailing slashes, case variants and query strings here. */
export function isWhatsAppApiPath(value: string): boolean {
  try {
    const pathname = decodeURIComponent(new URL(value, 'http://127.0.0.1').pathname)
      .replace(/\\/g, '/').toLowerCase();
    return pathname === '/api/servers/whatsapp' || pathname.startsWith('/api/servers/whatsapp/');
  } catch { return false; }
}

export function isTrustedAppRendererUrl(value: string, expectedFileUrl?: string,
  allowDevRenderer = true): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  if (parsed.protocol === 'file:') {
    // A preload exposed to the app window may also run after navigation to
    // an arbitrary local file. File scheme alone is not app provenance.
    // Non-IPC consumers use this as a broad display/lifecycle classification;
    // privileged IPC itself requires the explicit packaged-file pin below.
    if (!expectedFileUrl) return parsed.hostname === '' || parsed.hostname === 'localhost';
    try {
      const expected = new URL(expectedFileUrl);
      return expected.protocol === 'file:' && expected.hostname === '' &&
        !expected.search && !expected.hash && parsed.hostname === '' &&
        !parsed.search && parsed.pathname === expected.pathname;
    } catch { return false; }
  }

  if (parsed.protocol !== 'http:' || !allowDevRenderer) {
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

/** A media permission's WebContents URL is top-level even when a subframe
 * requests the device. The requesting frame must also be the app document. */
export function isTrustedMediaRequest(topLevelUrl: string, requestingUrl: string,
  expectedFileUrl: string, allowDevRenderer: boolean): boolean {
  if (!isTrustedAppRendererUrl(topLevelUrl, expectedFileUrl, allowDevRenderer) ||
      !isTrustedAppRendererUrl(requestingUrl, expectedFileUrl, allowDevRenderer)) return false;
  const top = new URL(topLevelUrl), requesting = new URL(requestingUrl);
  return top.protocol === 'file:' ? requesting.pathname === top.pathname && requesting.protocol === 'file:'
    : top.origin === requesting.origin;
}

export function isTrustedFileIpcFrame(frameUrl: string, isMainFrame: boolean,
  expectedFileUrl?: string, allowDevRenderer = true): boolean {
  if (!isMainFrame) {
    return false;
  }

  if (/^file:/i.test(frameUrl) && !expectedFileUrl) return false;
  return isTrustedAppRendererUrl(frameUrl, expectedFileUrl, allowDevRenderer);
}

export function assertTrustedFileIpcFrame(frameUrl: string, isMainFrame: boolean,
  expectedFileUrl?: string, allowDevRenderer = true): void {
  if (isTrustedFileIpcFrame(frameUrl, isMainFrame, expectedFileUrl, allowDevRenderer)) {
    return;
  }

  throw new Error(`Access denied: privileged file IPC requires the app main frame (got ${frameUrl || 'unknown'})`);
}

/** IPC from the app's own top-level document only. Unlike display/lifecycle
 * classification, an arbitrary local dev port or another path on that origin
 * is not a sufficient authority for native operations. */
export function assertTrustedAppIpcFrame(frameUrl: string, isMainFrame: boolean,
  expectedFileUrl: string, expectedHttpOrigin?: string): void {
  if (isTrustedFileIpcFrame(frameUrl, isMainFrame, expectedFileUrl, false)) return;
  try {
    const url = new URL(frameUrl);
    if (isMainFrame && expectedHttpOrigin && url.protocol === 'http:' &&
        url.origin === expectedHttpOrigin && url.pathname === '/' &&
        !url.search && !url.username && !url.password) return;
  } catch { /* Unknown frame cannot receive native authority. */ }
  throw new Error(`Access denied: privileged IPC requires the app main frame (got ${frameUrl || 'unknown'})`);
}
