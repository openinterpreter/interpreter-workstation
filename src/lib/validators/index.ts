import type {
  BackgroundTerminalStopRequestBody,
  CreateMcpServerBody,
  OAuthLoginBody,
  SteerRequestBody,
  StopRequestBody,
  StreamRequestBody,
  UpdateMcpServerBody,
} from "../codex/api-types";
import { isReasoningEffort } from "../../../shared/types/reasoning";

type Validator = ((value: unknown) => boolean) & { errors?: unknown };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function setErrors(validator: Validator, errors: unknown): boolean {
  validator.errors = errors;
  return errors === null;
}

const validateThreadStarted: Validator = (data: unknown): boolean => {
  if (!isObject(data) || !isObject(data.thread)) {
    return setErrors(validateThreadStarted, [{ message: "invalid thread/started params" }]);
  }

  const thread = data.thread;
  const valid =
    typeof thread.id === "string" &&
    typeof thread.preview === "string" &&
    typeof thread.modelProvider === "string" &&
    typeof thread.createdAt === "number" &&
    typeof thread.updatedAt === "number" &&
    Array.isArray(thread.turns) &&
    typeof thread.cwd === "string" &&
    typeof thread.cliVersion === "string" &&
    typeof thread.source === "string" &&
    (thread.path === null || typeof thread.path === "string");

  if (!valid) {
    return setErrors(validateThreadStarted, [{ message: "invalid thread/started params" }]);
  }

  return setErrors(validateThreadStarted, null);
};

const validateTurnStarted: Validator = (data: unknown): boolean => {
  if (!isObject(data) || typeof data.threadId !== "string" || !isObject(data.turn)) {
    return setErrors(validateTurnStarted, [{ message: "invalid turn/started params" }]);
  }

  const turn = data.turn;
  const valid =
    typeof turn.id === "string" &&
    Array.isArray(turn.items) &&
    typeof turn.status === "string" &&
    (!hasOwn(turn, "error") || turn.error === null || isObject(turn.error));

  if (!valid) {
    return setErrors(validateTurnStarted, [{ message: "invalid turn/started params" }]);
  }

  return setErrors(validateTurnStarted, null);
};

const validateTurnCompleted: Validator = (data: unknown): boolean => {
  if (!isObject(data) || typeof data.threadId !== "string" || !isObject(data.turn)) {
    return setErrors(validateTurnCompleted, [{ message: "invalid turn/completed params" }]);
  }

  const turn = data.turn;
  const valid =
    typeof turn.id === "string" &&
    Array.isArray(turn.items) &&
    typeof turn.status === "string" &&
    (!hasOwn(turn, "error") || turn.error === null || isObject(turn.error));

  if (!valid) {
    return setErrors(validateTurnCompleted, [{ message: "invalid turn/completed params" }]);
  }

  return setErrors(validateTurnCompleted, null);
};

const validateItemStarted: Validator = (data: unknown): boolean => {
  const valid =
    isObject(data) &&
    typeof data.threadId === "string" &&
    typeof data.turnId === "string" &&
    isObject(data.item) &&
    typeof data.item.id === "string" &&
    typeof data.item.type === "string";

  if (!valid) {
    return setErrors(validateItemStarted, [{ message: "invalid item/started params" }]);
  }

  return setErrors(validateItemStarted, null);
};

const validateItemCompleted: Validator = (data: unknown): boolean => {
  const valid =
    isObject(data) &&
    typeof data.threadId === "string" &&
    typeof data.turnId === "string" &&
    isObject(data.item) &&
    typeof data.item.id === "string" &&
    typeof data.item.type === "string";

  if (!valid) {
    return setErrors(validateItemCompleted, [{ message: "invalid item/completed params" }]);
  }

  return setErrors(validateItemCompleted, null);
};

const validateError: Validator = (data: unknown): boolean => {
  const valid =
    isObject(data) &&
    typeof data.threadId === "string" &&
    typeof data.turnId === "string" &&
    typeof data.willRetry === "boolean" &&
    isObject(data.error) &&
    typeof data.error.message === "string";

  if (!valid) {
    return setErrors(validateError, [{ message: "invalid error params" }]);
  }

  return setErrors(validateError, null);
};

const LIFECYCLE_VALIDATORS: Record<string, Validator> = {
  "thread/started": validateThreadStarted,
  "turn/started": validateTurnStarted,
  "turn/completed": validateTurnCompleted,
  "item/started": validateItemStarted,
  "item/completed": validateItemCompleted,
  error: validateError,
};

