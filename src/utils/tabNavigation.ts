import type { ActiveTabRegion, LayoutState, Pane, TreeNode } from '../../shared/types/layout';
import { isPane } from '../../shared/types/layout';
import { findPaneById, getAllPanes, getFirstPane } from './treeOperations';

interface TabNavigationEntry {
  tabId: string;
  region: ActiveTabRegion;
  paneId: string;
}

export interface TabNavigationTarget {
  region: ActiveTabRegion;
  paneId: string;
  tabIds: string[];
  activeTabId: string | null;
}

function getOrderedMainPanes(tree: TreeNode): Pane[] {
  if (isPane(tree)) {
    return [tree];
  }

  return getAllPanes(tree);
}

export function getOrderedTabEntries(
  state: Pick<LayoutState, 'tree' | 'sidebarPane'>,
): TabNavigationEntry[] {
  const entries: TabNavigationEntry[] = [];

  for (const pane of getOrderedMainPanes(state.tree)) {
    for (const tabId of pane.tabIds) {
      entries.push({
        tabId,
        region: 'main',
        paneId: pane.id,
      });
    }
  }

  if (state.sidebarPane) {
    for (const tabId of state.sidebarPane.tabIds) {
      entries.push({
        tabId,
        region: 'sidebar',
        paneId: state.sidebarPane.id,
      });
    }
  }

  return entries;
}

export function buildGlobalTabNumbers(
  state: Pick<LayoutState, 'tree' | 'sidebarPane'>,
): Map<string, number> {
  const orderedTabIds = getOrderedTabEntries(state).map((entry) => entry.tabId);
  const map = new Map<string, number>();

  for (let index = 0; index < orderedTabIds.length; index += 1) {
    if (index < 8) {
      map.set(orderedTabIds[index], index + 1);
    }
  }

  if (orderedTabIds.length > 0) {
    const lastTabId = orderedTabIds[orderedTabIds.length - 1];
    const existingNumber = map.get(lastTabId);
    if (!existingNumber || orderedTabIds.length > 8) {
      map.set(lastTabId, 9);
    }
  }

  return map;
}

export function resolveMainPane(
  state: Pick<LayoutState, 'tree' | 'activePaneId'>,
): Pane {
  const activePane = state.activePaneId
    ? findPaneById(state.tree, state.activePaneId)
    : null;

  return activePane ?? getFirstPane(state.tree);
}

export function resolveActiveTabRegion(
  state: Pick<LayoutState, 'activeTabRegion' | 'sidebarPane' | 'rightSidebar'>,
): ActiveTabRegion {
  if (
    state.activeTabRegion === 'sidebar'
    && state.rightSidebar.isOpen
    && (state.sidebarPane?.tabIds.length ?? 0) > 0
  ) {
    return 'sidebar';
  }

  return 'main';
}

export function resolveActiveTabTarget(
  state: Pick<LayoutState, 'tree' | 'activePaneId' | 'activeTabRegion' | 'sidebarPane' | 'rightSidebar'>,
): TabNavigationTarget {
  const region = resolveActiveTabRegion(state);

  if (region === 'sidebar' && state.sidebarPane) {
    return {
      region: 'sidebar',
      paneId: state.sidebarPane.id,
      tabIds: [...state.sidebarPane.tabIds],
      activeTabId: state.sidebarPane.activeTabId ?? state.sidebarPane.tabIds[0] ?? null,
    };
  }

  const pane = resolveMainPane(state);
  return {
    region: 'main',
    paneId: pane.id,
    tabIds: [...pane.tabIds],
    activeTabId: pane.activeTabId ?? pane.tabIds[0] ?? null,
  };
}

export function findTabNavigationEntry(
  state: Pick<LayoutState, 'tree' | 'sidebarPane'>,
  tabId: string,
): TabNavigationEntry | null {
  return getOrderedTabEntries(state).find((entry) => entry.tabId === tabId) ?? null;
}
