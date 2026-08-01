import { match, P } from "ts-pattern";
import type { v2 } from "../../../server/handlers/codex-generated-types/index";
import {
  getLocalModelProviderRuntime,
  isOllamaVersionBelowDeveloperRoleFloor,
  MIN_OLLAMA_DEVELOPER_ROLE_VERSION,
} from "../../../shared/types/provider";
import { DEFAULT_OPENAI_RESPONSES_CUSTOM_TOOL_MODEL_ID } from "../../../shared/utils/openAiResponsesTools";
import type { LocaleKey } from "../../../shared/locales";
import { trEn } from "../../../shared/locales/serverI18n";
import {
  formatLmStudioPromptTemplateFailure,
  isLmStudioPromptTemplateFailure,
} from "./lmStudioErrors";

export const AUTH_SESSION_RE = /\bAUTH_SESSION_(?:EXPIRED|INVALID)\b/;
const REFRESH_TOKEN_AUTH_RE = /\brefresh_token_(?:invalidated|reused)\b/;
const MISSING_BEARER_RE = /\bMissing Bearer\b/i;
const HTTP_401_UNAUTHORIZED_RE = /\b401\b[^\n]*\bUnauthorized\b/i;
const MISSING_AUTHORIZATION_HEADER_RE =
  /"loc"\s*:\s*\[\s*"header"\s*,\s*"authorization"\s*\]/i;
const NOT_ENOUGH_TOKENS_RE =
  /\[not_enough_tokens\]|\bInsufficient interpreter tokens\b/i;
const INVALID_ENCRYPTED_CONTENT_RE = /\binvalid_encrypted_content\b/i;
const ORG_MISMATCH_RE = /\borganization_id did not match\b/i;
const RESPONSES_ENDPOINT_PATH_RE = /\/responses(?:\b|[/?#])/i;
const WINDOW_DURATION_MINS_RE = /"windowDurationMins"\s*:\s*(\d+)/i;
const RESETS_AT_RE = /"resetsAt"\s*:\s*(\d{10,13})/i;
const TRY_AGAIN_AT_RE = /\btry again at\s+([^.]+)(?:\.|$)/i;
const REQUEST_TOO_LARGE_RE =
  /\b(?:payload too large|request too large|tokens per minute|TPM)\b/i;
const CHATGPT_USAGE_LIMIT_CLARIFIER =
  "This limit is set by your ChatGPT account and is separate from Interpreter plan usage shown in Settings.";
const OPENAI_API_USAGE_LIMIT_CLARIFIER =
  "ChatGPT Pro and Plus do not include OpenAI API usage.";
const GENERIC_PROVIDER_LABELS = new Set([
  "local",
  "custom endpoint",
]);

export type TurnErrorParamValue = string | number;

export type TurnErrorDescriptor =
  | {
      kind: "key";
      key: LocaleKey;
      params?: Record<string, TurnErrorParamValue>;
    }
  | { kind: "raw"; text: string }
  | {
      kind: "sequence";
      parts: TurnErrorDescriptor[];
      separator?: string;
    };

function key(
  keyName: LocaleKey,
  params?: Record<string, TurnErrorParamValue>,
): TurnErrorDescriptor {
  return params ? { kind: "key", key: keyName, params } : { kind: "key", key: keyName };
}

function raw(text: string): TurnErrorDescriptor {
  return { kind: "raw", text };
}

function sequence(
  parts: TurnErrorDescriptor[],
  separator = "",
): TurnErrorDescriptor {
  return { kind: "sequence", parts, separator };
}

export function formatTurnErrorDescriptor(
  errorInfo: TurnErrorDescriptor,
): string {
  switch (errorInfo.kind) {
    case "key":
      return trEn(errorInfo.key, errorInfo.params);
    case "raw":
      return errorInfo.text;
    case "sequence":
      return errorInfo.parts
        .map((part) => formatTurnErrorDescriptor(part))
        .join(errorInfo.separator ?? "");
  }
}

export const RESPONSES_TOOL_CALLING_CONTRACT_KEY =
  "errors.turn.responsesContract.generic";
export const OPENAI_CUSTOM_TOOL_MODEL_KEY =
  "errors.turn.openAiCustomToolModel";
export const TOOL_USE_ROUTE_UNAVAILABLE_KEY =
  "errors.turn.toolRouteUnavailable";
export const IMAGE_INPUT_ROUTE_UNAVAILABLE_KEY =
  "errors.turn.imageRouteUnavailable";
export const INSUFFICIENT_INTERPRETER_TOKENS_KEY =
  "errors.turn.insufficientTokens";
export const REQUEST_TOO_LARGE_KEY = "errors.turn.requestTooLarge";
export const INTERPRETER_HOSTED_OVERLOADED_KEY =
  "errors.turn.hostedOverloaded";
export const INTERPRETER_HOSTED_ACCOUNT_INACTIVE_KEY =
  "errors.turn.hostedAccountInactive";
const CYBER_POLICY_KEY = "errors.turn.cyberPolicy";

export const RESPONSES_TOOL_CALLING_CONTRACT_MESSAGE = trEn(RESPONSES_TOOL_CALLING_CONTRACT_KEY);
export const OPENAI_CUSTOM_TOOL_MODEL_MESSAGE = trEn(OPENAI_CUSTOM_TOOL_MODEL_KEY, {
  model: DEFAULT_OPENAI_RESPONSES_CUSTOM_TOOL_MODEL_ID,
});
export const TOOL_USE_ROUTE_UNAVAILABLE_MESSAGE = trEn(TOOL_USE_ROUTE_UNAVAILABLE_KEY);
export const IMAGE_INPUT_ROUTE_UNAVAILABLE_MESSAGE = trEn(IMAGE_INPUT_ROUTE_UNAVAILABLE_KEY);
export const INSUFFICIENT_INTERPRETER_TOKENS_MESSAGE = trEn(INSUFFICIENT_INTERPRETER_TOKENS_KEY);
export const REQUEST_TOO_LARGE_MESSAGE = trEn(REQUEST_TOO_LARGE_KEY);
export const INTERPRETER_HOSTED_OVERLOADED_MESSAGE = trEn(INTERPRETER_HOSTED_OVERLOADED_KEY);
export const INTERPRETER_HOSTED_ACCOUNT_INACTIVE_MESSAGE = trEn(INTERPRETER_HOSTED_ACCOUNT_INACTIVE_KEY);
const CYBER_POLICY_MESSAGE = trEn(CYBER_POLICY_KEY);

const STRUCTURED_PROVIDER_DIAGNOSTIC_MARKERS = [
  "high demand",
  "payload too large",
  "provider returned error",
  "request too large",
] as const;
const DEVELOPER_ROLE_REJECTION_NEEDLE = "developer is not one of";
const TOOL_TYPE_MUST_BE_FUNCTION_NEEDLE = "'type' of tool must be 'function'";
const INPUT_INVALID_UNION_NEEDLE = "invalid_union";
const TOOL_USE_NO_ENDPOINTS_PREFIX =
  "No endpoints found that support tool use.";
const TOOL_USE_NO_ENDPOINTS_DISABLE_HINT = "Try disabling";
const IMAGE_INPUT_NO_ENDPOINTS_PREFIX =
  "No endpoints found that support image input";
const INTERNAL_STREAM_ENDED_UNEXPECTEDLY_RE =
  /\bstream disconnected before completion:\s*internal stream ended unexpectedly\b/i;
const ACCOUNT_INACTIVE_BILLING_RE =
  /\baccount is not active\b[\s\S]*\bbilling details\b/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonObject(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractNestedErrorMessageFromString(raw: string, depth: number): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = parseJsonObject(trimmed);
    if (parsed !== null) {
      return extractNestedErrorMessage(parsed, depth + 1);
    }
  }
  return trimmed;
}

export function extractNestedErrorMessage(raw: unknown, depth = 0): string | null {
  if (depth > 16 || raw === null || raw === undefined) {
    return null;
  }

  if (typeof raw === "string") {
    return extractNestedErrorMessageFromString(raw, depth);
  }

  if (Array.isArray(raw)) {
    for (const item of raw) {
      const message = extractNestedErrorMessage(item, depth + 1);
      if (message) return message;
    }
    return null;
  }

  if (!isRecord(raw)) {
    return null;
  }

  const metadata = raw.metadata;
  if (isRecord(metadata)) {
    const metadataRaw = extractNestedErrorMessage(metadata.raw, depth + 1);
    if (metadataRaw) return metadataRaw;
  }

  for (const key of ["detail", "error", "message", "msg", "error_description"]) {
    const message = extractNestedErrorMessage(raw[key], depth + 1);
    if (message) return message;
  }

  return null;
}

function unwrapJsonErrorMessage(raw: string): string {
  return extractNestedErrorMessage(raw) ?? raw;
}

function shouldPreferRawStructuredProviderMessage(
  rawMessage: string,
  codexErrorInfo: v2.CodexErrorInfo,
  formattedMessage: string,
): boolean {
  const normalizedRaw = rawMessage.trim().toLowerCase();
  if (!normalizedRaw) {
    return false;
  }

  if (normalizedRaw === formattedMessage.trim().toLowerCase()) {
    return false;
  }

  if (
    !isGenericStructuredHttpError(codexErrorInfo)
    && !isGenericServerCodexError(codexErrorInfo)
  ) {
    return false;
  }

  return STRUCTURED_PROVIDER_DIAGNOSTIC_MARKERS.some((marker) =>
    normalizedRaw.includes(marker),
  );
}

function isGenericStructuredHttpError(codexErrorInfo: v2.CodexErrorInfo): boolean {
  if (typeof codexErrorInfo === "string") {
    return false;
  }

  if (
    "httpConnectionFailed" in codexErrorInfo ||
    "responseStreamConnectionFailed" in codexErrorInfo ||
    "responseStreamDisconnected" in codexErrorInfo ||
    "responseTooManyFailedAttempts" in codexErrorInfo
  ) {
    return true;
  }

  return false;
}

function isGenericServerCodexError(codexErrorInfo: v2.CodexErrorInfo): boolean {
  return codexErrorInfo === "internalServerError"
    || codexErrorInfo === "serverOverloaded";
}

function isInternalStreamEndedUnexpectedly(rawMessage: string): boolean {
  return INTERNAL_STREAM_ENDED_UNEXPECTEDLY_RE.test(rawMessage);
}

export function isHostedHighDemandMessage(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("currently experiencing high demand") ||
    (normalized.includes("experiencing high demand") &&
      normalized.includes("temporary errors"))
  );
}

