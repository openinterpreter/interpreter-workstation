import { nanoid } from 'nanoid';
import type { v2 } from '../handlers/codex-generated-types/index';
import type { ServerNotification } from '../handlers/codex-generated-types/index';
import type { JsonValue } from '../handlers/codex-generated-types/serde_json/JsonValue';
import {
  getCodexNetworkAccess,
  getCodexReadAccessMode,
  getCodexSandboxMode,
  getCustomInstructions,
  getProfile as getStoredProfile,
} from '../configStore';
import { getServerJWT } from '../lib/jwtStore';
import { getServerPort } from './serverPort';
import { validateRuntimeModelId } from './runtimeModelValidation';
import { formatLocalModelToolUseError, resolveLocalModelToolUseSupport, getOllamaVersion } from '../handlers/providers';
import { requiresFreshThread } from './codexThreadRecovery';
import { appendCustomInstructionsToPrompt } from './customInstructions';
import { getCodexService } from './codexSkillsBridge';
import {
  getMainAgentBaseInstructions,
  getMainAgentDeveloperPrompt,
  type PromptVisibleSkill,
} from './mainAgentPrompt';
import {
  buildInterpreterCliServerConnection,
  buildInterpreterCliShellEnvironmentPolicy,
  materializeInterpreterCliLauncher,
  type InterpreterCliRuntimeTransport,
} from './interpreterCliRuntime';
import { agentTabManager } from '../agentTabManager';
import { listInterpreterCliServerTools, listInterpreterCliTools } from '../handlers/interpreterCli';
import { getInterpreterUserDataDir } from './skillsPaths';
import type { AgentModelConfig } from '../../shared/types/model';
import type { ReasoningEffort } from '../../shared/types/reasoning';
import {
  buildAppManagedModelProviderId,
  buildProfileFromPreset,
  getCustomPreset,
  getProfile as getCodexProfile,
  isCustomPreset,
  isProfileId,
  type Profile as CodexProfile,
  withAuthToken,
} from '../../src/lib/codex/profiles';
import { inferProfileIdFromEndpoint } from '../../src/lib/codex/profile-options';
import type {
  StreamImageAttachment,
  StreamSkillReference,
} from '../../src/lib/codex/api-types';
import {
  SERVER_METHOD,
  type NotificationOfMethod,
} from '../../src/lib/codex/protocol';
import type { CodexService, StreamEvent } from '../../src/lib/codex/service';
import type {
  ExplicitStreamRequest,
  NormalizedStreamRequest,
  StoredProfileStreamRequest,
} from '../routes/agentStreamRequest';
import { selectRequestedRuntimeModel } from '../routes/agentStreamRequest';
import type { Profile as AppProfile } from '../../shared/types/profile';
import { profileToModelConfig } from '../../shared/types/profile';
import type { AgentPermissionOwnerReference } from '../../shared/types/approval';
import {
  getLocalModelProviderRuntime,
  getProviderApiFormat,
  getProviderBaseURL,
  isDeepSeekApiBaseURL,
  resolveLocalRuntimeModelId,
} from '../../shared/types/provider';
import { hasHostedApi } from '../../shared/productConfig';
import { getProvider as getStoredProvider } from '../services/providerStore';
import {
  formatTurnError,
  type TurnErrorFormattingContext,
} from '../../src/lib/codex/errors';

export const FRESH_THREAD_REQUIRED_MESSAGE = 'This chat needs a fresh thread. Codex failed while replaying earlier reasoning history. Start a new chat, or use "Start new chat with history".';
const ATTACHED_OVERLAY_COMPLETION_RETRY_LIMIT = 3;
const IDLE_TURN_RECOVERY_RETRY_LIMIT = 3;
const PROMPT_BUNDLED_SKILL_NAMES = [
  'doc',
  'spreadsheets',
  'slides',
  ...(hasHostedApi() ? ['media-creation'] : []),
  'pdf',
  'transcribe',
  'playwright',
  'settings',
  'browser-control',
] as const;
const PROMPT_BUNDLED_SKILL_NAME_SET = new Set<string>(PROMPT_BUNDLED_SKILL_NAMES);
const NATIVE_RUNTIME_TRANSCRIPT_TOOLS = [
  {
    name: 'update_plan',
    description: 'Updates the task plan/checklist with steps and statuses.',
    inputSchema: {
      type: 'object',
      properties: {
        explanation: { type: 'string' },
        plan: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              step: { type: 'string' },
              status: {
                type: 'string',
                description: 'One of: pending, in_progress, completed',
              },
            },
            required: ['step', 'status'],
            additionalProperties: false,
          },
        },
      },
      required: ['plan'],
      additionalProperties: false,
    },
  },
] as const;
const RUNTIME_SKILL_SCOPE_PRIORITY: Record<v2.SkillScope, number> = {
  repo: 3,
  user: 2,
  system: 1,
  admin: 0,
};

type CodexReasoningSummary = 'auto' | 'concise' | 'detailed' | 'none';
type VisibleRuntimeSkill = {
  name: string;
  description: string;
  path: string;
  scope: v2.SkillScope;
};
type RuntimeSkillMetadata = Pick<v2.SkillMetadata, 'name' | 'description' | 'shortDescription' | 'path' | 'scope' | 'enabled'>;

type TurnAttemptDiagnostics = {
  threadId: string | null;
  turnId: string | null;
  progressEvents: number;
  toolCalls: number;
  assistantMessages: number;
  userMessages: number;
  reasoningEvents: number;
  reasoningSummaryDeltas: number;
  finalAnswerSeen: boolean;
  lastAssistantPhase: string | null;
};

type IdleRecoveryProgressNotificationMethod =
  | typeof SERVER_METHOD.turnPlanUpdated
  | typeof SERVER_METHOD.itemStarted
  | typeof SERVER_METHOD.itemCompleted
  | typeof SERVER_METHOD.rawResponseItemCompleted
  | typeof SERVER_METHOD.agentMessageDelta
  | typeof SERVER_METHOD.planDelta
  | typeof SERVER_METHOD.reasoningSummaryTextDelta
  | typeof SERVER_METHOD.reasoningSummaryPartAdded
  | typeof SERVER_METHOD.commandExecutionOutputDelta
  | typeof SERVER_METHOD.commandExecutionTerminalInteraction
  | typeof SERVER_METHOD.fileChangeOutputDelta
  | typeof SERVER_METHOD.mcpToolCallProgress;

const IDLE_RECOVERY_PROGRESS_NOTIFICATION_METHODS: ReadonlySet<ServerNotification["method"]> = new Set([
  SERVER_METHOD.turnPlanUpdated,
  SERVER_METHOD.itemStarted,
  SERVER_METHOD.itemCompleted,
  SERVER_METHOD.rawResponseItemCompleted,
  SERVER_METHOD.agentMessageDelta,
  SERVER_METHOD.planDelta,
  SERVER_METHOD.reasoningSummaryTextDelta,
  SERVER_METHOD.reasoningSummaryPartAdded,
  SERVER_METHOD.commandExecutionOutputDelta,
  SERVER_METHOD.commandExecutionTerminalInteraction,
  SERVER_METHOD.fileChangeOutputDelta,
  SERVER_METHOD.mcpToolCallProgress,
]);

function isIdleRecoveryProgressNotification(
  notification: ServerNotification,
): notification is NotificationOfMethod<IdleRecoveryProgressNotificationMethod> {
  return IDLE_RECOVERY_PROGRESS_NOTIFICATION_METHODS.has(notification.method);
}

function createTurnAttemptDiagnostics(): TurnAttemptDiagnostics {
  return {
    threadId: null,
    turnId: null,
    progressEvents: 0,
    toolCalls: 0,
    assistantMessages: 0,
    userMessages: 0,
    reasoningEvents: 0,
    reasoningSummaryDeltas: 0,
    finalAnswerSeen: false,
    lastAssistantPhase: null,
  };
}

function recordNotificationTurnIdentity(
  diagnostics: TurnAttemptDiagnostics,
  notification: NotificationOfMethod<IdleRecoveryProgressNotificationMethod>,
): void {
  diagnostics.threadId = notification.params.threadId;
  diagnostics.turnId = notification.params.turnId;
}

function recordFinalAnswerPhase(
  diagnostics: TurnAttemptDiagnostics,
  notification: ServerNotification,
): void {
  if (
    notification.method === SERVER_METHOD.itemStarted
    || notification.method === SERVER_METHOD.itemCompleted
  ) {
    const item = notification.params.item;
    if (item?.type === 'agentMessage') {
      diagnostics.lastAssistantPhase = item.phase ?? diagnostics.lastAssistantPhase;
      if (item.phase === 'final_answer') {
        diagnostics.finalAnswerSeen = true;
      }
    }
    return;
  }

  if (notification.method === SERVER_METHOD.rawResponseItemCompleted) {
    const item = notification.params.item;
    if (item.type === 'message') {
      diagnostics.lastAssistantPhase = item.phase ?? diagnostics.lastAssistantPhase;
      if (item.phase === 'final_answer') {
        diagnostics.finalAnswerSeen = true;
      }
    }
  }
}

