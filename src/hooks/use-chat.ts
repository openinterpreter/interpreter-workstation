"use client";

import { createParser, type EventSourceMessage } from "eventsource-parser";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  StreamImageAttachment,
  StreamSkillReference,
  StreamRequestBody,
} from "@/lib/codex/api-types";
import { getApiUrl, runtime } from "@/ipc";
import {
  clearLiveToolCallsForIds,
  setLiveToolCall,
} from "@/stores/liveItemsStore";
import { playSound } from "@/utils/sounds";
import {
  applyMarketingDemoScenario,
  buildMarketingDemoAssistantReply,
  createMarketingDemoThread,
  getMarketingDemoScenario,
  getMarketingDemoTranscript,
  isMarketingDemoMode,
  saveMarketingDemoTranscript,
  type MarketingDemoScenarioDefinition,
  type MarketingDemoToolCallDescriptor,
  type MarketingDemoTranscriptMessage,
} from "../demo/marketingDemo";
import {
  trackMessageSent,
  trackResponseReceived,
  trackResponseError,
  trackResponseStopped,
  trackFirstSuccessfulInteraction,
  trackAgentTurnCompleted,
  trackToolCalled,
  trackToolCompleted,
  trackToolFailed,
  type AgentTurnEndReason,
} from "@/utils/telemetry";
import { setActiveProfile } from "@/utils/telemetryContext";
import { tr } from "@/i18n";
import { classifyToolOutcome } from "@/lib/codex/errors";
import { parseToolName } from "../../shared/utils/mcpToolName";
import type { SseStreamEvent } from "@/lib/codex/event-mapper";
import { isThreadReadResponse } from "@/lib/codex/thread-history-guards";
import { mapThreadToChatMessages } from "@/lib/codex/thread-history-mapper";
import type { v2 } from "../../server/handlers/codex-generated-types/index";
import {
  applyChatEvent,
  createInitialChatState,
  settleMessageToolCalls,
  type ChatState,
} from "./use-chat-reducer";
import { logUserVisibleError } from "@/utils/userVisibleErrorLog";
import type { MessageSendSource } from "../../shared/types/messageSendSource";
import { extractSkillMentionsFromText } from "../../shared/utils/skillMentions";
import { stripWorkstationContext } from "../../shared/utils/formatWorkstationContext";

export type ToolCallInfo = {
  id: string;
  type: v2.ThreadItem["type"];
  label: string;
  state: "loading" | "complete" | "error";
  item?: v2.ThreadItem;
  startedAt?: number;
  completedAt?: number;
  processId?: string | null;
  backgroundState?: "waiting" | "interacted";
  backgroundInput?: string;
  details?: string;
  output?: string;
  verb?: { active: string; past: string };
  target?: string;
  filePath?: string;
  sourceInput?: string;
  sourceToolName?: string;
  reasoningSummaryIndex?: number;
};

export type ChatMessagePart =
  | { kind: "text"; content: string }
  | { kind: "tool-call"; toolCall: ToolCallInfo };

const RUNTIME_RESTART_CONTINUE_MESSAGE =
  "Continue the previous task now that Interpreter restarted. Continue from where you left off and verify the MCP/tool changes are available.";
const RUNTIME_RESTART_CONTINUATION_STORAGE_PREFIX =
  "interpreter.runtimeRestartContinuation:";

type RuntimeRestartContinuationStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

export function textContent(msg: { parts: ChatMessagePart[] }): string {
  return msg.parts
    .filter(
      (p): p is Extract<ChatMessagePart, { kind: "text" }> => p.kind === "text",
    )
    .map((p) => p.content)
    .join("");
}

function isRuntimeRestartContinuationText(text: string): boolean {
  return text.trim() === RUNTIME_RESTART_CONTINUE_MESSAGE;
}

export function runtimeRestartContinuationStorageKey(threadId: string): string {
  return `${RUNTIME_RESTART_CONTINUATION_STORAGE_PREFIX}${threadId}`;
}

function getRuntimeRestartContinuationStorage(): RuntimeRestartContinuationStorage | null {
  if (typeof window === "undefined") {
    return null;
  }
  return window.sessionStorage;
}

async function requestBackgroundProcessStopForThread(
  threadId: string | null | undefined,
): Promise<void> {
  if (!threadId) {
    return;
  }

  const stopUrl = await getApiUrl("/api/agent/chat/background/stop");
  const response = await fetch(stopUrl, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threadId }),
  });

  if (!response.ok) {
    const message = await response.text();
    if (!message.includes("thread not found")) {
      throw new Error("Failed to stop background processes.");
    }
  }
}

export function rememberRuntimeRestartContinuation(
  threadId: string | null | undefined,
  storage: RuntimeRestartContinuationStorage | null = getRuntimeRestartContinuationStorage(),
): void {
  if (!threadId || !storage) {
    return;
  }
  storage.setItem(
    runtimeRestartContinuationStorageKey(threadId),
    String(Date.now()),
  );
}

export function hasRuntimeRestartContinuation(
  threadId: string | null | undefined,
  storage: RuntimeRestartContinuationStorage | null = getRuntimeRestartContinuationStorage(),
): boolean {
  if (!threadId || !storage) {
    return false;
  }
  return (
    storage.getItem(runtimeRestartContinuationStorageKey(threadId)) !== null
  );
}

export function forgetRuntimeRestartContinuation(
  threadId: string | null | undefined,
  storage: RuntimeRestartContinuationStorage | null = getRuntimeRestartContinuationStorage(),
): void {
  if (!threadId || !storage) {
    return;
  }
  storage.removeItem(runtimeRestartContinuationStorageKey(threadId));
}

export function isHiddenRuntimeContinuationMessage(message: {
  role: string;
  parts: ChatMessagePart[];
}): boolean {
  return (
    message.role === "user" &&
    isRuntimeRestartContinuationText(textContent(message))
  );
}

export function msgToolCalls(msg: {
  parts: ChatMessagePart[];
}): ToolCallInfo[] {
  return msg.parts
    .filter(
      (p): p is Extract<ChatMessagePart, { kind: "tool-call" }> =>
        p.kind === "tool-call",
    )
    .map((p) => p.toolCall);
}

export function hasToolCalls(msg: { parts: ChatMessagePart[] }): boolean {
  return msg.parts.some((p) => p.kind === "tool-call");
}

function logChatError(
  message: string,
  options?: {
    details?: string | null;
    endpointBaseUrl?: string | null;
    model?: string | null;
    profileId?: string | null;
    threadId?: string | null;
    turnId?: string | null;
  },
): void {
  logUserVisibleError("chat", {
    message,
    details: options?.details ?? null,
    endpointBaseUrl: options?.endpointBaseUrl ?? null,
    model: options?.model ?? null,
    profileId: options?.profileId ?? null,
    threadId: options?.threadId ?? null,
    turnId: options?.turnId ?? null,
  });
}

function getActiveTurnIdForErrorLogging(
  state: ChatState,
  draft: ChatMessage | null,
): string | null {
  return draft?.serverMessageId ?? state.draft?.serverMessageId ?? null;
}

export function draftHasVisibleContent(draft: ChatMessage | null): boolean {
  if (!draft) return false;
  if (textContent(draft).trim().length > 0) return true;
  if (draft.parts.some((p) => p.kind === "tool-call")) return true;
  return false;
}

export function finalizeVisibleDraftMessage(
  draft: ChatMessage | null,
): ChatMessage | null {
  if (!draft || !draftHasVisibleContent(draft)) {
    return null;
  }
  return settleMessageToolCalls(draft);
}

export function appendVisibleDraftMessage(
  messages: ChatMessage[],
  draft: ChatMessage | null,
): ChatMessage[] {
  const finalDraft = finalizeVisibleDraftMessage(draft);
  if (!finalDraft) {
    return messages;
  }
  if (messages.some((message) => message.id === finalDraft.id)) {
    return messages;
  }
  return [...messages, finalDraft];
}

function clearBackgroundToolCall(toolCall: ToolCallInfo): ToolCallInfo {
  if (toolCall.type !== "commandExecution") {
    return toolCall;
  }

  const item =
    toolCall.item?.type === "commandExecution"
      ? { ...toolCall.item, processId: null }
      : toolCall.item;

  return {
    ...toolCall,
    item,
    processId: null,
    backgroundState: undefined,
    backgroundInput: undefined,
  };
}