type UsageLimitWindowDetails = {
  windowDurationMins: number | null;
  resetsAt: number | null;
};

export type TurnErrorFormattingContext = {
  hasImageInput?: boolean;
  isChatGptProfile?: boolean;
  modelId?: string | null;
  modelProvider?: string | null;
  providerLabel?: string | null;
  /** Version reported by the local runtime (Ollama/LM Studio), when detected. */
  localProviderVersion?: string | null;
};

type ExhaustivelyFormattedCodexErrorInfo = Exclude<v2.CodexErrorInfo, "cyberPolicy">;

function isCyberPolicyErrorInfo(codexErrorInfo: unknown): codexErrorInfo is "cyberPolicy" {
  return codexErrorInfo === "cyberPolicy";
}

function formatAuthError(additionalDetails?: string | null): string {
  if (
    additionalDetails &&
    (AUTH_SESSION_RE.test(additionalDetails) ||
      REFRESH_TOKEN_AUTH_RE.test(additionalDetails))
  ) {
    return "Authentication failed. Your session expired. Please sign in again.";
  }
  return "Authentication failed. Check your API key, or sign in again if using hosted models.";
}

function isRefreshTokenAuthError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("refresh token") ||
    normalized.includes("refresh_token") ||
    normalized.includes("could not be refreshed")
  );
}

function formatRefreshTokenAuthError(
  context: TurnErrorFormattingContext = {},
): string {
  if (context.isChatGptProfile) {
    return "Your ChatGPT sign-in expired. Sign in with ChatGPT again in Settings > Models, then retry.";
  }

  return "Authentication failed. Sign in again with the selected model provider, then retry.";
}

function formatUnstructuredAuthError(
  message: string,
  additionalDetails?: string | null,
): string | null {
  const combined = [message, additionalDetails]
    .filter((value): value is string => Boolean(value))
    .join("\n");

  if (!combined) {
    return null;
  }

  if (
    AUTH_SESSION_RE.test(combined) ||
    REFRESH_TOKEN_AUTH_RE.test(combined)
  ) {
    return "Authentication failed. Your session expired. Please sign in again.";
  }

  if (
    INVALID_ENCRYPTED_CONTENT_RE.test(combined) ||
    ORG_MISMATCH_RE.test(combined)
  ) {
    return "Conversation encrypted content is invalid (organization mismatch). This conversation is unrecoverable.";
  }

  if (
    MISSING_BEARER_RE.test(combined) ||
    HTTP_401_UNAUTHORIZED_RE.test(combined) ||
    MISSING_AUTHORIZATION_HEADER_RE.test(combined)
  ) {
    return formatAuthError(combined);
  }

  return null;
}

function formatLocalProviderUpdateMessage(
  context: TurnErrorFormattingContext,
): string | null {
  const detectedVersion = context.localProviderVersion?.trim();
  const normalizedVersion = detectedVersion?.startsWith("v")
    ? detectedVersion.slice(1)
    : detectedVersion;
  const versionSuffix = normalizedVersion ? ` (v${normalizedVersion})` : "";

  switch (getLocalModelProviderRuntime(context.modelProvider)) {
    case "ollama":
      return `Your Ollama version${versionSuffix} does not support the required message format (developer role). Update Ollama to v${MIN_OLLAMA_DEVELOPER_ROLE_VERSION} or newer.`;
    case "lmstudio":
      return `Your LM Studio version${versionSuffix} does not support the required message format (developer role). Update LM Studio to the latest version.`;
    default:
      return null;
  }
}

