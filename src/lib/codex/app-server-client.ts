import { execFile, type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";
import EventEmitter from "eventemitter3";
import {
  JSONRPCClient,
  type JSONRPCRequest,
  type JSONRPCResponse,
} from "json-rpc-2.0";

import {
  isServerRequestShape,
  isValidJsonRpcResponse,
  isValidLifecycleNotification,
  isValidNotificationShape,
} from "../validators/index";
import type { v2 } from "../../../server/handlers/codex-generated-types/index";
import type { JsonValue } from "../../../server/handlers/codex-generated-types/serde_json/JsonValue";
import type {
  StreamImageAttachment,
  StreamSkillReference,
} from "./api-types";

import {
  type AppServerNotification,
  CLIENT_METHOD,
  CLIENT_NOTIFICATION_METHOD,
  type McpServerEntry,
  type McpResourceReadParams,
  type McpResourceReadResponse,
  type McpServerStatusListParams,
  type McpServerToolCallParams,
  type McpServerToolCallResponse,
  type NotificationOfMethod,
  type RequestMap,
  SERVER_METHOD,
  type ServerRequest,
  mcpServerEntryToToml,
} from "./protocol";
import {
  buildCodexSandboxPolicy,
  buildCodexWorkspacePermissionSelection,
  type CodexWorkspacePermissionSelection,
  type CodexReadAccessMode,
  type CodexSandboxMode,
} from "./sandbox-policy";
import { getInterpreterCliShellRuntimeDir } from "../../../server/utils/interpreterCliRuntime";
import {
  getBundledSkillsDisabledInCurrentApp,
  getStrippedSystemSkillPathsInCurrentApp,
  isBundledSkillEnabledInCurrentApp,
} from "../../../server/utils/bundledSkillAvailability";
import {
  resolveBundledResourceCandidates,
} from "../../../server/utils/bundledRuntimePaths";
import type {
  ToolConnectionState,
  ToolServerStatus,
} from "../../../server/tools/toolTypes";

async function getConfigApprovalPolicy(): Promise<string> {
  try {
    const { getCodexApprovalPolicy } = await import("../../../server/configStore");
    return await getCodexApprovalPolicy();
  } catch {
    return "never";
  }
}

async function getConfigSandboxMode(): Promise<CodexSandboxMode> {
  try {
    const { getCodexSandboxMode } = await import("../../../server/configStore");
    return await getCodexSandboxMode();
  } catch {
    return "workspace-write";
  }
}

async function getConfigReadAccessMode(): Promise<CodexReadAccessMode> {
  try {
    const { getCodexReadAccessMode } = await import("../../../server/configStore");
    return await getCodexReadAccessMode();
  } catch {
    return "full-system";
  }
}

async function getConfigNetworkAccess(): Promise<boolean> {
  try {
    const { getCodexNetworkAccess } = await import("../../../server/configStore");
    return await getCodexNetworkAccess();
  } catch {
    return true;
  }
}

async function getConfigMacosTempAccess(): Promise<boolean> {
  if (process.platform !== "darwin") {
    return true;
  }

  try {
    const { getCodexMacosTempAccess } = await import("../../../server/configStore");
    return await getCodexMacosTempAccess();
  } catch {
    return true;
  }
}

async function getConfigMacosScreenshotAccess(): Promise<boolean> {
  if (process.platform !== "darwin") {
    return true;
  }

  try {
    const { getCodexMacosScreenshotAccess } = await import("../../../server/configStore");
    return await getCodexMacosScreenshotAccess();
  } catch {
    return true;
  }
}

export type CodexRuntimeAccessSnapshot = {
  sandboxMode: CodexSandboxMode;
  readAccessMode: CodexReadAccessMode;
  networkAccess: boolean;
  macosTempAccess: boolean;
  macosScreenshotAccess: boolean;
};

export async function loadCodexRuntimeAccessSnapshot(): Promise<CodexRuntimeAccessSnapshot> {
  const [
    sandboxMode,
    readAccessMode,
    networkAccess,
    macosTempAccess,
    macosScreenshotAccess,
  ] = await Promise.all([
    getConfigSandboxMode(),
    getConfigReadAccessMode(),
    getConfigNetworkAccess(),
    getConfigMacosTempAccess(),
    getConfigMacosScreenshotAccess(),
  ]);

  return {
    sandboxMode,
    readAccessMode,
    networkAccess,
    macosTempAccess,
    macosScreenshotAccess,
  };
}

function buildUserInput(params: {
  message?: string;
  attachments?: StreamImageAttachment[];
  skills?: StreamSkillReference[];
}): v2.UserInput[] {
  const input: v2.UserInput[] = [];

  if (params.message?.trim()) {
    input.push({
      type: "text",
      text: params.message.trim(),
      text_elements: [],
    });
  }

  for (const attachment of params.attachments ?? []) {
    input.push({ type: "image", url: attachment.dataUrl });
  }

  for (const skill of params.skills ?? []) {
    input.push({
      type: "skill",
      name: skill.name,
      path: skill.path,
    });
  }

  return input;
}

const BUNDLED_SKILLS_DIR_NAME = "codex-skills";
const STDOUT_DIAGNOSTIC_MAX_LINES = 8;
const STDOUT_DIAGNOSTIC_MAX_CHARS_PER_LINE = 1200;
const CODEX_CLI_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const CODEX_CLI_TIMEOUT_MS = 30_000;
// Pin the interpreter runtime so it never self-updates. The OIX binary is
// bundled and code-signed inside the app (on macOS under
// Contents/Resources/oix/...); an in-place self-update rewrites files inside the
// sealed bundle and invalidates its signature, and could swap in an oix build
// whose app-server protocol no longer matches our generated TS bindings. We bump
// the bundled version deliberately (regenerate types/schema, then cut a release)
// instead. `check_for_update_on_startup` is the first gate the runtime checks
// before any startup update work, so false disables it for the spawned runtime.
const DISABLE_INTERPRETER_AUTO_UPDATE_CONFIG = "check_for_update_on_startup=false";
const CODEX_CONFIG_HEADER_PREFIX = [
  "# Interpreter user configuration",
  "# Hosted model IDs must be \"interpreter-smart\", \"interpreter-fast\", or <provider>/<model_id>.",
  "# Interpreter may repair or remove invalid [interpreter_app] profiles when it reloads this file.",
  "# API model IDs are supplied by OIX and preserved even when they are newer than Workstation's fallback catalog.",
  "# For API profiles, set base_url to the API root.",
  "# Responses is the default API wire format. API profiles use wire_api = \"chat\" only when Chat Completions is explicitly enabled in Settings.",
].join("\n");
const CODEX_CONFIG_HEADER_BLOCK = `${CODEX_CONFIG_HEADER_PREFIX}\n\n`;
const execFileAsync = promisify(execFile);

type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

type JsonRpcResponse<T = unknown> = {
  id: number | string;
  result?: T;
  error?: JsonRpcError;
};

type JsonRpcRequest<TMethod extends string, TParams> = {
  id: number;
  method: TMethod;
  params: TParams;
};

type JsonRpcNotification<
  TMethod extends string,
  TParams = Record<string, never>,
> = {
  method: TMethod;
  params?: TParams;
};

type JsonObject = Record<string, unknown>;

const REDACTED_DIAGNOSTIC_VALUE = "[REDACTED]";
const SENSITIVE_DIAGNOSTIC_FIELD_NAMES = new Set([
  "accessToken",
  "access_token",
  "apiKey",
  "apiKeys",
  "api_key",
  "authToken",
  "authorization",
  "bearerToken",
  "bearer_token",
  "clientSecret",
  "client_secret",
  "codeVerifier",
  "experimental_bearer_token",
  "jwt",
  "password",
  "refreshToken",
  "refresh_token",
  "secret",
  "sessionToken",
  "session_token",
  "x-api-key",
]);
const SENSITIVE_DIAGNOSTIC_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
]);
type ThreadPreviewResult = {
  thread: Pick<v2.Thread, "preview">;
};
type ClosePreviewThreadResponse = {
  id: number | string;
  result: ThreadPreviewResult;
};
type ClosePreviewErrorNotification = NotificationOfMethod<typeof SERVER_METHOD.streamError>;
type ClosePreviewErrorEnvelope = {
  method: typeof SERVER_METHOD.streamError;
  params: ClosePreviewErrorNotification["params"];
};

type HydratedToolServerBroadcastDeps = {
  getToolManager: () => {
    listDisplayToolServers: () => Promise<ToolServerStatus[]>;
  };
};

export async function loadHydratedToolServersForBroadcast(
  deps?: HydratedToolServerBroadcastDeps,
): Promise<ToolServerStatus[]> {
  if (deps) {
    return deps.getToolManager().listDisplayToolServers();
  }

  const { getToolManager } = await import("../../../server/tools/toolManagerAccessor");
  return getToolManager().listDisplayToolServers();
}

type CodexCliMcpAuthStatus = "unsupported" | "not_logged_in" | "bearer_token" | "oauth";

type CodexCliMcpListEntry = {
  name: string;
  enabled: boolean;
  auth_status: CodexCliMcpAuthStatus;
};

function extractJsonPayload(rawOutput: string): string {
  const firstJsonLine = rawOutput
    .split("\n")
    .findIndex((line) => {
      const trimmed = line.trimStart();
      return trimmed.startsWith("[") || trimmed.startsWith("{");
    });

  if (firstJsonLine === -1) {
    throw new Error("interpreter mcp list --json did not return JSON output");
  }

  return rawOutput
    .split("\n")
    .slice(firstJsonLine)
    .join("\n");
}

function normalizeCodexCliMcpAuthStatus(rawAuthStatus: string): CodexCliMcpAuthStatus | null {
  switch (rawAuthStatus) {
    case "unsupported":
    case "not_logged_in":
    case "bearer_token":
    case "oauth":
      return rawAuthStatus;
    case "o_auth":
      return "oauth";
    default:
      return null;
  }
}

function toGeneratedMcpAuthStatus(authStatus: CodexCliMcpAuthStatus): v2.McpAuthStatus {
  switch (authStatus) {
    case "unsupported":
      return "unsupported";
    case "not_logged_in":
      return "notLoggedIn";
    case "bearer_token":
      return "bearerToken";
    case "oauth":
      return "oAuth";
  }
}

function parseCodexCliMcpList(rawOutput: string): CodexCliMcpListEntry[] {
  const payload = JSON.parse(extractJsonPayload(rawOutput)) as unknown;
  if (!Array.isArray(payload)) {
    throw new Error("interpreter mcp list --json returned a non-array payload");
  }

  return payload.flatMap((entry, index) => {
    if (
      typeof entry !== "object"
      || entry === null
      || typeof entry.name !== "string"
      || typeof entry.enabled !== "boolean"
      || typeof entry.auth_status !== "string"
    ) {
      throw new Error(`interpreter mcp list --json returned an invalid entry at index ${index}`);
    }

    const authStatus = normalizeCodexCliMcpAuthStatus(entry.auth_status);
    if (!authStatus) {
      console.warn(
        `[interpreter-server] ignoring unknown CLI MCP auth_status for server=${entry.name} auth_status=${entry.auth_status}`,
      );
      return [];
    }

    return [{
      name: entry.name,
      enabled: entry.enabled,
      auth_status: authStatus,
    }];
  });
}

function mcpFailureNeedsAuth(error: string | null | undefined): boolean {
  if (!error) {
    return false;
  }

  const normalized = error.toLowerCase();
  return [
    "access token",
    "oauth",
    "authorization",
    "unauthorized",
    "forbidden",
    "access denied",
    "not logged in",
    "login required",
    "invalid_token",
    "invalid token",
    "expired token",
    "credential",
  ].some((token) => normalized.includes(token));
}

type McpAuthRequiredFailure = {
  error: string;
  resourceUrl: string;
};

