import type {
  ClientNotification,
  ClientRequest,
  InitializeParams,
  InitializeResponse,
  ServerNotification,
  ServerRequest,
  v2,
} from "../../../server/handlers/codex-generated-types/index";
import type { JsonValue } from "../../../server/handlers/codex-generated-types/serde_json/JsonValue";

type ClientMethod =
  | ClientRequest["method"]
  | "thread/backgroundTerminals/clean"
  | "mcpServer/tool/call"
  | "mcpServer/resource/read";
type ServerMethod = ServerNotification["method"];
type ServerRequestMethod = ServerRequest["method"];

export const CLIENT_METHOD = {
  initialize: "initialize",
  accountLoginStart: "account/login/start",
  threadStart: "thread/start",
  threadResume: "thread/resume",
  threadSetName: "thread/name/set",
  threadArchive: "thread/archive",
  threadUnarchive: "thread/unarchive",
  threadBackgroundTerminalsClean: "thread/backgroundTerminals/clean",
  skillsList: "skills/list",
  skillsConfigWrite: "skills/config/write",
  windowsSandboxSetupStart: "windowsSandbox/setupStart",
  turnStart: "turn/start",
  turnSteer: "turn/steer",
  turnInterrupt: "turn/interrupt",
  configValueWrite: "config/value/write",
  configRead: "config/read",
  configBatchWrite: "config/batchWrite",
  mcpServerReload: "config/mcpServer/reload",
  mcpServerStatusList: "mcpServerStatus/list",
  mcpServerOauthLogin: "mcpServer/oauth/login",
  mcpServerToolCall: "mcpServer/tool/call",
  mcpResourceRead: "mcpServer/resource/read",
  threadList: "thread/list",
  threadRead: "thread/read",
  modelList: "model/list",
  interpreterProviderList: "interpreter/provider/list",
  interpreterProviderSet: "interpreter/provider/set",
  interpreterModelList: "interpreter/model/list",
  interpreterModelSet: "interpreter/model/set",
  interpreterHarnessList: "interpreter/harness/list",
  interpreterHarnessSet: "interpreter/harness/set",
  accountRead: "account/read",
  accountLogout: "account/logout",
  accountLoginCancel: "account/login/cancel",
} as const satisfies Record<string, ClientMethod>;

export const CLIENT_NOTIFICATION_METHOD = {
  initialized: "initialized",
} as const satisfies Record<string, ClientNotification["method"]>;

export const SERVER_METHOD = {
  threadStarted: "thread/started",
  skillsChanged: "skills/changed",
  turnStarted: "turn/started",
  turnCompleted: "turn/completed",
  turnPlanUpdated: "turn/plan/updated",
  itemStarted: "item/started",
  itemCompleted: "item/completed",
  planDelta: "item/plan/delta",
  rawResponseItemCompleted: "rawResponseItem/completed",
  agentMessageDelta: "item/agentMessage/delta",
  reasoningSummaryTextDelta: "item/reasoning/summaryTextDelta",
  reasoningSummaryPartAdded: "item/reasoning/summaryPartAdded",
  reasoningTextDelta: "item/reasoning/textDelta",
  threadCompacted: "thread/compacted",
  commandExecutionOutputDelta: "item/commandExecution/outputDelta",
  commandExecutionTerminalInteraction: "item/commandExecution/terminalInteraction",
  fileChangeOutputDelta: "item/fileChange/outputDelta",
  mcpToolCallProgress: "item/mcpToolCall/progress",
  streamError: "error",
  mcpServerOauthLoginCompleted: "mcpServer/oauthLogin/completed",
  mcpServerStartupStatusUpdated: "mcpServer/startupStatus/updated",
  threadNameUpdated: "thread/name/updated",
  accountLoginCompleted: "account/login/completed",
  accountUpdated: "account/updated",
  windowsSandboxSetupCompleted: "windowsSandbox/setupCompleted",
} as const satisfies Record<string, ServerMethod>;