/**
 * True for any message produced by {@link formatLocalProviderUpdateMessage}, so
 * the renderer can classify these into a dedicated "update your local runtime"
 * error (proper title + Open Profiles action) without re-deriving the version
 * logic. Matches the stable update-instruction tail shared by both variants.
 */
export function isLocalRuntimeUpdateMessage(message: string | null | undefined): boolean {
  if (!message) return false;
  return (
    message.includes("Update Ollama to v") ||
    message.includes("Update LM Studio to")
  );
}

function extractHttpStatusCode(codexErrorInfo: v2.CodexErrorInfo | null): number | null {
  if (codexErrorInfo === null || typeof codexErrorInfo !== "object") {
    return null;
  }
  for (const key of [
    "httpConnectionFailed",
    "responseStreamConnectionFailed",
    "responseStreamDisconnected",
    "responseTooManyFailedAttempts",
  ] as const) {
    if (key in codexErrorInfo) {
      const code = (codexErrorInfo as Record<string, { httpStatusCode?: unknown }>)[key]
        ?.httpStatusCode;
      if (typeof code === "number") return code;
    }
  }
  return null;
}

/**
 * Names an outdated Ollama runtime as the cause of a Responses-API failure.
 *
 * Ollama only gained `/v1/responses` in 0.13.3, so on an older server codex's
 * POST 404s before any developer-role rejection (which the contract-error path
 * already handles). Gated on a positively detected below-floor version, so it
 * never fires for auth, not-running, or model-missing errors, nor when the
 * version is unknown.
 */
function formatOutdatedLocalRuntimeResponsesError(
  error: v2.TurnError,
  context: TurnErrorFormattingContext,
): string | null {
  if (getLocalModelProviderRuntime(context.modelProvider) !== "ollama") {
    return null;
  }
  if (!isOllamaVersionBelowDeveloperRoleFloor(context.localProviderVersion)) {
    return null;
  }

  const combined = [error.message, error.additionalDetails]
    .filter((value): value is string => Boolean(value))
    .join("\n");
  const normalized = combined.toLowerCase();
  const status = extractHttpStatusCode(error.codexErrorInfo);

  const looksLikeResponsesIncompatibility =
    status === 404 ||
    (RESPONSES_ENDPOINT_PATH_RE.test(combined) &&
      (normalized.includes("404") || normalized.includes("not found"))) ||
    (normalized.includes("too old") && normalized.includes("ollama"));

  return looksLikeResponsesIncompatibility
    ? formatLocalProviderUpdateMessage(context)
    : null;
}

function formatResponsesToolCallingContractMessage(
  context: TurnErrorFormattingContext,
): string {
  const modelId = context.modelId?.trim();
  const providerLabel = context.providerLabel?.trim();
  const providerPrefix = providerLabel
    && !GENERIC_PROVIDER_LABELS.has(providerLabel.toLowerCase())
      ? providerLabel
      : null;

  if (providerPrefix && modelId) {
    return `${modelId} on ${providerPrefix} does not support Interpreter's Responses/tool-calling contract.`;
  }
  if (providerPrefix) {
    return `The selected model on ${providerPrefix} does not support Interpreter's Responses/tool-calling contract.`;
  }
  if (modelId) {
    return `${modelId} does not support Interpreter's Responses/tool-calling contract.`;
  }
  return RESPONSES_TOOL_CALLING_CONTRACT_MESSAGE;
}

type OpenAiErrorBody = {
  readonly error?: {
    readonly message?: unknown;
    readonly param?: unknown;
    readonly code?: unknown;
    readonly type?: unknown;
  };
};

function isOpenAiToolTypeParam(param: unknown): boolean {
  if (typeof param !== "string") {
    return false;
  }

  const parts = param.split(".");
  if (parts.length !== 3 || parts[0] !== "tools" || parts[2] !== "type") {
    return false;
  }

  return parts[1] !== ""
    && Array.from(parts[1]).every((char) => char >= "0" && char <= "9");
}

function isOpenAiProviderContext(context: TurnErrorFormattingContext): boolean {
  const modelProvider = context.modelProvider?.trim().toLowerCase() ?? "";
  if (
    matchesProviderPrefix(modelProvider, "openai")
    || matchesProviderPrefix(modelProvider, "openrouter")
    || matchesProviderPrefix(modelProvider, "interpreter")
  ) {
    return true;
  }

  const providerLabel = context.providerLabel?.trim().toLowerCase() ?? "";
  return (
    providerLabel === "openai"
    || providerLabel === "openai api"
    || providerLabel === "openrouter"
    || providerLabel === "hosted"
  );
}

function isInvalidInputUnionError(combined: string): boolean {
  const normalized = combined.toLowerCase();
  return normalized.includes("invalid type for 'input'")
    && normalized.includes(INPUT_INVALID_UNION_NEEDLE);
}

function parseOpenAiErrorBody(raw: string): OpenAiErrorBody | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object") {
      return parsed as OpenAiErrorBody;
    }
  } catch {
    return null;
  }

  return null;
}

function isOpenAiCustomToolRejection(
  message?: string | null,
  additionalDetails?: string | null,
  context: TurnErrorFormattingContext = {},
): boolean {
  if (!isOpenAiProviderContext(context)) {
    return false;
  }

  const combined = [message, additionalDetails]
    .filter((value): value is string => Boolean(value))
    .join("\n");
  if (!combined) {
    return false;
  }

  // NOTE(victor): LM Studio/OpenAI-compatible endpoints can reject Interpreter
  // custom tools with only message="Invalid" plus param="tools.<index>.type";
  // the param is the only durable signal that the server rejected the schema.
  const parsed = parseOpenAiErrorBody(combined);
  const openAiError = parsed?.error;
  if (
    openAiError?.param === "tools" &&
    typeof openAiError.message === "string" &&
    openAiError.message.includes("Invalid value: 'custom'")
  ) {
    return true;
  }

  const normalized = combined.toLowerCase();
  return (
    normalized.includes("invalid value: 'custom'") &&
    normalized.includes("tools")
  );
}