function extractMcpAuthRequiredFailures(stderrDetail: string): McpAuthRequiredFailure[] {
  if (!stderrDetail.includes("AuthRequired(")) {
    return [];
  }

  const failures: McpAuthRequiredFailure[] = [];
  for (const rawLine of stderrDetail.split("\n")) {
    if (!rawLine.includes("AuthRequired(")) {
      continue;
    }

    const line = rawLine.replace(/\\"/g, "\"");
    const resourceUrl =
      line.match(/resource_metadata="([^"]+)"/)?.[1]
      ?? line.match(/https?:\/\/[^\s"\\]+oauth-protected-resource[^\s"\\]*/)?.[0];
    if (!resourceUrl) {
      continue;
    }

    const error =
      line.match(/error_description="([^"]+)"/)?.[1]
      ?? "OAuth login required";

    failures.push({ resourceUrl, error });
  }

  return failures;
}

async function persistMcpAuthRequiredFailures(stderrDetail: string): Promise<void> {
  const failures = extractMcpAuthRequiredFailures(stderrDetail);
  if (failures.length === 0) {
    return;
  }

  const {
    listMcpServers,
    setMcpServerConnectionFailure,
  } = await import("../../../server/configStore");
  const persistedConfigs = await listMcpServers();

  for (const failure of failures) {
    let resourceUrl: URL;
    try {
      resourceUrl = new URL(failure.resourceUrl);
    } catch {
      continue;
    }

    const matchedConfig = persistedConfigs.find((config) => {
      if (!config.url) {
        return false;
      }

      try {
        const configUrl = new URL(config.url);
        return configUrl.origin === resourceUrl.origin;
      } catch {
        return false;
      }
    });
    if (!matchedConfig) {
      continue;
    }

    if (
      matchedConfig.lastConnectionFailure?.error === failure.error
      && matchedConfig.lastConnectionFailure.needsAuth === true
    ) {
      continue;
    }

    await setMcpServerConnectionFailure(matchedConfig.id, {
      error: failure.error,
      needsAuth: true,
      updatedAt: Date.now(),
    });
  }
}

async function persistMcpStartupStatus(
  startupStatus: v2.McpServerStatusUpdatedNotification,
): Promise<void> {
  const {
    clearMcpServerConnectionFailure,
    setMcpServerConnectionFailure,
  } = await import("../../../server/configStore");

  switch (startupStatus.status) {
    case "starting":
      return;
    case "ready":
      await clearMcpServerConnectionFailure(startupStatus.name);
      return;
    case "failed":
    case "cancelled": {
      const error = startupStatus.error
        ?? (startupStatus.status === "cancelled"
          ? "MCP server startup cancelled"
          : "Failed to start MCP server");
      await setMcpServerConnectionFailure(startupStatus.name, {
        error,
        ...(mcpFailureNeedsAuth(error) ? { needsAuth: true } : {}),
        updatedAt: Date.now(),
      });
      return;
    }
  }
}

async function persistMcpOauthCompletion(
  name: string,
  success: boolean,
  error?: string | null,
): Promise<void> {
  const {
    clearMcpServerConnectionFailure,
    setMcpServerConnectionFailure,
  } = await import("../../../server/configStore");

  if (success) {
    await clearMcpServerConnectionFailure(name);
    return;
  }

  await setMcpServerConnectionFailure(name, {
    error: error ?? "OAuth login required",
    needsAuth: true,
    updatedAt: Date.now(),
  });
}

function mapStartupStatusToToolState(
  startupStatus: v2.McpServerStatusUpdatedNotification,
): ToolConnectionState | null {
  switch (startupStatus.status) {
    case "starting":
      return { status: "connecting" };
    case "failed": {
      const error = startupStatus.error ?? "Failed to start MCP server";
      return {
        status: "failed",
        error,
        ...(mcpFailureNeedsAuth(error) ? { needsAuth: true } : {}),
      };
    }
    case "cancelled": {
      const error = startupStatus.error ?? "MCP server startup cancelled";
      return {
        status: "failed",
        error,
        ...(mcpFailureNeedsAuth(error) ? { needsAuth: true } : {}),
      };
    }
    case "ready":
      return null;
  }
}

export function mergeStartupStatusIntoToolServers(
  servers: ToolServerStatus[],
  startupStatus?: v2.McpServerStatusUpdatedNotification,
): ToolServerStatus[] {
  if (!startupStatus) {
    return servers;
  }

  const startupState = mapStartupStatusToToolState(startupStatus);
  if (!startupState) {
    return servers;
  }

  const serverIndex = servers.findIndex((server) => server.id === startupStatus.name);
  if (serverIndex === -1) {
    return [
      ...servers,
      {
        id: startupStatus.name,
        name: startupStatus.name,
        state: startupState,
      },
    ];
  }

  return servers.map((server, index) => {
    if (index !== serverIndex) {
      return server;
    }

    const existingNeedsAuth =
      server.state.status === "failed"
      && (server.state as { needsAuth?: boolean }).needsAuth === true;
    const startupNeedsAuth =
      startupState.status === "failed"
      && (startupState as { needsAuth?: boolean }).needsAuth === true;

    if (existingNeedsAuth && !startupNeedsAuth && startupState.status === "failed") {
      return { ...server, state: { ...startupState, needsAuth: true } };
    }

    return { ...server, state: startupState };
  });
}

export interface JsonRpcTransport {
  start(): Promise<void>;
  send(message: string): void;
  onMessage(handler: (message: string) => void): void;
  onClose(handler: (error?: Error) => void): void;
  stop(): void | Promise<void>;
  getStderrSnapshot?(): string;
}

export interface CodexCliRunner {
  runCodexCli(args: string[]): Promise<{ stdout: string; stderr: string }>;
}

type CodexAppServerClientOptions = {
  syncMcpServersFromConfigStore?: boolean;
};

function isCodexCliRunner(value: JsonRpcTransport): value is JsonRpcTransport & CodexCliRunner {
  return typeof (value as Partial<CodexCliRunner>).runCodexCli === "function";
}

export class CodexRuntimeDisconnectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexRuntimeDisconnectedError";
  }
}

type SpawnProcess = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => ChildProcessWithoutNullStreams;

type BuildCodexSpawnEnvArgs = {
  baseEnv: NodeJS.ProcessEnv;
  codeHome: string;
  codexBinary: string;
  platform?: NodeJS.Platform;
  pathExists?: (candidatePath: string) => boolean;
};

type TransportEvents = {
  message: (message: string) => void;
  close: (error?: Error) => void;
};

type ClientEvents = {
  notification: (notification: AppServerNotification) => void;
  "server-request": (
    request: ServerRequest,
    respond: (result: unknown) => void,
  ) => void;
  "auth-invalidated": (reason: string) => void;
  disconnect: (reason: string) => void;
};

const CODEX_AUTH_CLOSE_MARKERS = [
  "401 unauthorized",
  "authentication token has been invalidated",
  "authentication token invalidated",
  "refresh token has been invalidated",
  "refresh token has already been used",
  "refresh_token_invalidated",
  "refresh_token_reused",
  "please try signing in again",
  "responses_websocket 403 forbidden",
  "403 forbidden, url: wss://chatgpt.com/backend-api/codex/responses",
];
let codexMcpStatusListRequestId = 0;
let codexEnsureConnectedRequestId = 0;
let codexConnectAndInitializeRequestId = 0;
let codexSyncMcpServersRequestId = 0;

function collapseWhitespace(value: string): string {
  return value.trim().split(/\s+/).filter(Boolean).join(" ");
}

function extractCanonicalClosePreview(value: string): string | null {
  const normalized = value.toLowerCase();

  if (normalized.includes("refresh_token_invalidated")) {
    return "refresh_token_invalidated";
  }
  if (normalized.includes("refresh_token_reused")) {
    return "refresh_token_reused";
  }
  if (normalized.includes("authentication token has been invalidated")) {
    return "authentication token invalidated";
  }
  if (normalized.includes("responses_websocket") && normalized.includes("403 forbidden")) {
    return "responses_websocket 403 forbidden";
  }
  if (normalized.includes("internal_server_error")) {
    return "internal_server_error";
  }
  if (normalized.includes("response stream disconnected")) {
    return "response stream disconnected";
  }

  return null;
}

function toSafeClosePreview(value: string): string | null {
  const canonical = extractCanonicalClosePreview(value);
  if (canonical) {
    return canonical;
  }

  const compact = collapseWhitespace(value);
  if (!compact) {
    return null;
  }

  return compact;
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function redactSensitiveDiagnosticText(text: string): string {
  let redacted = text;

  redacted = redacted.replace(
    /((?:["'`]?)(?:api[_-]?key|x-api-key|access[_-]?token|refresh[_-]?token|auth[_-]?token|oauth[_-]?token|authorization|client[_-]?secret|session[_-]?token|password|secret|experimental[_-]?bearer[_-]?token|bearer[_-]?token|jwt)(?:["'`]?)\s*[:=]\s*)(["'`]?)[^"'`,\s}\]]+\2/gi,
    (_match, prefix: string, quote: string) => `${prefix}${quote}${REDACTED_DIAGNOSTIC_VALUE}${quote}`,
  );

  redacted = redacted.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi, `Bearer ${REDACTED_DIAGNOSTIC_VALUE}`);
  redacted = redacted.replace(/\bsk-ant-[A-Za-z0-9_-]+\b/g, REDACTED_DIAGNOSTIC_VALUE);
  redacted = redacted.replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, REDACTED_DIAGNOSTIC_VALUE);
  redacted = redacted.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+\b/g, REDACTED_DIAGNOSTIC_VALUE);
  redacted = redacted.replace(
    /([?&](?:access_token|refresh_token|api_key|apikey|token)=)[^&\s]+/gi,
    `$1${REDACTED_DIAGNOSTIC_VALUE}`,
  );

  return redacted;
}

function redactStructuredDiagnostic(value: unknown, parentKey?: string): unknown {
  if (typeof value === "string") {
    return redactSensitiveDiagnosticText(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactStructuredDiagnostic(entry));
  }

  if (!isJsonObject(value)) {
    return value;
  }

  const redacted: JsonObject = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (SENSITIVE_DIAGNOSTIC_FIELD_NAMES.has(key)) {
      if (key === "apiKeys" && isJsonObject(nestedValue)) {
        redacted[key] = Object.fromEntries(
          Object.keys(nestedValue).map((nestedKey) => [nestedKey, REDACTED_DIAGNOSTIC_VALUE]),
        );
      } else {
        redacted[key] = REDACTED_DIAGNOSTIC_VALUE;
      }
      continue;
    }

    if (
      (parentKey === "headers" || parentKey === "http_headers" || parentKey === "env_http_headers")
      && SENSITIVE_DIAGNOSTIC_HEADER_NAMES.has(key.toLowerCase())
    ) {
      redacted[key] = REDACTED_DIAGNOSTIC_VALUE;
      continue;
    }

    redacted[key] = redactStructuredDiagnostic(nestedValue, key);
  }

  return redacted;
}

function sanitizeStdoutDiagnosticLine(line: string): string {
  const normalized = line.replace(/\r/g, "");
  const trimmed = normalized.trim();
  let sanitizedLine: string;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      sanitizedLine = JSON.stringify(redactStructuredDiagnostic(JSON.parse(trimmed)));
    } catch {
      // Fall back to string redaction for non-parseable lines.
      sanitizedLine = redactSensitiveDiagnosticText(normalized);
    }
  } else {
    sanitizedLine = redactSensitiveDiagnosticText(normalized);
  }

  if (sanitizedLine.length <= STDOUT_DIAGNOSTIC_MAX_CHARS_PER_LINE) {
    return sanitizedLine;
  }

  const omittedCharCount = sanitizedLine.length - STDOUT_DIAGNOSTIC_MAX_CHARS_PER_LINE;
  return `${sanitizedLine.slice(0, STDOUT_DIAGNOSTIC_MAX_CHARS_PER_LINE)}… [truncated ${omittedCharCount} chars]`;
}