export function isValidLifecycleNotification(
  method: string,
  params: unknown,
): boolean {
  const validator = LIFECYCLE_VALIDATORS[method];
  if (!validator) {
    return true;
  }
  const valid = validator(params);
  if (!valid) {
    console.warn(
      `Invalid lifecycle notification params for ${method}:`,
      validator.errors,
    );
  }
  return valid;
}

export function isValidJsonRpcResponse(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (!(typeof value.id === "number" || typeof value.id === "string")) return false;
  return hasOwn(value, "result") || hasOwn(value, "error");
}

export function isValidNotificationShape(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "method" in value &&
    typeof (value as Record<string, unknown>).method === "string" &&
    !("id" in value)
  );
}

export function isServerRequestShape(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    "method" in value &&
    typeof (value as Record<string, unknown>).method === "string" &&
    !("result" in value) &&
    !("error" in value)
  );
}

function isValidAttachment(value: unknown): boolean {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 5) return false;
  if (value.kind !== "image") return false;

  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.mimeType === "string" &&
    typeof value.dataUrl === "string"
  );
}

function isValidSkillReference(value: unknown): boolean {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 4) return false;

  return (
    typeof value.id === "string" &&
    typeof value.label === "string" &&
    typeof value.name === "string" &&
    typeof value.path === "string"
  );
}

export function validateStreamRequestBody(
  data: unknown,
): data is StreamRequestBody {
  if (!isObject(data)) {
    console.warn("Invalid StreamRequestBody:", [{ message: "must be object" }]);
    return false;
  }

  const allowedKeys = new Set([
    "agentId",
    "callerToken",
    "message",
    "system",
    "threadId",
    "workspacePath",
    "model",
    "profileId",
    "codexProfileId",
    "customEndpoint",
    "customApiKey",
    "reasoningEffort",
    "attachments",
    "skills",
  ]);

  for (const key of Object.keys(data)) {
    if (!allowedKeys.has(key)) {
      console.warn("Invalid StreamRequestBody:", [{ message: `unexpected property: ${key}` }]);
      return false;
    }
  }

  if (hasOwn(data, "message") && typeof data.message !== "string") {
    console.warn("Invalid StreamRequestBody:", [{ message: "message must be string" }]);
    return false;
  }

  if (hasOwn(data, "system") && typeof data.system !== "string") {
    console.warn("Invalid StreamRequestBody:", [{ message: "system must be string" }]);
    return false;
  }

  if (hasOwn(data, "threadId") && data.threadId !== null && typeof data.threadId !== "string") {
    console.warn("Invalid StreamRequestBody:", [{ message: "threadId must be string or null" }]);
    return false;
  }

  if (hasOwn(data, "workspacePath") && data.workspacePath !== null && typeof data.workspacePath !== "string") {
    console.warn("Invalid StreamRequestBody:", [{ message: "workspacePath must be string or null" }]);
    return false;
  }

  const stringKeys = ["agentId", "callerToken", "model", "profileId", "codexProfileId", "customEndpoint", "customApiKey"] as const;
  for (const key of stringKeys) {
    if (hasOwn(data, key) && typeof data[key] !== "string") {
      console.warn("Invalid StreamRequestBody:", [{ message: `${key} must be string` }]);
      return false;
    }
  }

  if (hasOwn(data, "reasoningEffort") && !isReasoningEffort(data.reasoningEffort)) {
    console.warn("Invalid StreamRequestBody:", [{ message: "reasoningEffort must be a supported level" }]);
    return false;
  }

  if (hasOwn(data, "attachments")) {
    if (!Array.isArray(data.attachments) || !data.attachments.every(isValidAttachment)) {
      console.warn("Invalid StreamRequestBody:", [{ message: "attachments must be valid image payloads" }]);
      return false;
    }
  }

  if (hasOwn(data, "skills")) {
    if (!Array.isArray(data.skills) || !data.skills.every(isValidSkillReference)) {
      console.warn("Invalid StreamRequestBody:", [{ message: "skills must be valid skill references" }]);
      return false;
    }
  }

  return true;
}

export function validateStopRequestBody(
  data: unknown,
): data is StopRequestBody {
  if (!isObject(data)) {
    console.warn("Invalid StopRequestBody:", [{ message: "must be object" }]);
    return false;
  }

  const allowedKeys = new Set(["threadId", "turnId"]);
  for (const key of Object.keys(data)) {
    if (!allowedKeys.has(key)) {
      console.warn("Invalid StopRequestBody:", [{ message: `unexpected property: ${key}` }]);
      return false;
    }
  }

  if (typeof data.threadId !== "string") {
    console.warn("Invalid StopRequestBody:", [{ message: "threadId must be string" }]);
    return false;
  }

  if (hasOwn(data, "turnId") && typeof data.turnId !== "string") {
    console.warn("Invalid StopRequestBody:", [{ message: "turnId must be string" }]);
    return false;
  }

  return true;
}

