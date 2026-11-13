import { match } from "ts-pattern";
import { nativeTerminalOwnerObserved } from '../../../server/utils/nativeTurnOwnership';
import { nativeCommandSessionSnapshot, nativeTurnReceipt } from './native-turn-receipt';
import { boundNativeTerminalStatus, validateNativeTerminalRequest, type NativeTerminalStatusRequest,
  type NativeTerminalStatusResponse } from './native-terminal-status';
import { ManagedGoalDocumentError, validateGoalDocumentInput, verifyGoalDocument, type ThreadGoalDocumentGetResponse,
  type ThreadGoalDocumentCreateParams, type ThreadGoalDocumentCreateResponse,
  type ThreadGoalDocumentSetParams, type ThreadGoalDocumentSetResponse } from './goal-document';
import { GoalMutationUnconfirmedError, GoalRevisionConflictError, GoalRevisionUnavailableError, goalCasExpectedParams,
  verifyThreadGoalRevision, type ThreadGoalRevision } from './goal-revision';
import { JSONRPCErrorException } from "json-rpc-2.0";
import type { v2 } from "../../../server/handlers/codex-generated-types/index";
import type { JsonValue } from "../../../server/handlers/codex-generated-types/serde_json/JsonValue";
import {
  getLocalModelProviderRuntime,
  LOCAL_MODEL_PROVIDER_RUNTIMES,
  type LocalModelProviderRuntime,
} from "../../../shared/types/provider";
import type {
  StreamImageAttachment,
  StreamSkillReference,
} from "./api-types";
import {
  CodexAppServerClient,
  StdioJsonRpcTransport,
  loadCodexRuntimeAccessSnapshot,
} from "./app-server-client";
import type { Profile } from "./profiles";
import { providerConfigToJsonValue } from "./profiles";
import { attachCodexServerRequestApprovals } from "../../../server/utils/codexServerRequestApprovals";

import {
  type AppServerNotification,
  type McpResourceReadParams,
  type McpResourceReadResponse,
  type McpServerStatusListParams,
  type McpServerToolCallParams,
  type McpServerToolCallResponse,
  SERVER_METHOD,
} from "./protocol";

const ACTIVE_TURN_MISMATCH_PREFIX = "expected active turn id `";
const ACTIVE_TURN_MISMATCH_SEPARATOR = "` but found `";
const DEFAULT_RUN_TURN_IDLE_TIMEOUT_MS = 3 * 60 * 1000;
const NATIVE_CUSTODY_PHASE_DEADLINE_MS = 12_000;
// Keep the exact-thread operator HTTP read bounded independently of the native
// RPC's lifetime. Two sequential reads reserve response time for an operator
// with an eight-second HTTP deadline; this cannot diagnose a request that
// never reaches this route. An expired native RPC may still complete later.
export const NATIVE_CUSTODY_OPERATOR_PHASE_DEADLINE_MS = 3_000;
export const NATIVE_CUSTODY_GLOBAL_OPERATOR_DEADLINE_MS = 6_000;
const NATIVE_CUSTODY_GLOBAL_MAX_DEADLINE_MS = 30_000;

export type NativeCustodyPhase = 'thread_read' | 'queue_read' | 'loaded_list' | 'thread_list'
  | 'terminal_status'
  | 'global_queue_read' | 'verify_loaded_list' | 'verify_thread_list' | 'verify_queue_read';

/** A failed inspection is never evidence that a native queue or command is empty. */
export class NativeCustodyPhaseError extends Error {
  constructor(
    readonly phase: NativeCustodyPhase,
    readonly category: 'deadline' | 'native_unavailable',
  ) {
    super('Native custody inspection unavailable.');
    this.name = 'NativeCustodyPhaseError';
  }
}

/** Fixed, content-free categories for failures after a native RPC returned. */
export class NativeGlobalInventoryError extends Error {
  constructor(
    readonly category: 'invalid_page' | 'invalid_identifiers' | 'invalid_cursor'
      | 'loaded_missing' | 'inventory_changed' | 'queue_changed',
    message: string,
  ) {
    super(message);
    this.name = 'NativeGlobalInventoryError';
  }
}

async function nativeCustodyPhase<T>(
  phase: NativeCustodyPhase,
  operation: () => Promise<T>,
  deadlineMs: number,
  onLate?: (phase: NativeCustodyPhase, status: 'completed' | 'failed') => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    const pending = operation();
    if (onLate) void pending.then(() => {
      if (timedOut) onLate(phase, 'completed');
    }, () => {
      if (timedOut) onLate(phase, 'failed');
    });
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new NativeCustodyPhaseError(phase, 'deadline'));
        }, deadlineMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof NativeCustodyPhaseError) throw error;
    // Neither native exception text nor a late RPC result is an operator receipt.
    throw new NativeCustodyPhaseError(phase, 'native_unavailable');
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type SteerErrorCode =
  | "active_turn_not_steerable"
  | "no_active_turn"
  | "other";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractJsonRpcErrorMessage(error: unknown): string | null {
  if (error instanceof JSONRPCErrorException) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (!isRecord(error) || typeof error.message !== "string") {
    return null;
  }
  return error.message;
}

function extractJsonRpcErrorData(error: unknown): unknown {
  if (error instanceof JSONRPCErrorException) {
    return error.data;
  }
  if (!isRecord(error) || !("data" in error)) {
    return null;
  }
  return error.data;
}

function extractCodexErrorInfo(error: unknown): v2.CodexErrorInfo | null {
  const data = extractJsonRpcErrorData(error);
  if (!isRecord(data) || !("codexErrorInfo" in data)) {
    return null;
  }
  return (data.codexErrorInfo as v2.CodexErrorInfo | null | undefined) ?? null;
}

function extractSteerMismatchActualTurnId(error: unknown): string | null {
  const message = extractJsonRpcErrorMessage(error);
  if (!message?.startsWith(ACTIVE_TURN_MISMATCH_PREFIX)) {
    return null;
  }

  const actualTurnId = message
    .slice(ACTIVE_TURN_MISMATCH_PREFIX.length)
    .split(ACTIVE_TURN_MISMATCH_SEPARATOR)[1]
    ?.slice(0, -1);

  return actualTurnId?.trim() || null;
}

function isNoActiveTurnSteerError(error: unknown): boolean {
  return extractJsonRpcErrorMessage(error) === "no active turn to steer";
}

export function getSteerErrorCode(error: unknown): SteerErrorCode {
  const codexErrorInfo = extractCodexErrorInfo(error);
  if (
    codexErrorInfo
    && typeof codexErrorInfo === "object"
    && "activeTurnNotSteerable" in codexErrorInfo
  ) {
    return "active_turn_not_steerable";
  }
  if (isNoActiveTurnSteerError(error)) {
    return "no_active_turn";
  }
  return "other";
}

function isReservedLocalProviderId(modelProvider: string): boolean {
  return LOCAL_MODEL_PROVIDER_RUNTIMES.includes(
    modelProvider as LocalModelProviderRuntime,
  );
}

function isLocalProviderId(modelProvider: string): boolean {
  return getLocalModelProviderRuntime(modelProvider) !== null;
}

// NOTE(victor): Thread listing requires two explicit filter overrides at codex v0.106.0:
// - sourceKinds: codex hardcodes SessionSource::VSCode for all app-server threads
//   (See: openinterpreter/codex codex-rs/app-server/src/message_processor.rs:185),
//   so we must include "vscode". "appServer" is for forward-compat.
// - modelProviders: docs say omitting includes all, but the implementation defaults to
//   config.model_provider_id ("openai"), hiding "interpreter" threads.
//   Passing [] explicitly disables the filter.
//   (See: openinterpreter/codex codex-rs/app-server/src/codex_message_processor.rs:3831)
export const THREAD_LIST_DEFAULTS: v2.ThreadListParams = {
  sortKey: "updated_at",
  sourceKinds: ["vscode", "appServer"],
  modelProviders: [],
  archived: false,
};

export type StreamEvent =
  | { kind: "thread"; threadId: string }
  | { kind: "turn"; threadId: string; turnId: string; status: v2.TurnStatus }
  | { kind: "notification"; notification: AppServerNotification };

type RunTurnOptions = {
  threadId?: string;
  message?: string;
  /** Stable native input identity when the caller has durable custody. */
  clientUserMessageId?: string;
  attachments?: StreamImageAttachment[];
  skills?: StreamSkillReference[];
  sandboxPolicy?: v2.SandboxPolicy;
  model: string;
  modelProvider?: string | null;
  providerConfig?: Profile["providerConfig"];
  cwd?: string;
  baseInstructions?: string;
  developerInstructions?: string;
  config?: Record<string, JsonValue> | null;
  effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | null;
  summary?: "auto" | "concise" | "detailed" | "none" | null;
  idleTimeoutMs?: number | null;
  onEvent: (event: StreamEvent) => void;
  signal?: AbortSignal;
  dynamicTools?: v2.DynamicToolSpec[] | null;
  additionalWritableRoots?: string[];
};

type ResumeThreadOptions = {
  threadId: string;
  model: string | null;
  modelProvider?: string | null;
  providerConfig?: Profile["providerConfig"];
  cwd?: string;
  config?: Record<string, JsonValue> | null;
  /** Only after bounded native custody proves this saved thread is not loaded. */
  coldShellPolicy?: boolean;
};

type ForkThreadOptions = ResumeThreadOptions & {
  lastTurnId: string;
};

