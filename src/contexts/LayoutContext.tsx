/**
 * Layout Context
 *
 * Manages the global layout state for the unified pane/tab system.
 * Tree-based split pane architecture. All tabs live in a flat registry.
 * Panes reference tabs by ID. Moving a tab = splice between tabIds arrays.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState, useRef } from 'react';
import type { ActiveTabRegion, LayoutState, Tab, TreeNode, Pane, SplitNode } from '../../shared/types/layout';
import { isAgentTab, isPane, SIDEBAR_TAB_TYPES } from '../../shared/types/layout';
import type { Profile } from '../../shared/types/profile';
import {
  createDefaultLayoutState,
  findTabByPath,
  findFolderTabByPath,
  createAgentTab,
  createFileTab,
  createFolderTab,
  createBrowserTab,
  createEmailTab,
  createEmptyAgentTab,
  createSettingsTab,
  createTerminalEditorTab,
} from '../utils/layoutHelpers';
import {
  addTabToPane,
  createPane,
  createSplitNode,
  findPaneByTabId,
  findPaneById,
  getAllPanes,
  getFirstPane,
  removeTabFromPane,
  setActiveTabInPane,
  splitPane,
  moveTabToPane,
  updateSplitRatio,
  collapseSplit,
  updatePane,
} from '../utils/treeOperations';
import { appendSidebarPaneTab, insertSidebarPaneTab, removeSidebarPaneTab } from '../utils/sidebarPane';
import type { AgentModelConfig } from '../../shared/types/model';
import { saveLayoutState, loadLayoutState, clearLayoutState, flushLayoutState } from '../utils/layoutPersistence';
import { getWorkspace, getProfiles } from '../api';
import type { WorkstationContext, Selection } from '../../shared/types/workstation';
import {
  browserControl,
  profiles as profilesIpc,
  workspace as workspaceIpc,
  agentTabs as agentTabsIpc,
  pathBasename,
  windowIpc,
  getWindowBootstrapLayout,
  getWindowSessionKey,
} from '@/ipc';
import type { BrowserControlStatus } from '../../shared/types/browserControl';
import { useSelectionTracking } from '../hooks/useSelectionTracking';
import { useWikilinkResolver } from '../hooks/useWikilinkResolver';
import { useTabOpeners } from '../hooks/useTabOpeners';
import { useLayoutIpcListeners } from '../hooks/useLayoutIpcListeners';
import { getAgentActivity, subscribeAgentActivity } from '../stores/agentActivityStore';
import { setActiveFilePathSnapshot } from '../stores/activeFileStore';
import { setWorkspacePathSnapshot } from '../stores/workspaceStore';
import { clearAgentPendingInputs } from '../stores/agentPendingInputStore';
import { syncIdleAgentTabsToWindowWorkspace } from '../utils/agentWorkspaceSync';
import {
  trackAgentReset,
  trackAgentPinned,
  trackAgentUnpinned,
  trackSplitViewObserved,
  trackSidebarTabChanged,
  trackSidebarVisibilityChanged,
  trackScreenViewed,
} from '../utils/telemetry';
import { setCurrentScreen } from '../utils/telemetryContext';
import { summarizeSplitViewTelemetry } from '../utils/layoutTelemetry';
import { syncAgentProfileTabs } from '../utils/syncAgentProfileTabs';
import { getDefaultModelConfig, profileToModelConfig } from '../../shared/types/profile';
import { getStoredDefaultReasoningEffort } from '../utils/reasoningPreference';
import type { PaneTabDragData } from '../utils/paneTabDrag';
import lodashGet from 'lodash/get';
import lodashSet from 'lodash/set';
import cloneDeep from 'lodash/cloneDeep';

// ============================================================================
// Context Interface
// ============================================================================

export interface LayoutActions {
  toggleLeftSidebar(): void;
  toggleRightSidebar(): void;
  setLeftSidebarOpen(isOpen: boolean): void;
  setRightSidebarOpen(isOpen: boolean): void;
  setLeftSidebarTab(tab: 'explorer' | 'browser' | 'inbox'): void;
  setLeftSidebarWidth(width: number): void;
  setRightSidebarWidth(width: number): void;
  openFile(path: string, paneId?: string, page?: number): void;
  openFolder(path: string, paneId?: string): string;
  refreshTab(path: string): void;
  closeTab(tabId: string): void;
  setActiveTab(tabId: string): void;
  moveTab(tabId: string, targetPaneId: string, index: number): void;
  updateTabPath(oldPath: string, newPath: string): void;
  updateTabLabel(tabId: string, label: string): void;
  splitPaneAction(paneId: string, direction: 'horizontal' | 'vertical', position: 'before' | 'after', tabId?: string): string | null;
  setActivePaneId(paneId: string): void;
  setActiveTabRegion(region: ActiveTabRegion): void;
  updateSplitRatioAction(splitId: string, ratio: number): void;
  openNewTab(paneId?: string): string;
  openSeededAgentTab(initialMessage: string, options?: { paneId?: string; preferFastProfile?: boolean }): string;
  openBrowser(url: string, paneId?: string, browserId?: string): void;
  updateBrowserTabLabel(tabId: string, label: string): void;
  openEmail(emailId: string, subject: string, paneId?: string): void;
  openChat(threadId: string, channel: import('../../shared/types/messaging').MessagingChannel, label: string, paneId?: string): void;
  openSettings(paneId?: string, section?: string): void;
  toggleSettings(paneId?: string): void;
  openAgentTab(agentTabId: string, label: string, extra?: { terminalAgent?: string; modelConfig?: AgentModelConfig; cwd?: string; workspacePath?: string }, paneId?: string): void;
  morphNewTabToAgent(oldTabId: string, initialMessage: string, modelConfig: AgentModelConfig): void;
  registerSidebarTab(tab: Tab): void;
  unregisterSidebarTab(tabId: string): void;
  setSidebarActiveTab(tabId: string | null): void;
  updateSidebarTabLabel(tabId: string, label: string): void;
  updateTabModelConfig(tabId: string, modelConfig: AgentModelConfig): void;
  updateTab(tabId: string, fieldsOrUpdater: Partial<Tab> | ((tab: Tab) => Tab)): void;
  detachTabToNewWindow(tabId: string): Promise<boolean>;
  moveTabToSidebar(tabId: string, options?: { fallbackPaneId?: string; fallbackIndex?: number; index?: number }): void;
  moveSidebarTab(tabId: string, index: number): void;
  unpinSidebarTab(tabId: string, paneId?: string): void;
  updatePaneRect(paneId: string, rect: DOMRect | null): void;
  handleTabDrop(tabId: string, sourcePaneId: string | null, targetPaneId: string, zone: 'center' | 'left' | 'right' | 'top' | 'bottom', index?: number, sidebarMeta?: any, dragData?: PaneTabDragData | null): void;
  getState(): LayoutState;
  resetAgentTab(tabId: string, options?: { autoStartVoiceMode?: boolean; initialMessage?: string }): string | null;
  resetToDefaults(): void;
  setLayoutState(state: LayoutState): void;
}

interface PaneRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface LayoutContextValue extends LayoutActions {
  state: LayoutState;
  paneRects: Record<string, PaneRect>;
  currentSelection: Selection | null;
  setSelection(selection: Selection | null): void;
  clearSelection(): void;
  getWorkstationContext(): WorkstationContext;
  pendingPrompt: string | null;
  pendingAutoSend: boolean;
  setComposerPrompt(prompt: string | null, options?: { autoSend?: boolean }): void;
}

export const LayoutContext = createContext<LayoutContextValue | null>(null);

/**
 * Separate context for action functions only — these have stable references
 * (useCallback) and rarely change. Components that only need to call actions
 * (openFile, closeTab, etc.) can subscribe to this context and avoid
 * re-rendering when layout state changes (e.g. tab switches).
 */
export const LayoutActionsContext = createContext<LayoutActions | null>(null);

function sanitizeActiveTabRegion(
  currentRegion: ActiveTabRegion,
  sidebarPane: Pane | null,
  rightSidebarIsOpen: boolean,
): ActiveTabRegion {
  if (currentRegion === 'sidebar' && rightSidebarIsOpen && (sidebarPane?.tabIds.length ?? 0) > 0) {
    return 'sidebar';
  }

  return 'main';
}

function getActiveFilePathFromState(state: LayoutState): string | null {
  const pane = findPaneById(state.tree, state.activePaneId || '');
  if (!pane?.activeTabId) return null;
  const tab = state.tabs[pane.activeTabId];
  return tab?.type === 'file' ? tab.path || null : null;
}

// ============================================================================
// Provider
// ============================================================================

