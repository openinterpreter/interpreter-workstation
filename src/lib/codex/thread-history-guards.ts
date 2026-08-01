import type { v2 } from "../../../server/handlers/codex-generated-types/index";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === "string";
}

function isThreadItemType(value: unknown): value is v2.ThreadItem["type"] {
  return (
    value === "userMessage" ||
    value === "agentMessage" ||
    value === "reasoning" ||
    value === "plan" ||
    value === "commandExecution" ||
    value === "fileChange" ||
    value === "mcpToolCall" ||
    value === "collabAgentToolCall" ||
    value === "webSearch" ||
    value === "imageView" ||
    value === "enteredReviewMode" ||
    value === "exitedReviewMode" ||
    value === "contextCompaction"
  );
}

function isThreadItem(value: unknown): value is v2.ThreadItem {
  if (!isRecord(value)) return false;
  if (!hasString(value, "id")) return false;
  return isThreadItemType(value.type);
}

function isTurn(value: unknown): value is v2.Turn {
  if (!isRecord(value)) return false;
  if (!hasString(value, "id")) return false;
  if (!Array.isArray(value.items) || !value.items.every(isThreadItem)) return false;
  return (
    value.status === "inProgress" ||
    value.status === "completed" ||
    value.status === "interrupted" ||
    value.status === "failed"
  );
}

function isThread(value: unknown): value is v2.Thread {
  if (!isRecord(value)) return false;
  if (!hasString(value, "id")) return false;
  if (!hasString(value, "preview")) return false;
  if (typeof value.createdAt !== "number") return false;
  if (typeof value.updatedAt !== "number") return false;
  if (!Array.isArray(value.turns) || !value.turns.every(isTurn)) return false;
  return true;
}

export function isThreadReadResponse(value: unknown): value is v2.ThreadReadResponse {
  if (!isRecord(value)) return false;
  return isThread(value.thread);
}

export function isThreadListResponse(value: unknown): value is v2.ThreadListResponse {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.data) || !value.data.every(isThread)) return false;
  return value.nextCursor === null || typeof value.nextCursor === "string";
}
