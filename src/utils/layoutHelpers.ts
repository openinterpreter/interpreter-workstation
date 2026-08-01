/**
 * Layout Helper Functions
 *
 * Utility functions for the tree-based split pane layout system.
 */

import { nanoid } from 'nanoid';
import { pathBasename, pathNormalize } from '@/ipc';
import { tr } from '../i18n';
import type { AgentModelConfig } from '../../shared/types/model';
import type { MessagingChannel } from '../../shared/types/messaging';
import { getDefaultModelConfig } from '../../shared/types/profile';
import type {
  LayoutState,
  Tab,
  TabType,
  Pane,
  TreeNode,
} from '../../shared/types/layout';
import { isPane } from '../../shared/types/layout';
import { createPane, getAllPanes, getFirstPane } from './treeOperations';

// Re-export for convenience
export type { LayoutState, Tab, Pane, TreeNode, TabType };

// ============================================================================
// Tab Creators
// ============================================================================

export function getFileNameFromPath(path: string): string {
  return pathBasename(path) || path;
}

export function getLabelFromUrl(url: string): string {
  try {
    return new URL(url).hostname || 'Browser';
  } catch {
    return url.slice(0, 30) || 'Browser';
  }
}

export function createFileTab(path: string): Tab {
  return {
    id: nanoid(),
    type: 'file',
    label: getFileNameFromPath(path),
    path,
  };
}

export function createFolderTab(path: string): Tab {
  const normalizedPath = pathNormalize(path);
  return {
    id: nanoid(),
    type: 'folder',
    label: getFileNameFromPath(normalizedPath),
    path: normalizedPath,
  };
}

export function createAgentCallerToken(): string {
  return `agtok_${nanoid()}`;
}

export function createConfiguredAgentTab(options: {
  id?: string;
  label?: string;
  modelConfig: AgentModelConfig;
  workspacePath?: string;
  systemPrompt?: string;
  startupId?: string;
  requestId?: string;
  initialMessage?: string;
  conversationId?: string;
  codexThreadId?: string;
  callerToken?: string;
  agentChannel?: MessagingChannel;
  agentChannelThreadId?: string;
  createdAt?: number;
  morphTransition?: boolean;
}): Tab {
  return {
    id: options.id ?? `agent-${nanoid()}`,
    type: 'agent',
    label: options.label ?? tr('common.newAgent'),
    createdAt: options.createdAt ?? Date.now(),
    agent: {
      runtime: {
        modelConfig: options.modelConfig,
        workspacePath: options.workspacePath,
        systemPrompt: options.systemPrompt,
      },
      session: {
        startupId: options.startupId,
        requestId: options.requestId,
        initialMessage: options.initialMessage,
        conversationId: options.conversationId,
        codexThreadId: options.codexThreadId,
        callerToken: options.callerToken ?? createAgentCallerToken(),
        agentChannel: options.agentChannel,
        agentChannelThreadId: options.agentChannelThreadId,
      },
    },
    morphTransition: options.morphTransition,
  };
}

export function createEmptyAgentTab(
  modelConfig: AgentModelConfig,
  options?: { workspacePath?: string }
): Tab {
  return createConfiguredAgentTab({
    id: `agent-${nanoid()}`,
    label: tr('common.newAgent'),
    modelConfig,
    workspacePath: options?.workspacePath,
  });
}

export function createBrowserTab(url: string, existingBrowserId?: string): Tab {
  let label = 'Browser';
  let faviconUrl: string | undefined;
  try {
    const urlObj = new URL(url);
    label = urlObj.hostname || 'Browser';
    faviconUrl = `https://www.google.com/s2/favicons?domain=${urlObj.hostname}&sz=32`;
  } catch {
    label = url.slice(0, 30) || 'Browser';
  }
  return {
    id: nanoid(),
    type: 'browser',
    label,
    url,
    browserId: existingBrowserId || crypto.randomUUID(),
    faviconUrl,
  };
}

export function createEmailTab(emailId: string, subject: string): Tab {
  return {
    id: nanoid(),
    type: 'email',
    label: subject || '(no subject)',
    emailId,
  };
}

export function createChatTab(threadId: string, channel: MessagingChannel, label: string): Tab {
  return {
    id: nanoid(),
    type: 'chat',
    label,
    chatThreadId: threadId,
    chatChannel: channel,
  };
}

export function createSettingsTab(section?: string): Tab {
  return {
    id: nanoid(),
    type: 'settings',
    label: 'Settings',
    settingsSection: section,
  };
}

export function createTerminalEditorTab(
  agentTabId: string,
  label: string,
  extra?: { terminalAgent?: string; modelConfig?: AgentModelConfig; cwd?: string },
): Tab {
  return {
    id: nanoid(),
    type: 'terminal',
    label,
    agentTabId,
    terminalAgent: extra?.terminalAgent,
    modelConfig: extra?.modelConfig,
    cwd: extra?.cwd,
  };
}

export function createAgentTab(
  initialMessage: string,
  modelConfig: AgentModelConfig,
  options?: { morphTransition?: boolean; workspacePath?: string },
): Tab {
  return createConfiguredAgentTab({
    id: `agent-${Date.now()}`,
    label: 'Agent',
    modelConfig,
    workspacePath: options?.workspacePath,
    initialMessage,
    requestId: nanoid(),
    morphTransition: options?.morphTransition,
  });
}

// ============================================================================
// Registry Lookup Helpers
// ============================================================================

export function findTabByPath(tabs: Record<string, Tab>, path: string): Tab | null {
  for (const tab of Object.values(tabs)) {
    if (tab.type === 'file' && tab.path === path) return tab;
  }
  return null;
}

