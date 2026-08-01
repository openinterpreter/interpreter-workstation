/**
 * Windowing API
 *
 * Public API for programmatic window management
 * All operations go through the LayoutContext
 */

import type { LayoutState, Tab, Pane } from '../utils/layoutHelpers';
import { getAllPanes, findPaneById } from '../utils/treeOperations';

/**
 * Interface for layout context getter
 */
interface LayoutContextGetter {
  (): {
    state: LayoutState;
    actions: {
      openFile: (path: string, paneId?: string) => void;
      openFolder: (path: string, paneId?: string) => string;
      openBrowser: (url: string, paneId?: string, browserId?: string) => void;
      closeTab: (tabId: string) => void;
      setActiveTab: (tabId: string) => void;
      moveTab: (tabId: string, targetPaneId: string, index: number) => void;
      splitPaneAction: (paneId: string, direction: 'horizontal' | 'vertical', position: 'before' | 'after', tabId?: string) => string | null;
      setActivePaneId: (paneId: string) => void;
      openNewTab: (paneId?: string) => void;
      toggleLeftSidebar: () => void;
      toggleRightSidebar: () => void;
      setLeftSidebarTab: (tab: 'explorer' | 'browser' | 'inbox') => void;
      setLeftSidebarWidth: (width: number) => void;
      setRightSidebarWidth: (width: number) => void;
      resetToDefaults: () => void;
      setLayoutState: (state: LayoutState) => void;
      getState: () => LayoutState;
    };
  };
}

/**
 * Public API for programmatic window management
 */
export class WindowingAPI {
  private getContext: LayoutContextGetter | null = null;

  init(contextGetter: LayoutContextGetter) {
    this.getContext = contextGetter;
  }

  private ensureInitialized(): boolean {
    if (!this.getContext) {
      console.error('WindowingAPI not initialized. Call init() first.');
      return false;
    }
    return true;
  }

  // ========================================================================
  // FILE MANAGEMENT
  // ========================================================================

  openFile(path: string, options?: { paneId?: string; split?: boolean }): void {
    if (!this.ensureInitialized()) return;

    try {
      const { actions } = this.getContext!();
      const state = actions.getState();

      if (options?.split) {
        const activePaneId = state.activePaneId || getAllPanes(state.tree)[0]?.id;
        if (activePaneId) {
          const newPaneId = actions.splitPaneAction(activePaneId, 'horizontal', 'after');
          if (newPaneId) {
            actions.openFile(path, newPaneId);
          } else {
            actions.openFile(path, options?.paneId || undefined);
          }
        } else {
          actions.openFile(path, options?.paneId || undefined);
        }
      } else {
        actions.openFile(path, options?.paneId || undefined);
      }
    } catch (error) {
      console.error('Error opening file:', error);
    }
  }

  openFolder(path: string, options?: { paneId?: string }): string {
    if (!this.ensureInitialized()) return '';

    try {
      const { actions } = this.getContext!();
      return actions.openFolder(path, options?.paneId);
    } catch (error) {
      console.error('Error opening folder:', error);
      return '';
    }
  }

  closeFile(path: string): void {
    if (!this.ensureInitialized()) return;

    try {
      const { actions } = this.getContext!();
      const state = actions.getState();

      for (const tab of Object.values(state.tabs)) {
        if (tab.type === 'file' && tab.path === path) {
          actions.closeTab(tab.id);
        }
      }
    } catch (error) {
      console.error('Error closing file:', error);
    }
  }

  closeAllFiles(): void {
    if (!this.ensureInitialized()) return;

    try {
      const { actions } = this.getContext!();
      const state = actions.getState();

      for (const tab of Object.values(state.tabs)) {
        if (tab.type === 'file') {
          actions.closeTab(tab.id);
        }
      }
    } catch (error) {
      console.error('Error closing all files:', error);
    }
  }

  // ========================================================================
  // BROWSER MANAGEMENT
  // ========================================================================

  openBrowser(url: string, options?: { paneId?: string; browserId?: string }): void {
    if (!this.ensureInitialized()) return;

    try {
      const { actions } = this.getContext!();
      actions.openBrowser(url, options?.paneId, options?.browserId);
    } catch (error) {
      console.error('Error opening browser:', error);
    }
  }

  // ========================================================================
  // TAB MANAGEMENT
  // ========================================================================

  closeTab(tabId: string): void {
    if (!this.ensureInitialized()) return;

    try {
      const { actions } = this.getContext!();
      actions.closeTab(tabId);
    } catch (error) {
      console.error('Error closing tab:', error);
    }
  }