// NOTE(victor): These RPC param/response types are not yet in the generated
// codex-rs bindings. They mirror the Rust server-side structs for
// mcpServer/tool/call and mcpServer/resource/read.
export type McpServerToolCallParams = {
  threadId: string;
  server: string;
  tool: string;
  arguments: Record<string, unknown> | null;
};

export type McpServerToolCallResponse = {
  content: Array<JsonValue>;
  structuredContent: JsonValue | null;
  isError: boolean;
};

export type McpResourceReadParams = {
  threadId: string;
  server: string;
  uri: string;
};

export type McpResourceReadResponse = {
  contents: Array<{
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
  }>;
};

// NOTE: the vendored app-server protocol already supports the lighter
// `toolsAndAuthOnly` MCP status detail, but the generated app bindings in this
// repo have not caught up yet. Keep this local extension narrow and remove it
// once the generated types include `detail`.
export type McpServerStatusListParams = v2.ListMcpServerStatusParams & {
  detail?: "full" | "toolsAndAuthOnly" | null;
};

export type RequestMap = {
  [CLIENT_METHOD.initialize]: {
    params: InitializeParams;
    result: InitializeResponse;
  };
  [CLIENT_METHOD.threadStart]: {
    params: v2.ThreadStartParams;
    result: v2.ThreadStartResponse;
  };
  [CLIENT_METHOD.accountLoginStart]: {
    params: v2.LoginAccountParams;
    result: v2.LoginAccountResponse;
  };
  [CLIENT_METHOD.threadResume]: {
    params: v2.ThreadResumeParams;
    result: v2.ThreadResumeResponse;
  };
  [CLIENT_METHOD.threadSetName]: {
    params: v2.ThreadSetNameParams;
    result: v2.ThreadSetNameResponse;
  };
  [CLIENT_METHOD.threadArchive]: {
    params: v2.ThreadArchiveParams;
    result: v2.ThreadArchiveResponse;
  };
  [CLIENT_METHOD.threadUnarchive]: {
    params: v2.ThreadUnarchiveParams;
    result: v2.ThreadUnarchiveResponse;
  };
  [CLIENT_METHOD.threadBackgroundTerminalsClean]: {
    params: {
      threadId: string;
    };
    result: Record<string, never>;
  };
  [CLIENT_METHOD.skillsList]: {
    params: v2.SkillsListParams;
    result: v2.SkillsListResponse;
  };
  [CLIENT_METHOD.skillsConfigWrite]: {
    params: v2.SkillsConfigWriteParams;
    result: v2.SkillsConfigWriteResponse;
  };
  [CLIENT_METHOD.windowsSandboxSetupStart]: {
    params: v2.WindowsSandboxSetupStartParams;
    result: v2.WindowsSandboxSetupStartResponse;
  };
  [CLIENT_METHOD.turnStart]: {
    params: v2.TurnStartParams;
    result: v2.TurnStartResponse;
  };
  [CLIENT_METHOD.turnSteer]: {
    params: v2.TurnSteerParams;
    result: v2.TurnSteerResponse;
  };
  [CLIENT_METHOD.turnInterrupt]: {
    params: v2.TurnInterruptParams;
    result: v2.TurnInterruptResponse;
  };
  [CLIENT_METHOD.configValueWrite]: {
    params: v2.ConfigValueWriteParams;
    result: v2.ConfigWriteResponse;
  };
  [CLIENT_METHOD.configRead]: {
    params: v2.ConfigReadParams;
    result: v2.ConfigReadResponse;
  };
  [CLIENT_METHOD.configBatchWrite]: {
    params: v2.ConfigBatchWriteParams;
    result: v2.ConfigWriteResponse;
  };
  [CLIENT_METHOD.mcpServerReload]: {
    params: undefined;
    result: v2.McpServerRefreshResponse;
  };
  [CLIENT_METHOD.mcpServerStatusList]: {
    params: McpServerStatusListParams;
    result: v2.ListMcpServerStatusResponse;
  };
  [CLIENT_METHOD.mcpServerOauthLogin]: {
    params: v2.McpServerOauthLoginParams;
    result: v2.McpServerOauthLoginResponse;
  };
  [CLIENT_METHOD.mcpServerToolCall]: {
    params: McpServerToolCallParams;
    result: McpServerToolCallResponse;
  };
  [CLIENT_METHOD.mcpResourceRead]: {
    params: McpResourceReadParams;
    result: McpResourceReadResponse;
  };
  [CLIENT_METHOD.threadList]: {
    params: v2.ThreadListParams;
    result: v2.ThreadListResponse;
  };
  [CLIENT_METHOD.threadRead]: {
    params: v2.ThreadReadParams;
    result: v2.ThreadReadResponse;
  };
  [CLIENT_METHOD.modelList]: {
    params: v2.ModelListParams;
    result: v2.ModelListResponse;
  };
  [CLIENT_METHOD.interpreterProviderList]: {
    params: v2.InterpreterProviderListParams;
    result: v2.InterpreterProviderListResponse;
  };
  [CLIENT_METHOD.interpreterProviderSet]: {
    params: v2.InterpreterProviderSetParams;
    result: v2.InterpreterProviderSetResponse;
  };
  [CLIENT_METHOD.interpreterModelList]: {
    params: v2.InterpreterModelListParams;
    result: v2.InterpreterModelListResponse;
  };
  [CLIENT_METHOD.interpreterModelSet]: {
    params: v2.InterpreterModelSetParams;
    result: v2.InterpreterModelSetResponse;
  };
  [CLIENT_METHOD.interpreterHarnessList]: {
    params: v2.InterpreterHarnessListParams;
    result: v2.InterpreterHarnessListResponse;
  };
  [CLIENT_METHOD.interpreterHarnessSet]: {
    params: v2.InterpreterHarnessSetParams;
    result: v2.InterpreterHarnessSetResponse;
  };
  [CLIENT_METHOD.accountRead]: {
    params: v2.GetAccountParams;
    result: v2.GetAccountResponse;
  };
  [CLIENT_METHOD.accountLogout]: {
    params: undefined;
    result: v2.LogoutAccountResponse;
  };
  [CLIENT_METHOD.accountLoginCancel]: {
    params: v2.CancelLoginAccountParams;
    result: v2.CancelLoginAccountResponse;
  };
};