export function getResponsesToolCallingContractError(
  message?: string | null,
  additionalDetails?: string | null,
  context: TurnErrorFormattingContext = {},
): string | null {
  const combined = [message, additionalDetails]
    .filter((value): value is string => Boolean(value))
    .join("\n");

  if (!combined) {
    return null;
  }

  if (
    combined.includes(TOOL_USE_NO_ENDPOINTS_PREFIX) &&
    combined.includes(TOOL_USE_NO_ENDPOINTS_DISABLE_HINT)
  ) {
    return TOOL_USE_ROUTE_UNAVAILABLE_MESSAGE;
  }

  if (isOpenAiCustomToolRejection(message, additionalDetails, context)) {
    return OPENAI_CUSTOM_TOOL_MODEL_MESSAGE;
  }

  const parsed = parseOpenAiErrorBody(combined);
  const openAiError = parsed?.error;
  if (
    openAiError?.type === "invalid_request_error"
    && isOpenAiToolTypeParam(openAiError.param)
  ) {
    return formatResponsesToolCallingContractMessage(context);
  }

  const normalized = combined.toLowerCase();
  if (normalized.includes("responses/tool-calling contract")) {
    return formatResponsesToolCallingContractMessage(context);
  }

  const firstLine = combined
    .trimStart()
    .split("\n")
    .find((line) => line.trim().length > 0)
    ?.trim()
    .toLowerCase();
  if (firstLine && isLikelyLiteralToolCallText(firstLine)) {
    return formatResponsesToolCallingContractMessage(context);
  }

  if (
    normalized.includes("input")
    && normalized.includes("valid string")
    && (
      normalized.includes("validation error")
      || normalized.includes("invalid_request_error")
      || normalized.includes("json_invalid")
      || normalized.includes("schema")
    )
  ) {
    return formatResponsesToolCallingContractMessage(context);
  }

  if (isInvalidInputUnionError(combined)) {
    return formatResponsesToolCallingContractMessage(context);
  }

  // Some OpenAI-compatible endpoints (for example DashScope-compatible routes)
  // reject Responses/tool-calling payloads with this provider-specific 400 error.
  if (
    normalized.includes("internalerror.algo.invalidparameter")
    && normalized.includes("content field is a required field")
  ) {
    return formatResponsesToolCallingContractMessage(context);
  }

  if (
    normalized.includes(DEVELOPER_ROLE_REJECTION_NEEDLE)
    && normalized.includes("role")
  ) {
    return formatLocalProviderUpdateMessage(context)
      ?? formatResponsesToolCallingContractMessage(context);
  }

  if (normalized.includes(TOOL_TYPE_MUST_BE_FUNCTION_NEEDLE)) {
    return formatResponsesToolCallingContractMessage(context);
  }

  return null;
}

export function getUnsupportedImageInputError(
  message?: string | null,
  additionalDetails?: string | null,
  context: TurnErrorFormattingContext = {},
): string | null {
  const combined = [message, additionalDetails]
    .filter((value): value is string => Boolean(value))
    .join("\n");

  if (combined.includes(IMAGE_INPUT_NO_ENDPOINTS_PREFIX)) {
    return IMAGE_INPUT_ROUTE_UNAVAILABLE_MESSAGE;
  }

  if (
    isLmStudioErrorFormattingContext(context)
    && context.hasImageInput
    && isInvalidInputUnionError(combined)
  ) {
    return IMAGE_INPUT_ROUTE_UNAVAILABLE_MESSAGE;
  }

  return null;
}

function isLikelyLiteralToolCallText(firstLine: string): boolean {
  if (!firstLine.startsWith("call:")) {
    return false;
  }

  const afterPrefix = firstLine.slice("call:".length);
  if (afterPrefix.length === 0 || afterPrefix !== afterPrefix.trimStart()) {
    return false;
  }

  const braceIndex = afterPrefix.indexOf("{");
  if (braceIndex < 0) {
    return false;
  }

  const toolName = afterPrefix.slice(0, braceIndex);
  if (!toolName || toolName !== toolName.trim()) {
    return false;
  }

  for (const char of toolName) {
    const isLowerAlpha = char >= "a" && char <= "z";
    const isDigit = char >= "0" && char <= "9";
    if (!isLowerAlpha && !isDigit && char !== "_" && char !== "-") {
      return false;
    }
  }

  return isBalancedObjectLiteral(afterPrefix.slice(braceIndex));
}

function isBalancedObjectLiteral(value: string): boolean {
  if (!value.startsWith("{")) {
    return false;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index === value.length - 1;
      }
      if (depth < 0) {
        return false;
      }
    }
  }

  return false;
}

function formatHttpError(
  prefix: string,
  code: number | null,
  additionalDetails?: string | null,
  context: TurnErrorFormattingContext = {},
): string {
  const imageInputError = getUnsupportedImageInputError(
    undefined,
    additionalDetails,
  );
  if (imageInputError) {
    return imageInputError;
  }

  const contractError = getResponsesToolCallingContractError(
    undefined,
    additionalDetails,
    context,
  );
  if (contractError) {
    return contractError;
  }
  const requestTooLargeError = formatRequestTooLargeError(
    undefined,
    additionalDetails,
  );
  if (code === 413) {
    return requestTooLargeError ?? REQUEST_TOO_LARGE_MESSAGE;
  }
  if (code === null) return `${prefix}.`;
  return match(code)
    .with(401, () => formatAuthError(additionalDetails))
    .with(
      402,
      () =>
        formatInsufficientTokenError(undefined, additionalDetails) ??
        "Payment required. Check your billing settings.",
    )
    .with(403, () => "Access forbidden. Check your API key permissions.")
    .with(404, () => formatEndpointNotFoundError(additionalDetails, context))
    .with(408, () => "Request timed out. Try again.")
    .with(429, () => "Rate limited. Try again later.")
    .with(500, () => "Provider internal server error.")
    .with(502, () => "Bad gateway. The provider may be down.")
    .with(503, () => "Provider service unavailable. Try again later.")
    .with(504, () => "Gateway timeout. The provider is not responding.")
    .otherwise((c) => `${prefix} (HTTP ${c}).`);
}

function isCustomEndpointContext(context: TurnErrorFormattingContext): boolean {
  const providerLabel = context.providerLabel?.trim().toLowerCase();
  if (providerLabel === "custom endpoint") {
    return true;
  }

  const modelProvider = context.modelProvider?.trim().toLowerCase();
  if (!modelProvider) {
    return false;
  }

  return matchesProviderPrefix(modelProvider, "custom");
}

function formatEndpointNotFoundError(
  additionalDetails?: string | null,
  context: TurnErrorFormattingContext = {},
): string {
  if (
    isCustomEndpointContext(context)
    && additionalDetails
    && RESPONSES_ENDPOINT_PATH_RE.test(additionalDetails)
  ) {
    return "API endpoint not found. This base URL may not support the OpenAI Responses API (/responses). Use a supported Responses provider URL or OpenRouter.";
  }

  return "API endpoint not found. Check your provider URL.";
}

function formatInsufficientTokenError(
  message?: string | null,
  additionalDetails?: string | null,
): string | null {
  const combined = [message, additionalDetails]
    .filter((value): value is string => Boolean(value))
    .join("\n");

  if (!combined) {
    return null;
  }

  if (NOT_ENOUGH_TOKENS_RE.test(combined)) {
    return INSUFFICIENT_INTERPRETER_TOKENS_MESSAGE;
  }

  return null;
}

function formatRequestTooLargeError(
  message?: string | null,
  additionalDetails?: string | null,
): string | null {
  const combined = [message, additionalDetails]
    .filter((value): value is string => Boolean(value))
    .join("\n");

  if (!combined || !REQUEST_TOO_LARGE_RE.test(combined)) {
    return null;
  }

  return REQUEST_TOO_LARGE_MESSAGE;
}

