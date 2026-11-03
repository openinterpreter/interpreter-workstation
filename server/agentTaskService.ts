import { nanoid } from 'nanoid';
import { getDefaultProfile } from './configStore';
import { agentTabManager } from './agentTabManager';
import { broadcastEvent } from './handlers/broadcast';
import { runCodexSubagent } from './tools/builtin-tools/agents/codexSubagentRunnerBridge';
import { getCodexService } from '../src/lib/codex/service';
import {
  ensureOpenAIOAuthAccountReady,
  resolveAgentInterpreterCliTransport,
  resolveCodexProfileFromModelConfig,
} from './utils/codexRuntime';
import {
  buildInterpreterCliServerConnection,
  buildInterpreterCliShellEnvironmentPolicy,
} from './utils/interpreterCliRuntime';
import { buildGroqProxyBaseUrl, routeGroqProfileThroughProxy } from './utils/groqResponsesProxy';
import { getServerPort } from './utils/serverPort';
import { revokeOtherNativeCallerBindingsForThread } from './utils/persistedCallerBinding';
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
  idleTimeoutMs?: number | null;
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

export interface ResumeAgentTaskThreadOptions {
  threadId: string;
  workspace?: string;
  modelConfig?: AgentModelConfig;
}

export interface ForkAgentTaskThreadOptions extends ResumeAgentTaskThreadOptions {
  lastTurnId: string;
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

export async function resolveAgentModelConfig(
  explicitModelConfig?: AgentModelConfig,
  overrides?: { modelId?: string; reasoningEffort?: AgentModelConfig['reasoningEffort'] },
): Promise<AgentModelConfig> {
  let resolved: AgentModelConfig;
  if (explicitModelConfig) {
    resolved = explicitModelConfig;
  } else {
    const selectedProfile = await getDefaultProfile();
    resolved = selectedProfile ? profileToModelConfig(selectedProfile, {
      reasoningEffort: selectedProfile.reasoningEffort,
    }) : getDefaultModelConfig();
  }

  return {
    ...resolved,
    ...(overrides?.modelId ? { modelId: overrides.modelId } : {}),
    ...(overrides?.reasoningEffort ? { reasoningEffort: overrides.reasoningEffort } : {}),
  };
}

/** Restore a persisted OIX thread without manufacturing a model turn. */
export async function resumeAgentTaskThread(
  options: ResumeAgentTaskThreadOptions,
): Promise<{ threadId: string }> {
  const workspace = normalizeHeadlessTaskWorkspace(options.workspace);
  if (!workspace) {
    throw new Error(HEADLESS_TASK_WORKSPACE_ERROR);
  }

  const modelConfig = await resolveAgentModelConfig(options.modelConfig);
  const profile = routeGroqProfileThroughProxy(
    resolveCodexProfileFromModelConfig(modelConfig),
    buildGroqProxyBaseUrl(getServerPort()),
  );
  const service = getCodexService();
  await ensureOpenAIOAuthAccountReady(
    service,
    modelConfig.provider === 'openai-oauth',
  );
  // A resumed thread can outlive this request through native OIX features such
  // as Goal. Provision the provider in OIX first so those later turns retain
  // environment-backed auth after the request-scoped resume overrides are gone.
  await service.ensureProvider(profile, true);
  const callerToken = `agtok_${nanoid()}`;
  const agentId = `resumed-${nanoid()}`;
  const shellEnvironmentPolicy = buildInterpreterCliShellEnvironmentPolicy(
    callerToken,
    process.env,
    process.platform,
    workspace,
    buildInterpreterCliServerConnection(getServerPort(), {
      transport: resolveAgentInterpreterCliTransport(process.platform),
    }),
  );
  agentTabManager.bindThread({
    agentId,
    callerToken,
    threadId: options.threadId,
    workspacePath: workspace,
    modelConfig,
  });
  const threadId = await service.resumeThread({
    threadId: options.threadId,
    model: modelConfig.modelId,
    modelProvider: profile.modelProvider,
    providerConfig: profile.providerConfig,
    cwd: workspace,
    config: {
      ...(modelConfig.reasoningEffort
        ? { model_reasoning_effort: modelConfig.reasoningEffort }
        : {}),
      // A resumed thread may immediately continue an active native Goal without
      // another Workstation request. Reapply the model-facing app-tool bridge
      // here so those autonomous turns retain interpreter-app and js_repl.
      mcp_servers: {},
      shell_environment_policy: shellEnvironmentPolicy,
    },
  });

  return { threadId };
}

/** Operator-only cold rebind: no input, model change, token export or loaded-shell mutation. */
export async function coldBindAgentTaskThread(options: { threadId: string; workspace: string }) {
  const workspace = normalizeHeadlessTaskWorkspace(options.workspace);
  if (!workspace) throw new Error(HEADLESS_TASK_WORKSPACE_ERROR);
  const service = getCodexService();
  const thread = await service.readThread(options.threadId);
  const custody = await service.readNativeCustody(options.threadId);
  const global = await service.readGlobalNativeCustody();
  if (thread.id !== options.threadId || thread.cwd !== workspace ||
      !['idle', 'notLoaded'].includes(custody.status) || custody.queuedSubmissionCount !== 0 ||
      (custody.lastTurnStatus !== null && !['completed', 'failed', 'interrupted'].includes(custody.lastTurnStatus)) ||
      global.queuedSubmissionCount !== 0 || global.loadedThreadIds.includes(options.threadId) ||
      !global.threads.some(row => row.threadId === options.threadId)) {
    throw new Error('Cold caller bind requires the exact unloaded idle thread, workspace and empty native queues');
  }
  const oldBinding = agentTabManager.getBindingForThread(options.threadId);
  if (oldBinding && (oldBinding.workspacePath !== workspace || oldBinding.windowSessionKey ||
      oldBinding.parentOwner || oldBinding.allowedToolNames?.length || oldBinding.toolProfileId)) {
    throw new Error('Existing caller owner or tool scope differs');
  }
  const callerToken = `agtok_${nanoid()}`;
  // Inventory the private on-disk scopes before native resume; a process
  // restart must not turn a previously restricted caller into an open one.
  revokeOtherNativeCallerBindingsForThread(options.threadId, callerToken, undefined, true);
  const agentId = `cold-${nanoid()}`;
  const policy = buildInterpreterCliShellEnvironmentPolicy(
    callerToken, process.env, process.platform, workspace,
    buildInterpreterCliServerConnection(getServerPort(), {
      transport: resolveAgentInterpreterCliTransport(process.platform),
    }),
  );
  // Register before native resume so autonomous native turns cannot race the
  // caller binding. If resume rejects, restore the prior exact owner.
  agentTabManager.bindThread({ agentId, callerToken, threadId: options.threadId, workspacePath: workspace });
  try {
    await service.resumeThread({ threadId: options.threadId, model: null, cwd: workspace,
      config: { mcp_servers: {}, shell_environment_policy: policy }, coldShellPolicy: true });
  } catch (error) {
    agentTabManager.disposeBinding(callerToken);
    if (oldBinding) agentTabManager.bindThread({ ...oldBinding, threadId: options.threadId });
    throw error;
  }
  if (oldBinding) agentTabManager.disposeBinding(oldBinding.callerToken);
  const revokedPriorBindings = revokeOtherNativeCallerBindingsForThread(options.threadId, callerToken);
  return { threadId: options.threadId, carrier: 'cold-bound' as const, revokedPriorBindings };
}

/** Preserve the source thread and continue its native OIX state from a completed turn. */
export async function forkAgentTaskThread(
  options: ForkAgentTaskThreadOptions,
): Promise<{ threadId: string }> {
  const workspace = normalizeHeadlessTaskWorkspace(options.workspace);
  if (!workspace) {
    throw new Error(HEADLESS_TASK_WORKSPACE_ERROR);
  }

  const modelConfig = await resolveAgentModelConfig(options.modelConfig);
  const profile = routeGroqProfileThroughProxy(
    resolveCodexProfileFromModelConfig(modelConfig),
    buildGroqProxyBaseUrl(getServerPort()),
  );
  const service = getCodexService();
  await ensureOpenAIOAuthAccountReady(
    service,
    modelConfig.provider === 'openai-oauth',
  );
  await service.ensureProvider(profile, true);
  const threadId = await service.forkThread({
    threadId: options.threadId,
    lastTurnId: options.lastTurnId,
    model: modelConfig.modelId,
    modelProvider: profile.modelProvider,
    providerConfig: profile.providerConfig,
    cwd: workspace,
    ...(modelConfig.reasoningEffort
      ? { config: { model_reasoning_effort: modelConfig.reasoningEffort } }
      : {}),
  });

  return { threadId };
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
    idleTimeoutMs: options.idleTimeoutMs,
    workspace: options.workspace,
    allowedToolNames: options.allowedToolNames,
    parentOwner: options.parentOwner,
    threadId: options.threadId,
    retainThreadCaller: true,
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
