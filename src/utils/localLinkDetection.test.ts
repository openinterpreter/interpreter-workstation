import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

let previousWindow: unknown;

let parseLocalLink: (href: string) => { path: string; fragment?: string; lineStart?: number; lineEnd?: number } | null;
let isLocalFileLink: (href: string) => boolean;
let inferLocalLinkItemType: (options: {
  href: string;
  path: string;
  fragment?: string | null;
  lineStart?: number | null;
  lineEnd?: number | null;
}) => 'file' | 'directory';
let canonicalizeLocalLinkPath: (path: string, itemType: 'file' | 'directory') => string;
let resolveLocalLinkTarget: (href: string) => {
  path: string;
  itemType: 'file' | 'directory';
  fragment?: string;
  lineStart?: number;
  lineEnd?: number;
} | null;
let serializeLocalLinkHref: (options: {
  path: string;
  itemType?: 'file' | 'directory';
  fragment?: string | null;
  lineStart?: number | null;
  lineEnd?: number | null;
}) => string;

beforeAll(async () => {
  const globalObject = globalThis as any;
  previousWindow = globalObject.window;
  globalObject.window = globalObject.window ?? new EventTarget();
  globalObject.window.electron = globalObject.window.electron ?? undefined;

  const module = await import('./localLinkDetection');
  parseLocalLink = module.parseLocalLink;
  isLocalFileLink = module.isLocalFileLink;
  inferLocalLinkItemType = module.inferLocalLinkItemType;
  canonicalizeLocalLinkPath = module.canonicalizeLocalLinkPath;
  resolveLocalLinkTarget = module.resolveLocalLinkTarget;
  serializeLocalLinkHref = module.serializeLocalLinkHref;
});

afterAll(() => {
  (globalThis as any).window = previousWindow;
});

describe('parseLocalLink percent-decoding', () => {
  test('should decode %20 to space in path', () => {
    const result = parseLocalLink('As%20we%20may%20think.pdf');
    expect(result).not.toBeNull();
    expect(result!.path).toBe('As we may think.pdf');
  });

  test('should decode %20 in relative path with directory', () => {
    const result = parseLocalLink('my%20folder/my%20file.txt');
    expect(result).not.toBeNull();
    expect(result!.path).toBe('my folder/my file.txt');
  });

  test('should decode %20 in absolute path', () => {
    const result = parseLocalLink('/Users/victor/my%20documents/file.pdf');
    expect(result).not.toBeNull();
    expect(result!.path).toBe('/Users/victor/my documents/file.pdf');
  });

  test('should decode %20 while preserving fragment', () => {
    const result = parseLocalLink('my%20file.md#my-heading');
    expect(result).not.toBeNull();
    expect(result!.path).toBe('my file.md');
    expect(result!.fragment).toBe('my-heading');
  });

  test('should decode %20 while preserving line range', () => {
    const result = parseLocalLink('my%20file.md:L10-L20');
    expect(result).not.toBeNull();
    expect(result!.path).toBe('my file.md');
    expect(result!.lineStart).toBe(10);
    expect(result!.lineEnd).toBe(20);
  });

  test('should handle already-decoded paths (no-op)', () => {
    const result = parseLocalLink('file with spaces.pdf');
    expect(result).not.toBeNull();
    expect(result!.path).toBe('file with spaces.pdf');
  });

  test('should handle malformed percent sequence gracefully', () => {
    const result = parseLocalLink('file%GGname.txt');
    expect(result).not.toBeNull();
    expect(result!.path).toBe('file%GGname.txt');
  });

  test('should decode other percent-encoded characters', () => {
    const result = parseLocalLink('caf%C3%A9.md');
    expect(result).not.toBeNull();
    expect(result!.path).toBe('caf\u00e9.md');
  });
});