function isInterpreterHostedErrorFormattingContext(
  context: TurnErrorFormattingContext,
): boolean {
  const modelProvider = context.modelProvider?.trim().toLowerCase() ?? "";
  if (matchesProviderPrefix(modelProvider, "interpreter")) {
    return true;
  }

  const providerLabel = context.providerLabel?.trim().toLowerCase() ?? "";
  return providerLabel === "hosted" || providerLabel === "interpreter";
}

function formatInterpreterHostedInfrastructureError(
  message?: string | null,
  additionalDetails?: string | null,
  context: TurnErrorFormattingContext = {},
): string | null {
  if (!isInterpreterHostedErrorFormattingContext(context)) {
    return null;
  }

  const combined = [message, additionalDetails]
    .filter((value): value is string => Boolean(value))
    .join("\n");

  if (ACCOUNT_INACTIVE_BILLING_RE.test(combined)) {
    return INTERPRETER_HOSTED_ACCOUNT_INACTIVE_MESSAGE;
  }

  if (
    isHostedHighDemandMessage(combined) ||
    isInternalStreamEndedUnexpectedly(combined)
  ) {
    return INTERPRETER_HOSTED_OVERLOADED_MESSAGE;
  }

  return null;
}

function normalizeEpochSeconds(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  if (value <= 0) {
    return null;
  }
  const seconds = value > 1_000_000_000_000 ? value / 1_000 : value;
  return Math.floor(seconds);
}

interface RateLimitPrimary {
  windowDurationMins?: unknown;
  resetsAt?: unknown;
}

interface RateLimitEntry {
  primary?: RateLimitPrimary;
}

function hasRateLimitsByLimitId(
  x: unknown,
): x is { rateLimitsByLimitId: Record<string, RateLimitEntry> } {
  if (x === null || typeof x !== "object" || !("rateLimitsByLimitId" in x)) {
    return false;
  }
  const inner = (x as { rateLimitsByLimitId: unknown }).rateLimitsByLimitId;
  return inner !== null && typeof inner === "object" && !Array.isArray(inner);
}

function extractUsageLimitWindowDetailsFromObject(
  input: unknown,
): UsageLimitWindowDetails | null {
  if (!hasRateLimitsByLimitId(input)) return null;
  const firstEntry = Object.values(input.rateLimitsByLimitId)[0];
  const primary = firstEntry?.primary;
  if (!primary) return null;

  const windowDurationMins =
    typeof primary.windowDurationMins === "number" &&
    Number.isFinite(primary.windowDurationMins)
      ? Math.floor(primary.windowDurationMins)
      : null;
  const resetsAt = normalizeEpochSeconds(primary.resetsAt);

  return windowDurationMins === null && resetsAt === null
    ? null
    : { windowDurationMins, resetsAt };
}

function extractUsageLimitWindowDetails(
  additionalDetails?: string | null,
): UsageLimitWindowDetails | null {
  if (!additionalDetails) {
    return null;
  }

  try {
    const parsed = JSON.parse(additionalDetails);
    const details = extractUsageLimitWindowDetailsFromObject(parsed);
    if (details) {
      return details;
    }
  } catch {
    // Keep parsing below for string blobs that embed JSON snippets.
  }

  const windowMatch = additionalDetails.match(WINDOW_DURATION_MINS_RE);
  const resetMatch = additionalDetails.match(RESETS_AT_RE);
  const windowDurationMins = windowMatch ? Number.parseInt(windowMatch[1]!, 10) : null;
  const resetsAtRaw = resetMatch ? Number.parseInt(resetMatch[1]!, 10) : null;
  const resetsAt = normalizeEpochSeconds(resetsAtRaw);

  if (windowDurationMins === null && resetsAt === null) {
    return null;
  }

  return { windowDurationMins, resetsAt };
}

function formatResetTimestamp(resetsAt: number): string | null {
  const date = new Date(resetsAt * 1_000);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString().replace(".000Z", "Z");
}

function extractTryAgainAtFromMessage(message: string): string | null {
  const match = message.match(TRY_AGAIN_AT_RE);
  if (!match?.[1]) {
    return null;
  }

  const value = match[1].trim();
  return value.length > 0 ? value : null;
}

export function isChatGptUsageLimitSentence(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("you've hit your usage limit")
    || normalized.includes("you have hit your usage limit");
}

export function formatChatGptUsageLimitMessage(message: string): string {
  const pieces = ["You've hit your ChatGPT usage limit."];
  const tryAgainAtText = extractTryAgainAtFromMessage(message);
  if (tryAgainAtText) {
    pieces.push(`Try again at: ${tryAgainAtText}.`);
  }
  return pieces.join(" ");
}

function matchesProviderPrefix(
  modelProvider: string,
  prefix: string,
): boolean {
  return modelProvider === prefix || modelProvider.startsWith(`${prefix}-`);
}

function isLmStudioErrorFormattingContext(
  context: TurnErrorFormattingContext,
): boolean {
  const modelProvider = context.modelProvider?.trim().toLowerCase() ?? "";
  if (modelProvider) {
    return getLocalModelProviderRuntime(modelProvider) === "lmstudio";
  }

  const providerLabel = context.providerLabel?.trim().toLowerCase() ?? "";
  return providerLabel === "lm studio";
}

function isLocalErrorFormattingContext(
  context: TurnErrorFormattingContext,
): boolean {
  const modelProvider = context.modelProvider?.trim().toLowerCase() ?? "";
  if (modelProvider) {
    return modelProvider === "local"
      || getLocalModelProviderRuntime(modelProvider) !== null;
  }

  const providerLabel = context.providerLabel?.trim().toLowerCase() ?? "";
  return providerLabel === "local" || providerLabel === "lm studio";
}

function resolveUsageLimitProviderLabel(
  context: TurnErrorFormattingContext,
): string | null {
  const modelProvider = context.modelProvider?.trim().toLowerCase() ?? "";
  if (getLocalModelProviderRuntime(modelProvider)) {
    return null;
  }

  const rawProviderLabel = context.providerLabel?.trim();
  if (
    rawProviderLabel &&
    !GENERIC_PROVIDER_LABELS.has(rawProviderLabel.toLowerCase())
  ) {
    return rawProviderLabel;
  }

  if (!modelProvider) {
    return null;
  }

  if (matchesProviderPrefix(modelProvider, "openai")) return "OpenAI";
  if (matchesProviderPrefix(modelProvider, "openrouter")) return "OpenRouter";
  if (matchesProviderPrefix(modelProvider, "nvidia")) return "NVIDIA";
  if (matchesProviderPrefix(modelProvider, "groq")) return "Groq";
  if (matchesProviderPrefix(modelProvider, "xai")) return "xAI";
  if (matchesProviderPrefix(modelProvider, "fireworks")) return "Fireworks AI";
  if (matchesProviderPrefix(modelProvider, "interpreter")) return "Interpreter";

  return null;
}

