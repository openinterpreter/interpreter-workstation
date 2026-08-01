import { match } from "ts-pattern";
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
import { isThreadUnavailableError } from "../../../server/utils/codexThreadRecovery";

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
  effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | null;
  summary?: "auto" | "concise" | "detailed" | "none" | null;
  idleTimeoutMs?: number | null;
  onEvent: (event: StreamEvent) => void;
  signal?: AbortSignal;
  dynamicTools?: v2.DynamicToolSpec[] | null;
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
  ): Promise<string>;
  startTurn(params: {
    threadId: string;
    message?: string;
    attachments?: StreamImageAttachment[];
    skills?: StreamSkillReference[];
    sandboxPolicy?: v2.SandboxPolicy;
    cwd?: string;
    model?: string;
    effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | null;
    summary?: "auto" | "concise" | "detailed" | "none" | null;
  }): Promise<v2.Turn>;
  steerTurn(params: {
    threadId: string;
    turnId: string;
    message?: string;
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
  threadRead(params: v2.ThreadReadParams): Promise<v2.ThreadReadResponse>;
  threadSetName(params: v2.ThreadSetNameParams): Promise<v2.ThreadSetNameResponse>;
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

function extractThreadId(notification: AppServerNotification) {
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

function extractTurnId(notification: AppServerNotification) {
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

  constructor(private readonly client: CodexClient) {}

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

  async runTurn(options: RunTurnOptions) {
    if (options.threadId) {
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

    const threadId = await this.resolveThread(
      options.threadId,
      options.model,
      options.modelProvider,
      options.cwd,
      options.baseInstructions,
      options.developerInstructions,
      runConfig,
      options.dynamicTools,
    );
    this.assertNoActiveTurn(threadId);
    this.activeTurns.set(threadId, null);
    options.onEvent({ kind: "thread", threadId });
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
      this.activeTurns.delete(threadId);
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
      unsubscribe = this.client.subscribe((notification) => {
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

        options.onEvent({ kind: "notification", notification });
        scheduleIdleTimeout(describeTurnActivity(notification));

        if (notification.method === SERVER_METHOD.turnCompleted) {
          pendingTurnCompletion = {
            turnId: notification.params.turn.id,
            status: notification.params.turn.status,
          };
          schedulePendingTurnCompletion();
          return;
        }
      });

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
      const turn = await this.client.startTurn({
        threadId,
        message: options.message,
        attachments: options.attachments,
        skills: options.skills,
        sandboxPolicy: options.sandboxPolicy,
        cwd: options.cwd,
        model: options.model,
        effort: options.effort,
        summary: options.summary,
      });

      turnId = turn.id;
      turnStarted = true;
      this.activeTurns.set(threadId, turnId);
      options.onEvent({ kind: "turn", threadId, turnId, status: turn.status });
      scheduleIdleTimeout("turn started");

      if (options.signal) {
        const interruptOnAbort = () => {
          void this.interrupt(threadId).catch(() => {});
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

  async readThread(threadId: string): Promise<v2.Thread> {
    const result = await this.client.threadRead({ threadId, includeTurns: true });
    return result.thread;
  }

  async setThreadName(threadId: string, name: string): Promise<void> {
    await this.client.threadSetName({ threadId, name });
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
        const response = await this.client.steerTurn({
          threadId,
          turnId: activeTurnId,
          message: params.message,
          attachments: params.attachments,
          skills: params.skills,
        });
        this.activeTurns.set(threadId, response.turnId);
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
    const eventThreadId = extractThreadId(notification);
    if (eventThreadId && eventThreadId !== threadId) {
      return false;
    }

    const eventTurnId = extractTurnId(notification);
    if (turnId && eventTurnId && eventTurnId !== turnId) {
      return false;
    }

    if (!eventThreadId && !eventTurnId) {
      return false;
    }

    return true;
  }

  private async resolveThread(
    threadId: string | undefined,
    model: string,
    modelProvider?: string | null,
    cwd?: string,
    baseInstructions?: string,
    developerInstructions?: string,
    config?: Record<string, JsonValue> | null,
    dynamicTools?: v2.DynamicToolSpec[] | null,
  ) {
    const nextConfig = withElectronRunAsNodeConfig(config);

    if (!threadId) {
      return this.client.startThreadWithConfig(
        model,
        modelProvider,
        baseInstructions,
        cwd,
        nextConfig,
        developerInstructions,
        dynamicTools,
      );
    }

    try {
      return await this.client.resumeThread(
        threadId,
        modelProvider,
        model,
        cwd,
        nextConfig,
        baseInstructions,
        developerInstructions,
      );
    } catch (error) {
      // NOTE(victor): Upstream app-server reports stale thread resumes as
      // InvalidRequest markers like "thread not found", "thread not loaded", or
      // "invalid thread id". Only those should start a fresh thread; transport
      // exits still need to surface. See server/utils/codexThreadRecovery.ts and
      // codex/codex-rs/app-server/src/codex_message_processor.rs.
      if (!isThreadUnavailableError(error)) {
        throw error;
      }

      return this.client.startThreadWithConfig(
        model,
        modelProvider,
        baseInstructions,
        cwd,
        nextConfig,
        developerInstructions,
        dynamicTools,
      );
    }
  }
}

let sharedClient: CodexAppServerClient | null = null;
let sharedMcpClient: CodexAppServerClient | null = null;

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