function stopBackgroundToolCall(toolCall: ToolCallInfo): ToolCallInfo {
  if (toolCall.type !== "commandExecution") {
    return toolCall;
  }

  const cleared = clearBackgroundToolCall(toolCall);
  const item =
    cleared.item?.type === "commandExecution"
      ? {
          ...cleared.item,
          processId: null,
          status: "completed" as const,
        }
      : cleared.item;

  return {
    ...cleared,
    item,
    state: cleared.state === "loading" ? "complete" : cleared.state,
  };
}

export function clearBackgroundProcessesFromMessage(
  message: ChatMessage,
): ChatMessage {
  return clearBackgroundProcessesFromMessageByProcessIds(message);
}

export function clearBackgroundProcessesFromMessageByProcessIds(
  message: ChatMessage,
  processIds?: ReadonlySet<string>,
): ChatMessage {
  if (message.role !== "assistant") {
    return message;
  }

  return {
    ...message,
    parts: message.parts.map((part) => {
      if (part.kind !== "tool-call") {
        return part;
      }

      if (processIds && part.toolCall.type === "commandExecution") {
        const processId =
          typeof part.toolCall.processId === "string"
            ? part.toolCall.processId
            : part.toolCall.item?.type === "commandExecution"
              ? part.toolCall.item.processId
              : null;

        if (!processId || !processIds.has(processId)) {
          return part;
        }
      }

      return {
        kind: "tool-call" as const,
        toolCall: clearBackgroundToolCall(part.toolCall),
      };
    }),
  };
}

function stopToolCallItem(item: NonNullable<ToolCallInfo["item"]>): NonNullable<ToolCallInfo["item"]> {
  const next = { ...item } as NonNullable<ToolCallInfo["item"]> & {
    status?: string;
    processId?: string | null;
  };

  if (next.status === "inProgress") {
    next.status = "completed";
  }

  if (next.type === "commandExecution") {
    next.processId = null;
  }

  return next;
}

function stopLoadingToolCall(toolCall: ToolCallInfo): ToolCallInfo {
  if (toolCall.state !== "loading") {
    return toolCall;
  }

  if (toolCall.type === "commandExecution") {
    return stopBackgroundToolCall({
      ...toolCall,
      item: toolCall.item ? stopToolCallItem(toolCall.item) : toolCall.item,
    });
  }

  return {
    ...toolCall,
    item: toolCall.item ? stopToolCallItem(toolCall.item) : toolCall.item,
    state: "complete",
  };
}

export function stopLoadingToolCallsInMessage(message: ChatMessage): ChatMessage {
  if (message.role !== "assistant") {
    return message;
  }

  let changed = false;
  const parts = message.parts.map((part) => {
    if (part.kind !== "tool-call" || part.toolCall.state !== "loading") {
      return part;
    }

    changed = true;
    return {
      kind: "tool-call" as const,
      toolCall: stopLoadingToolCall(part.toolCall),
    };
  });

  if (!changed) {
    return message;
  }

  return {
    ...message,
    parts,
  };
}

function stopBackgroundToolCallsInMessage(
  message: ChatMessage,
  toolCallIds?: ReadonlySet<string>,
): ChatMessage {
  if (message.role !== "assistant") {
    return message;
  }

  return {
    ...message,
    parts: message.parts.map((part) => {
      if (
        part.kind !== "tool-call" ||
        part.toolCall.type !== "commandExecution"
      ) {
        return part;
      }

      if (toolCallIds && !toolCallIds.has(part.toolCall.id)) {
        return part;
      }

      return {
        kind: "tool-call" as const,
        toolCall: stopBackgroundToolCall(part.toolCall),
      };
    }),
  };
}

// NOTE(victor): Decides whether the final-event text should replace the
// draft's content.  Returns false when the final belongs to a different
// agentMessage item (already committed in a previous split).
export function shouldApplyFinalText(
  finalItemId: string | undefined,
  draftAgentMessageId: string | null,
  draftContent: string,
): boolean {
  if (draftContent.trim()) return false;
  if (
    finalItemId &&
    draftAgentMessageId != null &&
    draftAgentMessageId !== finalItemId
  )
    return false;
  return true;
}

// NOTE(victor): Extracted from handleParsedEvent so reasoning dedup is testable.
export function resolveToolCallIndex(
  existing: ToolCallInfo[],
  itemId: string,
  itemType: string,
): number {
  let idx = existing.findIndex((t) => t.id === itemId);
  if (idx < 0 && itemType === "reasoning") {
    idx = existing.findIndex(
      (t) => t.type === "reasoning" && t.state === "loading",
    );
  }
  return idx;
}

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  parts: ChatMessagePart[];
  serverMessageId?: string;
  attachments?: StreamImageAttachment[];
};

type SendMessageOverrides = {
  workspacePath?: string | null;
  attachments?: StreamImageAttachment[];
  messageSource?: MessageSendSource | null;
  hideUserMessage?: boolean;
};

export type PlanChecklistState = {
  threadId: string;
  turnId: string;
  explanation: string | null;
  steps: Array<{
    step: string;
    status: v2.TurnPlanStepStatus;
  }>;
};

function createTextChatMessage(
  role: "user" | "assistant",
  text: string,
  id: string = crypto.randomUUID(),
): ChatMessage {
  return {
    id,
    role,
    parts: [{ kind: "text", content: text }],
    attachments: [],
  };
}

function marketingDemoTranscriptToChatMessages(
  transcript: MarketingDemoTranscriptMessage[],
): ChatMessage[] {
  return transcript.map((message) => {
    if (!message.parts?.length) {
      return createTextChatMessage(message.role, message.text, message.id);
    }

    return {
      id: message.id,
      role: message.role,
      parts: message.parts.map(
        (part): ChatMessagePart =>
          part.kind === "text"
            ? { kind: "text", content: part.content }
            : {
                kind: "tool-call",
                toolCall: {
                  id: part.toolCall.id,
                  type: part.toolCall.type as ToolCallInfo["type"],
                  label: part.toolCall.label,
                  state: part.toolCall.state,
                  details: part.toolCall.details,
                  output: part.toolCall.output,
                  filePath: part.toolCall.filePath,
                  target: part.toolCall.target,
                },
              },
      ),
    };
  });
}

export function createMarketingDemoTranscriptMessage(
  message: ChatMessage,
): MarketingDemoTranscriptMessage {
  return {
    id: message.id,
    role: message.role,
    text: textContent(message),
    parts: message.parts.map((part) =>
      part.kind === "text"
        ? { kind: "text" as const, content: part.content }
        : {
            kind: "tool-call" as const,
            toolCall: {
              id: part.toolCall.id,
              type: part.toolCall.type,
              label: part.toolCall.label,
              state: part.toolCall.state,
              details: part.toolCall.details,
              output: part.toolCall.output,
              filePath: part.toolCall.filePath,
              target: part.toolCall.target,
            },
          },
    ),
  };
}

function createMarketingDemoToolCallInfo(
  toolCall: MarketingDemoToolCallDescriptor,
  messageId: string,
  state: ToolCallInfo["state"],
): ToolCallInfo {
  return {
    id: `${messageId}-${toolCall.id}`,
    type: toolCall.type,
    label: toolCall.label,
    state,
    details: toolCall.details,
    output: toolCall.output,
    filePath: toolCall.filePath,
    target: toolCall.target,
  };
}

