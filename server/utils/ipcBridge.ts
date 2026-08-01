/**
 * IPC Bridge
 *
 * Server-side utilities for emitting IPC events to the renderer process.
 * Uses the unified broadcastEvent() abstraction for all event broadcasting.
 *
 * NOTE: This module provides semantic function names (emitSetupCompleted, etc.)
 * that wrap broadcastEvent(). It does NOT directly access IPC or SSE.
 */

import type { AppToastEvent, SetupCompletedEvent, ToolServerInfo, ToolServersChangedEvent, SubagentToolCallEvent } from '../../electron/ipc/registry';
import { IPC_CHANNELS } from '../../electron/ipc/registry';
import { addSubagentToolCall } from './subagentToolStore';
import { broadcastEvent } from '../handlers/broadcast';
import { notifyMcpToolsListChanged } from '../routes/mcp';
import { stat } from 'node:fs/promises';
import { relative } from 'node:path';
import { getCurrentWorkspace } from './workspace';

let latestToolServersChangedEvent: ToolServersChangedEvent | null = null;

/**
 * Emit setup:completed event
 * Used when OAuth or other setup operations complete
 */
export function emitSetupCompleted(data: SetupCompletedEvent): void {
  console.log('[IPC Bridge] Broadcasting setup:completed event:', data.serverId);
  broadcastEvent(IPC_CHANNELS.SETUP_COMPLETED, data);
}

/**
 * Generic event emitter for server-side code.
 *
 * FILE_REFRESHED is the single event channel for agent-driven file edits.
 * The bridge fans that one event out to open viewers and the Explorer tree.
 */
export function emitEvent(channel: string, ...args: any[]): void {
  if (channel === IPC_CHANNELS.FILE_REFRESHED && args[0]?.filePath) {
    broadcastEvent(IPC_CHANNELS.FILE_REFRESHED, args[0]);
    void emitWorkspaceFileChangedForRefresh(args[0].filePath);
    return;
  }

  broadcastEvent(channel, args[0]);
}

/**
 * Emit toolServers:changed event
 * Used to notify the renderer when tool servers are added, removed, or changed.
 * Also notifies any connected MCP clients (via notifications/tools/list_changed).
 */
export function emitToolServersChanged(servers: ToolServerInfo[]): void {
  const event: ToolServersChangedEvent = { servers };
  latestToolServersChangedEvent = event;
  console.log('[IPC Bridge] Broadcasting toolServers:changed event, count:', servers.length);
  broadcastEvent(IPC_CHANNELS.TOOL_SERVERS_CHANGED, event);

  // Notify any connected MCP clients that tools have changed
  // They should call tools/list again to get the updated list
  notifyMcpToolsListChanged();
}

export function getLatestToolServersChangedEvent(): ToolServersChangedEvent | null {
  return latestToolServersChangedEvent;
}

export function emitAppToast(event: AppToastEvent): void {
  broadcastEvent(IPC_CHANNELS.APP_TOAST_SHOW, event);
}

// NOTE(victor): Agent-driven file edits emit FILE_REFRESHED exactly once.
// The bridge derives WORKSPACE_FILES_CHANGED from that refresh so the Explorer
// stays in sync without every tool coordinating multiple refresh channels.
//
// Without WORKSPACE_FILES_CHANGED, the tree relies on @parcel/watcher which on
// Windows reports atomic rename as 'create' instead of 'update', causing the
// tree to miss file changes.
//
// NOTE(victor): eventType MUST be 'add', NOT 'change'. When the agent creates a NEW file,
// Explorer's 'change' handler (handleFileChanged) only updates mtime on existing tree nodes
// via .map() -- it silently no-ops for files not yet in the tree. The 'add' handler correctly
// checks whether the node exists: if yes + mtime, treats as change; if no, reloads the tree.
// Using 'change' here was the cause of new agent-created files not appearing in the sidebar.
async function emitWorkspaceFileChangedForRefresh(filePath: string): Promise<void> {
  const workspace = getCurrentWorkspace();
  if (workspace && filePath.startsWith(workspace)) {
    const relativePath = relative(workspace, filePath);
    try {
      const stats = await stat(filePath);
      const eventType = stats.isDirectory() ? 'addDir' : 'add';
      console.log('[IPC Bridge] Emitting WORKSPACE_FILES_CHANGED:', eventType, relativePath, 'mtime:', stats.mtime.getTime());
      broadcastEvent(IPC_CHANNELS.WORKSPACE_FILES_CHANGED, {
        eventType,
        path: relativePath,
        mtime: stats.mtime.getTime(),
      });
    } catch (err) {
      console.log('[IPC Bridge] Emitting WORKSPACE_FILES_CHANGED (stat failed):', 'add', relativePath, err);
      broadcastEvent(IPC_CHANNELS.WORKSPACE_FILES_CHANGED, {
        eventType: 'add',
        path: relativePath,
      });
    }
  } else {
    console.log('[IPC Bridge] Skipping WORKSPACE_FILES_CHANGED - path outside workspace. filePath:', filePath, 'workspace:', workspace);
  }
}

/**
 * Emit subagentTools:tool-call event
 * Used to stream subagent tool calls to the frontend in real-time
 *
 * NOTE: This function will call addSubagentToolCall() from subagentToolStore.ts
 * to persist the event for conversation save/load.
 */
export function emitSubagentToolEvent(event: SubagentToolCallEvent): void {
  // Store for persistence BEFORE emitting (ensures save captures all events)
  addSubagentToolCall(event);

  console.log('[IPC Bridge] Broadcasting subagentTools:tool-call event:', event.toolCall.toolName);
  broadcastEvent(IPC_CHANNELS.SUBAGENT_TOOL_CALL, event);
}
