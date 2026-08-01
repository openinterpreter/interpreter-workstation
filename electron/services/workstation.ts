/**
 * Workstation Service
 *
 * Provides tools access to workstation context and control.
 * Follows the browserService pattern for consistency.
 *
 * ## Query Tools (use executeJavaScript)
 * - getContext() - Get full workstation context from LayoutContext
 * - getSelection() - Get current selection
 *
 * ## Control Tools (use IPC fire-and-forget)
 * - openFile(path) - Open file in editor
 * - openNewTab() - Create a new agent tab
 * - openUrl(url) - Open URL in browser tab
 * - closeTab(id) - Close a tab by ID
 * - focusTab(id) - Focus a tab by ID
 * - toggleSidebar(side) - Toggle sidebar visibility
 */

import { BrowserWindow } from './workstationElectronBridge';
import { IPC_CHANNELS } from '../ipc/registry';
import type { Selection } from '../../shared/types/workstation';
import {
  getCurrentWindowSessionKey,
  getWindowSessionByKey,
} from '../../server/utils/windowSessions';

/**
 * Tab information in workstation context
 */
export interface WorkstationTab {
  id: string;
  type: 'file' | 'browser' | 'email' | 'agent' | 'inbox' | 'unknown';
  title: string;
  path?: string;
  url?: string;
  isActive: boolean;
}

export type WorkstationSelection = Selection;

/**
 * Full workstation context
 */
export interface WorkstationContext {
  tabs: WorkstationTab[];
  activeTabId: string | null;
  workspacePath: string | null;
  selection: WorkstationSelection | null;
  leftSidebarOpen: boolean;
}

export class WorkstationService {
  private primaryWindowId: number | null = null;
  private rendererStateByWindowId = new Map<number, {
    ready: boolean;
    pendingMessages: Array<{ channel: string; args: any[] }>;
  }>();

  private isRegisteredWindowId(windowId: number | null | undefined): boolean {
    return typeof windowId === 'number' && this.rendererStateByWindowId.has(windowId);
  }

  private getFirstRegisteredWindow(options?: { excludeWindowId?: number | null }): BrowserWindow | null {
    for (const registeredWindowId of this.rendererStateByWindowId.keys()) {
      if (options?.excludeWindowId === registeredWindowId) {
        continue;
      }

      const registeredWindow = this.getWindowById(registeredWindowId);
      if (registeredWindow) {
        return registeredWindow;
      }
    }

    return null;
  }