  switchToTab(tabId: string): void {
    if (!this.ensureInitialized()) return;

    try {
      const { actions } = this.getContext!();
      actions.setActiveTab(tabId);
    } catch (error) {
      console.error('Error switching tab:', error);
    }
  }

  getOpenTabs(): Tab[] {
    if (!this.ensureInitialized()) return [];

    try {
      const { actions } = this.getContext!();
      const state = actions.getState();
      return Object.values(state.tabs);
    } catch (error) {
      console.error('Error getting open tabs:', error);
      return [];
    }
  }

  getPaneTabs(paneId: string): Tab[] | null {
    if (!this.ensureInitialized()) return null;

    try {
      const { actions } = this.getContext!();
      const state = actions.getState();
      const pane = findPaneById(state.tree, paneId);
      if (!pane) return null;
      return pane.tabIds.map(id => state.tabs[id]).filter(Boolean);
    } catch (error) {
      console.error('Error getting pane tabs:', error);
      return null;
    }
  }

  // ========================================================================
  // PANE MANAGEMENT
  // ========================================================================

  splitPane(paneId: string, direction: 'horizontal' | 'vertical' = 'horizontal', position: 'before' | 'after' = 'after'): string | null {
    if (!this.ensureInitialized()) return null;

    try {
      const { actions } = this.getContext!();
      return actions.splitPaneAction(paneId, direction, position);
    } catch (error) {
      console.error('Error splitting pane:', error);
      return null;
    }
  }

  getPanes(): Pane[] {
    if (!this.ensureInitialized()) return [];

    try {
      const { actions } = this.getContext!();
      const state = actions.getState();
      return getAllPanes(state.tree);
    } catch (error) {
      console.error('Error getting panes:', error);
      return [];
    }
  }

  getActivePane(): string | null {
    if (!this.ensureInitialized()) return null;

    try {
      const { actions } = this.getContext!();
      const state = actions.getState();
      return state.activePaneId;
    } catch (error) {
      console.error('Error getting active pane:', error);
      return null;
    }
  }

  // ========================================================================
  // SIDEBAR MANAGEMENT
  // ========================================================================

  toggleLeftSidebar(): void {
    if (!this.ensureInitialized()) return;

    try {
      const { actions } = this.getContext!();
      actions.toggleLeftSidebar();
    } catch (error) {
      console.error('Error toggling left sidebar:', error);
    }
  }

  toggleRightSidebar(): void {
    if (!this.ensureInitialized()) return;

    try {
      const { actions } = this.getContext!();
      actions.toggleRightSidebar();
    } catch (error) {
      console.error('Error toggling right sidebar:', error);
    }
  }

  openLeftSidebar(tab: 'explorer' | 'browser' | 'inbox'): void {
    if (!this.ensureInitialized()) return;

    try {
      const { actions } = this.getContext!();
      const state = actions.getState();

      if (!state.leftSidebar.isOpen) {
        actions.toggleLeftSidebar();
      }
      actions.setLeftSidebarTab(tab);
    } catch (error) {
      console.error('Error opening left sidebar:', error);
    }
  }

  closeLeftSidebar(): void {
    if (!this.ensureInitialized()) return;

    try {
      const { actions } = this.getContext!();
      const state = actions.getState();

      if (state.leftSidebar.isOpen) {
        actions.toggleLeftSidebar();
      }
    } catch (error) {
      console.error('Error closing left sidebar:', error);
    }
  }

  closeRightSidebar(): void {
    if (!this.ensureInitialized()) return;

    try {
      const { actions } = this.getContext!();
      const state = actions.getState();

      if (state.rightSidebar.isOpen) {
        actions.toggleRightSidebar();
      }
    } catch (error) {
      console.error('Error closing right sidebar:', error);
    }
  }

  // ========================================================================
  // LAYOUT MANAGEMENT
  // ========================================================================

  resetLayout(): void {
    if (!this.ensureInitialized()) return;

    try {
      const { actions } = this.getContext!();
      actions.resetToDefaults();
    } catch (error) {
      console.error('Error resetting layout:', error);
    }
  }

  getLayoutState(): LayoutState | null {
    if (!this.ensureInitialized()) return null;

    try {
      const { actions } = this.getContext!();
      return actions.getState();
    } catch (error) {
      console.error('Error getting layout state:', error);
      return null;
    }
  }

  setLayoutState(state: LayoutState): void {
    if (!this.ensureInitialized()) return;

    try {
      const { actions } = this.getContext!();
      actions.setLayoutState(state);
    } catch (error) {
      console.error('Error setting layout state:', error);
    }
  }
}

// Singleton instance
export const windowingAPI = new WindowingAPI();

// Export types for TypeScript consumers
export type { LayoutState, Tab, Pane };
