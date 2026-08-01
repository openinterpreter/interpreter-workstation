import { describe, test, expect, beforeEach } from 'bun:test';
import { setFileCache, clearFileCache, type FileEntry } from '../stores/fileStore';

const globalObject = globalThis as any;
globalObject.window = globalObject.window ?? {};
globalObject.window.electron = globalObject.window.electron ?? undefined;

const { filterSearchItems, getWorkspaceFiles } = await import('./useFileSearch');
type SearchItem = import('./useFileSearch').SearchItem;

beforeEach(() => {
  clearFileCache();
});

describe('filterSearchItems', () => {
  const items: SearchItem[] = [
    { name: 'readme.md', path: '/workspace/readme.md', type: 'file' },
    { name: 'index.ts', path: '/workspace/src/index.ts', type: 'file' },
    { name: 'styles.css', path: '/workspace/src/styles.css', type: 'file' },
    { name: 'GitHub', type: 'browser-tab', url: 'https://github.com/org/repo', browserId: 'b1' },
    { name: 'Docs', type: 'browser-tab', url: 'https://docs.example.com', browserId: 'b2' },
    { name: 'src', path: '/workspace/src', type: 'directory' },
  ];

  test('empty query returns all items', () => {
    expect(filterSearchItems(items, '')).toEqual(items);
  });

  test('filters by name match', () => {
    const result = filterSearchItems(items, 'readme');

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('readme.md');
  });

  test('filters by path match', () => {
    const result = filterSearchItems(items, '/src/');

    expect(result).toHaveLength(2); // index.ts, styles.css (src dir path is /workspace/src, no trailing slash)
  });

  test('filters by URL match for browser tabs', () => {
    const result = filterSearchItems(items, 'github.com');

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('GitHub');
  });

  test('case insensitive matching', () => {
    const result = filterSearchItems(items, 'README');

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('readme.md');
  });

  test('case insensitive URL matching', () => {
    const result = filterSearchItems(items, 'GITHUB');

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('GitHub');
  });

  test('no match returns empty array', () => {
    const result = filterSearchItems(items, 'nonexistent');

    expect(result).toEqual([]);
  });

  test('matches across name and path', () => {
    const result = filterSearchItems(items, 'index');

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('index.ts');
  });

  test('partial substring match works', () => {
    const result = filterSearchItems(items, '.css');

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('styles.css');
  });

  test('filters empty items list', () => {
    expect(filterSearchItems([], 'query')).toEqual([]);
  });

  test('matches directory type', () => {
    const result = filterSearchItems(items, 'src');

    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.some(r => r.type === 'directory')).toBe(true);
  });
});

describe('getWorkspaceFiles', () => {
  test('returns empty array when cache is empty', () => {
    expect(getWorkspaceFiles()).toEqual([]);
  });

  test('maps FileEntry to SearchItem', () => {
    const files: FileEntry[] = [
      { path: '/workspace/file.txt', name: 'file.txt', type: 'file' },
      { path: '/workspace/docs', name: 'docs', type: 'directory' },
    ];
    setFileCache(files);

    const result = getWorkspaceFiles();

    expect(result).toEqual([
      { path: '/workspace/file.txt', name: 'file.txt', type: 'file' },
      { path: '/workspace/docs', name: 'docs', type: 'directory' },
    ]);
  });

  test('preserves file and directory types', () => {
    const files: FileEntry[] = [
      { path: '/a', name: 'a', type: 'file' },
      { path: '/b', name: 'b', type: 'directory' },
    ];
    setFileCache(files);

    const result = getWorkspaceFiles();

    expect(result[0].type).toBe('file');
    expect(result[1].type).toBe('directory');
  });

  test('does not include extra properties from FileEntry', () => {
    const files: FileEntry[] = [
      { path: '/workspace/test.ts', name: 'test.ts', type: 'file' },
    ];
    setFileCache(files);

    const result = getWorkspaceFiles();

    expect(Object.keys(result[0]).sort()).toEqual(['name', 'path', 'type']);
  });
});
