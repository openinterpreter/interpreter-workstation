/**
 * useTabOpeners Hook
 *
 * Tab-type-specific opening logic extracted from LayoutContext:
 * fetchThumbnailForTab, openFile (with .webloc handling + dedup), refreshTab,
 * openNewTab, openBrowser, closeTabByBrowserId, updateBrowserTabLabel,
 * openEmail (with dedup), openSettings (with dedup), toggleSettings,
 * openAgentTab, openAgentSessionTab.
 *
 * Owns openBrowserRef and closeTabByBrowserIdRef.
 *
 * NOTE: openNewTab creates an empty agent tab in the editor.
 */

import { useCallback, useEffect, useRef } from 'react';
import { tr } from '../i18n';
import { trackNewChat, trackSettingsOpened } from '@/utils/telemetry';
import { recordFileOpenActivity } from '../api';
import { focusComposer } from '../../agent/utils/focusComposer';
import type { LayoutState } from '../../shared/types/layout';
import {
  createFileTab,
  createFolderTab,
  createBrowserTab,
  createEmailTab,
  createChatTab,
  createSettingsTab,
  createTerminalEditorTab,
  createEmptyAgentTab,
  createAgentTab,
  createConfiguredAgentTab,
  findTabByPath,
  findFolderTabByPath,
  findTabByBrowserId,
  findTabByEmailId,
  findTabByChatThreadId,
  findSettingsTab,
} from '../utils/layoutHelpers';
import {
  findPaneById,
  findPaneByTabId,
  getAllPanes,
  addTabToPane,
  setActiveTabInPane,
  splitPane,
  updatePane,
} from '../utils/treeOperations';
import { appendSidebarPaneTab } from '../utils/sidebarPane';
import { getFileThumbnails } from '@/ipc';
import type { AgentModelConfig } from '../../shared/types/model';
import type { MessagingChannel } from '../../shared/types/messaging';
import { getPreviewThumbnailData } from '../utils/fileThumbnail';

interface UseTabOpenersArgs {
  updateState: (updater: (prev: LayoutState) => LayoutState) => void;
  stateRef: React.MutableRefObject<LayoutState>;
  getActivePane: (paneId?: string) => string;
  closeTab: (tabId: string) => void;
  workspacePath: string | null;
  getDefaultAgentModelConfig: () => AgentModelConfig;
  getFastAgentModelConfig: () => AgentModelConfig | null;
}