const TURN_BLOCKING_ITEM_TYPES = new Set<v2.ThreadItem["type"]>([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
]);

function isTurnBlockingItem(item: v2.ThreadItem): boolean {
  return TURN_BLOCKING_ITEM_TYPES.has(item.type);
}

function normalizeRunTurnIdleTimeoutMs(
  idleTimeoutMs: number | null | undefined,
): number | null {
  if (idleTimeoutMs === null || idleTimeoutMs === undefined) {
    return DEFAULT_RUN_TURN_IDLE_TIMEOUT_MS;
  }
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
    return null;
  }
  return idleTimeoutMs;
}

function describeTurnActivity(notification: AppServerNotification): string {
  return match(notification)
    .with(
      { method: SERVER_METHOD.itemStarted },
      (n) => `${n.method}:${n.params.item.type}`,
    )
    .with(
      { method: SERVER_METHOD.itemCompleted },
      (n) => `${n.method}:${n.params.item.type}`,
    )
    .with(
      { method: SERVER_METHOD.rawResponseItemCompleted },
      (n) => `${n.method}:${n.params.item.type}`,
    )
    .otherwise((n) => n.method);
}

export type CodexClient = {
  ensureConnected(): Promise<void>;
  subscribe(handler: (notification: AppServerNotification) => void): () => void;
  onDisconnect(handler: (reason: string) => void): () => void;
  startThread(
    model: string,
    modelProvider?: string | null,
    baseInstructions?: string | null,
    cwd?: string | null,
    developerInstructions?: string | null,
  ): Promise<string>;
  startThreadWithConfig(
    model: string,
    modelProvider?: string | null,
    baseInstructions?: string | null,
    cwd?: string | null,
    config?: Record<string, JsonValue> | null,
    developerInstructions?: string | null,
    dynamicTools?: v2.DynamicToolSpec[] | null,
    additionalWritableRoots?: string[],
  ): Promise<string>;
  startMcpToolThread(params: {
    model?: string | null;
    modelProvider?: string | null;
    cwd?: string | null;
  }): Promise<string>;
  resumeThread(
    threadId: string,
    modelProvider?: string | null,
    model?: string | null,
    cwd?: string | null,
    config?: Record<string, JsonValue> | null,
    baseInstructions?: string | null,
    developerInstructions?: string | null,
    additionalWritableRoots?: string[],
  ): Promise<string>;
  forkThread(
    threadId: string,
    lastTurnId: string,
    modelProvider?: string | null,
    model?: string | null,
    cwd?: string | null,
    config?: Record<string, JsonValue> | null,
  ): Promise<string>;
  startTurn(params: {
    threadId: string;
    message?: string;
    clientUserMessageId?: string;
    attachments?: StreamImageAttachment[];
    skills?: StreamSkillReference[];
    sandboxPolicy?: v2.SandboxPolicy;
    cwd?: string;
    model?: string;
    effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | null;
    summary?: "auto" | "concise" | "detailed" | "none" | null;
    additionalWritableRoots?: string[];
  }): Promise<v2.Turn>;
  steerTurn(params: {
    threadId: string;
    turnId: string;
    message?: string;
    clientUserMessageId?: string;
    attachments?: StreamImageAttachment[];
    skills?: StreamSkillReference[];
  }): Promise<v2.TurnSteerResponse>;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
  threadBackgroundTerminalsClean(
    threadId: string,
  ): Promise<Record<string, never>>;
  configValueWrite(keyPath: string, value: JsonValue): Promise<void>;
  configRead(params: v2.ConfigReadParams): Promise<v2.ConfigReadResponse>;
  configBatchWrite(
    params: v2.ConfigBatchWriteParams,
  ): Promise<v2.ConfigWriteResponse>;
  mcpServerReload(): Promise<v2.McpServerRefreshResponse>;
  mcpServerStatusList(
    params?: McpServerStatusListParams,
  ): Promise<v2.ListMcpServerStatusResponse>;
  mcpServerAuthStatusListViaCli(): Promise<Map<string, v2.McpAuthStatus>>;
  mcpServerLogoutViaCli(name: string): Promise<void>;
  mcpServerOauthLogin(
    params: v2.McpServerOauthLoginParams,
  ): Promise<v2.McpServerOauthLoginResponse>;
  mcpServerToolCall(
    params: McpServerToolCallParams,
  ): Promise<McpServerToolCallResponse>;
  mcpResourceRead(
    params: McpResourceReadParams,
  ): Promise<McpResourceReadResponse>;
  loginWithChatGPT(): Promise<{ loginId: string; authUrl: string }>;
  getAccount(refreshToken?: boolean): Promise<v2.GetAccountResponse>;
  cancelLogin(loginId: string): Promise<void>;
  logout(): Promise<void>;
  modelList(params?: v2.ModelListParams): Promise<v2.ModelListResponse>;
  interpreterProviderList(
    params?: v2.InterpreterProviderListParams,
  ): Promise<v2.InterpreterProviderListResponse>;
  interpreterProviderSet(
    params: v2.InterpreterProviderSetParams,
  ): Promise<v2.InterpreterProviderSetResponse>;
  interpreterModelList(
    params?: v2.InterpreterModelListParams,
  ): Promise<v2.InterpreterModelListResponse>;
  interpreterModelSet(
    params: v2.InterpreterModelSetParams,
  ): Promise<v2.InterpreterModelSetResponse>;
  interpreterHarnessList(
    params: v2.InterpreterHarnessListParams,
  ): Promise<v2.InterpreterHarnessListResponse>;
  interpreterHarnessSet(
    params: v2.InterpreterHarnessSetParams,
  ): Promise<v2.InterpreterHarnessSetResponse>;
  skillsList(params?: v2.SkillsListParams): Promise<v2.SkillsListResponse>;
  skillsConfigWrite(
    params: v2.SkillsConfigWriteParams,
  ): Promise<v2.SkillsConfigWriteResponse>;
  windowsSandboxSetupStart(
    params: v2.WindowsSandboxSetupStartParams,
  ): Promise<v2.WindowsSandboxSetupStartResponse>;
  threadList(params?: v2.ThreadListParams): Promise<v2.ThreadListResponse>;
  threadLoadedList(params?: v2.ThreadLoadedListParams): Promise<v2.ThreadLoadedListResponse>;
  threadRead(params: v2.ThreadReadParams): Promise<v2.ThreadReadResponse>;
  threadTurnsList(params: v2.ThreadTurnsListParams): Promise<v2.ThreadTurnsListResponse>;
  threadSupervisorSnapshot(threadId: string): Promise<v2.Thread>;
  threadBackgroundTerminalsStatus?(params: Omit<NativeTerminalStatusRequest, 'terminalGeneration'>): Promise<NativeTerminalStatusResponse>;
  threadBackgroundTerminalsList?(params: { threadId: string; cursor?: string | null; limit?: number | null }): Promise<{
    data: Array<{ itemId: string; turnId?: string | null; nativeProcessId?: string | null;
      terminalGeneration?: number | null; [key: string]: unknown }>;
    nextCursor: string | null;
  }>;
  threadQueueList(params: { threadId: string; cursor?: string | null; limit?: number | null }): Promise<{
    data: Array<{ id: string; clientUserMessageId: string; input: unknown[] }>;
    nextCursor: string | null;
  }>;
  threadSetName(params: v2.ThreadSetNameParams): Promise<v2.ThreadSetNameResponse>;
  threadGoalSet(params: v2.ThreadGoalSetParams): Promise<v2.ThreadGoalSetResponse>;
  threadGoalGet(params: v2.ThreadGoalGetParams): Promise<v2.ThreadGoalGetResponse>;
  threadGoalRevisionGet?(params: v2.ThreadGoalGetParams): Promise<v2.ThreadGoalGetResponse>;
  threadGoalRevisionSet?(params: v2.ThreadGoalSetParams): Promise<v2.ThreadGoalSetResponse>;
  threadGoalDocumentGet?(params: { threadId: string }): Promise<ThreadGoalDocumentGetResponse>;
  threadGoalDocumentCreate?(params: ThreadGoalDocumentCreateParams): Promise<ThreadGoalDocumentCreateResponse>;
  threadGoalDocumentSet?(params: ThreadGoalDocumentSetParams): Promise<ThreadGoalDocumentSetResponse>;
  threadGoalDocumentRevisionSet?(params: ThreadGoalDocumentSetParams): Promise<ThreadGoalDocumentSetResponse>;
  threadGoalClear(params: v2.ThreadGoalClearParams): Promise<v2.ThreadGoalClearResponse>;
  threadArchive(params: v2.ThreadArchiveParams): Promise<v2.ThreadArchiveResponse>;
  threadUnarchive(params: v2.ThreadUnarchiveParams): Promise<v2.ThreadUnarchiveResponse>;
  onAuthInvalidated(handler: (reason: string) => void): () => void;
};