export const SERVER_REQUEST_METHOD = {
  commandExecutionApproval: "item/commandExecution/requestApproval",
  fileChangeApproval: "item/fileChange/requestApproval",
  toolRequestUserInput: "item/tool/requestUserInput",
  mcpServerElicitationRequest: "mcpServer/elicitation/request",
  toolCall: "item/tool/call",

  applyPatchApproval: "applyPatchApproval",
  execCommandApproval: "execCommandApproval",
} as const satisfies Record<string, ServerRequestMethod>;

export type { ServerRequest };

export type NotificationOfMethod<M extends ServerMethod> = Extract<
  ServerNotification,
  { method: M }
>;

export type AppServerNotification = ServerNotification;

// --- MCP server config types ---

export type AppToolApproval = v2.AppToolApproval;

export type McpServerToolConfig = {
  readonly approvalMode?: AppToolApproval;
};

export type McpServerToolTomlConfig = {
  approval_mode?: AppToolApproval;
};

export type StdioTransportConfig = {
  readonly transport: "stdio";
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
  readonly envVars?: ReadonlyArray<string>;
  readonly cwd?: string;
};

export type StreamableHttpTransportConfig = {
  readonly transport: "streamable_http";
  readonly url: string;
  readonly oauthResource?: string;
  readonly bearerTokenEnvVar?: string;
  readonly httpHeaders?: Readonly<Record<string, string>>;
  readonly envHttpHeaders?: Readonly<Record<string, string>>;
};

