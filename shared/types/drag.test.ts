import { describe, test, expect } from 'bun:test';
import {
  isFileDragData,
  isBrowserTabDragData,
  isEmailTabDragData,
  parseDragData,
  createFileDragData,
  createBrowserTabDragData,
  createEmailTabDragData,
} from './drag';

describe('isFileDragData', () => {
  test('valid file drag data returns true', () => {
    const data = { type: 'file', sourceContext: 'explorer', filePath: '/a/b', fileName: 'b', isDirectory: false };
    expect(isFileDragData(data)).toBe(true);
  });

  test('missing filePath returns false', () => {
    const data = { type: 'file', sourceContext: 'explorer', fileName: 'b', isDirectory: false };
    expect(isFileDragData(data)).toBe(false);
  });

  test('wrong type field returns false', () => {
    const data = { type: 'browser-tab', sourceContext: 'explorer', filePath: '/a/b', fileName: 'b', isDirectory: false };
    expect(isFileDragData(data)).toBe(false);
  });

  test('invalid sourceContext returns false', () => {
    const data = { type: 'file', sourceContext: 'invalid', filePath: '/a/b', fileName: 'b', isDirectory: false };
    expect(isFileDragData(data)).toBe(false);
  });

  test('null returns false', () => {
    expect(isFileDragData(null)).toBe(false);
  });

  test('non-object returns false', () => {
    expect(isFileDragData('string')).toBe(false);
  });
});

describe('isBrowserTabDragData', () => {
  test('valid browser tab data returns true', () => {
    const data = { type: 'browser-tab', url: 'https://x.com', fileName: 'X', browserId: 'b1' };
    expect(isBrowserTabDragData(data)).toBe(true);
  });

  test('missing browserId returns false', () => {
    const data = { type: 'browser-tab', url: 'https://x.com', fileName: 'X' };
    expect(isBrowserTabDragData(data)).toBe(false);
  });
});

describe('isEmailTabDragData', () => {
  test('valid email tab data returns true', () => {
    const data = { type: 'email-tab', emailId: 'e1', subject: 'Hello' };
    expect(isEmailTabDragData(data)).toBe(true);
  });

  test('missing emailId returns false', () => {
    const data = { type: 'email-tab', subject: 'Hello' };
    expect(isEmailTabDragData(data)).toBe(false);
  });
});

describe('parseDragData', () => {
  test('parses valid file drag JSON', () => {
    const input = JSON.stringify({ type: 'file', sourceContext: 'tabs', filePath: '/x', fileName: 'x', isDirectory: false });
    const result = parseDragData(input);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('file');
  });

  test('parses valid browser tab drag JSON', () => {
    const input = JSON.stringify({ type: 'browser-tab', url: 'https://x.com', fileName: 'X', browserId: 'b1' });
    const result = parseDragData(input);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('browser-tab');
  });

  test('parses valid email tab drag JSON', () => {
    const input = JSON.stringify({ type: 'email-tab', emailId: 'e1', subject: 'Hello' });
    const result = parseDragData(input);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('email-tab');
  });

  test('returns null for invalid JSON', () => {
    expect(parseDragData('not-json')).toBeNull();
  });

  test('returns null for unrecognized format', () => {
    expect(parseDragData(JSON.stringify({ type: 'unknown' }))).toBeNull();
  });
});

describe('factory functions', () => {
  test('createFileDragData produces correct shape', () => {
    const result = createFileDragData('/a/b.txt', 'b.txt', false, 'explorer');
    expect(result).toEqual({
      type: 'file',
      sourceContext: 'explorer',
      filePath: '/a/b.txt',
      fileName: 'b.txt',
      isDirectory: false,
    });
  });

  test('createBrowserTabDragData produces correct shape', () => {
    const result = createBrowserTabDragData('b1', 'https://x.com', 'X', 'https://x.com/favicon.ico');
    expect(result).toEqual({
      type: 'browser-tab',
      browserId: 'b1',
      url: 'https://x.com',
      fileName: 'X',
      faviconUrl: 'https://x.com/favicon.ico',
    });
  });

  test('createEmailTabDragData produces correct shape', () => {
    const result = createEmailTabDragData('e1', 'Hello');
    expect(result).toEqual({
      type: 'email-tab',
      emailId: 'e1',
      subject: 'Hello',
    });
  });
});
