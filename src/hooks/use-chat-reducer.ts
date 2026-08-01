import { match } from "ts-pattern";

import type { SseStreamEvent } from "@/lib/codex/event-mapper";
import {
  describeFormattedTurnError,
  formatTurnError,
  formatTurnErrorDescriptor,
  getResponsesToolCallingContractError,
} from "@/lib/codex/errors";
import { translateTurnError } from "@/lib/codex/translateTurnError";
import {
  isFailedToolItem,
} from "@/lib/codex/tool-call-format";
import { buildToolCallInfoFromItem } from "@/lib/codex/tool-call-info";
import { tr } from "@/i18n";
import type {
  ChatMessage,
  ChatMessagePart,
  PlanChecklistState,
  ToolCallInfo,
} from "./use-chat";
import { hasToolCalls, resolveToolCallIndex, shouldApplyFinalText, textContent } from "./use-chat";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChatState = {
  messages: ChatMessage[];
  draft: ChatMessage | null;
  draftAgentMessageId: string | null;
  error: string | null;
  errorDetails: string | null;
  retrying: string | null;
  pendingToolInputs: Record<string, { toolName: string; input: string }>;
  threadId: string | null;
  planChecklist: PlanChecklistState | null;
};

export type ChatSideEffect = {
  type: "threadNameUpdated";
  threadId: string;
  name: string | null;
} | {
  type: "conversationHistoryRefreshRequested";
};

export type ApplyResult = {
  state: ChatState;
  sideEffects: ChatSideEffect[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function createInitialChatState(): ChatState {
  return {
    messages: [],
    draft: null,
    draftAgentMessageId: null,
    error: null,
    errorDetails: null,
    retrying: null,
    pendingToolInputs: {},
    threadId: null,
    planChecklist: null,
  };
}

function dropPendingToolInput(
  pendingToolInputs: ChatState["pendingToolInputs"],
  itemId: string,
): ChatState["pendingToolInputs"] {
  if (!(itemId in pendingToolInputs)) {
    return pendingToolInputs;
  }

  const next = { ...pendingToolInputs };
  delete next[itemId];
  return next;
}

function defaultGenerateId(): string {
  return crypto.randomUUID();
}

function draftHasVisibleContent(state: ChatState): boolean {
  return Boolean(
    state.draft
    && (
      textContent(state.draft).trim().length > 0
      || hasToolCalls(state.draft)
    ),
  );
}

function ensureDraft(
  state: ChatState,
  updater: (draft: ChatMessage) => ChatMessage,
  generateId: () => string,
): ChatState {
  const current: ChatMessage = state.draft ?? {
    id: generateId(),
    role: "assistant",
    parts: [],
  };
  return { ...state, draft: updater(current) };
}

function endDraftToolCallSpans(message: ChatMessage, completedAt: number): ChatMessage {
  if (message.role !== "assistant") {
    return message;
  }

  let changed = false;
  const parts = message.parts.map((part) => {
    if (part.kind !== "tool-call") {
      return part;
    }
    if (part.toolCall.completedAt === completedAt) {
      return part;
    }
    changed = true;
    return {
      kind: "tool-call" as const,
      toolCall: {
        ...part.toolCall,
        completedAt,
      },
    };
  });

  return changed ? { ...message, parts } : message;
}

function commitDraft(
  state: ChatState,
  generateId: () => string,
): ChatState {
  if (!state.draft) return state;

  const turnId = state.draft.serverMessageId;
  const committedDraft = hasToolCalls(state.draft)
    ? endDraftToolCallSpans(state.draft, Date.now())
    : state.draft;
  return {
    ...state,
    messages: [...state.messages, { ...committedDraft }],
    draft: {
      id: generateId(),
      role: "assistant",
      parts: [],
      serverMessageId: turnId,
    },
  };
}

function updateToolInMessages(
  messages: ChatMessage[],
  item: ToolCallInfo["item"],
  updater: (toolCall: ToolCallInfo) => ToolCallInfo,
) {
  if (!item) {
    return { messages, updated: false };
  }

  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (!message || message.role !== "assistant") continue;

    const toolCalls = message.parts
      .map((part, partIndex) => part.kind === "tool-call" ? { toolCall: part.toolCall, partIndex } : null)
      .filter((value): value is { toolCall: ToolCallInfo; partIndex: number } => value !== null);
    const toolIndex = resolveToolCallIndex(
      toolCalls.map((value) => value.toolCall),
      item.id,
      item.type,
    );

    if (toolIndex < 0) continue;

    const partIndex = toolCalls[toolIndex]!.partIndex;
    const updatedParts = [...message.parts];
    const current = toolCalls[toolIndex]!.toolCall;
    updatedParts[partIndex] = {
      kind: "tool-call",
      toolCall: updater(current),
    };

    const updatedMessages = [...messages];
    updatedMessages[messageIndex] = {
      ...message,
      parts: updatedParts,
    };
    return { messages: updatedMessages, updated: true };
  }

  return { messages, updated: false };
}

function updateToolByIdInMessages(
  messages: ChatMessage[],
  itemId: string,
  updater: (toolCall: ToolCallInfo) => ToolCallInfo,
) {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (!message || message.role !== "assistant") continue;

    const partIndex = message.parts.findIndex(
      (part) => part.kind === "tool-call" && part.toolCall.id === itemId,
    );
    if (partIndex < 0) continue;

    const part = message.parts[partIndex] as Extract<ChatMessagePart, { kind: "tool-call" }>;
    const updatedParts = [...message.parts];
    updatedParts[partIndex] = {
      kind: "tool-call",
      toolCall: updater(part.toolCall),
    };

    const updatedMessages = [...messages];
    updatedMessages[messageIndex] = {
      ...message,
      parts: updatedParts,
    };
    return { messages: updatedMessages, updated: true };
  }

  return { messages, updated: false };
}

