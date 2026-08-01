import { describe, expect, test } from 'bun:test';
import type { DisplayInfo } from '../shared/types';
import {
  buildOverlayContextItemsFromSelectionToolJson,
  createSelectedTextContextItem,
  type NormalizeOverlayFileContextPaths,
} from './selection-tool-context';

const display: DisplayInfo = {
  id: 'display-1',
  boundsDIP: { x: 100, y: 200, width: 800, height: 600 },
  scaleFactor: 2,
};

describe('selection tool overlay context conversion', () => {
  test('builds selected text context without screen bounds for window voice', () => {
    const item = createSelectedTextContextItem(' Window selected copy ', null, null);

    expect(item).toMatchObject({
      kind: 'file',
      role: 'reference',
      name: 'Selected text.txt',
      mimeType: 'text/plain',
      filePath: null,
      sourceKind: 'selected-text',
      sourceLabel: 'Selected text',
      sourceBounds: null,
      sourceDisplayId: null,
    });
    expect(item.dataUrl).toContain(Buffer.from('Window selected copy').toString('base64'));
  });

  test('converts selected text from the selection tool into an overlay reference item', async () => {
    const items = await buildOverlayContextItemsFromSelectionToolJson(JSON.stringify({
      text: {
        text: ' Selected paragraph ',
        bounds: { x: 120, y: 240, width: 300, height: 40 },
      },
      files: [],
      deniedFiles: [],
    }), display, async () => []);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'file',
      role: 'reference',
      name: 'Selected text.txt',
      mimeType: 'text/plain',
      filePath: null,
      sourceKind: 'selected-text',
      sourceLabel: 'Selected text',
      sourceBounds: { x: 20, y: 40, width: 300, height: 40 },
      sourceDisplayId: 'display-1',
    });
    expect(items[0]?.dataUrl).toContain(Buffer.from('Selected paragraph').toString('base64'));
  });

  test('normalizes permitted selected files with source metadata from the selection tool', async () => {
    const calls: Parameters<NormalizeOverlayFileContextPaths>[] = [];
    const normalize: NormalizeOverlayFileContextPaths = async (...args) => {
      calls.push(args);
      return [{
        id: 'file-1',
        kind: 'file',
        role: 'reference',
        name: 'notes.txt',
        mimeType: 'text/plain',
        sizeBytes: 10,
        filePath: args[0][0] ?? null,
        ...args[1],
      }];
    };

    const items = await buildOverlayContextItemsFromSelectionToolJson(JSON.stringify({
      text: null,
      files: [{
        path: '/workspace/notes.txt',
        bounds: { x: 150, y: 260, width: 80, height: 30 },
      }],
      deniedFiles: [{ name: 'secret.txt', reason: 'read permission denied by agent file scope' }],
    }), display, normalize);

    expect(calls).toEqual([
      [
        ['/workspace/notes.txt'],
        {
          sourceKind: 'selected-file',
          sourceLabel: 'Selected file',
          sourceBounds: { x: 50, y: 60, width: 80, height: 30 },
          sourceDisplayId: 'display-1',
        },
      ],
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.filePath).toBe('/workspace/notes.txt');
  });

  test('deduplicates selected files before normalizing them', async () => {
    const paths: string[] = [];
    const normalize: NormalizeOverlayFileContextPaths = async (filePaths) => {
      paths.push(...filePaths);
      return [];
    };

    await buildOverlayContextItemsFromSelectionToolJson(JSON.stringify({
      text: null,
      files: [
        { path: '/workspace/a.txt', bounds: null },
        { path: '/workspace/a.txt', bounds: null },
        { path: '/workspace/b.txt', bounds: null },
      ],
    }), display, normalize);

    expect(paths).toEqual(['/workspace/a.txt', '/workspace/b.txt']);
  });
});