function recordTurnAttemptDiagnostics(
  diagnostics: TurnAttemptDiagnostics,
  event: StreamEvent,
): void {
  if (event.kind === 'thread') {
    diagnostics.threadId = event.threadId;
    return;
  }

  if (event.kind === 'turn') {
    diagnostics.threadId = event.threadId;
    diagnostics.turnId = event.turnId;
    return;
  }

  if (event.kind !== 'notification') {
    return;
  }

  const notification = event.notification;
  if (isIdleRecoveryProgressNotification(notification)) {
    recordNotificationTurnIdentity(diagnostics, notification);
    recordFinalAnswerPhase(diagnostics, notification);
    diagnostics.progressEvents += 1;
  }

  if (notification.method === SERVER_METHOD.agentMessageDelta) {
    diagnostics.assistantMessages += 1;
    return;
  }

  if (notification.method === SERVER_METHOD.reasoningSummaryTextDelta) {
    diagnostics.reasoningSummaryDeltas += 1;
    return;
  }

  if (
    notification.method !== SERVER_METHOD.itemStarted
    && notification.method !== SERVER_METHOD.itemCompleted
  ) {
    return;
  }

  const item = notification.params.item;
  if (!item) {
    return;
  }

  if (
    notification.method === SERVER_METHOD.itemStarted
    && (item.type === 'mcpToolCall' || item.type === 'commandExecution')
  ) {
    diagnostics.toolCalls += 1;
  }

  if (notification.method === SERVER_METHOD.itemStarted && item.type === 'reasoning') {
    diagnostics.reasoningEvents += 1;
  }

  if (notification.method === SERVER_METHOD.itemStarted && item.type === 'agentMessage') {
    diagnostics.assistantMessages += 1;
  }

  if (notification.method === SERVER_METHOD.itemCompleted && item.type === 'userMessage') {
    diagnostics.userMessages += 1;
  }
}

function isIdleTurnError(error: unknown): error is Error {
  return error instanceof Error
    && error.message.includes('went idle for')
    && error.message.includes('without reaching turn/completed');
}

/*
 * Issue #1187: local LM Studio turns can keep producing valid progress events
 * (reasoning, commands, or commentary) and then stall before the terminal
 * turn/completed event. Retry those partial-progress stalls in the same thread
 * so long PDF/document tasks can continue, but keep the recovery bounded:
 * - never retry after a final answer started
 * - allow recovery only after typed turn-progress notifications
 */
function shouldRetryIdleTurn(diagnostics: TurnAttemptDiagnostics): boolean {
  if (diagnostics.finalAnswerSeen) {
    return false;
  }

  return diagnostics.progressEvents > 0;
}

function canRetryIdleTurn(
  diagnostics: TurnAttemptDiagnostics,
  idleRecoveryAttempt: number,
): boolean {
  if (
    idleRecoveryAttempt >= IDLE_TURN_RECOVERY_RETRY_LIMIT
    || !shouldRetryIdleTurn(diagnostics)
  ) {
    return false;
  }

  return idleRecoveryAttempt === 0
    || diagnostics.progressEvents > 0;
}

function buildIdleTurnRecoveryMessage(): string {
  return 'The previous turn stalled before completing. Continue the same task from the existing context. If you already sent commentary or a deliverable-focused plan, do not repeat it; resume with the next concrete step. Use bundled skills and available tools naturally.';
}

export function resolveAgentInterpreterCliTransport(
  platform: NodeJS.Platform = process.platform,
): InterpreterCliRuntimeTransport {
  return platform === 'win32' ? 'http' : 'file';
}

export interface AgentRuntimeBindingOptions {
  agentId: string;
  callerToken?: string;
  workspacePath?: string;
  allowedToolNames?: string[];
  modelConfig?: AgentModelConfig;
  toolProfileId?: string;
  parentOwner?: AgentPermissionOwnerReference;
}

export interface RunCodexAgentTurnOptions {
  service: CodexService;
  profile: CodexProfile;
  requestedModel?: string;
  usesChatGptAuth?: boolean;
  workspacePath: string;
  message?: string;
  attachments?: StreamImageAttachment[];
  skills?: StreamSkillReference[];
  threadId?: string;
  binding: AgentRuntimeBindingOptions;
  sandboxPolicy?: v2.SandboxPolicy;
  reasoningEffort?: ReasoningEffort | null;
  reasoningSummary?: CodexReasoningSummary | null;
  system?: string;
  config?: Record<string, JsonValue> | null;
  idleTimeoutMs?: number | null;
  signal?: AbortSignal;
  inspectExistingThread?: boolean;
  onEvent?: (event: StreamEvent) => void;
  turnErrorContext?: TurnErrorFormattingContext;
}

function buildProfileSyncResetMessage(reason: string): string {
  return `${reason} Please reset your model preferences in Settings > Models.`;
}

export async function ensureOpenAIOAuthAccountReady(
  service: Pick<CodexService, 'getAccount'>,
  isChatGptProfile: boolean,
): Promise<void> {
  if (!isChatGptProfile) {
    return;
  }

  const { account } = await service.getAccount(true);
  if (account?.type !== 'chatgpt') {
    throw new Error('OpenAI account is not connected. Sign in with OpenAI in Settings > Models and try again.');
  }
}

function buildAttachedOverlayContinuationMessage(attempt: number): string {
  const prefix = attempt <= 1
    ? 'The live Interpreter Overlay session is still attached.'
    : `The live Interpreter Overlay session is still attached after reminder ${attempt - 1}.`;

  return `${prefix} Do not finish this turn while the live overlay session remains attached. Re-read the granted square if needed. If the task is not actually complete, keep using overlay tools until the visible UI matches the request. If this is a form or other UI-completion task and a final visible action such as Save, Submit, Send, Create, or Continue is still required, activate that control before detaching. Once live overlay work is truly done, call \`overlay_complete\` (or \`overlay_detach\` if you intentionally need to continue without the live overlay) before you end the turn.`;
}

function toGroqProxyBaseUrl(): string {
  return `http://localhost:${getServerPort()}/api/agent/groq-proxy`;
}

function routeGroqThroughProxy(profile: CodexProfile): CodexProfile {
  if (profile.modelProvider !== 'groq' || !profile.providerConfig) {
    return profile;
  }

  return {
    ...profile,
    providerConfig: {
      ...profile.providerConfig,
      base_url: toGroqProxyBaseUrl(),
    },
  };
}

function codexProfileFromExplicitId(
  codexProfileId: string,
  request: ExplicitStreamRequest,
): CodexProfile {
  if (!isProfileId(codexProfileId)) {
    throw new Error(buildProfileSyncResetMessage(`Unknown codex profile: ${codexProfileId}.`));
  }
  const preset = isCustomPreset(codexProfileId) ? getCustomPreset(codexProfileId) : undefined;
  return preset
    ? buildProfileFromPreset(preset, {
      baseUrl: request.customEndpoint,
      apiKey: request.customApiKey,
      model: request.model,
    })
    : getCodexProfile(codexProfileId);
}

function resolveEnvironmentApiKey(environmentKey: string | undefined): string | undefined {
  const key = environmentKey?.trim();
  return key ? process.env[key]?.trim() || undefined : undefined;
}

async function hydrateStoredProfileProviderConfig(profile: AppProfile): Promise<AppProfile> {
  const environmentApiKey = resolveEnvironmentApiKey(profile.environmentKey);
  if (!profile.providerId) {
    return environmentApiKey && !profile.apiKey
      ? { ...profile, apiKey: environmentApiKey }
      : profile;
  }

  const provider = await getStoredProvider(profile.providerId);
  if (!provider) {
    throw new Error(
      buildProfileSyncResetMessage(`Provider "${profile.providerId}" was not found.`),
    );
  }

  return {
    ...profile,
    apiKey: profile.apiKey ?? environmentApiKey ?? provider.apiKey,
    baseURL: profile.baseURL ?? getProviderBaseURL(provider),
    apiFormat:
      profile.apiFormat
      ?? (provider.type === 'api' ? getProviderApiFormat(provider) : undefined),
    wireApi:
      profile.wireApi
      ?? (provider.type === 'api' ? provider.api?.wireApi : undefined),
  };
}

