import { nanoid } from 'nanoid';
import { getDefaultProfile } from './configStore';
import { agentTabManager } from './agentTabManager';
import { broadcastEvent } from './handlers/broadcast';
import { runCodexSubagent } from './tools/builtin-tools/agents/codexSubagentRunnerBridge';
import {
  getCodexService,
  setUnloadedThreadCarrierProvider,
  type CodexService,
  type UnloadedThreadCarrier,
  type UnloadedThreadCarrierProvider,
} from '../src/lib/codex/service';
import type { JsonValue } from './handlers/codex-generated-types/serde_json/JsonValue';
import type { SubagentInputRefusal } from '../src/lib/codex/subagent-input';
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
import {
  listNativeCallerScopesForThread,
  revokeOtherNativeCallerBindingsForThread,
  sameNativeCallerScope,
  type NativeCallerScope,
  type PersistedNativeCallerScope,
} from './utils/persistedCallerBinding';
import { IPC_CHANNELS } from '../electron/ipc/registry';
import type { AgentModelConfig } from '../shared/types/model';
import type { AgentPermissionOwnerReference } from '../shared/types/approval';
import type { StreamImageAttachment, StreamSkillReference } from '../src/lib/codex/api-types';
import { mapNotificationToUiEvents, type UiStreamEvent } from '../src/lib/codex/event-mapper';
import { getDefaultModelConfig, profileToModelConfig } from '../shared/types/profile';
import type { AgentCompletionDisposition, AgentThreadBinding } from './agentTabManager';
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
  clientUserMessageId?: string;
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
  /** Set when the target thread refused the input before any native turn. */
  refusal?: SubagentInputRefusal;
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
  // A loaded native thread keeps its original shell environment. A newly
  // minted caller here would be registered in Workstation but absent from the
  // native shell; a failed resume would also leave that false binding behind.
  const binding = agentTabManager.getBindingForThread(options.threadId);
  if (!binding || binding.workspacePath !== workspace ||
      (binding.modelConfig && (binding.modelConfig.provider !== modelConfig.provider ||
        binding.modelConfig.modelId !== modelConfig.modelId))) {
    throw new Error('Existing thread caller is unavailable or its owner scope differs; use guarded cold bind only when eligible');
  }
  const service = getCodexService();
  await ensureOpenAIOAuthAccountReady(
    service,
    modelConfig.provider === 'openai-oauth',
  );
  // A resumed thread can outlive this request through native OIX features such
  // as Goal. Provision the provider in OIX first so those later turns retain
  // environment-backed auth after the request-scoped resume overrides are gone.
  await service.ensureProvider(profile, true);
  // Loading a saved thread fixes its shell environment for every later turn,
  // including Goal continuations the runtime starts on its own. Carry the
  // thread's own existing caller and the current app CLI connection so those
  // turns can reach `interpreter-app`. The service applies this only when the
  // exact thread is not loaded; a loaded thread keeps its live environment.
  // Delegated callers keep their owner's ordinary path.
  const shellPolicy = binding.parentOwner
    ? undefined
    : buildCallerShellPolicy(binding.callerToken, workspace);
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
      mcp_servers: {},
      ...(shellPolicy ? { shell_environment_policy: shellPolicy as unknown as JsonValue } : {}),
    },
    ...(shellPolicy ? { callerBoundShellPolicy: true } : {}),
  });

  return { threadId };
}

const COLD_BIND_CUSTODY_ERROR =
  'Cold caller bind requires the exact unloaded idle thread, workspace and empty native queues';

/** App CLI shell policy for `callerToken` with the current server connection. */
function buildCallerShellPolicy(callerToken: string, workspace: string) {
  return buildInterpreterCliShellEnvironmentPolicy(
    callerToken, process.env, process.platform, workspace,
    buildInterpreterCliServerConnection(getServerPort(), {
      transport: resolveAgentInterpreterCliTransport(process.platform),
    }),
  );
}

/** A thread may only receive an open fresh caller when no prior caller of it
 * is narrower. Covers the live binding and private on-disk scopes, so a
 * process restart cannot turn a restricted caller into an open one. */
