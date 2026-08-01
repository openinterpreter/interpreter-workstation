/**
 * Browser Service
 *
 * Manages WebContentsView instances for browser tabs.
 * Adapted from old_workstation PersistentWebView implementation.
 */

import type { WebContentsView as WebContentsViewT, BrowserWindow as BrowserWindowT } from 'electron';

const { WebContentsView, BrowserWindow, app } = require('electron') as typeof import('electron');
import * as fs from 'fs/promises';
import * as path from 'path';

interface BrowserViewData {
  id: string;
  view: WebContentsViewT;
  url: string;
  title: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  currentWindowId?: number;
  isAttached: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
  browserId?: string;
  faviconUrl?: string;
  debuggerAttached?: boolean;
}

export interface AXNode {
  nodeId: string;
  role?: { value: string };
  name?: { value: string };
  description?: { value: string };
  value?: { value: string };
  properties?: Array<{ name: string; value: { value: any } }>;
  childIds?: string[];
  backendDOMNodeId?: number;
  ref?: string;
}

export interface AccessibilityTree {
  nodes: AXNode[];
}

export interface PersistedBrowserTab {
  browserId: string;
  url: string;
  title: string;
  faviconUrl?: string;
}

type BrowserEventCallback = (event: {
  id: string;
  type: 'url-changed' | 'title-changed' | 'loading-changed' | 'navigation-state-changed';
  data: any;
}) => void;

class BrowserService {
  private views = new Map<string, BrowserViewData>();
  private hiddenWindow: BrowserWindowT | null = null;
  private eventCallbacks: BrowserEventCallback[] = [];
  private persistencePath: string | null = null;
  private browserIdToViewId = new Map<string, string>();
  private refMappings = new Map<string, Map<string, number>>();

  constructor() {
    this.createHiddenWindow();
    this.initPersistence();
  }

  /**
   * Resolve a tab ID to the internal view ID.
   * Handles:
   * 1. browser:// prefix stripping
   * 2. browserId -> viewId mapping (mentions use browserId, views map uses viewId)
   * 3. Direct viewId lookup as fallback
   */
  private resolveTabId(tabId: string): string {
    // Strip browser:// prefix if present
    let id = tabId.startsWith('browser://') ? tabId.slice('browser://'.length) : tabId;

    // Check if this is a browserId that needs to be mapped to viewId
    const viewId = this.browserIdToViewId.get(id);
    if (viewId) {
      return viewId;
    }

    // Already a viewId or unknown
    return id;
  }

  /**
   * Get view data by ID, handling browser:// prefix and browserId mapping automatically.
   */
  private getViewData(id: string): BrowserViewData | undefined {
    return this.views.get(this.resolveTabId(id));
  }

  private initPersistence(): void {
    if (!app.isReady()) {
      app.once('ready', () => this.initPersistence());
      return;
    }

    const userDataPath = app.getPath('userData');
    this.persistencePath = path.join(userDataPath, 'browser-tabs.json');
    console.log('[BrowserService] Persistence path:', this.persistencePath);
  }