function codexProfileFromStoredProfile(profile: AppProfile): CodexProfile {
  if (profile.provider === 'api' && isDeepSeekApiBaseURL(profile.baseURL)) {
    const preset = getCustomPreset('deepseek');
    if (!preset) {
      throw new Error(buildProfileSyncResetMessage('Unknown codex profile: deepseek.'));
    }
    return buildProfileFromPreset(preset, {
      baseUrl: profile.baseURL,
      apiKey: profile.apiKey,
      model: profile.modelId,
      wireApi: 'chat',
    });
  }

  if (profile.codexProfileId && isProfileId(profile.codexProfileId)) {
    const preset = isCustomPreset(profile.codexProfileId)
      ? getCustomPreset(profile.codexProfileId)
      : undefined;
    if (preset) {
      return buildProfileFromPreset(preset, {
        baseUrl: profile.baseURL,
        apiKey: profile.apiKey,
        model: profile.modelId,
        // Local providers (Ollama/LM Studio) honor an explicit wireApi override
        // too; buildProfileFromPreset falls back to the preset default when unset.
        wireApi: profile.wireApi,
      });
    }

    return codexProfileFromExplicitId(profile.codexProfileId, {
      selection: 'explicit',
      agentId: undefined,
      callerToken: undefined,
      attachments: [],
      skills: [],
      customApiKey: profile.apiKey,
      customEndpoint: profile.baseURL,
      message: undefined,
      model: profile.modelId,
      reasoningEffort: profile.reasoningEffort,
      threadId: undefined,
      workspacePath: undefined,
    });
  }

  if (profile.codexProfileId) {
    const wireApi = profile.wireApi
      ?? (profile.apiFormat === 'anthropic' ? 'messages' : 'responses');
    return {
      id: profile.codexProfileId,
      label: profile.name,
      modelProvider: profile.apiKey
        ? buildAppManagedModelProviderId(profile.codexProfileId)
        : profile.codexProfileId,
      model: profile.modelId || undefined,
      harness: profile.harness,
      ...(profile.baseURL && profile.apiKey
        ? {
            providerConfig: {
              base_url: profile.baseURL,
              name: profile.name,
              requires_openai_auth: false,
              wire_api: wireApi,
              ...(profile.apiKey
                ? {
                    experimental_bearer_token: profile.apiKey,
                    http_headers: {
                      Authorization: `Bearer ${profile.apiKey}`,
                      ...(wireApi === 'messages' ? { 'x-api-key': profile.apiKey } : {}),
                    },
                  }
                : {}),
            },
          }
        : {}),
    };
  }

  if (profile.provider === 'hosted') {
    return getCodexProfile('interpreter');
  }

  if (profile.provider === 'openai-oauth') {
    return getCodexProfile('default');
  }

  if (profile.provider === 'local' || profile.provider === 'api') {
    const endpoint = profile.baseURL || '';
    const presetId = inferProfileIdFromEndpoint(endpoint);
    const preset = getCustomPreset(presetId);
    if (!preset) {
      throw new Error(buildProfileSyncResetMessage(`Unknown preset for endpoint: ${profile.baseURL || '<empty>'}.`));
    }
    return buildProfileFromPreset(preset, {
      baseUrl: profile.baseURL,
      apiKey: profile.apiKey,
      model: profile.modelId,
      wireApi: profile.wireApi,
    });
  }

  throw new Error(buildProfileSyncResetMessage(`Profile "${profile.name}" uses provider "${profile.provider}" which is not supported by the Codex runtime.`));
}

function applyStoredProfileRuntimeOverrides(
  profile: AppProfile,
  request: StoredProfileStreamRequest,
): AppProfile {
  return {
    ...profile,
    modelId: request.model ?? profile.modelId,
    codexProfileId: request.codexProfileId ?? profile.codexProfileId,
    baseURL: request.customEndpoint ?? profile.baseURL,
    apiKey: request.customApiKey ?? profile.apiKey,
  };
}

export async function resolveCodexProfileForStreamRequest(
  request: NormalizedStreamRequest,
): Promise<{
  profile: CodexProfile;
  requestedModel?: string;
  isChatGptProfile: boolean;
}> {
  if (request.selection === 'stored-profile') {
    const storedProfile = await getStoredProfile(request.profileId);
    if (!storedProfile) {
      throw new Error(buildProfileSyncResetMessage(`Profile "${request.profileId}" was not found.`));
    }
    const effectiveProfile = applyStoredProfileRuntimeOverrides(
      storedProfile,
      request,
    );
    return {
      profile: {
        ...codexProfileFromStoredProfile(
          await hydrateStoredProfileProviderConfig(effectiveProfile),
        ),
        ...(effectiveProfile.harness !== undefined
          ? { harness: effectiveProfile.harness }
          : {}),
      },
      requestedModel: selectRequestedRuntimeModel(request, effectiveProfile.modelId),
      isChatGptProfile: storedProfile.provider === 'openai-oauth',
    };
  }

  if (request.codexProfileId && isProfileId(request.codexProfileId)) {
    const profile = codexProfileFromExplicitId(request.codexProfileId, request);
    return {
      profile,
      requestedModel: selectRequestedRuntimeModel(request, profile.model),
      isChatGptProfile: false,
    };
  }

  if (request.customEndpoint) {
    const presetId = inferProfileIdFromEndpoint(request.customEndpoint);
    const preset = getCustomPreset(presetId);
    if (!preset) {
      throw new Error(buildProfileSyncResetMessage(`Unknown preset for endpoint: ${request.customEndpoint}.`));
    }
    const profile = buildProfileFromPreset(preset, {
      baseUrl: request.customEndpoint,
      apiKey: request.customApiKey,
      model: request.model,
    });
    return {
      profile,
      requestedModel: selectRequestedRuntimeModel(request, profile.model),
      isChatGptProfile: false,
    };
  }

  if (request.model?.startsWith('interpreter-')) {
    const profile = getCodexProfile('interpreter');
    return {
      profile,
      requestedModel: selectRequestedRuntimeModel(request, profile.model),
      isChatGptProfile: false,
    };
  }

  throw new Error(buildProfileSyncResetMessage('No resolvable profile was provided for this request.'));
}

export async function resolveAgentModelConfigForStreamRequest(
  request: NormalizedStreamRequest,
): Promise<AgentModelConfig | undefined> {
  if (request.selection === 'stored-profile') {
    const storedProfile = await getStoredProfile(request.profileId);
    if (!storedProfile) {
      throw new Error(buildProfileSyncResetMessage(`Profile "${request.profileId}" was not found.`));
    }
    const effectiveProfile = applyStoredProfileRuntimeOverrides(
      await hydrateStoredProfileProviderConfig(storedProfile),
      request,
    );
    return profileToModelConfig(effectiveProfile);
  }

  if (request.customEndpoint) {
    const presetId = inferProfileIdFromEndpoint(request.customEndpoint);
    return {
      provider: presetId === 'ollama' || presetId === 'lmstudio' ? 'local' : 'api',
      modelId: request.model ?? '',
      baseURL: request.customEndpoint,
      apiKey: request.customApiKey,
      apiFormat: 'openai',
      codexProfileId: request.codexProfileId ?? presetId,
      wireApi: presetId === 'deepseek' ? 'chat' : undefined,
      useResponsesApi: presetId === 'deepseek' ? false : undefined,
      reasoningEffort: request.reasoningEffort,
    };
  }

  if (request.model?.startsWith('interpreter-')) {
    return {
      provider: 'hosted',
      modelId: request.model,
      reasoningEffort: request.reasoningEffort,
    };
  }

  if (request.model) {
    return {
      provider: 'openai-oauth',
      modelId: request.model,
      codexProfileId: request.codexProfileId,
      reasoningEffort: request.reasoningEffort,
    };
  }

  return undefined;
}

function withModelConfigHarness(
  profile: CodexProfile,
  modelConfig: AgentModelConfig,
): CodexProfile {
  return modelConfig.harness === undefined
    ? profile
    : { ...profile, harness: modelConfig.harness };
}

export function resolveCodexProfileFromModelConfig(
  modelConfig: AgentModelConfig,
): CodexProfile {
  if (modelConfig.codexProfileId && isProfileId(modelConfig.codexProfileId)) {
    const explicit = isDeepSeekApiBaseURL(modelConfig.baseURL)
      ? 'deepseek'
      : modelConfig.codexProfileId;
    if (isCustomPreset(explicit)) {
      const preset = getCustomPreset(explicit);
      if (!preset) {
        throw new Error(`Unknown custom Codex preset: ${explicit}`);
      }
      return withModelConfigHarness(buildProfileFromPreset(preset, {
        baseUrl: modelConfig.baseURL,
        apiKey: modelConfig.apiKey,
        environmentKey: modelConfig.environmentKey,
        model: modelConfig.modelId,
        wireApi: explicit === 'deepseek' ? 'chat' : modelConfig.wireApi,
      }), modelConfig);
    }
    return withModelConfigHarness(getCodexProfile(explicit), modelConfig);
  }

  if (modelConfig.codexProfileId) {
    const wireApi = modelConfig.wireApi
      ?? (modelConfig.apiFormat === 'anthropic' ? 'messages' : 'responses');
    return withModelConfigHarness({
      id: modelConfig.codexProfileId,
      label: modelConfig.codexProfileId,
      modelProvider: modelConfig.apiKey || modelConfig.environmentKey
        ? buildAppManagedModelProviderId(modelConfig.codexProfileId)
        : modelConfig.codexProfileId,
      model: modelConfig.modelId || undefined,
      ...(modelConfig.baseURL && (modelConfig.apiKey || modelConfig.environmentKey)
        ? {
            providerConfig: {
              base_url: modelConfig.baseURL,
              name: modelConfig.codexProfileId,
              requires_openai_auth: false,
              wire_api: wireApi,
              ...(!modelConfig.apiKey && modelConfig.environmentKey
                ? { env_key: modelConfig.environmentKey }
                : {}),
              ...(modelConfig.apiKey
                ? {
                    experimental_bearer_token: modelConfig.apiKey,
                    http_headers: {
                      Authorization: `Bearer ${modelConfig.apiKey}`,
                      ...(wireApi === 'messages' ? { 'x-api-key': modelConfig.apiKey } : {}),
                    },
                  }
                : {}),
            },
          }
        : {}),
    }, modelConfig);
  }

  if (modelConfig.provider === 'hosted') {
    return withModelConfigHarness(getCodexProfile('interpreter'), modelConfig);
  }

  if (modelConfig.provider === 'openai-oauth') {
    return withModelConfigHarness(getCodexProfile('default'), modelConfig);
  }

  if (modelConfig.provider === 'local' || modelConfig.provider === 'api') {
    const endpoint = modelConfig.baseURL || '';
    const presetId = inferProfileIdFromEndpoint(endpoint);
    const preset = getCustomPreset(presetId);
    if (!preset) {
      throw new Error(`Unknown Codex preset for endpoint: ${endpoint || '<empty>'}`);
    }
    return withModelConfigHarness(buildProfileFromPreset(preset, {
      baseUrl: modelConfig.baseURL,
      apiKey: modelConfig.apiKey,
      environmentKey: modelConfig.environmentKey,
      model: modelConfig.modelId,
      wireApi: presetId === 'deepseek' ? 'chat' : modelConfig.wireApi,
    }), modelConfig);
  }

  throw new Error(`Provider "${modelConfig.provider}" is not supported by the Codex runtime`);
}

