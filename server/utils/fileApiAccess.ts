import type { IncomingHttpHeaders } from 'node:http';

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

export function isAbsoluteFilesystemPath(inputPath: string): boolean {
  return (
    inputPath.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(inputPath) ||
    inputPath.startsWith('\\\\')
  );
}

export function isTrustedAbsoluteFileReadRequest(headers: IncomingHttpHeaders): boolean {
  const secFetchSite = firstHeaderValue(headers['sec-fetch-site'])?.toLowerCase().trim();
  if (secFetchSite === 'cross-site') {
    return false;
  }

  const origin = firstHeaderValue(headers.origin)?.trim();
  if (!origin) {
    // Browser navigations/subresource loads may omit Origin while still
    // providing Fetch Metadata. Trust only explicit local browser contexts.
    return (
      secFetchSite === 'same-origin' ||
      secFetchSite === 'same-site' ||
      secFetchSite === 'none'
    );
  }
  if (origin === 'null') {
    return true;
  }

  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    return false;
  }

  if (parsedOrigin.protocol === 'file:') {
    return true;
  }
  if (parsedOrigin.protocol !== 'http:' && parsedOrigin.protocol !== 'https:') {
    return false;
  }

  const hostname = parsedOrigin.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}