export function findFolderTabByPath(tabs: Record<string, Tab>, path: string): Tab | null {
  const normalizedPath = pathNormalize(path);
  for (const tab of Object.values(tabs)) {
    if (tab.type === 'folder' && tab.path === normalizedPath) return tab;
  }
  return null;
}

export function findTabByBrowserId(tabs: Record<string, Tab>, browserId: string): Tab | null {
  for (const tab of Object.values(tabs)) {
    if (tab.type === 'browser' && (tab.browserId === browserId || tab.id === browserId)) return tab;
  }
  return null;
}

export function findTabByEmailId(tabs: Record<string, Tab>, emailId: string): Tab | null {
  for (const tab of Object.values(tabs)) {
    if (tab.type === 'email' && tab.emailId === emailId) return tab;
  }
  return null;
}

export function findTabByChatThreadId(tabs: Record<string, Tab>, threadId: string): Tab | null {
  for (const tab of Object.values(tabs)) {
    if (tab.type === 'chat' && tab.chatThreadId === threadId) return tab;
  }
  return null;
}

export function findSettingsTab(tabs: Record<string, Tab>): Tab | null {
  for (const tab of Object.values(tabs)) {
    if (tab.type === 'settings') return tab;
  }
  return null;
}

// ============================================================================
// Default State
// ============================================================================

export function createDefaultLayoutState(): LayoutState {
  const agentTab = createEmptyAgentTab(getDefaultModelConfig());
  const defaultPane = createPane([agentTab.id], agentTab.id);

  return {
    version: 6,
    tree: defaultPane,
    tabs: { [agentTab.id]: agentTab },
    activePaneId: defaultPane.id,
    activeTabRegion: 'main',
    sidebarPane: null,
    sidebarWidth: 320,
    sidebarOpen: false,
    leftSidebar: {
      isOpen: false,
      width: 320,
      activeTab: 'explorer',
    },
    rightSidebar: {
      isOpen: false,
      width: 320,
    },
  };
}

// ============================================================================
// Validation & Migration
// ============================================================================

export function isValidLayoutState(state: any): state is LayoutState {
  if (!state || typeof state !== 'object') return false;
  if (state.version !== 6) return false;
  if (!state.tree || !state.tabs || !state.leftSidebar || !state.rightSidebar) return false;

  const validLeftSidebarTabs = new Set(['explorer', 'browser', 'inbox']);

  if (
    (state.activeTabRegion !== 'main' && state.activeTabRegion !== 'sidebar')
    || typeof state.leftSidebar.activeTab !== 'string'
    || !validLeftSidebarTabs.has(state.leftSidebar.activeTab)
  ) {
    return false;
  }

  const validTabTypes = new Set<TabType>([
    'file',
    'folder',
    'browser',
    'email',
    'chat',
    'settings',
    'terminal',
    'agent',
  ]);

  return Object.values(state.tabs).every((tab) => {
    if (!tab || typeof tab !== 'object') return false;

    const candidate = tab as {
      type?: unknown;
      agent?: {
        runtime?: unknown;
        session?: unknown;
      };
    };

    if (typeof candidate.type !== 'string' || !validTabTypes.has(candidate.type as TabType)) {
      return false;
    }

    if (candidate.type !== 'agent') {
      return true;
    }

    return (
      candidate.agent != null
      && typeof candidate.agent === 'object'
      && typeof candidate.agent.runtime === 'object'
      && typeof candidate.agent.session === 'object'
      && typeof (candidate.agent.session as { callerToken?: unknown }).callerToken === 'string'
    );
  });
}

export function ensureMinimumLayout(state: LayoutState): LayoutState {
  const tabs = { ...state.tabs };
  const ephemeralIds = new Set<string>();
  for (const [id, tab] of Object.entries(tabs)) {
    if (tab.type === 'terminal') {
      ephemeralIds.add(id);
      delete tabs[id];
    }
  }

  function cleanNode(node: TreeNode): TreeNode {
    if (isPane(node)) {
      const tabIds = node.tabIds.filter(id => !ephemeralIds.has(id));
      const activeTabId = (node.activeTabId && ephemeralIds.has(node.activeTabId))
        ? (tabIds[0] ?? null)
        : node.activeTabId;
      return { ...node, tabIds, activeTabId };
    }
    return { ...node, children: [cleanNode(node.children[0]), cleanNode(node.children[1])] as [TreeNode, TreeNode] };
  }

  let tree = cleanNode(state.tree);
  const allPanes = getAllPanes(tree);

  if (!allPanes.some(p => p.tabIds.length > 0)) {
    const agentTab = createEmptyAgentTab(getDefaultModelConfig());
    tabs[agentTab.id] = agentTab;
    tree = { kind: 'pane', id: getFirstPane(tree).id, tabIds: [agentTab.id], activeTabId: agentTab.id };
  }

  let sidebarPane = state.sidebarPane;
  if (sidebarPane) {
    const sTabIds = sidebarPane.tabIds.filter(id => !ephemeralIds.has(id));
    sidebarPane = sTabIds.length === 0 ? null : { ...sidebarPane, id: 'sidebar', tabIds: sTabIds, activeTabId: sTabIds.includes(sidebarPane.activeTabId!) ? sidebarPane.activeTabId : sTabIds[0] ?? null };
  }

  return {
    ...state, tree, tabs, sidebarPane,
    activePaneId: (state.activePaneId && allPanes.some(p => p.id === state.activePaneId))
      ? state.activePaneId : getFirstPane(tree).id,
    activeTabRegion: state.activeTabRegion === 'sidebar' && state.rightSidebar.isOpen && sidebarPane
      ? 'sidebar'
      : 'main',
  };
}