  /**
   * Register a workstation window.
   * Must be called after window creation in main.ts.
   */
  registerWindow(window: BrowserWindow, options?: { primary?: boolean }) {
    const windowId = window.id;
    if (options?.primary || this.primaryWindowId === null) {
      this.primaryWindowId = windowId;
    }

    this.rendererStateByWindowId.set(windowId, {
      ready: false,
      pendingMessages: [],
    });

    // NOTE(victor): Reset ready state on navigation so dev reload (CMD+R) works correctly
    window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (!isInPlace && isMainFrame) {
        this.rendererStateByWindowId.set(windowId, {
          ready: false,
          pendingMessages: [],
        });
      }
    });

    console.log('[WorkstationService] Registered window', { windowId, primaryWindowId: this.primaryWindowId });
  }

  unregisterWindow(windowId: number): void {
    this.rendererStateByWindowId.delete(windowId);

    if (this.primaryWindowId === windowId) {
      this.primaryWindowId = this.getFirstRegisteredWindow({ excludeWindowId: windowId })?.id ?? null;
    }
  }

  setMainWindow(window: BrowserWindow) {
    this.registerWindow(window, { primary: true });
  }

  markRendererReady(windowId: number): void {
    const rendererState = this.rendererStateByWindowId.get(windowId);
    if (!rendererState || rendererState.ready) return;

    console.log('[WorkstationService] Renderer ready, flushing', rendererState.pendingMessages.length, 'pending messages for window', windowId);
    rendererState.ready = true;
    const pendingMessages = rendererState.pendingMessages;
    rendererState.pendingMessages = [];

    const targetWindow = this.getWindowById(windowId);
    if (!targetWindow) {
      return;
    }

    for (const { channel, args } of pendingMessages) {
      targetWindow.webContents.send(channel, ...args);
    }
  }

  private getWindowById(windowId: number | null | undefined): BrowserWindow | null {
    if (!windowId) {
      return null;
    }

    const targetWindow = BrowserWindow.fromId(windowId);
    if (!targetWindow || targetWindow.isDestroyed()) {
      return null;
    }
    return targetWindow;
  }

  private resolveTargetWindow(options?: { windowId?: number | null; sessionKey?: string | null }): BrowserWindow | null {
    if (options?.windowId) {
      return this.isRegisteredWindowId(options.windowId) ? this.getWindowById(options.windowId) : null;
    }

    if (options?.sessionKey) {
      const sessionWindowId = getWindowSessionByKey(options.sessionKey)?.windowId ?? null;
      return this.isRegisteredWindowId(sessionWindowId) ? this.getWindowById(sessionWindowId) : null;
    }

    const currentSessionKey = getCurrentWindowSessionKey();
    if (currentSessionKey) {
      const sessionWindowId = getWindowSessionByKey(currentSessionKey)?.windowId ?? null;
      const currentSessionWindow = this.getWindowById(sessionWindowId);
      if (currentSessionWindow) {
        return currentSessionWindow;
      }
    }

    const focusedWindow = BrowserWindow.getFocusedWindow();
    if (focusedWindow && !focusedWindow.isDestroyed() && this.isRegisteredWindowId(focusedWindow.id)) {
      return focusedWindow;
    }

    const primaryWindow = this.getWindowById(this.primaryWindowId);
    if (primaryWindow) {
      return primaryWindow;
    }

    return this.getFirstRegisteredWindow();
  }

  private sendWhenReadyToWindow(windowId: number, channel: string, ...args: any[]): void {
    const targetWindow = this.getWindowById(windowId);
    if (!targetWindow) {
      console.warn('[WorkstationService] sendWhenReady: no window available', { windowId, channel });
      return;
    }

    const rendererState = this.rendererStateByWindowId.get(windowId) ?? {
      ready: false,
      pendingMessages: [],
    };
    this.rendererStateByWindowId.set(windowId, rendererState);

    if (rendererState.ready) {
      targetWindow.webContents.send(channel, ...args);
      return;
    }

    console.log('[WorkstationService] Queuing message (renderer not ready):', channel, { windowId });
    rendererState.pendingMessages.push({ channel, args });
  }

  /**
   * Get the main window reference.
   */
  getMainWindow(): BrowserWindow | null {
    const primaryWindow = this.getWindowById(this.primaryWindowId);
    if (primaryWindow) {
      return primaryWindow;
    }

    const fallbackWindow = this.getFirstRegisteredWindow();
    this.primaryWindowId = fallbackWindow?.id ?? null;
    return fallbackWindow;
  }

  sendToMainRendererWhenReady(channel: string, data: unknown): void {
    const primaryWindow = this.getMainWindow();
    if (!primaryWindow) {
      return;
    }
    this.sendWhenReadyToWindow(primaryWindow.id, channel, data);
  }

  sendToWindowWhenReady(windowId: number, channel: string, data: unknown): void {
    this.sendWhenReadyToWindow(windowId, channel, data);
  }

  // ============================================================================
  // Query Tools (use executeJavaScript for synchronous renderer access)
  // ============================================================================

  /**
   * Get the full workstation context.
   * Executes JavaScript in renderer to read from LayoutContext.
   */
  async getContext(): Promise<WorkstationContext | null> {
    const targetWindow = this.resolveTargetWindow();
    if (!targetWindow) {
      console.warn('[WorkstationService] getContext called but window not available');
      return null;
    }

    try {
      const result = await targetWindow.webContents.executeJavaScript(
        'window.__getWorkstationContext ? window.__getWorkstationContext() : null'
      );
      return result;
    } catch (error) {
      console.error('[WorkstationService] Error getting context:', error);
      return null;
    }
  }

  /**
   * Get the agent-friendly layout object (or a sub-path of it).
   * Uses lodash-style path syntax (e.g. "tree.children[0].tabs").
   */
  async getLayout(path?: string): Promise<any> {
    const targetWindow = this.resolveTargetWindow();
    if (!targetWindow) {
      console.warn('[WorkstationService] getLayout called but window not available');
      return null;
    }

    try {
      const jsCall = path
        ? `window.__getWorkstationLayout ? window.__getWorkstationLayout(${JSON.stringify(path)}) : null`
        : `window.__getWorkstationLayout ? window.__getWorkstationLayout() : null`;
      const result = await targetWindow.webContents.executeJavaScript(jsCall);
      return result;
    } catch (error) {
      console.error('[WorkstationService] Error getting layout:', error);
      return null;
    }
  }

  /**
   * Set a value at a path in the layout object, with reconciliation.
   * Returns the resulting layout object after reconciliation.
   */
  async setLayout(path: string, value: any): Promise<any> {
    const targetWindow = this.resolveTargetWindow();
    if (!targetWindow) {
      console.warn('[WorkstationService] setLayout called but window not available');
      return null;
    }

    try {
      const result = await targetWindow.webContents.executeJavaScript(
        `window.__setWorkstationLayout ? window.__setWorkstationLayout(${JSON.stringify(path)}, ${JSON.stringify(value)}) : null`
      );
      return result;
    } catch (error) {
      console.error('[WorkstationService] Error setting layout:', error);
      return null;
    }
  }

  /**
   * Get the current selection.
   * Executes JavaScript in renderer to read from LayoutContext.
   */
  async getSelection(): Promise<WorkstationSelection | null> {
    const targetWindow = this.resolveTargetWindow();
    if (!targetWindow) {
      console.warn('[WorkstationService] getSelection called but window not available');
      return null;
    }

    try {
      const result = await targetWindow.webContents.executeJavaScript(
        'window.__getCurrentSelection ? window.__getCurrentSelection() : null'
      );
      return result;
    } catch (error) {
      console.error('[WorkstationService] Error getting selection:', error);
      return null;
    }
  }

  // ============================================================================
  // Control Tools (use IPC fire-and-forget for one-way commands)
  // ============================================================================

  /**
   * Open a file in the workstation.
   * Sends IPC message to renderer, which handles the tab creation.
   */
  openFile(path: string, page?: number, options?: { origin?: 'external-file-open' }): void {
    console.log(`[WorkstationService] Opening file: ${path}${page ? ` page ${page}` : ''}`);
    const targetWindow = this.resolveTargetWindow();
    if (!targetWindow) {
      return;
    }
    this.sendWhenReadyToWindow(targetWindow.id, IPC_CHANNELS.WORKSTATION_OPEN_FILE, { path, page, origin: options?.origin });
  }

  /**
   * Create a new agent tab.
   * Reuses the same renderer event path as the existing Cmd/Ctrl+T shortcut.
   */
  openNewTab(options?: { windowId?: number | null; sessionKey?: string | null }): void {
    console.log('[WorkstationService] Creating new tab');
    const targetWindow = this.resolveTargetWindow(options);
    if (!targetWindow) {
      return;
    }
    this.sendWhenReadyToWindow(targetWindow.id, IPC_CHANNELS.TAB_NEW);
  }

  /**
   * Open a URL in a browser tab.
   * Sends IPC message to renderer, which handles the tab creation.
   * @returns The browserId that can be used to reference this tab
   */
  openUrl(url: string, browserId?: string): string {
    const actualBrowserId = browserId || `browser-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    console.log(`[WorkstationService] Opening URL: ${url} with browserId: ${actualBrowserId}`);
    const targetWindow = this.resolveTargetWindow();
    if (!targetWindow) {
      return actualBrowserId;
    }
    this.sendWhenReadyToWindow(targetWindow.id, IPC_CHANNELS.WORKSTATION_OPEN_URL, { url, browserId: actualBrowserId });
    return actualBrowserId;
  }

  /**
   * Close a tab by ID.
   * Sends IPC message to renderer, which handles the tab removal.
   */
  closeTab(id: string): void {
    console.log(`[WorkstationService] Closing tab: ${id}`);
    const targetWindow = this.resolveTargetWindow();
    if (!targetWindow) {
      return;
    }
    this.sendWhenReadyToWindow(targetWindow.id, IPC_CHANNELS.WORKSTATION_CLOSE_TAB, { id });
  }

  /**
   * Focus a tab by ID.
   * Sends IPC message to renderer, which handles the tab activation.
   */
  focusTab(id: string): void {
    console.log(`[WorkstationService] Focusing tab: ${id}`);
    const targetWindow = this.resolveTargetWindow();
    if (!targetWindow) {
      return;
    }
    this.sendWhenReadyToWindow(targetWindow.id, IPC_CHANNELS.WORKSTATION_FOCUS_TAB, { id });
  }

  /**
   * Toggle a sidebar's visibility.
   * Sends IPC message to renderer, which handles the sidebar toggle.
   * @param side - Which sidebar to toggle ('left' or 'right')
   * @param open - Optional explicit state (true = open, false = close, undefined = toggle)
   */
  toggleSidebar(side: 'left' | 'right', open?: boolean): void {
    console.log(`[WorkstationService] ${open === undefined ? 'Toggling' : (open ? 'Opening' : 'Closing')} ${side} sidebar`);
    const targetWindow = this.resolveTargetWindow();
    if (!targetWindow) {
      return;
    }
    this.sendWhenReadyToWindow(targetWindow.id, IPC_CHANNELS.WORKSTATION_TOGGLE_SIDEBAR, { side, open });
  }
}

export const workstationService = new WorkstationService();