export function validateSteerRequestBody(
  data: unknown,
): data is SteerRequestBody {
  if (!isObject(data)) {
    console.warn("Invalid SteerRequestBody:", [{ message: "must be object" }]);
    return false;
  }

  const allowedKeys = new Set(["threadId", "turnId", "message", "attachments", "skills"]);
  for (const key of Object.keys(data)) {
    if (!allowedKeys.has(key)) {
      console.warn("Invalid SteerRequestBody:", [{ message: `unexpected property: ${key}` }]);
      return false;
    }
  }

  if (typeof data.threadId !== "string") {
    console.warn("Invalid SteerRequestBody:", [{ message: "threadId must be string" }]);
    return false;
  }

  if (typeof data.turnId !== "string") {
    console.warn("Invalid SteerRequestBody:", [{ message: "turnId must be string" }]);
    return false;
  }

  const hasMessage = typeof data.message === "string" && data.message.trim().length > 0;
  const hasAttachments = Array.isArray(data.attachments) && data.attachments.length > 0;
  const hasSkills = Array.isArray(data.skills) && data.skills.length > 0;
  if (!hasMessage && !hasAttachments && !hasSkills) {
    console.warn("Invalid SteerRequestBody:", [{ message: "message, attachments, or skills is required" }]);
    return false;
  }

  if (hasOwn(data, "message") && typeof data.message !== "string") {
    console.warn("Invalid SteerRequestBody:", [{ message: "message must be string" }]);
    return false;
  }

  if (hasOwn(data, "attachments")) {
    if (!Array.isArray(data.attachments) || !data.attachments.every(isValidAttachment)) {
      console.warn("Invalid SteerRequestBody:", [{ message: "attachments must be valid image payloads" }]);
      return false;
    }
  }

  if (hasOwn(data, "skills")) {
    if (!Array.isArray(data.skills) || !data.skills.every(isValidSkillReference)) {
      console.warn("Invalid SteerRequestBody:", [{ message: "skills must be valid skill references" }]);
      return false;
    }
  }

  return true;
}

export function validateBackgroundTerminalStopRequestBody(
  data: unknown,
): data is BackgroundTerminalStopRequestBody {
  if (!isObject(data)) {
    console.warn("Invalid BackgroundTerminalStopRequestBody:", [{ message: "must be object" }]);
    return false;
  }

  const allowedKeys = new Set(["threadId"]);
  for (const key of Object.keys(data)) {
    if (!allowedKeys.has(key)) {
      console.warn("Invalid BackgroundTerminalStopRequestBody:", [{ message: `unexpected property: ${key}` }]);
      return false;
    }
  }

  if (typeof data.threadId !== "string") {
    console.warn("Invalid BackgroundTerminalStopRequestBody:", [{ message: "threadId must be string" }]);
    return false;
  }

  return true;
}

function validateSharedConfig(config: Record<string, unknown>): boolean {
  if (hasOwn(config, "enabled") && typeof config.enabled !== "boolean") return false;
  if (hasOwn(config, "required") && typeof config.required !== "boolean") return false;
  if (hasOwn(config, "startupTimeoutSec") && typeof config.startupTimeoutSec !== "number") return false;
  if (hasOwn(config, "toolTimeoutSec") && typeof config.toolTimeoutSec !== "number") return false;
  if (
    hasOwn(config, "defaultToolsApprovalMode")
    && config.defaultToolsApprovalMode !== "auto"
    && config.defaultToolsApprovalMode !== "prompt"
    && config.defaultToolsApprovalMode !== "approve"
  ) return false;
  if (hasOwn(config, "tools")) {
    if (!isObject(config.tools)) return false;
    for (const toolConfig of Object.values(config.tools)) {
      if (!isObject(toolConfig)) return false;
      for (const key of Object.keys(toolConfig)) {
        if (key !== "approvalMode") return false;
      }
      if (
        hasOwn(toolConfig, "approvalMode")
        && toolConfig.approvalMode !== "auto"
        && toolConfig.approvalMode !== "prompt"
        && toolConfig.approvalMode !== "approve"
      ) return false;
    }
  }
  if (hasOwn(config, "enabledTools") && !isStringArray(config.enabledTools)) return false;
  if (hasOwn(config, "disabledTools") && !isStringArray(config.disabledTools)) return false;
  if (hasOwn(config, "scopes") && !isStringArray(config.scopes)) return false;
  return true;
}

