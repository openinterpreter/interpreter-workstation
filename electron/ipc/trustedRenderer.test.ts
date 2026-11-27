import { describe, expect, test } from 'bun:test';
import { assertTrustedAppIpcFrame, assertTrustedFileIpcFrame, isTrustedAppRendererUrl, isTrustedFileIpcFrame, isTrustedMediaRequest, isWhatsAppApiPath } from './trustedRenderer';

describe('trustedRenderer', () => {
  test('allows the packaged app main frame', () => {
    expect(isTrustedFileIpcFrame('file:///Applications/Interpreter/index.html', true,
      'file:///Applications/Interpreter/index.html')).toBe(true);
    expect(isTrustedFileIpcFrame('file:///Applications/Interpreter/index.html#/settings', true,
      'file:///Applications/Interpreter/index.html')).toBe(true);
    expect(isTrustedFileIpcFrame('file:///Users/attacker/index.html', true,
      'file:///Applications/Interpreter/index.html')).toBe(false);
    expect(isTrustedFileIpcFrame('file:///Applications/Interpreter/index.html?other=1', true,
      'file:///Applications/Interpreter/index.html')).toBe(false);
    expect(isTrustedFileIpcFrame('file:///Applications/Interpreter/index.html', true)).toBe(false);
    expect(isTrustedFileIpcFrame('FILE:///Applications/Interpreter/index.html', true)).toBe(false);
    expect(isTrustedAppRendererUrl('file:///Users/attacker/index.html',
      'file:///Applications/Interpreter/index.html')).toBe(false);
    expect(isTrustedAppRendererUrl('file:///Applications/Interpreter/index.html',
      'file:///Applications/Interpreter/index.html')).toBe(true);
  });

  test('allows the local dev app main frame', () => {
    expect(isTrustedFileIpcFrame('http://localhost:5173', true)).toBe(true);
    expect(isTrustedFileIpcFrame('http://127.0.0.1:5173', true)).toBe(true);
    expect(isTrustedFileIpcFrame('http://localhost:5173', true,
      'file:///Applications/Interpreter/index.html', false)).toBe(false);
    expect(isTrustedAppRendererUrl('http://localhost:5173',
      'file:///Applications/Interpreter/index.html', false)).toBe(false);
  });

  test('camera and microphone authority cannot be inherited by a different embedded document', () => {
    const packaged = 'file:///Applications/Interpreter/index.html';
    expect(isTrustedMediaRequest(packaged, `${packaged}#/simple`, packaged, false)).toBe(true);
    expect(isTrustedMediaRequest(packaged, 'file:///Users/attacker/embedded.html', packaged, false)).toBe(false);
    expect(isTrustedMediaRequest(packaged, 'https://untrusted.test/embedded', packaged, false)).toBe(false);
    expect(isTrustedMediaRequest('http://localhost:5173/', 'http://localhost:5173/simple', packaged, true)).toBe(true);
    expect(isTrustedMediaRequest('http://localhost:5173/', 'http://localhost:5174/embedded', packaged, true)).toBe(false);
    expect(isTrustedMediaRequest('http://localhost:5173/', 'http://localhost:5173/simple', packaged, false)).toBe(false);
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
    expect(() => assertTrustedFileIpcFrame('file:///Users/attacker/index.html', true,
      'file:///Applications/Interpreter/index.html')).toThrow('Access denied');
  });

  test('native IPC accepts only the loaded app document or exact local runtime origin', () => {
    const file = 'file:///Applications/Interpreter/index.html';
    expect(() => assertTrustedAppIpcFrame(`${file}#/simple`, true, file)).not.toThrow();
    expect(() => assertTrustedAppIpcFrame('file:///Users/other/index.html', true, file)).toThrow('Access denied');
    const dev = 'http://localhost:5174';
    expect(() => assertTrustedAppIpcFrame(`${dev}/#/simple`, true, file, dev)).not.toThrow();
    for (const url of ['http://localhost:5173/', 'http://127.0.0.1:5174/',
      'http://localhost:5174/another', 'http://localhost:5174/?redirect=/']) {
      expect(() => assertTrustedAppIpcFrame(url, true, file, dev)).toThrow('Access denied');
    }
    expect(() => assertTrustedAppIpcFrame(`${dev}/`, false, file, dev)).toThrow('Access denied');
    const built = 'http://127.0.0.1:3333';
    expect(() => assertTrustedAppIpcFrame(`${built}/`, true, file, built)).not.toThrow();
    expect(() => assertTrustedAppIpcFrame(`${built}/`, true, file)).toThrow('Access denied');
    expect(() => assertTrustedAppIpcFrame('about:srcdoc', false, file, built)).toThrow('Access denied');
  });

  test('guards equivalent WhatsApp API path spellings before forwarding', () => {
    for (const path of ['/api/servers/whatsapp/thread-binding', '/api/servers/whatsapp/thread-binding/',
      '/api/servers/whatsapp/thread-binding?retry=1', '/API/SERVERS/WHATSAPP/thread-binding',
      '/api/servers/%77hatsapp/thread-binding', '/api/servers/whatsapp/setup']) {
      expect(isWhatsAppApiPath(path)).toBe(true);
    }
    expect(isWhatsAppApiPath('/api/servers/whatsapped/thread-binding')).toBe(false);
  });
});