function appendTaskSpecificInstructions(
  developerInstructions: string,
  system: string | undefined,
): string {
  if (!system?.trim()) {
    return developerInstructions;
  }
  return `${developerInstructions}\n\n## Task-Specific Instructions\n${system.trim()}`;
}

export async function buildCodexDeveloperInstructions(options: {
  modelId: string;
  interpreterCliAvailable: boolean;
  interpreterCliPath?: string;
  workspacePath?: string;
  system?: string;
  runtimeSkills?: RuntimeSkillMetadata[];
}): Promise<string> {
  const [networkAccessEnabled, sandboxMode, readAccessMode, runtimeSkills] = await Promise.all([
    getCodexNetworkAccess(),
    getCodexSandboxMode(),
    getCodexReadAccessMode(),
    options.runtimeSkills
      ? Promise.resolve(options.runtimeSkills)
      : loadRuntimeSkillMetadata(options.workspacePath, 'prompt construction'),
  ]);
  const bundledSkillNames = listEnabledPromptBundledSkillNames(runtimeSkills);
  let developerInstructions = getMainAgentDeveloperPrompt(
    options.modelId,
    options.interpreterCliAvailable,
    options.interpreterCliPath,
    {
      injectAppToolsAsMcp: false,
      bundledSkillNames,
      networkAccessEnabled,
      sandboxMode,
      readAccessMode,
      visibleSkills: getPromptVisibleSkills(runtimeSkills),
    },
  );
  if (process.env.DEMO_PROMPT) {
    developerInstructions += `\n\n${process.env.DEMO_PROMPT}`;
  }
  const customInstructions = await getCustomInstructions();
  developerInstructions = appendCustomInstructionsToPrompt(
    developerInstructions,
    customInstructions,
  );
  return appendTaskSpecificInstructions(developerInstructions, options.system);
}