function settleToolCall(toolCall: ToolCallInfo): ToolCallInfo {
  if (toolCall.state !== "loading") {
    return toolCall;
  }

  const nextState: ToolCallInfo["state"] = toolCall.item && isFailedToolItem(toolCall.item)
    ? "error"
    : "complete";

  return {
    ...toolCall,
    state: nextState,
    completedAt: toolCall.completedAt ?? Date.now(),
  };
}

export function settleMessageToolCalls(message: ChatMessage): ChatMessage {
  if (message.role !== "assistant") {
    return message;
  }

  const parts = message.parts.map((part) => {
    if (part.kind !== "tool-call") {
      return part;
    }

    return {
      kind: "tool-call" as const,
      toolCall: settleToolCall(part.toolCall),
    };
  });

  return {
    ...message,
    parts,
  };
}

function settleLoadingToolCalls(state: ChatState): ChatState {
  return {
    ...state,
    messages: state.messages.map(settleMessageToolCalls),
    draft: state.draft ? settleMessageToolCalls(state.draft) : null,
  };
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function applyChatEvent(
  state: ChatState,
  event: SseStreamEvent,
  generateId: () => string = defaultGenerateId,
): ApplyResult {
  const sideEffects: ChatSideEffect[] = [];

  const nextState: ChatState = match(event)
    .with({ event: "thread" }, (c) => {
      if (state.threadId !== c.payload.threadId) {
        sideEffects.push({ type: "conversationHistoryRefreshRequested" });
      }
      return {
        ...state,
        threadId: c.payload.threadId,
      };
    })

    .with({ event: "turn" }, (c) =>
      ensureDraft(
        state,
        (d) => ({ ...d, serverMessageId: c.payload.turnId }),
        generateId,
      ),
    )

    .with({ event: "compacted" }, (c) => {
      const baseState = draftHasVisibleContent(state)
        ? commitDraft(state, generateId)
        : state;
      const compactionMessage: ChatMessage = {
        id: generateId(),
        role: "assistant",
        parts: [{
          kind: "text",
          content: '<compaction reason="context_limit"></compaction>',
        }],
        serverMessageId: c.payload.turnId,
      };

      return {
        ...baseState,
        draftAgentMessageId: null,
        messages: [...baseState.messages, compactionMessage],
      };
    })

    .with({ event: "threadName" }, (c) => {
      sideEffects.push({
        type: "threadNameUpdated",
        threadId: c.payload.threadId,
        name: c.payload.name,
      });
      return state;
    })

    .with({ event: "planUpdated" }, (c) => ({
      ...state,
      planChecklist: c.payload.plan.length > 0
        ? {
            threadId: c.payload.threadId,
            turnId: c.payload.turnId,
            explanation: c.payload.explanation,
            steps: c.payload.plan.map((step) => ({
              step: step.step,
              status: step.status,
            })),
          }
        : null,
    }))

    .with({ event: "delta" }, (c) => {
      let s: ChatState = { ...state, retrying: null };

      if (c.payload.text && hasToolCalls(s.draft ?? { parts: [] })) {
        s = commitDraft(s, generateId);
      }

      if (c.payload.itemId) {
        s = { ...s, draftAgentMessageId: c.payload.itemId };
      }

      if (c.payload.text) {
        s = ensureDraft(
          s,
          (d) => {
            const lastPart = d.parts[d.parts.length - 1];
            if (lastPart && lastPart.kind === 'text') {
              const updatedParts = [...d.parts];
              updatedParts[updatedParts.length - 1] = {
                kind: 'text',
                content: lastPart.content + c.payload.text,
              };
              return { ...d, parts: updatedParts };
            }
            return { ...d, parts: [...d.parts, { kind: 'text', content: c.payload.text }] };
          },
          generateId,
        );
      }

      return s;
    })

    .with({ event: "final" }, (c) => {
      if (!c.payload.text) return state;

      // Capture whether the streaming deltas have already delivered the
      // text for this same agentMessage. This MUST happen before
      // commitDraft below — otherwise commitDraft moves the
      // delta-accumulated text out of `draft` and into `messages`, the
      // draft becomes empty, and the post-commit dedup check
      // (textContent(d) === 0) incorrectly says "no text yet, apply
      // final" → the final text gets appended again and the user sees
      // the assistant message twice.
      const deltasAlreadyDeliveredFinal =
        state.draft !== null
        && state.draftAgentMessageId !== null
        && state.draftAgentMessageId === c.payload.itemId
        && textContent(state.draft).trim().length > 0;

      const next = hasToolCalls(state.draft ?? { parts: [] })
        ? commitDraft(state, generateId)
        : state;

      if (deltasAlreadyDeliveredFinal) {
        return next;
      }

      return ensureDraft(
        next,
        (d) => {
          if (
            !shouldApplyFinalText(
              c.payload.itemId,
              next.draftAgentMessageId,
              textContent(d),
            )
          ) {
            return d;
          }
          return { ...d, parts: [...d.parts, { kind: 'text' as const, content: c.payload.text }] };
        },
        generateId,
      );
    })

    .with({ event: "userMessage" }, (c) => {
      let nextState = state;
      if (nextState.draft && (textContent(nextState.draft).trim() || hasToolCalls(nextState.draft))) {
        nextState = commitDraft(nextState, generateId);
      }

      return {
        ...nextState,
        messages: [
          ...nextState.messages,
          {
            id: c.payload.itemId,
            role: "user" as const,
            parts: [{ kind: "text" as const, content: c.payload.text }],
          },
        ],
      };
    })

    .with({ event: "tool" }, (c) => {
      const s: ChatState = { ...state, retrying: null };
      const { item, phase } = c.payload;
      const pendingInput = s.pendingToolInputs[item.id];
      const baseState = pendingInput
        ? {
            ...s,
            pendingToolInputs: dropPendingToolInput(s.pendingToolInputs, item.id),
          }
        : s;

      const resolveState = (): ToolCallInfo["state"] => {
        if (phase !== "completed") return "loading";
        return isFailedToolItem(item) ? "error" : "complete";
      };

      const nextTool = (toolCall: ToolCallInfo): ToolCallInfo => ({
        ...buildToolCallInfoFromItem(item, {
          phase,
          previous: toolCall,
          sourceInput: pendingInput?.input,
          sourceToolName: pendingInput?.toolName,
        }),
        state: resolveState(),
      });
      const toolCallParts = baseState.draft?.parts
        .map((part, partIndex) => part.kind === "tool-call" ? { toolCall: part.toolCall, partIndex } : null)
        .filter((value): value is { toolCall: ToolCallInfo; partIndex: number } => value !== null)
        ?? [];
      const existing = toolCallParts.map((value) => value.toolCall);
      const idx = resolveToolCallIndex(existing, item.id, item.type);

      if (idx >= 0) {
        return ensureDraft(
          baseState,
          (d) => {
            const partIndex = toolCallParts[idx]!.partIndex;
            const updatedParts = [...d.parts];
            updatedParts[partIndex] = {
              kind: "tool-call",
              toolCall: nextTool(existing[idx]!),
            };
            return { ...d, parts: updatedParts };
          },
          generateId,
        );
      }

      const updatedMessages = updateToolInMessages(
        baseState.messages,
        item,
        nextTool,
      );

      if (updatedMessages.updated) {
        return {
          ...baseState,
          messages: updatedMessages.messages,
        };
      }

      return ensureDraft(
        baseState,
        (d) => ({
          ...d,
          parts: [
            ...d.parts,
            {
              kind: "tool-call",
              toolCall: {
                ...buildToolCallInfoFromItem(item, {
                  phase,
                  sourceInput: pendingInput?.input,
                  sourceToolName: pendingInput?.toolName,
                }),
                state: resolveState(),
              },
            },
          ],
        }),
        generateId,
      );
    })

    .with({ event: "toolInput" }, (c) => {
      const applyInput = (toolCall: ToolCallInfo): ToolCallInfo => ({
        ...toolCall,
        sourceInput: c.payload.input,
        sourceToolName: c.payload.toolName,
      });

      const partIndex = state.draft?.parts.findIndex(
        (part) => part.kind === "tool-call" && part.toolCall.id === c.payload.itemId,
      ) ?? -1;

      if (partIndex >= 0) {
        return ensureDraft(
          {
            ...state,
            pendingToolInputs: dropPendingToolInput(state.pendingToolInputs, c.payload.itemId),
          },
          (d) => {
            const part = d.parts[partIndex] as Extract<ChatMessagePart, { kind: "tool-call" }>;
            const updatedParts = [...d.parts];
            updatedParts[partIndex] = {
              kind: "tool-call",
              toolCall: applyInput(part.toolCall),
            };
            return { ...d, parts: updatedParts };
          },
          generateId,
        );
      }

      const updatedMessages = updateToolByIdInMessages(
        state.messages,
        c.payload.itemId,
        applyInput,
      );

      if (updatedMessages.updated) {
        return {
          ...state,
          messages: updatedMessages.messages,
          pendingToolInputs: dropPendingToolInput(state.pendingToolInputs, c.payload.itemId),
        };
      }

      return {
        ...state,
        pendingToolInputs: {
          ...state.pendingToolInputs,
          [c.payload.itemId]: {
            toolName: c.payload.toolName,
            input: c.payload.input,
          },
        },
      };
    })

    .with({ event: "toolDelta" }, (c) => {
      const partIndex = state.draft?.parts.findIndex(
        (p) => p.kind === 'tool-call' && p.toolCall.id === c.payload.itemId,
      ) ?? -1;

      if (partIndex >= 0) {
        return ensureDraft(
          state,
          (d) => {
            const part = d.parts[partIndex] as Extract<ChatMessagePart, { kind: 'tool-call' }>;
            const updatedParts = [...d.parts];
            const previousReasoningIndex = part.toolCall.reasoningSummaryIndex ?? 0;
            const nextReasoningIndex = c.payload.reasoningSummaryIndex;
            const reasoningSeparator = part.toolCall.type === 'reasoning'
              && typeof nextReasoningIndex === 'number'
              && nextReasoningIndex > previousReasoningIndex
              && (part.toolCall.output ?? '').length > 0
              ? "\n\n"
              : "";
            const nextOutput = (part.toolCall.output ?? "") + reasoningSeparator + c.payload.text;
            updatedParts[partIndex] = {
              kind: 'tool-call',
              toolCall: {
                ...part.toolCall,
                output: nextOutput,
                reasoningSummaryIndex: typeof nextReasoningIndex === 'number'
                  ? nextReasoningIndex
                  : part.toolCall.reasoningSummaryIndex,
                state: part.toolCall.state,
              },
            };
            return { ...d, parts: updatedParts };
          },
          generateId,
        );
      }

      const updatedMessages = updateToolByIdInMessages(
        state.messages,
        c.payload.itemId,
        (toolCall) => {
          const previousReasoningIndex = toolCall.reasoningSummaryIndex ?? 0;
          const nextReasoningIndex = c.payload.reasoningSummaryIndex;
          const reasoningSeparator = toolCall.type === 'reasoning'
            && typeof nextReasoningIndex === 'number'
            && nextReasoningIndex > previousReasoningIndex
            && (toolCall.output ?? '').length > 0
            ? "\n\n"
            : "";
          return {
            ...toolCall,
            output: (toolCall.output ?? "") + reasoningSeparator + c.payload.text,
            reasoningSummaryIndex: typeof nextReasoningIndex === 'number'
              ? nextReasoningIndex
              : toolCall.reasoningSummaryIndex,
            state: toolCall.state,
          };
        },
      );

      if (updatedMessages.updated) {
        return {
          ...state,
          messages: updatedMessages.messages,
        };
      }

      return state;
    })

    .with({ event: "terminalInteraction" }, (c) => {
      const nextBackgroundState = c.payload.stdin.trim().length > 0
        ? "interacted"
        : "waiting";
      const nextTool = (toolCall: ToolCallInfo): ToolCallInfo => ({
        ...toolCall,
        processId: c.payload.processId,
        backgroundState: nextBackgroundState,
        backgroundInput: c.payload.stdin,
      });

      const partIndex = state.draft?.parts.findIndex(
        (p) => p.kind === 'tool-call' && p.toolCall.id === c.payload.itemId,
      ) ?? -1;

      if (partIndex >= 0) {
        return ensureDraft(
          state,
          (d) => {
            const part = d.parts[partIndex] as Extract<ChatMessagePart, { kind: 'tool-call' }>;
            const updatedParts = [...d.parts];
            updatedParts[partIndex] = {
              kind: 'tool-call',
              toolCall: nextTool(part.toolCall),
            };
            return { ...d, parts: updatedParts };
          },
          generateId,
        );
      }

      const updatedMessages = updateToolByIdInMessages(
        state.messages,
        c.payload.itemId,
        nextTool,
      );

      if (updatedMessages.updated) {
        return {
          ...state,
          messages: updatedMessages.messages,
        };
      }

      return state;
    })

    .with({ event: "retrying" }, (c) => ({
      ...state,
      retrying: translateTurnError(c.payload.errorInfo),
    }))

    .with({ event: "error" }, (c) => ({
      ...state,
      error: formatTurnErrorDescriptor(c.payload.errorInfo),
      errorDetails: c.payload.additionalDetails ?? null,
    }))

    .with({ event: "completed" }, (c) => {
      const previousError = state.error;
      const previousErrorDetails = state.errorDetails;
      const previousRetrying = state.retrying;
      const s = settleLoadingToolCalls({
        ...state,
        retrying: null,
        pendingToolInputs: {},
      });
      if (c.payload.status === "failed") {
        if (c.payload.error === null) {
          // Preserve a prior non-retryable streamError message when the failed
          // completion payload has no turn error details.
          if (s.error) {
            return s;
          }
          return {
            ...s,
            error: tr("errors.chat.turnFailed"),
            errorDetails: null,
          };
        }

        const turnError = c.payload.error;
        return {
          ...s,
          error: formatTurnError(turnError, c.payload.turnErrorContext),
          errorDetails: turnError.additionalDetails ?? null,
        };
      }
      if (c.payload.status === "interrupted") {
        if (c.payload.error) {
          return {
            ...s,
            error: formatTurnError(c.payload.error, c.payload.turnErrorContext),
            errorDetails: c.payload.error.additionalDetails ?? null,
          };
        }

        if (previousError) {
          return {
            ...s,
            error: previousError,
            errorDetails: previousErrorDetails,
          };
        }

        if (previousRetrying) {
          return {
            ...s,
            error: tr("errors.chat.connectionLost"),
            errorDetails: null,
          };
        }
      }
      const responsesContractError = getResponsesToolCallingContractError(
        state.draft && !hasToolCalls(state.draft)
          ? textContent(state.draft)
          : null,
      );
      if (responsesContractError) {
        return {
          ...s,
          draft: s.draft
            ? {
                ...s.draft,
                parts: s.draft.parts.filter((part) => part.kind === "tool-call"),
            }
            : null,
          error: formatTurnErrorDescriptor(
            describeFormattedTurnError(responsesContractError),
          ),
          errorDetails: null,
        };
      }
      return { ...s, error: null, errorDetails: null };
    })

    .exhaustive();

  return { state: nextState, sideEffects };
}
