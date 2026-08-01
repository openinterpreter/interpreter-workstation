import { markResolvedDirs, type FileTreeNode } from './fileTreeTransform';

describe('markResolvedDirs', () => {
  test('sets isResolved:true for directories with children array', () => {
    const input: FileTreeNode[] = [
      { name: 'folder', path: 'folder', type: 'directory', children: [] },
    ];
    const result = markResolvedDirs(input);
    expect(result[0].isResolved).toBe(true);
  });

  test('sets isResolved:false for directories without children', () => {
    const input: FileTreeNode[] = [
      { name: 'folder', path: 'folder', type: 'directory' },
    ];
    const result = markResolvedDirs(input);
    expect(result[0].isResolved).toBe(false);
  });

  // NOTE(victor): react-arborist's isLeaf check is `!Array.isArray(children)`.
  // Directories with undefined children cannot be expanded. This test prevents regression.
  test('unloaded directories get empty children array for react-arborist expansion', () => {
    const input: FileTreeNode[] = [
      { name: 'unloaded', path: 'unloaded', type: 'directory' },
    ];
    const result = markResolvedDirs(input);
    expect(Array.isArray(result[0].children)).toBe(true);
    expect(result[0].children).toEqual([]);
    expect(result[0].isResolved).toBe(false);
  });

  test('sets isResolved:false for files', () => {
    const input: FileTreeNode[] = [
      { name: 'file.txt', path: 'file.txt', type: 'file' },
    ];
    const result = markResolvedDirs(input);
    expect(result[0].isResolved).toBe(false);
  });

  test('recursively marks nested directories', () => {
    const input: FileTreeNode[] = [
      {
        name: 'root',
        path: 'root',
        type: 'directory',
        children: [
          { name: 'nested', path: 'root/nested', type: 'directory', children: [] },
          { name: 'unloaded', path: 'root/unloaded', type: 'directory' },
        ],
      },
    ];
    const result = markResolvedDirs(input);
    expect(result[0].isResolved).toBe(true);
    expect(result[0].children![0].isResolved).toBe(true);
    expect(result[0].children![1].isResolved).toBe(false);
  });
});
