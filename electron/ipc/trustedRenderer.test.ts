import { describe, expect, test } from 'bun:test';
import { assertTrustedFileIpcFrame, isTrustedAppRendererUrl, isTrustedFileIpcFrame } from './trustedRenderer';

describe('trustedRenderer', () => {
  test('allows the packaged app main frame', () => {
    expect(isTrustedFileIpcFrame('file:///Applications/Interpreter/index.html', true)).toBe(true);
  });

  test('allows the local dev app main frame', () => {
    expect(isTrustedFileIpcFrame('http://localhost:5173', true)).toBe(true);
    expect(isTrustedFileIpcFrame('http://127.0.0.1:5173', true)).toBe(true);
  });

  test('rejects userinfo spoofing and invalid dev origins', () => {
    expect(isTrustedAppRendererUrl('http://localhost:5173@evil.com/')).toBe(false);
    expect(isTrustedAppRendererUrl('http://localhost:6000/')).toBe(false);
    expect(isTrustedAppRendererUrl('https://localhost:5173/')).toBe(false);
  });

  test('rejects subframes and srcdoc frames', () => {
    expect(isTrustedFileIpcFrame('about:srcdoc', false)).toBe(false);
    expect(isTrustedFileIpcFrame('http://localhost:5173', false)).toBe(false);
  });

  test('throws a concrete error for untrusted frames', () => {
    expect(() => assertTrustedFileIpcFrame('about:srcdoc', false)).toThrow(
      'Access denied: privileged file IPC requires the app main frame'
    );
  });
});
