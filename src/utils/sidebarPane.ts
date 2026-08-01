import type { Pane } from '../../shared/types/layout';

function createSidebarPane(): Pane {
  return {
    kind: 'pane',
    id: 'sidebar',
    tabIds: [],
    activeTabId: null,
  };
}

export function insertSidebarPaneTab(sidebarPane: Pane | null, tabId: string, index: number): Pane {
  const pane = sidebarPane ?? createSidebarPane();
  const existingIndex = pane.tabIds.indexOf(tabId);
  const tabIds = pane.tabIds.filter((id) => id !== tabId);
  const adjustedIndex = existingIndex !== -1 && existingIndex < index
    ? index - 1
    : index;
  const clampedIndex = Math.max(0, Math.min(adjustedIndex, tabIds.length));
  tabIds.splice(clampedIndex, 0, tabId);

  return {
    ...pane,
    id: 'sidebar',
    tabIds,
    activeTabId: tabId,
  };
}

export function appendSidebarPaneTab(sidebarPane: Pane | null, tabId: string): Pane {
  const insertIndex = sidebarPane?.tabIds.length ?? 0;
  return insertSidebarPaneTab(sidebarPane, tabId, insertIndex);
}

export function removeSidebarPaneTab(sidebarPane: Pane | null, tabId: string): Pane | null {
  if (!sidebarPane) {
    return null;
  }

  const removedIndex = sidebarPane.tabIds.indexOf(tabId);
  if (removedIndex === -1) {
    return sidebarPane;
  }

  const tabIds = sidebarPane.tabIds.filter((id) => id !== tabId);
  if (tabIds.length === 0) {
    return null;
  }

  const activeTabId = sidebarPane.activeTabId === tabId
    ? (tabIds[removedIndex] ?? tabIds[0] ?? null)
    : (sidebarPane.activeTabId && tabIds.includes(sidebarPane.activeTabId)
      ? sidebarPane.activeTabId
      : (tabIds[0] ?? null));

  return {
    ...sidebarPane,
    id: 'sidebar',
    tabIds,
    activeTabId,
  };
}