function isClosePreviewErrorEnvelope(value: unknown): value is ClosePreviewErrorEnvelope {
  if (!isJsonObject(value) || value.method !== SERVER_METHOD.streamError) {
    return false;
  }

  const params = value.params;
  if (!isJsonObject(params) || typeof params.threadId !== "string" || typeof params.turnId !== "string" || typeof params.willRetry !== "boolean") {
    return false;
  }

  const error = params.error;
  return isJsonObject(error) && typeof error.message === "string";
}

function isClosePreviewThreadResponse(value: unknown): value is ClosePreviewThreadResponse {
  if (!isJsonObject(value)) {
    return false;
  }

  const result = value.result;
  if (!isJsonObject(result)) {
    return false;
  }

  const thread = result.thread;
  return isJsonObject(thread) && typeof thread.preview === "string";
}

function formatTurnErrorPreview(error: v2.TurnError): string | null {
  const parts = [
    error.message.trim(),
    error.additionalDetails?.trim() ?? "",
  ].filter(Boolean);

  if (parts.length === 0) {
    return null;
  }

  return parts.join("\n");
}

function findStructuredClosePreview(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findStructuredClosePreview(entry);
      if (found) {
        return found;
      }
    }
    return null;
  }

  if (isClosePreviewErrorEnvelope(value)) {
    return formatTurnErrorPreview(value.params.error);
  }

  if (isClosePreviewThreadResponse(value)) {
    const preview = value.result.thread.preview.trim();
    return preview || null;
  }

  return null;
}

// NOTE(victor): Permanent auth failures are modeled upstream as an auth/session
// problem, not as a retryable transport hiccup:
// - refresh-token 401s are classified as permanent in
//   codex/codex-rs/core/src/auth.rs (`classify_refresh_token_failure`)
// - `handle_unauthorized()` turns those into `CodexErr::RefreshTokenFailed` in
//   codex/codex-rs/core/src/client.rs
// - `CodexErr::RefreshTokenFailed` is non-retryable and maps to protocol
//   `Unauthorized` in codex/codex-rs/core/src/error.rs
//
// When Interpreter sees one of those same auth markers wrapped in
// `codex app-server exited (...)`, we treat it as "the shared runtime session
// is no longer usable until re-auth" and fan that out through `auth-invalidated`.
function isCodexReauthCloseError(reason: string): boolean {
  const normalized = reason.toLowerCase();
  if (!normalized.includes("codex app-server exited")) {
    return false;
  }
  return CODEX_AUTH_CLOSE_MARKERS.some((marker) => normalized.includes(marker));
}

// NOTE(victor): This list is intentionally narrow. Upstream Codex only retries
// transport/stream classes such as `CodexErr::Stream`, connection failures, and
// `InternalServerError`; it explicitly does not retry `ServerOverloaded` or
// `RefreshTokenFailed`. See `CodexErr::is_retryable()` in
// codex/codex-rs/core/src/error.rs and the retry loop in
// codex/codex-rs/core/src/codex.rs.
//
// These methods are read-only or idempotent from Interpreter's point of
// view, so if they overlap a real transport loss we can reconnect and reissue
// them without inventing a second mutation. By contrast, turn execution and
// batch writes are left to fail loudly because replaying them could duplicate a
// side effect or hide an upstream app-server lifecycle bug.
const RETRYABLE_RPC_METHODS = new Set<keyof RequestMap>([
  CLIENT_METHOD.accountRead,
  CLIENT_METHOD.configRead,
  CLIENT_METHOD.configValueWrite,
  CLIENT_METHOD.mcpServerReload,
  CLIENT_METHOD.mcpServerStatusList,
  CLIENT_METHOD.modelList,
  CLIENT_METHOD.interpreterProviderList,
  CLIENT_METHOD.interpreterProviderSet,
  CLIENT_METHOD.interpreterModelList,
  CLIENT_METHOD.interpreterModelSet,
  CLIENT_METHOD.interpreterHarnessList,
  CLIENT_METHOD.interpreterHarnessSet,
  CLIENT_METHOD.threadList,
  CLIENT_METHOD.threadRead,
]);

function resolveInterpreterDataDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  homeDir = env.HOME ?? os.homedir(),
): string {
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  const interpreterHome = env.INTERPRETER_HOME?.trim();

  if (interpreterHome) {
    return interpreterHome;
  }

  if (platform === "win32") {
    const appData = env.APPDATA;
    if (!appData) {
      throw new Error("APPDATA is required to resolve Interpreter data directory");
    }
    return platformPath.join(appData, "interpreter");
  }

  if (platform === "darwin") {
    return platformPath.join(
      homeDir,
      "Library",
      "Application Support",
      "interpreter",
    );
  }

  return platformPath.join(
    env.XDG_CONFIG_HOME ?? platformPath.join(homeDir, ".config"),
    "interpreter",
  );
}

export function resolveDefaultCodexHome(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  homeDir = env.HOME ?? os.homedir(),
): string {
  const explicitCodexHome = env.CODEX_HOME?.trim();
  if (explicitCodexHome) {
    return explicitCodexHome;
  }

  const platformPath = platform === "win32" ? path.win32 : path.posix;
  return platformPath.join(
    resolveInterpreterDataDir(platform, env, homeDir),
    "codex-home",
  );
}

export function getInterpreterCliSandboxReadableRoots(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  homeDir = env.HOME ?? os.homedir(),
): string[] {
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  const codexHome = resolveDefaultCodexHome(platform, env, homeDir);
  const isolatedHome = platformPath.join(codexHome, "home");
  return [getInterpreterCliShellRuntimeDir(platform, isolatedHome)];
}

function normalizeCaseInsensitive(value: string): string {
  return value.toLowerCase();
}

function dedupeCaseInsensitive(values: Iterable<string>): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const value of values) {
    const normalized = normalizeCaseInsensitive(value);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    unique.push(value);
  }

  return unique;
}

const WINDOWS_PATH_ENV_KEY = "Path";

function normalizeWindowsPathEnv(env: NodeJS.ProcessEnv): string[] {
  const pathEntries = Object.entries(env).filter(([key]) => normalizeCaseInsensitive(key) === "path");
  const orderedPathEntries = [
    ...pathEntries.filter(([key]) => key === WINDOWS_PATH_ENV_KEY),
    ...pathEntries.filter(([key]) => key !== WINDOWS_PATH_ENV_KEY),
  ];
  const pathParts = dedupeCaseInsensitive(
    orderedPathEntries.flatMap(([, value]) => {
      if (typeof value !== "string" || value.length === 0) {
        return [];
      }

      return value
        .split(path.win32.delimiter)
        .map((segment) => segment.trim())
        .filter(Boolean);
    }),
  );

  for (const [key] of pathEntries) {
    if (key !== WINDOWS_PATH_ENV_KEY) {
      delete env[key];
    }
  }

  return pathParts;
}

function buildWindowsCodexSpawnEnv(
  env: NodeJS.ProcessEnv,
  isolatedHome: string,
  codeHome: string,
  codexBinary: string,
  pathExists: (candidatePath: string) => boolean,
): NodeJS.ProcessEnv {
  // NOTE(victor): Keep the real Windows profile if one already exists.
  // PowerShell and other Windows-native components use USERPROFILE/
  // HOMEDRIVE/HOMEPATH for profile- and DPAPI-backed initialization. Overriding
  // them to the isolated Codex home breaks clean-machine shell behavior.
  if (!env.USERPROFILE) {
    env.USERPROFILE = isolatedHome;
  }
  if (!env.HOMEDRIVE || !env.HOMEPATH) {
    const homeSource = env.USERPROFILE ?? isolatedHome;
    const winParsed = path.win32.parse(homeSource);
    if (winParsed.root) {
      const drive = winParsed.root.replace(/\\$/, "");
      const homePath = homeSource.slice(drive.length) || "\\";
      env.HOMEDRIVE = env.HOMEDRIVE ?? drive;
      env.HOMEPATH = env.HOMEPATH ?? homePath;
    }
  }

  const pathParts = normalizeWindowsPathEnv(env);
  const normalizedPathParts = new Set(pathParts.map(normalizeCaseInsensitive));
  const runtimeDir = path.win32.join(path.win32.dirname(codeHome), "oo-editors", "converter");
  const extraDirs = dedupeCaseInsensitive([
    path.win32.dirname(codexBinary),
    runtimeDir,
  ]).filter((candidatePath) => (
    !normalizedPathParts.has(normalizeCaseInsensitive(candidatePath))
      && pathExists(candidatePath)
  ));

  env[WINDOWS_PATH_ENV_KEY] = [...extraDirs, ...pathParts].join(path.win32.delimiter);
  return env;
}


export function buildCodexSpawnEnv({
  baseEnv,
  codeHome,
  codexBinary,
  platform = process.platform,
  pathExists = existsSync,
}: BuildCodexSpawnEnvArgs): NodeJS.ProcessEnv {
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  const isolatedHome = platformPath.join(codeHome, "home");
  const nextEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    CODEX_HOME: codeHome,
    INTERPRETER_HOME: codeHome,
    OPEN_INTERPRETER_HOME: codeHome,
    INTERPRETER_DISABLE_SYSTEM_IMPORT: "1",
    HOME: isolatedHome,
  };

  // Test/runtime instrumentation env vars should not leak into the Codex
  // subprocess because model-invoked shell/Node commands inherit them.
  // In benchmark runs, leaking NODE_V8_COVERAGE makes simple `node -e`
  // checks fail under workspace-write sandboxes when Node tries to write
  // coverage data outside the workspace.
  delete nextEnv.NODE_V8_COVERAGE;

  if (platform !== "win32") {
    return nextEnv;
  }

  return buildWindowsCodexSpawnEnv(
    nextEnv,
    isolatedHome,
    codeHome,
    codexBinary,
    pathExists,
  );
}

function resolveCodexRuntimeCacheRoot(homeDir: string): string {
  return path.join(homeDir, ".cache", "codex-runtimes");
}

export function ensureIsolatedCodexRuntimeCacheAccess(
  isolatedHome: string,
  {
    hostHome = os.homedir(),
    platform = process.platform,
  }: {
    hostHome?: string;
    platform?: NodeJS.Platform;
  } = {},
): void {
  const sourceRuntimeCacheRoot = resolveCodexRuntimeCacheRoot(hostHome);
  if (!existsSync(sourceRuntimeCacheRoot)) {
    return;
  }

  const isolatedCacheRoot = path.join(isolatedHome, ".cache");
  const targetRuntimeCacheRoot = path.join(isolatedCacheRoot, "codex-runtimes");

  mkdirSync(isolatedCacheRoot, { recursive: true });

  if (existsSync(targetRuntimeCacheRoot)) {
    try {
      const stat = lstatSync(targetRuntimeCacheRoot);
      if (stat.isSymbolicLink()) {
        const currentTarget = readlinkSync(targetRuntimeCacheRoot);
        const resolvedTarget = path.resolve(path.dirname(targetRuntimeCacheRoot), currentTarget);
        if (resolvedTarget === sourceRuntimeCacheRoot) {
          return;
        }
        rmSync(targetRuntimeCacheRoot, { recursive: true, force: true });
      } else {
        return;
      }
    } catch {
      return;
    }
  }

  symlinkSync(
    sourceRuntimeCacheRoot,
    targetRuntimeCacheRoot,
    platform === "win32" ? "junction" : "dir",
  );
}

function resolveBundledSkillsRoot(): string | null {
  const candidates = resolveBundledResourceCandidates({
    packagedSegments: [BUNDLED_SKILLS_DIR_NAME],
  });

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function copyDirectoryRecursive(sourceDir: string, targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirectoryRecursive(sourcePath, targetPath);
      continue;
    }
    if (entry.isFile()) {
      await copyFile(sourcePath, targetPath);
    }
  }
}

export function getBundledSkillPlatformVariantFileName(
  skillName: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (skillName !== "computer-use") {
    return null;
  }
  if (platform === "win32") {
    return "SKILL.win32.md";
  }
  return null;
}

