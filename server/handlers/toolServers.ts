/**
 * Tool Servers Handlers
 *
 * THE business logic for MCP tool server management.
 * Both Electron IPC and HTTP routes call these same functions.
 */

import { getToolManager } from '../tools/toolManagerAccessor';
import { getLatestToolServersChangedEvent } from '../utils/ipcBridge';

let toolServersListRequestId = 0;
let toolServersAddRequestId = 0;
let toolServersDeleteRequestId = 0;
let toolServersToggleRequestId = 0;
let toolServersOAuthRequestId = 0;

// ============================================================================
// Tool Server Operations
// ============================================================================

export async function listToolServers(): Promise<{ servers: any[] }> {
  const requestId = ++toolServersListRequestId;
  const startedAt = Date.now();
  console.log(`[toolServers] list start requestId=${requestId}`);
  const toolManager = getToolManager();
  try {
    const statuses = await toolManager.listDisplayToolServers();
    console.log(
      `[toolServers] list done requestId=${requestId} durationMs=${Date.now() - startedAt} count=${statuses.length}`,
    );
    return { servers: statuses };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[toolServers] list failed requestId=${requestId} durationMs=${Date.now() - startedAt} error=${message}`,
      error,
    );
    throw error;
  }
}

export async function getToolServersSnapshot(): Promise<import('../../electron/ipc/registry').ToolServersChangedEvent | null> {
  return getLatestToolServersChangedEvent();
}

export async function getToolServer(serverId: string): Promise<any> {
  const toolManager = getToolManager();
  return await toolManager.getDisplayToolServer(serverId);
}

export async function addToolServer(config: any): Promise<{ serverId: string }> {
  const requestId = ++toolServersAddRequestId;
  const startedAt = Date.now();
  console.log(`[toolServers] add start requestId=${requestId} name=${config?.name ?? 'unknown'}`);
  const toolManager = getToolManager();
  try {
    const serverId = await toolManager.addServer(config);
    console.log(
      `[toolServers] add done requestId=${requestId} name=${config?.name ?? 'unknown'} serverId=${serverId} durationMs=${Date.now() - startedAt}`,
    );
    return { serverId };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[toolServers] add failed requestId=${requestId} name=${config?.name ?? 'unknown'} durationMs=${Date.now() - startedAt} error=${message}`,
      error,
    );
    throw error;
  }
}

export async function startToolServerOAuth(
  serverId: string,
  scopes?: string[],
): Promise<{ authorizationUrl: string }> {
  const requestId = ++toolServersOAuthRequestId;
  const startedAt = Date.now();
  console.log(`[toolServers] oauth start requestId=${requestId} serverId=${serverId} scopes=${scopes?.length ?? 0}`);
  const toolManager = getToolManager();
  try {
    const result = await toolManager.startOAuthLogin(serverId, scopes);
    console.log(
      `[toolServers] oauth done requestId=${requestId} serverId=${serverId} durationMs=${Date.now() - startedAt}`,
    );
    return result;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[toolServers] oauth failed requestId=${requestId} serverId=${serverId} durationMs=${Date.now() - startedAt} error=${message}`,
      error,
    );
    throw error;
  }
}

export async function updateToolServer(
  serverId: string,
  updates: any
): Promise<{ success: boolean }> {
  const toolManager = getToolManager();
  await toolManager.updateServer(serverId, updates);
  return { success: true };
}

export async function deleteToolServer(serverId: string): Promise<{ success: boolean }> {
  const requestId = ++toolServersDeleteRequestId;
  const startedAt = Date.now();
  console.log(`[toolServers] delete start requestId=${requestId} serverId=${serverId}`);
  const toolManager = getToolManager();
  try {
    await toolManager.removeServer(serverId);
    console.log(
      `[toolServers] delete done requestId=${requestId} serverId=${serverId} durationMs=${Date.now() - startedAt}`,
    );
    return { success: true };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[toolServers] delete failed requestId=${requestId} serverId=${serverId} durationMs=${Date.now() - startedAt} error=${message}`,
      error,
    );
    throw error;
  }
}

export async function toggleToolServer(
  serverId: string,
  enabled: boolean
): Promise<{ success: boolean }> {
  const requestId = ++toolServersToggleRequestId;
  const startedAt = Date.now();
  console.log(`[toolServers] toggle start requestId=${requestId} serverId=${serverId} enabled=${enabled}`);
  const toolManager = getToolManager();
  try {
    await toolManager.toggleToolServer(serverId, enabled);
    console.log(
      `[toolServers] toggle done requestId=${requestId} serverId=${serverId} enabled=${enabled} durationMs=${Date.now() - startedAt}`,
    );
    return { success: true };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[toolServers] toggle failed requestId=${requestId} serverId=${serverId} enabled=${enabled} durationMs=${Date.now() - startedAt} error=${message}`,
      error,
    );
    throw error;
  }
}

export async function callTool(
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
  saveToDisk?: boolean,
  toolContext?: {
    profileId?: string;
    callerTabId?: string;
    workspace?: string;
    modelConfig?: import('../../shared/types/model').AgentModelConfig;
    overlayReviewedAction?: boolean;
  },
  options?: {
    includeHiddenBuiltins?: boolean;
  },
): Promise<any> {
  const toolManager = getToolManager();
  return await toolManager.callTool(
    serverId,
    toolName,
    args,
    saveToDisk,
    toolContext?.callerTabId,
    toolContext,
    undefined,
    options,
  );
}