function isJsonObject(value: JsonValue | null | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withElectronRunAsNodeConfig(
  config?: Record<string, JsonValue> | null,
): Record<string, JsonValue> {
  const nextConfig = { ...(config ?? {}) };
  const shellEnvironmentPolicy = isJsonObject(nextConfig.shell_environment_policy)
    ? nextConfig.shell_environment_policy
    : {};
  const set = isJsonObject(shellEnvironmentPolicy.set)
    ? shellEnvironmentPolicy.set
    : {};

  nextConfig.shell_environment_policy = {
    ...shellEnvironmentPolicy,
    set: {
      ...set,
      ELECTRON_RUN_AS_NODE: "1",
    },
  };

  return nextConfig;
}

/** A loaded OIX thread retains its original shell scope. Replacing that policy
 * on resume can add keys and is rejected before a native turn is admitted.
 * Rotate the existing caller through the dedicated native wake path instead;
 * ordinary continuations keep the persisted caller/shell policy unchanged.
 */
function configForExistingThread(config?: Record<string, JsonValue> | null): Record<string, JsonValue> {
  const { shell_environment_policy: _retainedShellPolicy, ...rest } = config ?? {};
  return rest;
}

export function extractNotificationThreadId(notification: AppServerNotification) {
  return match(notification)
    .with({ method: SERVER_METHOD.threadStarted }, (n) => n.params.thread.id)
    .with({ method: SERVER_METHOD.turnStarted }, (n) => n.params.threadId)
    .with({ method: SERVER_METHOD.turnCompleted }, (n) => n.params.threadId)
    .with({ method: SERVER_METHOD.turnPlanUpdated }, (n) => n.params.threadId)
    .with({ method: SERVER_METHOD.threadNameUpdated }, (n) => n.params.threadId)
    .with({ method: SERVER_METHOD.itemStarted }, (n) => n.params.threadId)
    .with({ method: SERVER_METHOD.itemCompleted }, (n) => n.params.threadId)
    .with({ method: SERVER_METHOD.rawResponseItemCompleted }, (n) => n.params.threadId)
    .with({ method: SERVER_METHOD.agentMessageDelta }, (n) => n.params.threadId)
    .with({ method: SERVER_METHOD.planDelta }, (n) => n.params.threadId)
    .with(
      { method: SERVER_METHOD.reasoningSummaryTextDelta },
      (n) => n.params.threadId,
    )
    .with(
      { method: SERVER_METHOD.reasoningSummaryPartAdded },
      (n) => n.params.threadId,
    )
    .with(
      { method: SERVER_METHOD.reasoningTextDelta },
      (n) => n.params.threadId,
    )
    .with(
      { method: SERVER_METHOD.commandExecutionOutputDelta },
      (n) => n.params.threadId,
    )
    .with(
      { method: SERVER_METHOD.commandExecutionTerminalInteraction },
      (n) => n.params.threadId,
    )
    .with(
      { method: SERVER_METHOD.fileChangeOutputDelta },
      (n) => n.params.threadId,
    )
    .with(
      { method: SERVER_METHOD.mcpToolCallProgress },
      (n) => n.params.threadId,
    )
    .with({ method: SERVER_METHOD.streamError }, (n) => n.params.threadId)
    .otherwise(() => null);
}

export function extractNotificationTurnId(notification: AppServerNotification) {
  return match(notification)
    .with({ method: SERVER_METHOD.turnStarted }, (n) => n.params.turn.id)
    .with({ method: SERVER_METHOD.turnCompleted }, (n) => n.params.turn.id)
    .with({ method: SERVER_METHOD.turnPlanUpdated }, (n) => n.params.turnId)
    .with({ method: SERVER_METHOD.itemStarted }, (n) => n.params.turnId)
    .with({ method: SERVER_METHOD.itemCompleted }, (n) => n.params.turnId)
    .with({ method: SERVER_METHOD.rawResponseItemCompleted }, (n) => n.params.turnId)
    .with({ method: SERVER_METHOD.agentMessageDelta }, (n) => n.params.turnId)
    .with({ method: SERVER_METHOD.planDelta }, (n) => n.params.turnId)
    .with(
      { method: SERVER_METHOD.reasoningSummaryTextDelta },
      (n) => n.params.turnId,
    )
    .with(
      { method: SERVER_METHOD.reasoningSummaryPartAdded },
      (n) => n.params.turnId,
    )
    .with(
      { method: SERVER_METHOD.reasoningTextDelta },
      (n) => n.params.turnId,
    )
    .with(
      { method: SERVER_METHOD.commandExecutionOutputDelta },
      (n) => n.params.turnId,
    )
    .with(
      { method: SERVER_METHOD.commandExecutionTerminalInteraction },
      (n) => n.params.turnId,
    )
    .with(
      { method: SERVER_METHOD.fileChangeOutputDelta },
      (n) => n.params.turnId,
    )
    .with({ method: SERVER_METHOD.mcpToolCallProgress }, (n) => n.params.turnId)
    .with({ method: SERVER_METHOD.streamError }, (n) => n.params.turnId)
    .otherwise(() => null);
}

export class CodexService {
  private readonly activeTurns = new Map<string, string | null>();
  private readonly provisionedProviders = new Set<string>();
  private reservedLocalOverridesCleared = false;
  private reservedLocalOverrideCleanup: Promise<void> | null = null;

  constructor(private readonly client: CodexClient) {
    // Native OIX features can start turns without going through runTurn(), so
    // keep their terminal failures visible in the service journal as well.
    this.client.subscribe((notification) => {
      if (
        notification.method === SERVER_METHOD.streamError
        && !notification.params.willRetry
      ) {
        console.error(
          `[codex-native-turn] terminal stream error threadId=${notification.params.threadId} turnId=${notification.params.turnId} message=${notification.params.error.message}`,
        );
        return;
      }
      if (
        notification.method === SERVER_METHOD.turnCompleted
        && notification.params.turn.status === "failed"
      ) {
        console.error(
          `[codex-native-turn] failed threadId=${notification.params.threadId} turnId=${notification.params.turn.id} message=${notification.params.turn.error?.message ?? "unknown turn error"}`,
        );
      }
    });
  }

  /** All ordinary ingress converges on the same native turn/start or
   * turn/steer submission. This is an RPC receipt, not durable admission:
   * durable producers must still reconcile their client ID in native history.
   */
  private async submitNativeInput(
    input: { kind: 'start'; params: Parameters<CodexClient['startTurn']>[0];
      existingThread?: { config?: Record<string, JsonValue>;
        model?: string | null; modelProvider?: string | null;
        baseInstructions?: string; developerInstructions?: string;
        additionalWritableRoots?: string[];
        /** UI observers already own the null reservation before turn/start. */
        preReserved?: boolean;
        onPhase?: (phase: 'resume' | 'start') => void } }
      | { kind: 'steer'; params: Parameters<CodexClient['steerTurn']>[0] },
  ): Promise<{ turnId: string; status?: v2.TurnStatus }> {
    if (input.kind === 'start') {
      const { threadId } = input.params;
      if (input.existingThread) {
        if (input.existingThread.preReserved) {
          if (!this.activeTurns.has(threadId) || this.activeTurns.get(threadId) !== null) {
            throw new Error('Existing input reservation changed before admission');
          }
        } else {
          await this.reconcileTerminalTurn(threadId);
          this.assertNoActiveTurn(threadId);
          this.activeTurns.set(threadId, null);
        }
      }
      try {
        if (input.existingThread) {
          input.existingThread.onPhase?.('resume');
          await this.resumeExistingInputThread({ threadId,
            modelProvider: input.existingThread.modelProvider ?? null,
            model: input.existingThread.model ?? null,
            cwd: input.params.cwd, config: input.existingThread.config,
            baseInstructions: input.existingThread.baseInstructions,
            developerInstructions: input.existingThread.developerInstructions,
            additionalWritableRoots: input.existingThread.additionalWritableRoots });
          input.existingThread.onPhase?.('start');
        }
        const turn = await this.client.startTurn(input.params);
        this.activeTurns.set(threadId, turn.id);
        return { turnId: turn.id, status: turn.status };
      } catch (error) {
        if (this.activeTurns.get(threadId) === null) this.activeTurns.delete(threadId);
        throw error;
      }
    }
    const response = await this.client.steerTurn(input.params);
    this.activeTurns.set(input.params.threadId, response.turnId);
    return { turnId: response.turnId };
  }

  /** Shared existing-thread preparation for UI, peer, timer and external
   * inputs. Producers choose their own auth and durable custody; none may
   * replace a loaded thread's shell scope or silently change its identity.
   */
  private async resumeExistingInputThread(options: {
    threadId: string;
    modelProvider?: string | null;
    model?: string | null;
    cwd?: string | null;
    config?: Record<string, JsonValue> | null;
    baseInstructions?: string | null;
    developerInstructions?: string | null;
    additionalWritableRoots?: string[];
    coldShellPolicy?: boolean;
  }): Promise<string> {
    if (options.coldShellPolicy) {
      const custody = await this.readNativeCustody(options.threadId);
      const global = await this.readGlobalNativeCustody();
      if (!['idle', 'notLoaded'].includes(custody.status) || custody.queuedSubmissionCount !== 0 ||
          global.queuedSubmissionCount !== 0 || global.loadedThreadIds.includes(options.threadId) ||
          !global.threads.some(row => row.threadId === options.threadId) ||
          !options.config?.shell_environment_policy) {
        throw new Error('Cold caller bind requires an unloaded idle thread and empty native queues');
      }
    }
    const resumedId = await this.client.resumeThread(
      options.threadId, options.modelProvider, options.model, options.cwd,
      options.coldShellPolicy ? options.config : configForExistingThread(options.config), options.baseInstructions,
      options.developerInstructions, options.additionalWritableRoots,
    );
    if (resumedId !== options.threadId) throw new Error('Existing thread identity changed');
    return resumedId;
  }

  private assertNoActiveTurn(threadId: string): void {
    if (!this.activeTurns.has(threadId)) {
      return;
    }

    const activeTurnId = this.activeTurns.get(threadId);
    const suffix = activeTurnId
      ? ` Wait for turn ${activeTurnId} to finish before sending another message.`
      : " Wait for the current response to finish before sending another message.";
    throw new Error(`Interpreter is already responding in this thread.${suffix}`);
  }

  private async reconcileTerminalTurn(threadId: string): Promise<void> {
    const activeTurnId = this.activeTurns.get(threadId);
    if (!activeTurnId) return; // A turn still starting cannot be reconciled.
    try {
      const terminal = await nativeTerminalOwnerObserved(threadId, activeTurnId,
        () => this.client.threadRead({ threadId, includeTurns: false }),
        params => this.client.threadTurnsList(params));
      if (terminal && this.activeTurns.get(threadId) === activeTurnId) this.activeTurns.delete(threadId);
    } catch {
      // A failed or ambiguous authoritative read must not clear the guard.
    }
  }

  async loginWithChatGPT() { return this.client.loginWithChatGPT(); }
  async getAccount(refreshToken?: boolean) { return this.client.getAccount(refreshToken); }
  async cancelLogin(loginId: string) { await this.client.cancelLogin(loginId); }
  async logout() { await this.client.logout(); }
  async listModels(params?: v2.ModelListParams) {
    return this.client.modelList(params ?? {});
  }
  async listInterpreterProviders(params?: v2.InterpreterProviderListParams) {
    return this.client.interpreterProviderList(params ?? {});
  }
  async setInterpreterProvider(params: v2.InterpreterProviderSetParams) {
    return this.client.interpreterProviderSet(params);
  }
  async listInterpreterModels(params?: v2.InterpreterModelListParams) {
    return this.client.interpreterModelList(params ?? {});
  }
  async setInterpreterModel(params: v2.InterpreterModelSetParams) {
    return this.client.interpreterModelSet(params);
  }
  async listInterpreterHarnesses(params: v2.InterpreterHarnessListParams) {
    return this.client.interpreterHarnessList(params);
  }
  async setInterpreterHarness(params: v2.InterpreterHarnessSetParams) {
    return this.client.interpreterHarnessSet(params);
  }

  private async listReservedLocalProviderOverridesInUserConfig(): Promise<
    LocalModelProviderRuntime[]
  > {
    const response = await this.client.configRead({ includeLayers: true });
    const userLayer = response.layers?.find((layer) => layer.name.type === "user");
    if (!userLayer || !isRecord(userLayer.config)) {
      return [];
    }

    const modelProviders = userLayer.config.model_providers;
    if (!isRecord(modelProviders)) {
      return [];
    }

    return LOCAL_MODEL_PROVIDER_RUNTIMES.filter((providerId) =>
      Object.prototype.hasOwnProperty.call(modelProviders, providerId),
    );
  }

  private async clearReservedLocalProviderOverrides(): Promise<void> {
    if (this.reservedLocalOverridesCleared) {
      return;
    }

    if (!this.reservedLocalOverrideCleanup) {
      this.reservedLocalOverrideCleanup = (async () => {
        const providerIdsToClear = await this.listReservedLocalProviderOverridesInUserConfig();
        for (const providerId of providerIdsToClear) {
          await this.client.configValueWrite(`model_providers.${providerId}`, null);
        }
        this.reservedLocalOverridesCleared = true;
      })().finally(() => {
        this.reservedLocalOverrideCleanup = null;
      });
    }

    await this.reservedLocalOverrideCleanup;
  }

  async ensureProvider(profile: Profile, force?: boolean): Promise<void> {
    if (!profile.modelProvider || !profile.providerConfig) {
      return;
    }

    if (isReservedLocalProviderId(profile.modelProvider)) {
      throw new Error(
        `Reserved built-in local provider ID "${profile.modelProvider}" must not be provisioned.`,
      );
    }

    if (isLocalProviderId(profile.modelProvider)) {
      await this.clearReservedLocalProviderOverrides();
    }

    if (!force && this.provisionedProviders.has(profile.modelProvider)) {
      return;
    }

    await this.client.configValueWrite(
      `model_providers.${profile.modelProvider}`,
      providerConfigToJsonValue(profile.providerConfig),
    );

    this.provisionedProviders.add(profile.modelProvider);
  }

  /**
   * Materialize an existing thread in the app-server without creating a turn.
   * OIX extensions (including Goal) receive their normal thread/resume lifecycle;
   * callers must not synthesize a user message merely to restore a runtime.
   */
  async resumeThread(options: ResumeThreadOptions): Promise<string> {
    await this.reconcileTerminalTurn(options.threadId);
    this.assertNoActiveTurn(options.threadId);

    const runConfig: Record<string, JsonValue> = {
      ...(options.config ?? {}),
    };
    if (options.modelProvider && options.providerConfig) {
      const existingProviders = isRecord(runConfig.model_providers)
        ? runConfig.model_providers as Record<string, JsonValue>
        : {};
      runConfig.model_providers = {
        ...existingProviders,
        [options.modelProvider]: providerConfigToJsonValue(options.providerConfig),
      };
    }

    return this.resumeExistingInputThread({
      threadId: options.threadId,
      modelProvider: options.modelProvider,
      model: options.model,
      cwd: options.cwd,
      config: runConfig,
      coldShellPolicy: options.coldShellPolicy,
    });
  }

  /**
   * Preserve a conversation while continuing from one completed turn. The
   * fork carries the source's native OIX state without mutating its history.
   */
  async forkThread(options: ForkThreadOptions): Promise<string> {
    this.assertNoActiveTurn(options.threadId);

    const runConfig: Record<string, JsonValue> = {
      ...(options.config ?? {}),
    };
    if (options.modelProvider && options.providerConfig) {
      const existingProviders = isRecord(runConfig.model_providers)
        ? runConfig.model_providers as Record<string, JsonValue>
        : {};
      runConfig.model_providers = {
        ...existingProviders,
        [options.modelProvider]: providerConfigToJsonValue(options.providerConfig),
      };
    }

    return this.client.forkThread(
      options.threadId,
      options.lastTurnId,
      options.modelProvider,
      options.model,
      options.cwd,
      withElectronRunAsNodeConfig(runConfig),
    );
  }

  async runTurn(options: RunTurnOptions) {
    if (options.threadId) {
      await this.reconcileTerminalTurn(options.threadId);
      this.assertNoActiveTurn(options.threadId);
    }

    const runConfig: Record<string, JsonValue> = {
      ...(options.config ?? {}),
    };
    if (options.modelProvider && options.providerConfig) {
      const existingProviders = isRecord(runConfig.model_providers)
        ? runConfig.model_providers as Record<string, JsonValue>
        : {};
      runConfig.model_providers = {
        ...existingProviders,
        [options.modelProvider]: providerConfigToJsonValue(options.providerConfig),
      };
    }

    const threadId = options.threadId ?? await this.resolveThread(
      options.model,
      options.modelProvider,
      options.cwd,
      options.baseInstructions,
      options.developerInstructions,
      runConfig,
      options.dynamicTools,
      options.additionalWritableRoots,
    );
    await this.reconcileTerminalTurn(threadId);
    this.assertNoActiveTurn(threadId);
    this.activeTurns.set(threadId, null);
    // A disconnected progress observer must not prevent native admission or
    // leave the exact thread permanently marked active before turn/start.
    // The durable submission receipt remains the authority after lost output.
    let observerAvailable = true;
    const emitEvent = (event: StreamEvent) => {
      if (!observerAvailable) return;
      try {
        options.onEvent(event);
      } catch {
        observerAvailable = false;
      }
    };
    emitEvent({ kind: "thread", threadId });
    const idleTimeoutMs = normalizeRunTurnIdleTimeoutMs(options.idleTimeoutMs);

    let turnId = "";
    let turnStarted = false;
    let turnSettled = false;
    const liveTurnBlockingItems = new Set<string>();
    let pendingTurnCompletion: { turnId: string; status: v2.TurnStatus } | null = null;
    let unsubscribe = () => {};
    let unsubscribeDisconnect = () => {};
    let removeAbortListener = () => {};
    let rejectCompletion: ((reason?: unknown) => void) | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let completionQueued = false;
    let lastTurnActivity = "turn started";
    let preAckNotifications: AppServerNotification[] = [];
    let preAckBytes = 0;
    let preAckOverflow = false;
    let drainPreAckNotifications = () => {};

    const clearIdleTimer = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };

    const cleanup = () => {
      clearIdleTimer();
      removeAbortListener();
      unsubscribe();
      unsubscribeDisconnect();
      if (this.activeTurns.get(threadId) === (turnId || null)) {
        this.activeTurns.delete(threadId);
      }
    };

    const settleTurn = (
      settle: (value: {
        threadId: string;
        turnId: string;
        status: v2.TurnStatus;
      }) => void,
      value: {
        threadId: string;
        turnId: string;
        status: v2.TurnStatus;
      },
    ) => {
      if (turnSettled) {
        return;
      }
      turnSettled = true;
      cleanup();
      settle(value);
    };

    const rejectTurn = (reject: (reason?: unknown) => void, reason: unknown) => {
      if (turnSettled) {
        return;
      }
      turnSettled = true;
      cleanup();
      reject(reason);
    };

    const scheduleIdleTimeout = (activity: string) => {
      lastTurnActivity = activity;
      if (!turnStarted || !idleTimeoutMs || turnSettled || !rejectCompletion) {
        return;
      }
      if (liveTurnBlockingItems.size > 0) {
        clearIdleTimer();
        return;
      }
      const idleReject = rejectCompletion;
      clearIdleTimer();
      idleTimer = setTimeout(() => {
        if (turnSettled || !turnStarted) {
          return;
        }
        void this.interrupt(threadId, turnId).catch(() => {});
        rejectTurn(
          idleReject,
          new Error(
            `Codex turn ${turnId} went idle for ${idleTimeoutMs}ms after ${lastTurnActivity} without reaching turn/completed.`,
          ),
        );
      }, idleTimeoutMs);
      (idleTimer as { unref?: () => void }).unref?.();
    };

    const completion = new Promise<{
      threadId: string;
      turnId: string;
      status: v2.TurnStatus;
    }>((resolve, reject) => {
      const schedulePendingTurnCompletion = () => {
        if (turnSettled || !pendingTurnCompletion || completionQueued) {
          return;
        }
        completionQueued = true;
        queueMicrotask(() => {
          completionQueued = false;
          if (turnSettled || !pendingTurnCompletion) {
            return;
          }

          // `turn/completed` is the terminal protocol signal. Delay settlement
          // only through the current task so any already-buffered trailing
          // `item/completed` notifications can still be observed.
          const completionEvent = pendingTurnCompletion;
          pendingTurnCompletion = null;
          settleTurn(resolve, {
            threadId,
            turnId: completionEvent.turnId,
            status: completionEvent.status,
          });
        });
      };

      rejectCompletion = reject;
      const observeNotification = (notification: AppServerNotification) => {
        if (!turnStarted) {
          const eventThreadId = extractNotificationThreadId(notification);
          if (eventThreadId && eventThreadId !== threadId) return;
          if (!eventThreadId && !extractNotificationTurnId(notification)) return;
          // A native completion may precede its turn/start RPC response. Do not
          // attach any pre-ack event to an unknown turn, especially an old one.
          if (preAckOverflow) return;
          try {
            const bytes = Buffer.byteLength(JSON.stringify(notification));
            if (preAckNotifications.length < 256 && bytes <= 8_388_608 - preAckBytes) {
              preAckBytes += bytes;
              preAckNotifications.push(notification);
            } else preAckOverflow = true;
          } catch {
            preAckOverflow = true;
          }
          return;
        }
        if (!this.belongsToTurn(notification, threadId, turnId)) {
          return;
        }

        if (
          notification.method === SERVER_METHOD.itemStarted
          && isTurnBlockingItem(notification.params.item)
        ) {
          liveTurnBlockingItems.add(notification.params.item.id);
        }

        if (
          notification.method === SERVER_METHOD.itemCompleted
          && isTurnBlockingItem(notification.params.item)
        ) {
          liveTurnBlockingItems.delete(notification.params.item.id);
        }

        emitEvent({ kind: "notification", notification });
        scheduleIdleTimeout(describeTurnActivity(notification));

        if (notification.method === SERVER_METHOD.turnCompleted) {
          pendingTurnCompletion = {
            turnId: notification.params.turn.id,
            status: notification.params.turn.status,
          };
          schedulePendingTurnCompletion();
          return;
        }
      };
      unsubscribe = this.client.subscribe(observeNotification);
      drainPreAckNotifications = () => {
        const buffered = preAckNotifications;
        preAckNotifications = [];
        for (const notification of buffered) observeNotification(notification);
      };

      unsubscribeDisconnect = this.client.onDisconnect((reason) => {
        // NOTE(victor): Upstream app-server is supposed to finish a failed turn
        // by emitting `error` and then `turn/completed`; see
        // codex/codex-rs/app-server/src/bespoke_event_handling.rs. If the
        // transport dies after `turn/start` succeeds but before
        // `turn/completed`, we have lost the entire session and waiting here
        // forever would be incorrect.
        if (!turnStarted) {
          // NOTE(victor): Ignore pre-turn disconnects here. Before
          // `startTurn()` resolves, the failure belongs to thread resolution or
          // turn creation itself, and that promise already rejects the caller.
          // Rejecting in both places would create a double-failure race.
          return;
        }
        // Once app-server has emitted `turn/completed`, the turn outcome is
        // terminal for callers. A later transport teardown must not reclassify
        // that same turn into a second error just because trailing blocking
        // item lifecycle events never arrived.
        if (pendingTurnCompletion) {
          const completionEvent = pendingTurnCompletion;
          pendingTurnCompletion = null;
          settleTurn(resolve, {
            threadId,
            turnId: completionEvent.turnId,
            status: completionEvent.status,
          });
          return;
        }
        rejectTurn(reject, new Error(reason));
      });
    });

    try {
      const turn = await this.submitNativeInput({ kind: 'start', params: {
        threadId,
        message: options.message,
        clientUserMessageId: options.clientUserMessageId,
        attachments: options.attachments,
        skills: options.skills,
        sandboxPolicy: options.sandboxPolicy,
        cwd: options.cwd,
        model: options.model,
        effort: options.effort,
        summary: options.summary,
        additionalWritableRoots: options.additionalWritableRoots,
      }, ...(options.threadId ? { existingThread: {
        preReserved: true, config: runConfig,
        model: options.model, modelProvider: options.modelProvider,
        baseInstructions: options.baseInstructions,
        developerInstructions: options.developerInstructions,
        additionalWritableRoots: options.additionalWritableRoots,
      } } : {}) });

      turnId = turn.turnId;
      turnStarted = true;
      emitEvent({ kind: "turn", threadId, turnId, status: turn.status! });
      if (preAckOverflow) {
        rejectTurn(rejectCompletion!, new Error('Native turn progress exceeded the pre-ack bound; reconcile the exact submission before retrying.'));
        return completion;
      }
      drainPreAckNotifications();
      scheduleIdleTimeout("turn started");

      if (options.signal) {
        const interruptOnAbort = () => {
          void this.interrupt(threadId, turnId).catch(() => {});
        };

        if (options.signal.aborted) {
          interruptOnAbort();
        } else {
          options.signal.addEventListener("abort", interruptOnAbort, { once: true });
          removeAbortListener = () => {
            options.signal?.removeEventListener("abort", interruptOnAbort);
          };
        }
      }

      return completion;
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  async listThreads(params?: v2.ThreadListParams): Promise<v2.ThreadListResponse> {
    return this.client.threadList(params ?? {});
  }

  /** Read-only, bounded inventory from the existing app-server client. No thread resumes. */
  async readGlobalNativeCustody(
    deadlineMs = NATIVE_CUSTODY_GLOBAL_MAX_DEADLINE_MS,
    onPhase?: (phase: NativeCustodyPhase, status: 'started' | 'completed' | 'late_completed' | 'late_failed') => void,
  ) {
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > NATIVE_CUSTODY_GLOBAL_MAX_DEADLINE_MS) {
      throw new Error('Invalid global native custody deadline');
    }
    // One monotonic budget covers the whole inventory, including pagination and
    // the verification pass. A timed-out native RPC is not cancelled or treated
    // as an empty queue; its late result is a separate diagnostic event.
    const deadlineAt = performance.now() + deadlineMs;
    const read = async <T>(phase: NativeCustodyPhase, operation: () => Promise<T>): Promise<T> => {
      onPhase?.(phase, 'started');
      const remaining = Math.floor(deadlineAt - performance.now());
      if (remaining < 1) throw new NativeCustodyPhaseError(phase, 'deadline');
      const result = await nativeCustodyPhase(phase, operation, remaining,
        (latePhase, status) => onPhase?.(latePhase, status === 'completed' ? 'late_completed' : 'late_failed'));
      onPhase?.(phase, 'completed');
      return result;
    };
    const sourceKinds: v2.ThreadSourceKind[] = [
      'cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview',
      'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown',
    ];
    const collect = async (loaded: boolean, verify = false): Promise<string[]> => {
      const ids: string[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      do {
        const page: { data: Array<string | v2.Thread>; nextCursor: string | null } = loaded
          ? await read(verify ? 'verify_loaded_list' : 'loaded_list',
            () => this.client.threadLoadedList({ cursor, limit: 100 }))
          : await read(verify ? 'verify_thread_list' : 'thread_list',
            () => this.client.threadList({ sourceKinds, modelProviders: [], archived: false, cursor, limit: 100 }));
        if (!Array.isArray(page.data) || page.data.length > 100)
          throw new NativeGlobalInventoryError('invalid_page', 'Invalid native inventory page');
        ids.push(...page.data.map((item) => loaded ? item as string : (item as v2.Thread).id));
        if (ids.length > 500 || new Set(ids).size !== ids.length ||
            ids.some((id) => !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id))) {
          throw new NativeGlobalInventoryError('invalid_identifiers', 'Native inventory bound or identifiers invalid');
        }
        cursor = page.nextCursor;
        if (cursor !== null && (typeof cursor !== 'string' || seenCursors.has(cursor))) {
          throw new NativeGlobalInventoryError('invalid_cursor', 'Invalid native inventory cursor');
        }
        if (cursor) seenCursors.add(cursor);
      } while (cursor);
      return ids.sort();
    };
    const loadedBefore = await collect(true);
    const threadIds = await collect(false);
    if (loadedBefore.some((id) => !threadIds.includes(id)))
      throw new NativeGlobalInventoryError('loaded_missing', 'Loaded native thread missing from inventory');
    const rows = [];
    for (const threadId of threadIds) {
      const queuedSubmissions = await read('global_queue_read', () => this.readNativeQueuedSubmissions(threadId));
      rows.push({ threadId, queuedSubmissionCount: queuedSubmissions.length, queuedSubmissions });
    }
    const [loadedAfter, threadIdsAfter] = await Promise.all([collect(true, true), collect(false, true)]);
    if (JSON.stringify(loadedBefore) !== JSON.stringify(loadedAfter) ||
        JSON.stringify(threadIds) !== JSON.stringify(threadIdsAfter)) {
      throw new NativeGlobalInventoryError('inventory_changed', 'Native inventory changed during inspection');
    }
    for (const row of rows) {
      if (JSON.stringify(row.queuedSubmissions) !==
          JSON.stringify(await read('verify_queue_read', () => this.readNativeQueuedSubmissions(row.threadId)))) {
        throw new NativeGlobalInventoryError('queue_changed', 'Native queue changed during inspection');
      }
    }
    // This is an enumerated snapshot, not an atomic freeze: the operator must
    // repeat it at a quiescent boundary immediately before the service stop.
    return { scope: 'all-enumerated-unarchived-native-threads', atomic: false,
      threadCount: rows.length, loadedThreadIds: loadedAfter,
      queuedSubmissionCount: rows.reduce((sum, row) => sum + row.queuedSubmissionCount, 0), threads: rows };
  }

  async readThread(threadId: string): Promise<v2.Thread> {
    const result = await this.client.threadRead({ threadId, includeTurns: true });
    return result.thread;
  }

  /** A bounded saved-turn shell for supervisor observation. Never hydrate the
   * full rollout or infer command/process liveness from an unloaded item view. */
  async readSupervisorThreadSnapshot(threadId: string): Promise<v2.Thread> {
    return this.client.threadSupervisorSnapshot(threadId);
  }

  async readNativeCustody(
    threadId: string,
    deadlineMs = NATIVE_CUSTODY_PHASE_DEADLINE_MS,
    onPhase?: (phase: NativeCustodyPhase, status: 'started' | 'completed' | 'late_completed' | 'late_failed') => void,
  ) {
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > NATIVE_CUSTODY_PHASE_DEADLINE_MS) {
      throw new Error('Invalid native custody deadline.');
    }
    onPhase?.('thread_read', 'started');
    const thread = await nativeCustodyPhase('thread_read', () => this.readThread(threadId), deadlineMs,
      (phase, status) => onPhase?.(phase, status === 'completed' ? 'late_completed' : 'late_failed'));
    onPhase?.('thread_read', 'completed');
    if (thread.id !== threadId) throw new Error('Native thread ID mismatch');
    onPhase?.('queue_read', 'started');
    const submissions = await nativeCustodyPhase('queue_read',
      () => this.readNativeQueuedSubmissions(threadId), deadlineMs,
      (phase, status) => onPhase?.(phase, status === 'completed' ? 'late_completed' : 'late_failed'));
    onPhase?.('queue_read', 'completed');
    const lastTurn = thread.turns[thread.turns.length - 1];
    const status = thread.status;
    return {
      threadId,
      status: status.type,
      activeFlags: status.type === 'active' ? status.activeFlags : [],
      lastTurnId: lastTurn?.id ?? null,
      lastTurnStatus: lastTurn?.status ?? null,
      commandSessionSnapshot: nativeCommandSessionSnapshot(lastTurn, status.type === 'active'),
      queuedSubmissionCount: submissions.length,
      queuedSubmissions: submissions,
    };
  }

  /** Exact forward submission custody. A journaled RPC acknowledgement is not
   * substituted for an OIX user item; only an exact native client ID links it.
   * Command records describe saved turn state, not live OS process custody. */
  async readNativeSubmissionCustody(threadId: string, clientUserMessageId: string,
    deadlineMs = NATIVE_CUSTODY_PHASE_DEADLINE_MS,
    onPhase?: (phase: NativeCustodyPhase, status: 'started' | 'completed' | 'late_completed' | 'late_failed') => void) {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(threadId) ||
        !/^[A-Za-z0-9_-]{1,160}$/.test(clientUserMessageId) ||
        !Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > NATIVE_CUSTODY_PHASE_DEADLINE_MS) {
      throw new Error('Invalid exact submission inspection');
    }
    onPhase?.('thread_read', 'started');
    const thread = await nativeCustodyPhase('thread_read', () => this.readThread(threadId), deadlineMs,
      (phase, status) => onPhase?.(phase, status === 'completed' ? 'late_completed' : 'late_failed'));
    onPhase?.('thread_read', 'completed');
    if (thread.id !== threadId || thread.turns.length > 2000) throw new Error('Invalid native thread inspection bound');
    onPhase?.('queue_read', 'started');
    const queue = await nativeCustodyPhase('queue_read',
      () => this.readNativeQueuedSubmissions(threadId), deadlineMs,
      (phase, status) => onPhase?.(phase, status === 'completed' ? 'late_completed' : 'late_failed'));
    onPhase?.('queue_read', 'completed');
    const matches: Array<{ turnId: string; userItemId: string; status: string;
      commandSessions: ReturnType<typeof nativeTurnReceipt>['commandSessions'] }> = [];
    for (const turn of thread.turns) {
      const receipt = nativeTurnReceipt(turn);
      for (const user of receipt.userItems) {
        if (user.clientUserMessageId === clientUserMessageId) matches.push({
          turnId: receipt.turnId, userItemId: user.itemId, status: receipt.status,
          commandSessions: receipt.commandSessions,
        });
      }
    }
    return { threadId, clientUserMessageId,
      linkage: matches.length === 1 ? 'native_user_item' : matches.length ? 'ambiguous' : 'not_observed',
      nativeMatch: matches.length === 1 ? matches[0] : null,
      queuedSubmissionIds: queue.filter(item => item.clientUserMessageId === clientUserMessageId).map(item => item.id),
      custodyVerified: matches.length <= 1,
      commandSessionScope: 'saved-native-turn-only-not-live-process-custody' as const };
  }

  /** Read one saved native turn without exposing its message, command or error text. */
  async readNativeTurnReceipt(threadId: string, turnId: string,
    deadlineMs = NATIVE_CUSTODY_OPERATOR_PHASE_DEADLINE_MS,
    onPhase?: (phase: NativeCustodyPhase, status: 'started' | 'completed' | 'late_completed' | 'late_failed') => void) {
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > NATIVE_CUSTODY_PHASE_DEADLINE_MS) {
      throw new Error('Invalid native turn receipt deadline');
    }
    onPhase?.('thread_read', 'started');
    const thread = await nativeCustodyPhase('thread_read', () => this.readThread(threadId), deadlineMs,
      (phase, status) => onPhase?.(phase, status === 'completed' ? 'late_completed' : 'late_failed'));
    onPhase?.('thread_read', 'completed');
    if (thread.id !== threadId) throw new Error('Native thread ID mismatch');
    const turn = thread.turns.find((item) => item.id === turnId);
    if (!turn) return null;
    return nativeTurnReceipt(turn);
  }

  async readNativeTerminalStatus(request: NativeTerminalStatusRequest,
    deadlineMs = NATIVE_CUSTODY_OPERATOR_PHASE_DEADLINE_MS,
    onPhase?: (phase: NativeCustodyPhase, status: 'started' | 'completed' | 'late_completed' | 'late_failed') => void) {
    validateNativeTerminalRequest(request);
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > NATIVE_CUSTODY_OPERATOR_PHASE_DEADLINE_MS ||
        !this.client.threadBackgroundTerminalsStatus) {
      throw new NativeCustodyPhaseError('terminal_status', 'native_unavailable');
    }
    const { terminalGeneration, ...params } = request;
    onPhase?.('terminal_status', 'started');
    const observation = await nativeCustodyPhase('terminal_status',
      () => this.client.threadBackgroundTerminalsStatus!(params), deadlineMs,
      (phase, status) => onPhase?.(phase, status === 'completed' ? 'late_completed' : 'late_failed'));
    onPhase?.('terminal_status', 'completed');
    return boundNativeTerminalStatus(observation, terminalGeneration);
  }

  async listNativeTerminalOwners(threadId: string, cursor?: string | null) {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(threadId) ||
        cursor !== undefined && cursor !== null && !/^[A-Za-z0-9_-]{1,160}$/.test(cursor) ||
        !this.client.threadBackgroundTerminalsList) {
      throw new NativeCustodyPhaseError('terminal_status', 'native_unavailable');
    }
    const result = await nativeCustodyPhase('terminal_status',
      () => this.client.threadBackgroundTerminalsList!({ threadId, cursor, limit: 100 }),
      NATIVE_CUSTODY_OPERATOR_PHASE_DEADLINE_MS);
    if (!result || !Array.isArray(result.data) || result.data.length > 100 ||
        result.nextCursor !== null && (typeof result.nextCursor !== 'string' ||
        !/^[A-Za-z0-9_-]{1,160}$/.test(result.nextCursor)) ||
        result.nextCursor !== null && result.nextCursor === cursor) {
      throw new NativeCustodyPhaseError('terminal_status', 'native_unavailable');
    }
    const seenOwners = new Set<string>();
    const data = result.data.map((item) => {
      const owner = { threadId, turnId: item.turnId, itemId: item.itemId,
        nativeProcessId: item.nativeProcessId, terminalGeneration: item.terminalGeneration };
      validateNativeTerminalRequest(owner as NativeTerminalStatusRequest);
      const key = `${owner.turnId}:${owner.itemId}:${owner.nativeProcessId}:${owner.terminalGeneration}`;
      if (seenOwners.has(key)) throw new NativeCustodyPhaseError('terminal_status', 'native_unavailable');
      seenOwners.add(key);
      return owner;
    });
    return { data, nextCursor: result.nextCursor };
  }

  private async readNativeQueuedSubmissions(threadId: string) {
    const submissions: Array<{ id: string; clientUserMessageId: string }> = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    const seenItems = new Set<string>();
    do {
      const page = await this.client.threadQueueList({ threadId, cursor, limit: 100 });
      if (!Array.isArray(page.data) || page.data.length > 100) throw new Error('Invalid native queue page');
      for (const item of page.data) {
        if (typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(item.id) ||
          typeof item.clientUserMessageId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(item.clientUserMessageId)) {
          throw new Error('Invalid native queue identifier');
        }
        if (seenItems.has(item.id)) throw new Error('Duplicate native queue identifier');
        seenItems.add(item.id);
        submissions.push({ id: item.id, clientUserMessageId: item.clientUserMessageId });
      }
      if (page.nextCursor !== null && typeof page.nextCursor !== 'string') {
        throw new Error('Invalid native queue cursor');
      }
      cursor = page.nextCursor;
      if (cursor !== null && (typeof cursor !== 'string' || !/^[0-9]{1,12}$/.test(cursor) || seen.has(cursor))) {
        throw new Error('Invalid native queue cursor');
      }
      if (cursor) seen.add(cursor);
      if (submissions.length > 2000) throw new Error('Native queue exceeds inspection bound');
    } while (cursor);
    return submissions;
  }

  /** Admit an input only to an existing idle thread, retaining its native model/config. */
  async startExistingThreadTurn(
    threadId: string,
    message: string,
    cwd?: string,
    config?: Record<string, JsonValue>,
    clientUserMessageId?: string,
    onAdmissionPhase?: (phase: 'resume' | 'start') => void,
  ): Promise<string> {
    const turn = await this.submitNativeInput({ kind: 'start', params: {
      threadId, message, cwd, clientUserMessageId,
    }, existingThread: { config, onPhase: onAdmissionPhase } });
    return turn.turnId;
  }

  /** Ordinary saved-thread input: native turn/start owns start-versus-steer.
   * App state is not an admission lock; the caller must reserve a durable
   * client ID and verify its original scoped binding before invoking this.
   */
  async submitSavedThreadInput(threadId: string, message: string, cwd: string,
    clientUserMessageId: string): Promise<string> {
    // Do not hydrate a long saved conversation merely to check its native
    // identity and loaded state before submitting the next input.
    const { thread } = await this.client.threadRead({ threadId, includeTurns: false });
    if (thread.id !== threadId || thread.cwd !== cwd ||
        !['idle', 'active', 'notLoaded'].includes(thread.status.type))
      throw new Error('Saved native thread identity or state unavailable');
    if (thread.status.type === 'notLoaded') {
      await this.resumeExistingInputThread({ threadId, cwd, config: { mcp_servers: {} } });
    }
    // OIX turn/start calls start_or_steer_turn. Never speculate about active
    // ownership here or turn a stale app observation into a second queue.
    const turn = await this.client.startTurn({ threadId, message, cwd, clientUserMessageId });
    this.activeTurns.set(threadId, turn.id);
    return turn.id;
  }

  async setThreadName(threadId: string, name: string): Promise<void> {
    await this.client.threadSetName({ threadId, name });
  }

  async getThreadGoal(threadId: string): Promise<v2.ThreadGoal | null> {
    const result = await this.client.threadGoalGet({ threadId });
    return result.goal;
  }

  /** Read exact native CAS identity; an old runtime or contradictory receipt is unavailable. */
  async getThreadGoalWithRevision(threadId: string, maxWaitMs = 3_000): Promise<{
    goal: v2.ThreadGoal | null;
    revision: ThreadGoalRevision | null;
  }> {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(threadId) ||
          !Number.isSafeInteger(maxWaitMs) || maxWaitMs < 1 || maxWaitMs > 3_000) {
        throw new GoalRevisionUnavailableError();
      }
      if (!this.client.threadGoalRevisionGet) throw new GoalRevisionUnavailableError();
      const result = await Promise.race([
        this.client.threadGoalRevisionGet({ threadId }),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new GoalRevisionUnavailableError()), maxWaitMs);
        }),
      ]);
      const revision = verifyThreadGoalRevision(result.goal, (result as { revision?: unknown }).revision,
        threadId);
      return { goal: result.goal, revision };
    } catch {
      throw new GoalRevisionUnavailableError();
    } finally {
      if (deadline) clearTimeout(deadline);
    }
  }

  /** The native runtime, not a preceding GET, atomically enforces this expected state. */
  async setThreadGoalWithRevision(
    threadId: string,
    expected: ThreadGoalRevision,
    change: { objective?: string; status?: v2.ThreadGoalStatus; tokenBudget?: number | null },
    maxWaitMs = 3_000,
  ): Promise<{ goal: v2.ThreadGoal; revision: ThreadGoalRevision }> {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(threadId) ||
        !this.client.threadGoalRevisionSet || !change ||
        !Number.isSafeInteger(maxWaitMs) || maxWaitMs < 1 || maxWaitMs > 3_000 ||
        !Object.entries(change).some(([key, value]) =>
          ['objective', 'status', 'tokenBudget'].includes(key) && value !== undefined) ||
        Object.keys(change).some(key => !['objective', 'status', 'tokenBudget'].includes(key)) ||
        (change.objective !== undefined && (typeof change.objective !== 'string' || !change.objective.trim())) ||
        (change.status !== undefined && !['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'].includes(change.status)) ||
        (change.tokenBudget !== undefined && change.tokenBudget !== null &&
          (!Number.isSafeInteger(change.tokenBudget) || change.tokenBudget <= 0))) {
      throw new GoalRevisionUnavailableError();
    }
    const params = { threadId, ...change, ...goalCasExpectedParams(expected) };
    // A rejected/unknown native mutation is never reissued here. No read-then-write fallback.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.client.threadGoalRevisionSet(params as v2.ThreadGoalSetParams),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new GoalMutationUnconfirmedError()), maxWaitMs);
        }),
      ]);
      const revision = verifyThreadGoalRevision(result.goal,
        (result as { revision?: unknown }).revision, threadId);
      if (!revision || revision.goalId !== expected.goalId ||
          revision.lifecycleRevision !== expected.lifecycleRevision + 1 ||
          revision.missionRevision !== expected.missionRevision +
            (change.objective === undefined ? 0 : 1) ||
          change.status !== undefined && result.goal.status !== change.status ||
          change.objective !== undefined && result.goal.objective !== change.objective ||
          change.tokenBudget !== undefined && result.goal.tokenBudget !== change.tokenBudget) {
        throw new GoalRevisionUnavailableError();
      }
      return { goal: result.goal, revision };
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === -32009) {
        throw new GoalRevisionConflictError();
      }
      throw new GoalMutationUnconfirmedError();
    } finally {
      if (deadline) clearTimeout(deadline);
    }
  }

  /** Full mission bytes remain in OIX's owned state directory, not an app file. */
  async getThreadGoalDocument(threadId: string): Promise<ThreadGoalDocumentGetResponse> {
    verifyGoalDocument(threadId, null, null);
    if (!this.client.threadGoalDocumentGet) throw new ManagedGoalDocumentError('read_unavailable');
    try {
      const result = await this.client.threadGoalDocumentGet({ threadId });
      verifyGoalDocument(threadId, result.document, result.content);
      if (result.goal !== null && result.goal?.threadId !== threadId ||
          (result.goal === null) !== (result.document === null)) {
        throw new Error('Invalid managed Goal document owner.');
      }
      return result;
    } catch {
      throw new ManagedGoalDocumentError('read_unavailable');
    }
  }

  /** One exact predecessor and stable creation ID, atomically enforced by OIX.
   * Never fall back to document/set when this experimental method is absent. */
  async createThreadGoalDocument(
    input: ThreadGoalDocumentCreateParams,
    maxWaitMs = 3_000,
  ): Promise<ThreadGoalDocumentCreateResponse> {
    validateGoalDocumentInput(input);
    if (!this.client.threadGoalDocumentCreate || !Number.isSafeInteger(maxWaitMs) ||
        maxWaitMs < 1 || maxWaitMs > 3_000) {
      throw new ManagedGoalDocumentError('create_unavailable');
    }
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.client.threadGoalDocumentCreate(input),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new ManagedGoalDocumentError('update_unconfirmed')),
            maxWaitMs);
        }),
      ]);
      return result;
    } catch (error) {
      // This fixed native error code is the only authoritative CAS conflict.
      // All transport/timeout failures remain unknown, never replay permission.
      if (error && typeof error === 'object' && 'code' in error && error.code === -32009) {
        throw new ManagedGoalDocumentError('stale_predecessor');
      }
      if (error && typeof error === 'object' && 'code' in error && error.code === -32601) {
        throw new ManagedGoalDocumentError('create_unavailable');
      }
      throw new ManagedGoalDocumentError('update_unconfirmed');
    } finally { if (deadline) clearTimeout(deadline); }
  }

  async setThreadGoalDocument(input: ThreadGoalDocumentSetParams): Promise<ThreadGoalDocumentSetResponse> {
    validateGoalDocumentInput(input);
    if (!this.client.threadGoalDocumentSet) throw new ManagedGoalDocumentError('update_unconfirmed');
    try {
      const result = await this.client.threadGoalDocumentSet(input);
      verifyGoalDocument(input.threadId, result.document, input.document);
      if (result.goal?.threadId !== input.threadId ||
          input.expectedMissionRevision != null &&
          result.document.missionRevision !== input.expectedMissionRevision + 1 ||
          input.status != null && result.goal.status !== input.status) {
        throw new Error('Invalid managed Goal document update receipt.');
      }
      return result;
    } catch {
      throw new ManagedGoalDocumentError('update_unconfirmed');
    }
  }

  /** One native transaction updates the file pointer and Goal only if all expected state matches. */
  async setThreadGoalDocumentWithRevision(
    input: Omit<ThreadGoalDocumentSetParams, 'expectedMissionRevision' | 'expectedGoalId' |
      'expectedStatus' | 'expectedLifecycleRevision'>,
    expected: ThreadGoalRevision,
    maxWaitMs = 3_000,
  ): Promise<{ goal: v2.ThreadGoal; document: ThreadGoalDocumentSetResponse['document'];
    revision: ThreadGoalRevision }> {
    validateGoalDocumentInput(input);
    if (!this.client.threadGoalDocumentRevisionSet || !Number.isSafeInteger(maxWaitMs) ||
        maxWaitMs < 1 || maxWaitMs > 3_000) {
      throw new ManagedGoalDocumentError('update_unconfirmed');
    }
    const params = { ...input, ...goalCasExpectedParams(expected) };
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.client.threadGoalDocumentRevisionSet(params),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new ManagedGoalDocumentError('update_unconfirmed')),
            maxWaitMs);
        }),
      ]);
      verifyGoalDocument(input.threadId, result.document, input.document);
      const revision = verifyThreadGoalRevision(result.goal, result.revision, input.threadId);
      if (!revision || revision.goalId !== expected.goalId ||
          revision.missionRevision !== expected.missionRevision + 1 ||
          revision.lifecycleRevision !== expected.lifecycleRevision + 1 ||
          result.document.missionRevision !== revision.missionRevision ||
          result.goal.status !== (input.status ?? expected.status)) {
        throw new ManagedGoalDocumentError('update_unconfirmed');
      }
      return { goal: result.goal, document: result.document, revision };
    } catch (error) {
      // Only native's fixed conflict code proves this CAS was rejected. A
      // transport loss can mean the write committed; reconcile, never replay.
      if (error && typeof error === 'object' && 'code' in error && error.code === -32009) {
        throw new ManagedGoalDocumentError('stale_revision');
      }
      throw new ManagedGoalDocumentError('update_unconfirmed');
    } finally {
      if (deadline) clearTimeout(deadline);
    }
  }

  async setThreadGoal(
    threadId: string,
    update: Omit<v2.ThreadGoalSetParams, 'threadId'>,
  ): Promise<v2.ThreadGoal> {
    const result = await this.client.threadGoalSet({ threadId, ...update });
    return result.goal;
  }

  async clearThreadGoal(threadId: string): Promise<boolean> {
    const result = await this.client.threadGoalClear({ threadId });
    return result.cleared;
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.client.threadArchive({ threadId });
  }

  async unarchiveThread(threadId: string): Promise<void> {
    await this.client.threadUnarchive({ threadId });
  }

  async listSkills(params?: v2.SkillsListParams): Promise<v2.SkillsListResponse> {
    await this.client.ensureConnected();
    return this.client.skillsList(params ?? {});
  }

  async writeSkillConfig(
    params: v2.SkillsConfigWriteParams,
  ): Promise<v2.SkillsConfigWriteResponse> {
    await this.client.ensureConnected();
    return this.client.skillsConfigWrite(params);
  }

  async interrupt(threadId: string, turnId?: string) {
    const activeTurnId = turnId ?? this.activeTurns.get(threadId);
    if (!activeTurnId) {
      return;
    }

    await this.client.interruptTurn(threadId, activeTurnId);
  }

  async steer(
    threadId: string,
    params: {
      turnId?: string;
      message?: string;
      clientUserMessageId?: string;
      attachments?: StreamImageAttachment[];
      skills?: StreamSkillReference[];
    },
  ): Promise<string> {
    let activeTurnId = params.turnId ?? this.activeTurns.get(threadId);
    if (!activeTurnId) {
      throw new Error("no active turn to steer");
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await this.submitNativeInput({ kind: 'steer', params: {
          threadId,
          turnId: activeTurnId,
          message: params.message,
          ...(params.clientUserMessageId ? { clientUserMessageId: params.clientUserMessageId } : {}),
          attachments: params.attachments,
          skills: params.skills,
        } });
        return response.turnId;
      } catch (error) {
        const actualTurnId = extractSteerMismatchActualTurnId(error);
        if (attempt === 0 && actualTurnId && actualTurnId !== activeTurnId) {
          activeTurnId = actualTurnId;
          this.activeTurns.set(threadId, actualTurnId);
          continue;
        }

        if (isNoActiveTurnSteerError(error)) {
          this.activeTurns.delete(threadId);
        }
        throw error;
      }
    }

    throw new Error("Failed to steer active turn.");
  }

  async cleanBackgroundTerminals(threadId: string) {
    await this.client.threadBackgroundTerminalsClean(threadId);
  }

  private belongsToTurn(
    notification: AppServerNotification,
    threadId: string,
    turnId: string,
  ) {
    const eventThreadId = extractNotificationThreadId(notification);
    if (eventThreadId && eventThreadId !== threadId) {
      return false;
    }

    const eventTurnId = extractNotificationTurnId(notification);
    if (turnId && eventTurnId && eventTurnId !== turnId) {
      return false;
    }

    if (!eventThreadId && !eventTurnId) {
      return false;
    }

    return true;
  }

  private async resolveThread(
    model: string,
    modelProvider?: string | null,
    cwd?: string,
    baseInstructions?: string,
    developerInstructions?: string,
    config?: Record<string, JsonValue> | null,
    dynamicTools?: v2.DynamicToolSpec[] | null,
    additionalWritableRoots?: string[],
  ) {
    return this.client.startThreadWithConfig(
      model, modelProvider, baseInstructions, cwd,
      withElectronRunAsNodeConfig(config), developerInstructions,
      dynamicTools, additionalWritableRoots,
    );
  }
}