function formatUsageLimitSource(context: TurnErrorFormattingContext): string {
  const providerLabel = resolveUsageLimitProviderLabel(context);
  if (!providerLabel) {
    return "Usage limit exceeded on your provider account.";
  }
  if (/\baccount\b$/i.test(providerLabel)) {
    return `Usage limit exceeded on your ${providerLabel}.`;
  }

  return `Usage limit exceeded on your ${providerLabel} account.`;
}

function isOpenAiApiUsageLimitContext(context: TurnErrorFormattingContext): boolean {
  const modelProvider = context.modelProvider?.trim().toLowerCase() ?? "";
  const providerLabel = context.providerLabel?.trim().toLowerCase() ?? "";
  return modelProvider === "openai-api" || providerLabel === "openai api";
}

function formatChatGptUsageLimitExceeded(message: string): string {
  const pieces = [
    formatChatGptUsageLimitMessage(message),
    CHATGPT_USAGE_LIMIT_CLARIFIER,
  ];
  return pieces.join(" ");
}

function formatUsageLimitExceeded(
  message: string,
  additionalDetails?: string | null,
  context: TurnErrorFormattingContext = {},
): string {
  if (context.isChatGptProfile) {
    return formatChatGptUsageLimitExceeded(message);
  }

  const details = extractUsageLimitWindowDetails(additionalDetails);
  const tryAgainAtText = extractTryAgainAtFromMessage(message);
  const providerMessage = formatUsageLimitSource(context);

  const pieces: string[] = [];
  if (isOpenAiApiUsageLimitContext(context)) {
    pieces.push(OPENAI_API_USAGE_LIMIT_CLARIFIER);
  }
  if (details?.windowDurationMins !== null && details?.windowDurationMins !== undefined) {
    pieces.push(`Window: ${details.windowDurationMins} minutes.`);
  }
  if (details?.resetsAt !== null && details?.resetsAt !== undefined) {
    const formatted = formatResetTimestamp(details.resetsAt);
    if (formatted) {
      pieces.push(`Resets at: ${formatted}.`);
    }
  } else if (tryAgainAtText) {
    pieces.push(`Try again at: ${tryAgainAtText}.`);
  }

  if (pieces.length === 0) {
    return `${providerMessage} Try again later.`;
  }

  return `${providerMessage} ${pieces.join(" ")}`;
}

function formatTurnErrorEnglish(
  error: v2.TurnError,
  context: TurnErrorFormattingContext = {},
): string {
  if (
    isLmStudioErrorFormattingContext(context) &&
    isLmStudioPromptTemplateFailure(error.message, error.additionalDetails)
  ) {
    return formatLmStudioPromptTemplateFailure(
      error.message,
      error.additionalDetails,
    );
  }

  const modelNotSupportedMatch = error.message.match(
    /The '([^']+)' model is not supported/,
  );
  if (modelNotSupportedMatch) {
    return `Model "${modelNotSupportedMatch[1]}" is not available on your current plan. Change your model in profile settings.`;
  }

  const unstructuredAuthError = formatUnstructuredAuthError(
    error.message,
    error.additionalDetails,
  );
  const responsesContractError = getResponsesToolCallingContractError(
    error.message,
    error.additionalDetails,
    context,
  );
  const unsupportedImageInputError = getUnsupportedImageInputError(
    error.message,
    error.additionalDetails,
    context,
  );
  const insufficientTokenError = formatInsufficientTokenError(
    error.message,
    error.additionalDetails,
  );
  const requestTooLargeError = formatRequestTooLargeError(
    error.message,
    error.additionalDetails,
  );
  const interpreterHostedInfrastructureError =
    formatInterpreterHostedInfrastructureError(
      error.message,
      error.additionalDetails,
      context,
    );

  if (unsupportedImageInputError) {
    return unsupportedImageInputError;
  }

  if (responsesContractError) {
    return responsesContractError;
  }

  const outdatedLocalRuntimeError = formatOutdatedLocalRuntimeResponsesError(
    error,
    context,
  );
  if (outdatedLocalRuntimeError) {
    return outdatedLocalRuntimeError;
  }

  if (!error.codexErrorInfo) {
    return (
      unstructuredAuthError ??
      insufficientTokenError ??
      requestTooLargeError ??
      interpreterHostedInfrastructureError ??
      unwrapJsonErrorMessage(error.message)
    );
  }

  if (interpreterHostedInfrastructureError) {
    return interpreterHostedInfrastructureError;
  }

  const httpError = (prefix: string, code: number | null) =>
    formatHttpError(prefix, code, error.additionalDetails, context);

  if (isCyberPolicyErrorInfo(error.codexErrorInfo)) {
    return CYBER_POLICY_MESSAGE;
  }

  const formattedError = match(error.codexErrorInfo as ExhaustivelyFormattedCodexErrorInfo)
    .with("unauthorized", () => {
      if (isRefreshTokenAuthError(error.message)) {
        return formatRefreshTokenAuthError(context);
      }
      return formatAuthError(error.additionalDetails);
    })
    .with("usageLimitExceeded", () =>
      formatUsageLimitExceeded(error.message, error.additionalDetails, context),
    )
    .with(
      "contextWindowExceeded",
      () => "Context window exceeded. Start a new conversation.",
    )
    .with("sessionBudgetExceeded", () => "This session has reached its configured budget.")
    .with("serverOverloaded", () => "Server overloaded. Try again later.")
    .with(
      "internalServerError",
      () => "Internal server error. Try again later.",
    )
    .with("sandboxError", () => "Sandbox policy blocked this action.")
    .with("badRequest", () => "Bad request.")
    .with(
      "threadRollbackFailed",
      () => "Failed to roll back conversation.",
    )
    .with("other", () => {
      return (
        responsesContractError ??
        unstructuredAuthError ??
        insufficientTokenError ??
        requestTooLargeError ??
        (
          !isLocalErrorFormattingContext(context)
          && isInternalStreamEndedUnexpectedly(error.message)
            ? "Response stream disconnected."
            : null
        ) ??
        unwrapJsonErrorMessage(error.message)
      );
    })
    .with({ httpConnectionFailed: P.select() }, ({ httpStatusCode }) =>
      httpError("Connection failed", httpStatusCode),
    )
    .with({ responseStreamConnectionFailed: P.select() }, ({ httpStatusCode }) =>
      httpError("Response stream failed to connect", httpStatusCode),
    )
    .with({ responseStreamDisconnected: P.select() }, ({ httpStatusCode }) =>
      httpError("Response stream disconnected", httpStatusCode),
    )
    .with({ responseTooManyFailedAttempts: P.select() }, ({ httpStatusCode }) =>
      httpError("Too many failed attempts", httpStatusCode),
    )
    .with({ activeTurnNotSteerable: P.select() }, ({ turnKind }) => {
      if (turnKind === "review") {
        return "This request can't be sent while the current turn is in review mode.";
      }

      return "This request can't be sent while the current turn is compacting context.";
    })
    .exhaustive();

  return shouldPreferRawStructuredProviderMessage(
    error.message,
    error.codexErrorInfo,
    formattedError,
  )
    ? unwrapJsonErrorMessage(error.message)
    : formattedError;
}

