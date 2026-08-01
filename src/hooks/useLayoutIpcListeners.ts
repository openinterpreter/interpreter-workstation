/**
 * useLayoutIpcListeners Hook
 *
 * All IPC-subscribing useEffects extracted from LayoutContext:
 * - files.onRefreshed
 * - browser.onTabCreated / onTabClosed
 * - tabs.onClose / onNew / onNext / onPrevious / onGoTo
 * - quickActions.onQuickOpen / onToggleExplorer / onFocusAgent / onOpenInbox
 * - workspace.onFilesChanged
 * - pane:file-drop window event
 * - workstation.onOpenFile / onOpenUrl / onCloseTab / onFocusTab / onToggleSidebar
 *
 * Pure side-effect hook — returns nothing.
 */

import { useEffect } from 'react';
import { tr } from '../i18n';
import type {
  AgentTabCreateRequestedEvent,
  AgentTabGetPendingResponse,
} from '../../electron/ipc/registry';
import { getDefaultModelConfig } from '../../shared/types/profile';
import { isAgentTab, type LayoutState } from '../../shared/types/layout';
import {
  findTabByPath,
  findTabByBrowserId,
} from '../utils/layoutHelpers';
import { findTabNavigationEntry, getOrderedTabEntries, resolveActiveTabTarget } from '../utils/tabNavigation';
import {
  files as filesIpc,
  browser as browserIpc,
  tabs as tabsIpc,
  quickActions as quickActionsIpc,
  workspace as workspaceIpc,
  workstation as workstationIpc,
  agentTabs,
  pathJoin,
  signalRendererReady,
} from '@/ipc';
import { focusComposer } from '../../agent/utils/focusComposer';
import { trackShortcutInvoked } from '../utils/telemetry';

interface UseLayoutIpcListenersArgs {
  stateRef: React.MutableRefObject<LayoutState>;
  workspacePath: string | null;

  // Tab openers & actions
  openFile: (path: string, paneId?: string, page?: number) => void;
  refreshTab: (path: string) => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  openNewTab: (paneId?: string) => void;
  openSettings: () => void;
  openAgentSessionTab: (options: {
    agentId?: string;
    label?: string;
    requestId?: string;
    startupId?: string;
    initialMessage?: string;
    conversationId?: string;
    threadId?: string;
    callerToken?: string;
    workspacePath?: string;
    modelConfig?: import('../../shared/types/model').AgentModelConfig;
    systemPrompt?: string;
    agentChannel?: import('../../shared/types/messaging').MessagingChannel;
    agentChannelThreadId?: string;
    activate?: boolean;
    paneId?: string;
  }) => string;

  // Split pane action
  splitPaneAction: (paneId: string, direction: 'horizontal' | 'vertical', position: 'before' | 'after', tabId?: string) => string | null;

  // Refs for browser tab sync
  openBrowserRef: React.MutableRefObject<((url: string, paneId?: string, browserId?: string) => void) | null>;
  closeTabByBrowserIdRef: React.MutableRefObject<((browserId: string) => void) | null>;

  // Sidebar actions
  toggleLeftSidebar: () => void;
  toggleRightSidebar: () => void;
  setLeftSidebarOpen: (isOpen: boolean) => void;
  setRightSidebarOpen: (isOpen: boolean) => void;
  setLeftSidebarTab: (tab: 'explorer' | 'browser' | 'inbox') => void;
  setSidebarActiveTab: (tabId: string | null) => void;
  setActiveTabRegion: (region: 'main' | 'sidebar') => void;
}

export function findExistingAgentTabIdForCreateRequest(
  state: LayoutState,
  request: Pick<AgentTabCreateRequestedEvent, 'agentId'>,
): string | null {
  const existingTab = state.tabs[request.agentId];
  if (!existingTab || !isAgentTab(existingTab)) {
    return null;
  }
  return existingTab.id;
}

