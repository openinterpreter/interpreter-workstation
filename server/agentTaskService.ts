import { getDefaultProfile } from './configStore';
import { agentTabManager } from './agentTabManager';
import { broadcastEvent } from './handlers/broadcast';
import { runCodexSubagent } from './tools/builtin-tools/agents/codexSubagentRunnerBridge';
import { IPC_CHANNELS } from '../electron/ipc/registry';
import type { AgentModelConfig } from '../shared/types/model';
import type { AgentPermissionOwnerReference } from '../shared/types/approval';
import type { StreamImageAttachment, StreamSkillReference } from '../src/lib/codex/api-types';
import { mapNotificationToUiEvents, type UiStreamEvent } from '../src/lib/codex/event-mapper';
import { getDefaultModelConfig, profileToModelConfig } from '../shared/types/profile';
import type { AgentCompletionDisposition } from './agentTabManager';
import {
  HEADLESS_TASK_WORKSPACE_ERROR,
  normalizeHeadlessTaskWorkspace,
} from './utils/headlessTaskWorkspace';

export type AgentTaskMode = 'headed' | 'headless';

export interface StartAgentTaskOptions {
  agentId?: string;
  callerToken?: string;
  message?: string;
  system?: string;
  timeoutMs?: number;
  mode?: AgentTaskMode;
  modelConfig?: AgentModelConfig;
  workspace?: string;
  threadId?: string;
  activate?: boolean;
  targetWindowSessionKey?: string;
  allowedToolNames?: string[];
  toolProfileId?: string;
  parentOwner?: AgentPermissionOwnerReference;
  startupAttachments?: StreamImageAttachment[];
  skills?: StreamSkillReference[];
  completionDisposition?: AgentCompletionDisposition;
  broadcastCreateRequestToAllWindows?: boolean;
  notifyStarted?: boolean;
  onProgress?: (event: AgentTaskProgressEvent) => void;
  createHeadedTask?: typeof agentTabManager.createAgentTask;
}

export interface AgentTaskResult {
  mode: AgentTaskMode;
  completed: boolean;
  timestamp: string;
  messageCount: number;
  messages: any[];
  error?: string;
  agentId?: string;
  requestId?: string;
  threadId?: string;
  threadPath?: string;
  hitMaxSteps?: boolean;
}

export type AgentTaskProgressEvent =
  | { kind: 'thread'; threadId: string }
  | { kind: 'turn'; threadId: string; turnId: string; status: string }
  | { kind: 'ui'; event: UiStreamEvent };

function buildMessagePreview(message: string | undefined): string {
  if (!message) {
    return '';
  }
  const normalized = message.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 140) {
    return normalized;
  }
  return `${normalized.slice(0, 137)}...`;
}

function notifyProgrammaticTaskStarted(options: StartAgentTaskOptions, mode: AgentTaskMode): void {
  const timestamp = new Date().toISOString();
  broadcastEvent(IPC_CHANNELS.PROGRAMMATIC_TASK_STARTED, {
    mode,
    message: options.message,
    messagePreview: buildMessagePreview(options.message),
    timestamp,
  });
}

async function resolveAgentModelConfig(
  explicitModelConfig?: AgentModelConfig,
): Promise<AgentModelConfig> {
  if (explicitModelConfig) {
    return explicitModelConfig;
  }

  const selectedProfile = await getDefaultProfile();
  if (selectedProfile) {
    return profileToModelConfig(selectedProfile, {
      reasoningEffort: selectedProfile.reasoningEffort,
    });
  }

  return getDefaultModelConfig();
}