const EXACT_TURN_ERROR_KEYS = new Map<string, LocaleKey>([
  [
    "Authentication failed. Your session expired. Please sign in again.",
    "errors.turn.authSessionExpired",
  ],
  [
    "Authentication failed. Check your API key, or sign in again if using hosted models.",
    "errors.turn.authGeneric",
  ],
  [
    "Your ChatGPT sign-in expired. Sign in with ChatGPT again in Settings > Models, then retry.",
    "errors.turn.authChatGptExpired",
  ],
  [
    "Authentication failed. Sign in again with the selected model provider, then retry.",
    "errors.turn.authProviderExpired",
  ],
  [
    "Conversation encrypted content is invalid (organization mismatch). This conversation is unrecoverable.",
    "errors.turn.invalidEncryptedContent",
  ],
  [RESPONSES_TOOL_CALLING_CONTRACT_MESSAGE, RESPONSES_TOOL_CALLING_CONTRACT_KEY],
  [OPENAI_CUSTOM_TOOL_MODEL_MESSAGE, OPENAI_CUSTOM_TOOL_MODEL_KEY],
  [TOOL_USE_ROUTE_UNAVAILABLE_MESSAGE, TOOL_USE_ROUTE_UNAVAILABLE_KEY],
  [IMAGE_INPUT_ROUTE_UNAVAILABLE_MESSAGE, IMAGE_INPUT_ROUTE_UNAVAILABLE_KEY],
  [INSUFFICIENT_INTERPRETER_TOKENS_MESSAGE, INSUFFICIENT_INTERPRETER_TOKENS_KEY],
  [REQUEST_TOO_LARGE_MESSAGE, REQUEST_TOO_LARGE_KEY],
  [INTERPRETER_HOSTED_OVERLOADED_MESSAGE, INTERPRETER_HOSTED_OVERLOADED_KEY],
  [INTERPRETER_HOSTED_ACCOUNT_INACTIVE_MESSAGE, INTERPRETER_HOSTED_ACCOUNT_INACTIVE_KEY],
  [trEn(CYBER_POLICY_KEY), CYBER_POLICY_KEY],
  [
    "Payment required. Check your billing settings.",
    "errors.turn.paymentRequired",
  ],
  [
    "Access forbidden. Check your API key permissions.",
    "errors.turn.accessForbidden",
  ],
  [
    "API endpoint not found. Check your provider URL.",
    "errors.turn.endpointNotFound",
  ],
  [
    "API endpoint not found. This base URL may not support the OpenAI Responses API (/responses). Use a supported Responses provider URL or OpenRouter.",
    "errors.turn.endpointNotFoundResponses",
  ],
  ["Request timed out. Try again.", "errors.turn.requestTimedOut"],
  ["Rate limited. Try again later.", "errors.turn.rateLimited"],
  [
    "Provider internal server error.",
    "errors.turn.providerInternalServerError",
  ],
  ["Bad gateway. The provider may be down.", "errors.turn.badGateway"],
  [
    "Provider service unavailable. Try again later.",
    "errors.turn.serviceUnavailable",
  ],
  [
    "Gateway timeout. The provider is not responding.",
    "errors.turn.gatewayTimeout",
  ],
  [
    "Context window exceeded. Start a new conversation.",
    "errors.turn.contextWindowExceeded",
  ],
  ["Server overloaded. Try again later.", "errors.turn.serverOverloaded"],
  [
    "Internal server error. Try again later.",
    "errors.turn.internalServerError",
  ],
  ["Sandbox policy blocked this action.", "errors.turn.sandboxError"],
  ["Bad request.", "errors.turn.badRequest"],
  ["Failed to roll back conversation.", "errors.turn.threadRollbackFailed"],
  ["Response stream disconnected.", "errors.turn.responseStreamDisconnected"],
  [
    "This request can't be sent while the current turn is in review mode.",
    "errors.turn.activeTurnReview",
  ],
  [
    "This request can't be sent while the current turn is compacting context.",
    "errors.turn.activeTurnCompacting",
  ],
]);

function describeResponsesContractMessage(message: string): TurnErrorDescriptor | null {
  const providerModel = message.match(
    /^(.+) on (.+) does not support Interpreter's Responses\/tool-calling contract\.$/,
  );
  if (providerModel) {
    return key("errors.turn.responsesContract.providerModel", {
      model: providerModel[1]!,
      provider: providerModel[2]!,
    });
  }

  const provider = message.match(
    /^The selected model on (.+) does not support Interpreter's Responses\/tool-calling contract\.$/,
  );
  if (provider) {
    return key("errors.turn.responsesContract.provider", {
      provider: provider[1]!,
    });
  }

  const model = message.match(
    /^(.+) does not support Interpreter's Responses\/tool-calling contract\.$/,
  );
  if (model) {
    return key("errors.turn.responsesContract.model", {
      model: model[1]!,
    });
  }

  return null;
}

function describeLocalRuntimeUpdateMessage(message: string): TurnErrorDescriptor | null {
  const ollama = message.match(
    /^Your Ollama version(?: \(v(.+)\))? does not support the required message format \(developer role\)\. Update Ollama to v(.+) or newer\.$/,
  );
  if (ollama) {
    return key("errors.turn.localRuntimeUpdateOllama", {
      version: ollama[1] ? ` (v${ollama[1]})` : "",
      minimumVersion: ollama[2]!,
    });
  }

  const lmStudio = message.match(
    /^Your LM Studio version(?: \(v(.+)\))? does not support the required message format \(developer role\)\. Update LM Studio to the latest version\.$/,
  );
  if (lmStudio) {
    return key("errors.turn.localRuntimeUpdateLmStudio", {
      version: lmStudio[1] ? ` (v${lmStudio[1]})` : "",
    });
  }

  return null;
}

function describeUsageLimitMessage(message: string): TurnErrorDescriptor | null {
  if (message.startsWith("You've hit your ChatGPT usage limit.")) {
    const tryAgain = message.match(/Try again at: ([^.]+)\./);
    return sequence([
      key("errors.turn.usageLimit.chatGpt"),
      ...(tryAgain
        ? [key("errors.turn.usageLimit.tryAgainAt", { time: tryAgain[1]! })]
        : []),
      key("errors.turn.usageLimit.chatGptClarifier"),
    ], " ");
  }

  const source = message.match(/^Usage limit exceeded on your (.+?)\. (.*)$/);
  if (!source) {
    return null;
  }

  const sourceLabel = source[1]!;
  const rest = source[2]!;
  const parts: TurnErrorDescriptor[] = [
    sourceLabel === "provider account"
      ? key("errors.turn.usageLimit.providerGeneric")
      : key("errors.turn.usageLimit.providerNamed", { provider: sourceLabel }),
  ];

  if (rest === "Try again later.") {
    parts.push(key("errors.turn.usageLimit.tryLater"));
    return sequence(parts, " ");
  }

  if (rest === OPENAI_API_USAGE_LIMIT_CLARIFIER) {
    parts.push(key("errors.turn.usageLimit.openAiApiClarifier"));
    return sequence(parts, " ");
  }

  const window = rest.match(/Window: (\d+) minutes\./);
  if (window) {
    parts.push(key("errors.turn.usageLimit.window", { minutes: window[1]! }));
  }
  const resetsAt = rest.match(/Resets at: ([^.]+)\./);
  if (resetsAt) {
    parts.push(key("errors.turn.usageLimit.resetsAt", { time: resetsAt[1]! }));
  }
  const tryAgain = rest.match(/Try again at: ([^.]+)\./);
  if (tryAgain) {
    parts.push(key("errors.turn.usageLimit.tryAgainAt", { time: tryAgain[1]! }));
  }

  return parts.length > 1 ? sequence(parts, " ") : null;
}