function getBundledSkillPlatformVariantFiles(
  skillName: string,
  platform: NodeJS.Platform = process.platform,
): Array<{ source: string; target: string }> {
  const skillVariantFileName = getBundledSkillPlatformVariantFileName(skillName, platform);
  if (skillName === "computer-use" && platform === "win32") {
    return [
      ...(skillVariantFileName ? [{ source: skillVariantFileName, target: "SKILL.md" }] : []),
      { source: path.join("agents", "openai.win32.yaml"), target: path.join("agents", "openai.yaml") },
    ];
  }
  return skillVariantFileName ? [{ source: skillVariantFileName, target: "SKILL.md" }] : [];
}

function getBundledSkillPlatformFilesToRemove(
  skillName: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (skillName !== "computer-use") {
    return [];
  }
  return [
    "SKILL.win32.md",
    path.join("agents", "openai.win32.yaml"),
    ...(platform === "win32" ? ["WEB_APPS.md"] : []),
  ];
}

async function applyBundledSkillPlatformVariant(
  skillName: string,
  sourceDir: string,
  targetDir: string,
): Promise<void> {
  for (const variant of getBundledSkillPlatformVariantFiles(skillName)) {
    const variantPath = path.join(sourceDir, variant.source);
    if (!existsSync(variantPath)) {
      throw new Error(`Missing bundled skill platform variant: ${variantPath}`);
    }
    await copyFile(variantPath, path.join(targetDir, variant.target));
  }

  for (const relativePath of getBundledSkillPlatformFilesToRemove(skillName)) {
    rmSync(path.join(targetDir, relativePath), { force: true });
  }
}

const bundledSkillInstallQueue = new Map<string, Promise<void>>();

async function runSerializedBundledSkillInstall<T>(
  codexHomeSkillsDir: string,
  install: () => Promise<T>,
): Promise<T> {
  const previous = bundledSkillInstallQueue.get(codexHomeSkillsDir) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  bundledSkillInstallQueue.set(
    codexHomeSkillsDir,
    previous.catch(() => undefined).then(() => current),
  );

  await previous.catch(() => undefined);
  try {
    return await install();
  } finally {
    releaseCurrent();
    if (bundledSkillInstallQueue.get(codexHomeSkillsDir) === current) {
      bundledSkillInstallQueue.delete(codexHomeSkillsDir);
    }
  }
}

function formatCodexConfigStringLiteral(value: string): string {
  return JSON.stringify(value);
}


function formatDisabledSystemSkillsConfig(codeHome: string): string | null {
  const skillPaths = getStrippedSystemSkillPathsInCurrentApp(codeHome);
  if (skillPaths.length === 0) {
    return null;
  }

  const configEntries = skillPaths
    .map((skillPath) => `{path=${formatCodexConfigStringLiteral(skillPath)},enabled=false}`)
    .join(",");

  return `skills={config=[${configEntries}]}`;
}

function withRequiredThreadConfig(
  config?: Record<string, JsonValue> | null,
): Record<string, JsonValue> {
  return {
    ...(config ?? {}),
    include_apply_patch_tool: config?.include_apply_patch_tool ?? true,
    include_permissions_instructions: false,
    // Keep Interpreter MCPs behind the interpreter-app CLI even though the
    // shared app-server runtime holds their configs for status and tool calls.
    mcp_servers: {},
  };
}

function withWorkspacePermissionConfig(
  config: Record<string, JsonValue> | null | undefined,
  selection: CodexWorkspacePermissionSelection | null,
): Record<string, JsonValue> {
  if (!selection) {
    return withRequiredThreadConfig(config);
  }

  const existingPermissions =
    config?.permissions
    && typeof config.permissions === "object"
    && !Array.isArray(config.permissions)
      ? config.permissions as Record<string, JsonValue>
      : {};
  const selectedPermissions = selection.config.permissions as Record<string, JsonValue>;

  return withRequiredThreadConfig({
    ...(config ?? {}),
    permissions: {
      ...existingPermissions,
      ...selectedPermissions,
    },
  });
}

type ExperimentalThreadAccessFields = {
  permissions?: string;
  runtimeWorkspaceRoots?: string[];
};

type ExperimentalTurnAccessFields = {
  permissions?: string;
  runtimeWorkspaceRoots?: string[];
};

// How recent a stderr line must be (ms before the process exit) to be treated as
// the *cause* of that exit, rather than stale noise that merely predates it.
//
// NOTE(victor): The transport's `stderrBuffer` is cumulative for the lifetime of
// the process -- it is reset only at spawn and otherwise appended to, because
// `mcpServerStatusList` diffs it via `slice()` to persist MCP `needsAuth`. That
// makes the raw buffer a poor signal for "what killed the process": whatever
// benign line happens to be sitting in it gets stamped onto the exit message.
//
// This cost a real investigation. In feedback `d8e04e98` (issue 1390) a turn
// stalled with `timeToFirstTokenMs: null` for ~30s against an overloaded hosted
// provider, the app-server process went away, and the close surfaced as
// `codex app-server exited (null): stderr: ...Missing or invalid access token...linear...`.
// That MCP line was 26 SECONDS old, from a server the runtime had already
// tolerated as a non-fatal `McpStartupStatus::Failed` (see
// oix/codex-rs/codex-mcp/src/mcp_connection_manager.rs). The crash had nothing to
// do with MCP, but the stale buffer made it read as an OAuth failure and sent
// triage -- and an earlier "fix" on this very PR -- down the wrong path.
//
// A genuine crash logs its error microseconds before the process dies, so a small
// window keeps real crash output while rejecting stale, unrelated lines.
const STALE_CLOSE_STDERR_WINDOW_MS = 5_000;

type CloseStderrAssessment =
  // No usable stderr preview at all.
  | { kind: "none" }
  // Emitted close to the exit: treat as the likely cause (headline detail).
  | { kind: "recent"; detail: string }
  // Older than the window: keep only as a clearly-labeled breadcrumb, never as
  // the headline cause.
  | { kind: "stale"; detail: string };

// Decide how a stderr preview should colour a process-exit message, given how
// long before the exit that stderr was last seen. Pure and exported so the
// recency policy can be unit-tested deterministically without faking a clock.
export function assessCloseStderr(
  stderrPreview: string | null,
  stderrAgeMs: number | null,
  staleWindowMs: number = STALE_CLOSE_STDERR_WINDOW_MS,
): CloseStderrAssessment {
  if (!stderrPreview) {
    return { kind: "none" };
  }
  // `null` age means we have stderr but never timestamped it (should not happen
  // in practice). Prefer surfacing it: a real crash line is worth more than the
  // risk of a false negative.
  if (stderrAgeMs === null || stderrAgeMs <= staleWindowMs) {
    return { kind: "recent", detail: `stderr: ${stderrPreview}` };
  }
  const ageSeconds = Math.max(1, Math.round(stderrAgeMs / 1000));
  return {
    kind: "stale",
    detail: `last stderr ${ageSeconds}s before exit (likely unrelated): ${stderrPreview}`,
  };
}

export class StdioJsonRpcTransport implements JsonRpcTransport {
  private process: ChildProcessWithoutNullStreams | null = null;
  private readonly events = new EventEmitter<TransportEvents>();
  private stderrBuffer = "";
  // Wall-clock time (ms) of the most recent stderr write. Used at process-exit
  // time to tell a fresh crash line from stale buffered noise. See
  // `assessCloseStderr` for why this matters (issue 1390).
  private lastStderrAt: number | null = null;
  private recentStdoutDiagnostics: string[] = [];
  private droppedStdoutDiagnosticLineCount = 0;
  private startPromise: Promise<void> | null = null;

