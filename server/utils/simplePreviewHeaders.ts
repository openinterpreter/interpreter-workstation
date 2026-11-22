/**
 * Request headers the Simple preview proxy forwards to a project server.
 *
 * The preview origin sits behind an authenticating front. That front's own
 * credentials and identity headers (Authorization, session cookies, forwarded
 * identity headers) must never reach a generated project's routes, so the
 * proxy forwards an allowlist rather than removing known-bad names: anything
 * not listed here is dropped, for requests and for WebSocket upgrades alike.
 */

/** Headers a browser or the Next.js client sends that a project server needs. */
const FORWARDED_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'cache-control',
  'content-encoding',
  'content-language',
  'content-length',
  'content-type',
  'dnt',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-range',
  'if-unmodified-since',
  'origin',
  'pragma',
  'priority',
  'purpose',
  'range',
  'rsc',
  'transfer-encoding',
  'upgrade',
  'user-agent',
  'x-requested-with',
]);

/** Header families a project server needs: fetch metadata, client hints, Next.js and WebSocket. */
const FORWARDED_PREFIXES = ['sec-fetch-', 'sec-ch-', 'sec-websocket-', 'next-', 'x-nextjs-'];

function forwardable(lowerName: string): boolean {
  return FORWARDED_HEADERS.has(lowerName) || FORWARDED_PREFIXES.some((prefix) => lowerName.startsWith(prefix));
}

/**
 * Project cookies live in their own namespace on the preview origin.
 *
 * A project server is untrusted with respect to the front: if the proxy sent
 * back cookies by the names the project chose, a project could name a cookie
 * after the front's session cookie and be handed the browser's credential, or
 * overwrite it. So every cookie a project sets is stored in the browser under
 * this prefix, and only cookies carrying the prefix are returned to it, with
 * the prefix removed. No other cookie on the origin can reach a project, and a
 * project can neither read nor replace one. A cookie written by page script
 * rather than by the project server has no prefix and is not sent to it.
 */
export const SIMPLE_PREVIEW_COOKIE_PREFIX = 'interpreter_preview_app_';

/**
 * A project's Set-Cookie header moved into the project namespace and confined
 * to the preview host. Returns null for a header that is not a usable cookie.
 */
export function namespacedSimplePreviewSetCookie(setCookie: string): string | null {
  const [pair, ...attributes] = setCookie.split(';');
  const separator = pair.indexOf('=');
  const name = separator > 0 ? pair.slice(0, separator).trim() : '';
  if (!name || /[\s,;="]/.test(name)) return null;
  // A Domain attribute could widen the cookie to sibling hosts; keep it host-only.
  const kept = attributes.filter((attribute) => !/^\s*domain\s*=/i.test(attribute));
  return [`${SIMPLE_PREVIEW_COOKIE_PREFIX}${name}=${pair.slice(separator + 1)}`, ...kept].join(';');
}

/** A response's Set-Cookie headers rewritten for the browser; unusable ones are dropped. */
export function namespacedSimplePreviewSetCookies(setCookie: string | string[] | undefined): string[] {
  const values = setCookie === undefined ? [] : Array.isArray(setCookie) ? setCookie : [setCookie];
  return values.flatMap((value) => namespacedSimplePreviewSetCookie(value) ?? []);
}

/** The Cookie header reduced to the project's own cookies under their original names, or null when none remain. */
export function projectSimplePreviewCookies(cookieHeader: string): string | null {
  const kept = cookieHeader
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => pair.startsWith(SIMPLE_PREVIEW_COOKIE_PREFIX) && pair.indexOf('=') > SIMPLE_PREVIEW_COOKIE_PREFIX.length)
    .map((pair) => pair.slice(SIMPLE_PREVIEW_COOKIE_PREFIX.length));
  return kept.length > 0 ? kept.join('; ') : null;
}

/**
 * The header list to send upstream, in order, with Host and Origin naming the
 * project server. `rawHeaders` is Node's alternating name/value list.
 */
export function forwardedSimplePreviewHeaders(
  rawHeaders: readonly string[],
  upstreamHost: string,
): Array<[name: string, value: string]> {
  const forwarded: Array<[string, string]> = [['Host', upstreamHost]];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    const lower = name.toLowerCase();
    if (lower === 'cookie') {
      const own = projectSimplePreviewCookies(value);
      if (own !== null) forwarded.push(['Cookie', own]);
      continue;
    }
    if (!forwardable(lower)) continue;
    forwarded.push([name, lower === 'origin' ? `http://${upstreamHost}` : value]);
  }
  return forwarded;
}