export function useLayoutIpcListeners({
  stateRef,
  workspacePath,
  openFile,
  refreshTab,
  closeTab,
  setActiveTab,
  openNewTab,
  openSettings,
  openAgentSessionTab,
  splitPaneAction,
  openBrowserRef,
  closeTabByBrowserIdRef,
  toggleLeftSidebar,
  toggleRightSidebar,
  setLeftSidebarOpen,
  setRightSidebarOpen,
  setLeftSidebarTab,
  setSidebarActiveTab,
  setActiveTabRegion,
}: UseLayoutIpcListenersArgs): void {
  "use no memo";

  // Listen for file refresh events from IPC
  useEffect(() => {
    const unsubscribe = filesIpc.onRefreshed((event: { filePath: string }) => {
      refreshTab(event.filePath);
    });
    return unsubscribe;
  }, [refreshTab]);

  // Listen for browser tab events
  useEffect(() => {
    const unsub1 = browserIpc.onTabCreated((event: { browserId: string; url: string }) => {
      openBrowserRef.current?.(event.url, undefined, event.browserId);
    });
    const unsub2 = browserIpc.onTabClosed((event: { browserId: string }) => {
      closeTabByBrowserIdRef.current?.(event.browserId);
    });
    return () => { unsub1(); unsub2(); };
  }, [openBrowserRef, closeTabByBrowserIdRef]);

  // Tab navigation (Menu Shortcuts): CMD+W, CMD+T, CMD+Shift+], CMD+Shift+[, CMD+1-9
  useEffect(() => {
    const unsubs: (() => void)[] = [];

    const activateTabById = (tabId: string) => {
      const entry = findTabNavigationEntry(stateRef.current, tabId);
      if (!entry) return;

      if (entry.region === 'sidebar') {
        setRightSidebarOpen(true);
        setSidebarActiveTab(tabId);
        setActiveTabRegion('sidebar');
        return;
      }

      setActiveTab(tabId);
    };

    // CMD+W: Close active tab
    unsubs.push(tabsIpc.onClose(() => {
      trackShortcutInvoked({ shortcut: 'CmdOrCtrl+W', action: 'close_tab', source: 'menu' });
      const activeTarget = resolveActiveTabTarget(stateRef.current);
      if (activeTarget.activeTabId) closeTab(activeTarget.activeTabId);
    }));

    // CMD+T: New tab
    unsubs.push(tabsIpc.onNew(() => {
      trackShortcutInvoked({ shortcut: 'CmdOrCtrl+T', action: 'new_tab', source: 'menu' });
      openNewTab();
    }));

    // CMD+Shift+]: Next tab
    unsubs.push(tabsIpc.onNext(() => {
      trackShortcutInvoked({ shortcut: 'CmdOrCtrl+Shift+]', action: 'next_tab', source: 'menu' });
      const orderedTabs = getOrderedTabEntries(stateRef.current);
      if (orderedTabs.length === 0) return;

      const activeTarget = resolveActiveTabTarget(stateRef.current);
      const currentIndex = orderedTabs.findIndex((entry) => entry.tabId === activeTarget.activeTabId);
      const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % orderedTabs.length;
      activateTabById(orderedTabs[nextIndex].tabId);
    }));

    // CMD+Shift+[: Previous tab
    unsubs.push(tabsIpc.onPrevious(() => {
      trackShortcutInvoked({ shortcut: 'CmdOrCtrl+Shift+[', action: 'previous_tab', source: 'menu' });
      const orderedTabs = getOrderedTabEntries(stateRef.current);
      if (orderedTabs.length === 0) return;

      const activeTarget = resolveActiveTabTarget(stateRef.current);
      const currentIndex = orderedTabs.findIndex((entry) => entry.tabId === activeTarget.activeTabId);
      const previousIndex = currentIndex <= 0 ? orderedTabs.length - 1 : currentIndex - 1;
      activateTabById(orderedTabs[previousIndex].tabId);
    }));

    // CMD+1-9: Go to specific tab across the combined main + sidebar tab order
    unsubs.push(tabsIpc.onGoTo((index: number) => {
      trackShortcutInvoked({ shortcut: `CmdOrCtrl+${index + 1}`, action: 'go_to_tab', source: 'menu' });
      const orderedTabs = getOrderedTabEntries(stateRef.current);
      if (orderedTabs.length === 0) return;

      const targetIndex = index === -1 ? orderedTabs.length - 1 : index;
      if (targetIndex >= 0 && targetIndex < orderedTabs.length) {
        activateTabById(orderedTabs[targetIndex].tabId);
      }
    }));

    return () => unsubs.forEach(u => u());
  }, [
    stateRef,
    closeTab,
    openNewTab,
    setActiveTab,
    setActiveTabRegion,
    setRightSidebarOpen,
    setSidebarActiveTab,
  ]);

  // Quick Actions: CMD+K (Quick Open), CMD+E (Toggle Explorer), CMD+L (Toggle Agent), CMD+N (New Agent), CMD+Shift+I (Open Inbox)
  useEffect(() => {
    const unsubscribe = quickActionsIpc.onQuickOpen(() => {
      trackShortcutInvoked({ shortcut: 'CmdOrCtrl+K', action: 'quick_open', source: 'menu' });
      const s = stateRef.current;
      const explorerSearch = document.querySelector('[data-explorer-search="true"]');
      const isSearchFocused = explorerSearch && document.activeElement === explorerSearch;

      if (s.leftSidebar.isOpen && isSearchFocused) {
        setLeftSidebarOpen(false);
      } else if (s.leftSidebar.isOpen) {
        setLeftSidebarTab('explorer');
        window.dispatchEvent(new CustomEvent('focus-explorer-search'));
      } else {
        setLeftSidebarOpen(true);
        setLeftSidebarTab('explorer');
        window.dispatchEvent(new CustomEvent('focus-explorer-search'));
      }
    });
    return unsubscribe;
  }, [stateRef, setLeftSidebarOpen, setLeftSidebarTab]);

  // NOTE(victor): Only close if already showing the explorer tab. If the sidebar is open
  // on a different tab (e.g. inbox), switch to explorer instead of closing -- closing would
  // force a double-press to reach the intended view, which feels broken.
  useEffect(() => {
    const unsubscribe = quickActionsIpc.onToggleExplorer(() => {
      trackShortcutInvoked({ shortcut: 'CmdOrCtrl+E', action: 'toggle_explorer', source: 'menu' });
      const s = stateRef.current;
      if (s.leftSidebar.isOpen && s.leftSidebar.activeTab === 'explorer') {
        setLeftSidebarOpen(false);
      } else {
        setLeftSidebarOpen(true);
        setLeftSidebarTab('explorer');
      }
    });
    return unsubscribe;
  }, [stateRef, setLeftSidebarOpen, setLeftSidebarTab]);

  // The right sidebar only hosts pinned agents, so the shortcut is a plain toggle.
  useEffect(() => {
    const unsubscribe = quickActionsIpc.onFocusAgent(() => {
      trackShortcutInvoked({ shortcut: 'CmdOrCtrl+L', action: 'focus_agent', source: 'menu' });
      const s = stateRef.current;
      if (s.rightSidebar.isOpen) {
        setRightSidebarOpen(false);
      } else {
        setRightSidebarOpen(true);
        if ((s.sidebarPane?.tabIds.length ?? 0) > 0) {
          setActiveTabRegion('sidebar');
        }
        focusComposer();
      }
    });
    return unsubscribe;
  }, [stateRef, setActiveTabRegion, setRightSidebarOpen]);

  useEffect(() => {
    const unsubscribe = quickActionsIpc.onOpenInbox(() => {
      trackShortcutInvoked({ shortcut: 'CmdOrCtrl+Shift+I', action: 'open_inbox', source: 'menu' });
      setLeftSidebarOpen(true);
      setLeftSidebarTab('inbox');
    });
    return unsubscribe;
  }, [setLeftSidebarOpen, setLeftSidebarTab]);

  // CMD+, : Open Settings
  useEffect(() => {
    const unsubscribe = quickActionsIpc.onOpenSettings(() => {
      trackShortcutInvoked({ shortcut: 'CmdOrCtrl+,', action: 'open_settings', source: 'menu' });
      openSettings();
    });
    return unsubscribe;
  }, [openSettings]);

  // Workspace file changes (delete → close tab)
  useEffect(() => {
    if (!workspacePath) return;
    const unsubscribe = workspaceIpc.onFilesChanged((event: { eventType: string; path?: string }) => {
      if (event.eventType === 'unlink' && event.path) {
        const fullPath = pathJoin(workspacePath, event.path);
        const tab = findTabByPath(stateRef.current.tabs, fullPath);
        if (tab) closeTab(tab.id);
      }
    });
    return unsubscribe;
  }, [stateRef, workspacePath, closeTab]);

  // Pane file drop events
  useEffect(() => {
    const handler = (e: CustomEvent) => {
      const { filePath, paneId } = e.detail;
      if (filePath) openFile(filePath, paneId);
    };
    window.addEventListener('pane:file-drop', handler as EventListener);
    return () => window.removeEventListener('pane:file-drop', handler as EventListener);
  }, [openFile]);

  // Pane file split events (file dropped on edge of a pane → open in new split)
  useEffect(() => {
    const directionMap: Record<string, 'horizontal' | 'vertical'> = {
      left: 'horizontal', right: 'horizontal', top: 'vertical', bottom: 'vertical',
    };
    const positionMap: Record<string, 'before' | 'after'> = {
      left: 'before', right: 'after', top: 'before', bottom: 'after',
    };

    const handler = (e: CustomEvent) => {
      const { filePath, paneId, zone } = e.detail;
      if (!filePath || !paneId || !zone) return;

      const direction = directionMap[zone];
      const position = positionMap[zone];
      if (!direction || !position) return;

      // Split the pane first, then open the file in the new pane
      const newPaneId = splitPaneAction(paneId, direction, position);
      if (newPaneId) {
        openFile(filePath, newPaneId);
      }
    };
    window.addEventListener('pane:file-split', handler as EventListener);
    return () => window.removeEventListener('pane:file-split', handler as EventListener);
  }, [openFile, splitPaneAction]);

  // Workstation control IPC
  useEffect(() => {
    const unsubs: (() => void)[] = [];

    unsubs.push(workstationIpc.onOpenFile((event: { path: string; page?: number; origin?: 'external-file-open' }) => {
      openFile(event.path, undefined, event.page);

      if (event.origin === 'external-file-open') {
        openNewTab();
        setTimeout(() => {
          focusComposer();
        }, 150);
      }
    }));

    unsubs.push(workstationIpc.onOpenUrl((event: { url: string; browserId?: string }) => {
      openBrowserRef.current?.(event.url, undefined, event.browserId);
    }));

    unsubs.push(workstationIpc.onCloseTab((event: { id?: string; tabId?: string; path?: string; browserId?: string }) => {
      const s = stateRef.current;
      const id = event.tabId || event.id;
      const pathId = event.path || event.id;
      const browserId = event.browserId || event.id;

      let tabId: string | null = null;
      if (id && s.tabs[id]) tabId = id;
      if (!tabId && pathId) { const t = findTabByPath(s.tabs, pathId); if (t) tabId = t.id; }
      if (!tabId && browserId) { const t = findTabByBrowserId(s.tabs, browserId); if (t) tabId = t.id; }
      if (tabId) closeTab(tabId);
    }));

    unsubs.push(workstationIpc.onFocusTab((event: { id?: string; tabId?: string; path?: string; browserId?: string }) => {
      const s = stateRef.current;
      const id = event.tabId || event.id;
      const pathId = event.path || event.id;
      const browserId = event.browserId || event.id;

      let tabId: string | null = null;
      if (id && s.tabs[id]) tabId = id;
      if (!tabId && pathId) { const t = findTabByPath(s.tabs, pathId); if (t) tabId = t.id; }
      if (!tabId && browserId) { const t = findTabByBrowserId(s.tabs, browserId); if (t) tabId = t.id; }
      if (tabId) setActiveTab(tabId);
    }));

    unsubs.push(workstationIpc.onToggleSidebar((event: { side: 'left' | 'right'; open?: boolean }) => {
      if (event.side === 'left') {
        event.open !== undefined ? setLeftSidebarOpen(event.open) : toggleLeftSidebar();
      } else {
        event.open !== undefined ? setRightSidebarOpen(event.open) : toggleRightSidebar();
      }
    }));

    return () => unsubs.forEach(u => u());
  }, [stateRef, openFile, openNewTab, openBrowserRef, closeTab, setActiveTab, toggleLeftSidebar, toggleRightSidebar, setLeftSidebarOpen, setRightSidebarOpen]);

  useEffect(() => {
    let disposed = false;
    const handledRequestIds = new Set<string>();

    const handleCreateRequested = async (request: AgentTabCreateRequestedEvent) => {
      if (disposed || handledRequestIds.has(request.requestId)) return;
      handledRequestIds.add(request.requestId);

      try {
        const existingAgentId = findExistingAgentTabIdForCreateRequest(stateRef.current, request);
        if (existingAgentId) {
          if (request.activate !== false) {
            setActiveTab(existingAgentId);
          }

          await agentTabs.created({
            requestId: request.requestId,
            agentId: existingAgentId,
          });

          console.log('[useLayoutIpcListeners] Reused existing agent tab for create request:', {
            requestId: request.requestId,
            agentId: existingAgentId,
          });
          return;
        }

        console.log('[useLayoutIpcListeners] Handling agent tab create request:', {
          requestId: request.requestId,
          agentId: request.agentId,
          activate: request.activate ?? null,
          startupId: request.startupId ?? null,
          threadId: request.threadId ?? null,
        });

        const agentId = openAgentSessionTab({
          agentId: request.agentId,
          label: request.channelLabel || 'Agent',
          requestId: request.requestId,
          startupId: request.startupId,
          initialMessage: request.initialMessage,
          threadId: request.threadId,
          callerToken: request.callerToken,
          workspacePath: request.workspacePath,
          modelConfig: request.modelConfig,
          systemPrompt: request.systemPrompt,
          agentChannel: request.channel,
          agentChannelThreadId: request.channelThreadId,
          activate: request.activate,
        });

        await agentTabs.created({
          requestId: request.requestId,
          agentId,
        });

        console.log('[useLayoutIpcListeners] Acknowledged agent tab create request:', {
          requestId: request.requestId,
          agentId,
        });
      } catch (error) {
        handledRequestIds.delete(request.requestId);
        console.error('[useLayoutIpcListeners] Failed to create agent tab from request:', {
          requestId: request.requestId,
          error,
        });
      }
    };

    const unsubscribe = agentTabs.onCreateRequested((request: AgentTabCreateRequestedEvent) => {
      console.log('[useLayoutIpcListeners] Received agent-tab:create-requested event:', {
        requestId: request.requestId,
        agentId: request.agentId,
      });
      void handleCreateRequested(request);
    });

    void agentTabs.getPending()
      .then(({ requests }: AgentTabGetPendingResponse) => {
        console.log('[useLayoutIpcListeners] Loaded pending agent tab requests:', {
          count: requests.length,
        });
        return Promise.all(requests.map(async (request: AgentTabCreateRequestedEvent) => {
        console.log('[useLayoutIpcListeners] Replaying pending agent tab request:', {
          requestId: request.requestId,
          agentId: request.agentId,
        });
        await handleCreateRequested(request);
        }));
      })
      .catch((error: unknown) => {
        console.error('[useLayoutIpcListeners] Failed to load pending agent tab requests:', error);
      });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [openAgentSessionTab, setActiveTab, stateRef]);

  useEffect(() => {
    const handleOpenConversation = (event: Event) => {
      const { conversationId, threadId, agentId, profileId, title, workspacePath: conversationWorkspacePath } =
        (event as CustomEvent<{
          conversationId: string;
          threadId?: string;
          agentId: string;
          profileId: string;
          title: string;
          workspacePath?: string;
        }>).detail;

      if (stateRef.current.tabs[agentId]) {
        setActiveTab(agentId);
        return;
      }

      openAgentSessionTab({
        agentId,
        label: title,
        conversationId,
        threadId,
        workspacePath: conversationWorkspacePath,
        modelConfig: profileId ? { ...getDefaultModelConfig(), profileId } : undefined,
      });
    };

    const handleHelpPanelSend = (event: Event) => {
      const { message } = (event as CustomEvent<{ message: string }>).detail;
      openAgentSessionTab({
        label: message.slice(0, 30) || tr('common.newAgent'),
        requestId: `help-panel-${Date.now()}`,
        initialMessage: message,
      });
    };

    window.addEventListener('conversation-history:open', handleOpenConversation as EventListener);
    window.addEventListener('help-panel:send-to-agent', handleHelpPanelSend as EventListener);

    return () => {
      window.removeEventListener('conversation-history:open', handleOpenConversation as EventListener);
      window.removeEventListener('help-panel:send-to-agent', handleHelpPanelSend as EventListener);
    };
  }, [openAgentSessionTab, setActiveTab, stateRef]);

  // NOTE(victor): Must be the LAST useEffect -- React fires effects in declaration order,
  // so all IPC listeners above are guaranteed registered before this signal is sent.
  useEffect(() => {
    signalRendererReady();
  }, []);
}