  constructor(
    private readonly spawnProcess: SpawnProcess = (command, args, env) =>
      spawn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env,
      }),
    private readonly codexHome?: string,
    private readonly runtimeAccessSnapshotLoader: () => Promise<CodexRuntimeAccessSnapshot> = loadCodexRuntimeAccessSnapshot,
  ) {}

  async start() {
    if (this.process) {
      return;
    }

    if (!this.startPromise) {
      this.startPromise = this.startInternal().finally(() => {
        this.startPromise = null;
      });
    }

    await this.startPromise;
  }

  getStderrSnapshot(): string {
    return this.stderrBuffer;
  }

  private async startInternal() {
    const codeHome = await this.resolveCodexHome();
    const codexHomeSkillsDir = path.join(codeHome, "skills");
    const isolatedHome = path.join(codeHome, "home");
    mkdirSync(codexHomeSkillsDir, { recursive: true });
    mkdirSync(isolatedHome, { recursive: true });
    ensureIsolatedCodexRuntimeCacheAccess(isolatedHome);
    await runSerializedBundledSkillInstall(codexHomeSkillsDir, async () => {
      await this.installBundledSkills(codexHomeSkillsDir);
    });

    const appServerBinary = await this.resolveInterpreterCliBinary();
    const disabledSystemSkillsConfig = formatDisabledSystemSkillsConfig(codeHome);
    console.log(`[interpreter-server] resolved app-server binary path: ${appServerBinary}`);

    // Start the shared OIX `interpreter app-server` runtime with an empty MCP table so no
    // ~/.codex MCP config leaks into the runtime and no unscoped Interpreter
    // tool surface is exposed globally. Per-thread config can inject a scoped
    // Interpreter MCP URL when a turn starts.
    //
    // NOTE(oix-runtime): The spawned binary is OIX's unified `interpreter` CLI.
    // Existing close/error strings intentionally keep "codex app-server" so
    // support-log classifiers and transport recovery tests keep matching during
    // the runtime migration.
    //
    // NOTE(victor): Codex defaults tool_timeout_sec to 120s (DEFAULT_TOOL_TIMEOUT
    // in codex-rs/core/src/mcp_connection_manager.rs:95). Interactive tools like
    // ask_user_question need to wait indefinitely for human input, but the config
    // has no "disable timeout" option -- Duration is always Some on ManagedClient
    // (mcp_connection_manager.rs:1311). Set to 1 hour as a practical ceiling.
    // Ref: https://github.com/openinterpreter/codex/blob/main/codex-rs/core/src/mcp_connection_manager.rs
    const args: string[] = ["app-server"];

    const configuredApprovalPolicy = await getConfigApprovalPolicy();
    const runtimeAccess = await this.runtimeAccessSnapshotLoader();

    console.log(
      `[interpreter-server] runtime_access sandboxMode=${runtimeAccess.sandboxMode} readAccessMode=${runtimeAccess.readAccessMode} networkAccess=${runtimeAccess.networkAccess} macosTempAccess=${runtimeAccess.macosTempAccess} macosScreenshotAccess=${runtimeAccess.macosScreenshotAccess}`,
    );

    if (disabledSystemSkillsConfig) {
      args.push(
        "-c",
        disabledSystemSkillsConfig,
      );
    }

    // Do not set the legacy sandbox_mode process-wide. OIX gives that setting
    // precedence over named permission profiles, which would silently defeat
    // Workstation's workspace-only read scope. Every thread and turn below
    // carries either an OIX `permissions` profile or an explicit legacy
    // sandbox request instead.
    args.push(
      "-c",
      `approval_policy="${configuredApprovalPolicy}"`,
    );

    // NOTE(interpreter-cli-mcp): Start every app-server process with an empty
    // mcp_servers table. App-managed MCP configs are synced only into the
    // isolated MCP mirror client, which keeps global ~/.codex MCP config from
    // becoming a second model-facing app-tool surface.
    args.push("-c", "mcp_servers={}");

    // The bundled, signed binary is the single source of truth; never let it
    // self-update. See DISABLE_INTERPRETER_AUTO_UPDATE_CONFIG.
    args.push("-c", DISABLE_INTERPRETER_AUTO_UPDATE_CONFIG);

    args.push("--listen", "stdio://");

    const spawnEnv = buildCodexSpawnEnv({
      baseEnv: process.env,
      codeHome,
      codexBinary: appServerBinary,
    });

    const child = this.spawnProcess(appServerBinary, args, spawnEnv);

    this.process = child;
    this.stderrBuffer = "";
    this.lastStderrAt = null;
    this.recentStdoutDiagnostics = [];
    this.droppedStdoutDiagnosticLineCount = 0;

    // NOTE(victor): On older Linux distros (glibc < 2.38) the codex binary
    // crashes immediately. Writing to the dead process's stdin emits EPIPE,
    // which Node treats as an uncaught exception if unhandled, crashing Electron.
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      const code = error.code ? ` (${error.code})` : "";
      console.error(`[interpreter-server:stdin] ${error.message}${code}`);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      this.stderrBuffer += text;
      this.lastStderrAt = Date.now();
      for (const line of text.split("\n")) {
        if (line.trim()) {
          console.error(`[interpreter-server:stderr] ${line}`);
        }
      }
    });

    const reader = readline.createInterface({ input: child.stdout });
    reader.on("line", (line) => {
      this.captureStdoutDiagnostic(line);
      // Forward stdout events to the JSON-RPC transport only.
      // Per-line console logging is too high-volume and can exhaust renderer memory.
      this.events.emit("message", line);
    });

    child.on("close", (code) => {
      this.process = null;
      const stderrDetail = this.stderrBuffer.trim();
      // Age of the newest stderr relative to this exit. A genuine crash logs its
      // error microseconds before dying; a line that is many seconds old almost
      // certainly predates (and did not cause) the exit. See `assessCloseStderr`.
      const stderrAgeMs =
        this.lastStderrAt === null ? null : Date.now() - this.lastStderrAt;
      const detail = this.buildCloseDetail(stderrDetail, stderrAgeMs);
      const error =
        code === 0
          ? undefined
          : new Error(
              detail
                ? `codex app-server exited (${code}): ${detail}`
                : `codex app-server exited (${code})`,
            );

      this.events.emit("close", error);
    });

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (error) => reject(error));
    });
  }

  async runCodexCli(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const codeHome = await this.resolveCodexHome();
    const interpreterBinary = await this.resolveInterpreterCliBinary();
    const spawnEnv = buildCodexSpawnEnv({
      baseEnv: process.env,
      codeHome,
      codexBinary: interpreterBinary,
    });

    const { stdout, stderr } = await execFileAsync(interpreterBinary, args, {
      env: spawnEnv,
      encoding: "utf8",
      maxBuffer: CODEX_CLI_MAX_BUFFER_BYTES,
      timeout: CODEX_CLI_TIMEOUT_MS,
    });

    return { stdout, stderr };
  }

  private async resolveInterpreterCliBinary(): Promise<string> {
    const platform = process.platform;
    const arch = process.arch;
    const binaryName = platform === "win32" ? "interpreter.exe" : "interpreter";
    const candidatePaths = resolveBundledResourceCandidates({
      packagedSegments: ["oix", "bin", binaryName],
      sourceSegments: ["oix", `${platform}-${arch}`, "bin", binaryName],
    });

    for (const candidate of candidatePaths) {
      if (existsSync(candidate)) {
        if (candidate.includes(`${path.sep}resources${path.sep}oix${path.sep}`)) {
          console.log(`[interpreter-server] using bundled interpreter CLI binary: ${candidate}`);
        } else {
          console.log(`[interpreter-server] using packaged interpreter CLI binary: ${candidate}`);
        }
        return candidate;
      }
    }

    throw new Error(
      `[interpreter-server] Bundled interpreter CLI binary not found. Checked: ${candidatePaths.join(", ")}`,
    );
  }

  send(message: string) {
    if (!this.process?.stdin.writable) {
      // NOTE(victor): A non-writable stdin means the stdio transport itself is
      // gone, not that Codex returned a semantic turn error. Upstream app-server
      // uses a single stdio connection in this mode; once that pipe is gone, the
      // connection closes and the runtime winds down. See
      // codex/codex-rs/app-server/src/transport.rs `start_stdio_connection()`
      // and codex/codex-rs/app-server/src/lib.rs `single_client_mode`.
      throw new CodexRuntimeDisconnectedError("codex app-server stdio is not writable");
    }

    this.process.stdin.write(`${message}\n`);
  }

  onMessage(handler: (message: string) => void) {
    this.events.on("message", handler);
  }

  onClose(handler: (error?: Error) => void) {
    this.events.on("close", handler);
  }

  async stop(): Promise<void> {
    const child = this.process;
    if (!child) {
      return;
    }

    await new Promise<void>((resolve) => {
      let done = false;
      let killTimer: ReturnType<typeof setTimeout> | null = null;
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

      const finish = () => {
        if (done) {
          return;
        }
        done = true;
        if (killTimer) {
          clearTimeout(killTimer);
        }
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
        }
        child.off("close", finish);
        resolve();
      };

      child.once("close", finish);

      killTimer = setTimeout(() => {
        if (this.process === child) {
          child.kill("SIGKILL");
        }
      }, 5_000);
      killTimer.unref?.();

      timeoutTimer = setTimeout(finish, 10_000);
      timeoutTimer.unref?.();

      child.kill("SIGTERM");
    });
  }

  private captureStdoutDiagnostic(line: string) {
    this.recentStdoutDiagnostics.push(sanitizeStdoutDiagnosticLine(line));
    if (this.recentStdoutDiagnostics.length > STDOUT_DIAGNOSTIC_MAX_LINES) {
      this.droppedStdoutDiagnosticLineCount +=
        this.recentStdoutDiagnostics.length - STDOUT_DIAGNOSTIC_MAX_LINES;
      this.recentStdoutDiagnostics = this.recentStdoutDiagnostics.slice(
        this.recentStdoutDiagnostics.length - STDOUT_DIAGNOSTIC_MAX_LINES,
      );
    }
  }

  private formatStdoutDiagnostics(): string | null {
    if (this.recentStdoutDiagnostics.length === 0) {
      return null;
    }

    const summary = this.droppedStdoutDiagnosticLineCount > 0
      ? `\n[showing last ${this.recentStdoutDiagnostics.length} lines; ${this.droppedStdoutDiagnosticLineCount} older lines omitted]`
      : "";
    return `recent stdout lines:${summary}\n${this.recentStdoutDiagnostics.join("\n")}`;
  }

  private buildCloseDetail(
    stderrDetail: string,
    stderrAgeMs: number | null,
  ): string | null {
    const stderr = assessCloseStderr(
      this.extractStderrPreview(stderrDetail),
      stderrAgeMs,
    );

    // Recent stderr is the strongest signal for why the process died: surface it.
    if (stderr.kind === "recent") {
      return stderr.detail;
    }

    // No recent stderr. Prefer signals that actually reflect THIS exit -- a
    // structured stdout error envelope, then recent stdout diagnostics -- over a
    // stderr line that predates the exit. Without this ordering, issue 1390's
    // provider stall was reported as a 26s-old MCP auth error (see
    // `assessCloseStderr`).
    const stdoutPreview = this.extractStdoutPreview();
    if (stdoutPreview) {
      return `stdout: ${stdoutPreview}`;
    }

    const diagnostics = this.formatStdoutDiagnostics();
    if (diagnostics) {
      return diagnostics;
    }

    // Last resort: keep the stale stderr as a clearly-labeled breadcrumb so the
    // support log still has it, without implying it caused the exit.
    if (stderr.kind === "stale") {
      return stderr.detail;
    }
    if (stderrDetail) {
      return "stderr detail available";
    }

    return null;
  }

  private extractStderrPreview(stderrDetail: string): string | null {
    const firstLine = stderrDetail
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean);

    if (!firstLine) {
      return null;
    }

    return toSafeClosePreview(firstLine);
  }

  private extractStdoutPreview(): string | null {
    for (let index = this.recentStdoutDiagnostics.length - 1; index >= 0; index -= 1) {
      const line = this.recentStdoutDiagnostics[index]!;
      const trimmed = line.trim();
      if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
        continue;
      }

      try {
        const parsed = JSON.parse(trimmed) as unknown;
        const preview = findStructuredClosePreview(parsed);
        if (!preview) {
          continue;
        }

        const safePreview = toSafeClosePreview(preview);
        if (safePreview) {
          return safePreview;
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  private async resolveCodexHome(): Promise<string> {
    if (this.codexHome) {
      mkdirSync(this.codexHome, { recursive: true });
      return this.codexHome;
    }

    const home = resolveDefaultCodexHome();
    mkdirSync(home, { recursive: true });
    return home;
  }

  private async installBundledSkills(codexHomeSkillsDir: string): Promise<void> {
    for (const skillName of getBundledSkillsDisabledInCurrentApp()) {
      rmSync(path.join(codexHomeSkillsDir, skillName), { recursive: true, force: true });
    }

    const bundledSkillsRoot = resolveBundledSkillsRoot();
    if (!bundledSkillsRoot) {
      return;
    }

    const entries = await readdir(bundledSkillsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
        continue;
      }
      const targetDir = path.join(codexHomeSkillsDir, entry.name);
      if (!isBundledSkillEnabledInCurrentApp(entry.name)) {
        rmSync(targetDir, { recursive: true, force: true });
        continue;
      }

      const sourceDir = path.join(bundledSkillsRoot, entry.name);
      rmSync(targetDir, { recursive: true, force: true });
      await copyDirectoryRecursive(sourceDir, targetDir);
      await applyBundledSkillPlatformVariant(entry.name, sourceDir, targetDir);
    }
  }
}

function stripJsonRpcField(
  message: JSONRPCRequest | JSONRPCRequest[],
): JsonRpcRequest<string, unknown> | Array<JsonRpcRequest<string, unknown>> {
  if (Array.isArray(message)) {
    return message.map((item) => stripJsonRpcField(item)) as Array<
      JsonRpcRequest<string, unknown>
    >;
  }

  const { jsonrpc, ...rest } = message;
  void jsonrpc;
  return rest as JsonRpcRequest<string, unknown>;
}

function toJsonRpc2ResponseEnvelope(
  message: JsonRpcResponse,
): JSONRPCResponse | null {
  if (message.result !== undefined) {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: message.result,
    };
  }

  if (message.error) {
    return {
      jsonrpc: "2.0",
      id: message.id,
      error: message.error,
    };
  }

  return null;
}

// NOTE(victor): Auto compaction is handled server-side by codex app-server.
// When `model_auto_compact_token_limit` is unset, the server derives a
// threshold from the model's context window. To override, write the config
// key via configValueWrite("model_auto_compact_token_limit", <tokens>).
// See: https://github.com/openinterpreter/codex/blob/main/codex-rs/core/src/compact.rs
export class CodexAppServerClient {
  private readonly options: CodexAppServerClientOptions;
  private initialized = false;
  private connectPromise: Promise<void> | null = null;
  private readonly events = new EventEmitter<ClientEvents>();
  private readonly runtimeAccessSnapshotLoader: () => Promise<CodexRuntimeAccessSnapshot>;
  private readonly workspaceScopedThreads = new Set<string>();
  private listenersAttached = false;
  private unsubscribeMcpServerNotifications: (() => void) | null = null;
  // NOTE(victor): `json-rpc-2.0` turns `rejectAllPendingRequests(message)` into
  // regular JSON-RPC error responses containing only that message; see
  // node_modules/json-rpc-2.0/dist/client.js. Do not make reconnect decisions
  // by parsing that text. Instead, track whether a request overlapped an actual
  // transport disconnect/write failure in this process.
  private disconnectSequence = 0;
  private readonly rpc = new JSONRPCClient<void>((jsonRequest) => {
    const outgoingRequests = Array.isArray(jsonRequest) ? jsonRequest : [jsonRequest];
    for (const request of outgoingRequests) {
      const strippedRequest = stripJsonRpcField(
        request as JSONRPCRequest,
      ) as JsonRpcRequest<string, unknown>;
      console.log(
        `[interpreter-server] rpc send method=${strippedRequest.method} id=${String(strippedRequest.id)}`,
      );
    }
    try {
      this.transport.send(JSON.stringify(stripJsonRpcField(jsonRequest)));
    } catch (error) {
      if (error instanceof CodexRuntimeDisconnectedError) {
        this.disconnectSequence += 1;
      }
      throw error;
    }
    return Promise.resolve();
  });

