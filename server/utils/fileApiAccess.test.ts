import type { IncomingHttpHeaders } from 'node:http';
import {
  isAbsoluteFilesystemPath,
  isTrustedAbsoluteFileReadRequest,
} from './fileApiAccess';

describe('isAbsoluteFilesystemPath', () => {
  test('detects unix absolute paths', () => {
    expect(isAbsoluteFilesystemPath('/tmp/test.pdf')).toBe(true);
  });

  test('detects windows drive absolute paths', () => {
    expect(isAbsoluteFilesystemPath('C:\\tmp\\test.pdf')).toBe(true);
    expect(isAbsoluteFilesystemPath('D:/tmp/test.pdf')).toBe(true);
  });

  test('detects UNC absolute paths', () => {
    expect(isAbsoluteFilesystemPath('\\\\server\\share\\test.pdf')).toBe(true);
  });

  test('rejects relative paths', () => {
    expect(isAbsoluteFilesystemPath('notes/test.pdf')).toBe(false);
    expect(isAbsoluteFilesystemPath('../notes/test.pdf')).toBe(false);
    expect(isAbsoluteFilesystemPath('C:test.pdf')).toBe(false);
  });
});

describe('isTrustedAbsoluteFileReadRequest', () => {
  const headers = (values: IncomingHttpHeaders): IncomingHttpHeaders => values;

  test('rejects requests without origin headers or fetch metadata', () => {
    expect(isTrustedAbsoluteFileReadRequest(headers({}))).toBe(false);
  });

  test('allows no-origin requests when fetch metadata indicates local browser context', () => {
    expect(
      isTrustedAbsoluteFileReadRequest(
        headers({
          'sec-fetch-site': 'same-origin',
        }),
      ),
    ).toBe(true);
    expect(
      isTrustedAbsoluteFileReadRequest(
        headers({
          'sec-fetch-site': 'none',
        }),
      ),
    ).toBe(true);
  });

  test('allows null origin (file renderer)', () => {
    expect(isTrustedAbsoluteFileReadRequest(headers({ origin: 'null' }))).toBe(true);
  });

  test('allows loopback origins', () => {
    expect(isTrustedAbsoluteFileReadRequest(headers({ origin: 'http://localhost:5173' }))).toBe(true);
    expect(isTrustedAbsoluteFileReadRequest(headers({ origin: 'http://127.0.0.1:5177' }))).toBe(true);
    expect(isTrustedAbsoluteFileReadRequest(headers({ origin: 'http://[::1]:5177' }))).toBe(true);
  });

  test('rejects non-loopback origins', () => {
    expect(isTrustedAbsoluteFileReadRequest(headers({ origin: 'https://evil.example' }))).toBe(false);
  });

  test('rejects malformed origins', () => {
    expect(isTrustedAbsoluteFileReadRequest(headers({ origin: '%%%not-a-url%%%' }))).toBe(false);
  });

  test('rejects cross-site browser requests', () => {
    expect(
      isTrustedAbsoluteFileReadRequest(
        headers({
          origin: 'http://localhost:5173',
          'sec-fetch-site': 'cross-site',
        }),
      ),
    ).toBe(false);
  });
});