function validateStdioConfig(config: Record<string, unknown>): boolean {
  const allowed = new Set([
    "transport",
    "command",
    "args",
    "env",
    "envVars",
    "cwd",
    "enabled",
    "required",
    "startupTimeoutSec",
    "toolTimeoutSec",
    "defaultToolsApprovalMode",
    "tools",
    "enabledTools",
    "disabledTools",
    "scopes",
  ]);

  for (const key of Object.keys(config)) {
    if (!allowed.has(key)) return false;
  }

  if (config.transport !== "stdio") return false;
  if (typeof config.command !== "string") return false;
  if (hasOwn(config, "args") && !isStringArray(config.args)) return false;
  if (hasOwn(config, "env") && !isStringRecord(config.env)) return false;
  if (hasOwn(config, "envVars") && !isStringArray(config.envVars)) return false;
  if (hasOwn(config, "cwd") && typeof config.cwd !== "string") return false;

  return validateSharedConfig(config);
}

function validateHttpConfig(config: Record<string, unknown>): boolean {
  const allowed = new Set([
    "transport",
    "url",
    "oauthResource",
    "bearerTokenEnvVar",
    "httpHeaders",
    "envHttpHeaders",
    "enabled",
    "required",
    "startupTimeoutSec",
    "toolTimeoutSec",
    "defaultToolsApprovalMode",
    "tools",
    "enabledTools",
    "disabledTools",
    "scopes",
  ]);

  for (const key of Object.keys(config)) {
    if (!allowed.has(key)) return false;
  }

  if (config.transport !== "streamable_http") return false;
  if (typeof config.url !== "string") return false;
  if (hasOwn(config, "oauthResource") && typeof config.oauthResource !== "string") return false;
  if (hasOwn(config, "bearerTokenEnvVar") && typeof config.bearerTokenEnvVar !== "string") return false;
  if (hasOwn(config, "httpHeaders") && !isStringRecord(config.httpHeaders)) return false;
  if (hasOwn(config, "envHttpHeaders") && !isStringRecord(config.envHttpHeaders)) return false;

  return validateSharedConfig(config);
}

function validateMcpConfig(config: unknown): boolean {
  if (!isObject(config)) return false;
  return validateStdioConfig(config) || validateHttpConfig(config);
}

export function validateCreateMcpServerBody(
  data: unknown,
): data is CreateMcpServerBody {
  if (!isObject(data)) {
    console.warn("Invalid CreateMcpServerBody:", [{ message: "must be object" }]);
    return false;
  }

  const allowed = new Set(["name", "config"]);
  for (const key of Object.keys(data)) {
    if (!allowed.has(key)) {
      console.warn("Invalid CreateMcpServerBody:", [{ message: `unexpected property: ${key}` }]);
      return false;
    }
  }

  if (typeof data.name !== "string" || !/^[a-zA-Z0-9_-]+$/.test(data.name)) {
    console.warn("Invalid CreateMcpServerBody:", [{ message: "name must match pattern" }]);
    return false;
  }

  const valid = validateMcpConfig(data.config);
  if (!valid) {
    console.warn("Invalid CreateMcpServerBody:", [{ message: "invalid config" }]);
  }
  return valid;
}

export function validateUpdateMcpServerBody(
  data: unknown,
): data is UpdateMcpServerBody {
  const valid = validateMcpConfig(data);
  if (!valid) {
    console.warn("Invalid UpdateMcpServerBody:", [{ message: "invalid config" }]);
  }
  return valid;
}

export function validateOAuthLoginBody(
  data: unknown,
): data is OAuthLoginBody {
  if (!isObject(data)) {
    console.warn("Invalid OAuthLoginBody:", [{ message: "must be object" }]);
    return false;
  }

  const allowed = new Set(["scopes"]);
  for (const key of Object.keys(data)) {
    if (!allowed.has(key)) {
      console.warn("Invalid OAuthLoginBody:", [{ message: `unexpected property: ${key}` }]);
      return false;
    }
  }

  if (hasOwn(data, "scopes") && !isStringArray(data.scopes)) {
    console.warn("Invalid OAuthLoginBody:", [{ message: "scopes must be string[]" }]);
    return false;
  }

  return true;
}