  constructor(
    private readonly transport: JsonRpcTransport = new StdioJsonRpcTransport(),
    // IMPORTANT: Interpreter's shared Codex app-server runtime must follow the
    // selected profile, not the parent Electron process environment.
    //
    // - `openai-oauth` profiles rely on persisted ChatGPT auth in CODEX_HOME.
    // - `api` / `local` / hosted profiles pass credentials via model provider
    //   config when a turn starts.
    //
    // If we implicitly consume OPENAI_API_KEY here, any app-server restart can
    // flip the shared runtime into API-key auth, overwrite CODEX_HOME/auth.json,
    // and make the OpenAI OAuth UI appear signed out even though the user chose
    // the ChatGPT/OpenAI-account path.
    //
    // Only dedicated callers should pass an explicit API key here.
    private readonly apiKey: string | null = null,
    runtimeAccessSnapshotLoader: () => Promise<CodexRuntimeAccessSnapshot> = loadCodexRuntimeAccessSnapshot,
    options: CodexAppServerClientOptions = {},
  ) {
    this.runtimeAccessSnapshotLoader = runtimeAccessSnapshotLoader;
    this.options = options;
  }

  async ensureConnected() {
    const requestId = ++codexEnsureConnectedRequestId;
    console.log(
      `[interpreter-server] ensureConnected start requestId=${requestId} initialized=${this.initialized} hasConnectPromise=${this.connectPromise !== null}`,
    );
    if (this.initialized) {
      console.log(`[interpreter-server] ensureConnected done requestId=${requestId} reusedInitialized=true`);
      return;
    }

    if (!this.connectPromise) {
      console.log(`[interpreter-server] ensureConnected createConnectPromise requestId=${requestId}`);
      this.connectPromise = this.connectAndInitialize().finally(() => {
        this.connectPromise = null;
      });
    } else {
      console.log(`[interpreter-server] ensureConnected awaitExistingConnectPromise requestId=${requestId}`);
    }

    await this.connectPromise;
    console.log(
      `[interpreter-server] ensureConnected done requestId=${requestId} initialized=${this.initialized}`,
    );
  }

  subscribe(handler: (notification: AppServerNotification) => void) {
    this.events.on("notification", handler);
    return () => {
      this.events.off("notification", handler);
    };
  }

  subscribeServerRequests(
    handler: (request: ServerRequest, respond: (result: unknown) => void) => void,
  ) {
    this.events.on("server-request", handler);
    return () => {
      this.events.off("server-request", handler);
    };
  }

  onAuthInvalidated(handler: (reason: string) => void): () => void {
    this.events.on("auth-invalidated", handler);
    return () => {
      this.events.off("auth-invalidated", handler);
    };
  }

  onDisconnect(handler: (reason: string) => void): () => void {
    this.events.on("disconnect", handler);
    return () => {
      this.events.off("disconnect", handler);
    };
  }

  shutdown(): void {
    this.transport.stop();
    this.initialized = false;
    this.connectPromise = null;
    this.workspaceScopedThreads.clear();
    this.unsubscribeMcpServerNotifications?.();
    this.unsubscribeMcpServerNotifications = null;
  }

  async startThread(
    model: string,
    modelProvider?: string | null,
    baseInstructions?: string | null,
    cwd?: string | null,
    developerInstructions?: string | null,
  ) {
    return this.startThreadWithConfig(
      model,
      modelProvider,
      baseInstructions,
      cwd,
      null,
      developerInstructions,
    );
  }

  async startThreadWithConfig(
    model: string,
    modelProvider?: string | null,
    baseInstructions?: string | null,
    cwd?: string | null,
    config?: Record<string, JsonValue> | null,
    developerInstructions?: string | null,
  ) {
    const threadApprovalPolicy = await getConfigApprovalPolicy();
    const runtimeAccess = await this.getRuntimeAccessSnapshot();
    const workspacePermission = buildCodexWorkspacePermissionSelection({
      sandboxMode: runtimeAccess.sandboxMode,
      readAccessMode: runtimeAccess.readAccessMode,
      networkAccess: runtimeAccess.networkAccess,
      allowTempAccess: process.platform === "darwin" ? runtimeAccess.macosTempAccess : true,
      cwd,
    });
    const nextConfig = withWorkspacePermissionConfig(config, workspacePermission);

    console.log(
      `[interpreter-thread] start model=${model} modelProvider=${modelProvider ?? "default"} cwd=${cwd ?? ""} access=${workspacePermission?.permissionProfileId ?? runtimeAccess.sandboxMode} approvalPolicy=${threadApprovalPolicy}`,
    );

    const request: v2.ThreadStartParams & ExperimentalThreadAccessFields = {
      model,
      modelProvider: modelProvider ?? null,
      ...(cwd ? { cwd } : {}),
      ...(baseInstructions ? { baseInstructions } : {}),
      ...(developerInstructions ? { developerInstructions } : {}),
      config: nextConfig,
      approvalPolicy: threadApprovalPolicy as v2.ThreadStartParams["approvalPolicy"],
      ...(workspacePermission
        ? {
            permissions: workspacePermission.permissionProfileId,
            runtimeWorkspaceRoots: workspacePermission.runtimeWorkspaceRoots,
          }
        : { sandbox: runtimeAccess.sandboxMode as v2.SandboxMode }),
    };
    const result = await this.rpcRequest(CLIENT_METHOD.threadStart, request);
    if (workspacePermission) {
      this.workspaceScopedThreads.add(result.thread.id);
    } else {
      this.workspaceScopedThreads.delete(result.thread.id);
    }

    return result.thread.id;
  }

  async startMcpToolThread(params: {
    model?: string | null;
    modelProvider?: string | null;
    cwd?: string | null;
  }): Promise<string> {
    const threadApprovalPolicy = await getConfigApprovalPolicy();
    const runtimeAccess = await this.getRuntimeAccessSnapshot();
    const workspacePermission = buildCodexWorkspacePermissionSelection({
      sandboxMode: runtimeAccess.sandboxMode,
      readAccessMode: runtimeAccess.readAccessMode,
      networkAccess: runtimeAccess.networkAccess,
      allowTempAccess: process.platform === "darwin" ? runtimeAccess.macosTempAccess : true,
      cwd: params.cwd,
    });
    const config = withWorkspacePermissionConfig({
      include_apply_patch_tool: false,
      include_permissions_instructions: false,
    }, workspacePermission);

    console.log(
      `[interpreter-thread] startMcpToolThread model=${params.model ?? ""} modelProvider=${params.modelProvider ?? "default"} cwd=${params.cwd ?? ""} access=${workspacePermission?.permissionProfileId ?? runtimeAccess.sandboxMode} approvalPolicy=${threadApprovalPolicy}`,
    );

    const request: v2.ThreadStartParams & ExperimentalThreadAccessFields = {
      ...(params.model ? { model: params.model } : {}),
      modelProvider: params.modelProvider ?? null,
      ...(params.cwd ? { cwd: params.cwd } : {}),
      config,
      approvalPolicy: threadApprovalPolicy as v2.ThreadStartParams["approvalPolicy"],
      ...(workspacePermission
        ? {
            permissions: workspacePermission.permissionProfileId,
            runtimeWorkspaceRoots: workspacePermission.runtimeWorkspaceRoots,
          }
        : { sandbox: runtimeAccess.sandboxMode as v2.SandboxMode }),
      ephemeral: true,
    };
    const result = await this.rpcRequest(CLIENT_METHOD.threadStart, request);
    if (workspacePermission) {
      this.workspaceScopedThreads.add(result.thread.id);
    } else {
      this.workspaceScopedThreads.delete(result.thread.id);
    }

    return result.thread.id;
  }

  async resumeThread(
    threadId: string,
    modelProvider?: string | null,
    model?: string | null,
    cwd?: string | null,
    config?: Record<string, JsonValue> | null,
    baseInstructions?: string | null,
    developerInstructions?: string | null,
  ) {
    const runtimeAccess = await this.getRuntimeAccessSnapshot();
    const workspacePermission = buildCodexWorkspacePermissionSelection({
      sandboxMode: runtimeAccess.sandboxMode,
      readAccessMode: runtimeAccess.readAccessMode,
      networkAccess: runtimeAccess.networkAccess,
      allowTempAccess: process.platform === "darwin" ? runtimeAccess.macosTempAccess : true,
      cwd,
    });
    const nextConfig = withWorkspacePermissionConfig(config, workspacePermission);

    console.log(
      `[interpreter-thread] resume threadId=${threadId} model=${model ?? ""} modelProvider=${modelProvider ?? "default"} cwd=${cwd ?? ""} access=${workspacePermission?.permissionProfileId ?? runtimeAccess.sandboxMode}`,
    );

    const request: v2.ThreadResumeParams & ExperimentalThreadAccessFields = {
      threadId,
      modelProvider: modelProvider ?? null,
      ...(model ? { model } : {}),
      ...(cwd ? { cwd } : {}),
      ...(baseInstructions ? { baseInstructions } : {}),
      config: nextConfig,
      ...(developerInstructions ? { developerInstructions } : {}),
      ...(workspacePermission
        ? {
            permissions: workspacePermission.permissionProfileId,
            runtimeWorkspaceRoots: workspacePermission.runtimeWorkspaceRoots,
          }
        : { sandbox: runtimeAccess.sandboxMode as v2.SandboxMode }),
    };
    const result = await this.rpcRequest(CLIENT_METHOD.threadResume, request);
    if (workspacePermission) {
      this.workspaceScopedThreads.add(result.thread.id);
    } else {
      this.workspaceScopedThreads.delete(result.thread.id);
    }

    return result.thread.id;
  }

  async threadList(params: v2.ThreadListParams = {}): Promise<v2.ThreadListResponse> {
    return this.rpcRequest(CLIENT_METHOD.threadList, params);
  }

  async threadRead(params: v2.ThreadReadParams): Promise<v2.ThreadReadResponse> {
    return this.rpcRequest(CLIENT_METHOD.threadRead, params);
  }

  async threadSetName(params: v2.ThreadSetNameParams): Promise<v2.ThreadSetNameResponse> {
    return this.rpcRequest(CLIENT_METHOD.threadSetName, params);
  }

  async threadArchive(params: v2.ThreadArchiveParams): Promise<v2.ThreadArchiveResponse> {
    return this.rpcRequest(CLIENT_METHOD.threadArchive, params);
  }

  async threadUnarchive(
    params: v2.ThreadUnarchiveParams,
  ): Promise<v2.ThreadUnarchiveResponse> {
    return this.rpcRequest(CLIENT_METHOD.threadUnarchive, params);
  }

  async threadBackgroundTerminalsClean(
    threadId: string,
  ): Promise<Record<string, never>> {
    return this.rpcRequest(CLIENT_METHOD.threadBackgroundTerminalsClean, {
      threadId,
    });
  }

  async modelList(params: v2.ModelListParams = {}): Promise<v2.ModelListResponse> {
    return this.rpcRequest(CLIENT_METHOD.modelList, params);
  }

  async interpreterProviderList(
    params: v2.InterpreterProviderListParams = {},
  ): Promise<v2.InterpreterProviderListResponse> {
    return this.rpcRequest(CLIENT_METHOD.interpreterProviderList, params);
  }

  async interpreterProviderSet(
    params: v2.InterpreterProviderSetParams,
  ): Promise<v2.InterpreterProviderSetResponse> {
    return this.rpcRequest(CLIENT_METHOD.interpreterProviderSet, params);
  }

  async interpreterModelList(
    params: v2.InterpreterModelListParams = {},
  ): Promise<v2.InterpreterModelListResponse> {
    return this.rpcRequest(CLIENT_METHOD.interpreterModelList, params);
  }

  async interpreterModelSet(
    params: v2.InterpreterModelSetParams,
  ): Promise<v2.InterpreterModelSetResponse> {
    return this.rpcRequest(CLIENT_METHOD.interpreterModelSet, params);
  }

  async interpreterHarnessList(
    params: v2.InterpreterHarnessListParams,
  ): Promise<v2.InterpreterHarnessListResponse> {
    return this.rpcRequest(CLIENT_METHOD.interpreterHarnessList, params);
  }

