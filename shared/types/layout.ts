/**
 * Layout Type Definitions
 *
 * Tree-based split pane layout system.
 * Tabs live in a flat registry. Panes reference tabs by ID.
 * Moving a tab = splice between two `tabIds` arrays.
 */

import type { AgentModelConfig } from './model';
import type { MessagingChannel } from './messaging';

// ============================================================================
// Tab Types
// ============================================================================

export type TabType = 'file' | 'folder' | 'browser' | 'email' | 'chat' | 'settings' | 'terminal' | 'agent';

/** Stateful tabs render in the PersistentLayer and never unmount */
export const STATEFUL_TAB_TYPES: Set<TabType> = new Set(['file', 'folder', 'browser', 'email', 'chat', 'settings', 'terminal', 'agent']);

/** Tabs allowed in the sidebar pane */
export const SIDEBAR_TAB_TYPES: Set<TabType> = new Set(['terminal', 'agent']);

export interface AgentTabRuntimeConfig {
  modelConfig: AgentModelConfig;
  workspacePath?: string;
  systemPrompt?: string;
  didSwitchRuntimeDuringConversation?: boolean;
}

export interface AgentTabSessionState {
  requestId?: string;
  startupId?: string;
  initialMessage?: string;
  conversationId?: string;
  codexThreadId?: string;
  callerToken: string;
  agentChannel?: MessagingChannel;
  agentChannelThreadId?: string;
}

export interface AgentTabState {
  runtime: AgentTabRuntimeConfig;
  session: AgentTabSessionState;
}

export interface Tab {
  id: string;
  type: TabType;
  label: string;

  // File / folder tab fields
  path?: string;            // Absolute file or folder path
  refreshKey?: number;
  thumbnail?: string;
  mtime?: number;
  pdfPage?: number;         // Navigate PDF to this page (1-indexed)

  // Browser tab fields
  url?: string;
  browserId?: string;
  faviconUrl?: string;

  // Email tab fields
  emailId?: string;

  // Chat tab fields (WhatsApp / Telegram)
  chatThreadId?: string;
  chatChannel?: MessagingChannel;

  // Settings tab fields
  settingsSection?: string;

  // Terminal tab fields (ephemeral - not persisted across restarts)
  agentTabId?: string;        // Links to the sidebar's terminal instance ID
  terminalAgent?: string;     // Terminal profile name (e.g. 'claude-code', 'codex')
  modelConfig?: AgentModelConfig;
  cwd?: string;               // Working directory for terminal
  createdAt?: number;         // Creation timestamp

  // Agent tab fields
  agent?: AgentTabState;

  // Morph transition (ephemeral — cleared after animation)
  morphTransition?: boolean;  // Signals fade-in for tabs created via morph

  // Voice mode auto-start (ephemeral — consumed after activation)
  autoStartVoiceMode?: boolean;
}

// ============================================================================
// Pane / Split Node Types
// ============================================================================

export interface Pane {
  kind: 'pane';
  id: string;
  tabIds: string[];
  activeTabId: string | null;
}

export interface SplitNode {
  kind: 'split';
  id: string;
  direction: 'horizontal' | 'vertical';
  ratio: number; // 0-1, position of the divider
  children: [TreeNode, TreeNode];
}

export type TreeNode = Pane | SplitNode;

export type ActiveTabRegion = 'main' | 'sidebar';

// ============================================================================
// Layout State
// ============================================================================

export interface LayoutState {
  version: number;

  // Main split tree (center panes)
  tree: TreeNode;

  // Flat tab registry - all tabs by ID
  tabs: Record<string, Tab>;

  // Active pane ID (which pane has focus)
  activePaneId: string | null;
  activeTabRegion: ActiveTabRegion;

  // Right sidebar (vertical tabs, agents only)
  sidebarPane: Pane | null;
  sidebarWidth: number;
  sidebarOpen: boolean;

  // Left sidebar (unchanged from old system)
  leftSidebar: {
    isOpen: boolean;
    width: number;
    activeTab: 'explorer' | 'browser' | 'inbox';
  };

  // Right sidebar (pinned agents only)
  rightSidebar: {
    isOpen: boolean;
    width: number;
  };
}

// ============================================================================
// Type Guards
// ============================================================================

export function isPane(node: TreeNode): node is Pane {
  return node.kind === 'pane';
}

export function isSplitNode(node: TreeNode): node is SplitNode {
  return node.kind === 'split';
}

export function isStatefulTab(tab: Tab): boolean {
  return STATEFUL_TAB_TYPES.has(tab.type);
}

export function isSidebarTab(tab: Tab): boolean {
  return SIDEBAR_TAB_TYPES.has(tab.type);
}

export function isAgentTab(tab: Tab): tab is Tab & { type: 'agent'; agent: AgentTabState } {
  return tab.type === 'agent' && tab.agent != null;
}