async function loadRuntimeSkillMetadata(
  workspacePath: string | undefined,
  purpose: string,
  service: Pick<CodexService, 'listSkills'> = getCodexService(),
): Promise<RuntimeSkillMetadata[]> {
  const cwd = workspacePath || getInterpreterUserDataDir();

  if (typeof service.listSkills !== 'function') {
    return [];
  }

  try {
    const response = await service.listSkills({
      cwds: [cwd],
    });
    const entry = response.data.find((item) => item.cwd === cwd) ?? response.data[0];
    return entry?.skills ?? [];
  } catch (error) {
    console.warn(
      `[Agent Runtime] Failed to inspect enabled bundled skills for ${purpose}.`,
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

function listEnabledPromptBundledSkillNames(skills: RuntimeSkillMetadata[]): string[] {
  const enabledSkillNames = new Set(
    skills
      .filter((skill) => (
        (skill.scope === 'user' || skill.scope === 'system')
        && skill.enabled
        && PROMPT_BUNDLED_SKILL_NAME_SET.has(skill.name)
      ))
      .map((skill) => skill.name),
  );

  return PROMPT_BUNDLED_SKILL_NAMES.filter((skillName) => enabledSkillNames.has(skillName));
}

export function summarizeVisibleRuntimeSkills(
  skills: RuntimeSkillMetadata[],
): VisibleRuntimeSkill[] {
  const visibleSkillsByName = new Map<string, VisibleRuntimeSkill>();

  for (const skill of skills) {
    if (!skill.enabled) {
      continue;
    }

    const visibleSkill: VisibleRuntimeSkill = {
      name: skill.name,
      description: (skill.description || skill.shortDescription || '').trim(),
      path: skill.path,
      scope: skill.scope,
    };

    const existingSkill = visibleSkillsByName.get(skill.name);
    if (!existingSkill) {
      visibleSkillsByName.set(skill.name, visibleSkill);
      continue;
    }

    if (RUNTIME_SKILL_SCOPE_PRIORITY[skill.scope] > RUNTIME_SKILL_SCOPE_PRIORITY[existingSkill.scope]) {
      visibleSkillsByName.set(skill.name, visibleSkill);
    }
  }

  return Array.from(visibleSkillsByName.values())
    .sort((left, right) => left.name.localeCompare(right.name));
}

function getPromptVisibleSkills(skills: RuntimeSkillMetadata[]): PromptVisibleSkill[] {
  return summarizeVisibleRuntimeSkills(skills).map((skill) => ({
    name: skill.name,
    description: skill.description,
    path: skill.path,
    scope: skill.scope,
  }));
}

function normalizeBinding(
  binding: AgentRuntimeBindingOptions,
): Required<Pick<AgentRuntimeBindingOptions, 'agentId'>> & AgentRuntimeBindingOptions {
  return {
    ...binding,
    allowedToolNames: binding.allowedToolNames && binding.allowedToolNames.length > 0
      ? Array.from(new Set(binding.allowedToolNames))
      : undefined,
  };
}

function createRuntimeCallerToken(): string {
  return `agtok_${nanoid()}`;
}

type StructuredAgentRuntimeNotificationMethod =
  | typeof SERVER_METHOD.itemStarted
  | typeof SERVER_METHOD.itemCompleted
  | typeof SERVER_METHOD.turnCompleted
  | typeof SERVER_METHOD.turnPlanUpdated
  | typeof SERVER_METHOD.streamError
  | typeof SERVER_METHOD.threadNameUpdated;

const STRUCTURED_AGENT_RUNTIME_NOTIFICATION_METHODS = new Set<ServerNotification["method"]>([
  SERVER_METHOD.itemStarted,
  SERVER_METHOD.itemCompleted,
  SERVER_METHOD.turnCompleted,
  SERVER_METHOD.turnPlanUpdated,
  SERVER_METHOD.streamError,
  SERVER_METHOD.threadNameUpdated,
]);

function isStructuredAgentRuntimeNotificationMethod(
  method: ServerNotification["method"],
): method is StructuredAgentRuntimeNotificationMethod {
  return STRUCTURED_AGENT_RUNTIME_NOTIFICATION_METHODS.has(method);
}

function truncateLogValue(value: string, maxLength = 160): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 3)}...`;
}

type StructuredLogField = string | number | boolean | null | undefined;

function formatStructuredLogValue(
  value: StructuredLogField,
  maxLength = 160,
): string {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  const normalized = truncateLogValue(value.replace(/\s+/g, ' ').trim(), maxLength);
  if (normalized.length === 0) {
    return '""';
  }
  return /^[A-Za-z0-9._:/-]+$/.test(normalized)
    ? normalized
    : JSON.stringify(normalized);
}

function formatStructuredLogFields<T extends Record<string, StructuredLogField>>(
  fields: T,
  options?: {
    maxLengthByKey?: Partial<Record<Extract<keyof T, string>, number>>;
  },
): string {
  // Most log fields should stay short, but a few error previews need a wider cap
  // without reintroducing wrapper/sentinel values into the field map.
  return Object.entries(fields)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => {
      const maxLength = options?.maxLengthByKey?.[key as Extract<keyof T, string>];
      return `${key}=${formatStructuredLogValue(value, maxLength)}`;
    })
    .join(' ');
}

type SessionLogLine = {
  level: 'log' | 'warn' | 'error';
  prefix: string;
  message: string;
};

function summarizePreview(value: string | null | undefined, maxLength = 160): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) {
    return undefined;
  }
  return truncateLogValue(normalized, maxLength);
}

function summarizeJsonPreview(value: unknown, maxLength = 160): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    return summarizePreview(value, maxLength);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return summarizePreview(String(value), maxLength);
  }
  return summarizePreview(JSON.stringify(value), maxLength);
}

type ScalarCodexErrorInfo = Exclude<v2.CodexErrorInfo, Record<string, unknown>>;

type TurnErrorInfoCode =
  | ScalarCodexErrorInfo
  | 'httpConnectionFailed'
  | 'responseStreamConnectionFailed'
  | 'responseStreamDisconnected'
  | 'responseTooManyFailedAttempts'
  | 'activeTurnNotSteerable'
  | 'none';

type TurnErrorKindSummary = {
  codexErrorInfo: TurnErrorInfoCode;
  httpStatusCode?: number;
  turnKind?: string;
};

type TurnErrorLogSummary = TurnErrorKindSummary & {
  rawMessagePreview: string;
  formattedMessagePreview: string;
  formattedChanged: boolean;
  additionalDetailsPreview?: string;
};

// Repo-local runtime telemetry only sees the app-server TurnError payload:
// `message`, `codexErrorInfo`, and `additionalDetails`.
// See `server/handlers/codex-generated-types/v2/TurnError.ts`.
// The full upstream provider body is already gone by this point, so the best
// local forensic artifact is "what app-server sent" plus "what the shared UI
// formatter turned that into".
const TURN_ERROR_LOG_MAX_LENGTH = 1200;
const TURN_ERROR_LOG_FIELD_MAX_LENGTHS = {
  rawMessagePreview: TURN_ERROR_LOG_MAX_LENGTH,
  formattedMessagePreview: TURN_ERROR_LOG_MAX_LENGTH,
  additionalDetailsPreview: TURN_ERROR_LOG_MAX_LENGTH,
} as const;

function summarizeCodexErrorInfo(
  codexErrorInfo: v2.TurnError['codexErrorInfo'],
): TurnErrorKindSummary {
  if (codexErrorInfo === null) {
    return { codexErrorInfo: 'none' };
  }

  if (typeof codexErrorInfo === 'string') {
    return { codexErrorInfo };
  }

  if ('httpConnectionFailed' in codexErrorInfo) {
    return {
      codexErrorInfo: 'httpConnectionFailed',
      httpStatusCode: codexErrorInfo.httpConnectionFailed.httpStatusCode ?? undefined,
    };
  }

  if ('responseStreamConnectionFailed' in codexErrorInfo) {
    return {
      codexErrorInfo: 'responseStreamConnectionFailed',
      httpStatusCode: codexErrorInfo.responseStreamConnectionFailed.httpStatusCode ?? undefined,
    };
  }

  if ('responseStreamDisconnected' in codexErrorInfo) {
    return {
      codexErrorInfo: 'responseStreamDisconnected',
      httpStatusCode: codexErrorInfo.responseStreamDisconnected.httpStatusCode ?? undefined,
    };
  }

  if ('responseTooManyFailedAttempts' in codexErrorInfo) {
    return {
      codexErrorInfo: 'responseTooManyFailedAttempts',
      httpStatusCode: codexErrorInfo.responseTooManyFailedAttempts.httpStatusCode ?? undefined,
    };
  }

  if ('activeTurnNotSteerable' in codexErrorInfo) {
    return {
      codexErrorInfo: 'activeTurnNotSteerable',
      turnKind: codexErrorInfo.activeTurnNotSteerable.turnKind,
    };
  }

  const exhaustiveCheck: never = codexErrorInfo;
  return exhaustiveCheck;
}

function summarizeTurnErrorForLog(
  error: v2.TurnError | null | undefined,
  context: TurnErrorFormattingContext = {},
): TurnErrorLogSummary | null {
  if (!error) {
    return null;
  }

  // Keep this in lockstep with `src/lib/codex/errors.ts::formatTurnError`.
  // Issue #1018 was specifically about raw provider diagnostics being collapsed
  // into generic UI copy, so support logs need both sides of that comparison.
  const formattedMessage = formatTurnError(error, context);
  return {
    ...summarizeCodexErrorInfo(error.codexErrorInfo),
    rawMessagePreview:
      summarizePreview(error.message, TURN_ERROR_LOG_MAX_LENGTH) ?? '',
    formattedMessagePreview:
      summarizePreview(formattedMessage, TURN_ERROR_LOG_MAX_LENGTH) ?? '',
    formattedChanged: formattedMessage.trim() !== error.message.trim(),
    additionalDetailsPreview: summarizePreview(
      error.additionalDetails,
      TURN_ERROR_LOG_MAX_LENGTH,
    ),
  };
}

function collectUserMessageParts(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }

  const bodyParts: string[] = [];
  const skillLines: string[] = [];

  for (const entry of content) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const typedEntry = entry as {
      type?: unknown;
      text?: unknown;
      path?: unknown;
      imageUrl?: unknown;
      name?: unknown;
    };
    if (typedEntry.type === 'text' && typeof typedEntry.text === 'string') {
      bodyParts.push(typedEntry.text);
      continue;
    }
    if (typedEntry.type === 'local_image' && typeof typedEntry.path === 'string') {
      bodyParts.push(`[local_image ${typedEntry.path}]`);
      continue;
    }
    if (typedEntry.type === 'input_image' && typeof typedEntry.imageUrl === 'string') {
      bodyParts.push(`[input_image ${typedEntry.imageUrl}]`);
      continue;
    }
    if (
      typedEntry.type === 'skill'
      && typeof typedEntry.name === 'string'
      && typeof typedEntry.path === 'string'
    ) {
      skillLines.push(`- ${typedEntry.name}: ${typedEntry.path}`);
    }
  }

  if (skillLines.length > 0) {
    bodyParts.push(`[attached_skills]\n${skillLines.join('\n')}\n[/attached_skills]`);
  }

  return bodyParts;
}

function extractUserMessageTranscript(content: unknown): string | undefined {
  const message = collectUserMessageParts(content).join('\n\n');
  return message.trim() ? message : undefined;
}

function extractUserMessagePreview(content: unknown): string | undefined {
  return summarizePreview(extractUserMessageTranscript(content));
}

function extractReasoningPreview(item: Extract<v2.ThreadItem, { type: 'reasoning' }>): string | undefined {
  return summarizePreview(item.summary.join('\n') || item.content.join('\n'));
}

function extractMcpResultPreview(item: Extract<v2.ThreadItem, { type: 'mcpToolCall' }>): string | undefined {
  if (item.error?.message) {
    return summarizePreview(`Error: ${item.error.message}`);
  }
  if (!item.result) {
    return undefined;
  }

  const textParts = item.result.content.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }
    const typedEntry = entry as { type?: unknown; text?: unknown };
    return typedEntry.type === 'text' && typeof typedEntry.text === 'string'
      ? [typedEntry.text]
      : [];
  });

  return summarizePreview(textParts.join('\n\n'))
    ?? summarizeJsonPreview(item.result.structuredContent ?? item.result.content);
}

function extractFileChangePreview(item: Extract<v2.ThreadItem, { type: 'fileChange' }>): string | undefined {
  return summarizePreview(item.changes.map((change) => change.diff).filter(Boolean).join('\n'));
}

function extractToolTranscriptName(item: v2.ThreadItem): string | null {
  switch (item.type) {
    case 'mcpToolCall':
      return item.tool;
    case 'commandExecution':
      return 'command_execution';
    case 'fileChange':
      return 'file_change';
    case 'collabAgentToolCall':
      return item.tool;
    case 'webSearch':
      return 'web_search';
    case 'imageView':
      return 'image_view';
    case 'enteredReviewMode':
      return 'entered_review_mode';
    case 'exitedReviewMode':
      return 'exited_review_mode';
    case 'contextCompaction':
      return 'context_compaction';
    case 'plan':
      return 'plan';
    default:
      return null;
  }
}

function extractToolTranscriptInput(item: v2.ThreadItem): unknown {
  switch (item.type) {
    case 'mcpToolCall':
      return item.arguments;
    case 'commandExecution':
      return {
        command: item.command,
        cwd: item.cwd,
      };
    case 'fileChange':
      return {
        status: item.status,
        changes: item.changes.map((change) => ({
          path: change.path,
          kind: change.kind,
        })),
      };
    case 'collabAgentToolCall':
      return {
        tool: item.tool,
        prompt: item.prompt,
        receiverThreadIds: item.receiverThreadIds,
      };
    case 'webSearch':
      return {
        query: item.query,
      };
    case 'imageView':
      return {
        path: item.path,
      };
    case 'enteredReviewMode':
    case 'exitedReviewMode':
      return {
        review: item.review,
      };
    case 'contextCompaction':
      return {
        status: 'completed',
      };
    case 'plan':
      return item.text;
    default:
      return undefined;
  }
}

function extractToolTranscriptOutput(item: v2.ThreadItem): unknown {
  switch (item.type) {
    case 'mcpToolCall':
      return item.error ?? item.result ?? {
        status: item.status,
        durationMs: item.durationMs,
      };
    case 'commandExecution':
      return item.aggregatedOutput ?? {
        status: item.status,
        exitCode: item.exitCode,
        durationMs: item.durationMs,
      };
    case 'fileChange':
      return item.changes.length > 0 ? item.changes : { status: item.status };
    case 'collabAgentToolCall':
      return {
        status: item.status,
        agentsStates: item.agentsStates,
      };
    case 'webSearch':
      return item.action ?? {
        query: item.query,
      };
    case 'imageView':
      return item.path;
    case 'enteredReviewMode':
    case 'exitedReviewMode':
      return item.review;
    case 'contextCompaction':
      return {
        status: 'completed',
      };
    case 'plan':
      return item.text;
    default:
      return undefined;
  }
}

function formatItemLifecycleLogLine(
  method: string,
  params: any,
): SessionLogLine {
  const item = params?.item as v2.ThreadItem | undefined;
  const phase = method === SERVER_METHOD.itemStarted ? 'started' : 'completed';
  const threadId = params?.threadId ?? null;
  const turnId = params?.turnId ?? null;

  if (!item) {
    return {
      level: 'log',
      prefix: 'AGENT_EVT',
      message: formatStructuredLogFields({
        kind: 'item',
        phase,
        threadId,
        turnId,
      }),
    };
  }

  switch (item.type) {
    case 'mcpToolCall':
      return {
        level: method === SERVER_METHOD.itemCompleted && item.status === 'failed' ? 'warn' : 'log',
        prefix: 'TOOL',
        message: formatStructuredLogFields({
          phase: method === SERVER_METHOD.itemStarted ? 'dispatch' : 'result',
          threadId,
          turnId,
          toolCallId: item.id,
          tool: item.tool,
          server: item.server,
          status: item.status ?? (method === SERVER_METHOD.itemStarted ? 'in_progress' : null),
          ok: method === SERVER_METHOD.itemCompleted
            ? item.status === 'completed'
            : undefined,
          durationMs: method === SERVER_METHOD.itemCompleted ? item.durationMs : undefined,
          argsPreview: method === SERVER_METHOD.itemStarted ? summarizeJsonPreview(item.arguments) : undefined,
          outputPreview: method === SERVER_METHOD.itemCompleted ? extractMcpResultPreview(item) : undefined,
        }),
      };

    case 'commandExecution':
      return {
        level: method === SERVER_METHOD.itemCompleted && item.status === 'failed' ? 'warn' : 'log',
        prefix: 'CMD',
        message: formatStructuredLogFields({
          phase: method === SERVER_METHOD.itemStarted ? 'dispatch' : 'result',
          threadId,
          turnId,
          itemId: item.id,
          status: item.status,
          ok: method === SERVER_METHOD.itemCompleted ? item.status === 'completed' : undefined,
          command: Array.isArray(item.command) ? item.command.join(' ') : item.command,
          exitCode: method === SERVER_METHOD.itemCompleted ? item.exitCode : undefined,
          durationMs: method === SERVER_METHOD.itemCompleted ? item.durationMs : undefined,
          outputPreview: method === SERVER_METHOD.itemCompleted ? summarizePreview(item.aggregatedOutput) : undefined,
        }),
      };

    case 'fileChange':
      return {
        level: method === SERVER_METHOD.itemCompleted && item.status === 'failed' ? 'warn' : 'log',
        prefix: 'TOOL',
        message: formatStructuredLogFields({
          phase: method === SERVER_METHOD.itemStarted ? 'dispatch' : 'result',
          threadId,
          turnId,
          itemId: item.id,
          tool: 'file_change',
          status: item.status,
          ok: method === SERVER_METHOD.itemCompleted ? item.status === 'completed' : undefined,
          changeCount: item.changes.length,
          pathsPreview: summarizeJsonPreview(
            item.changes.slice(0, 5).map((change) => change.path),
          ),
          outputPreview: method === SERVER_METHOD.itemCompleted ? extractFileChangePreview(item) : undefined,
        }),
      };

    case 'userMessage': {
      const preview = extractUserMessagePreview(item.content);
      return {
        level: 'log',
        prefix: 'AGENT',
        message: formatStructuredLogFields({
          kind: 'user_message',
          phase,
          threadId,
          turnId,
          itemId: item.id,
          chars: preview?.length ?? undefined,
          preview,
        }),
      };
    }

    case 'agentMessage': {
      const preview = summarizePreview(item.text);
      return {
        level: 'log',
        prefix: 'AGENT',
        message: formatStructuredLogFields({
          kind: 'assistant_message',
          phase,
          threadId,
          turnId,
          itemId: item.id,
          messagePhase: item.phase ?? undefined,
          chars: preview?.length ?? undefined,
          preview,
        }),
      };
    }

    case 'reasoning': {
      const preview = extractReasoningPreview(item);
      return {
        level: 'log',
        prefix: 'AGENT',
        message: formatStructuredLogFields({
          kind: 'reasoning',
          phase,
          threadId,
          turnId,
          itemId: item.id,
          chars: preview?.length ?? undefined,
          preview,
        }),
      };
    }

    default:
      return {
        level: 'log',
        prefix: 'AGENT_EVT',
        message: formatStructuredLogFields({
          kind: 'item',
          phase,
          threadId,
          turnId,
          itemId: item.id,
          itemType: item.type,
          statusPreview: 'status' in item
            ? summarizeJsonPreview((item as { status?: unknown }).status ?? null)
            : undefined,
        }),
      };
  }
}

export function selectAgentRuntimeLogEvent(
  event: StreamEvent,
): Record<string, unknown> | null {
  if (event.kind === 'thread') {
    return {
      kind: 'thread',
      threadId: event.threadId,
    };
  }

  if (event.kind === 'turn') {
    return {
      kind: 'turn',
      threadId: event.threadId,
      turnId: event.turnId,
      status: event.status,
    };
  }

  if (!isStructuredAgentRuntimeNotificationMethod(event.notification.method)) {
    return null;
  }

  return {
    kind: 'notification',
    method: event.notification.method,
    notification: event.notification,
  };
}

export type StructuredAgentRuntimeLogEvent =
  | {
    kind: 'thread';
    threadId: string;
  }
  | {
    kind: 'turn';
    threadId: string;
    turnId: string;
    status: v2.TurnStatus;
  }
  | {
    kind: 'notification';
    method: StructuredAgentRuntimeNotificationMethod;
    notification: ServerNotification;
    threadId?: string | null;
    turnId?: string | null;
    status?: v2.TurnStatus | null;
    willRetry?: boolean | null;
    threadName?: string | null;
    errorSummary?: TurnErrorLogSummary | null;
  };

export function buildStructuredAgentRuntimeLogEvent(
  event: StreamEvent,
  turnErrorContext: TurnErrorFormattingContext = {},
): StructuredAgentRuntimeLogEvent | null {
  const baseEvent = selectAgentRuntimeLogEvent(event);
  if (!baseEvent) {
    return null;
  }

  if (event.kind === 'thread' || event.kind === 'turn') {
    return baseEvent as StructuredAgentRuntimeLogEvent;
  }

  const structuredEvent = baseEvent as Extract<
    StructuredAgentRuntimeLogEvent,
    { kind: 'notification' }
  >;

  // Enrich the machine-readable event log with the same normalized error summary
  // used by the session log line so `.agent-events.jsonl` and `session-*.log`
  // tell the same story for support/debugging.
  if (event.notification.method === SERVER_METHOD.turnCompleted) {
    const notification = event.notification as NotificationOfMethod<typeof SERVER_METHOD.turnCompleted>;
    return {
      ...structuredEvent,
      threadId: notification.params.threadId ?? null,
      turnId: notification.params.turn?.id ?? null,
      status: notification.params.turn?.status ?? null,
      errorSummary: summarizeTurnErrorForLog(
        notification.params.turn?.error ?? null,
        turnErrorContext,
      ),
    };
  }

  if (event.notification.method === SERVER_METHOD.streamError) {
    const notification = event.notification as NotificationOfMethod<typeof SERVER_METHOD.streamError>;
    return {
      ...structuredEvent,
      threadId: notification.params.threadId ?? null,
      turnId: notification.params.turnId ?? null,
      willRetry: notification.params.willRetry ?? null,
      errorSummary: summarizeTurnErrorForLog(
        notification.params.error ?? null,
        turnErrorContext,
      ),
    };
  }

  if (event.notification.method === SERVER_METHOD.threadNameUpdated) {
    const notification = event.notification as NotificationOfMethod<typeof SERVER_METHOD.threadNameUpdated>;
    return {
      ...structuredEvent,
      threadId: notification.params.threadId ?? null,
      threadName: notification.params.threadName ?? null,
    };
  }

  if (event.notification.method === SERVER_METHOD.turnPlanUpdated) {
    const notification = event.notification as NotificationOfMethod<typeof SERVER_METHOD.turnPlanUpdated>;
    return {
      ...structuredEvent,
      threadId: notification.params.threadId ?? null,
      turnId: notification.params.turnId ?? null,
    };
  }

  return structuredEvent as StructuredAgentRuntimeLogEvent;
}

export function formatStructuredAgentRuntimeLogLine(
  event: StreamEvent,
  turnErrorContext: TurnErrorFormattingContext = {},
): SessionLogLine | null {
  const baseEvent = buildStructuredAgentRuntimeLogEvent(
    event,
    turnErrorContext,
  );
  if (!baseEvent) {
    return null;
  }

  if (baseEvent.kind === 'thread') {
    return {
      level: 'log',
      prefix: 'AGENT_EVT',
      message: formatStructuredLogFields({
        kind: 'thread',
        threadId: baseEvent.threadId,
      }),
    };
  }

  if (baseEvent.kind === 'turn') {
    return {
      level: 'log',
      prefix: 'AGENT_EVT',
      message: formatStructuredLogFields({
        kind: 'turn',
        threadId: baseEvent.threadId,
        turnId: baseEvent.turnId,
        status: baseEvent.status,
      }),
    };
  }

  const structuredEvent = baseEvent as Extract<
    StructuredAgentRuntimeLogEvent,
    { kind: 'notification' }
  >;
  const method = structuredEvent.method;

  if (
    method === SERVER_METHOD.itemStarted ||
    method === SERVER_METHOD.itemCompleted
  ) {
    const params = structuredEvent.notification.params;
    return formatItemLifecycleLogLine(method, params);
  }

  if (method === SERVER_METHOD.turnCompleted) {
    return {
      level: structuredEvent.status === 'failed' ? 'warn' : 'log',
      prefix: 'AGENT_EVT',
      message: formatStructuredLogFields({
        kind: 'turn_completed',
        threadId: structuredEvent.threadId ?? null,
        turnId: structuredEvent.turnId ?? null,
        status: structuredEvent.status ?? null,
        ...structuredEvent.errorSummary,
      }, {
        maxLengthByKey: TURN_ERROR_LOG_FIELD_MAX_LENGTHS,
      }),
    };
  }

  if (method === SERVER_METHOD.streamError) {
    return {
      level: 'error',
      prefix: 'AGENT_EVT',
      message: formatStructuredLogFields({
        kind: 'stream_error',
        threadId: structuredEvent.threadId ?? null,
        turnId: structuredEvent.turnId ?? null,
        willRetry: structuredEvent.willRetry ?? null,
        ...structuredEvent.errorSummary,
      }, {
        maxLengthByKey: TURN_ERROR_LOG_FIELD_MAX_LENGTHS,
      }),
    };
  }

  if (method === SERVER_METHOD.threadNameUpdated) {
    return {
      level: 'log',
      prefix: 'AGENT_EVT',
      message: formatStructuredLogFields({
        kind: 'thread_name_updated',
        threadId: structuredEvent.threadId ?? null,
        threadName: structuredEvent.threadName ?? null,
      }),
    };
  }

  if (method === SERVER_METHOD.turnPlanUpdated) {
    const notification = structuredEvent.notification as NotificationOfMethod<typeof SERVER_METHOD.turnPlanUpdated>;
    return {
      level: 'log',
      prefix: 'TOOL',
      message: formatStructuredLogFields({
        phase: 'result',
        threadId: structuredEvent.threadId ?? null,
        turnId: structuredEvent.turnId ?? null,
        tool: 'update_plan',
        ok: true,
        stepCount: notification.params.plan.length,
        outputPreview: summarizeJsonPreview(notification.params.plan),
      }),
    };
  }

  return {
    level: 'log',
    prefix: 'AGENT_EVT',
    message: formatStructuredLogFields({
      kind: 'notification',
      method,
    }),
  };
}

export function logAgentTranscriptEvent(event: StreamEvent): void {
  if (event.kind !== 'notification') {
    return;
  }

  const agentLogging = (global as any).__agentLogging;
  if (!agentLogging) {
    return;
  }

  const params = (event.notification as any)?.params ?? {};
  if (event.notification.method === SERVER_METHOD.turnPlanUpdated) {
    agentLogging.logToolCall?.('update_plan', {
      explanation: params.explanation ?? null,
      plan: params.plan ?? [],
    });
    agentLogging.logToolResult?.('update_plan', 'Plan updated', false);
    return;
  }

  const item = params?.item as v2.ThreadItem | undefined;
  if (!item) {
    return;
  }

  if (event.notification.method === SERVER_METHOD.itemStarted) {
    const toolName = extractToolTranscriptName(item);
    if (toolName && item.type !== 'webSearch') {
      agentLogging.logToolCall?.(toolName, extractToolTranscriptInput(item));
    }
    return;
  }

  if (event.notification.method === SERVER_METHOD.itemCompleted) {
    if (item.type === 'userMessage') {
      const message = extractUserMessageTranscript(item.content);
      if (message) {
        agentLogging.logUser?.(message);
      }
      return;
    }

    if (item.type === 'reasoning') {
      const preview = extractReasoningPreview(item);
      if (preview) {
        agentLogging.logReasoning?.(preview);
      }
      return;
    }

    if (item.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim()) {
      agentLogging.logAssistant?.(item.text);
      return;
    }

    const toolName = extractToolTranscriptName(item);
    if (toolName) {
      if (item.type === 'webSearch') {
        agentLogging.logToolCall?.(toolName, extractToolTranscriptInput(item));
      }
      agentLogging.logToolResult?.(
        toolName,
        extractToolTranscriptOutput(item),
        'status' in item && item.status === 'failed',
      );
    }
  }
}

function logStructuredAgentRuntimeEvent(
  event: StreamEvent,
  turnErrorContext: TurnErrorFormattingContext = {},
): void {
  markTurnErrorFormattingContextFromEvent(turnErrorContext, event);
  const structuredEvent = buildStructuredAgentRuntimeLogEvent(
    event,
    turnErrorContext,
  );
  if (!structuredEvent) {
    return;
  }
  (global as any).__agentLogging?.logEvent?.(structuredEvent);
  logAgentTranscriptEvent(event);
  const sessionLogLine = formatStructuredAgentRuntimeLogLine(event, turnErrorContext);
  if (!sessionLogLine) {
    return;
  }
  const rendered = `[${sessionLogLine.prefix}] ${sessionLogLine.message}`;
  if (sessionLogLine.level === 'error') {
    console.error(rendered);
    return;
  }
  if (sessionLogLine.level === 'warn') {
    console.warn(rendered);
    return;
  }
  console.log(rendered);
}

/*
 * Track facts that are only knowable from prior stream events, not from the
 * later error payload itself. `hasImageInput` is reset at each new turn and set
 * when that same turn emits an imageView item, so retry/continuation attempts
 * do not inherit image state from earlier attempts.
 */
function markTurnErrorFormattingContextFromEvent(
  context: TurnErrorFormattingContext,
  event: StreamEvent,
): void {
  if (event.kind === 'turn') {
    context.hasImageInput = false;
    return;
  }
  if (event.kind !== 'notification') {
    return;
  }
  if (
    event.notification.method !== SERVER_METHOD.itemStarted &&
    event.notification.method !== SERVER_METHOD.itemCompleted
  ) {
    return;
  }

  const item = event.notification.params.item;
  if (item.type === 'imageView') {
    context.hasImageInput = true;
  }
}

async function logAgentTurnContext(options: {
  callerToken: string;
  systemMessage: string;
  runtimeSkills: RuntimeSkillMetadata[];
  workspacePath?: string;
}): Promise<void> {
  const agentLogging = (global as any).__agentLogging;
  if (!agentLogging) {
    return;
  }

  agentLogging.logSystem?.(options.systemMessage);

  try {
    agentLogging.logSkills?.(summarizeVisibleRuntimeSkills(options.runtimeSkills));
  } catch (error) {
    console.warn(
      '[Agent Runtime] Failed to log visible skills for transcript:',
      error instanceof Error ? error.message : error,
    );
  }

  try {
    const toolListing = await listInterpreterCliTools(options.callerToken);
    const toolGroups = await Promise.all(toolListing.servers.map(async (server) => {
      return await listInterpreterCliServerTools(options.callerToken, server.id);
    }));
    const tools = toolGroups.flatMap((group) => (
      group.tools.map((tool) => ({
        name: `${group.server.id}__${tool.name}`,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema ?? null,
      }))
    ));
    agentLogging.logTools?.([
      ...NATIVE_RUNTIME_TRANSCRIPT_TOOLS,
      ...tools,
    ]);
  } catch (error) {
    console.warn(
      '[Agent Runtime] Failed to log visible tools for transcript:',
      error instanceof Error ? error.message : error,
    );
  }
}

export async function runCodexAgentTurn(
  options: RunCodexAgentTurnOptions,
): Promise<{
  completion: {
    threadId: string;
    turnId: string;
    status: string;
  };
  profile: CodexProfile;
  resolvedModel: string;
}> {
  let profile = routeGroqThroughProxy(options.profile);
  if (profile.modelProvider === 'interpreter') {
    const jwt = getServerJWT();
    if (jwt) {
      profile = withAuthToken(profile, jwt);
    }
  }

  const requestedModel = options.requestedModel ?? profile.model;
  if (!requestedModel) {
    throw new Error('Model is required.');
  }
  const localRuntime = getLocalModelProviderRuntime(profile.modelProvider);
  const resolvedModel = localRuntime
    ? resolveLocalRuntimeModelId(requestedModel, localRuntime)
    : requestedModel;
  if (profile.model !== resolvedModel) {
    profile = { ...profile, model: resolvedModel };
  }

  const turnErrorContext: TurnErrorFormattingContext = options.turnErrorContext ?? {
    isChatGptProfile: options.usesChatGptAuth,
    modelId: resolvedModel,
    modelProvider: profile.modelProvider,
    providerLabel: profile.label,
  };

  const runtimeModelValidationError = validateRuntimeModelId(
    profile.modelProvider,
    resolvedModel,
  );
  if (runtimeModelValidationError) {
    throw new Error(runtimeModelValidationError);
  }

  // Probe tool-use support and (for Ollama) the server version concurrently so
  // a too-old runtime can be named in the turn-error message without adding a
  // serial round-trip. Both hit the local runtime in parallel.
  const [localModelToolUse, ollamaVersion] = await Promise.all([
    resolveLocalModelToolUseSupport({
      modelProvider: profile.modelProvider,
      baseURL: profile.providerConfig?.base_url,
      apiKey: profile.providerConfig?.experimental_bearer_token,
      modelId: resolvedModel,
    }),
    localRuntime === 'ollama'
      ? getOllamaVersion(
          profile.providerConfig?.base_url,
          profile.providerConfig?.experimental_bearer_token,
        )
      : Promise.resolve(undefined),
  ]);
  if (ollamaVersion) {
    turnErrorContext.localProviderVersion = ollamaVersion;
  }
  const localModelToolUseError = formatLocalModelToolUseError(localModelToolUse, resolvedModel);
  if (localModelToolUseError) {
    throw new Error(localModelToolUseError);
  }

  const normalizedBinding = normalizeBinding(options.binding);
  const ownsCallerToken = !normalizedBinding.callerToken;
  const callerToken = normalizedBinding.callerToken ?? createRuntimeCallerToken();
  const runtimeBinding = {
    ...normalizedBinding,
    callerToken,
  };
  const interpreterCliServerConnection = buildInterpreterCliServerConnection(getServerPort(), {
    transport: resolveAgentInterpreterCliTransport(process.platform),
  });
  const interpreterCliPath = materializeInterpreterCliLauncher(
    process.env,
    process.platform,
  );
  const callerConfig = { ...(options.config ?? {}) };
  delete callerConfig.mcp_servers;
  const threadConfig = {
    ...(profile.harness !== undefined ? { harness: profile.harness } : {}),
    ...callerConfig,
    ...(options.usesChatGptAuth ? { forced_login_method: 'chatgpt' } : {}),
    // App tools are discovered and executed through the shell-visible
    // interpreter-app CLI. Never expose a second direct-MCP app-tool surface.
    mcp_servers: {} as unknown as JsonValue,
    shell_environment_policy: buildInterpreterCliShellEnvironmentPolicy(
      callerToken,
      process.env,
      process.platform,
      runtimeBinding.workspacePath,
      interpreterCliServerConnection,
    ) as unknown as JsonValue,
  };

  agentTabManager.registerAgentRuntime({
    agentId: runtimeBinding.agentId,
    callerToken: runtimeBinding.callerToken,
    workspacePath: runtimeBinding.workspacePath,
    allowedToolNames: runtimeBinding.allowedToolNames,
    modelConfig: runtimeBinding.modelConfig,
    toolProfileId: runtimeBinding.toolProfileId,
    parentOwner: runtimeBinding.parentOwner,
  });

  if (options.threadId) {
    agentTabManager.bindThread({
      agentId: runtimeBinding.agentId,
      threadId: options.threadId,
      callerToken: runtimeBinding.callerToken,
      workspacePath: runtimeBinding.workspacePath,
      allowedToolNames: runtimeBinding.allowedToolNames,
      modelConfig: runtimeBinding.modelConfig,
      toolProfileId: runtimeBinding.toolProfileId,
      parentOwner: runtimeBinding.parentOwner,
    });
  }

  if (options.threadId && options.inspectExistingThread) {
    try {
      const existingThread = await options.service.readThread(options.threadId);
      if (requiresFreshThread(existingThread)) {
        throw new Error(FRESH_THREAD_REQUIRED_MESSAGE);
      }
    } catch (error) {
      if (error instanceof Error && error.message === FRESH_THREAD_REQUIRED_MESSAGE) {
        throw error;
      }
      console.warn(
        '[Agent Runtime] Failed to inspect Codex thread before send; continuing with normal resume flow.',
        error instanceof Error ? error.message : error,
      );
    }
  }

  const runtimeSkills = await loadRuntimeSkillMetadata(
    options.workspacePath,
    'turn context',
    options.service,
  );
  const developerInstructions = await buildCodexDeveloperInstructions({
    modelId: resolvedModel,
    interpreterCliAvailable: true,
    interpreterCliPath,
    workspacePath: options.workspacePath,
    system: options.system,
    runtimeSkills,
  });
  const systemMessage = [
    getMainAgentBaseInstructions(),
    developerInstructions,
  ].filter(Boolean).join('\n\n');

  await logAgentTurnContext({
    callerToken,
    systemMessage,
    runtimeSkills,
    workspacePath: options.workspacePath,
  });

  let completionStatus: string | null = null;
  const { overlaySessionManager } = await import('../overlaySessionManager');

  try {
    let threadId = options.threadId;
    let nextMessage = options.message;
    let nextAttachments = options.attachments;
    let nextSkills = options.skills;
    let continuationAttempt = 0;
    let idleRecoveryAttempt = 0;

    while (true) {
      const attemptDiagnostics = createTurnAttemptDiagnostics();
      let completion: Awaited<ReturnType<typeof options.service.runTurn>>;
      turnErrorContext.hasImageInput = false;

      try {
        completion = await options.service.runTurn({
          threadId,
          message: nextMessage,
          attachments: nextAttachments,
          skills: nextSkills,
          sandboxPolicy: options.sandboxPolicy,
          cwd: options.workspacePath,
          model: resolvedModel,
          modelProvider: profile.modelProvider,
          providerConfig: profile.providerConfig,
          baseInstructions: getMainAgentBaseInstructions(),
          developerInstructions,
          config: threadConfig,
          effort: options.reasoningEffort ?? null,
          summary: options.reasoningSummary ?? null,
          idleTimeoutMs: options.idleTimeoutMs,
          signal: options.signal,
          onEvent: (event) => {
            recordTurnAttemptDiagnostics(attemptDiagnostics, event);
            logStructuredAgentRuntimeEvent(event, turnErrorContext);
            if (event.kind === 'thread') {
              agentTabManager.bindThread({
                agentId: runtimeBinding.agentId,
                threadId: event.threadId,
                callerToken: runtimeBinding.callerToken,
                workspacePath: runtimeBinding.workspacePath,
                allowedToolNames: runtimeBinding.allowedToolNames,
                modelConfig: runtimeBinding.modelConfig,
                toolProfileId: runtimeBinding.toolProfileId,
                parentOwner: runtimeBinding.parentOwner,
              });
            }
            options.onEvent?.(event);
          },
        });
      } catch (error) {
        if (
          isIdleTurnError(error)
          && canRetryIdleTurn(attemptDiagnostics, idleRecoveryAttempt)
        ) {
          idleRecoveryAttempt += 1;
          threadId = attemptDiagnostics.threadId ?? threadId;
          console.warn(
            '[Agent Runtime] Retrying idle turn after partial progress.',
            {
              agentId: runtimeBinding.agentId,
              threadId,
              turnId: attemptDiagnostics.turnId,
              toolCalls: attemptDiagnostics.toolCalls,
              assistantMessages: attemptDiagnostics.assistantMessages,
              userMessages: attemptDiagnostics.userMessages,
              finalAnswerSeen: attemptDiagnostics.finalAnswerSeen,
              lastAssistantPhase: attemptDiagnostics.lastAssistantPhase,
              progressEvents: attemptDiagnostics.progressEvents,
              reasoningEvents: attemptDiagnostics.reasoningEvents,
              reasoningSummaryDeltas: attemptDiagnostics.reasoningSummaryDeltas,
              idleRecoveryAttempt,
            },
          );
          nextMessage = buildIdleTurnRecoveryMessage();
          nextAttachments = undefined;
          nextSkills = undefined;
          continue;
        }
        throw error;
      }
      completionStatus = completion.status;

      const activeOverlaySession = overlaySessionManager.getDebugSnapshotForAgent(
        runtimeBinding.agentId,
      );
      // Only the session owner must end the live overlay session before
      // finishing. A delegated agent (hidden-agent dispatch) is attached to a
      // session owned by the dispatching controller; it reports back and the
      // owner ends the session.
      const ownsOverlaySession = activeOverlaySession?.agentId === runtimeBinding.agentId;
      if (completion.status !== 'completed' || !ownsOverlaySession) {
        return {
          completion: {
            ...completion,
            status: completion.status,
          },
          profile,
          resolvedModel,
        };
      }

      continuationAttempt += 1;
      if (continuationAttempt > ATTACHED_OVERLAY_COMPLETION_RETRY_LIMIT) {
        throw new Error(
          `Live Interpreter Overlay session remained attached after ${ATTACHED_OVERLAY_COMPLETION_RETRY_LIMIT} completed turn(s). The agent must call overlay_complete or overlay_detach before finishing.`,
        );
      }

      console.warn(
        '[Agent Runtime] Live Interpreter Overlay session is still attached after a completed turn; requesting continuation.',
        {
          agentId: runtimeBinding.agentId,
          threadId: completion.threadId,
          attempt: continuationAttempt,
          overlaySessionId: activeOverlaySession.id,
        },
      );

      threadId = completion.threadId;
      nextMessage = buildAttachedOverlayContinuationMessage(continuationAttempt);
      nextAttachments = undefined;
      nextSkills = undefined;
    }
  } finally {
    if (ownsCallerToken) {
      const activeOverlaySession = overlaySessionManager.getDebugSnapshotForAgent(
        runtimeBinding.agentId,
      );
      if (activeOverlaySession) {
        console.warn(
          '[Agent Runtime] Preserving agent binding because the live Interpreter Overlay session is still attached and must be cleared explicitly.',
          {
            agentId: runtimeBinding.agentId,
            callerToken,
            overlaySessionId: activeOverlaySession.id,
            completionStatus,
          },
        );
      } else {
        agentTabManager.disposeBinding(callerToken);
      }
    }
  }
}