function assertOpenCallerScope(threadId: string, workspace: string, callerToken: string) {
  const oldBinding = agentTabManager.getBindingForThread(threadId);
  if (oldBinding && (oldBinding.workspacePath !== workspace || oldBinding.windowSessionKey ||
      oldBinding.parentOwner || oldBinding.allowedToolNames?.length || oldBinding.toolProfileId)) {
    throw new Error('Existing caller owner or tool scope differs');
  }
  revokeOtherNativeCallerBindingsForThread(threadId, callerToken, undefined, true);
  return oldBinding;
}

/** Register a fresh app CLI caller for an exact unloaded idle thread. The
 * caller must resume the thread with `shellPolicy` as its cold shell policy,
 * then `commit` on success or `rollback` on failure. */
async function assertColdBindCustody(service: CodexService, threadId: string) {
  const custody = await service.readNativeCustody(threadId);
  const global = await service.readGlobalNativeCustody();
  if (!['idle', 'notLoaded'].includes(custody.status) || custody.queuedSubmissionCount !== 0 ||
      global.queuedSubmissionCount !== 0 || global.loadedThreadIds.includes(threadId) ||
      !global.threads.some(row => row.threadId === threadId)) {
    throw new Error(COLD_BIND_CUSTODY_ERROR);
  }
}

type PriorCallerScope = NativeCallerScope & { modelConfig?: AgentModelConfig };

const PRIOR_SCOPE_ERROR = 'Existing caller owner or tool scope differs';

/** The scope a fresh caller of `threadId` must carry, so a restart never turns
 * a restricted caller into an open one. A live binding is authoritative; it
 * must be an undelegated, unwindowed caller of the same workspace. Otherwise
 * every persisted caller of the thread in this workspace must share one tool
 * scope and one stored model; with none, the scope is open. Every other
 * persisted caller of the thread, in any workspace, must have that same tool
 * scope. Callers of another workspace are checked but never revoked here. */
function resolvePriorCallerScope(
  threadId: string, workspace: string, callerToken: string,
): { scope: PriorCallerScope & { workspacePath: string }; oldBinding?: AgentThreadBinding } {
  const oldBinding = agentTabManager.getBindingForThread(threadId);
  let scope: PriorCallerScope;
  if (oldBinding) {
    if (oldBinding.workspacePath !== workspace || oldBinding.windowSessionKey || oldBinding.parentOwner) {
      throw new Error(PRIOR_SCOPE_ERROR);
    }
    scope = {
      ...(oldBinding.allowedToolNames?.length ? { allowedToolNames: [...oldBinding.allowedToolNames] } : {}),
      ...(oldBinding.toolProfileId ? { toolProfileId: oldBinding.toolProfileId } : {}),
      ...(oldBinding.modelConfig ? { modelConfig: oldBinding.modelConfig } : {}),
    };
  } else {
    const current = listNativeCallerScopesForThread(threadId).filter(record => record.workspacePath === workspace);
    const first = current[0];
    // Ambiguous prior scopes are refused; the wider one is never chosen.
    if (first && current.some(record => !sameNativeCallerScope(record, first))) {
      throw new Error(PRIOR_SCOPE_ERROR);
    }
    // A caller with no model resolves one from its tool profile, or from the
    // default profile when it has none, so omitting a disputed model could
    // give it a model or provider that no saved caller had. Refuse instead.
    const modelKey = (record: PersistedNativeCallerScope) => JSON.stringify(record.model ?? null);
    if (first && current.some(record => modelKey(record) !== modelKey(first))) {
      throw new Error('Existing callers disagree on model');
    }
    const model = first?.model;
    scope = {
      ...(first?.allowedToolNames?.length ? { allowedToolNames: [...first.allowedToolNames] } : {}),
      ...(first?.toolProfileId ? { toolProfileId: first.toolProfileId } : {}),
      // Recovered callers carry this same stored model subset.
      ...(model ? { modelConfig: model as AgentModelConfig } : {}),
    };
  }
  // Older callers in any workspace must not differ from the chosen scope; the
  // commit passes this same scope and workspace, so it revokes exactly what
  // this dry run approved.
  const replacement = { ...scope, workspacePath: workspace };
  revokeOtherNativeCallerBindingsForThread(threadId, callerToken, undefined, true, replacement);
  return { scope: replacement, oldBinding };
}

