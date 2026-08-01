import { describe, expect, test } from 'bun:test';
import { isTrustedAppRendererUrl } from './trustedAppRendererUrl';

const options = {
  devRendererPortStart: 5173,
  devRendererPortEnd: 5193,
};

describe('isTrustedAppRendererUrl', () => {
  test('accepts packaged file renderer URLs', () => {
    expect(isTrustedAppRendererUrl('file:///Applications/Interpreter.app/index.html', options)).toBe(true);
  });

  test('accepts localhost dev renderer URLs inside the configured port range', () => {
    expect(isTrustedAppRendererUrl('http://localhost:5173/', options)).toBe(true);
    expect(isTrustedAppRendererUrl('http://localhost:5193/workspace', options)).toBe(true);
  });

  test('rejects localhost dev renderer URLs outside the configured port range', () => {
    expect(isTrustedAppRendererUrl('http://localhost:5172/', options)).toBe(false);
    expect(isTrustedAppRendererUrl('http://localhost:5194/', options)).toBe(false);
  });

  test('rejects userinfo spoofing attempts', () => {
    expect(isTrustedAppRendererUrl('http://localhost:5173@evil.com/', options)).toBe(false);
  });

  test('rejects non-local hosts and protocols', () => {
    expect(isTrustedAppRendererUrl('http://127.0.0.1:5173/', options)).toBe(false);
    expect(isTrustedAppRendererUrl('https://localhost:5173/', options)).toBe(false);
    expect(isTrustedAppRendererUrl('javascript:alert(1)', options)).toBe(false);
  });

  test('rejects malformed URLs', () => {
    expect(isTrustedAppRendererUrl('not a url', options)).toBe(false);
  });
});