  private async loadPersistedTabs(): Promise<PersistedBrowserTab[]> {
    if (!this.persistencePath) return [];

    try {
      await fs.access(this.persistencePath);
      const data = await fs.readFile(this.persistencePath, 'utf-8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[BrowserService] Failed to load persisted tabs:', err);
      }
    }
    return [];
  }

  private async savePersistedTabs(): Promise<void> {
    if (!this.persistencePath) return;

    const tabs: PersistedBrowserTab[] = [];
    for (const [, viewData] of this.views.entries()) {
      if (viewData.browserId) {
        tabs.push({
          browserId: viewData.browserId,
          url: viewData.url,
          title: viewData.title,
          faviconUrl: viewData.faviconUrl,
        });
      }
    }

    try {
      await fs.writeFile(this.persistencePath, JSON.stringify(tabs, null, 2), 'utf-8');
    } catch (err) {
      console.error('[BrowserService] Failed to save persisted tabs:', err);
    }
  }

  private async removeFromPersistence(browserId: string): Promise<void> {
    if (!this.persistencePath) return;

    try {
      const tabs = await this.loadPersistedTabs();
      const filtered = tabs.filter(t => t.browserId !== browserId);
      await fs.writeFile(this.persistencePath, JSON.stringify(filtered, null, 2), 'utf-8');
    } catch (err) {
      console.error('[BrowserService] Failed to remove from persistence:', err);
    }
  }

  async getPersistedTabs(): Promise<PersistedBrowserTab[]> {
    return this.loadPersistedTabs();
  }

  private createHiddenWindow(): void {
    if (!app.isReady()) {
      app.once('ready', () => this.createHiddenWindow());
      return;
    }

    this.hiddenWindow = new BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    console.log('[BrowserService] Hidden window created');
  }

  private emitEvent(event: Parameters<BrowserEventCallback>[0]): void {
    this.eventCallbacks.forEach((cb) => {
      try {
        cb(event);
      } catch (err) {
        console.error('[BrowserService] Error in event callback:', err);
      }
    });
  }

  onEvent(callback: BrowserEventCallback): () => void {
    this.eventCallbacks.push(callback);
    return () => {
      const index = this.eventCallbacks.indexOf(callback);
      if (index !== -1) {
        this.eventCallbacks.splice(index, 1);
      }
    };
  }

  create(id: string, url: string, browserId?: string, faviconUrl?: string): void {
    if (this.views.has(id)) {
      console.log(`[BrowserService] View ${id} already exists, navigating to ${url}`);
      this.navigate(id, url);
      return;
    }

    console.log(`[BrowserService] Creating view ${id} with URL: ${url}, browserId: ${browserId}`);

    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
      },
    });

    view.setBackgroundColor('#ffffff');

    const viewData: BrowserViewData = {
      id,
      view,
      url,
      title: 'Loading...',
      isLoading: true,
      canGoBack: false,
      canGoForward: false,
      isAttached: false,
      browserId,
      faviconUrl,
    };

    if (browserId) {
      this.browserIdToViewId.set(browserId, id);
    }

    view.webContents.on('did-start-loading', () => {
      viewData.isLoading = true;
      this.emitEvent({
        id,
        type: 'loading-changed',
        data: { isLoading: true },
      });
    });

    view.webContents.on('did-stop-loading', () => {
      viewData.isLoading = false;
      viewData.canGoBack = view.webContents.canGoBack();
      viewData.canGoForward = view.webContents.canGoForward();
      this.emitEvent({
        id,
        type: 'loading-changed',
        data: { isLoading: false },
      });
      this.emitEvent({
        id,
        type: 'navigation-state-changed',
        data: {
          canGoBack: viewData.canGoBack,
          canGoForward: viewData.canGoForward,
        },
      });
    });

    view.webContents.on('did-navigate', (_event, newUrl) => {
      viewData.url = newUrl;
      viewData.canGoBack = view.webContents.canGoBack();
      viewData.canGoForward = view.webContents.canGoForward();
      this.emitEvent({
        id,
        type: 'url-changed',
        data: { url: newUrl },
      });
      this.emitEvent({
        id,
        type: 'navigation-state-changed',
        data: {
          canGoBack: viewData.canGoBack,
          canGoForward: viewData.canGoForward,
        },
      });
      if (viewData.browserId) {
        void this.savePersistedTabs();
      }
    });

    view.webContents.on('did-navigate-in-page', (_event, newUrl) => {
      viewData.url = newUrl;
      viewData.canGoBack = view.webContents.canGoBack();
      viewData.canGoForward = view.webContents.canGoForward();
      this.emitEvent({
        id,
        type: 'url-changed',
        data: { url: newUrl },
      });
    });

    view.webContents.on('page-title-updated', (_event, title) => {
      viewData.title = title;
      this.emitEvent({
        id,
        type: 'title-changed',
        data: { title },
      });
      if (viewData.browserId) {
        void this.savePersistedTabs();
      }
    });

    view.webContents.setWindowOpenHandler((details) => {
      console.log(`[BrowserService] New window requested: ${details.url}`);
      if (details.url.includes('accounts.google.com') ||
          details.url.includes('login.microsoftonline.com') ||
          details.url.includes('github.com/login') ||
          details.url.includes('oauth')) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 600,
            height: 800,
            webPreferences: {
              nodeIntegration: false,
              contextIsolation: true,
            },
          },
        };
      }
      return { action: 'deny' };
    });

    this.views.set(id, viewData);

    if (this.hiddenWindow && !this.hiddenWindow.isDestroyed()) {
      this.hiddenWindow.contentView.addChildView(view);
      view.setBounds({ x: 0, y: 0, width: 1, height: 1 });
    }

    view.webContents.loadURL(url).catch((err) => {
      console.error(`[BrowserService] Failed to load URL ${url}:`, err);
    });

    if (browserId) {
      void this.savePersistedTabs();
    }
  }

  async navigate(id: string, url: string): Promise<void> {
    const viewData = this.getViewData(id);
    if (!viewData) {
      console.warn(`[BrowserService] View ${id} not found`);
      return;
    }

    console.log(`[BrowserService] Navigating ${id} to: ${url}`);
    viewData.url = url;

    try {
      await viewData.view.webContents.loadURL(url);
    } catch (err) {
      console.error(`[BrowserService] Navigation failed:`, err);
    }
  }

  goBack(id: string): void {
    const viewData = this.getViewData(id);
    if (!viewData) return;

    if (viewData.view.webContents.canGoBack()) {
      viewData.view.webContents.goBack();
    }
  }

  goForward(id: string): void {
    const viewData = this.getViewData(id);
    if (!viewData) return;

    if (viewData.view.webContents.canGoForward()) {
      viewData.view.webContents.goForward();
    }
  }

  reload(id: string): void {
    const viewData = this.getViewData(id);
    if (!viewData) return;

    viewData.view.webContents.reload();
  }

  stop(id: string): void {
    const viewData = this.getViewData(id);
    if (!viewData) return;

    viewData.view.webContents.stop();
  }

  getUrl(id: string): string | undefined {
    const viewData = this.getViewData(id);
    return viewData?.url;
  }

  getTitle(id: string): string | undefined {
    const viewData = this.getViewData(id);
    return viewData?.title;
  }

  getState(id: string): {
    url: string;
    title: string;
    isLoading: boolean;
    canGoBack: boolean;
    canGoForward: boolean;
  } | undefined {
    const viewData = this.getViewData(id);
    if (!viewData) return undefined;

    return {
      url: viewData.url,
      title: viewData.title,
      isLoading: viewData.isLoading,
      canGoBack: viewData.canGoBack,
      canGoForward: viewData.canGoForward,
    };
  }

  listTabs(): Array<{
    id: string;
    url: string;
    title: string;
    isLoading: boolean;
  }> {
    const tabs: Array<{
      id: string;
      url: string;
      title: string;
      isLoading: boolean;
    }> = [];

    for (const [id, viewData] of this.views.entries()) {
      tabs.push({
        // Use browserId as the canonical ID (what mentions use), fall back to internal id
        id: viewData.browserId || id,
        url: viewData.url,
        title: viewData.title,
        isLoading: viewData.isLoading,
      });
    }

    return tabs;
  }

  async takeScreenshot(id: string): Promise<Buffer | null> {
    const viewData = this.getViewData(id);
    if (!viewData) return null;

    try {
      const image = await viewData.view.webContents.capturePage();
      return image.toPNG();
    } catch (err) {
      console.error('[BrowserService] Screenshot failed:', err);
      return null;
    }
  }

  attach(id: string, windowId: number): void {
    const viewData = this.getViewData(id);
    if (!viewData) {
      console.warn(`[BrowserService] Cannot attach - view ${id} not found`);
      return;
    }

    const targetWindow = BrowserWindow.fromId(windowId);
    if (!targetWindow || targetWindow.isDestroyed()) {
      console.warn(`[BrowserService] Cannot attach - window ${windowId} not found`);
      return;
    }

    if (viewData.isAttached && viewData.currentWindowId === windowId) {
      return;
    }

    console.log(`[BrowserService] Attaching view ${id} to window ${windowId}`);

    if (viewData.currentWindowId && viewData.currentWindowId !== windowId) {
      const oldWindow = BrowserWindow.fromId(viewData.currentWindowId);
      if (oldWindow && !oldWindow.isDestroyed()) {
        try {
          oldWindow.contentView.removeChildView(viewData.view);
        } catch (err) {
          console.warn('[BrowserService] Error removing from old window:', err);
        }
      }
    } else if (this.hiddenWindow && !this.hiddenWindow.isDestroyed()) {
      try {
        this.hiddenWindow.contentView.removeChildView(viewData.view);
      } catch (err) {
        // Ignore - may not be attached
      }
    }

    targetWindow.contentView.addChildView(viewData.view);
    viewData.currentWindowId = windowId;
    viewData.isAttached = true;

    if (viewData.bounds) {
      viewData.view.setBounds(viewData.bounds);
    }

    viewData.view.setVisible(true);
  }

  detach(id: string, windowId?: number): void {
    const viewData = this.getViewData(id);
    if (!viewData || !viewData.isAttached) return;

    if (windowId && viewData.currentWindowId && viewData.currentWindowId !== windowId) {
      return;
    }

    console.log(`[BrowserService] Detaching view ${id}`);

    // NOTE(victor): setVisible(false) is required before removeChildView.
    // View.visible controls drawing independently of the view hierarchy
    // ("Whether the view should be drawn. Note that this is different from
    // whether the view is visible on screen"). removeChildView does not reset
    // this flag. On Linux (X11 + Wayland) the compositor keeps rendering the
    // view at its last bounds if visible remains true.
    // Ref: node_modules/electron/electron.d.ts View class --
    //   setVisible (l15219), getVisible (l15176), removeChildView (l15184).
    // Filed as #1060.
    viewData.view.setVisible(false);

    if (viewData.currentWindowId) {
      const window = BrowserWindow.fromId(viewData.currentWindowId);
      if (window && !window.isDestroyed()) {
        try {
          window.contentView.removeChildView(viewData.view);
        } catch (err) {
          console.warn('[BrowserService] Error detaching:', err);
        }
      }
    }

    if (this.hiddenWindow && !this.hiddenWindow.isDestroyed()) {
      this.hiddenWindow.contentView.addChildView(viewData.view);
      viewData.view.setBounds({ x: 0, y: 0, width: 1, height: 1 });
    }

    viewData.currentWindowId = undefined;
    viewData.isAttached = false;
  }

  setBounds(id: string, bounds: { x: number; y: number; width: number; height: number }): void {
    const viewData = this.getViewData(id);
    if (!viewData) return;

    const validBounds = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(1, Math.round(bounds.width)),
      height: Math.max(1, Math.round(bounds.height)),
    };

    viewData.bounds = validBounds;

    if (viewData.isAttached) {
      viewData.view.setBounds(validBounds);
    }
  }

  focus(id: string): void {
    const viewData = this.getViewData(id);
    if (!viewData) return;

    try {
      viewData.view.webContents.focus();
    } catch (err) {
      console.warn('[BrowserService] Error focusing:', err);
    }
  }

  close(id: string): void {
    const viewData = this.getViewData(id);
    if (!viewData) return;

    console.log(`[BrowserService] Closing view ${id}`);

    const browserId = viewData.browserId;

    this.detach(id);

    try {
      if (!viewData.view.webContents.isDestroyed()) {
        viewData.view.webContents.close();
      }
    } catch (err) {
      console.warn('[BrowserService] Error closing view:', err);
    }

    this.views.delete(id);

    if (browserId) {
      this.browserIdToViewId.delete(browserId);
      void this.removeFromPersistence(browserId);
    }
  }

  closeAll(): void {
    const ids = Array.from(this.views.keys());
    for (const id of ids) {
      this.close(id);
    }
  }

  shutdown(): void {
    console.log('[BrowserService] Shutting down...');
    this.closeAll();

    if (this.hiddenWindow && !this.hiddenWindow.isDestroyed()) {
      this.hiddenWindow.destroy();
      this.hiddenWindow = null;
    }

    this.eventCallbacks = [];
  }

  async attachDebugger(id: string): Promise<void> {
    const viewData = this.getViewData(id);
    if (!viewData) {
      throw new Error(`View ${id} not found`);
    }

    if (viewData.debuggerAttached) {
      return;
    }

    const dbg = viewData.view.webContents.debugger;
    try {
      dbg.attach('1.3');
      viewData.debuggerAttached = true;
      console.log(`[BrowserService] Debugger attached to view ${id}`);
    } catch (err) {
      console.error(`[BrowserService] Failed to attach debugger to ${id}:`, err);
      throw err;
    }
  }

  async sendCDPCommand(id: string, method: string, params?: object): Promise<any> {
    const viewData = this.getViewData(id);
    if (!viewData) {
      throw new Error(`View ${id} not found`);
    }

    const dbg = viewData.view.webContents.debugger;

    if (!dbg.isAttached()) {
      await this.attachDebugger(id);
    }

    try {
      const result = await dbg.sendCommand(method, params);
      return result;
    } catch (err) {
      console.error(`[BrowserService] CDP command ${method} failed:`, err);
      throw err;
    }
  }

  async getAccessibilityTree(id: string, options?: { filter?: 'interactive' }): Promise<AccessibilityTree> {
    const tree = await this.sendCDPCommand(id, 'Accessibility.getFullAXTree') as AccessibilityTree;

    if (options?.filter === 'interactive') {
      const interactiveRoles = new Set([
        'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
        'listbox', 'menu', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
        'option', 'searchbox', 'slider', 'spinbutton', 'switch', 'tab',
        'treeitem', 'textField', 'TextField'
      ]);

      tree.nodes = tree.nodes.filter(node => {
        const role = node.role?.value?.toLowerCase();
        return role && interactiveRoles.has(role);
      });
    }

    return tree;
  }

  setRefMapping(id: string, mapping: Map<string, number>): void {
    this.refMappings.set(this.resolveTabId(id), mapping);
  }

  getRefMapping(id: string): Map<string, number> | undefined {
    return this.refMappings.get(this.resolveTabId(id));
  }

  clearRefMapping(id: string): void {
    this.refMappings.delete(this.resolveTabId(id));
  }

  async clickElement(tabId: string, refId: string): Promise<{ x: number; y: number; element: string; scrolled: boolean }> {
    const resolvedTabId = this.resolveTabId(tabId);
    const refMapping = this.refMappings.get(resolvedTabId);
    if (!refMapping) {
      throw new Error(`No page structure found for tab ${tabId}. Call browser_read_page first.`);
    }

    const backendDOMNodeId = refMapping.get(refId);
    if (!backendDOMNodeId) {
      throw new Error(`Reference ID "${refId}" not found. Call browser_read_page to get valid references.`);
    }

    const resolveResult = await this.sendCDPCommand(resolvedTabId, 'DOM.resolveNode', {
      backendNodeId: backendDOMNodeId
    });

    if (!resolveResult?.object?.objectId) {
      throw new Error(`Failed to resolve DOM node for ${refId}`);
    }

    const objectId = resolveResult.object.objectId;

    // NOTE(victor): Always scroll into view FIRST, then get bounding rect.
    // If we get the rect before scrolling, elements that aren't laid out yet
    // return (0,0,0,0) which passes the "in viewport" check and never scrolls.
    const positionFn = `
    function() {
      const element = this;
      if (element.disabled) {
        throw new Error('Element is disabled and cannot be clicked');
      }

      element.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });

      const rect = element.getBoundingClientRect();

      if (rect.width === 0 && rect.height === 0) {
        throw new Error('Element has zero dimensions - may be hidden or not rendered. Tag: ' + element.tagName);
      }

      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;

      return {
        x: x,
        y: y,
        element: element.tagName.toLowerCase(),
        scrolled: true
      };
    }
    `;

    const callResult = await this.sendCDPCommand(resolvedTabId, 'Runtime.callFunctionOn', {
      objectId: objectId,
      functionDeclaration: positionFn,
      arguments: [],
      returnByValue: true
    });

    if (callResult?.exceptionDetails) {
      const errorMessage = callResult.exceptionDetails.exception?.description || 'Unknown error';
      throw new Error(`Failed to get element position: ${errorMessage}`);
    }

    const { x, y, element, scrolled } = callResult?.result?.value || {};

    if (typeof x !== 'number' || typeof y !== 'number' || x === 0 && y === 0) {
      throw new Error(`Invalid coordinates returned: (${x}, ${y}). Element may not be visible.`);
    }

    await this.sendCDPCommand(resolvedTabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: x,
      y: y,
      button: 'left',
      clickCount: 1
    });

    await this.sendCDPCommand(resolvedTabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: x,
      y: y,
      button: 'left',
      clickCount: 1
    });

    return { x, y, element, scrolled };
  }

  async fillElement(tabId: string, refId: string, value: string | boolean | number): Promise<{ element: string; type: string; value: any }> {
    const resolvedTabId = this.resolveTabId(tabId);
    const refMapping = this.refMappings.get(resolvedTabId);
    if (!refMapping) {
      throw new Error(`No page structure found for tab ${tabId}. Call browser_read_page first.`);
    }

    const backendDOMNodeId = refMapping.get(refId);
    if (!backendDOMNodeId) {
      throw new Error(`Reference ID "${refId}" not found. Call browser_read_page to get valid references.`);
    }

    const resolveResult = await this.sendCDPCommand(resolvedTabId, 'DOM.resolveNode', {
      backendNodeId: backendDOMNodeId
    });

    if (!resolveResult?.object?.objectId) {
      throw new Error(`Failed to resolve DOM node for ${refId}`);
    }

    const objectId = resolveResult.object.objectId;

    const fillFn = `
    function(value) {
      const element = this;
      const tagName = element.tagName.toLowerCase();
      const inputType = element.type ? element.type.toLowerCase() : '';

      if (tagName === 'input' && inputType === 'checkbox') {
        const boolValue = typeof value === 'boolean' ? value : true;
        element.checked = boolValue;
        element.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (tagName === 'input' && inputType === 'radio') {
        element.checked = true;
        element.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (tagName === 'select') {
        const stringValue = String(value);
        element.value = stringValue;
        if (element.value !== stringValue) {
          const options = Array.from(element.options);
          const matchingOption = options.find(opt =>
            opt.text.trim() === stringValue || opt.value === stringValue
          );
          if (matchingOption) {
            element.value = matchingOption.value;
          }
        }
        element.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (tagName === 'textarea' || (tagName === 'input' && ['text', 'email', 'password', 'search', 'tel', 'url', 'number'].includes(inputType))) {
        const stringValue = String(value);
        element.value = stringValue;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (element.isContentEditable) {
        element.textContent = String(value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        throw new Error('Element is not a form input: ' + tagName + ' type=' + inputType);
      }

      return {
        element: tagName,
        type: inputType || 'none',
        value: element.value !== undefined ? element.value : element.checked
      };
    }
    `;

    const callResult = await this.sendCDPCommand(resolvedTabId, 'Runtime.callFunctionOn', {
      objectId: objectId,
      functionDeclaration: fillFn,
      arguments: [{ value: value }],
      returnByValue: true
    });

    if (callResult?.exceptionDetails) {
      const errorMessage = callResult.exceptionDetails.exception?.description || 'Unknown error';
      throw new Error(`Failed to fill element: ${errorMessage}`);
    }

    return callResult?.result?.value || {};
  }

  /**
   * Get the current text selection from a browser tab.
   * Used for polling selection when a browser tab has focus.
   *
   * @param id - The tab ID (browserId or viewId)
   * @returns The selected text, or null if no selection or tab not found
   */
  async getSelection(id: string): Promise<string | null> {
    const viewData = this.getViewData(id);
    if (!viewData) {
      return null;
    }

    try {
      const result = await viewData.view.webContents.executeJavaScript(
        'window.getSelection().toString()'
      );
      return typeof result === 'string' && result.length > 0 ? result : null;
    } catch (err) {
      console.warn(`[BrowserService] Failed to get selection from ${id}:`, err);
      return null;
    }
  }

  /**
   * Get the URL of the current selection's source (the page URL).
   * Returns both selection text and source URL for context tracking.
   *
   * @param id - The tab ID (browserId or viewId)
   * @returns Object with selection text and source URL, or null if no selection
   */
  async getSelectionWithSource(id: string): Promise<{ text: string; sourceUrl: string; sourceTitle: string } | null> {
    const viewData = this.getViewData(id);
    if (!viewData) {
      return null;
    }

    try {
      const text = await viewData.view.webContents.executeJavaScript(
        'window.getSelection().toString()'
      );

      if (typeof text !== 'string' || text.length === 0) {
        return null;
      }

      return {
        text,
        sourceUrl: viewData.url,
        sourceTitle: viewData.title
      };
    } catch (err) {
      console.warn(`[BrowserService] Failed to get selection with source from ${id}:`, err);
      return null;
    }
  }
}

export const browserService = new BrowserService();
