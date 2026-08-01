import { match } from "ts-pattern";
import type { v2 } from "../../../server/handlers/codex-generated-types/index";

import {
  describeTurnError,
  formatTurnError,
  isTurnErrorDescriptorKey,
  type TurnErrorDescriptor,
  type TurnErrorFormattingContext,
} from "./errors";
import { type AppServerNotification, SERVER_METHOD } from "./protocol";
import { userInputToText } from "./user-input-to-text";

export type UiStreamEvent =
  | { event: "delta"; payload: { text: string; itemId?: string } }
  | { event: "final"; payload: { text: string; itemId?: string } }
  | { event: "compacted"; payload: { threadId: string; turnId: string } }
  | { event: "userMessage"; payload: { text: string; itemId: string } }
  | {
      event: "planUpdated";
      payload: {
        threadId: string;
        turnId: string;
        explanation: string | null;
        plan: v2.TurnPlanStep[];
      };
    }
  | {
      event: "tool";
      payload: {
        phase: "started" | "completed";
        type: v2.ThreadItem["type"];
        item: v2.ThreadItem;
      };
    }
  | {
      event: "toolDelta";
      payload: { itemId: string; text: string; reasoningSummaryIndex?: number };
    }
  | {
      event: "toolInput";
      payload: { itemId: string; toolName: string; input: string };
    }
  | {
      event: "terminalInteraction";
      payload: {
        itemId: string;
        processId: string;
        stdin: string;
      };
    }
  | {
      event: "completed";
      payload: {
        turnId: string;
        status: v2.TurnStatus;
        error: v2.TurnError | null;
        turnErrorContext?: TurnErrorFormattingContext;
      };
    }
  | { event: "retrying"; payload: { errorInfo: TurnErrorDescriptor } }
  | {
      event: "error";
      payload: {
        errorInfo: TurnErrorDescriptor;
        additionalDetails?: string | null;
      };
    };

export type SseStreamEvent =
  | UiStreamEvent
  | { event: "thread"; payload: { threadId: string } }
  | { event: "threadName"; payload: { threadId: string; name: string | null } }
  | {
      event: "turn";
      payload: { threadId: string; turnId: string; status: v2.TurnStatus };
    };

const NON_TOOL_ITEM_TYPES = new Set<v2.ThreadItem["type"]>([
  "userMessage",
  "agentMessage",
]);

