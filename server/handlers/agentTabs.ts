/**
 * Agent Tabs Handlers
 *
 * THE business logic for agent tab management.
 * Both Electron IPC and HTTP routes call these same functions.
 */

import { agentTabManager } from '../agentTabManager';
import { onWhatsAppBridgeTabCreated } from '../services/whatsappBridge';
import type { AgentModelConfig } from '../../shared/types/model';
import type { AgentActivityState } from '../../shared/utils/agentAttention';
import type { AgentTabGetPendingResponse } from '../../electron/ipc/registry';
import { getCurrentWorkspace } from '../utils/workspace';
import { getCurrentWindowSessionKey } from '../utils/windowSessions';

// ============================================================================
// Agent Tab Operations
// ============================================================================

export async function onTabCreated(
  requestId: string,
  agentId: string
): Promise<{ success: boolean }> {
  agentTabManager.onTabCreated(requestId, agentId);
  onWhatsAppBridgeTabCreated(requestId, agentId);
  return { success: true };
}

export async function onTabCompleted(
  requestId: string,
  messages: any[],
  error?: string,
  threadId?: string,
): Promise<{ success: boolean }> {
  agentTabManager.onTabCompleted(requestId, messages, error, threadId);
  return { success: true };
}

export async function getPendingRequests(): Promise<AgentTabGetPendingResponse> {
  return {
    requests: agentTabManager.getPendingRequests({
      windowSessionKey: getCurrentWindowSessionKey(),
      workspacePath: getCurrentWorkspace(),
    }),
  };
}

export async function consumeStartup(
  startupId: string,
  agentId: string,
): Promise<{
  success: boolean;
  startup: ReturnType<typeof agentTabManager.consumeStartup>;
}> {
  return {
    success: true,
    startup: agentTabManager.consumeStartup(startupId, agentId),
  };
}

export async function bindThread(
  agentId: string,
  threadId: string,
  callerToken: string,
  options?: {
    workspacePath?: string;
    allowedToolNames?: string[];
    modelConfig?: AgentModelConfig;
    toolProfileId?: string;
  },
): Promise<{ success: boolean }> {
  agentTabManager.bindThread({
    agentId,
    threadId,
    callerToken,
    workspacePath: options?.workspacePath,
    allowedToolNames: options?.allowedToolNames,
    modelConfig: options?.modelConfig,
    toolProfileId: options?.toolProfileId,
  });
  return { success: true };
}

export async function reportActivity(
  agentId: string,
  activity: Partial<AgentActivityState>,
): Promise<{ success: boolean }> {
  agentTabManager.reportAgentWindowActivity(agentId, activity);
  return { success: true };
}

export async function disposeBinding(
  callerToken: string,
): Promise<{ success: boolean }> {
  agentTabManager.disposeBinding(callerToken);
  return { success: true };
}