let sharedClient: CodexAppServerClient | null = null;
let sharedMcpClient: CodexAppServerClient | null = null;
const persistentNotificationSubscribers = new Set<(notification: AppServerNotification) => void>();
let sharedNotificationUnsubscribe: (() => void) | null = null;

function attachPersistentNotificationSubscribers(client: CodexAppServerClient): void {
  sharedNotificationUnsubscribe?.();
  sharedNotificationUnsubscribe = client.subscribe((notification) => {
    for (const subscriber of persistentNotificationSubscribers) {
      try {
        subscriber(notification);
      } catch {
        console.error('[interpreter-server] persistent notification subscriber failed');
      }
    }
  });
}

/**
 * Observe notifications across shared app-server restarts. Runtime profile
 * changes intentionally replace the shared client; publication and other
 * process-level observers must survive that replacement.
 */
export function subscribeCodexNotifications(
  handler: (notification: AppServerNotification) => void,
): () => void {
  persistentNotificationSubscribers.add(handler);
  getCodexClient();
  return () => persistentNotificationSubscribers.delete(handler);
}

export function getCodexClient(): CodexClient {
  if (!sharedClient) {
    // Keep the shared app-server runtime profile-driven:
    // - OpenAI OAuth uses persisted ChatGPT auth in CODEX_HOME
    // - API/local/hosted profiles inject credentials through provider config
    // Do not let a global OPENAI_API_KEY hijack the shared runtime's account
    // mode, or switching/restarting can wipe ChatGPT auth for openai-oauth.
    sharedClient = new CodexAppServerClient(
      new StdioJsonRpcTransport(undefined, undefined, loadCodexRuntimeAccessSnapshot),
      null,
      loadCodexRuntimeAccessSnapshot,
    );
    attachCodexServerRequestApprovals(sharedClient);
    attachPersistentNotificationSubscribers(sharedClient);
  }
  return sharedClient;
}