export function useTabOpeners({
  updateState,
  stateRef,
  getActivePane,
  closeTab,
  workspacePath,
  getDefaultAgentModelConfig,
  getFastAgentModelConfig,
}: UseTabOpenersArgs) {
  const openBrowserRef = useRef<((url: string, paneId?: string, browserId?: string) => void) | null>(null);
  const closeTabByBrowserIdRef = useRef<((browserId: string) => void) | null>(null);

  const fetchThumbnailForTab = useCallback(async (tabId: string, filePath: string) => {
    try {
      const { thumbnails } = await getFileThumbnails([filePath]);
      const previewThumbnail = getPreviewThumbnailData(thumbnails[filePath]);
      if (previewThumbnail) {
        updateState(prev => ({
          ...prev,
          tabs: { ...prev.tabs, [tabId]: { ...prev.tabs[tabId], thumbnail: previewThumbnail.dataUrl } },
        }));
      }
    } catch (error) {
      console.error('[LayoutContext] Failed to fetch thumbnail:', error);
    }
  }, [updateState]);

  const openFolder = useCallback((path: string, paneId?: string) => {
    if (typeof window !== 'undefined' && !window.electron?.files?.listDirectory) {
      return '';
    }

    let nextTabId = '';
    updateState(prev => {
      const existingTab = findFolderTabByPath(prev.tabs, path);
      if (existingTab) {
        const pane = findPaneByTabId(prev.tree, existingTab.id);
        if (pane) {
          nextTabId = existingTab.id;
          return {
            ...prev,
            tree: setActiveTabInPane(prev.tree, pane.id, existingTab.id),
            activePaneId: pane.id,
            activeTabRegion: 'main',
          };
        }
      }

      const newTab = createFolderTab(path);
      nextTabId = newTab.id;
      const targetPaneId = getActivePane(paneId);
      return {
        ...prev,
        tabs: { ...prev.tabs, [newTab.id]: newTab },
        tree: addTabToPane(prev.tree, targetPaneId, newTab.id),
        activePaneId: targetPaneId,
        activeTabRegion: 'main',
      };
    });
    return nextTabId;
  }, [getActivePane, updateState]);

  const openFile = useCallback((path: string, paneId?: string, page?: number) => {
    // Record the file open for the new-tab suggestion signals (best-effort, non-blocking).
    void recordFileOpenActivity(path);

    // Handle .webloc bookmark files
    if (path.endsWith('.webloc')) {
      fetch(`file://${path}`)
        .then(res => res.text())
        .then(content => {
          let bookmarkData: { URL?: string } = {};
          try {
            bookmarkData = JSON.parse(content);
          } catch {}
          if (bookmarkData.URL) {
            openBrowserRef.current?.(bookmarkData.URL, paneId);
          }
        })
        .catch(() => {});
      return;
    }

    let newTabId: string | null = null;

    updateState(prev => {
      // Check if file is already open in any pane
      const existingTab = findTabByPath(prev.tabs, path);
      if (existingTab) {
        // Activate the existing tab in its pane
        const pane = findPaneByTabId(prev.tree, existingTab.id);
        if (pane) {
          const updatedTab = page != null ? { ...existingTab, pdfPage: page } : existingTab;
          return {
            ...prev,
            tabs: { ...prev.tabs, [updatedTab.id]: updatedTab },
            tree: setActiveTabInPane(prev.tree, pane.id, existingTab.id),
            activePaneId: pane.id,
            activeTabRegion: 'main',
          };
        }
      }

      // Create new tab
      const newTab = createFileTab(path);
      if (page != null) newTab.pdfPage = page;
      newTabId = newTab.id;
      const targetPaneId = getActivePane(paneId);

      return {
        ...prev,
        tabs: { ...prev.tabs, [newTab.id]: newTab },
        tree: addTabToPane(prev.tree, targetPaneId, newTab.id),
        activePaneId: targetPaneId,
        activeTabRegion: 'main',
      };
    });

    if (newTabId) fetchThumbnailForTab(newTabId, path);
  }, [fetchThumbnailForTab, getActivePane, updateState]);

  // NOTE(victor): Debounce per path so bursty refresh events do not remount a viewer twice.
  const refreshTimestampsRef = useRef<Map<string, number>>(new Map());
  const refreshTab = useCallback((path: string) => {
    const now = Date.now();
    const timestamps = refreshTimestampsRef.current;
    const last = timestamps.get(path) || 0;
    if (now - last < 300) return;
    if (timestamps.size > 50) timestamps.clear();
    timestamps.set(path, now);

    updateState(prev => {
      const tab = findTabByPath(prev.tabs, path);
      if (!tab) return prev;
      return {
        ...prev,
        tabs: { ...prev.tabs, [tab.id]: { ...tab, refreshKey: (tab.refreshKey || 0) + 1 } },
      };
    });
  }, [updateState]);

  const openNewTab = useCallback((paneId?: string) => {
    let newTabId = '';
    trackNewChat();
    updateState(prev => {
      const newTab = createEmptyAgentTab(getDefaultAgentModelConfig(), {
        workspacePath: workspacePath ?? undefined,
      });
      newTabId = newTab.id;
      const targetPaneId = getActivePane(paneId);
      return {
        ...prev,
        tabs: { ...prev.tabs, [newTab.id]: newTab },
        tree: addTabToPane(prev.tree, targetPaneId, newTab.id),
        activePaneId: targetPaneId,
        activeTabRegion: 'main',
      };
    });
    if (newTabId) {
      focusComposer({ agentId: newTabId, delay: 0 });
    }
    return newTabId;
  }, [getActivePane, getDefaultAgentModelConfig, updateState, workspacePath]);

  const openSeededAgentTab = useCallback((
    initialMessage: string,
    options?: { paneId?: string; preferFastProfile?: boolean },
  ) => {
    let newTabId = '';
    trackNewChat();
    updateState(prev => {
      const modelConfig = options?.preferFastProfile
        ? getFastAgentModelConfig() ?? getDefaultAgentModelConfig()
        : getDefaultAgentModelConfig();
      const newTab = createConfiguredAgentTab({
        label: tr('common.newAgent'),
        modelConfig,
        workspacePath: workspacePath ?? undefined,
        initialMessage,
        requestId: crypto.randomUUID(),
      });
      newTabId = newTab.id;
      const targetPaneId = getActivePane(options?.paneId);
      return {
        ...prev,
        tabs: { ...prev.tabs, [newTab.id]: newTab },
        tree: addTabToPane(prev.tree, targetPaneId, newTab.id),
        activePaneId: targetPaneId,
        activeTabRegion: 'main',
      };
    });
    return newTabId;
  }, [getActivePane, getDefaultAgentModelConfig, getFastAgentModelConfig, updateState, workspacePath]);

  const openBrowser = useCallback((url: string, paneId?: string, browserId?: string) => {
    updateState(prev => {
      const newTab = createBrowserTab(url, browserId);
      const targetPaneId = getActivePane(paneId);
      return {
        ...prev,
        tabs: { ...prev.tabs, [newTab.id]: newTab },
        tree: addTabToPane(prev.tree, targetPaneId, newTab.id),
        activePaneId: targetPaneId,
        activeTabRegion: 'main',
      };
    });
  }, [getActivePane, updateState]);

  useEffect(() => {
    openBrowserRef.current = openBrowser;
  }, [openBrowser]);

  const closeTabByBrowserId = useCallback((browserId: string) => {
    const tab = findTabByBrowserId(stateRef.current.tabs, browserId);
    if (tab) closeTab(tab.id);
  }, [stateRef, closeTab]);

  useEffect(() => {
    closeTabByBrowserIdRef.current = closeTabByBrowserId;
  }, [closeTabByBrowserId]);

  const updateBrowserTabLabel = useCallback((tabId: string, label: string) => {
    updateState(prev => {
      const tab = prev.tabs[tabId];
      if (!tab) return prev;
      return { ...prev, tabs: { ...prev.tabs, [tabId]: { ...tab, label } } };
    });
  }, [updateState]);

  const openEmail = useCallback((emailId: string, subject: string, paneId?: string) => {
    updateState(prev => {
      const existing = findTabByEmailId(prev.tabs, emailId);
      if (existing) {
        const pane = findPaneByTabId(prev.tree, existing.id);
        if (pane) {
          return {
            ...prev,
            tree: setActiveTabInPane(prev.tree, pane.id, existing.id),
            activePaneId: pane.id,
            activeTabRegion: 'main',
          };
        }
      }
      const newTab = createEmailTab(emailId, subject);
      const targetPaneId = getActivePane(paneId);
      return {
        ...prev,
        tabs: { ...prev.tabs, [newTab.id]: newTab },
        tree: addTabToPane(prev.tree, targetPaneId, newTab.id),
        activePaneId: targetPaneId,
        activeTabRegion: 'main',
      };
    });
  }, [getActivePane, updateState]);

  const openChat = useCallback((threadId: string, channel: MessagingChannel, label: string, paneId?: string) => {
    updateState(prev => {
      const existing = findTabByChatThreadId(prev.tabs, threadId);
      if (existing) {
        const pane = findPaneByTabId(prev.tree, existing.id);
        if (pane) {
          return {
            ...prev,
            tree: setActiveTabInPane(prev.tree, pane.id, existing.id),
            activePaneId: pane.id,
            activeTabRegion: 'main',
          };
        }
      }
      const newTab = createChatTab(threadId, channel, label);
      let targetPaneId = getActivePane(paneId);

      // NOTE(victor): #574 -- opening a chat while Settings is the active tab
      // injected the chat into the settings pane, visually overlaying settings.
      // Route to an alternate pane or split so settings stays undisturbed.
      const targetPane = findPaneById(prev.tree, targetPaneId);
      if (targetPane && targetPane.activeTabId && prev.tabs[targetPane.activeTabId]?.type === 'settings') {
        const alt = getAllPanes(prev.tree).find(p => p.id !== targetPaneId);
        if (alt) {
          targetPaneId = alt.id;
        } else {
          const result = splitPane(prev.tree, targetPaneId, 'horizontal', 'after');
          if (result.newPaneId) {
            return {
              ...prev,
              tabs: { ...prev.tabs, [newTab.id]: newTab },
              tree: addTabToPane(result.tree, result.newPaneId, newTab.id),
              activePaneId: result.newPaneId,
              activeTabRegion: 'main',
            };
          }
        }
      }

      return {
        ...prev,
        tabs: { ...prev.tabs, [newTab.id]: newTab },
        tree: addTabToPane(prev.tree, targetPaneId, newTab.id),
        activePaneId: targetPaneId,
        activeTabRegion: 'main',
      };
    });
  }, [updateState, getActivePane]);

  const openSettings = useCallback((paneId?: string, section?: string) => {
    trackSettingsOpened(section);
    updateState(prev => {
      const existing = findSettingsTab(prev.tabs);
      if (existing) {
        const pane = findPaneByTabId(prev.tree, existing.id);
        if (pane) {
          const tabs = section
            ? { ...prev.tabs, [existing.id]: { ...existing, settingsSection: section } }
            : prev.tabs;
          return {
            ...prev,
            tabs,
            tree: setActiveTabInPane(prev.tree, pane.id, existing.id),
            activePaneId: pane.id,
            activeTabRegion: 'main',
          };
        }
      }
      const newTab = createSettingsTab(section);
      const targetPaneId = getActivePane(paneId);
      return {
        ...prev,
        tabs: { ...prev.tabs, [newTab.id]: newTab },
        tree: addTabToPane(prev.tree, targetPaneId, newTab.id),
        activePaneId: targetPaneId,
        activeTabRegion: 'main',
      };
    });
  }, [updateState, getActivePane]);

  const toggleSettings = useCallback((paneId?: string) => {
    const existing = findSettingsTab(stateRef.current.tabs);
    if (existing) closeTab(existing.id);
    else openSettings(paneId);
  }, [stateRef, closeTab, openSettings]);

  const openAgentTab = useCallback((
    agentTabId: string,
    label: string,
    extra?: { terminalAgent?: string; modelConfig?: AgentModelConfig; cwd?: string; workspacePath?: string },
    paneId?: string,
  ) => {
    let newTabId = '';
    updateState(prev => {
      const newTab = extra?.terminalAgent
        ? createTerminalEditorTab(agentTabId, label, {
            terminalAgent: extra.terminalAgent,
            modelConfig: extra?.modelConfig,
            cwd: extra?.cwd,
          })
        : createEmptyAgentTab(
            extra?.modelConfig ?? getDefaultAgentModelConfig(),
            { workspacePath: extra?.workspacePath ?? workspacePath ?? undefined },
          );
      newTabId = newTab.id;

      if (paneId === 'sidebar') {
        return {
          ...prev,
          tabs: { ...prev.tabs, [newTab.id]: newTab },
          sidebarPane: appendSidebarPaneTab(prev.sidebarPane, newTab.id),
          rightSidebar: { ...prev.rightSidebar, isOpen: true },
          activeTabRegion: 'sidebar',
        };
      }

      const targetPaneId = getActivePane(paneId);
      return {
        ...prev,
        tabs: { ...prev.tabs, [newTab.id]: newTab },
        tree: addTabToPane(prev.tree, targetPaneId, newTab.id),
        activePaneId: targetPaneId,
        activeTabRegion: 'main',
      };
    });
    if (newTabId && !extra?.terminalAgent) {
      focusComposer({ agentId: newTabId, delay: 0 });
    }
  }, [getActivePane, getDefaultAgentModelConfig, updateState, workspacePath]);

  const openAgentSessionTab = useCallback((options: {
    agentId?: string;
    label?: string;
    requestId?: string;
    startupId?: string;
    initialMessage?: string;
    conversationId?: string;
    threadId?: string;
    callerToken?: string;
    workspacePath?: string;
    modelConfig?: AgentModelConfig;
    systemPrompt?: string;
    agentChannel?: MessagingChannel;
    agentChannelThreadId?: string;
    activate?: boolean;
    paneId?: string;
  }): string => {
    let nextAgentId = options.agentId ?? '';
    const shouldFocusComposer = options.activate !== false
      && !options.initialMessage
      && !options.startupId
      && !options.conversationId
      && !options.threadId;

    updateState(prev => {
      const targetPaneId = getActivePane(options.paneId);
      const nextTab = createConfiguredAgentTab({
        id: options.agentId,
        label: options.label ?? 'Agent',
        modelConfig: options.modelConfig ?? getDefaultAgentModelConfig(),
        workspacePath: options.workspacePath ?? workspacePath ?? undefined,
        systemPrompt: options.systemPrompt,
        startupId: options.startupId,
        requestId: options.startupId ? undefined : options.requestId,
        initialMessage: options.startupId ? undefined : options.initialMessage,
        conversationId: options.conversationId,
        codexThreadId: options.threadId,
        callerToken: options.callerToken,
        agentChannel: options.agentChannel,
        agentChannelThreadId: options.agentChannelThreadId,
      });
      nextAgentId = nextTab.id;

      if (options.activate === false) {
        return {
          ...prev,
          tabs: { ...prev.tabs, [nextTab.id]: nextTab },
          tree: updatePane(prev.tree, targetPaneId, pane => ({
            ...pane,
            tabIds: [...pane.tabIds, nextTab.id],
            activeTabId: pane.activeTabId ?? nextTab.id,
          })),
        };
      }

      return {
        ...prev,
        tabs: { ...prev.tabs, [nextTab.id]: nextTab },
        tree: addTabToPane(prev.tree, targetPaneId, nextTab.id),
        activePaneId: targetPaneId,
        activeTabRegion: 'main',
      };
    });

    if (nextAgentId && shouldFocusComposer) {
      focusComposer({ agentId: nextAgentId, delay: 0 });
    }

    return nextAgentId;
  }, [getActivePane, getDefaultAgentModelConfig, updateState, workspacePath]);

  const morphNewTabToAgent = useCallback((
    oldTabId: string,
    initialMessage: string,
    modelConfig: AgentModelConfig,
  ) => {
    console.log('[useTabOpeners] morphNewTabToAgent called', {
      oldTabId,
      messageLen: initialMessage.length,
      provider: modelConfig.provider,
      modelId: modelConfig.modelId,
      apiFormat: modelConfig.apiFormat,
      baseURL: modelConfig.baseURL,
      hasApiKey: !!modelConfig.apiKey,
    });
    updateState(prev => {
      const oldTab = prev.tabs[oldTabId];
      if (!oldTab || oldTab.type !== 'agent') {
        console.error('[useTabOpeners] morphNewTabToAgent FAILED: tab not found or not agent type', { oldTabId, oldTab: oldTab ? { type: oldTab.type, id: oldTab.id } : null, availableTabIds: Object.keys(prev.tabs) });
        return prev;
      }

      const pane = findPaneByTabId(prev.tree, oldTabId);
      if (!pane) {
        console.error('[useTabOpeners] morphNewTabToAgent FAILED: pane not found for tab', { oldTabId });
        return prev;
      }

      console.log('[useTabOpeners] morphNewTabToAgent creating agent tab', { oldTabId, paneId: pane.id });
      const newTab = createAgentTab(initialMessage, modelConfig, {
        morphTransition: true,
        workspacePath: workspacePath ?? undefined,
      });

      // Swap the tab in the pane's tabIds at the same index
      const idx = pane.tabIds.indexOf(oldTabId);
      const newTabIds = [...pane.tabIds];
      newTabIds[idx] = newTab.id;

      const tree = updatePane(prev.tree, pane.id, p => ({
        ...p,
        tabIds: newTabIds,
        activeTabId: p.activeTabId === oldTabId ? newTab.id : p.activeTabId,
      }));

      // Remove old tab, add new tab to registry
      const tabs = { ...prev.tabs };
      delete tabs[oldTabId];
      tabs[newTab.id] = newTab;

      console.log('[useTabOpeners] morphNewTabToAgent SUCCESS: swapped tab', { oldTabId, newTabId: newTab.id });
      return { ...prev, tree, tabs };
    });
  }, [updateState, workspacePath]);

  return {
    fetchThumbnailForTab,
    openFile,
    refreshTab,
    openNewTab,
    openSeededAgentTab,
    openFolder,
    openBrowser,
    closeTabByBrowserId,
    updateBrowserTabLabel,
    openEmail,
    openChat,
    openSettings,
    toggleSettings,
    openAgentTab,
    openAgentSessionTab,
    morphNewTabToAgent,
    openBrowserRef,
    closeTabByBrowserIdRef,
  };
}