describe('parseLocalLink non-encoded cases (no regression)', () => {
  test('should parse simple relative path', () => {
    const result = parseLocalLink('notes.md');
    expect(result).not.toBeNull();
    expect(result!.path).toBe('notes.md');
  });

  test('should parse relative path with directory', () => {
    const result = parseLocalLink('./docs/readme.md');
    expect(result).not.toBeNull();
    expect(result!.path).toBe('./docs/readme.md');
  });

  test('should parse path with fragment and line', () => {
    const result = parseLocalLink('file.md#section:L5');
    expect(result).not.toBeNull();
    expect(result!.path).toBe('file.md');
    expect(result!.fragment).toBe('section');
    expect(result!.lineStart).toBe(5);
  });

  test('should parse file:// links as local paths', () => {
    const result = parseLocalLink('file:///Users/victor/workspace/readme.md');
    expect(result).not.toBeNull();
    expect(result!.path).toBe('/Users/victor/workspace/readme.md');
  });

  test('should parse file:// links with line numbers', () => {
    const result = parseLocalLink('file:///Users/victor/workspace/readme.md:12');
    expect(result).not.toBeNull();
    expect(result!.path).toBe('/Users/victor/workspace/readme.md');
    expect(result!.lineStart).toBe(12);
  });

  test('should normalize Windows file:// links to native separators', () => {
    const result = parseLocalLink('file:///C:/Users/victor/workspace/readme.md:12');
    expect(result).not.toBeNull();
    expect(result!.path).toBe('C:\\Users\\victor\\workspace\\readme.md');
    expect(result!.lineStart).toBe(12);
  });

  test('should return null for external URLs', () => {
    expect(parseLocalLink('https://example.com')).toBeNull();
    expect(parseLocalLink('http://example.com')).toBeNull();
    expect(parseLocalLink('mailto:test@test.com')).toBeNull();
  });

  test('should return null for empty or fragment-only links', () => {
    expect(parseLocalLink('')).toBeNull();
    expect(parseLocalLink('#heading')).toBeNull();
  });
});

describe('isLocalFileLink', () => {
  test('should classify relative, absolute, and file:// links as local', () => {
    expect(isLocalFileLink('As we may think.pdf')).toBe(true);
    expect(isLocalFileLink('/Users/victor/workspace/readme.md')).toBe(true);
    expect(isLocalFileLink('file:///Users/victor/workspace/readme.md')).toBe(true);
  });

  test('should classify external URLs as non-local', () => {
    expect(isLocalFileLink('https://example.com')).toBe(false);
    expect(isLocalFileLink('browser://tab-id')).toBe(false);
  });
});

describe('inferLocalLinkItemType', () => {
  test('treats extensionless labels as files when the href points to a file', () => {
    expect(inferLocalLinkItemType({
      href: 'cost_model.md',
      path: 'cost_model.md',
    })).toBe('file');
  });

  test('treats trailing-slash targets as directories', () => {
    expect(inferLocalLinkItemType({
      href: 'factory/assets/',
      path: 'factory/assets',
    })).toBe('directory');
  });
});

describe('serializeLocalLinkHref', () => {
  test('adds a trailing slash for directory links', () => {
    expect(serializeLocalLinkHref({
      path: 'factory/assets',
      itemType: 'directory',
    })).toBe('factory/assets/');
  });

  test('preserves fragments and line ranges for file links', () => {
    expect(serializeLocalLinkHref({
      path: 'cost_model.md',
      fragment: 'assumptions',
      lineStart: 12,
      lineEnd: 14,
    })).toBe('cost_model.md#assumptions:L12-L14');
  });
});

describe('canonicalizeLocalLinkPath', () => {
  test('strips trailing separators from directory targets without touching roots', () => {
    expect(canonicalizeLocalLinkPath('factory/assets/', 'directory')).toBe('factory/assets');
    expect(canonicalizeLocalLinkPath('/workspace/', 'directory')).toBe('/workspace');
    expect(canonicalizeLocalLinkPath('C:\\workspace\\', 'directory')).toBe('C:\\workspace');
  });
});

describe('resolveLocalLinkTarget', () => {
  test('classifies extensionless markdown note targets as files', () => {
    expect(resolveLocalLinkTarget('cost_model.md')).toEqual({
      path: 'cost_model.md',
      itemType: 'file',
    });
  });

  test('preserves fragments and line ranges for file targets', () => {
    expect(resolveLocalLinkTarget('notes.md#assumptions:L12-L14')).toEqual({
      path: 'notes.md',
      itemType: 'file',
      fragment: 'assumptions',
      lineStart: 12,
      lineEnd: 14,
    });
  });

  test('canonicalizes directory targets by removing trailing separators', () => {
    expect(resolveLocalLinkTarget('./docs/')).toEqual({
      path: './docs',
      itemType: 'directory',
    });
  });
});