export function getMcpCodexClient(): CodexClient {
  if (!sharedMcpClient) {
    // App MCP servers need an app-server runtime connection for status reads
    // and approved `mcpServer/tool/call` RPCs. Keep this helper synced from
    // Interpreter config so MCP management can refresh independently.
    sharedMcpClient = new CodexAppServerClient(
      new StdioJsonRpcTransport(undefined, undefined, loadCodexRuntimeAccessSnapshot),
      null,
      loadCodexRuntimeAccessSnapshot,
      { syncMcpServersFromConfigStore: true },
    );
  }
  return sharedMcpClient;
}

let service: CodexService | null = null;

export function getCodexService(): CodexService {
  if (!service) {
    service = new CodexService(getCodexClient());
  }
  return service;
}

/**
 * Shut down the shared Codex app-server process and reset singletons.
 */
export function shutdownCodexRuntime(): void {
  sharedNotificationUnsubscribe?.();
  sharedNotificationUnsubscribe = null;
  if (sharedClient) {
    sharedClient.shutdown();
    sharedClient = null;
  }
  if (sharedMcpClient) {
    sharedMcpClient.shutdown();
    sharedMcpClient = null;
  }
  service = null;
}

/**
 * Restart lazily: stop the current runtime now; the next client/service lookup
 * spawns a fresh process with the latest config.
 */
export function restartCodexRuntime(): void {
  shutdownCodexRuntime();
}