async function startHeadedAgentTask(
  options: StartAgentTaskOptions,
): Promise<AgentTaskResult> {
  const modelConfig = await resolveAgentModelConfig(options.modelConfig);
  const createHeadedTask = options.createHeadedTask ?? agentTabManager.createAgentTask.bind(agentTabManager);
  const result = await createHeadedTask({
    ...(options.agentId ? { agentId: options.agentId } : {}),
    ...(options.callerToken ? { callerToken: options.callerToken } : {}),
    initialMessage: options.message,
    systemPrompt: options.system,
    timeout: options.timeoutMs,
    threadId: options.threadId,
    workspacePath: options.workspace,
    modelConfig,
    activate: options.activate,
    ...(options.targetWindowSessionKey ? { targetWindowSessionKey: options.targetWindowSessionKey } : {}),
    ...(options.allowedToolNames ? { allowedToolNames: options.allowedToolNames } : {}),
    ...(options.toolProfileId ? { toolProfileId: options.toolProfileId } : {}),
    ...(options.parentOwner ? { parentOwner: options.parentOwner } : {}),
    ...(options.startupAttachments ? { startupAttachments: options.startupAttachments } : {}),
    completionDisposition: options.completionDisposition,
    ...(options.broadcastCreateRequestToAllWindows !== undefined
      ? { broadcastCreateRequestToAllWindows: options.broadcastCreateRequestToAllWindows }
      : {}),
  });

  return {
    mode: 'headed',
    agentId: result.agentId,
    requestId: result.requestId,
    threadId: result.threadId,
    completed: true,
    timestamp: new Date().toISOString(),
    messageCount: result.messages.length,
    messages: result.messages,
  };
}

async function startHeadlessAgentTask(
  options: StartAgentTaskOptions,
): Promise<AgentTaskResult> {
  const modelConfig = await resolveAgentModelConfig(options.modelConfig);
  const result = await runCodexSubagent({
    message: options.message ?? '',
    system: options.system,
    skills: options.skills,
    modelConfig,
    timeoutMs: options.timeoutMs,
    workspace: options.workspace,
    allowedToolNames: options.allowedToolNames,
    parentOwner: options.parentOwner,
    threadId: options.threadId,
    onEvent: (event) => {
      if (event.kind === 'thread') {
        options.onProgress?.({
          kind: 'thread',
          threadId: event.threadId,
        });
        return;
      }

      if (event.kind === 'turn') {
        options.onProgress?.({
          kind: 'turn',
          threadId: event.threadId,
          turnId: event.turnId,
          status: event.status,
        });
        return;
      }

      for (const uiEvent of mapNotificationToUiEvents(event.notification)) {
        options.onProgress?.({
          kind: 'ui',
          event: uiEvent,
        });
      }
    },
  });

  return {
    mode: 'headless',
    agentId: result.agentId,
    threadId: result.threadId,
    completed: result.completed,
    timestamp: result.timestamp ?? new Date().toISOString(),
    messageCount: Array.isArray(result.messages) ? result.messages.length : 0,
    messages: Array.isArray(result.messages) ? result.messages : [],
    error: result.error,
    hitMaxSteps: result.hitMaxSteps,
    threadPath: result.threadPath,
  };
}

export async function startAgentTask(
  options: StartAgentTaskOptions,
): Promise<AgentTaskResult> {
  const mode = options.mode ?? 'headless';
  const normalizedMessage = typeof options.message === 'string' ? options.message.trim() : '';
  const normalizedWorkspace = normalizeHeadlessTaskWorkspace(options.workspace);

  if (mode === 'headless' && !normalizedWorkspace) {
    throw new Error(HEADLESS_TASK_WORKSPACE_ERROR);
  }

  if (options.notifyStarted === true) {
    notifyProgrammaticTaskStarted(options, mode);
  }

  if (mode === 'headless' && !normalizedMessage) {
    throw new Error('message is required for headless tasks');
  }

  if (mode === 'headed' && !normalizedMessage && !options.threadId) {
    throw new Error('message or threadId is required for headed tasks');
  }

  if (mode === 'headed') {
    return startHeadedAgentTask({
      ...options,
      message: normalizedMessage || undefined,
      workspace: normalizedWorkspace,
    });
  }

  return startHeadlessAgentTask({
    ...options,
    message: normalizedMessage,
    workspace: normalizedWorkspace,
  });
}
