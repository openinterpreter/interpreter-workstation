import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';

import { openMentionTarget } from './openMentionTarget';

describe('openMentionTarget', () => {
  test('opens directory mentions as folder tabs', () => {
    const calls: string[] = [];

    openMentionTarget(
      { path: '/tmp/mockups', itemType: 'directory' },
      {
        windowingApi: {
          openFile: (path) => calls.push(`file:${path}`),
          openFolder: (path) => calls.push(`folder:${path}`),
        },
      },
    );

    assert.deepEqual(calls, ['folder:/tmp/mockups']);
  });

  test('opens file mentions and schedules reference scrolling', () => {
    const calls: string[] = [];
    let scrollDetail: { path: string; fragment?: string; lineStart?: number; lineEnd?: number } | null = null;

    openMentionTarget(
      {
        path: '/tmp/notes.md',
        itemType: 'file',
        lineStart: 12,
        lineEnd: 15,
      },
      {
        windowingApi: {
          openFile: (path) => calls.push(`file:${path}`),
          openFolder: (path) => calls.push(`folder:${path}`),
        },
        scheduleScroll: (detail) => {
          scrollDetail = detail;
        },
      },
    );

    assert.deepEqual(calls, ['file:/tmp/notes.md']);
    assert.deepEqual(scrollDetail, {
      path: '/tmp/notes.md',
      lineStart: 12,
      lineEnd: 15,
      fragment: undefined,
    });
  });

  test('resolves relative response links against the active workspace', () => {
    const calls: string[] = [];

    openMentionTarget(
      { path: 'reports/summary.docx', itemType: 'file' },
      {
        workspacePath: '/tmp/project',
        windowingApi: {
          openFile: (path) => calls.push(path),
        },
      },
    );

    assert.deepEqual(calls, ['/tmp/project/reports/summary.docx']);
  });
});
