import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';

import {
  getComposerFileDropData,
  getComposerTabMentionData,
  isComposerFileDrag,
  resolveComposerFileDropData,
} from './composerDrop';
import { clearActiveFileDragData, setActiveFileDragData } from './fileDragData';
import { clearActivePaneTabDragData, setActivePaneTabDragData } from './paneTabDrag';

function makeDataTransfer({
  json = '',
  types = [],
  files = [],
}: {
  json?: string;
  types?: string[];
  files?: Array<File & { path?: string }>;
}) {
  const fileList = Object.assign([...files], { length: files.length }) as unknown as FileList;

  return {
    getData: (type: string) => (type === 'application/json' ? json : ''),
    types,
    files: fileList,
  } as Pick<DataTransfer, 'getData' | 'types' | 'files'>;
}

describe('getComposerTabMentionData', () => {
  test('maps file tabs to file mentions', () => {
    assert.deepEqual(
      getComposerTabMentionData({
        id: 'tab-1',
        type: 'file',
        label: 'README.md',
        path: '/workspace/README.md',
      }),
      {
        id: '/workspace/README.md',
        label: 'README.md',
        itemType: 'file',
      },
    );
  });

  test('maps browser tabs to browser-tab mentions', () => {
    assert.deepEqual(
      getComposerTabMentionData({
        id: 'tab-2',
        type: 'browser',
        label: 'Docs',
        browserId: 'browser-1',
        url: 'https://example.com',
        faviconUrl: 'https://example.com/favicon.ico',
      }),
      {
        id: 'browser-1',
        label: 'Docs',
        itemType: 'browser-tab',
        url: 'https://example.com',
        faviconUrl: 'https://example.com/favicon.ico',
      },
    );
  });

  test('returns null for non-mentionable tabs', () => {
    assert.equal(
      getComposerTabMentionData({
        id: 'tab-3',
        type: 'agent',
        label: 'Agent',
      }),
      null,
    );
  });

  test('maps file tabs to composer file-drop data', () => {
    assert.deepEqual(
      getComposerFileDropData({
        id: 'tab-4',
        type: 'file',
        label: 'notes.md',
        path: '/workspace/notes.md',
      }),
      {
        filePath: '/workspace/notes.md',
        fileName: 'notes.md',
        isDirectory: false,
      },
    );
  });

  test('resolves explorer file drags for composer drops', () => {
    const dataTransfer = makeDataTransfer({
      json: JSON.stringify({
        type: 'file',
        sourceContext: 'explorer',
        filePath: '/workspace/report.pdf',
        fileName: 'report.pdf',
        isDirectory: false,
      }),
      types: ['application/json', 'application/x-file-drag'],
    });

    assert.equal(isComposerFileDrag(dataTransfer, {}), true);
    assert.deepEqual(resolveComposerFileDropData(dataTransfer, {}), {
      filePath: '/workspace/report.pdf',
      fileName: 'report.pdf',
      isDirectory: false,
    });
  });

  test('resolves dragged file tabs for composer drops', () => {
    const dataTransfer = makeDataTransfer({
      json: JSON.stringify({
        type: 'pane-tab',
        tabId: 'file-tab',
        sourcePaneId: 'pane-1',
      }),
      types: ['application/json', 'text/plain'],
    });

    const tabs = {
      'file-tab': {
        id: 'file-tab',
        type: 'file' as const,
        label: 'draft.md',
        path: '/workspace/draft.md',
      },
    };

    assert.equal(isComposerFileDrag(dataTransfer, tabs), true);
    assert.deepEqual(resolveComposerFileDropData(dataTransfer, tabs), {
      filePath: '/workspace/draft.md',
      fileName: 'draft.md',
      isDirectory: false,
    });
  });

  test('does not treat non-file pane tabs as composer file drops', () => {
    const dataTransfer = makeDataTransfer({
      json: JSON.stringify({
        type: 'pane-tab',
        tabId: 'agent-tab',
        sourcePaneId: 'pane-1',
      }),
      types: ['application/json', 'text/plain'],
    });

    const tabs = {
      'agent-tab': {
        id: 'agent-tab',
        type: 'agent' as const,
        label: 'Agent',
      },
    };

    assert.equal(isComposerFileDrag(dataTransfer, tabs), false);
    assert.equal(resolveComposerFileDropData(dataTransfer, tabs), null);
  });

  test('resolves native file drags for composer drops', () => {
    const dataTransfer = makeDataTransfer({
      types: ['Files'],
      files: [{ name: 'image.png', path: '/workspace/image.png' } as File & { path?: string }],
    });

    assert.equal(isComposerFileDrag(dataTransfer, {}), true);
    assert.deepEqual(resolveComposerFileDropData(dataTransfer, {}), {
      filePath: '/workspace/image.png',
      fileName: 'image.png',
      isDirectory: false,
    });
  });

  test('prefers the dropped native file over stale pane-tab drag state', () => {
    setActivePaneTabDragData({
      type: 'pane-tab',
      tabId: 'agent-tab',
      sourcePaneId: 'pane-1',
    });

    const dataTransfer = makeDataTransfer({
      types: ['Files'],
      files: [{ name: 'image.png', path: '/workspace/image.png' } as File & { path?: string }],
    });

    assert.deepEqual(resolveComposerFileDropData(dataTransfer, {
      'agent-tab': {
        id: 'agent-tab',
        type: 'agent',
        label: 'Agent',
      },
    }), {
      filePath: '/workspace/image.png',
      fileName: 'image.png',
      isDirectory: false,
    });

    clearActivePaneTabDragData();
  });

  test('resolves explorer uri-list drags when application/json is unavailable', () => {
    const dataTransfer = {
      getData: (type: string) => type === 'text/uri-list'
        ? 'file:///workspace/notes.txt'
        : '',
      types: ['text/uri-list'],
      files: Object.assign([], { length: 0 }) as unknown as FileList,
    } as Pick<DataTransfer, 'getData' | 'types' | 'files'>;

    assert.equal(isComposerFileDrag(dataTransfer, {}), true);
    assert.deepEqual(resolveComposerFileDropData(dataTransfer, {}), {
      filePath: '/workspace/notes.txt',
      fileName: 'notes.txt',
      isDirectory: false,
    });
  });

  test('normalizes Windows uri-list drags before resolving the file path', () => {
    const dataTransfer = {
      getData: (type: string) => type === 'text/uri-list'
        ? 'file:///C:/workspace/notes.txt'
        : '',
      types: ['text/uri-list'],
      files: Object.assign([], { length: 0 }) as unknown as FileList,
    } as Pick<DataTransfer, 'getData' | 'types' | 'files'>;

    assert.equal(isComposerFileDrag(dataTransfer, {}), true);
    assert.deepEqual(resolveComposerFileDropData(dataTransfer, {}), {
      filePath: 'C:\\workspace\\notes.txt',
      fileName: 'notes.txt',
      isDirectory: false,
    });
  });

  test('uses the active internal file drag when hover payloads are unavailable', () => {
    setActiveFileDragData({
      type: 'file',
      sourceContext: 'explorer',
      filePath: '/workspace/notes.txt',
      fileName: 'notes.txt',
      isDirectory: false,
    });

    const dataTransfer = makeDataTransfer({
      types: [],
    });

    assert.equal(isComposerFileDrag(dataTransfer, {}), true);
    assert.deepEqual(resolveComposerFileDropData(dataTransfer, {}), {
      filePath: '/workspace/notes.txt',
      fileName: 'notes.txt',
      isDirectory: false,
    });

    clearActiveFileDragData();
  });
});