function prepareColdCallerCarrier(
  threadId: string, workspace: string,
): UnloadedThreadCarrier & { callerToken: string; commit(): number } {
  const callerToken = `agtok_${nanoid()}`;
  const { scope, oldBinding } = resolvePriorCallerScope(threadId, workspace, callerToken);
  const shellPolicy = buildCallerShellPolicy(callerToken, workspace);
  const restorePrior = () => {
    agentTabManager.disposeBinding(callerToken);
    if (oldBinding) agentTabManager.bindThread({ ...oldBinding, threadId });
  };
  // Register before native resume so autonomous native turns cannot race the
  // caller binding. The fresh caller carries exactly the prior scope.
  const binding = agentTabManager.bindThread({
    agentId: `cold-${nanoid()}`, callerToken, threadId, workspacePath: workspace,
    ...(scope.allowedToolNames ? { allowedToolNames: scope.allowedToolNames } : {}),
    ...(scope.toolProfileId ? { toolProfileId: scope.toolProfileId } : {}),
    ...(scope.modelConfig ? { modelConfig: scope.modelConfig } : {}),
  });
  if (!sameNativeCallerScope(binding, scope)) {
    restorePrior();
    throw new Error('Fresh caller scope differs from the prior caller');
  }
  return {
    callerToken,
    shellPolicy: shellPolicy as unknown as JsonValue,
    rollback: restorePrior,
    commit() {
      if (oldBinding) agentTabManager.disposeBinding(oldBinding.callerToken);
      return revokeOtherNativeCallerBindingsForThread(threadId, callerToken, undefined, false, scope);
    },
  };
}

/** Input to a saved thread that is not loaded resumes it with a fresh caller
 * under the caller scope rules of an operator cold bind. The service checks
 * that the exact thread is not loaded before it uses the carrier. */
export const prepareUnloadedThreadCarrier: UnloadedThreadCarrierProvider = async ({ threadId, cwd }) => {
  const workspace = normalizeHeadlessTaskWorkspace(cwd);
  if (!workspace || workspace !== cwd) throw new Error(COLD_BIND_CUSTODY_ERROR);
  return prepareColdCallerCarrier(threadId, workspace);
};

export function installUnloadedThreadCarrier(): () => void {
  return setUnloadedThreadCarrierProvider(prepareUnloadedThreadCarrier);
}

/** Operator-only cold rebind: no input, model change, token export or loaded-shell mutation. */
export async function coldBindAgentTaskThread(options: { threadId: string; workspace: string }) {
  const workspace = normalizeHeadlessTaskWorkspace(options.workspace);
  if (!workspace) throw new Error(HEADLESS_TASK_WORKSPACE_ERROR);
  const service = getCodexService();
  const thread = await service.readThread(options.threadId);
  if (thread.id !== options.threadId || thread.cwd !== workspace) throw new Error(COLD_BIND_CUSTODY_ERROR);
  await assertColdBindCustody(service, options.threadId);
  const carrier = prepareColdCallerCarrier(options.threadId, workspace);
  try {
    await service.resumeThread({ threadId: options.threadId, model: null, cwd: workspace,
      config: { mcp_servers: {}, shell_environment_policy: carrier.shellPolicy }, coldShellPolicy: true });
  } catch (error) {
    // Restore the prior exact owner.
    carrier.rollback();
    throw error;
  }
  const revokedPriorBindings = carrier.commit();
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
  // The fork is a new native thread with its own shell environment; give it
  // a fresh app CLI caller when the source thread's caller scope is open.
  // A narrower source forks as before, without a new caller.
  const callerToken = `agtok_${nanoid()}`;
  let openScope = true;
  try { assertOpenCallerScope(options.threadId, workspace, callerToken); }
  catch { openScope = false; }
  await service.ensureProvider(profile, true);
  const threadId = await service.forkThread({
    threadId: options.threadId,
    lastTurnId: options.lastTurnId,
    model: modelConfig.modelId,
    modelProvider: profile.modelProvider,
    providerConfig: profile.providerConfig,
    cwd: workspace,
    config: {
      ...(modelConfig.reasoningEffort
        ? { model_reasoning_effort: modelConfig.reasoningEffort }
        : {}),
      ...(openScope
        ? { shell_environment_policy: buildCallerShellPolicy(callerToken, workspace) as unknown as JsonValue }
        : {}),
    },
  });
  if (openScope) {
    agentTabManager.bindThread({
      agentId: `fork-${nanoid()}`, callerToken, threadId, workspacePath: workspace, modelConfig,
    });
  }

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
    clientUserMessageId: options.clientUserMessageId,
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
    ...(result.refusal && { refusal: result.refusal }),
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