function describeLmStudioPromptTemplateMessage(message: string): TurnErrorDescriptor | null {
  const guidance = [
    "The selected model from LM Studio doesn't support Interpreter tools.",
    "Choose a tool-capable model in LM Studio, or switch to an Interpreter hosted model, then retry.",
  ].join("\n");
  if (message === guidance) {
    return key("errors.turn.lmStudioToolUnsupported");
  }
  if (message.endsWith(`\n\n${guidance}`)) {
    return sequence([
      raw(message.slice(0, -`\n\n${guidance}`.length)),
      key("errors.turn.lmStudioToolUnsupported"),
    ], "\n\n");
  }
  return null;
}

function describeHttpPrefixMessage(message: string): TurnErrorDescriptor | null {
  const prefixKeyByMessage: Record<string, LocaleKey> = {
    "Connection failed": "errors.turn.httpPrefix.connectionFailed",
    "Response stream failed to connect": "errors.turn.httpPrefix.responseStreamConnectionFailed",
    "Response stream disconnected": "errors.turn.httpPrefix.responseStreamDisconnected",
    "Too many failed attempts": "errors.turn.httpPrefix.tooManyFailedAttempts",
  };

  const withCode = message.match(
    /^(Connection failed|Response stream failed to connect|Response stream disconnected|Too many failed attempts) \(HTTP (\d+)\)\.$/,
  );
  if (withCode) {
    const prefixKey = prefixKeyByMessage[withCode[1]!];
    return prefixKey
      ? sequence([key(prefixKey), raw(` (HTTP ${withCode[2]!}).`)])
      : null;
  }

  const withoutCode = message.match(
    /^(Connection failed|Response stream failed to connect|Response stream disconnected|Too many failed attempts)\.$/,
  );
  if (withoutCode) {
    const prefixKey = prefixKeyByMessage[withoutCode[1]!];
    return prefixKey ? sequence([key(prefixKey), raw(".")]) : null;
  }

  return null;
}

export function describeFormattedTurnError(message: string): TurnErrorDescriptor {
  const exactKey = EXACT_TURN_ERROR_KEYS.get(message);
  if (exactKey) {
    if (exactKey === OPENAI_CUSTOM_TOOL_MODEL_KEY) {
      return key(exactKey, {
        model: DEFAULT_OPENAI_RESPONSES_CUSTOM_TOOL_MODEL_ID,
      });
    }
    return key(exactKey);
  }

  const modelNotSupported = message.match(
    /^Model "(.+)" is not available on your current plan\. Change your model in profile settings\.$/,
  );
  if (modelNotSupported) {
    return key("errors.turn.modelNotSupported", {
      model: modelNotSupported[1]!,
    });
  }

  return (
    describeResponsesContractMessage(message) ??
    describeLocalRuntimeUpdateMessage(message) ??
    describeUsageLimitMessage(message) ??
    describeLmStudioPromptTemplateMessage(message) ??
    describeHttpPrefixMessage(message) ??
    raw(message)
  );
}

export function describeTurnError(
  error: v2.TurnError,
  context: TurnErrorFormattingContext = {},
): TurnErrorDescriptor {
  return describeFormattedTurnError(formatTurnErrorEnglish(error, context));
}

export function formatTurnError(
  error: v2.TurnError,
  context: TurnErrorFormattingContext = {},
): string {
  return formatTurnErrorDescriptor(describeTurnError(error, context));
}

export function isTurnErrorDescriptorKey(
  descriptor: TurnErrorDescriptor,
  keyName: LocaleKey,
): boolean {
  return descriptor.kind === "key" && descriptor.key === keyName;
}

export function isFailedToolItem(item: v2.ThreadItem): boolean {
  return match(item)
    .with(
      { type: "commandExecution", status: P.union("failed", "declined") },
      () => true,
    )
    .with({ type: "mcpToolCall", status: "failed" }, () => true)
    .with(
      { type: "fileChange", status: P.union("failed", "declined") },
      () => true,
    )
    .with({ type: "collabAgentToolCall", status: "failed" }, () => true)
    .otherwise(() => false);
}

export type ToolOutcome =
  | { kind: "completed" }
  | { kind: "nonzero_exit"; exitCode: number }
  | { kind: "declined" }
  | { kind: "real_failure"; reason: ToolFailureReason };

export type ToolFailureReason =
  | "process_start_failed"
  | "mcp_failed"
  | "file_change_failed"
  | "collab_agent_failed";

// Classifies a finished tool item for telemetry. The UI's `isFailedToolItem`
// stays binary so non-zero exits still render as "failed-looking" output to the
// user; this helper exists so telemetry can separate genuine tool breakage
// (process couldn't launch, MCP server errored, etc.) from agent-driven
// non-zero exits where the tool worked fine and the agent will read the output
// and decide what to do next.
export function classifyToolOutcome(item: v2.ThreadItem): ToolOutcome {
  if (item.type === "commandExecution") {
    if (item.status === "declined") return { kind: "declined" };
    if (item.status === "failed") {
      // exitCode === null means the process never produced an exit (couldn't
      // launch, sandbox refused, guardian timeout). exitCode set to a number
      // means the command ran and returned non-zero — agent gets the output.
      if (item.exitCode === null || item.exitCode === undefined) {
        return { kind: "real_failure", reason: "process_start_failed" };
      }
      return { kind: "nonzero_exit", exitCode: item.exitCode };
    }
    return { kind: "completed" };
  }
  if (item.type === "mcpToolCall") {
    return item.status === "failed"
      ? { kind: "real_failure", reason: "mcp_failed" }
      : { kind: "completed" };
  }
  if (item.type === "fileChange") {
    if (item.status === "declined") return { kind: "declined" };
    if (item.status === "failed") {
      return { kind: "real_failure", reason: "file_change_failed" };
    }
    return { kind: "completed" };
  }
  if (item.type === "collabAgentToolCall") {
    return item.status === "failed"
      ? { kind: "real_failure", reason: "collab_agent_failed" }
      : { kind: "completed" };
  }
  return { kind: "completed" };
}