  async interpreterHarnessSet(
    params: v2.InterpreterHarnessSetParams,
  ): Promise<v2.InterpreterHarnessSetResponse> {
    return this.rpcRequest(CLIENT_METHOD.interpreterHarnessSet, params);
  }

  async skillsList(
    params: v2.SkillsListParams = {},
  ): Promise<v2.SkillsListResponse> {
    return this.rpcRequest(CLIENT_METHOD.skillsList, params);
  }

  async skillsConfigWrite(
    params: v2.SkillsConfigWriteParams,
  ): Promise<v2.SkillsConfigWriteResponse> {
    return this.rpcRequest(CLIENT_METHOD.skillsConfigWrite, params);
  }

  async windowsSandboxSetupStart(
    params: v2.WindowsSandboxSetupStartParams,
  ): Promise<v2.WindowsSandboxSetupStartResponse> {
    await this.ensureConnected();
    return this.rpcRequest(CLIENT_METHOD.windowsSandboxSetupStart, params);
  }

  async configValueWrite(keyPath: string, value: JsonValue) {
    await this.writeConfigAndEnsureHeader(CLIENT_METHOD.configValueWrite, {
      keyPath,
      value,
      mergeStrategy: "upsert",
    });
  }

  async startTurn(params: {
    threadId: string;
    message?: string;
    attachments?: StreamImageAttachment[];
    skills?: StreamSkillReference[];
    sandboxPolicy?: v2.SandboxPolicy;
    cwd?: string;
    model?: string;
    effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | null;
    summary?: "auto" | "concise" | "detailed" | "none" | null;
  }) {
    const input = buildUserInput(params);

    const turnApprovalPolicy = await getConfigApprovalPolicy();
    const runtimeAccess = await this.getRuntimeAccessSnapshot();
    const workspacePermission = buildCodexWorkspacePermissionSelection({
      sandboxMode: runtimeAccess.sandboxMode,
      readAccessMode: runtimeAccess.readAccessMode,
      networkAccess: runtimeAccess.networkAccess,
      allowTempAccess: process.platform === "darwin" ? runtimeAccess.macosTempAccess : true,
      cwd: params.cwd,
    });
    const sandboxPolicy = workspacePermission
      ? undefined
      : params.sandboxPolicy ?? buildCodexSandboxPolicy({
          sandboxMode: runtimeAccess.sandboxMode,
          networkAccess: runtimeAccess.networkAccess,
          allowTempAccess: process.platform === "darwin" ? runtimeAccess.macosTempAccess : true,
        });
    if (workspacePermission && !this.workspaceScopedThreads.has(params.threadId)) {
      throw new Error(
        `Thread ${params.threadId} must be started or resumed with the active OIX workspace permission profile before starting a workspace-only turn.`,
      );
    }

    const request: v2.TurnStartParams & ExperimentalTurnAccessFields = {
      threadId: params.threadId,
      input,
      ...(params.cwd ? { cwd: params.cwd } : {}),
      approvalPolicy: turnApprovalPolicy as v2.TurnStartParams["approvalPolicy"],
      ...(workspacePermission
        ? {
            // The custom profile definition is a request-scoped thread config.
            // Re-selecting it here makes OIX reload global config, where that
            // request-only table does not exist. The active thread already
            // holds the resolved profile; only rebind its runtime roots.
            runtimeWorkspaceRoots: workspacePermission.runtimeWorkspaceRoots,
          }
        : { sandboxPolicy }),
      ...(params.model ? { model: params.model } : {}),
      ...(params.effort ? { effort: params.effort } : {}),
      ...(params.summary ? { summary: params.summary } : {}),
    };
    const result = await this.rpcRequest(CLIENT_METHOD.turnStart, request);

    console.log(
      `[interpreter-turn] start threadId=${params.threadId} cwd=${params.cwd ?? ""} approvalPolicy=${turnApprovalPolicy} access=${workspacePermission?.permissionProfileId ?? JSON.stringify(sandboxPolicy)}`,
    );

    return result.turn;
  }

  async steerTurn(params: {
    threadId: string;
    turnId: string;
    message?: string;
    attachments?: StreamImageAttachment[];
    skills?: StreamSkillReference[];
  }) {
    const input = buildUserInput(params);
    return this.rpcRequest(CLIENT_METHOD.turnSteer, {
      threadId: params.threadId,
      input,
      expectedTurnId: params.turnId,
    });
  }

  async interruptTurn(threadId: string, turnId: string) {
    await this.rpcRequest(CLIENT_METHOD.turnInterrupt, { threadId, turnId });
  }

  async configRead(
    params: v2.ConfigReadParams,
  ): Promise<v2.ConfigReadResponse> {
    const response = await this.rpcRequest(CLIENT_METHOD.configRead, params);
    await this.ensureConfigHeaderFromRead(response);
    return response;
  }

  async configBatchWrite(
    params: v2.ConfigBatchWriteParams,
  ): Promise<v2.ConfigWriteResponse> {
    return this.writeConfigAndEnsureHeader(CLIENT_METHOD.configBatchWrite, params);
  }

  private async writeConfigAndEnsureHeader(
    method: typeof CLIENT_METHOD.configValueWrite | typeof CLIENT_METHOD.configBatchWrite,
    params: v2.ConfigValueWriteParams | v2.ConfigBatchWriteParams,
  ): Promise<v2.ConfigWriteResponse> {
    const response = await this.rpcRequest(method, params);
    await this.ensureConfigHeaderCommentBlock(response.filePath);
    return response;
  }

  private async ensureConfigHeaderCommentBlock(filePath: string): Promise<void> {
    let content = "";
    try {
      content = await readFile(filePath, "utf-8");
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      await mkdir(path.dirname(filePath), { recursive: true });
    }

    if (content.startsWith(CODEX_CONFIG_HEADER_PREFIX)) {
      return;
    }

    const nextContent = content
      ? `${CODEX_CONFIG_HEADER_BLOCK}${content}`
      : `${CODEX_CONFIG_HEADER_PREFIX}\n`;
    await writeFile(filePath, nextContent, "utf-8");
  }

  private async ensureConfigHeaderFromRead(response: v2.ConfigReadResponse): Promise<void> {
    const userLayer = response.layers?.find((layer) => layer.name.type === "user");
    if (!userLayer || userLayer.name.type !== "user") {
      return;
    }

    await this.ensureConfigHeaderCommentBlock(userLayer.name.file);
  }

  async mcpServerReload(): Promise<v2.McpServerRefreshResponse> {
    return this.rpcRequest(CLIENT_METHOD.mcpServerReload, undefined);
  }

