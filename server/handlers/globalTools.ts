/**
 * Global Tools Handler
 *
 * Business logic for globally enabling/disabling tools across all profiles.
 * This is separate from global disabled tools list (MCP blacklist).
 */

import * as configStore from '../configStore';
import { broadcastEvent } from './broadcast';
import { emitToolServersChanged } from '../utils/ipcBridge';
import { getToolManager } from '../tools/toolManagerAccessor';

/**
 * Get all global tool enabled states
 */
export async function listGlobalTools(): Promise<Record<string, boolean>> {
  return configStore.listBuiltinToolsEnabled();
}

/**
 * Get the global enabled state for a specific tool
 */
export async function getGlobalToolEnabled(serverId: string): Promise<boolean> {
  return configStore.isBuiltinToolEnabled(serverId);
}

/**
 * Set the global enabled state for a tool
 */
export async function setGlobalToolEnabled(serverId: string, enabled: boolean): Promise<void> {
  console.log(`[GlobalTools] Setting ${serverId} to ${enabled ? 'enabled' : 'disabled'}`);
  await configStore.setBuiltinToolEnabled(serverId, enabled);
  broadcastEvent('globalTools:changed', { serverId, enabled });

  // Also emit tool-servers:changed so UI refreshes
  const toolManager = getToolManager();
  emitToolServersChanged(await toolManager.listToolServerSnapshot());
}
