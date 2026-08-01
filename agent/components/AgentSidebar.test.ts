import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';

import { canAcceptSidebarPaneTabDrag, parsePaneTabDragData } from './AgentSidebar';
import {
  clearActivePaneTabDragData,
  createPaneTabDragData,
  resolvePaneTabDragData,
  setActivePaneTabDragData,
} from '../../src/utils/paneTabDrag';
import { clearActiveFileDragData, setActiveFileDragData } from '../../src/utils/fileDragData';
import type { Tab } from '../../shared/types/layout';

function makeTab(id: string, type: Tab['type'] = 'agent'): Tab {
  return {
    id,
    type,
    label: 'Tab',
  };
}

describe('parsePaneTabDragData', () => {
  test('parses pane-tab payloads', () => {
    assert.deepEqual(
      parsePaneTabDragData(JSON.stringify({
        type: 'pane-tab',
        tabId: 'agent-1',
        sourcePaneId: 'pane-1',
      })),
      {
        type: 'pane-tab',
        tabId: 'agent-1',
        sourcePaneId: 'pane-1',
      },
    );
  });

  test('returns null for non pane-tab payloads', () => {
    assert.equal(
      parsePaneTabDragData(JSON.stringify({ type: 'file', tabId: 'agent-1' })),
      null,
    );
  });
});

describe('createPaneTabDragData', () => {
  test('includes the source window session key for cross-window drags', () => {
    const globalObject = globalThis as typeof globalThis & {
      window?: {
        electron?: {
          getWindowSessionKey?: () => string;
        };
      };
    };
    const previousWindow = globalObject.window;

    globalObject.window = {
      electron: {
        getWindowSessionKey: () => 'window-sidebar-1',
      },
    };

    try {
      assert.deepEqual(
        createPaneTabDragData({
          tabId: 'agent-1',
          sourcePaneId: 'sidebar',
          sourceIndex: 1,
          tab: makeTab('agent-1'),
          sidebarMeta: {
            tabType: 'agent',
            label: 'Tab',
            agentTabId: 'agent-1',
          },
        }),
        {
          type: 'pane-tab',
          tabId: 'agent-1',
          sourcePaneId: 'sidebar',
          sourceIndex: 1,
          sourceWindowSessionKey: 'window-sidebar-1',
          tab: makeTab('agent-1'),
          sidebarMeta: {
            tabType: 'agent',
            label: 'Tab',
            agentTabId: 'agent-1',
          },
        },
      );
    } finally {
      globalObject.window = previousWindow;
    }
  });
});

describe('canAcceptSidebarPaneTabDrag', () => {
  test('accepts eligible agent tab drags', () => {
    assert.equal(
      canAcceptSidebarPaneTabDrag({
        dragTypes: ['text/plain', 'application/json'],
        dragData: {
          type: 'pane-tab',
          tabId: 'agent-1',
          sourcePaneId: 'pane-1',
        },
        tabs: { 'agent-1': makeTab('agent-1') },
      }),
      true,
    );
  });

  test('rejects sidebar-origin drags', () => {
    assert.equal(
      canAcceptSidebarPaneTabDrag({
        dragTypes: ['text/plain', 'application/json'],
        dragData: {
          type: 'pane-tab',
          tabId: 'agent-1',
          sourcePaneId: 'sidebar',
        },
        tabs: { 'agent-1': makeTab('agent-1') },
      }),
      false,
    );
  });

  test('rejects drags that have no resolved pane-tab payload', () => {
    assert.equal(
      canAcceptSidebarPaneTabDrag({
        dragTypes: ['text/plain', 'application/json'],
        dragData: null,
        tabs: {},
      }),
      false,
    );
  });

  test('rejects explorer file drags', () => {
    assert.equal(
      canAcceptSidebarPaneTabDrag({
        dragTypes: ['application/json', 'text/uri-list'],
        dragData: null,
        tabs: {},
      }),
      false,
    );
  });
});

describe('resolvePaneTabDragData', () => {
  test('falls back to the active in-process drag payload when drop data is unavailable', () => {
    setActivePaneTabDragData({
      type: 'pane-tab',
      tabId: 'agent-1',
      sourcePaneId: 'pane-1',
      sourceIndex: 2,
    });

    assert.deepEqual(
      resolvePaneTabDragData({
        getData: (_type: string) => '',
        types: [],
      }),
      {
        type: 'pane-tab',
        tabId: 'agent-1',
        sourcePaneId: 'pane-1',
        sourceIndex: 2,
      },
    );

    clearActivePaneTabDragData();
  });

  test('does not fall back to active pane-tab drag for explorer file payloads', () => {
    setActivePaneTabDragData({
      type: 'pane-tab',
      tabId: 'agent-1',
      sourcePaneId: 'pane-1',
      sourceIndex: 2,
    });

    assert.equal(
      resolvePaneTabDragData({
        getData: (type: string) => type === 'application/json'
          ? JSON.stringify({
            type: 'file',
            sourceContext: 'explorer',
            filePath: '/workspace/notes.md',
            fileName: 'notes.md',
            isDirectory: false,
          })
          : '',
        types: ['application/json', 'text/uri-list'],
      }),
      null,
    );

    clearActivePaneTabDragData();
  });

  test('does not fall back to active pane-tab drag for native file drags', () => {
    setActivePaneTabDragData({
      type: 'pane-tab',
      tabId: 'agent-1',
      sourcePaneId: 'pane-1',
      sourceIndex: 2,
    });

    assert.equal(
      resolvePaneTabDragData({
        getData: (_type: string) => '',
        types: ['Files'],
      }),
      null,
    );

    clearActivePaneTabDragData();
  });

  test('does not fall back to active pane-tab drag while an internal file drag is active', () => {
    setActivePaneTabDragData({
      type: 'pane-tab',
      tabId: 'agent-1',
      sourcePaneId: 'pane-1',
      sourceIndex: 2,
    });
    setActiveFileDragData({
      type: 'file',
      sourceContext: 'explorer',
      filePath: '/workspace/notes.md',
      fileName: 'notes.md',
      isDirectory: false,
    });

    assert.equal(
      resolvePaneTabDragData({
        getData: (_type: string) => '',
        types: [],
      }),
      null,
    );

    clearActiveFileDragData();
    clearActivePaneTabDragData();
  });
});