const LOW_SIGNAL_COMMENTARY_PATTERNS = [
  /^using the .+ (?:skill|workflow)\b/i,
  /^i(?:'m| am) using (?:python|openpyxl|python-docx|python-pptx|artifact-tool)\b/i,
  /^i(?:'ll| will) inspect the (?:workbook|spreadsheet|document|file)\b/i,
  /^the first discovery command failed\b/i,
  /^the bundled skill path isn't present\b/i,
  /^i(?:'m| am) using the document's spreadsheet workflow guidance now\b/i,
];

function shouldHideLowSignalCommentary(item: Extract<v2.ThreadItem, { type: "agentMessage" }>): boolean {
  if (item.phase !== "commentary") {
    return false;
  }

  const normalized = item.text.trim();
  if (!normalized) {
    return false;
  }

  return LOW_SIGNAL_COMMENTARY_PATTERNS.some((pattern) => pattern.test(normalized));
}

function hasTurnErrorFormattingContext(
  context: TurnErrorFormattingContext,
): boolean {
  return Boolean(
    context.hasImageInput !== undefined
    || context.isChatGptProfile !== undefined
    || context.modelId
    || context.modelProvider
    || context.providerLabel,
  );
}

export function mapNotificationToUiEvents(
  notification: AppServerNotification,
  turnErrorContext: TurnErrorFormattingContext = {},
): UiStreamEvent[] {
  return match(notification)
    .with({ method: SERVER_METHOD.agentMessageDelta }, (n) => [
      { event: "delta" as const, payload: { text: n.params.delta, itemId: n.params.itemId } },
    ])
    .with({ method: SERVER_METHOD.reasoningSummaryTextDelta }, (n) => [
      {
        event: "toolDelta" as const,
        payload: {
          itemId: n.params.itemId,
          text: n.params.delta,
          reasoningSummaryIndex: n.params.summaryIndex,
        },
      },
    ])
    .with({ method: SERVER_METHOD.reasoningTextDelta }, (n) => [
      {
        event: "toolDelta" as const,
        payload: { itemId: n.params.itemId, text: n.params.delta },
      },
    ])
    .with({ method: SERVER_METHOD.reasoningSummaryPartAdded }, () => [])
    .with({ method: SERVER_METHOD.threadCompacted }, (n) => [
      {
        event: "compacted" as const,
        payload: {
          threadId: n.params.threadId,
          turnId: n.params.turnId,
        },
      },
    ])
    .with({ method: SERVER_METHOD.turnPlanUpdated }, (n) => [
      {
        event: "planUpdated" as const,
        payload: {
          threadId: n.params.threadId,
          turnId: n.params.turnId,
          explanation: n.params.explanation,
          plan: n.params.plan,
        },
      },
    ])
    .with({ method: SERVER_METHOD.rawResponseItemCompleted }, (n) => {
      if (n.params.item.type !== "custom_tool_call") {
        return [];
      }

      return [{
        event: "toolInput" as const,
        payload: {
          itemId: n.params.item.call_id,
          toolName: n.params.item.name,
          input: n.params.item.input,
        },
      }];
    })
    .with({ method: SERVER_METHOD.commandExecutionOutputDelta }, (n) => [
      {
        event: "toolDelta" as const,
        payload: { itemId: n.params.itemId, text: n.params.delta },
      },
    ])
    .with({ method: SERVER_METHOD.commandExecutionTerminalInteraction }, (n) => [
      {
        event: "terminalInteraction" as const,
        payload: {
          itemId: n.params.itemId,
          processId: n.params.processId,
          stdin: n.params.stdin,
        },
      },
    ])
    .with({ method: SERVER_METHOD.fileChangeOutputDelta }, (n) => [
      {
        event: "toolDelta" as const,
        payload: { itemId: n.params.itemId, text: n.params.delta },
      },
    ])
    .with({ method: SERVER_METHOD.mcpToolCallProgress }, (n) => [
      {
        event: "toolDelta" as const,
        payload: { itemId: n.params.itemId, text: n.params.message },
      },
    ])
    .with(
      { method: SERVER_METHOD.itemStarted },
      { method: SERVER_METHOD.itemCompleted },
      (n) => {
        const item = n.params.item;

        if (
          n.method === SERVER_METHOD.itemCompleted &&
          item.type === "userMessage"
        ) {
          return [{
            event: "userMessage" as const,
            payload: {
              text: userInputToText(item.content),
              itemId: item.id,
            },
          }];
        }

        if (
          n.method === SERVER_METHOD.itemCompleted &&
          item.type === "agentMessage" &&
          item.text.trim()
        ) {
          if (shouldHideLowSignalCommentary(item)) {
            return [];
          }
          return [{ event: "final" as const, payload: { text: item.text, itemId: item.id } }];
        }

        if (NON_TOOL_ITEM_TYPES.has(item.type)) {
          return [];
        }

        return [
          {
            event: "tool" as const,
            payload: {
              phase:
                n.method === SERVER_METHOD.itemStarted
                  ? ("started" as const)
                  : ("completed" as const),
              type: item.type,
              item,
            },
          },
        ];
      },
    )
    .with({ method: SERVER_METHOD.turnCompleted }, (n) => [
      {
        event: "completed" as const,
        payload: {
          turnId: n.params.turn.id,
          status: n.params.turn.status,
          error: n.params.turn.error,
          ...(hasTurnErrorFormattingContext(turnErrorContext)
            ? { turnErrorContext }
            : {}),
        },
      },
    ])
    .with({ method: SERVER_METHOD.streamError }, (n) => {
      const errorInfo = describeTurnError(n.params.error, turnErrorContext);
      const formattedError = formatTurnError(n.params.error, turnErrorContext);
      if (n.params.willRetry) {
        if (isTurnErrorDescriptorKey(errorInfo, "errors.turn.insufficientTokens")) {
          return [
            {
              event: "error" as const,
              payload: {
                errorInfo,
                additionalDetails: n.params.error.additionalDetails,
              },
            },
          ];
        }
        const retryInfo = isTurnErrorDescriptorKey(errorInfo, "errors.turn.responseStreamDisconnected")
          ? { kind: "raw" as const, text: n.params.error.message }
          : errorInfo;
        return [
          {
            event: "retrying" as const,
            payload: { errorInfo: retryInfo },
          },
        ];
      }
      const formattedErrorMessage = formattedError;
      const hasStructuredErrorInfo = n.params.error.codexErrorInfo !== null;
      const useFormattedErrorMessage = hasStructuredErrorInfo
        || formattedErrorMessage !== n.params.error.message;
      const errorMessage = useFormattedErrorMessage
        ? formattedErrorMessage
        : n.params.error.additionalDetails
          ? `${n.params.error.message}\n${n.params.error.additionalDetails}`
          : n.params.error.message;
      return [
        {
          event: "error" as const,
          payload: {
            errorInfo: useFormattedErrorMessage
              ? errorInfo
              : { kind: "raw" as const, text: errorMessage },
            additionalDetails: n.params.error.additionalDetails,
          },
        },
      ];
    })
    .otherwise(() => []);
}
