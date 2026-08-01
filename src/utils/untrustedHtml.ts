const UNTRUSTED_HTML_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "img-src data: blob: http: https: file: cid:",
  "media-src data: blob: http: https: file:",
  "style-src 'unsafe-inline' data: http: https: file:",
  "font-src data: http: https: file:",
].join('; ');

const UNTRUSTED_EMAIL_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "img-src data: blob: cid: http: https:",
  "media-src data: blob: http: https:",
  "style-src 'unsafe-inline'",
  "font-src data:",
].join('; ');

const BLOCKED_REMOTE_EMAIL_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "img-src data: blob: cid:",
  "media-src data: blob:",
  "style-src 'unsafe-inline'",
  "font-src data:",
].join('; ');

export const UNTRUSTED_IFRAME_SANDBOX = '';
const SCRIPT_TAG_PATTERN = /<script\b/i;
const INLINE_EVENT_HANDLER_PATTERN = /\son[a-z]+\s*=/i;
const JAVASCRIPT_PROTOCOL_PATTERN = /\b(?:src|href)\s*=\s*(?:["']\s*)?javascript:/i;
const BLOCKED_EMBED_PATTERN = /<(?:embed|iframe|object)\b/i;

const SHARED_BASE_STYLES = `
  html, body {
    margin: 0;
    min-height: 100%;
    background: white;
    color: #111827;
  }

  * {
    box-sizing: border-box;
  }

  img, video, iframe, table {
    max-width: 100%;
  }

  pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
`;

const EMAIL_BASE_STYLES = `
  body {
    padding: 24px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    line-height: 1.6;
    overflow-wrap: anywhere;
  }

  a {
    color: #2563eb;
  }

  blockquote {
    margin: 1rem 0;
    padding-left: 1rem;
    border-left: 2px solid #d1d5db;
    color: #4b5563;
  }
`;

function injectHeadMarkup(html: string, headMarkup: string): string {
  if (/<head[\s>]/i.test(html)) {
    return html.replace(/<head(\s[^>]*)?>/i, match => `${match}${headMarkup}`);
  }

  if (/<html[\s>]/i.test(html)) {
    return html.replace(/<html(\s[^>]*)?>/i, match => `${match}<head>${headMarkup}</head>`);
  }

  return `<!doctype html><html><head>${headMarkup}</head><body>${html}</body></html>`;
}

export function buildUntrustedHtmlDocument(html: string): string {
  const headMarkup = `
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="Content-Security-Policy" content="${UNTRUSTED_HTML_CSP}" />
    <style>${SHARED_BASE_STYLES}</style>
  `;

  return injectHeadMarkup(html, headMarkup);
}

export function htmlContainsBlockedPreviewContent(html: string): boolean {
  return (
    SCRIPT_TAG_PATTERN.test(html) ||
    INLINE_EVENT_HANDLER_PATTERN.test(html) ||
    JAVASCRIPT_PROTOCOL_PATTERN.test(html) ||
    BLOCKED_EMBED_PATTERN.test(html)
  );
}

export function emailContainsRemoteAssets(html: string): boolean {
  return /(?:src|href)\s*=\s*["']https?:\/\/|url\(\s*["']?https?:\/\//i.test(html);
}

export function buildUntrustedEmailDocument(html: string, options?: { allowRemoteAssets?: boolean }): string {
  const allowRemoteAssets = options?.allowRemoteAssets ?? false;
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="Content-Security-Policy" content="${allowRemoteAssets ? UNTRUSTED_EMAIL_CSP : BLOCKED_REMOTE_EMAIL_CSP}" />
    <style>${SHARED_BASE_STYLES}${EMAIL_BASE_STYLES}</style>
  </head>
  <body>
    ${html}
  </body>
</html>`;
}