export type McpTransportConfig =
  | StdioTransportConfig
  | StreamableHttpTransportConfig;

export type McpServerSharedConfig = {
  readonly enabled?: boolean;
  readonly required?: boolean;
  readonly startupTimeoutSec?: number;
  readonly toolTimeoutSec?: number;
  readonly defaultToolsApprovalMode?: AppToolApproval;
  readonly tools?: Readonly<Record<string, McpServerToolConfig>>;
  readonly enabledTools?: ReadonlyArray<string>;
  readonly disabledTools?: ReadonlyArray<string>;
  readonly scopes?: ReadonlyArray<string>;
};

export type McpServerConfig = McpTransportConfig & McpServerSharedConfig;

export type McpServerEntry = {
  readonly name: string;
  readonly config: McpServerConfig;
};

// --- TOML wire format ---

export type McpServerTomlEntry = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  env_vars?: string[];
  cwd?: string;
  url?: string;
  oauth_resource?: string;
  bearer_token_env_var?: string;
  http_headers?: Record<string, string>;
  env_http_headers?: Record<string, string>;
  enabled?: boolean;
  required?: boolean;
  startup_timeout_sec?: number;
  tool_timeout_sec?: number;
  default_tools_approval_mode?: AppToolApproval;
  tools?: Record<string, McpServerToolTomlConfig>;
  enabled_tools?: string[];
  disabled_tools?: string[];
  scopes?: string[];
};

// --- Compile-time drift guards ---
// If a field is added to any config type but not to McpServerTomlEntry
// (or vice versa), one of these assertions will fail.

type Expect<T extends true> = T;
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y
  ? 1
  : 2
  ? true
  : false;

type ConfigToTomlKeyMap = {
  command: "command";
  args: "args";
  env: "env";
  envVars: "env_vars";
  cwd: "cwd";
  url: "url";
  oauthResource: "oauth_resource";
  bearerTokenEnvVar: "bearer_token_env_var";
  httpHeaders: "http_headers";
  envHttpHeaders: "env_http_headers";
  enabled: "enabled";
  required: "required";
  startupTimeoutSec: "startup_timeout_sec";
  toolTimeoutSec: "tool_timeout_sec";
  defaultToolsApprovalMode: "default_tools_approval_mode";
  tools: "tools";
  enabledTools: "enabled_tools";
  disabledTools: "disabled_tools";
  scopes: "scopes";
};

type AllConfigKeys = Exclude<
  | keyof StdioTransportConfig
  | keyof StreamableHttpTransportConfig
  | keyof McpServerSharedConfig,
  "transport"
>;

export type AssertAllConfigKeysMapped = Expect<
  Equal<keyof ConfigToTomlKeyMap, AllConfigKeys>
>;
export type AssertTomlKeysMatch = Expect<
  Equal<keyof McpServerTomlEntry, ConfigToTomlKeyMap[keyof ConfigToTomlKeyMap]>
>;

function setIfDefined(
  target: Record<string, JsonValue | undefined>,
  key: string,
  value: JsonValue | undefined,
) {
  if (value !== undefined) {
    target[key] = value;
  }
}

type McpServerTomlWire = McpServerTomlEntry &
  Record<string, JsonValue | undefined>;

