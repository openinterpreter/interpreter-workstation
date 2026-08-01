import { describe, test, expect, beforeEach } from 'bun:test';
import {
  setFileCache,
  getFileCache,
  getFileCacheVersion,
  hasFileCache,
  getFileCacheAge,
  clearFileCache,
  subscribeFileCache,
  resetFileStoreForTests,
  type FileEntry,
} from './fileStore';

beforeEach(() => {
  resetFileStoreForTests();
});

describe('fileStore', () => {
  const sampleFiles: FileEntry[] = [
    { path: '/workspace/readme.md', name: 'readme.md', type: 'file' },
    { path: '/workspace/src', name: 'src', type: 'directory' },
    { path: '/workspace/src/index.ts', name: 'index.ts', type: 'file' },
  ];

  test('getFileCache returns empty array initially', () => {
    expect(getFileCache()).toEqual([]);
  });

  test('hasFileCache returns false initially', () => {
    expect(hasFileCache()).toBe(false);
  });

  test('setFileCache stores files and getFileCache retrieves them', () => {
    setFileCache(sampleFiles);

    expect(getFileCache()).toEqual(sampleFiles);
  });

  test('hasFileCache returns true after setting files', () => {
    setFileCache(sampleFiles);

    expect(hasFileCache()).toBe(true);
  });

  test('hasFileCache returns false after setting empty array', () => {
    setFileCache([]);

    expect(hasFileCache()).toBe(false);
  });

  test('setFileCache overwrites previous cache', () => {
    setFileCache(sampleFiles);
    const newFiles: FileEntry[] = [{ path: '/other/file.txt', name: 'file.txt', type: 'file' }];
    setFileCache(newFiles);

    expect(getFileCache()).toEqual(newFiles);
    expect(getFileCache()).toHaveLength(1);
  });

  test('clearFileCache resets to empty', () => {
    setFileCache(sampleFiles);
    clearFileCache();

    expect(getFileCache()).toEqual([]);
    expect(hasFileCache()).toBe(false);
  });

  test('getFileCacheAge returns time since last update', () => {
    setFileCache(sampleFiles);

    const age = getFileCacheAge();
    expect(age).toBeGreaterThanOrEqual(0);
    expect(age).toBeLessThan(5000);
  });

  test('getFileCacheAge resets after clearFileCache', () => {
    setFileCache(sampleFiles);
    clearFileCache();

    // After clear, lastUpdateTime is 0, so age = Date.now() - 0 (very large)
    const age = getFileCacheAge();
    expect(age).toBeGreaterThan(1000);
  });

  test('increments cache version when the cache changes', () => {
    expect(getFileCacheVersion()).toBe(0);

    setFileCache(sampleFiles);
    expect(getFileCacheVersion()).toBe(1);

    clearFileCache();
    expect(getFileCacheVersion()).toBe(2);
  });

  test('notifies subscribers when the cache changes', () => {
    const calls: number[] = [];
    const unsubscribe = subscribeFileCache(() => {
      calls.push(getFileCacheVersion());
    });

    setFileCache(sampleFiles);
    clearFileCache();
    unsubscribe();
    setFileCache(sampleFiles);

    expect(calls).toEqual([1, 2]);
  });
});