  async mcpServerStatusList(
    params: McpServerStatusListParams = {},
  ): Promise<v2.ListMcpServerStatusResponse> {
    const requestId = ++codexMcpStatusListRequestId;
    const startedAt = Date.now();
    const detail = params.detail ?? "full";
    const stderrBefore = this.transport.getStderrSnapshot?.() ?? "";
    console.log(`[interpreter-server] mcpServerStatus/list start requestId=${requestId} detail=${detail}`);
    try {
      const response = await this.rpcRequest(CLIENT_METHOD.mcpServerStatusList, params);
      const stderrAfter = this.transport.getStderrSnapshot?.() ?? "";
      await persistMcpAuthRequiredFailures(stderrAfter.slice(stderrBefore.length));
      console.log(
        `[interpreter-server] mcpServerStatus/list done requestId=${requestId} durationMs=${Date.now() - startedAt} detail=${detail} count=${response.data.length}`,
      );
      return response;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[interpreter-server] mcpServerStatus/list failed requestId=${requestId} durationMs=${Date.now() - startedAt} detail=${detail} error=${message}`,
        error,
      );
      throw error;
    }
  }

  async mcpServerAuthStatusListViaCli(): Promise<Map<string, v2.McpAuthStatus>> {
    if (!isCodexCliRunner(this.transport)) {
      throw new Error("codex CLI runner is unavailable for MCP auth status checks");
    }

    const { stdout } = await this.transport.runCodexCli(["mcp", "list", "--json"]);
    const entries = parseCodexCliMcpList(stdout);
    return new Map(
      entries
        .filter((entry) => entry.enabled)
        .map((entry) => [entry.name, toGeneratedMcpAuthStatus(entry.auth_status)]),
    );
  }

  async mcpServerLogoutViaCli(name: string): Promise<void> {
    if (!isCodexCliRunner(this.transport)) {
      throw new Error("codex CLI runner is unavailable for MCP logout");
    }

    await this.transport.runCodexCli(["mcp", "logout", name]);
  }

  async mcpServerOauthLogin(
    params: v2.McpServerOauthLoginParams,
  ): Promise<v2.McpServerOauthLoginResponse> {
    return this.rpcRequest(CLIENT_METHOD.mcpServerOauthLogin, params);
  }

  async mcpServerToolCall(
    params: McpServerToolCallParams,
  ): Promise<McpServerToolCallResponse> {
    return this.rpcRequest(CLIENT_METHOD.mcpServerToolCall, params);
  }

  async mcpResourceRead(
    params: McpResourceReadParams,
  ): Promise<McpResourceReadResponse> {
    return this.rpcRequest(CLIENT_METHOD.mcpResourceRead, params);
  }

  async loginWithChatGPT(): Promise<{ loginId: string; authUrl: string }> {
    const result = await this.rpcRequest(CLIENT_METHOD.accountLoginStart, {
      type: "chatgpt",
    });
    if (result.type !== "chatgpt") {
      throw new Error(`Unexpected login response type: ${result.type}`);
    }
    return { loginId: result.loginId, authUrl: result.authUrl };
  }

  async getAccount(refreshToken = false): Promise<v2.GetAccountResponse> {
    return this.rpcRequest(CLIENT_METHOD.accountRead, { refreshToken });
  }

  async cancelLogin(loginId: string): Promise<void> {
    await this.rpcRequest(CLIENT_METHOD.accountLoginCancel, { loginId });
  }

  async logout(): Promise<void> {
    await this.rpcRequest(CLIENT_METHOD.accountLogout, undefined);
  }

  private async connectAndInitialize() {
    const requestId = ++codexConnectAndInitializeRequestId;
    const startedAt = Date.now();
    console.log(`[interpreter-server] connectAndInitialize start requestId=${requestId}`);
    await this.transport.start();
    console.log(`[interpreter-server] connectAndInitialize transportStarted requestId=${requestId}`);
    this.attachTransportListenersOnce();
    console.log(`[interpreter-server] connectAndInitialize listenersAttached requestId=${requestId}`);

    await this.rpcRequest(CLIENT_METHOD.initialize, {
      clientInfo: {
        name: "codex_ui",
        title: "Interpreter",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    }, { skipEnsureConnected: true });
    console.log(`[interpreter-server] connectAndInitialize initializeDone requestId=${requestId}`);

    this.notify(CLIENT_NOTIFICATION_METHOD.initialized);
    console.log(`[interpreter-server] connectAndInitialize initializedSent requestId=${requestId}`);

    // Startup API-key login is opt-in. The shared Interpreter runtime must not
    // infer account auth from process.env because profile selection already
    // determines how Codex should authenticate for each request.
    if (this.apiKey) {
      await this.rpcRequest(CLIENT_METHOD.accountLoginStart, {
        type: "apiKey",
        apiKey: this.apiKey,
      }, { skipEnsureConnected: true });
      console.log(`[interpreter-server] connectAndInitialize apiKeyLoginDone requestId=${requestId}`);
    }

    this.subscribeMcpServerNotifications();
    this.initialized = true;
    console.log(
      `[interpreter-server] connectAndInitialize initialized requestId=${requestId} durationMs=${Date.now() - startedAt}`,
    );

    if (this.options.syncMcpServersFromConfigStore) {
      void this.syncMcpServersFromConfigStore();
      console.log(`[interpreter-server] connectAndInitialize syncTriggered requestId=${requestId}`);
    }
  }

  private async syncMcpServersFromConfigStore(): Promise<void> {
    // NOTE(interpreter-cli-mcp): Interpreter config is the source of truth for enabled
    // app MCP servers. This sync writes those entries into the app-server
    // runtime via `configValueWrite("mcp_servers.<name>", ...)`, then reloads
    // MCP clients. The persisted source is `server/configStore.ts`.
    const requestId = ++codexSyncMcpServersRequestId;
    const startedAt = Date.now();
    console.log(`[interpreter-server] syncMcpServers start requestId=${requestId}`);
    try {
      const { listMcpServers } = await import("../../../server/configStore");
      const appServers = await listMcpServers();
      const enabledServers = appServers.filter((s: any) => s.enabled !== false);
      console.log(
        `[interpreter-server] syncMcpServers loaded requestId=${requestId} appCount=${appServers.length} enabledCount=${enabledServers.length}`,
      );
      if (enabledServers.length === 0) {
        console.log(`[interpreter-server] syncMcpServers skip requestId=${requestId} enabledCount=0`);
        return;
      }

      // NOTE(interpreter-cli-mcp): Mirror EVERY enabled server, including ones
      // currently in an auth-required state. The shared app-server runtime
      // tolerates a failed MCP connect as a non-fatal `McpStartupStatus::Failed`
      // (oix/codex-rs/codex-mcp/src/mcp_connection_manager.rs), so a broken token
      // does not crash it. The mirror must keep auth-required servers in its
      // config so they stay visible as "needs auth" AND remain recoverable: the
      // sign-in RPC resolves the server by name from this same config
      // (oix/codex-rs/app-server/src/codex_message_processor.rs
      // `mcp_server_oauth_login` -> "No MCP server named '<name>' found"). Filtering
      // them out here would silently make OAuth sign-in impossible (issue 1390).
      for (const server of enabledServers) {
        const name = server.id ?? server.name;
        if (!name) continue;
        console.log(`[interpreter-server] syncMcpServers write start requestId=${requestId} server=${name}`);
        const url = server.transport === "websocket" ? server.wsUrl : server.url;
        const timeouts = {
          ...(server.startupTimeoutSec !== undefined && {
            startupTimeoutSec: server.startupTimeoutSec,
          }),
          toolTimeoutSec: server.toolTimeoutSec ?? 3600,
          defaultToolsApprovalMode: "prompt" as const,
        };
        const entry: McpServerEntry = url
          ? {
              name,
              config: {
                transport: "streamable_http" as const,
                url,
                ...(server.headers ? { httpHeaders: server.headers } : {}),
                ...(server.oauthResource ? { oauthResource: server.oauthResource } : {}),
                ...timeouts,
              },
            }
          : {
              name,
              config: {
                transport: "stdio" as const,
                command: server.command!,
                ...(server.args ? { args: server.args } : {}),
                ...(server.env ? { env: server.env } : {}),
                ...timeouts,
              },
            };
        const toml = mcpServerEntryToToml(entry);
        await this.rpcRequest(CLIENT_METHOD.configValueWrite, {
          keyPath: `mcp_servers.${name}`,
          value: toml,
          mergeStrategy: "upsert",
        });
        console.log(`[interpreter-server] syncMcpServers write done requestId=${requestId} server=${name}`);
      }

      console.log(`[interpreter-server] syncMcpServers reload start requestId=${requestId}`);
      await this.rpcRequest(CLIENT_METHOD.mcpServerReload, undefined);
      console.log(
        `[interpreter-server] syncMcpServers done requestId=${requestId} durationMs=${Date.now() - startedAt} enabledCount=${enabledServers.length}`,
      );
    } catch (error) {
      console.warn(
        `[interpreter-server] syncMcpServers failed requestId=${requestId} durationMs=${Date.now() - startedAt}`,
        error,
      );
    }
  }

  private subscribeMcpServerNotifications() {
    if (this.unsubscribeMcpServerNotifications) {
      return;
    }

    this.unsubscribeMcpServerNotifications = this.subscribe((notification) => {
      switch (notification.method) {
        case SERVER_METHOD.mcpServerStartupStatusUpdated:
          console.log(
            `[interpreter-server] mcpServer startup status: name=${notification.params.name} status=${notification.params.status}`,
          );
          void this.handleMcpServerStartupStatusUpdated(notification);
          return;
        case SERVER_METHOD.mcpServerOauthLoginCompleted:
          void this.handleMcpServerOauthLoginCompleted(notification);
          return;
        default:
          return;
      }
    });
  }

  private async handleMcpServerStartupStatusUpdated(
    notification: NotificationOfMethod<typeof SERVER_METHOD.mcpServerStartupStatusUpdated>,
  ): Promise<void> {
    try {
      await persistMcpStartupStatus(notification.params);
    } catch (error) {
      console.warn("[interpreter-server] failed to persist MCP startup status:", error);
    }

    await this.broadcastMcpServerStatusChange(notification.params);
  }

  private async handleMcpServerOauthLoginCompleted(
    notification: NotificationOfMethod<typeof SERVER_METHOD.mcpServerOauthLoginCompleted>,
  ): Promise<void> {
    const { error, name, success } = notification.params;
    console.log(
      `[interpreter-server] mcpServer oauth completed: name=${name} success=${success} error=${error ?? "none"}`,
    );

    try {
      const { emitSetupCompleted } = await import("../../../server/utils/ipcBridge");
      emitSetupCompleted({
        serverId: name,
        configured: success,
        ...(error ? { error } : {}),
      });
    } catch (setupError) {
      console.warn("[interpreter-server] failed to broadcast MCP OAuth completion:", setupError);
    }

    try {
      await persistMcpOauthCompletion(name, success, error);
    } catch (persistError) {
      console.warn("[interpreter-server] failed to persist MCP OAuth completion:", persistError);
    }

    // The app-server emits this notification after the OAuth flow finishes and
    // persists credentials. `config/mcpServer/reload` is only for config edits.
    await this.broadcastMcpServerStatusChange();
  }

  private async broadcastMcpServerStatusChange(
    startupStatus?: v2.McpServerStatusUpdatedNotification,
  ): Promise<void> {
    const startedAt = Date.now();
    const startupServer = startupStatus?.name ?? "none";
    const startupState = startupStatus?.status ?? "none";
    console.log(`[interpreter-server] broadcast MCP status start startupServer=${startupServer} startupState=${startupState}`);
    try {
      const { emitToolServersChanged } = await import("../../../server/utils/ipcBridge");
      const hydratedStatuses = await loadHydratedToolServersForBroadcast();
      const statuses = mergeStartupStatusIntoToolServers(
        hydratedStatuses,
        startupStatus,
      );
      emitToolServersChanged(statuses);
      console.log(
        `[interpreter-server] broadcast MCP status done durationMs=${Date.now() - startedAt} startupServer=${startupServer} startupState=${startupState} hydratedCount=${hydratedStatuses.length} broadcastCount=${statuses.length}`,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[interpreter-server] broadcast MCP status failed durationMs=${Date.now() - startedAt} startupServer=${startupServer} startupState=${startupState} error=${message}`,
        error,
      );
    }
  }

  private attachTransportListenersOnce() {
    if (this.listenersAttached) {
      return;
    }

    this.listenersAttached = true;

    this.transport.onMessage((line) => {
      let message: unknown;

      try {
        message = JSON.parse(line);
      } catch {
        return;
      }

      if (isValidJsonRpcResponse(message)) {
        const response = message as JsonRpcResponse;
        console.log(
          `[interpreter-server] rpc response id=${String(response.id)} ok=${response.error === undefined}`,
        );
        const jsonRpc2Message = toJsonRpc2ResponseEnvelope(
          response,
        );
        if (jsonRpc2Message) {
          void this.rpc.receive(jsonRpc2Message);
        }
        return;
      }

      if (isServerRequestShape(message)) {
        const req = message as { id: number | string; method: string; params: unknown };
        console.warn(
          `[interpreter-server] received server request: ${req.method} (id=${req.id})`,
        );

        const respond = (result: unknown) => {
          this.transport.send(JSON.stringify({ id: req.id, result }));
        };

        this.events.emit("server-request", message as ServerRequest, respond);
        return;
      }

      if (!isValidNotificationShape(message)) {
        return;
      }

      const msg = message as Record<string, unknown>;
      if (!isValidLifecycleNotification(msg.method as string, msg.params)) {
        return;
      }

      this.events.emit("notification", message as AppServerNotification);
    });

    this.transport.onClose((error) => {
      this.initialized = false;
      this.connectPromise = null;
      this.disconnectSequence += 1;

      // NOTE(victor): In stdio mode there is exactly one client connection.
      // Once stdin hits EOF or stdout writes fail, app-server closes that
      // connection; with no remaining connections, the processor loop exits.
      // See `start_stdio_connection()` in
      // codex/codex-rs/app-server/src/transport.rs and
      // `shutdown_when_no_connections = single_client_mode` in
      // codex/codex-rs/app-server/src/lib.rs.
      //
      // That makes `onClose` here a real runtime/session teardown signal, not a
      // normal per-turn error. Normal turn failures are supposed to arrive via
      // app-server notifications such as `error` and then `turn/completed`; see
      // codex/codex-rs/app-server/src/bespoke_event_handling.rs.
      const reason =
        error?.message ?? "codex app-server connection closed unexpectedly";
      this.rpc.rejectAllPendingRequests(reason);
      this.events.emit("disconnect", reason);

      if (isCodexReauthCloseError(reason)) {
        this.events.emit("auth-invalidated", reason);
      }
    });
  }

  private async getRuntimeAccessSnapshot(): Promise<CodexRuntimeAccessSnapshot> {
    return this.runtimeAccessSnapshotLoader();
  }

  private async rpcRequest<M extends keyof RequestMap>(
    method: M,
    params: RequestMap[M]["params"],
    options?: { skipEnsureConnected?: boolean },
  ) {
    return this.rpcRequestWithReconnect(
      method,
      params,
      1,
      options?.skipEnsureConnected === true,
    );
  }

  private async rpcRequestWithReconnect<M extends keyof RequestMap>(
    method: M,
    params: RequestMap[M]["params"],
    remainingReconnectAttempts: number,
    skipEnsureConnected = false,
  ): Promise<RequestMap[M]["result"]> {
    // NOTE(victor): Retry only when a real disconnect happened while this RPC
    // was in flight. If the sequence did not change, then the failure came back
    // through the normal JSON-RPC path and should preserve upstream semantics.
    // That distinction matters because upstream Codex already models many
    // failures as turn/session errors without requiring process restart:
    // - `ServerOverloaded` / `InternalServerError` in
    //   codex/codex-rs/core/src/error.rs
    // - app-server `error` and `turn/completed` notifications in
    //   codex/codex-rs/app-server/src/bespoke_event_handling.rs
    const disconnectSequence = this.disconnectSequence;

    try {
      // Connection establishment is part of the retry boundary for retryable
      // methods. A disconnect during `initialize` is still a transport failure.
      if (!skipEnsureConnected && !this.initialized) {
        await this.ensureConnected();
      }

      const result = await this.rpc.request(method, params);
      const typedResult = result as RequestMap[M]["result"] | undefined;
      if (typedResult === undefined) {
        throw new Error(`JSON-RPC response missing result for ${method}`);
      }

      return typedResult;
    } catch (error) {
      if (
        remainingReconnectAttempts <= 0
        || !RETRYABLE_RPC_METHODS.has(method)
        || disconnectSequence === this.disconnectSequence
      ) {
        throw error;
      }

      this.shutdown();
      await this.ensureConnected();
      return this.rpcRequestWithReconnect(
        method,
        params,
        remainingReconnectAttempts - 1,
        skipEnsureConnected,
      );
    }
  }

  private notify(method: typeof CLIENT_NOTIFICATION_METHOD.initialized) {
    this.send({ method } satisfies JsonRpcNotification<typeof method>);
  }

  private send(
    message:
      | JsonRpcRequest<string, unknown>
      | JsonRpcNotification<string, unknown>,
  ) {
    this.transport.send(JSON.stringify(message));
  }
}
