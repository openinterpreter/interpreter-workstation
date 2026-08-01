/**
 * IPC Event Emitters
 *
 * Helper functions for emitting IPC events from the main process to renderer.
 * These are used by managers and other main process code to communicate with the UI.
 */

import type { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from './registry';
import type {
  ApprovalCreatedEvent,
  ApprovalResolvedEvent,
  ApprovalTimeoutEvent,
  ApprovalListChangedEvent,
  AgentTabCreateRequestedEvent,
  WorkspaceConfirmationRequestedEvent,
  WorkspaceFilesChangedEvent,
  SetupCompletedEvent,
  ComputerUseSetupRequestedEvent,
  QuestionRequest,
  PdfFillFieldEvent,
  FileRefreshedEvent,
  BrowserTabCreatedEvent,
  BrowserTabClosedEvent,
  WindowFullscreenChangedEvent,
  ToolServersChangedEvent,
  ToolServerInfo,
  WorkspaceChangedEvent,
} from './registry';
import { broadcast } from '../../server/utils/sse';
import { sendToWindow } from '../utils/safeIpcSend';

/**
 * Safely emit an event to the renderer process
 */
function emitToRenderer(window: BrowserWindow | null, channel: string, ...args: any[]): boolean {
  if (!window) return false;
  return sendToWindow(window, channel, ...args);
}

// ============================================================================
// Approval Events
// ============================================================================

/**
 * Emit approval:created event
 */
export function emitApprovalCreated(
  window: BrowserWindow | null,
  approval: QuestionRequest
): void {
  const event: ApprovalCreatedEvent = { approval };
  emitToRenderer(window, IPC_CHANNELS.APPROVAL_CREATED, event);
  broadcast('approvals:created', event);
  console.log('[IPC] Sent approval:created event:', approval.id);
}

/**
 * Emit approval:resolved event
 */
export function emitApprovalResolved(
  window: BrowserWindow | null,
  id: string,
  approved: boolean
): void {
  const event: ApprovalResolvedEvent = { id, approved };
  emitToRenderer(window, IPC_CHANNELS.APPROVAL_RESOLVED, event);
  broadcast('approvals:resolved', event);
  console.log('[IPC] Sent approval:resolved event:', id, approved);
}

/**
 * Emit approval:timeout event
 */
export function emitApprovalTimeout(window: BrowserWindow | null, id: string): void {
  const event: ApprovalTimeoutEvent = { id };
  emitToRenderer(window, IPC_CHANNELS.APPROVAL_TIMEOUT, event);
  broadcast('approvals:timeout', event);
  console.log('[IPC] Sent approval:timeout event:', id);
}

/**
 * Emit approval:list-changed event
 * This replaces the need for polling - emit whenever the approval list changes
 */
export function emitApprovalListChanged(
  window: BrowserWindow | null,
  approvals: QuestionRequest[]
): void {
  const event: ApprovalListChangedEvent = {
    count: approvals.length,
    approvals,
  };
  emitToRenderer(window, IPC_CHANNELS.APPROVAL_LIST_CHANGED, event);
  broadcast('approvals:listChanged', event);
  console.log('[IPC] Sent approval:list-changed event, count:', approvals.length);
}

// ============================================================================
// Agent Tab Events
// ============================================================================

/**
 * Emit agent-tab:create-requested event
 */
export function emitAgentTabCreateRequested(
  window: BrowserWindow | null,
  data: AgentTabCreateRequestedEvent
): void {
  emitToRenderer(window, IPC_CHANNELS.AGENT_TAB_CREATE_REQUESTED, data);
  broadcast('agentTabs:createRequested', data);
  console.log('[IPC] Sent agent-tab:create-requested event:', data.requestId);
}

// ============================================================================
// Workspace Events
// ============================================================================

/**
 * Emit workspace:confirmation-requested event
 */
export function emitWorkspaceConfirmationRequested(
  window: BrowserWindow | null,
  event: WorkspaceConfirmationRequestedEvent
): boolean {
  const sent = emitToRenderer(window, IPC_CHANNELS.WORKSPACE_CONFIRMATION_REQUESTED, event);
  if (sent) {
    console.log('[IPC] Sent workspace:confirmation-requested event:', event.requestId, event.workspacePath);
  }
  return sent;
}

/**
 * Emit workspace:changed event
 */
export function emitWorkspaceChanged(
  window: BrowserWindow | null,
  workspacePath: string | null
): void {
  const event: WorkspaceChangedEvent = { workspacePath };
  emitToRenderer(window, IPC_CHANNELS.WORKSPACE_CHANGED, event);
  broadcast('workspace:changed', event);
  console.log('[IPC] Sent workspace:changed event:', workspacePath);
}

/**
 * Emit workspace:files-changed event
 */
export function emitWorkspaceFilesChanged(
  window: BrowserWindow | null,
  eventType: 'add' | 'unlink' | 'addDir' | 'unlinkDir' | 'change',
  path?: string,
  mtime?: number
): void {
  const event: WorkspaceFilesChangedEvent = { eventType, path, mtime };
  emitToRenderer(window, IPC_CHANNELS.WORKSPACE_FILES_CHANGED, event);
  broadcast('workspace:filesChanged', event);
  console.log('[IPC] Sent workspace:files-changed event:', eventType, path);
}

// ============================================================================
// Setup Events
// ============================================================================

/**
 * Emit setup:completed event
 * Used for OAuth flow completion and other setup operations
 */
export function emitSetupCompleted(
  window: BrowserWindow | null,
  data: SetupCompletedEvent
): void {
  emitToRenderer(window, IPC_CHANNELS.SETUP_COMPLETED, data);
  broadcast('setup:completed', data);
  console.log('[IPC] Sent setup:completed event:', data.serverId);
}

export function emitComputerUseSetupRequested(
  window: BrowserWindow | null,
  data: ComputerUseSetupRequestedEvent,
): void {
  emitToRenderer(window, IPC_CHANNELS.COMPUTER_USE_SETUP_REQUESTED, data);
  broadcast('computerUseSetup:requested', data);
  console.log('[IPC] Sent computer-use-setup:requested event:', data.reason);
}

// ============================================================================
// PDF Events
// ============================================================================

/**
 * Emit pdf:fill-field event
 * Used by tools to fill PDF form fields
 */
export function emitPdfFillField(
  window: BrowserWindow | null,
  data: PdfFillFieldEvent
): void {
  emitToRenderer(window, IPC_CHANNELS.PDF_FILL_FIELD, data);
  broadcast('pdf:fillField', data);
  console.log('[IPC] Sent pdf:fill-field event:', data.filePath, data.identifier);
}

// ============================================================================
// File Refresh Events
// ============================================================================

/**
 * Emit file:refreshed event
 * Used to notify the frontend that a file has been modified and should be refreshed
 */
export function emitFileRefreshed(
  window: BrowserWindow | null,
  filePath: string
): void {
  const event: FileRefreshedEvent = { filePath };
  emitToRenderer(window, IPC_CHANNELS.FILE_REFRESHED, event);
  broadcast('files:refreshed', event);
  console.log('[IPC] Sent file:refreshed event:', filePath);
}

// ============================================================================
// Browser Events
// ============================================================================

/**
 * Emit browser:tab-created event
 * Used by agent tools to notify renderer that a browser tab was created
 */
export function emitBrowserTabCreated(
  window: BrowserWindow | null,
  browserId: string,
  url: string
): void {
  const event: BrowserTabCreatedEvent = { browserId, url };
  emitToRenderer(window, IPC_CHANNELS.BROWSER_TAB_CREATED, event);
  broadcast('browser:tabCreated', event);
  console.log('[IPC] Sent browser:tab-created event:', browserId, url);
}

/**
 * Emit browser:tab-closed event
 * Used by agent tools to notify renderer that a browser tab was closed
 */
export function emitBrowserTabClosed(
  window: BrowserWindow | null,
  browserId: string
): void {
  const event: BrowserTabClosedEvent = { browserId };
  emitToRenderer(window, IPC_CHANNELS.BROWSER_TAB_CLOSED, event);
  broadcast('browser:tabClosed', event);
  console.log('[IPC] Sent browser:tab-closed event:', browserId);
}

// ============================================================================
// Window Events
// ============================================================================

/**
 * Emit window:fullscreen-changed event
 * Used to notify renderer when window enters or leaves fullscreen mode
 */
export function emitWindowFullscreenChanged(
  window: BrowserWindow | null,
  isFullScreen: boolean
): void {
  const event: WindowFullscreenChangedEvent = { isFullScreen };
  emitToRenderer(window, IPC_CHANNELS.WINDOW_FULLSCREEN_CHANGED, event);
  broadcast('window:fullscreenChanged', event);
  console.log('[IPC] Sent window:fullscreen-changed event:', isFullScreen);
}

// ============================================================================
// Tab Navigation Events
// ============================================================================

/**
 * Emit tabs:close event
 * Used by CMD+W menu shortcut to close the active tab
 */
export function emitTabClose(window: BrowserWindow | null): void {
  emitToRenderer(window, IPC_CHANNELS.TAB_CLOSE);
  broadcast('tabs:close', {});
}

/**
 * Emit tabs:new event
 * Used by CMD+T menu shortcut to open a new main-area agent tab
 */
export function emitTabNew(window: BrowserWindow | null): void {
  emitToRenderer(window, IPC_CHANNELS.TAB_NEW);
  broadcast('tabs:new', {});
}

/**
 * Emit tabs:next event
 * Used by CMD+Shift+] or CMD+Option+Right to go to next tab
 */
export function emitTabNext(window: BrowserWindow | null): void {
  emitToRenderer(window, IPC_CHANNELS.TAB_NEXT);
  broadcast('tabs:next', {});
}

/**
 * Emit tabs:previous event
 * Used by CMD+Shift+[ or CMD+Option+Left to go to previous tab
 */
export function emitTabPrevious(window: BrowserWindow | null): void {
  emitToRenderer(window, IPC_CHANNELS.TAB_PREVIOUS);
  broadcast('tabs:previous', {});
}

/**
 * Emit tabs:go-to event
 * Used by CMD+1 through CMD+9 to go to specific tab
 */
export function emitTabGoTo(window: BrowserWindow | null, index: number): void {
  emitToRenderer(window, IPC_CHANNELS.TAB_GO_TO, index);
  broadcast('tabs:go-to', { index });
}

/**
 * Emit quick-open event
 * Used by CMD+K to open the quick file search
 */
export function emitQuickOpen(window: BrowserWindow | null): void {
  emitToRenderer(window, IPC_CHANNELS.QUICK_OPEN);
  broadcast('quickActions:open', {});
}

/**
 * Emit toggle-explorer event
 * Used by CMD+E to toggle the explorer sidebar
 */
export function emitToggleExplorer(window: BrowserWindow | null): void {
  emitToRenderer(window, IPC_CHANNELS.TOGGLE_EXPLORER);
  broadcast('explorer:toggle', {});
}

/**
 * Emit focus-agent event
 * Used by CMD+L to toggle the agent sidebar and focus the input when opened
 */
export function emitFocusAgent(window: BrowserWindow | null): void {
  emitToRenderer(window, IPC_CHANNELS.FOCUS_AGENT);
  broadcast('agent:focus', {});
}

/**
 * Emit new-sidebar-agent event
 * Used by CMD+Shift+L to create a pinned sidebar agent
 */
export function emitNewSidebarAgent(window: BrowserWindow | null): void {
  emitToRenderer(window, IPC_CHANNELS.NEW_SIDEBAR_AGENT);
  broadcast('agent:sidebar-new', {});
}

/**
 * Emit open-inbox event
 * Used by File > Open Experimental Inbox to open the inbox sidebar
 */
export function emitOpenInbox(window: BrowserWindow | null): void {
  emitToRenderer(window, IPC_CHANNELS.OPEN_INBOX);
  broadcast('inbox:open', {});
}

/**
 * Emit open-settings event
 * Used by Cmd+, to open the settings page
 */
export function emitOpenSettings(window: BrowserWindow | null): void {
  emitToRenderer(window, IPC_CHANNELS.OPEN_SETTINGS);
  broadcast('settings:open', {});
}

// ============================================================================
// Tool Server Events
// ============================================================================

/**
 * Emit tool-servers:changed event
 * Used to notify the renderer when tool servers are added, removed, or changed
 */
export function emitToolServersChanged(
  window: BrowserWindow | null,
  servers: ToolServerInfo[]
): void {
  const event: ToolServersChangedEvent = { servers };
  emitToRenderer(window, IPC_CHANNELS.TOOL_SERVERS_CHANGED, event);
  console.log('[IPC] Sent tool-servers:changed event, count:', servers.length);
}
