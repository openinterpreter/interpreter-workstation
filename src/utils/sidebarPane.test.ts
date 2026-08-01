import { describe, expect, test } from 'bun:test';

import type { Pane } from '../../shared/types/layout';
import { appendSidebarPaneTab, insertSidebarPaneTab, removeSidebarPaneTab } from './sidebarPane';

function createSidebarPane(tabIds: string[], activeTabId: string | null): Pane {
  return {
    kind: 'pane',
    id: 'sidebar',
    tabIds,
    activeTabId,
  };
}

describe('sidebarPane helpers', () => {
  test('insertSidebarPaneTab inserts at a specific index and activates the tab', () => {
    const sidebarPane = createSidebarPane(['agent-1', 'agent-3'], 'agent-1');

    expect(insertSidebarPaneTab(sidebarPane, 'agent-2', 1)).toEqual({
      kind: 'pane',
      id: 'sidebar',
      tabIds: ['agent-1', 'agent-2', 'agent-3'],
      activeTabId: 'agent-2',
    });
  });

  test('insertSidebarPaneTab reorders an existing tab within the sidebar', () => {
    const sidebarPane = createSidebarPane(['agent-1', 'agent-2', 'agent-3'], 'agent-1');

    expect(insertSidebarPaneTab(sidebarPane, 'agent-3', 0)).toEqual({
      kind: 'pane',
      id: 'sidebar',
      tabIds: ['agent-3', 'agent-1', 'agent-2'],
      activeTabId: 'agent-3',
    });
  });

  test('insertSidebarPaneTab preserves the intended slot when moving an existing tab downward', () => {
    const sidebarPane = createSidebarPane(['agent-1', 'agent-2', 'agent-3'], 'agent-1');

    expect(insertSidebarPaneTab(sidebarPane, 'agent-1', 2)).toEqual({
      kind: 'pane',
      id: 'sidebar',
      tabIds: ['agent-2', 'agent-1', 'agent-3'],
      activeTabId: 'agent-1',
    });
  });

  test('appendSidebarPaneTab creates a sidebar pane when empty', () => {
    expect(appendSidebarPaneTab(null, 'agent-1')).toEqual({
      kind: 'pane',
      id: 'sidebar',
      tabIds: ['agent-1'],
      activeTabId: 'agent-1',
    });
  });

  test('appendSidebarPaneTab appends and activates without duplicating', () => {
    const sidebarPane = createSidebarPane(['agent-1', 'agent-2'], 'agent-1');

    expect(appendSidebarPaneTab(sidebarPane, 'agent-3')).toEqual({
      kind: 'pane',
      id: 'sidebar',
      tabIds: ['agent-1', 'agent-2', 'agent-3'],
      activeTabId: 'agent-3',
    });
    expect(appendSidebarPaneTab(sidebarPane, 'agent-1')).toEqual({
      kind: 'pane',
      id: 'sidebar',
      tabIds: ['agent-2', 'agent-1'],
      activeTabId: 'agent-1',
    });
  });

  test('removeSidebarPaneTab picks the next surviving tab when removing the active tab', () => {
    const sidebarPane = createSidebarPane(['agent-1', 'agent-2', 'agent-3'], 'agent-2');

    expect(removeSidebarPaneTab(sidebarPane, 'agent-2')).toEqual({
      kind: 'pane',
      id: 'sidebar',
      tabIds: ['agent-1', 'agent-3'],
      activeTabId: 'agent-3',
    });
  });

  test('removeSidebarPaneTab falls back to the first remaining tab when removing the last active tab', () => {
    const sidebarPane = createSidebarPane(['agent-1', 'agent-2'], 'agent-2');

    expect(removeSidebarPaneTab(sidebarPane, 'agent-2')).toEqual({
      kind: 'pane',
      id: 'sidebar',
      tabIds: ['agent-1'],
      activeTabId: 'agent-1',
    });
  });

  test('removeSidebarPaneTab collapses the sidebar when the last tab is removed', () => {
    const sidebarPane = createSidebarPane(['agent-1'], 'agent-1');

    expect(removeSidebarPaneTab(sidebarPane, 'agent-1')).toBeNull();
  });
});
