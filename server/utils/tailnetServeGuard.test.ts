import { describe, expect, test } from 'bun:test';
import { privateServeForLoopback, privateRemotePort } from './tailnetServeGuard';

const endpoint = 'https://workstation.example.ts.net';
const privateStatus = { TCP: { '443': { HTTPS: true } }, Web: {
  'workstation.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:18573' } } },
}, AllowFunnel: {} };

describe('private Serve preflight', () => {
  test('requires an exact loopback HTTPS mapping', () => {
    expect(privateServeForLoopback(privateStatus, endpoint, 18573)).toBe(true);
    expect(privateServeForLoopback(privateStatus, endpoint, 18574)).toBe(false);
    expect(privateServeForLoopback(privateStatus, 'https://example.com', 18573)).toBe(false);
    expect(privateServeForLoopback(privateStatus, 'http://workstation.example.ts.net', 18573)).toBe(false);
  });
  test('rejects Funnel, extra handlers and non-loopback proxy', () => {
    expect(privateServeForLoopback({ ...privateStatus, AllowFunnel: { 'workstation.example.ts.net:443': true } }, endpoint, 18573)).toBe(false);
    expect(privateServeForLoopback({ ...privateStatus, TCP: {} }, endpoint, 18573)).toBe(false);
    expect(privateServeForLoopback({ ...privateStatus, Web: { 'workstation.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://0.0.0.0:18573' } } } } }, endpoint, 18573)).toBe(false);
  });
  test('remote listener port cannot reuse the full operator sidecar', () => {
    const previous = process.env.INTERPRETER_SIMPLE_REMOTE_PORT;
    try {
      process.env.INTERPRETER_SIMPLE_REMOTE_PORT = '5177';
      expect(() => privateRemotePort()).toThrow('separate');
      process.env.INTERPRETER_SIMPLE_REMOTE_PORT = '18573';
      expect(privateRemotePort()).toBe(18573);
    } finally {
      if (previous === undefined) delete process.env.INTERPRETER_SIMPLE_REMOTE_PORT;
      else process.env.INTERPRETER_SIMPLE_REMOTE_PORT = previous;
    }
  });
});
