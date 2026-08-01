import { describe, expect, test } from 'bun:test';
import {
  buildUntrustedEmailDocument,
  buildUntrustedHtmlDocument,
  emailContainsRemoteAssets,
  htmlContainsBlockedPreviewContent,
  UNTRUSTED_IFRAME_SANDBOX
} from './untrustedHtml';

describe('untrustedHtml', () => {
  test('html documents get a locked-down CSP injected', () => {
    const doc = buildUntrustedHtmlDocument('<html><head><title>x</title></head><body><script>alert(1)</script></body></html>');
    expect(doc).toContain('Content-Security-Policy');
    expect(doc).toContain("script-src 'none'");
    expect(doc).toContain("connect-src 'none'");
    expect(doc).toContain("frame-src 'none'");
  });

  test('email documents are wrapped in an isolated document shell', () => {
    const doc = buildUntrustedEmailDocument('<style>body{font-family:Comic Sans MS}</style><p>Hello</p>');
    expect(doc).toContain('<!doctype html>');
    expect(doc).toContain('font-family: -apple-system');
    expect(doc).toContain('<p>Hello</p>');
    expect(doc).toContain("img-src data: blob: cid:");
    expect(doc).toContain("media-src data: blob:");
    expect(doc).toContain("style-src 'unsafe-inline'");
    expect(doc).not.toContain("connect-src http:");
    expect(doc).not.toContain("script-src 'unsafe-inline'");
  });

  test('email documents can opt into remote image loading explicitly', () => {
    const doc = buildUntrustedEmailDocument('<img src="https://example.com/pixel.png" />', { allowRemoteAssets: true });
    expect(doc).toContain("img-src data: blob: cid: http: https:");
    expect(doc).toContain("media-src data: blob: http: https:");
  });

  test('detects remote assets in email html', () => {
    expect(emailContainsRemoteAssets('<img src="https://example.com/a.png" />')).toBe(true);
    expect(emailContainsRemoteAssets('<div style="background-image:url(https://example.com/a.png)"></div>')).toBe(true);
    expect(emailContainsRemoteAssets('<img src="cid:image001.png@01" />')).toBe(false);
    expect(emailContainsRemoteAssets('<p>Hello</p>')).toBe(false);
  });

  test('sandboxed iframe config grants no extra capabilities', () => {
    expect(UNTRUSTED_IFRAME_SANDBOX).toBe('');
  });

  test('detects html content that the preview blocks', () => {
    expect(htmlContainsBlockedPreviewContent('<script src="https://example.com/app.js"></script>')).toBe(true);
    expect(htmlContainsBlockedPreviewContent('<button onclick="run()">Click</button>')).toBe(true);
    expect(htmlContainsBlockedPreviewContent('<a href="javascript:alert(1)">run</a>')).toBe(true);
    expect(htmlContainsBlockedPreviewContent('<a href=javascript:alert(1)>run</a>')).toBe(true);
    expect(htmlContainsBlockedPreviewContent('<iframe src="https://example.com/chart"></iframe>')).toBe(true);
    expect(htmlContainsBlockedPreviewContent('<object data="chart.svg"></object>')).toBe(true);
    expect(htmlContainsBlockedPreviewContent('<p>Hello</p>')).toBe(false);
  });
});