export function mcpServerEntryToToml(entry: McpServerEntry): McpServerTomlWire {
  const result: Record<string, JsonValue | undefined> = {};
  const { config } = entry;

  if (config.transport === "stdio") {
    setIfDefined(result, "command", config.command);
    setIfDefined(result, "args", config.args && [...config.args]);
    setIfDefined(result, "env", config.env && { ...config.env });
    setIfDefined(result, "env_vars", config.envVars && [...config.envVars]);
    setIfDefined(result, "cwd", config.cwd);
  } else {
    setIfDefined(result, "url", config.url);
    setIfDefined(result, "oauth_resource", config.oauthResource);
    setIfDefined(result, "bearer_token_env_var", config.bearerTokenEnvVar);
    setIfDefined(
      result,
      "http_headers",
      config.httpHeaders && { ...config.httpHeaders },
    );
    setIfDefined(
      result,
      "env_http_headers",
      config.envHttpHeaders && { ...config.envHttpHeaders },
    );
  }

  setIfDefined(result, "enabled", config.enabled);
  setIfDefined(result, "required", config.required);
  setIfDefined(result, "startup_timeout_sec", config.startupTimeoutSec);
  setIfDefined(result, "tool_timeout_sec", config.toolTimeoutSec);
  setIfDefined(
    result,
    "default_tools_approval_mode",
    config.defaultToolsApprovalMode,
  );
  if (config.tools !== undefined) {
    result.tools = Object.fromEntries(
      Object.entries(config.tools).flatMap(([toolName, toolConfig]) => (
        toolConfig.approvalMode === undefined
          ? []
          : [[toolName, { approval_mode: toolConfig.approvalMode }]]
      )),
    ) as JsonValue;
  }
  setIfDefined(
    result,
    "enabled_tools",
    config.enabledTools && [...config.enabledTools],
  );
  setIfDefined(
    result,
    "disabled_tools",
    config.disabledTools && [...config.disabledTools],
  );
  setIfDefined(result, "scopes", config.scopes && [...config.scopes]);

  return result as McpServerTomlWire;
}

export function tomlEntryToMcpServerConfig(
  toml: McpServerTomlEntry,
): McpServerConfig {
  const hasCommand = toml.command !== undefined;
  const hasUrl = toml.url !== undefined;

  if (hasCommand === hasUrl) {
    throw new Error(
      "Cannot infer transport: entry must have exactly one of 'command' (stdio) or 'url' (streamable_http)",
    );
  }

  const shared: McpServerSharedConfig = {
    ...(toml.enabled !== undefined && { enabled: toml.enabled }),
    ...(toml.required !== undefined && { required: toml.required }),
    ...(toml.startup_timeout_sec !== undefined && {
      startupTimeoutSec: toml.startup_timeout_sec,
    }),
    ...(toml.tool_timeout_sec !== undefined && {
      toolTimeoutSec: toml.tool_timeout_sec,
    }),
    ...(toml.default_tools_approval_mode !== undefined && {
      defaultToolsApprovalMode: toml.default_tools_approval_mode,
    }),
    ...(toml.tools !== undefined && {
      tools: Object.fromEntries(
        Object.entries(toml.tools).flatMap(([toolName, toolConfig]) => (
          toolConfig.approval_mode === undefined
            ? []
            : [[toolName, { approvalMode: toolConfig.approval_mode }]]
        )),
      ),
    }),
    ...(toml.enabled_tools !== undefined && {
      enabledTools: toml.enabled_tools,
    }),
    ...(toml.disabled_tools !== undefined && {
      disabledTools: toml.disabled_tools,
    }),
    ...(toml.scopes !== undefined && { scopes: toml.scopes }),
  };

  if (hasCommand) {
    return {
      transport: "stdio" as const,
      command: toml.command!,
      ...(toml.args !== undefined && { args: toml.args }),
      ...(toml.env !== undefined && { env: toml.env }),
      ...(toml.env_vars !== undefined && { envVars: toml.env_vars }),
      ...(toml.cwd !== undefined && { cwd: toml.cwd }),
      ...shared,
    };
  }

  return {
    transport: "streamable_http" as const,
    url: toml.url!,
    ...(toml.oauth_resource !== undefined && {
      oauthResource: toml.oauth_resource,
    }),
    ...(toml.bearer_token_env_var !== undefined && {
      bearerTokenEnvVar: toml.bearer_token_env_var,
    }),
    ...(toml.http_headers !== undefined && {
      httpHeaders: toml.http_headers,
    }),
    ...(toml.env_http_headers !== undefined && {
      envHttpHeaders: toml.env_http_headers,
    }),
    ...shared,
  };
}