function createMarketingDemoReasoningToolCall(
  messageId: string,
  label: string,
  state: ToolCallInfo["state"],
): ToolCallInfo {
  return {
    id: `${messageId}-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    type: "reasoning",
    label,
    state,
  };
}

function createMarketingDemoReasoningDraft(
  messageId: string,
  label: string,
  state: ToolCallInfo["state"] = "loading",
): ChatMessage {
  return {
    id: messageId,
    role: "assistant",
    parts: [
      {
        kind: "tool-call",
        toolCall: createMarketingDemoReasoningToolCall(messageId, label, state),
      },
    ],
  };
}

function createMarketingDemoScenarioMessage(params: {
  messageId: string;
  scenario: MarketingDemoScenarioDefinition;
  activeToolCallIndex?: number;
  includeFinalText?: boolean;
  includeReasoningLabel?: string | null;
}): ChatMessage {
  const parts: ChatMessagePart[] = [];
  if (params.includeReasoningLabel) {
    parts.push({
      kind: "tool-call",
      toolCall: createMarketingDemoReasoningToolCall(
        params.messageId,
        params.includeReasoningLabel,
        params.includeFinalText ? "complete" : "loading",
      ),
    });
  }

  const maxToolIndex = params.includeFinalText
    ? params.scenario.toolCalls.length - 1
    : (params.activeToolCallIndex ?? -1);
  const visibleToolCalls =
    maxToolIndex >= 0
      ? params.scenario.toolCalls.slice(0, maxToolIndex + 1)
      : [];
  parts.push(
    ...visibleToolCalls.map((toolCall, index) => ({
      kind: "tool-call" as const,
      toolCall: createMarketingDemoToolCallInfo(
        toolCall,
        params.messageId,
        params.includeFinalText || index < maxToolIndex
          ? "complete"
          : "loading",
      ),
    })),
  );

  if (params.includeFinalText) {
    parts.push({
      kind: "text",
      content: params.scenario.replyText,
    });
  }

  return {
    id: params.messageId,
    role: "assistant",
    parts,
  };
}

function splitMarketingDemoReplyIntoChunks(text: string): string[] {
  if (text.length <= 18) {
    return [text];
  }

  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const targetEnd = Math.min(text.length, cursor + 22);
    const nextWhitespace = text.lastIndexOf(" ", targetEnd);
    const end = nextWhitespace > cursor + 8 ? nextWhitespace : targetEnd;
    chunks.push(text.slice(cursor, end));
    cursor = end;
  }

  return chunks.filter((chunk) => chunk.length > 0);
}

function toolCallInfoEqual(a: ToolCallInfo, b: ToolCallInfo): boolean {
  return (
    a.id === b.id &&
    a.type === b.type &&
    a.label === b.label &&
    a.state === b.state &&
    a.details === b.details &&
    a.output === b.output &&
    a.target === b.target &&
    a.filePath === b.filePath &&
    a.sourceInput === b.sourceInput &&
    a.sourceToolName === b.sourceToolName &&
    a.reasoningSummaryIndex === b.reasoningSummaryIndex &&
    a.verb?.active === b.verb?.active &&
    a.verb?.past === b.verb?.past
  );
}

function chatMessagePartsEqual(
  a: ChatMessagePart[],
  b: ChatMessagePart[],
): boolean {
  if (a.length !== b.length) {
    return false;
  }

  for (let index = 0; index < a.length; index += 1) {
    const left = a[index]!;
    const right = b[index]!;
    if (left.kind !== right.kind) {
      return false;
    }
    if (left.kind === "text" && right.kind === "text") {
      if (left.content !== right.content) {
        return false;
      }
      continue;
    }
    if (left.kind === "tool-call" && right.kind === "tool-call") {
      if (!toolCallInfoEqual(left.toolCall, right.toolCall)) {
        return false;
      }
    }
  }

  return true;
}

function chatMessagesEqual(a: ChatMessage, b: ChatMessage): boolean {
  return (
    a.id === b.id &&
    a.role === b.role &&
    a.serverMessageId === b.serverMessageId &&
    JSON.stringify(a.attachments ?? []) ===
      JSON.stringify(b.attachments ?? []) &&
    chatMessagePartsEqual(a.parts, b.parts)
  );
}

export function mergeCommittedAssistantMessages(
  timelineMessages: ChatMessage[],
  committedAssistantMessages: ChatMessage[],
): ChatMessage[] {
  if (committedAssistantMessages.length === 0) {
    return timelineMessages;
  }

  const committedById = new Map(
    committedAssistantMessages.map((message) => [message.id, message]),
  );
  let changed = false;

  const nextTimeline = timelineMessages.map((message) => {
    const committed = committedById.get(message.id);
    if (!committed) {
      return message;
    }
    if (chatMessagesEqual(message, committed)) {
      return message;
    }
    changed = true;
    return { ...committed };
  });

  const existingIds = new Set(nextTimeline.map((message) => message.id));
  const appendedMessages = committedAssistantMessages
    .filter((message) => !existingIds.has(message.id))
    .map((message) => ({ ...message }));

  if (appendedMessages.length === 0) {
    return changed ? nextTimeline : timelineMessages;
  }

  return [...(changed ? nextTimeline : timelineMessages), ...appendedMessages];
}

export type UseChatReturn = {
  messages: ChatMessage[];
  streamingMessage: ChatMessage | null;
  planChecklist: PlanChecklistState | null;
  historyLoaded: boolean;
  hasOlderHistory: boolean;
  loadingOlderHistory: boolean;
  loadOlderHistory: () => Promise<void>;
  isStreaming: boolean;
  error: string | null;
  errorDetails: string | null;
  errorEndpointBaseUrl: string | null;
  retrying: string | null;
  input: string;
  setInput: (value: string) => void;
  showError: (
    message: string,
    options?: { details?: string | null; endpointBaseUrl?: string | null },
  ) => void;
  sendMessage: (
    messageOverride?: string,
    overrides?: SendMessageOverrides,
  ) => void;
  stopGeneration: () => void;
  stopBackgroundProcess: (toolCallIds?: string[]) => Promise<void>;
  threadId: string | null;
};

export type UseChatOptions = {
  agentId: string;
  callerToken: string;
  model?: string;
  codexProfileId?: string;
  customEndpoint?: string;
  customApiKey?: string;
  reasoningEffort?: import("../../shared/types/reasoning").ReasoningEffort;
  initialThreadId?: string;
  workspacePath?: string | null;
  system?: string;
  onCommittedUserMessage?: (message: {
    itemId: string;
    text: string;
  }) => boolean;
};

type ThreadHistoryPageMetadata = {
  nextCursor: string | null;
  hasMore: boolean;
};

function readThreadHistoryPageMetadata(value: unknown): ThreadHistoryPageMetadata {
  if (typeof value !== 'object' || value === null) {
    return { nextCursor: null, hasMore: false };
  }
  const page = (value as { historyPage?: unknown }).historyPage;
  if (typeof page !== 'object' || page === null) {
    return { nextCursor: null, hasMore: false };
  }
  const nextCursor = (page as { nextCursor?: unknown }).nextCursor;
  const hasMore = (page as { hasMore?: unknown }).hasMore;
  return {
    nextCursor: typeof nextCursor === 'string' ? nextCursor : null,
    hasMore: hasMore === true,
  };
}

export function mergeChatHistory(
  current: ChatMessage[],
  incoming: ChatMessage[],
  direction: 'older' | 'newer',
): ChatMessage[] {
  const incomingById = new Map(incoming.map((message) => [message.id, message]));
  const updatedCurrent = current.map((message) => incomingById.get(message.id) ?? message);
  const currentIds = new Set(current.map((message) => message.id));
  const additions = incoming.filter((message) => !currentIds.has(message.id));
  return direction === 'older'
    ? [...additions, ...updatedCurrent]
    : [...updatedCurrent, ...additions];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractTagBody(source: string, tagName: string): string | null {
  const startTag = `<${tagName}>`;
  const endTag = `</${tagName}>`;
  const startIndex = source.indexOf(startTag);
  if (startIndex === -1) {
    return null;
  }

  const bodyStart = startIndex + startTag.length;
  const endIndex = source.indexOf(endTag, bodyStart);
  if (endIndex === -1) {
    return null;
  }

  return source.slice(bodyStart, endIndex);
}

function serializePastedContent(label: string, text: string): string {
  return `<pasted-content label=${JSON.stringify(label)}>
${text}
</pasted-content>`;
}

function removeStandaloneOverlayContextMention(
  source: string,
  label: string,
): string {
  const mentionPattern = new RegExp(
    `(?:^|\\n)\\s*@?\\[${escapeRegExp(label)}\\]\\(<[^>\\n]+>\\)\\s*(?=\\n|$)`,
    "i",
  );
  return source.replace(mentionPattern, "\n");
}

function buildOverlayUserMessagePreview(message: string): string | null {
  const userRequest = extractTagBody(message, "user_request");
  if (!userRequest) {
    return null;
  }

  const selectedContent = extractTagBody(userRequest, "selected_content");
  let preview = userRequest.trim();

  if (selectedContent) {
    const trimmedSelection = selectedContent.trim();
    preview = preview.replace(
      /<selected_content>\s*[\s\S]*?\s*<\/selected_content>/i,
      serializePastedContent("Selection", trimmedSelection),
    );
    preview = removeStandaloneOverlayContextMention(preview, "Selection");
  }

  return preview.trim();
}

export function buildUserMessagePreview(message: string) {
  const overlayPreview = buildOverlayUserMessagePreview(message);
  if (overlayPreview) {
    return overlayPreview;
  }
  return message;
}

export function buildStreamRequestBody(params: {
  profileId: string;
  threadId: string | null;
  message: string;
  attachments: StreamImageAttachment[];
  skills: StreamSkillReference[];
  options?: Omit<UseChatOptions, "agentId" | "callerToken"> & {
    agentId?: string;
    callerToken?: string;
  };
}): StreamRequestBody {
  if (
    (params.options?.agentId && !params.options.callerToken) ||
    (!params.options?.agentId && params.options?.callerToken)
  ) {
    throw new Error(
      "Agent chat requests require both agentId and callerToken.",
    );
  }

  const requestBody: StreamRequestBody = {
    agentId: params.options?.agentId,
    callerToken: params.options?.callerToken,
    message: params.message,
    system: params.options?.system,
    skills: params.skills,
    threadId: params.threadId,
    workspacePath: params.options?.workspacePath ?? null,
    attachments: params.attachments,
    reasoningEffort: params.options?.reasoningEffort,
  };

  if (params.profileId) {
    requestBody.profileId = params.profileId;
  }
  if (params.options?.model) {
    requestBody.model = params.options.model;
  }
  if (params.options?.codexProfileId) {
    requestBody.codexProfileId = params.options.codexProfileId;
  }
  if (params.options?.customEndpoint) {
    requestBody.customEndpoint = params.options.customEndpoint;
  }
  if (params.options?.customApiKey) {
    requestBody.customApiKey = params.options.customApiKey;
  }

  return requestBody;
}

export function describeStreamFailure(
  streamError: unknown,
  interruptedByReload: boolean,
): string {
  if (interruptedByReload) {
    return tr("errors.chat.streamReloaded");
  }
  return streamError instanceof Error
    ? streamError.message
    : tr("errors.chat.streamFailedGeneric");
}

export function useChat(
  profileId: string,
  options: UseChatOptions,
): UseChatReturn {
  "use no memo";

  const marketingDemoMode = isMarketingDemoMode();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingMessage, setStreamingMessage] = useState<ChatMessage | null>(
    null,
  );
  const [planChecklist, setPlanChecklist] = useState<PlanChecklistState | null>(
    null,
  );
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<string | null>(null);
  const [errorEndpointBaseUrl, setErrorEndpointBaseUrl] = useState<
    string | null
  >(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [threadId, setThreadId] = useState<string | null>(
    options?.initialThreadId ?? null,
  );
  const [historyLoaded, setHistoryLoaded] = useState(!options.initialThreadId);
  const [hasOlderHistory, setHasOlderHistory] = useState(false);
  const [loadingOlderHistory, setLoadingOlderHistory] = useState(false);
  const [runtimeContinuationNonce, setRuntimeContinuationNonce] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  const draftRef = useRef<ChatMessage | null>(null);
  // Tracks every tool-call id we publish to liveItemsStore during the
  // current stream so we can clear all of them on stream end, regardless
  // of whether they ended up in draft.parts or committed mid-stream into
  // state.messages via updateToolInMessages.
  const publishedLiveIdsRef = useRef<Set<string>>(new Set());
  const messagesRef = useRef<ChatMessage[]>(messages);
  const stateRef = useRef<ChatState>(createInitialChatState());
  const requestCustomEndpointRef = useRef<string | null>(
    options.customEndpoint ?? null,
  );
  const toolStartTimesRef = useRef<Map<string, number>>(new Map());
  const olderHistoryCursorRef = useRef<string | null>(null);

  // Keep the telemetry context in sync with the chat's active profile so
  // every emitted event is enriched with activeProfileId/activeModel — not
  // just events from screens that mount NewTabComposer.
  useEffect(() => {
    setActiveProfile({ profileId, model: options?.model ?? undefined });
  }, [profileId, options?.model]);
  const rendererReloadingRef = useRef(false);
  const marketingDemoTimerIdsRef = useRef<number[]>([]);
  const stoppedForRuntimeRestartRef = useRef(false);
  const pendingRuntimeContinuationRef = useRef(false);
  // Same-runtime model changes can reuse the current thread via resumeThread.
  // Cross-provider switches should open a fresh chat tab before reaching this hook.
  messagesRef.current = messages;

  const clearMarketingDemoTimers = useCallback(() => {
    for (const timerId of marketingDemoTimerIdsRef.current) {
      window.clearTimeout(timerId);
    }
    marketingDemoTimerIdsRef.current = [];
  }, []);

  const showError = useCallback((
    message: string,
    errorOptions?: { details?: string | null; endpointBaseUrl?: string | null },
  ) => {
    const errorDetails = errorOptions?.details ?? null;
    const endpointBaseUrl = errorOptions?.endpointBaseUrl ?? null;
    logChatError(message, {
      details: errorDetails,
      endpointBaseUrl,
      model: options?.model ?? null,
      profileId,
      threadId: stateRef.current.threadId,
      turnId: getActiveTurnIdForErrorLogging(stateRef.current, draftRef.current),
    });
    setError(message);
    setErrorDetails(errorDetails);
    setErrorEndpointBaseUrl(endpointBaseUrl);
    setRetrying(null);
    stateRef.current = {
      ...stateRef.current,
      error: message,
      errorDetails,
      retrying: null,
    };
  }, [options?.model, profileId]);

  useEffect(() => {
    const handleRendererReload = () => {
      rendererReloadingRef.current = true;
      abortRef.current?.abort();
      clearMarketingDemoTimers();
    };
    const hot = (
      import.meta as ImportMeta & {
        hot?: { dispose(callback: () => void): void };
      }
    ).hot;

    window.addEventListener("beforeunload", handleRendererReload);
    window.addEventListener("pagehide", handleRendererReload);
    hot?.dispose(handleRendererReload);

    return () => {
      window.removeEventListener("beforeunload", handleRendererReload);
      window.removeEventListener("pagehide", handleRendererReload);
      clearMarketingDemoTimers();
    };
  }, [clearMarketingDemoTimers]);

  useEffect(() => {
    const initialThreadId = options?.initialThreadId?.trim();
    if (!initialThreadId) {
      setHistoryLoaded(true);
      return;
    }

    if (marketingDemoMode) {
      if (messages.length > 0 && threadId === initialThreadId) {
        setThreadId(initialThreadId);
        setHistoryLoaded(true);
        return;
      }

      const nextMessages = marketingDemoTranscriptToChatMessages(
        getMarketingDemoTranscript(initialThreadId),
      );
      draftRef.current = null;
      stateRef.current = {
        messages: nextMessages,
        draft: null,
        draftAgentMessageId: null,
        error: null,
        errorDetails: null,
        retrying: null,
        pendingToolInputs: {},
        threadId: initialThreadId,
        planChecklist: null,
      };
      setThreadId(initialThreadId);
      setMessages(nextMessages);
      setPlanChecklist(null);
      setError(null);
      setErrorDetails(null);
      setRetrying(null);
      setStreamingMessage(null);
      setHistoryLoaded(true);
      return;
    }

    if (messages.length > 0 && threadId === initialThreadId) {
      setThreadId(initialThreadId);
      setHistoryLoaded(true);
      return;
    }

    setHistoryLoaded(false);
    setThreadId(initialThreadId);

    let cancelled = false;

    // NOTE(victor): Codex app-server exposes typed thread history via thread/read with includeTurns.
    // We validate the HTTP payload before mapping so malformed responses fail fast at this boundary.
    // See: https://developers.openai.com/codex/app-server
    void (async () => {
      try {
        const response = await fetch(
          await getApiUrl(
            `/api/agent/threads/${encodeURIComponent(initialThreadId)}?limit=24`,
          ),
          { credentials: 'include' },
        );
        if (response.status === 404) {
          if (!cancelled) {
            // Stale thread ids should transparently recover to a fresh conversation.
            draftRef.current = null;
            stateRef.current = createInitialChatState();
            setThreadId(null);
            setMessages([]);
            setPlanChecklist(null);
            setError(null);
            setErrorDetails(null);
            setErrorEndpointBaseUrl(null);
            setRetrying(null);
          }
          return;
        }
        if (!response.ok) {
          throw new Error(
            tr("errors.chat.threadHistoryLoadHttp", { status: response.status }),
          );
        }

        const payload: unknown = await response.json();
        if (!isThreadReadResponse(payload)) {
          throw new Error("Invalid thread history response shape.");
        }

        if (!cancelled) {
          const historyPage = readThreadHistoryPageMetadata(payload);
          const nextMessages = mapThreadToChatMessages(payload.thread).filter(
            (message) => !isHiddenRuntimeContinuationMessage(message),
          );
          draftRef.current = null;
          stateRef.current = {
            messages: nextMessages,
            draft: null,
            draftAgentMessageId: null,
            error: null,
            errorDetails: null,
            retrying: null,
            pendingToolInputs: {},
            threadId: initialThreadId,
            planChecklist: null,
          };
          setMessages(nextMessages);
          setIsStreaming(payload.thread.status?.type === 'active');
          olderHistoryCursorRef.current = historyPage.nextCursor;
          setHasOlderHistory(historyPage.hasMore);
          setPlanChecklist(null);
          setError(null);
          setErrorDetails(null);
          setErrorEndpointBaseUrl(null);
          setRetrying(null);
        }
      } catch (loadError) {
        if (!cancelled) {
          draftRef.current = null;
          stateRef.current = {
            ...createInitialChatState(),
            threadId: initialThreadId,
          };
          showError(
            loadError instanceof Error
              ? loadError.message
              : tr("errors.chat.threadHistoryLoadFailed"),
          );
        }
      } finally {
        if (!cancelled) {
          setHistoryLoaded(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    marketingDemoMode,
    messages.length,
    options?.initialThreadId,
    showError,
    threadId,
  ]);

  const loadOlderHistory = useCallback(async () => {
    const activeThreadId = stateRef.current.threadId ?? threadId;
    const cursor = olderHistoryCursorRef.current;
    if (!activeThreadId || !cursor || loadingOlderHistory || marketingDemoMode) {
      return;
    }

    setLoadingOlderHistory(true);
    try {
      const response = await fetch(
        await getApiUrl(
          `/api/agent/threads/${encodeURIComponent(activeThreadId)}?limit=24&before=${encodeURIComponent(cursor)}`,
        ),
        { credentials: 'include' },
      );
      if (!response.ok) {
        throw new Error(tr('errors.chat.threadHistoryLoadHttp', { status: response.status }));
      }
      const payload: unknown = await response.json();
      if (!isThreadReadResponse(payload)) {
        throw new Error('Invalid thread history response shape.');
      }
      const historyPage = readThreadHistoryPageMetadata(payload);
      const olderMessages = mapThreadToChatMessages(payload.thread).filter(
        (message) => !isHiddenRuntimeContinuationMessage(message),
      );
      const nextMessages = mergeChatHistory(
        stateRef.current.messages,
        olderMessages,
        'older',
      );
      stateRef.current = { ...stateRef.current, messages: nextMessages };
      setMessages(nextMessages);
      olderHistoryCursorRef.current = historyPage.nextCursor;
      setHasOlderHistory(historyPage.hasMore);
    } catch (loadError) {
      showError(
        loadError instanceof Error
          ? loadError.message
          : tr('errors.chat.threadHistoryLoadFailed'),
      );
    } finally {
      setLoadingOlderHistory(false);
    }
  }, [loadingOlderHistory, marketingDemoMode, showError, threadId]);

  useEffect(() => {
    const activeThreadId = options.initialThreadId?.trim();
    if (!activeThreadId || !historyLoaded || marketingDemoMode) {
      return;
    }

    let cancelled = false;
    const refresh = async () => {
      try {
        const response = await fetch(
          await getApiUrl(
            `/api/agent/threads/${encodeURIComponent(activeThreadId)}?limit=24&bestEffort=1`,
          ),
          { credentials: 'include' },
        );
        if (!response.ok || cancelled) return;
        const payload: unknown = await response.json();
        if (!isThreadReadResponse(payload) || cancelled) return;
        const refreshed = mapThreadToChatMessages(payload.thread).filter(
          (message) => !isHiddenRuntimeContinuationMessage(message),
        );
        const nextMessages = mergeChatHistory(
          stateRef.current.messages,
          refreshed,
          'newer',
        );
        stateRef.current = { ...stateRef.current, messages: nextMessages };
        setMessages(nextMessages);
        setIsStreaming(payload.thread.status?.type === 'active');
      } catch {
        // Reconnect polling is best-effort. The normal history error remains the
        // authoritative failure surface and the next interval tries again.
      }
    };

    const intervalId = window.setInterval(() => void refresh(), 2500);
    void refresh();
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [historyLoaded, marketingDemoMode, options.initialThreadId]);

  const handleParsedEvent = useCallback(
    (chunk: SseStreamEvent) => {
      if (chunk.event === "userMessage") {
        if (isRuntimeRestartContinuationText(chunk.payload.text)) {
          return;
        }
        const shouldInclude =
          options?.onCommittedUserMessage?.({
            itemId: chunk.payload.itemId,
            text: chunk.payload.text,
          }) ?? false;
        if (!shouldInclude) {
          return;
        }
      }

      if (chunk.event === "tool") {
        const { item, phase } = chunk.payload;
        const rawName =
          item.type === "mcpToolCall"
            ? ((item as { tool?: string }).tool ?? item.type)
            : item.type;
        const parsed = parseToolName(rawName);
        const toolName = parsed?.toolName ?? rawName;
        const serverId = parsed?.serverId;
        const threadIdForTool =
          stateRef.current.threadId ?? threadId ?? undefined;
        if (phase === "started") {
          toolStartTimesRef.current.set(item.id, Date.now());
          trackToolCalled({
            toolName,
            serverId,
            callId: item.id,
            threadId: threadIdForTool,
            profileId,
            model: options?.model,
          });
        } else if (phase === "completed") {
          const startedAt = toolStartTimesRef.current.get(item.id);
          const durationMs = startedAt ? Date.now() - startedAt : 0;
          toolStartTimesRef.current.delete(item.id);
          const outcome = classifyToolOutcome(item);
          if (outcome.kind === "real_failure") {
            trackToolFailed({
              toolName,
              serverId,
              callId: item.id,
              threadId: threadIdForTool,
              profileId,
              model: options?.model,
              error: `${item.type} failed (${outcome.reason})`,
              errorKind: outcome.reason,
              durationMs,
            });
          } else {
            trackToolCompleted({
              toolName,
              serverId,
              callId: item.id,
              threadId: threadIdForTool,
              durationMs,
              ...(outcome.kind === "nonzero_exit"
                ? { nonZeroExit: true, exitCode: outcome.exitCode }
                : {}),
              ...(outcome.kind === "declined" ? { declined: true } : {}),
            });
          }
        }
      }

      const prev = stateRef.current;
      const result = applyChatEvent(prev, chunk);
      stateRef.current = result.state;

      draftRef.current = result.state.draft;
      setStreamingMessage(
        result.state.draft ? { ...result.state.draft } : null,
      );

      // Doc 05 §2: publish per-item snapshots to the live store so each
      // tool-call card can subscribe to its own slice. setLiveToolCall
      // bails when render-relevant fields are unchanged, so only the
      // items that actually changed wake their listeners.
      //
      // Walk both draft.parts AND the most recent assistant message —
      // the reducer commits tool items to messages mid-stream (see
      // updateToolInMessages in use-chat-reducer.ts), so a reasoning
      // item that arrived early may have left the draft by now. We
      // record every id we publish so the end-of-stream clear can
      // tear down every live entry we created this turn.
      const publishToolPart = (part: ChatMessagePart): void => {
        if (part.kind !== "tool-call" || !part.toolCall.id) return;
        setLiveToolCall(part.toolCall.id, part.toolCall);
        publishedLiveIdsRef.current.add(part.toolCall.id);
      };
      const draftAfter = result.state.draft;
      if (draftAfter) {
        for (const part of draftAfter.parts) publishToolPart(part);
      }
      const lastCommittedAssistant = result.state.messages.length > 0
        ? result.state.messages[result.state.messages.length - 1]
        : null;
      if (lastCommittedAssistant && lastCommittedAssistant.role === "assistant") {
        for (const part of lastCommittedAssistant.parts) publishToolPart(part);
      }

      if (result.state.messages !== prev.messages) {
        setMessages((prevMsgs) =>
          mergeCommittedAssistantMessages(prevMsgs, result.state.messages),
        );
      }

      setThreadId(result.state.threadId);
      setError(result.state.error);
      setErrorDetails(result.state.errorDetails);
      setErrorEndpointBaseUrl(
        result.state.error ? requestCustomEndpointRef.current : null,
      );
      setRetrying(result.state.retrying);
      setPlanChecklist(result.state.planChecklist);

      if (
        result.state.error &&
        (result.state.error !== prev.error ||
          result.state.errorDetails !== prev.errorDetails)
      ) {
        logChatError(result.state.error, {
          details: result.state.errorDetails,
          endpointBaseUrl: requestCustomEndpointRef.current,
          model: options?.model ?? null,
          profileId,
          threadId: result.state.threadId,
          turnId: getActiveTurnIdForErrorLogging(result.state, result.state.draft),
        });
      }

      for (const effect of result.sideEffects) {
        if (effect.type === "threadNameUpdated") {
          window.dispatchEvent(
            new CustomEvent("agent-thread:name-updated", {
              detail: { threadId: effect.threadId, name: effect.name },
            }),
          );
          continue;
        }

        if (effect.type === "conversationHistoryRefreshRequested") {
          window.dispatchEvent(new Event("conversation-history:refresh"));
        }
      }
    },
    [options?.onCommittedUserMessage, profileId, options?.model, threadId],
  );

  const sendMessage = useCallback(
    (messageOverride?: string, overrides?: SendMessageOverrides) => {
      const message = (messageOverride ?? input).trim();
      const parsedSkills = extractSkillMentionsFromText(message);
      const cleanedMessage = parsedSkills.text;
      const normalizedMarketingDemoMessage =
        stripWorkstationContext(cleanedMessage).trim();
      const pendingAttachments = overrides?.attachments ?? [];
      if ((!message && pendingAttachments.length === 0) || isStreaming) return;

      window.dispatchEvent(new Event("assistant-tts:stop"));

      if (messageOverride === undefined) {
        setInput("");
      }
      setError(null);
      setErrorDetails(null);
      setErrorEndpointBaseUrl(null);
      setRetrying(null);
      draftRef.current = null;
      setStreamingMessage(null);
      setPlanChecklist(null);

      const shouldShowUserMessage = overrides?.hideUserMessage !== true;
      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ kind: "text", content: buildUserMessagePreview(message) }],
        ...(pendingAttachments.length > 0
          ? { attachments: pendingAttachments }
          : {}),
      };
      const initialMessages = shouldShowUserMessage
        ? [...messagesRef.current, userMsg]
        : messagesRef.current;
      stateRef.current = {
        ...createInitialChatState(),
        messages: initialMessages,
        threadId,
      };
      if (shouldShowUserMessage) {
        setMessages((prev) => [...prev, userMsg]);
      }

      const abortController = new AbortController();
      rendererReloadingRef.current = false;
      abortRef.current = abortController;
      setIsStreaming(true);
      if (shouldShowUserMessage) {
        playSound("voiceSent");
      }

      const isFirstMessage = messages.length <= 1;
      trackMessageSent({
        messageLength: message.length,
        hasAttachments: pendingAttachments.length > 0,
        attachmentCount: pendingAttachments.length,
        isFirstMessage,
        profileId,
        model: options?.model,
        messageSource: overrides?.messageSource,
      });

      if (marketingDemoMode) {
        clearMarketingDemoTimers();

        const nextThreadId = threadId ?? createMarketingDemoThread();
        const scenario = getMarketingDemoScenario(
          normalizedMarketingDemoMessage,
          parsedSkills.skills.map((skill) => skill.name),
        );
        const replyText =
          scenario?.replyText ??
          buildMarketingDemoAssistantReply({
            message: normalizedMarketingDemoMessage,
            workspacePath:
              overrides?.workspacePath ?? options?.workspacePath ?? null,
            attachmentCount: pendingAttachments.length,
          });
        const replyChunks = scenario
          ? []
          : splitMarketingDemoReplyIntoChunks(replyText);
        const assistantMessageId = crypto.randomUUID();
        const userTranscriptEntry: MarketingDemoTranscriptMessage = {
          id: userMsg.id,
          role: "user",
          text: textContent(userMsg),
        };
        const baseTranscript = getMarketingDemoTranscript(nextThreadId);
        saveMarketingDemoTranscript(nextThreadId, [
          ...baseTranscript,
          userTranscriptEntry,
        ]);
        const streamStartTime = Date.now();
        let streamedText = "";

        setThreadId(nextThreadId);
        stateRef.current = {
          ...createInitialChatState(),
          threadId: nextThreadId,
        };

        if (scenario) {
          const toolCallCount = scenario.toolCalls.length;
          const streamStartTime = Date.now();
          let cumulativeDelayMs = 180;
          let scenarioMutationApplied = false;
          const introAssistantMessage = createTextChatMessage(
            "assistant",
            scenario.introText,
          );
          const introTranscriptEntry: MarketingDemoTranscriptMessage = {
            id: introAssistantMessage.id,
            role: "assistant",
            text: scenario.introText,
          };

          const planningTimerId = window.setTimeout(() => {
            const draft = createMarketingDemoReasoningDraft(
              assistantMessageId,
              scenario.planningLabel,
            );
            draftRef.current = draft;
            stateRef.current = {
              ...stateRef.current,
              threadId: nextThreadId,
              draft,
            };
            setStreamingMessage(draft);
          }, cumulativeDelayMs);
          marketingDemoTimerIdsRef.current.push(planningTimerId);
          cumulativeDelayMs += 420;

          const introTimerId = window.setTimeout(() => {
            draftRef.current = null;
            stateRef.current = {
              ...stateRef.current,
              threadId: nextThreadId,
              draft: null,
              draftAgentMessageId: null,
            };
            setStreamingMessage(null);
            setMessages((prev) => [...prev, introAssistantMessage]);
            saveMarketingDemoTranscript(nextThreadId, [
              ...baseTranscript,
              userTranscriptEntry,
              introTranscriptEntry,
            ]);
          }, cumulativeDelayMs);
          marketingDemoTimerIdsRef.current.push(introTimerId);
          cumulativeDelayMs += 300;

          const transitionReasoningTimerId = window.setTimeout(() => {
            const draft = createMarketingDemoReasoningDraft(
              assistantMessageId,
              scenario.completionLabel,
            );
            draftRef.current = draft;
            stateRef.current = {
              ...stateRef.current,
              threadId: nextThreadId,
              draft,
            };
            setStreamingMessage(draft);
          }, cumulativeDelayMs);
          marketingDemoTimerIdsRef.current.push(transitionReasoningTimerId);
          cumulativeDelayMs += 260;

          for (let index = 0; index < scenario.toolCalls.length; index += 1) {
            const timerId = window.setTimeout(() => {
              const draft = createMarketingDemoScenarioMessage({
                messageId: assistantMessageId,
                scenario,
                activeToolCallIndex: index,
                includeReasoningLabel: scenario.completionLabel,
              });
              draftRef.current = draft;
              stateRef.current = {
                ...stateRef.current,
                threadId: nextThreadId,
                draft,
              };
              setStreamingMessage(draft);

              if (
                index === scenario.toolCalls.length - 1 &&
                !scenarioMutationApplied
              ) {
                scenarioMutationApplied = true;
                const mutationResult = applyMarketingDemoScenario(scenario.id);
                const openedFilePath = mutationResult.openedFilePath;
                if (openedFilePath) {
                  window.setTimeout(() => {
                    const windowingApi = (
                      window as typeof window & {
                        windowingAPI?: { openFile?: (path: string) => void };
                      }
                    ).windowingAPI;
                    windowingApi?.openFile?.(openedFilePath);
                  }, 120);
                }
              }
            }, cumulativeDelayMs);

            marketingDemoTimerIdsRef.current.push(timerId);
            cumulativeDelayMs += index === 0 ? 300 : 220;
          }

          const finalTimerId = window.setTimeout(() => {
            const finalAssistantMessage = createMarketingDemoScenarioMessage({
              messageId: assistantMessageId,
              scenario,
              includeFinalText: true,
              includeReasoningLabel: scenario.completionLabel,
            });
            draftRef.current = null;
            stateRef.current = {
              ...stateRef.current,
              threadId: nextThreadId,
              draft: null,
              draftAgentMessageId: null,
            };
            setStreamingMessage(null);
            setMessages((prev) => [...prev, finalAssistantMessage]);
            saveMarketingDemoTranscript(nextThreadId, [
              ...baseTranscript,
              userTranscriptEntry,
              introTranscriptEntry,
              createMarketingDemoTranscriptMessage(finalAssistantMessage),
            ]);
            marketingDemoTimerIdsRef.current = [];
            setIsStreaming(false);
            playSound("agentFinished");
            trackResponseReceived({
              durationMs: Date.now() - streamStartTime,
              timeToFirstTokenMs: 140,
              toolCallCount,
              hadError: false,
              isFirstResponse: isFirstMessage,
              profileId,
              model: options?.model,
            });
            if (isFirstMessage) {
              trackFirstSuccessfulInteraction();
            }
          }, cumulativeDelayMs + 140);

          marketingDemoTimerIdsRef.current.push(finalTimerId);
          return;
        }

        const scheduleChunk = (index: number) => {
          const timerId = window.setTimeout(
            () => {
              const nextChunk = replyChunks[index] ?? "";
              streamedText += nextChunk;

              const draft = createTextChatMessage(
                "assistant",
                streamedText,
                assistantMessageId,
              );
              draftRef.current = draft;
              stateRef.current = {
                ...stateRef.current,
                threadId: nextThreadId,
                draft,
              };
              setStreamingMessage(draft);

              if (index < replyChunks.length - 1) {
                scheduleChunk(index + 1);
                return;
              }

              const finalAssistantMessage = createTextChatMessage(
                "assistant",
                replyText,
                assistantMessageId,
              );
              draftRef.current = null;
              stateRef.current = {
                ...stateRef.current,
                threadId: nextThreadId,
                draft: null,
                draftAgentMessageId: null,
              };
              setStreamingMessage(null);
              setMessages((prev) => [...prev, finalAssistantMessage]);
              saveMarketingDemoTranscript(nextThreadId, [
                ...baseTranscript,
                userTranscriptEntry,
                createMarketingDemoTranscriptMessage(finalAssistantMessage),
              ]);
              marketingDemoTimerIdsRef.current = [];
              setIsStreaming(false);
              playSound("agentFinished");
              trackResponseReceived({
                durationMs: Date.now() - streamStartTime,
                timeToFirstTokenMs: 120,
                toolCallCount: 0,
                hadError: false,
                isFirstResponse: isFirstMessage,
                profileId,
                model: options?.model,
              });
              if (isFirstMessage) {
                trackFirstSuccessfulInteraction();
              }
            },
            index === 0 ? 180 : 65,
          );
          marketingDemoTimerIdsRef.current.push(timerId);
        };

        scheduleChunk(0);
        return;
      }

      const streamStartTime = Date.now();
      const currentThreadId = threadId;
      const requestBody = buildStreamRequestBody({
        profileId,
        threadId: currentThreadId,
        message: cleanedMessage,
        attachments: pendingAttachments,
        skills: parsedSkills.skills,
        options: {
          ...options,
          workspacePath:
            overrides?.workspacePath ?? options?.workspacePath ?? null,
        },
      });
      const requestEndpointBaseUrl = requestBody.customEndpoint ?? null;
      requestCustomEndpointRef.current = requestEndpointBaseUrl;

      console.log("[useChat] Sending chat stream request", {
        profileId: requestBody.profileId ?? null,
        threadId: requestBody.threadId ?? null,
        model: requestBody.model ?? null,
        codexProfileId: requestBody.codexProfileId ?? null,
        customEndpoint: requestBody.customEndpoint ?? null,
        workspacePath: requestBody.workspacePath ?? null,
        reasoningEffort: requestBody.reasoningEffort ?? null,
        attachmentCount: requestBody.attachments?.length ?? 0,
        skillCount: requestBody.skills?.length ?? 0,
      });

      // SSE coalescing buffer (Doc 05 §4) — hoisted above the try so both
      // the success and error paths can flush before snapshotting draft.
      const pendingEvents: SseStreamEvent[] = [];
      let scheduledFrame: number | null = null;
      // Reset the published-id tracker for the new stream. Lives in a
      // hook-scope ref so handleParsedEvent (defined as a useCallback at
      // the hook level) can write to it during the stream.
      publishedLiveIdsRef.current.clear();

      const drainBuffer = () => {
        scheduledFrame = null;
        const batch = pendingEvents.splice(0, pendingEvents.length);
        for (const event of batch) {
          try {
            handleParsedEvent(event);
          } catch (handlerError) {
            console.warn("[useChat] SSE handler threw, continuing batch", handlerError);
          }
        }
      };

      const scheduleFlush = () => {
        if (scheduledFrame !== null) return;
        scheduledFrame = requestAnimationFrame(drainBuffer);
      };

      const flushSseBuffer = () => {
        if (scheduledFrame !== null) {
          cancelAnimationFrame(scheduledFrame);
          scheduledFrame = null;
        }
        if (pendingEvents.length > 0) drainBuffer();
      };

      (async () => {
        try {
          // NOTE(victor): SSE over localhost HTTP is intentional over Electron IPC.
          // Localhost TCP is kernel-optimized (~0.1ms roundtrip), eventsource-parser
          // handles reconnection/partial chunks/event boundaries for free (battle-tested
          // by Vercel AI SDK, OpenAI SDK), and the real bottleneck is token generation
          // speed, not transport. Electron IPC would add complexity without perceptible gain.
          const response = await fetch(
            await getApiUrl("/api/agent/chat/stream"),
            {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              signal: abortController.signal,
              body: JSON.stringify(requestBody),
            },
          );

          if (!response.ok || !response.body) {
            throw new Error(
              tr("errors.chat.streamStartHttp", { status: response.status }),
            );
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let firstTokenTime: number | undefined;

          const parser = createParser({
            onEvent(parsedEvent: EventSourceMessage) {
              if (!parsedEvent.data) return;
              if (
                firstTokenTime === undefined &&
                parsedEvent.event === "delta"
              ) {
                firstTokenTime = Date.now();
              }
              try {
                const parsed = JSON.parse(parsedEvent.data);
                pendingEvents.push({
                  event: parsedEvent.event,
                  payload: parsed,
                } as SseStreamEvent);
                scheduleFlush();
              } catch {
                showError(tr("errors.chat.sseParseFailed"), {
                  endpointBaseUrl: requestEndpointBaseUrl,
                });
              }
            },
          });

          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              parser.feed(decoder.decode());
              break;
            }
            parser.feed(decoder.decode(value, { stream: true }));
          }

          // Drain anything still buffered before we snapshot finalDraft —
          // a deferred batch would otherwise leave draftRef stale and the
          // assistant message could silently lose its tail.
          flushSseBuffer();

          // NOTE(victor): Snapshot draft before nulling. setMessages' functional updater
          // runs lazily during React's render phase -- if we null the ref first, the
          // updater reads null and the assistant message silently disappears.
          const finalDraft = draftRef.current;
          draftRef.current = null;
          stateRef.current = {
            ...stateRef.current,
            draft: null,
            draftAgentMessageId: null,
          };
          setStreamingMessage(null);
          // Clear every live snapshot we published this turn — the
          // committed messages array is now authoritative. The ref's set
          // includes ids from both the final draft AND mid-stream-committed
          // assistant messages, which is what reasoning items typically
          // end up in.
          if (publishedLiveIdsRef.current.size > 0) {
            clearLiveToolCallsForIds(publishedLiveIdsRef.current);
            publishedLiveIdsRef.current.clear();
          }
          setMessages((prev) => appendVisibleDraftMessage(prev, finalDraft));
          playSound("agentFinished");
          const toolCallCount = finalDraft
            ? finalDraft.parts.filter((p) => p.kind === "tool-call").length
            : 0;
          const hadError = !!stateRef.current.error;
          console.log("[useChat] Stream completed", {
            threadId: stateRef.current.threadId ?? currentThreadId ?? null,
            durationMs: Date.now() - streamStartTime,
            timeToFirstTokenMs: firstTokenTime
              ? firstTokenTime - streamStartTime
              : null,
            toolCallCount,
            hadError,
            profileId,
            model: options?.model ?? null,
          });
          trackResponseReceived({
            durationMs: Date.now() - streamStartTime,
            timeToFirstTokenMs: firstTokenTime
              ? firstTokenTime - streamStartTime
              : undefined,
            toolCallCount,
            hadError,
            isFirstResponse: isFirstMessage,
            profileId,
            model: options?.model,
          });
          const toolFailCount = finalDraft
            ? finalDraft.parts.filter(
                (p) =>
                  p.kind === "tool-call" &&
                  p.toolCall.state === "error",
              ).length
            : 0;
          trackAgentTurnCompleted({
            reason: hadError ? "error" : "natural_stop",
            durationMs: Date.now() - streamStartTime,
            timeToFirstTokenMs: firstTokenTime
              ? firstTokenTime - streamStartTime
              : undefined,
            toolCallCount,
            toolFailCount,
            profileId,
            model: options?.model,
            isFirstResponse: isFirstMessage,
            threadId: stateRef.current.threadId ?? currentThreadId ?? undefined,
            errorMessage: hadError
              ? (stateRef.current.error ?? undefined)
              : undefined,
          });
          if (isFirstMessage && !hadError) {
            trackFirstSuccessfulInteraction();
          }
        } catch (streamError) {
          // Apply any buffered events so draftRef reflects whatever the
          // stream did deliver before failing.
          flushSseBuffer();
          const finalDraft = draftRef.current;
          if (publishedLiveIdsRef.current.size > 0) {
            clearLiveToolCallsForIds(publishedLiveIdsRef.current);
            publishedLiveIdsRef.current.clear();
          }
          draftRef.current = null;
          stateRef.current = {
            ...stateRef.current,
            draft: null,
            draftAgentMessageId: null,
          };
          setStreamingMessage(null);
          setMessages((prev) => appendVisibleDraftMessage(prev, finalDraft));

          if (abortController.signal.aborted) {
            trackAgentTurnCompleted({
              reason: "user_stopped",
              durationMs: Date.now() - streamStartTime,
              toolCallCount: finalDraft
                ? finalDraft.parts.filter((p) => p.kind === "tool-call").length
                : 0,
              profileId,
              model: options?.model,
              isFirstResponse: isFirstMessage,
              threadId:
                stateRef.current.threadId ?? currentThreadId ?? undefined,
            });
          }
          if (!abortController.signal.aborted) {
            const interruptedByReload = rendererReloadingRef.current;
            const finalErrorMsg = describeStreamFailure(
              streamError,
              interruptedByReload,
            );
            showError(finalErrorMsg, {
              endpointBaseUrl: requestEndpointBaseUrl,
            });
            console.error("[useChat] Stream failed", {
              threadId: stateRef.current.threadId ?? currentThreadId ?? null,
              durationMs: Date.now() - streamStartTime,
              message: finalErrorMsg,
              errorName: streamError instanceof Error ? streamError.name : null,
              interruptedByReload,
              profileId,
              model: options?.model ?? null,
            });
            trackResponseError({
              error: finalErrorMsg,
              isFirstMessage,
              profileId,
              model: options?.model,
            });
            const reason: AgentTurnEndReason = /timeout/i.test(finalErrorMsg)
              ? "timeout"
              : /context\s*(length|limit|window)/i.test(finalErrorMsg)
                ? "context_limit"
                : "error";
            trackAgentTurnCompleted({
              reason,
              durationMs: Date.now() - streamStartTime,
              toolCallCount: 0,
              profileId,
              model: options?.model,
              isFirstResponse: isFirstMessage,
              threadId:
                stateRef.current.threadId ?? currentThreadId ?? undefined,
              errorMessage: finalErrorMsg,
            });
          }
        } finally {
          abortRef.current = null;
          setIsStreaming(false);
        }
      })();
    },
    [
      input,
      isStreaming,
      threadId,
      profileId,
      options?.model,
      options?.codexProfileId,
      options?.customEndpoint,
      options?.customApiKey,
      options?.reasoningEffort,
      options?.workspacePath,
      handleParsedEvent,
      showError,
    ],
  );

  const stopGeneration = useCallback((threadIdOverride?: string | null) => {
    window.dispatchEvent(new Event("assistant-tts:stop"));
    trackResponseStopped();

    const stoppedDraft = draftRef.current
      ? stopLoadingToolCallsInMessage(draftRef.current)
      : null;
    const stoppedMessages = stateRef.current.messages.map(stopLoadingToolCallsInMessage);
    const nextMessages = stoppedDraft && draftHasVisibleContent(stoppedDraft)
      ? stoppedMessages.some((message) => message.id === stoppedDraft.id)
        ? stoppedMessages
        : [...stoppedMessages, { ...stoppedDraft }]
      : stoppedMessages;

    if (marketingDemoMode) {
      clearMarketingDemoTimers();
      draftRef.current = null;
      stateRef.current = {
        ...stateRef.current,
        messages: nextMessages,
        draft: null,
        draftAgentMessageId: null,
      };
      setStreamingMessage(null);
      setMessages(nextMessages);
      setIsStreaming(false);
      if (stoppedDraft && draftHasVisibleContent(stoppedDraft) && threadId) {
        const transcript = getMarketingDemoTranscript(threadId);
        saveMarketingDemoTranscript(threadId, [
          ...transcript,
          createMarketingDemoTranscriptMessage(stoppedDraft),
        ]);
      }
      return;
    }

    abortRef.current?.abort();

    const targetThreadId = threadIdOverride ?? threadId;
    if (targetThreadId) {
      getApiUrl("/api/agent/chat/stop")
        .then((stopUrl) =>
          fetch(stopUrl, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ threadId: targetThreadId }),
          }),
        )
        .catch(() => {});
    }

    draftRef.current = null;
    // Clear the reducer draft so ensureDraft won't reuse the stale draft
    // if a new turn starts before sendMessage fully resets stateRef.
    stateRef.current = {
      ...stateRef.current,
      messages: nextMessages,
      draft: null,
      draftAgentMessageId: null,
    };
    setStreamingMessage(null);
    setMessages(nextMessages);
    setIsStreaming(false);
  }, [clearMarketingDemoTimers, marketingDemoMode, threadId]);

  useEffect(() => {
    const unsubscribeRestarting = runtime.onRestarting(() => {
      if (!isStreaming || stoppedForRuntimeRestartRef.current) {
        return;
      }

      stoppedForRuntimeRestartRef.current = true;
      pendingRuntimeContinuationRef.current = true;
      const currentThreadId = stateRef.current.threadId ?? threadId;
      rememberRuntimeRestartContinuation(currentThreadId);
      console.log(
        "[useChat] Runtime restart interrupted active turn; queued hidden continuation",
        {
          threadId: currentThreadId,
        },
      );
      stopGeneration();
    });

    const unsubscribeRestarted = runtime.onRestarted(() => {
      if (!stoppedForRuntimeRestartRef.current) {
        return;
      }

      stoppedForRuntimeRestartRef.current = false;
      setMessages((prev) => [
        ...prev,
        createTextChatMessage(
          "assistant",
          "Interpreter restarted. New changes have taken effect.",
        ),
      ]);
      setRuntimeContinuationNonce((value) => value + 1);
    });

    return () => {
      unsubscribeRestarting();
      unsubscribeRestarted();
    };
  }, [isStreaming, stopGeneration, threadId]);

  useEffect(() => {
    if (isStreaming || !historyLoaded) {
      return;
    }

    const currentThreadId =
      stateRef.current.threadId ?? threadId ?? options.initialThreadId ?? null;
    if (
      !pendingRuntimeContinuationRef.current &&
      hasRuntimeRestartContinuation(currentThreadId)
    ) {
      pendingRuntimeContinuationRef.current = true;
      setMessages((prev) => [
        ...prev,
        createTextChatMessage(
          "assistant",
          "Interpreter restarted. New changes have taken effect.",
        ),
      ]);
    }

    if (!pendingRuntimeContinuationRef.current) {
      return;
    }

    forgetRuntimeRestartContinuation(currentThreadId);
    pendingRuntimeContinuationRef.current = false;
    console.log("[useChat] Sending hidden continuation after runtime restart", {
      threadId: currentThreadId,
    });
    sendMessage(RUNTIME_RESTART_CONTINUE_MESSAGE, { hideUserMessage: true });
  }, [
    historyLoaded,
    isStreaming,
    options.initialThreadId,
    runtimeContinuationNonce,
    sendMessage,
    threadId,
  ]);

  const stopBackgroundProcess = useCallback(
    async (toolCallIds?: string[]) => {
      if (marketingDemoMode) {
        return;
      }

      if (!threadId) {
        return;
      }

      const targetIds = new Set(
        (toolCallIds ?? []).filter(
          (value) => typeof value === "string" && value.length > 0,
        ),
      );
      await requestBackgroundProcessStopForThread(threadId);

      stateRef.current = {
        ...stateRef.current,
        messages: stateRef.current.messages.map((message) =>
          stopBackgroundToolCallsInMessage(message, targetIds),
        ),
        draft: stateRef.current.draft
          ? stopBackgroundToolCallsInMessage(stateRef.current.draft, targetIds)
          : null,
      };
      setMessages((prev) =>
        prev.map((message) =>
          stopBackgroundToolCallsInMessage(message, targetIds),
        ),
      );
      setStreamingMessage((prev) =>
        prev ? stopBackgroundToolCallsInMessage(prev, targetIds) : null,
      );
    },
    [marketingDemoMode, messages, streamingMessage, threadId],
  );

  return {
    messages,
    streamingMessage,
    planChecklist,
    historyLoaded,
    hasOlderHistory,
    loadingOlderHistory,
    loadOlderHistory,
    isStreaming,
    error,
    errorDetails,
    errorEndpointBaseUrl,
    retrying,
    input,
    setInput,
    showError,
    sendMessage,
    stopGeneration,
    stopBackgroundProcess,
    threadId,
  };
}