export function LayoutProvider({ children }: { children: React.ReactNode }) {
  "use no memo";

  const windowSessionKeyRef = useRef(getWindowSessionKey() ?? 'window-browser');
  const windowBootstrapLayoutRef = useRef(getWindowBootstrapLayout());
  const windowSessionKey = windowSessionKeyRef.current;
  const [state, setState] = useState<LayoutState>(() => loadLayoutState(
    windowSessionKey,
    windowBootstrapLayoutRef.current,
  ));
  const [paneRects, setPaneRects] = useState<Record<string, PaneRect>>({});
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const workspacePathRef = useRef<string | null>(null);
  const sawWorkspaceChangeEventRef = useRef(false);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [pendingAutoSend, setPendingAutoSend] = useState(false);
  const isInitialMount = useRef(true);
  const stateRef = useRef(state);
  const browserControlStatusRef = useRef<BrowserControlStatus | null>(null);
  const splitViewTelemetrySignatureRef = useRef<string | null>(null);
  const { currentSelection: textSelection } = useSelectionTracking();
  const [externalSelection, setExternalSelection] = useState<Selection | null>(null);
  const externalSelectionRef = useRef<Selection | null>(null);
  const latestProfilesRef = useRef<Profile[]>([]);
  const latestDefaultProfileIdRef = useRef<string | null>(null);
  const latestFastProfileIdRef = useRef<string | null>(null);
  const pendingProfileRefreshRef = useRef<Set<string>>(new Set());

  // Unified selection: text selection from useSelectionTracking takes precedence,
  // but external sources (explorer file selection) can set via event or setSelection.
  // Any new text selection clears the external selection, and vice versa.
  const currentSelection: Selection | null = textSelection ?? externalSelection;
  const currentSelectionRef = useRef<Selection | null>(currentSelection);
  useEffect(() => { currentSelectionRef.current = currentSelection; }, [currentSelection]);
  useEffect(() => {
    workspacePathRef.current = workspacePath;
    setWorkspacePathSnapshot(workspacePath);
  }, [workspacePath]);
  useEffect(() => {
    setActiveFilePathSnapshot(getActiveFilePathFromState(state));
  }, [state]);
  useWikilinkResolver(workspacePath);

  // When text selection appears, clear any external selection
  useEffect(() => {
    if (textSelection) {
      setExternalSelection(null);
      externalSelectionRef.current = null;
    }
  }, [textSelection]);

  const setSelection = useCallback((selection: Selection | null) => {
    setExternalSelection(selection);
    externalSelectionRef.current = selection;
    // If setting a non-text selection, clear browser text selection so they don't conflict
    if (selection && selection.type !== 'text') {
      window.getSelection()?.removeAllRanges();
    }
  }, []);

  const clearSelection = useCallback(() => {
    setExternalSelection(null);
    externalSelectionRef.current = null;
    // NOTE(victor): only clear browser selection when focus is outside a contenteditable,
    // otherwise removeAllRanges() destroys the Tiptap composer caret/cursor
    if (!document.activeElement?.closest('[contenteditable="true"]')) {
      window.getSelection()?.removeAllRanges();
    }
  }, []);

  // Listen for selection:changed CustomEvent from any source (e.g., Explorer)
  useEffect(() => {
    const handleSelectionChanged = (e: Event) => {
      const detail = (e as CustomEvent).detail as Selection | null;
      setSelection(detail);
    };
    window.addEventListener('selection:changed', handleSelectionChanged);
    return () => window.removeEventListener('selection:changed', handleSelectionChanged);
  }, [setSelection]);

  const updateState = useCallback((updater: (prev: LayoutState) => LayoutState) => {
    const newState = updater(stateRef.current);
    stateRef.current = newState;
    setActiveFilePathSnapshot(getActiveFilePathFromState(newState));
    setState(newState);
  }, []);

  const syncWindowWorkspaceIntoIdleAgentTabs = useCallback((
    nextWorkspacePath: string | null,
    previousWorkspacePath: string | null,
  ) => {
    updateState((prev) => {
      const nextTabs = syncIdleAgentTabsToWindowWorkspace({
        tabs: prev.tabs,
        previousWorkspacePath,
        nextWorkspacePath,
        getMessageCount: (tabId) => getAgentActivity(tabId).messageCount,
      });
      return nextTabs ? { ...prev, tabs: nextTabs } : prev;
    });
  }, [updateState]);

  const syncTabsToProfiles = useCallback((profiles: Profile[]) => {
    latestProfilesRef.current = profiles;

    const result = syncAgentProfileTabs({
      tabs: stateRef.current.tabs,
      profiles,
      defaultProfileId: latestDefaultProfileIdRef.current,
      defaultReasoningEffort: getStoredDefaultReasoningEffort(),
      pendingTabIds: pendingProfileRefreshRef.current,
      isAgentRunning: (tabId) => getAgentActivity(tabId).isRunning,
    });

    pendingProfileRefreshRef.current = result.pendingTabIds;
    if (!result.changed) return;

    updateState((prev) => ({
      ...prev,
      tabs: result.tabs,
    }));
  }, [updateState]);

  const didAgentRuntimeChange = useCallback((
    previous: AgentModelConfig | undefined,
    next: AgentModelConfig,
  ): boolean => {
    if (!previous) return false;

    const previousSignature = JSON.stringify({
      profileId: previous.profileId ?? null,
      provider: previous.provider,
      providerId: previous.providerId ?? null,
      modelId: previous.modelId,
      codexProfileId: previous.codexProfileId ?? null,
      baseURL: previous.baseURL ?? null,
      apiFormat: previous.apiFormat ?? null,
      apiKey: previous.apiKey ?? null,
    });
    const nextSignature = JSON.stringify({
      profileId: next.profileId ?? null,
      provider: next.provider,
      providerId: next.providerId ?? null,
      modelId: next.modelId,
      codexProfileId: next.codexProfileId ?? null,
      baseURL: next.baseURL ?? null,
      apiFormat: next.apiFormat ?? null,
      apiKey: next.apiKey ?? null,
    });

    return previousSignature !== nextSignature;
  }, []);

  const getDefaultAgentModelConfig = useCallback((): AgentModelConfig => {
    const defaultReasoningEffort = getStoredDefaultReasoningEffort();
    const defaultProfileId = latestDefaultProfileIdRef.current;
    if (!defaultProfileId) {
      return getDefaultModelConfig();
    }

    const defaultProfile = latestProfilesRef.current.find((profile) => profile.id === defaultProfileId);
    return defaultProfile
      ? profileToModelConfig(defaultProfile, { reasoningEffort: defaultReasoningEffort })
      : getDefaultModelConfig();
  }, []);

  const getFastAgentModelConfig = useCallback((): AgentModelConfig | null => {
    const defaultReasoningEffort = getStoredDefaultReasoningEffort();
    const fastProfileId = latestFastProfileIdRef.current;
    if (!fastProfileId) {
      return null;
    }

    const fastProfile = latestProfilesRef.current.find((profile) => profile.id === fastProfileId);
    return fastProfile
      ? profileToModelConfig(fastProfile, { reasoningEffort: defaultReasoningEffort })
      : null;
  }, []);

  const getActivePane = useCallback((paneId?: string): string => {
    if (paneId) return paneId;
    const s = stateRef.current;
    return s.activePaneId || getFirstPane(s.tree).id;
  }, []);

  const splitViewTelemetrySnapshot = useMemo(() => summarizeSplitViewTelemetry(state.tree), [state.tree]);

  useEffect(() => {
    if (isInitialMount.current) { isInitialMount.current = false; return; }
    saveLayoutState(windowSessionKey, state);
  }, [state, windowSessionKey]);

  useEffect(() => {
    if (splitViewTelemetrySignatureRef.current === splitViewTelemetrySnapshot.signature) {
      return;
    }

    const previousSignature = splitViewTelemetrySignatureRef.current;
    splitViewTelemetrySignatureRef.current = splitViewTelemetrySnapshot.signature;

    trackSplitViewObserved({
      source: previousSignature == null ? 'initial' : 'layout_changed',
      hasSplitView: splitViewTelemetrySnapshot.hasSplitView,
      paneCount: splitViewTelemetrySnapshot.paneCount,
      splitCount: splitViewTelemetrySnapshot.splitCount,
      horizontalSplitCount: splitViewTelemetrySnapshot.horizontalSplitCount,
      verticalSplitCount: splitViewTelemetrySnapshot.verticalSplitCount,
      maxSplitDepth: splitViewTelemetrySnapshot.maxSplitDepth,
      rootDirection: splitViewTelemetrySnapshot.rootDirection,
    });
  }, [splitViewTelemetrySnapshot]);

  // Emit screen_viewed whenever the active tab changes. Derives a stable
  // screen name from the active tab's type (+ optional settingsSection) so
  // the event is stable across reloads and comparable across users.
  const activePane = state.activePaneId ? findPaneById(state.tree, state.activePaneId) : null;
  const activeTabId = activePane?.activeTabId ?? null;
  const activeTab = activeTabId ? state.tabs[activeTabId] : null;
  const activeScreenKey = activeTab
    ? activeTab.type === 'settings'
      ? `settings.${(activeTab as { settingsSection?: string }).settingsSection ?? 'root'}`
      : activeTab.type
    : null;
  useEffect(() => {
    if (!activeScreenKey) return;
    const { previousScreen, previousDurationMs } = setCurrentScreen(activeScreenKey);
    if (previousScreen === activeScreenKey) return;
    trackScreenViewed({
      screen: activeScreenKey,
      fromScreen: previousScreen,
      previousDurationMs,
      screenIndex: 0, // populated by telemetryContext; overwritten via enrichment
      tabType: activeTab?.type,
      settingsSection: activeTab && activeTab.type === 'settings'
        ? (activeTab as { settingsSection?: string }).settingsSection
        : undefined,
    });
  }, [activeScreenKey, activeTab]);

  useEffect(() => {
    const flushPersistedLayout = () => {
      flushLayoutState(windowSessionKey, stateRef.current);
    };

    window.addEventListener('beforeunload', flushPersistedLayout);
    window.addEventListener('pagehide', flushPersistedLayout);

    return () => {
      window.removeEventListener('beforeunload', flushPersistedLayout);
      window.removeEventListener('pagehide', flushPersistedLayout);
    };
  }, [windowSessionKey]);

  useEffect(() => {
    const unsubscribe = workspaceIpc.onChanged(async (event: { workspacePath: string | null }) => {
      sawWorkspaceChangeEventRef.current = true;
      const previousWorkspacePath = workspacePathRef.current;
      // Make the new default visible to tab creation immediately. The IPC
      // response can resolve before React commits the corresponding state.
      workspacePathRef.current = event.workspacePath;
      syncWindowWorkspaceIntoIdleAgentTabs(event.workspacePath, previousWorkspacePath);
      setWorkspacePath(event.workspacePath);
    });
    return unsubscribe;
  }, [syncWindowWorkspaceIntoIdleAgentTabs]);

  useEffect(() => {
    let cancelled = false;

    getWorkspace().then(({ workspace }) => {
      if (cancelled || sawWorkspaceChangeEventRef.current) {
        return;
      }

      const previousWorkspacePath = workspacePathRef.current;
      workspacePathRef.current = workspace;
      syncWindowWorkspaceIntoIdleAgentTabs(workspace, previousWorkspacePath);
      setWorkspacePath(workspace);
    })
      .catch(err => console.error('[LayoutContext] Failed to get workspace:', err));

    return () => {
      cancelled = true;
    };
  }, [syncWindowWorkspaceIntoIdleAgentTabs]);

  useEffect(() => {
    getProfiles().then(({ profiles, defaultProfileId, fastProfileId }) => {
      latestProfilesRef.current = profiles;
      latestDefaultProfileIdRef.current = defaultProfileId ?? null;
      latestFastProfileIdRef.current = fastProfileId ?? null;
      if (!defaultProfileId) {
        clearLayoutState(windowSessionKey);
        const freshState = createDefaultLayoutState();
        stateRef.current = freshState;
        setActiveFilePathSnapshot(getActiveFilePathFromState(freshState));
        setState(freshState);
      }
    }).catch(() => {});
  }, [windowSessionKey]);

  useEffect(() => {
    let cancelled = false;

    const refreshProfiles = async () => {
      let nextProfiles: Profile[] = [];
      let nextDefaultProfileId: string | null | undefined = null;
      let nextFastProfileId: string | null | undefined = null;
      let loadError: unknown = null;
      try {
        const data = await getProfiles();
        nextProfiles = data.profiles;
        nextDefaultProfileId = data.defaultProfileId;
        nextFastProfileId = data.fastProfileId;
      } catch (err) {
        loadError = err;
      }
      if (cancelled) return;
      if (loadError) {
        console.error('[LayoutContext] Failed to refresh profiles:', loadError);
        return;
      }
      latestDefaultProfileIdRef.current = nextDefaultProfileId ?? null;
      latestFastProfileIdRef.current = nextFastProfileId ?? null;
      syncTabsToProfiles(nextProfiles);
    };

    void refreshProfiles();
    const unsubscribe = profilesIpc.onChanged(() => {
      void refreshProfiles();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [syncTabsToProfiles]);

  useEffect(() => {
    return subscribeAgentActivity(() => {
      if (pendingProfileRefreshRef.current.size === 0) return;
      syncTabsToProfiles(latestProfilesRef.current);
    });
  }, [syncTabsToProfiles]);

  // Sidebar actions
  const toggleLeftSidebar = useCallback(() => {
    const nextIsOpen = !stateRef.current.leftSidebar.isOpen;
    trackSidebarVisibilityChanged({
      sidebar: 'left',
      isOpen: nextIsOpen,
      tab: stateRef.current.leftSidebar.activeTab,
    });
    updateState(prev => ({ ...prev, leftSidebar: { ...prev.leftSidebar, isOpen: nextIsOpen } }));
  }, [updateState]);
  const toggleRightSidebar = useCallback(() => {
    const nextIsOpen = !stateRef.current.rightSidebar.isOpen;
    trackSidebarVisibilityChanged({
      sidebar: 'right',
      isOpen: nextIsOpen,
      hasPinnedAgent: Boolean(stateRef.current.sidebarPane?.activeTabId ?? stateRef.current.sidebarPane?.tabIds[0]),
    });
    updateState(prev => ({
      ...prev,
      rightSidebar: { ...prev.rightSidebar, isOpen: nextIsOpen },
      activeTabRegion: sanitizeActiveTabRegion(prev.activeTabRegion, prev.sidebarPane, nextIsOpen),
    }));
  }, [updateState]);
  const setLeftSidebarOpen = useCallback((isOpen: boolean) => {
    if (stateRef.current.leftSidebar.isOpen !== isOpen) {
      trackSidebarVisibilityChanged({
        sidebar: 'left',
        isOpen,
        tab: stateRef.current.leftSidebar.activeTab,
      });
    }
    updateState(prev => ({ ...prev, leftSidebar: { ...prev.leftSidebar, isOpen } }));
  }, [updateState]);
  const setRightSidebarOpen = useCallback((isOpen: boolean) => {
    if (stateRef.current.rightSidebar.isOpen !== isOpen) {
      trackSidebarVisibilityChanged({
        sidebar: 'right',
        isOpen,
        hasPinnedAgent: Boolean(stateRef.current.sidebarPane?.activeTabId ?? stateRef.current.sidebarPane?.tabIds[0]),
      });
    }
    updateState(prev => ({
      ...prev,
      rightSidebar: { ...prev.rightSidebar, isOpen },
      activeTabRegion: sanitizeActiveTabRegion(prev.activeTabRegion, prev.sidebarPane, isOpen),
    }));
  }, [updateState]);
  const setLeftSidebarTab = useCallback((tab: 'explorer' | 'browser' | 'inbox') => {
    if (stateRef.current.leftSidebar.activeTab !== tab) {
      trackSidebarTabChanged({ sidebar: 'left', tab });
    }
    updateState(prev => ({ ...prev, leftSidebar: { ...prev.leftSidebar, activeTab: tab } }));
  }, [updateState]);
  const setActiveTabRegion = useCallback((region: ActiveTabRegion) => {
    updateState((prev) => ({
      ...prev,
      activeTabRegion: sanitizeActiveTabRegion(region, prev.sidebarPane, prev.rightSidebar.isOpen),
    }));
  }, [updateState]);
  const setLeftSidebarWidth = useCallback((width: number) => updateState(prev => ({ ...prev, leftSidebar: { ...prev.leftSidebar, width } })), [updateState]);
  const setRightSidebarWidth = useCallback((width: number) => updateState(prev => ({ ...prev, rightSidebar: { ...prev.rightSidebar, width } })), [updateState]);

  // Core tab actions
  const closeTab = useCallback((tabId: string) => {
    const tabToClose = stateRef.current.tabs[tabId];
    if (tabToClose && isAgentTab(tabToClose)) {
      void agentTabsIpc.disposeBinding({
        callerToken: tabToClose.agent.session.callerToken,
      });
    }

    updateState(prev => {
      const tab = prev.tabs[tabId];
      if (!tab) return prev;
      const tabs = { ...prev.tabs };
      delete tabs[tabId];
      let tree = prev.tree;
      let sidebarPane = prev.sidebarPane;
      const wasSidebarTab = Boolean(prev.sidebarPane?.tabIds.includes(tabId));

      if (wasSidebarTab) {
        sidebarPane = removeSidebarPaneTab(prev.sidebarPane, tabId);
      } else {
        tree = removeTabFromPane(prev.tree, findPaneByTabId(prev.tree, tabId)?.id || '', tabId);
      }

      let activePaneId = prev.activePaneId;
      const allPanes = getAllPanes(tree);
      if (!allPanes.some(p => p.id === activePaneId)) activePaneId = getFirstPane(tree).id;

      // Ensure at least one tab always exists — create a new tab if all panes are empty
      if (!allPanes.some(p => p.tabIds.length > 0)) {
        const agentTab = createEmptyAgentTab(getDefaultAgentModelConfig(), {
          workspacePath: workspacePath ?? undefined,
        });
        tabs[agentTab.id] = agentTab;
        const rootPane = getFirstPane(tree);
        tree = updatePane(tree, rootPane.id, p => ({ ...p, tabIds: [agentTab.id], activeTabId: agentTab.id }));
        activePaneId = rootPane.id;
      }

      return {
        ...prev,
        tabs,
        tree,
        sidebarPane,
        activePaneId,
        activeTabRegion: wasSidebarTab
          ? sanitizeActiveTabRegion('sidebar', sidebarPane, prev.rightSidebar.isOpen)
          : sanitizeActiveTabRegion(prev.activeTabRegion, sidebarPane, prev.rightSidebar.isOpen),
      };
    });
    clearAgentPendingInputs(tabId);
  }, [getDefaultAgentModelConfig, updateState, workspacePath]);

  const transferTabOut = useCallback((tabId: string): boolean => {
    let transferred = false;
    let shouldCloseWindow = false;

    updateState((prev) => {
      const tab = prev.tabs[tabId];
      if (!tab) {
        return prev;
      }

      transferred = true;
      const tabs = { ...prev.tabs };
      delete tabs[tabId];

      let tree = prev.tree;
      let sidebarPane = prev.sidebarPane;
      const wasSidebarTab = Boolean(prev.sidebarPane?.tabIds.includes(tabId));

      if (wasSidebarTab) {
        sidebarPane = removeSidebarPaneTab(prev.sidebarPane, tabId);
      } else {
        const pane = findPaneByTabId(prev.tree, tabId);
        if (!pane) {
          return prev;
        }
        tree = removeTabFromPane(prev.tree, pane.id, tabId);
      }

      const allPanes = getAllPanes(tree);
      let activePaneId = prev.activePaneId;
      if (allPanes.length > 0 && !allPanes.some((pane) => pane.id === activePaneId)) {
        activePaneId = getFirstPane(tree).id;
      }

      const remainingTabCount = allPanes.reduce((count, pane) => count + pane.tabIds.length, 0)
        + (sidebarPane?.tabIds.length ?? 0);
      shouldCloseWindow = remainingTabCount === 0;

      return {
        ...prev,
        tabs,
        tree,
        sidebarPane,
        activePaneId,
        activeTabRegion: wasSidebarTab
          ? sanitizeActiveTabRegion('sidebar', sidebarPane, prev.rightSidebar.isOpen)
          : sanitizeActiveTabRegion(prev.activeTabRegion, sidebarPane, prev.rightSidebar.isOpen),
      };
    });

    if (shouldCloseWindow) {
      window.close();
    }

    return transferred;
  }, [updateState]);

  const detachTabToNewWindow = useCallback(async (tabId: string): Promise<boolean> => {
    const currentState = stateRef.current;
    const tab = currentState.tabs[tabId];
    if (!tab) {
      return false;
    }

    const currentWorkspacePath = workspacePathRef.current;
    const detachWorkspacePath = isAgentTab(tab)
      ? tab.agent.runtime.workspacePath ?? currentWorkspacePath
      : currentWorkspacePath;

    try {
      const result = await windowIpc.detachTab({
        tab,
        workspacePath: detachWorkspacePath,
      });
      if (!result.success) {
        console.error('[LayoutContext] Failed to detach tab:', result.error);
        return false;
      }

      const mainTabCount = getAllPanes(currentState.tree).reduce((count, pane) => count + pane.tabIds.length, 0);
      const sidebarTabCount = currentState.sidebarPane?.tabIds.length ?? 0;
      if (mainTabCount + sidebarTabCount <= 1) {
        window.close();
        return true;
      }

      closeTab(tabId);
      return true;
    } catch (error) {
      console.error('[LayoutContext] Failed to detach tab:', error);
      return false;
    }
  }, [closeTab]);

  const resetAgentTab = useCallback((tabId: string, options?: { autoStartVoiceMode?: boolean; initialMessage?: string }): string | null => {
    trackAgentReset();
    const tabToReset = stateRef.current.tabs[tabId];
    if (tabToReset && isAgentTab(tabToReset)) {
      void agentTabsIpc.disposeBinding({
        callerToken: tabToReset.agent.session.callerToken,
      });
    }

    let replacementTabId: string | null = null;
    updateState(prev => {
      const oldTab = prev.tabs[tabId];
      if (!oldTab || !isAgentTab(oldTab)) return prev;

      const nextModelConfig = oldTab.agent.runtime.modelConfig ?? getDefaultAgentModelConfig();
      const nextWorkspacePath = oldTab.agent.runtime.workspacePath;
      const newTab = options?.initialMessage
        ? createAgentTab(options.initialMessage, nextModelConfig, {
            workspacePath: nextWorkspacePath,
          })
        : createEmptyAgentTab(
            nextModelConfig,
            { workspacePath: nextWorkspacePath },
          );
      if (options?.autoStartVoiceMode) {
        newTab.autoStartVoiceMode = true;
      }
      replacementTabId = newTab.id;

      const tabs = { ...prev.tabs };
      delete tabs[tabId];
      tabs[newTab.id] = newTab;

      // Check if tab is in the sidebar pane
      if (prev.sidebarPane?.tabIds.includes(tabId)) {
        const sidebarTabIds = prev.sidebarPane.tabIds.map(id => id === tabId ? newTab.id : id);
        const activeTabId = prev.sidebarPane.activeTabId === tabId ? newTab.id : prev.sidebarPane.activeTabId;
        return {
          ...prev,
          tabs,
          sidebarPane: { ...prev.sidebarPane, tabIds: sidebarTabIds, activeTabId },
        };
      }

      // Otherwise look in the main tree
      const pane = findPaneByTabId(prev.tree, tabId);
      if (!pane) return prev;

      const idx = pane.tabIds.indexOf(tabId);
      const newTabIds = [...pane.tabIds];
      newTabIds[idx] = newTab.id;

      const tree = updatePane(prev.tree, pane.id, p => ({
        ...p,
        tabIds: newTabIds,
        activeTabId: p.activeTabId === tabId ? newTab.id : p.activeTabId,
      }));

      return { ...prev, tree, tabs };
    });
    clearAgentPendingInputs(tabId);
    return replacementTabId;
  }, [getDefaultAgentModelConfig, updateState, workspacePath]);

  const setActiveTab = useCallback((tabId: string) => {
    // Imperatively flip PersistentLayer visibility BEFORE React re-renders.
    // This makes the tab switch appear instant while React reconciles in the background.
    const prev = stateRef.current;
    const pane = findPaneByTabId(prev.tree, tabId);
    if (!pane) return;
    const oldActiveTabId = pane.activeTabId;

    if (oldActiveTabId && oldActiveTabId !== tabId) {
      // Flip visibility on persistent layer overlay divs
      const oldEl = document.querySelector<HTMLElement>(`[data-persistent-tab="${oldActiveTabId}"]`);
      const newEl = document.querySelector<HTMLElement>(`[data-persistent-tab="${tabId}"]`);
      if (oldEl) { oldEl.style.visibility = 'hidden'; oldEl.style.pointerEvents = 'none'; }
      if (newEl) { newEl.style.visibility = 'visible'; newEl.style.pointerEvents = 'auto'; }

      // Update tab bar active state imperatively
      const tabBar = document.querySelector<HTMLElement>(`[data-testid="pane-tab-bar-${pane.id}"]`);
      if (tabBar) {
        const oldTab = tabBar.querySelector<HTMLElement>(`[data-tab-id="${oldActiveTabId}"]`);
        const newTab = tabBar.querySelector<HTMLElement>(`[data-tab-id="${tabId}"]`);
        if (oldTab) { oldTab.classList.remove('content-tab-active'); oldTab.setAttribute('data-active', 'false'); oldTab.setAttribute('aria-selected', 'false'); }
        if (newTab) { newTab.classList.add('content-tab-active'); newTab.setAttribute('data-active', 'true'); newTab.setAttribute('aria-selected', 'true'); }
      }

      // Trigger SVG chrome animation imperatively — measure the new active tab
      // position and dispatch an event that PaneShellChrome listens for.
      // This starts the animation immediately, before React reconciles.
      const paneShell = document.querySelector<HTMLElement>(`[data-pane-id="${pane.id}"]`);
      if (paneShell && tabBar) {
        const activeTabEl = tabBar.querySelector<HTMLElement>(`[data-tab-id="${tabId}"]`);
        const tabBarRect = tabBar.getBoundingClientRect();
        const activeRect = activeTabEl?.getBoundingClientRect();
        if (activeRect) {
          window.dispatchEvent(new CustomEvent('pane-shell:animate-tab', {
            detail: {
              paneId: pane.id,
              tabLeft: activeRect.left - tabBarRect.left,
              tabWidth: activeRect.width,
            },
          }));
        }
      }
    }

    // Update stateRef synchronously so other operations see the new active tab
    stateRef.current = {
      ...prev,
      tree: setActiveTabInPane(prev.tree, pane.id, tabId),
      activePaneId: pane.id,
      activeTabRegion: 'main',
    };

    // Yield to the browser so it can paint the imperative DOM changes above,
    // THEN run React reconciliation. Use updateState (not direct setState)
    // to avoid race conditions with operations that happen between now and the rAF.
    requestAnimationFrame(() => {
      updateState(prev2 => {
        const p = findPaneByTabId(prev2.tree, tabId);
        if (!p) return prev2;
        return {
          ...prev2,
          tree: setActiveTabInPane(prev2.tree, p.id, tabId),
          activePaneId: p.id,
          activeTabRegion: 'main',
        };
      });
    });
  }, [updateState]);

  const moveTab = useCallback((tabId: string, targetPaneId: string, index: number) => {
    updateState(prev => {
      const sourcePane = findPaneByTabId(prev.tree, tabId);
      if (!sourcePane) return prev;
      return {
        ...prev,
        tree: moveTabToPane(prev.tree, tabId, sourcePane.id, targetPaneId, index),
        activePaneId: targetPaneId,
        activeTabRegion: 'main',
      };
    });
  }, [updateState]);

  const updateTabPath = useCallback((oldPath: string, newPath: string) => {
    updateState(prev => {
      const tab = findTabByPath(prev.tabs, oldPath);
      if (!tab) return prev;
      const newLabel = pathBasename(newPath) || newPath;
      return { ...prev, tabs: { ...prev.tabs, [tab.id]: { ...tab, path: newPath, label: newLabel } } };
    });
  }, [updateState]);

  const updateTabLabel = useCallback((tabId: string, label: string) => {
    updateState(prev => {
      const tab = prev.tabs[tabId];
      if (!tab) return prev;
      return { ...prev, tabs: { ...prev.tabs, [tabId]: { ...tab, label } } };
    });
  }, [updateState]);

  // Tab openers (extracted hook)
  const tabOpeners = useTabOpeners({
    updateState,
    stateRef,
    getActivePane,
    closeTab,
    workspacePathRef,
    getDefaultAgentModelConfig,
    getFastAgentModelConfig,
  });
  const { fetchThumbnailForTab } = tabOpeners;

  // Pane actions
  const splitPaneAction = useCallback((paneId: string, direction: 'horizontal' | 'vertical', position: 'before' | 'after', tabId?: string): string | null => {
    let newPaneId: string | null = null;
    updateState(prev => {
      const result = splitPane(prev.tree, paneId, direction, position, tabId);
      newPaneId = result.newPaneId || null;
      return { ...prev, tree: result.tree, activePaneId: result.newPaneId || prev.activePaneId };
    });
    return newPaneId;
  }, [updateState]);

  const setActivePaneId = useCallback((paneId: string) => updateState(prev => ({
    ...prev,
    activePaneId: paneId,
    activeTabRegion: 'main',
  })), [updateState]);
  const updateSplitRatioAction = useCallback((splitId: string, ratio: number) => updateState(prev => ({ ...prev, tree: updateSplitRatio(prev.tree, splitId, ratio) })), [updateState]);

  // Sidebar pane management
  const registerSidebarTab = useCallback((tab: Tab) => {
    updateState(prev => {
      const tabs = { ...prev.tabs, [tab.id]: tab };
      return {
        ...prev,
        tabs,
        sidebarPane: appendSidebarPaneTab(prev.sidebarPane, tab.id),
      };
    });
  }, [updateState]);

  const unregisterSidebarTab = useCallback((tabId: string) => {
    updateState(prev => {
      const tabs = { ...prev.tabs };
      delete tabs[tabId];
      return {
        ...prev,
        tabs,
        sidebarPane: removeSidebarPaneTab(prev.sidebarPane, tabId),
      };
    });
  }, [updateState]);

  const setSidebarActiveTab = useCallback((tabId: string | null) => {
    updateState(prev => {
      if (!prev.sidebarPane) return prev;
      const nextTabId = tabId && prev.sidebarPane.tabIds.includes(tabId)
        ? tabId
        : (prev.sidebarPane.tabIds[0] ?? null);
      return {
        ...prev,
        sidebarPane: { ...prev.sidebarPane, activeTabId: nextTabId },
        activeTabRegion: nextTabId
          ? sanitizeActiveTabRegion('sidebar', prev.sidebarPane, prev.rightSidebar.isOpen)
          : 'main',
      };
    });
  }, [updateState]);

  // IPC listeners (extracted hook)
  useLayoutIpcListeners({
    stateRef, workspacePath,
    openFile: tabOpeners.openFile, refreshTab: tabOpeners.refreshTab, closeTab, setActiveTab,
    openNewTab: tabOpeners.openNewTab, openSettings: tabOpeners.openSettings, openAgentSessionTab: tabOpeners.openAgentSessionTab, splitPaneAction,
    openBrowserRef: tabOpeners.openBrowserRef, closeTabByBrowserIdRef: tabOpeners.closeTabByBrowserIdRef,
    toggleLeftSidebar, toggleRightSidebar, setLeftSidebarOpen, setRightSidebarOpen, setLeftSidebarTab, setSidebarActiveTab, setActiveTabRegion,
  });

  const updateSidebarTabLabel = useCallback((tabId: string, label: string) => {
    updateState(prev => {
      const tab = prev.tabs[tabId];
      if (!tab || tab.label === label) return prev;
      return { ...prev, tabs: { ...prev.tabs, [tabId]: { ...tab, label } } };
    });
  }, [updateState]);

  const updateTabModelConfig = useCallback((tabId: string, modelConfig: AgentModelConfig) => {
    updateState(prev => {
      const tab = prev.tabs[tabId];
      if (!tab || !isAgentTab(tab) || tab.agent.runtime.modelConfig === modelConfig) return prev;
      const nextTab: Tab = {
        ...tab,
        agent: {
          ...tab.agent,
          runtime: {
            ...tab.agent.runtime,
            modelConfig,
          },
        },
      };
      if (
        tab.agent.session.codexThreadId
        && didAgentRuntimeChange(tab.agent.runtime.modelConfig, modelConfig)
      ) {
        nextTab.agent = {
          ...nextTab.agent!,
          runtime: {
            ...nextTab.agent!.runtime,
            didSwitchRuntimeDuringConversation: true,
          },
        };
      }
      return { ...prev, tabs: { ...prev.tabs, [tabId]: nextTab } };
    });
  }, [didAgentRuntimeChange, updateState]);

  const updateTab = useCallback((tabId: string, fieldsOrUpdater: Partial<Tab> | ((tab: Tab) => Tab)) => {
    updateState(prev => {
      const tab = prev.tabs[tabId];
      if (!tab) return prev;
      const nextTab = typeof fieldsOrUpdater === 'function'
        ? fieldsOrUpdater(tab)
        : { ...tab, ...fieldsOrUpdater };
      return { ...prev, tabs: { ...prev.tabs, [tabId]: nextTab } };
    });
  }, [updateState]);

  const moveTabToSidebar = useCallback((tabId: string, options?: { fallbackPaneId?: string; fallbackIndex?: number; index?: number }) => {
    trackAgentPinned();
    updateState(prev => {
      const tab = prev.tabs[tabId];
      if (!tab) return prev;
      // Only agent and terminal tabs can live in the sidebar
      if (!SIDEBAR_TAB_TYPES.has(tab.type)) return prev;
      let tabs = prev.tabs;
      const sourcePane = findPaneByTabId(prev.tree, tabId);
      let tree = prev.tree;
      if (sourcePane) {
        tree = updatePane(tree, sourcePane.id, pane => {
          const newTabIds = pane.tabIds.filter(id => id !== tabId);
          return { ...pane, tabIds: newTabIds, activeTabId: pane.activeTabId === tabId ? (newTabIds[0] ?? null) : pane.activeTabId };
        });
      }

      if (sourcePane) {
        const updatedSource = findPaneById(tree, sourcePane.id);
        if (updatedSource && updatedSource.tabIds.length === 0 && !isPane(tree)) tree = collapseSplit(tree, sourcePane.id);
      }

      const mainTabCount = getAllPanes(tree).reduce((count, pane) => count + pane.tabIds.length, 0);
      let activePaneId = (prev.activePaneId && findPaneById(tree, prev.activePaneId))
        ? prev.activePaneId
        : getFirstPane(tree).id;

      if (mainTabCount === 0) {
        const replacementTab = createEmptyAgentTab(getDefaultAgentModelConfig(), {
          workspacePath: workspacePath ?? undefined,
        });
        tabs = { ...tabs, [replacementTab.id]: replacementTab };
        tree = addTabToPane(tree, activePaneId, replacementTab.id);
        activePaneId = activePaneId;
      }

      return {
        ...prev,
        tabs,
        tree,
        activePaneId,
        activeTabRegion: 'sidebar',
        sidebarPane: insertSidebarPaneTab(
          prev.sidebarPane,
          tabId,
          options?.index ?? (prev.sidebarPane?.tabIds.length ?? 0),
        ),
      };
    });
  }, [updateState, getDefaultAgentModelConfig, workspacePath]);

  const moveSidebarTab = useCallback((tabId: string, index: number) => {
    updateState(prev => {
      if (!prev.sidebarPane?.tabIds.includes(tabId)) {
        return prev;
      }

      return {
        ...prev,
        sidebarPane: insertSidebarPaneTab(prev.sidebarPane, tabId, index),
        activeTabRegion: sanitizeActiveTabRegion('sidebar', prev.sidebarPane, prev.rightSidebar.isOpen),
      };
    });
  }, [updateState]);

  const unpinSidebarTab = useCallback((tabId: string, paneId?: string) => {
    trackAgentUnpinned();
    updateState(prev => {
      if (!prev.sidebarPane?.tabIds.includes(tabId)) return prev;

      const targetPaneId = paneId && findPaneById(prev.tree, paneId)
        ? paneId
        : ((prev.activePaneId && findPaneById(prev.tree, prev.activePaneId))
            ? prev.activePaneId
            : getFirstPane(prev.tree).id);

      const tree = addTabToPane(prev.tree, targetPaneId, tabId);
      return {
        ...prev,
        tree,
        sidebarPane: removeSidebarPaneTab(prev.sidebarPane, tabId),
        activePaneId: targetPaneId,
        activeTabRegion: 'main',
      };
    });
  }, [updateState]);

  // Pane rect tracking
  const updatePaneRect = useCallback((paneId: string, rect: DOMRect | null) => {
    setPaneRects(prev => {
      if (!rect) { if (!prev[paneId]) return prev; const next = { ...prev }; delete next[paneId]; return next; }
      // Round to integers to avoid infinite re-render loops from sub-pixel jitter
      const r = { top: Math.round(rect.top), left: Math.round(rect.left), width: Math.round(rect.width), height: Math.round(rect.height) };
      const existing = prev[paneId];
      if (existing && existing.top === r.top && existing.left === r.left && existing.width === r.width && existing.height === r.height) return prev;
      return { ...prev, [paneId]: r };
    });
  }, []);

  // Tab drop (drag-to-split)
  const handleTabDrop = useCallback((tabId: string, sourcePaneId: string | null, targetPaneId: string, zone: 'center' | 'left' | 'right' | 'top' | 'bottom', index?: number, sidebarMeta?: any, dragData?: PaneTabDragData | null) => {
    const sourceWindowSessionKey = dragData?.sourceWindowSessionKey ?? null;
    const draggedTab = dragData?.tab ?? null;
    const isCrossWindowDrop = Boolean(
      sourceWindowSessionKey
      && sourceWindowSessionKey !== windowSessionKey
      && draggedTab,
    );

    if (isCrossWindowDrop && draggedTab) {
      void (async () => {
        const transferResult = await windowIpc.transferTabOut({
          sourceSessionKey: sourceWindowSessionKey!,
          tabId: draggedTab.id,
        });
        if (!transferResult.success) {
          console.error('[LayoutContext] Failed to transfer tab out of source window:', transferResult.error);
          return;
        }

        updateState((prev) => {
          if (prev.tabs[draggedTab.id]) {
            return prev;
          }

          const tabs = { ...prev.tabs, [draggedTab.id]: draggedTab };

          if (zone === 'center') {
            const tree = addTabToPane(prev.tree, targetPaneId, draggedTab.id, index);
            return {
              ...prev,
              tabs,
              tree,
              activePaneId: targetPaneId,
              activeTabRegion: 'main',
            };
          }

          const directionMap = { left: 'horizontal', right: 'horizontal', top: 'vertical', bottom: 'vertical' } as const;
          const positionMap = { left: 'before', right: 'after', top: 'before', bottom: 'after' } as const;
          const splitResult = splitPane(prev.tree, targetPaneId, directionMap[zone], positionMap[zone]);
          let tree = splitResult.tree;
          if (splitResult.newPaneId) {
            tree = updatePane(tree, splitResult.newPaneId, (pane) => ({
              ...pane,
              tabIds: [draggedTab.id],
              activeTabId: draggedTab.id,
            }));
          }

          return {
            ...prev,
            tabs,
            tree,
            activePaneId: splitResult.newPaneId || prev.activePaneId,
            activeTabRegion: 'main',
          };
        });
      })();
      return;
    }

    updateState(prev => {
      const fromSidebar = sourcePaneId === 'sidebar';
      let tabs = prev.tabs;
      let sidebarPane = prev.sidebarPane;
      const effectiveTabId = tabId;

      if (fromSidebar && sidebarPane) {
        sidebarPane = removeSidebarPaneTab(sidebarPane, effectiveTabId);
      }

      const srcPane = fromSidebar ? null : (sourcePaneId ? findPaneById(prev.tree, sourcePaneId) : findPaneByTabId(prev.tree, effectiveTabId));
      if (!fromSidebar && !srcPane) return prev;

      if (zone === 'center') {
        if (fromSidebar) {
          const tree = updatePane(prev.tree, targetPaneId, pane => ({ ...pane, tabIds: [...pane.tabIds, effectiveTabId], activeTabId: effectiveTabId }));
          return {
            ...prev,
            tree,
            tabs,
            sidebarPane,
            activePaneId: targetPaneId,
            activeTabRegion: 'main',
          };
        }
        return {
          ...prev,
          tree: moveTabToPane(prev.tree, effectiveTabId, srcPane!.id, targetPaneId, index ?? 9999),
          tabs,
          activePaneId: targetPaneId,
          activeTabRegion: 'main',
        };
      }

      const directionMap = { left: 'horizontal', right: 'horizontal', top: 'vertical', bottom: 'vertical' } as const;
      const positionMap = { left: 'before', right: 'after', top: 'before', bottom: 'after' } as const;

      let tree = prev.tree;
      if (srcPane && srcPane.tabIds.includes(effectiveTabId)) {
        tree = updatePane(tree, srcPane.id, pane => {
          const newTabIds = pane.tabIds.filter(id => id !== effectiveTabId);
          return { ...pane, tabIds: newTabIds, activeTabId: pane.activeTabId === effectiveTabId ? (newTabIds[0] ?? null) : pane.activeTabId };
        });
        const updatedSource = findPaneById(tree, srcPane.id);
        if (updatedSource && updatedSource.tabIds.length === 0 && !isPane(tree)) tree = collapseSplit(tree, srcPane.id);
      }

      const targetPane = findPaneById(tree, targetPaneId);
      if (!targetPane) return prev;

      const splitResult = splitPane(tree, targetPaneId, directionMap[zone], positionMap[zone]);
      let newTree = splitResult.tree;
      if (splitResult.newPaneId) {
        newTree = updatePane(newTree, splitResult.newPaneId, pane => ({ ...pane, tabIds: [effectiveTabId], activeTabId: effectiveTabId }));
      }
      return {
        ...prev,
        tree: newTree,
        tabs,
        sidebarPane,
        activePaneId: splitResult.newPaneId || prev.activePaneId,
        activeTabRegion: 'main',
      };
    });

    if (sourcePaneId === 'sidebar' && sidebarMeta?.agentTabId) {
      queueMicrotask(() => window.dispatchEvent(new CustomEvent('sidebar:tab-moved-to-editor', { detail: { agentTabId: sidebarMeta.agentTabId } })));
    }
  }, [updateState, windowSessionKey]);

  // Utility
  const getState = useCallback(() => stateRef.current, []);
  const resetToDefaults = useCallback(() => updateState(() => createDefaultLayoutState()), [updateState]);
  const setLayoutState = useCallback((newState: LayoutState) => {
    if (!newState?.leftSidebar || !newState?.rightSidebar || !newState?.tree) return;
    updateState(() => ({
      ...newState,
      activeTabRegion: sanitizeActiveTabRegion(
        newState.activeTabRegion,
        newState.sidebarPane,
        newState.rightSidebar.isOpen,
      ),
    }));
  }, [updateState]);

  useEffect(() => {
    let cancelled = false;

    const refreshBrowserControlStatus = async () => {
      try {
        const status = await browserControl.getStatus();
        if (!cancelled) {
          browserControlStatusRef.current = status;
        }
      } catch {
        if (!cancelled) {
          browserControlStatusRef.current = null;
        }
      }
    };

    void refreshBrowserControlStatus();
    const unsubscribe = browserControl.onChanged?.(() => {
      void refreshBrowserControlStatus();
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  // Workstation context
  const getWorkstationContext = useCallback((): WorkstationContext => {
    const s = stateRef.current;
    const files: { path: string; isActive: boolean }[] = [];
    const browsers: { browserId: string; title: string; url: string; isActive: boolean }[] = [];
    const emails: { emailId: string; subject: string; isActive: boolean }[] = [];
    for (const pane of getAllPanes(s.tree)) {
      for (const tabId of pane.tabIds) {
        const tab = s.tabs[tabId];
        if (!tab) continue;
        const isActive = pane.activeTabId === tabId;
        if (tab.type === 'file' && tab.path) files.push({ path: tab.path, isActive });
        else if (tab.type === 'browser' && tab.browserId) browsers.push({ browserId: tab.browserId, title: tab.label, url: tab.url || '', isActive });
        else if (tab.type === 'email' && tab.emailId) emails.push({ emailId: tab.emailId, subject: tab.label, isActive });
      }
    }
    const browserStatus = browserControlStatusRef.current;
    for (const connection of browserStatus?.connections ?? []) {
      for (const target of connection.targets) {
        if (target.type !== 'page') continue;
        browsers.push({
          browserId: target.tabRef,
          title: target.title,
          url: target.url,
          isActive: connection.activeSessions > 0,
        });
      }
    }
    return {
      workspace: workspacePath,
      tabs: { files, browsers, emails },
      selection: currentSelectionRef.current,
      sidebars: {
        left: { isOpen: s.leftSidebar.isOpen, activeTab: s.leftSidebar.activeTab },
        right: { isOpen: s.rightSidebar.isOpen },
      },
    };
  }, [workspacePath, currentSelectionRef]);

  // Layout get/set (agent-friendly serialization + reconciliation)
  const serializeLayout = useCallback((): any => {
    const s = stateRef.current;
    function serializeTab(tab: Tab, isActive: boolean): any {
      const entry: any = { tab_id: tab.id, type: tab.type, label: tab.label };
      if (isActive) entry.active = true;
      if (tab.path) entry.path = tab.path;
      if (tab.url) entry.url = tab.url;
      if (tab.browserId) entry.browser_id = tab.browserId;
      if (tab.emailId) entry.email_id = tab.emailId;
      if (tab.agentTabId) entry.agent_tab_id = tab.agentTabId;
      if (tab.terminalAgent) entry.terminal_agent = tab.terminalAgent;
      if (tab.settingsSection) entry.settings_section = tab.settingsSection;
      if (tab.pdfPage) entry.page = tab.pdfPage;
      return entry;
    }
    function serializeNode(node: TreeNode): any {
      if (isPane(node)) {
        return { kind: 'pane', pane_id: node.id, tabs: node.tabIds.map(id => s.tabs[id]).filter(Boolean).map(tab => serializeTab(tab, node.activeTabId === tab.id)) };
      }
      return { kind: 'split', direction: node.direction, ratio: node.ratio, children: node.children.map(serializeNode) };
    }
    return {
      tree: serializeNode(s.tree),
      active_pane_id: s.activePaneId,
      sidebar_tabs: s.sidebarPane ? s.sidebarPane.tabIds.map(id => s.tabs[id]).filter(Boolean).map(tab => serializeTab(tab, s.sidebarPane?.activeTabId === tab.id)) : [],
      sidebars: { left: { is_open: s.leftSidebar.isOpen, active_tab: s.leftSidebar.activeTab }, right: { is_open: s.rightSidebar.isOpen } },
      workspace: workspacePath,
    };
  }, [workspacePath]);

  const getWorkstationLayout = useCallback((path?: string): any => {
    const layout = serializeLayout();
    if (!path) return layout;
    return lodashGet(layout, path);
  }, [serializeLayout]);

  const setWorkstationLayout = useCallback((path: string, value: any): any => {
    const current = serializeLayout();
    const desired = cloneDeep(current);
    lodashSet(desired, path, value);
    const s = stateRef.current;
    const newTabs: Record<string, Tab> = {};
    const mentionedTabIds = new Set<string>();

    const _warnings: string[] = [];
    const newFileTabPaths: { tabId: string; path: string }[] = [];

    function inferEntryType(entry: any): Tab['type'] | null {
      if (entry.tab_id && s.tabs[entry.tab_id]) return s.tabs[entry.tab_id].type;
      if (entry.type === 'folder' && entry.path) return 'folder';
      if (entry.path) return 'file';
      if (entry.url) return 'browser';
      if (entry.email_id) return 'email';
      if (entry.agent_tab_id) return 'terminal';
      if (entry.type === 'settings' || entry.settings_section || entry.section) return 'settings';
      return null;
    }

    function describeEntry(entry: any): string {
      if (entry.tab_id && s.tabs[entry.tab_id]) return s.tabs[entry.tab_id].label;
      if (entry.label) return entry.label;
      if (entry.path) return entry.path;
      if (entry.url) return entry.url;
      if (entry.email_id) return entry.email_id;
      if (entry.agent_tab_id) return entry.agent_tab_id;
      if (entry.settings_section || entry.section) return `Settings (${entry.settings_section || entry.section})`;
      if (entry.tab_id) return entry.tab_id;
      return JSON.stringify(entry);
    }

    function resolveTab(entry: any): Tab | null {
      try {
        const requestedSettingsSection = typeof entry.settings_section === 'string'
          ? entry.settings_section
          : typeof entry.section === 'string'
            ? entry.section
            : undefined;

        // Reuse existing tab by ID
        if (entry.tab_id && s.tabs[entry.tab_id]) {
          let e = s.tabs[entry.tab_id];
          if (entry.page != null) e = { ...e, pdfPage: entry.page };
          if (e.type === 'settings' && requestedSettingsSection && e.settingsSection !== requestedSettingsSection) {
            e = { ...e, settingsSection: requestedSettingsSection };
          }
          mentionedTabIds.add(e.id);
          newTabs[e.id] = e;
          return e;
        }

        // Warn if tab_id was provided but doesn't exist (likely stale reference)
        if (entry.tab_id && !s.tabs[entry.tab_id] && !entry.path && !entry.url && !entry.email_id && !entry.agent_tab_id && entry.type !== 'settings' && !requestedSettingsSection) {
          _warnings.push(`Tab ID "${entry.tab_id}" not found in current state — tab was dropped. Provide a "path", "url", or other identifying field as a fallback.`);
          return null;
        }

        // Infer type from fields — fields are unambiguous, type is optional
        if (entry.type === 'folder' && entry.path) {
          const existingFolderTab = findFolderTabByPath(s.tabs, entry.path);
          if (existingFolderTab) {
            mentionedTabIds.add(existingFolderTab.id);
            newTabs[existingFolderTab.id] = existingFolderTab;
            return existingFolderTab;
          }
          const folderTab = createFolderTab(entry.path);
          mentionedTabIds.add(folderTab.id);
          newTabs[folderTab.id] = folderTab;
          return folderTab;
        }
        if (entry.path) { let e = findTabByPath(s.tabs, entry.path); if (e) { if (entry.page != null) e = { ...e, pdfPage: entry.page }; mentionedTabIds.add(e.id); newTabs[e.id] = e; return e; } const t = createFileTab(entry.path); if (entry.page != null) t.pdfPage = entry.page; mentionedTabIds.add(t.id); newTabs[t.id] = t; newFileTabPaths.push({ tabId: t.id, path: entry.path }); return t; }
        if (entry.url) { for (const t of Object.values(s.tabs)) if (t.type === 'browser' && t.url === entry.url) { mentionedTabIds.add(t.id); newTabs[t.id] = t; return t; } const t = createBrowserTab(entry.url, entry.browser_id); mentionedTabIds.add(t.id); newTabs[t.id] = t; return t; }
        if (entry.email_id) { for (const t of Object.values(s.tabs)) if (t.type === 'email' && t.emailId === entry.email_id) { mentionedTabIds.add(t.id); newTabs[t.id] = t; return t; } const t = createEmailTab(entry.email_id, entry.label || '(no subject)'); mentionedTabIds.add(t.id); newTabs[t.id] = t; return t; }
        if (entry.agent_tab_id) { for (const t of Object.values(s.tabs)) if (t.type === 'terminal' && t.agentTabId === entry.agent_tab_id) { mentionedTabIds.add(t.id); newTabs[t.id] = t; return t; } const t = createTerminalEditorTab(entry.agent_tab_id, entry.label || 'Terminal', { terminalAgent: entry.terminal_agent }); mentionedTabIds.add(t.id); newTabs[t.id] = t; return t; }

        // Type-only entries (no distinguishing field)
        if (entry.type === 'settings' || requestedSettingsSection) {
          for (const t of Object.values(s.tabs)) {
            if (t.type === 'settings') {
              const nextSettingsTab = requestedSettingsSection && t.settingsSection !== requestedSettingsSection
                ? { ...t, settingsSection: requestedSettingsSection }
                : t;
              mentionedTabIds.add(nextSettingsTab.id);
              newTabs[nextSettingsTab.id] = nextSettingsTab;
              return nextSettingsTab;
            }
          }
          const t = createSettingsTab(requestedSettingsSection);
          mentionedTabIds.add(t.id);
          newTabs[t.id] = t;
          return t;
        }

        // Unresolvable — warn
        const desc = entry.label || JSON.stringify(entry);
        _warnings.push(`Dropped unresolvable tab entry: ${desc}. Provide a "path" for files, "url" for browsers, "email_id" for emails, "agent_tab_id" for terminals, or "settings_section" for Settings.`);
        return null;
      } catch (err) {
        const desc = entry.label || entry.url || entry.path || JSON.stringify(entry);
        _warnings.push(`Error resolving tab "${desc}": ${err instanceof Error ? err.message : String(err)}`);
        console.error('[setWorkstationLayout] resolveTab error:', err, 'entry:', entry);
        return null;
      }
    }

    function buildNode(nodeObj: any): TreeNode {
      // Guard: if nodeObj is a string, try to parse it (handles double-encoded JSON from LLM tool calls)
      if (typeof nodeObj === 'string') {
        try {
          const parsed = JSON.parse(nodeObj);
          if (parsed && typeof parsed === 'object') {
            _warnings.push('Tree value was a JSON string instead of an object — auto-parsed. Check tool call encoding.');
            return buildNode(parsed);
          }
        } catch { /* not valid JSON, fall through */ }
        _warnings.push(`Tree node is a string ("${nodeObj.slice(0, 80)}") instead of an object — created empty pane. Provide an object with kind:"pane" or kind:"split".`);
        return createPane([], null);
      }
      if (!nodeObj || typeof nodeObj !== 'object') {
        _warnings.push(`Tree node is ${nodeObj === null ? 'null' : typeof nodeObj} instead of an object — created empty pane.`);
        return createPane([], null);
      }
      if (nodeObj.kind === 'pane') {
        const tabIds: string[] = []; let activeTabId: string | null = null;
        for (const entry of (nodeObj.tabs || [])) { const t = resolveTab(entry); if (t) { tabIds.push(t.id); if (entry.active) activeTabId = t.id; } }
        if (!activeTabId && tabIds.length > 0) activeTabId = tabIds[0];
        return { kind: 'pane', id: nodeObj.pane_id || createPane().id, tabIds, activeTabId } as Pane;
      }
      if (nodeObj.kind === 'split') {
        const children = (nodeObj.children || []).map(buildNode);
        while (children.length < 2) children.push(createPane([], null));
        return { kind: 'split', id: createSplitNode(nodeObj.direction || 'horizontal', [children[0], children[1]]).id, direction: nodeObj.direction || 'horizontal', ratio: nodeObj.ratio ?? 0.5, children: [children[0], children[1]] as [TreeNode, TreeNode] } as SplitNode;
      }
      _warnings.push(`Tree node has unrecognized kind: "${nodeObj.kind}" — created empty pane. Use kind:"pane" or kind:"split".`);
      return createPane([], null);
    }

    let newTree = desired.tree ? buildNode(desired.tree) : s.tree;
    let newSidebarPane = s.sidebarPane;
    const sidebarWasExplicitlySet = path === 'sidebar_tabs' || path.startsWith('sidebar_tabs');
    const treeWasExplicitlySet = path === 'tree' || path.startsWith('tree');
    if (desired.sidebar_tabs && Array.isArray(desired.sidebar_tabs)) {
      const sTabIds: string[] = []; let sActive: string | null = null;
      for (const entry of desired.sidebar_tabs) {
        const inferredType = inferEntryType(entry);
        if (inferredType && !SIDEBAR_TAB_TYPES.has(inferredType)) {
          _warnings.push(`Cannot move "${describeEntry(entry)}" (type: ${inferredType}) to sidebar — only agent and terminal tabs are allowed in the sidebar. Leave non-agent tabs in the main tree.`);
          continue;
        }

        const t = resolveTab(entry);
        if (t) {
          if (!SIDEBAR_TAB_TYPES.has(t.type)) {
            _warnings.push(`Cannot move "${t.label}" (type: ${t.type}) to sidebar — only agent and terminal tabs are allowed in the sidebar. Leave non-agent tabs in the main tree.`);
            continue;
          }
          if (!sTabIds.includes(t.id)) {
            sTabIds.push(t.id);
          }
          if (entry.active) sActive = t.id;
        }
      }
      newSidebarPane = sTabIds.length > 0 ? { kind: 'pane', id: s.sidebarPane?.id || 'sidebar', tabIds: sTabIds, activeTabId: sActive || sTabIds[0] } : null;
    }

    // Deduplicate: a tab can only be in the tree OR the sidebar, not both.
    // The explicitly-set side wins. If sidebar_tabs was set, remove those tabs from the tree.
    // If tree was set, remove those tabs from the sidebar.
    if (sidebarWasExplicitlySet && newSidebarPane) {
      const sidebarIds = new Set(newSidebarPane.tabIds);
      function removeFromTree(node: TreeNode): TreeNode {
        if (isPane(node)) {
          const filtered = node.tabIds.filter(id => !sidebarIds.has(id));
          const activeTabId = node.activeTabId && sidebarIds.has(node.activeTabId) ? (filtered[0] ?? null) : node.activeTabId;
          return { ...node, tabIds: filtered, activeTabId };
        }
        return { ...node, children: [removeFromTree(node.children[0]), removeFromTree(node.children[1])] as [TreeNode, TreeNode] };
      }
      newTree = removeFromTree(newTree);
    } else if (treeWasExplicitlySet && newSidebarPane) {
      const treeIds = new Set<string>();
      function collectTreeIds(node: TreeNode) { if (isPane(node)) node.tabIds.forEach(id => treeIds.add(id)); else node.children.forEach(collectTreeIds); }
      collectTreeIds(newTree);
      const filtered = newSidebarPane.tabIds.filter(id => !treeIds.has(id));
      if (filtered.length > 0) {
        const activeTabId = newSidebarPane.activeTabId && treeIds.has(newSidebarPane.activeTabId) ? (filtered[0] ?? null) : newSidebarPane.activeTabId;
        newSidebarPane = { ...newSidebarPane, tabIds: filtered, activeTabId };
      } else {
        newSidebarPane = null;
      }
    }

    const placedTabIds = new Set<string>();
    function collectPlaced(node: TreeNode) { if (isPane(node)) node.tabIds.forEach(id => placedTabIds.add(id)); else node.children.forEach(collectPlaced); }
    collectPlaced(newTree);
    if (newSidebarPane) newSidebarPane.tabIds.forEach(id => placedTabIds.add(id));

    for (const [id, tab] of Object.entries(s.tabs)) {
      if (!mentionedTabIds.has(id) && !placedTabIds.has(id)) { newTabs[id] = tab; }
    }
    const unmentioned = Object.entries(s.tabs).filter(([id]) => !mentionedTabIds.has(id) && !placedTabIds.has(id)).map(([, tab]) => tab);
    if (unmentioned.length > 0) {
      const fp = getFirstPane(newTree);
      newTree = updatePane(newTree, fp.id, pane => ({ ...pane, tabIds: [...pane.tabIds, ...unmentioned.map(t => t.id)] }));
    }

    if (!isPane(newTree)) {
      let changed = true;
      while (changed && !isPane(newTree)) {
        changed = false;
        for (const p of getAllPanes(newTree)) {
          if (p.tabIds.length === 0) {
            _warnings.push(`Auto-collapsed empty pane "${p.id}". If you expected tabs here, check that tab entries have the correct fields (path, url, tab_id, etc.).`);
            newTree = collapseSplit(newTree, p.id); changed = true; break;
          }
        }
      }
    }

    // Verify that all URL tabs from the input survived reconciliation
    function collectRequestedUrls(obj: any): string[] {
      if (!obj || typeof obj !== 'object') return [];
      const urls: string[] = [];
      if (typeof obj.url === 'string' && !obj.tab_id) urls.push(obj.url);
      if (Array.isArray(obj.tabs)) for (const t of obj.tabs) urls.push(...collectRequestedUrls(t));
      if (Array.isArray(obj.children)) for (const c of obj.children) urls.push(...collectRequestedUrls(c));
      return urls;
    }
    const requestedUrls = collectRequestedUrls(value);
    if (requestedUrls.length > 0) {
      const placedUrls = new Set<string>();
      for (const id of placedTabIds) { const t = newTabs[id]; if (t?.type === 'browser' && t.url) placedUrls.add(t.url); }
      for (const url of requestedUrls) {
        if (!placedUrls.has(url)) {
          _warnings.push(`Browser tab for URL "${url}" was requested but is missing from the final layout. This may indicate a reconciliation bug.`);
        }
      }
    }

    let newLeft = s.leftSidebar, newRight = s.rightSidebar;
    if (desired.sidebars?.left) newLeft = { ...s.leftSidebar, ...(desired.sidebars.left.is_open !== undefined ? { isOpen: desired.sidebars.left.is_open } : {}), ...(desired.sidebars.left.active_tab !== undefined ? { activeTab: desired.sidebars.left.active_tab } : {}) };
    if (desired.sidebars?.right) newRight = { ...s.rightSidebar, ...(desired.sidebars.right.is_open !== undefined ? { isOpen: desired.sidebars.right.is_open } : {}) };

    // Auto-open right sidebar when tabs are added to it
    const oldSidebarTabCount = s.sidebarPane?.tabIds.length || 0;
    const newSidebarTabCount = newSidebarPane?.tabIds.length || 0;
    if (newSidebarTabCount > oldSidebarTabCount && !newRight.isOpen) {
      newRight = { ...newRight, isOpen: true };
    }

    let newActivePaneId = desired.active_pane_id || s.activePaneId;
    if (!getAllPanes(newTree).some(p => p.id === newActivePaneId)) newActivePaneId = getFirstPane(newTree).id;

    const newState: LayoutState = { ...s, tree: newTree, tabs: { ...newTabs }, activePaneId: newActivePaneId, sidebarPane: newSidebarPane, leftSidebar: newLeft, rightSidebar: newRight };
    for (const id of placedTabIds) { if (!newState.tabs[id] && s.tabs[id]) newState.tabs[id] = s.tabs[id]; }

    const oldSidebarIds = new Set(s.sidebarPane?.tabIds || []);
    const newSidebarIds = new Set(newSidebarPane?.tabIds || []);
    updateState(() => newState);

    for (const tid of oldSidebarIds) { if (!newSidebarIds.has(tid)) { const t = s.tabs[tid]; queueMicrotask(() => window.dispatchEvent(new CustomEvent('sidebar:tab-moved-to-editor', { detail: { agentTabId: t?.agentTabId || tid } }))); } }
    for (const tid of newSidebarIds) { if (!oldSidebarIds.has(tid)) queueMicrotask(() => window.dispatchEvent(new CustomEvent('sidebar:tab-added', { detail: { tabId: tid } }))); }
    for (const { tabId, path: filePath } of newFileTabPaths) fetchThumbnailForTab(tabId, filePath);
    const result = serializeLayout();
    if (_warnings.length > 0) result._warnings = _warnings;
    return result;
  }, [fetchThumbnailForTab, serializeLayout, updateState]);

  // Expose to window
  useEffect(() => {
    (window as any).__layoutContext = {
      getState, openFile: tabOpeners.openFile, refreshTab: tabOpeners.refreshTab, closeTab, setActiveTab, moveTab,
      splitPaneAction, setActivePaneId, setActiveTabRegion, updateSplitRatioAction, handleTabDrop,
      openNewTab: tabOpeners.openNewTab, openSeededAgentTab: tabOpeners.openSeededAgentTab, openFolder: tabOpeners.openFolder, openBrowser: tabOpeners.openBrowser, updateBrowserTabLabel: tabOpeners.updateBrowserTabLabel, openEmail: tabOpeners.openEmail, openChat: tabOpeners.openChat,
      openSettings: tabOpeners.openSettings, toggleSettings: tabOpeners.toggleSettings, openAgentTab: tabOpeners.openAgentTab,
      detachTabToNewWindow, transferTabOut,
      toggleLeftSidebar, toggleRightSidebar, setLeftSidebarOpen, setRightSidebarOpen, setLeftSidebarTab, setLeftSidebarWidth, setRightSidebarWidth,
      moveSidebarTab, unpinSidebarTab,
      resetToDefaults, setLayoutState,
    };
    return () => { delete (window as any).__layoutContext; };
  });

  useEffect(() => {
    (window as any).__getWorkstationContext = getWorkstationContext;
    (window as any).__getWorkstationLayout = getWorkstationLayout;
    (window as any).__setWorkstationLayout = setWorkstationLayout;
    (window as any).__getCurrentSelection = () => currentSelectionRef.current;
    return () => { delete (window as any).__getWorkstationContext; delete (window as any).__getWorkstationLayout; delete (window as any).__setWorkstationLayout; delete (window as any).__getCurrentSelection; };
  }, [getWorkstationContext, getWorkstationLayout, setWorkstationLayout, currentSelectionRef]);

  const setComposerPrompt = useCallback((prompt: string | null, options?: { autoSend?: boolean }) => {
    setPendingPrompt(prompt);
    setPendingAutoSend(options?.autoSend ?? false);
  }, []);

  // Actions-only value — stable references, no state dependency.
  // Components that only need actions subscribe to LayoutActionsContext
  // and skip re-renders on state changes (e.g. tab switches).
  const actionsValue: LayoutActions = useMemo(() => ({
    toggleLeftSidebar, toggleRightSidebar, setLeftSidebarOpen, setRightSidebarOpen, setLeftSidebarTab, setLeftSidebarWidth, setRightSidebarWidth,
    openFile: tabOpeners.openFile, openFolder: tabOpeners.openFolder, refreshTab: tabOpeners.refreshTab, closeTab, setActiveTab, moveTab, updateTabPath, updateTabLabel,
    splitPaneAction, setActivePaneId, setActiveTabRegion, updateSplitRatioAction,
    openNewTab: tabOpeners.openNewTab, openSeededAgentTab: tabOpeners.openSeededAgentTab, openBrowser: tabOpeners.openBrowser, updateBrowserTabLabel: tabOpeners.updateBrowserTabLabel, openEmail: tabOpeners.openEmail, openChat: tabOpeners.openChat,
    openSettings: tabOpeners.openSettings, toggleSettings: tabOpeners.toggleSettings, openAgentTab: tabOpeners.openAgentTab,
    detachTabToNewWindow,
    morphNewTabToAgent: tabOpeners.morphNewTabToAgent,
    registerSidebarTab, unregisterSidebarTab, setSidebarActiveTab, updateSidebarTabLabel, updateTabModelConfig, updateTab, moveTabToSidebar, moveSidebarTab, unpinSidebarTab,
    updatePaneRect, handleTabDrop,
    getState, resetAgentTab, resetToDefaults, setLayoutState,
  }), [
    toggleLeftSidebar, toggleRightSidebar, setLeftSidebarOpen, setRightSidebarOpen, setLeftSidebarTab, setLeftSidebarWidth, setRightSidebarWidth,
    tabOpeners.openFile, tabOpeners.openFolder, tabOpeners.refreshTab, closeTab, setActiveTab, moveTab, updateTabPath, updateTabLabel,
    splitPaneAction, setActivePaneId, setActiveTabRegion, updateSplitRatioAction,
    tabOpeners.openNewTab, tabOpeners.openSeededAgentTab, tabOpeners.openBrowser, tabOpeners.updateBrowserTabLabel, tabOpeners.openEmail, tabOpeners.openChat,
    tabOpeners.openSettings, tabOpeners.toggleSettings, tabOpeners.openAgentTab,
    detachTabToNewWindow,
    tabOpeners.morphNewTabToAgent,
    registerSidebarTab, unregisterSidebarTab, setSidebarActiveTab, updateSidebarTabLabel, updateTabModelConfig, updateTab, moveTabToSidebar, moveSidebarTab, unpinSidebarTab,
    updatePaneRect, handleTabDrop,
    getState, resetAgentTab, resetToDefaults, setLayoutState,
  ]);

  const contextValue: LayoutContextValue = useMemo(() => ({
    state, paneRects, currentSelection, setSelection, clearSelection, getWorkstationContext, pendingPrompt, pendingAutoSend, setComposerPrompt,
    ...actionsValue,
  }), [
    state, paneRects, currentSelection, setSelection, clearSelection, getWorkstationContext, pendingPrompt, pendingAutoSend, setComposerPrompt,
    actionsValue,
  ]);

  return (
    <LayoutActionsContext.Provider value={actionsValue}>
      <LayoutContext.Provider value={contextValue}>{children}</LayoutContext.Provider>
    </LayoutActionsContext.Provider>
  );
}

// ============================================================================
// Hooks
// ============================================================================

export function useActiveFilePath(): string | null {
  const context = useContext(LayoutContext);
  const activeFilePath = useMemo(() => {
    if (!context) return null;
    return getActiveFilePathFromState(context.state);
  }, [context]);

  return activeFilePath;
}
