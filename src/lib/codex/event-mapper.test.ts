import { describe, test } from "bun:test";
import assert from "node:assert/strict";

import { mapNotificationToUiEvents, type UiStreamEvent } from "@/lib/codex/event-mapper";
import {
  formatTurnErrorDescriptor,
  INTERPRETER_HOSTED_OVERLOADED_MESSAGE,
} from "@/lib/codex/errors";
import { type NotificationOfMethod, SERVER_METHOD } from "@/lib/codex/protocol";

const LMSTUDIO_SINGLE_TOOL_CALL_TEMPLATE_ERROR =
  'stream disconnected before completion: Error rendering prompt with jinja template: "This model only supports single tool-calls at once!". This is usually an issue with the model\'s chat template.';
const EXPECTED_LMSTUDIO_TOOL_SUPPORT_GUIDANCE = [
  LMSTUDIO_SINGLE_TOOL_CALL_TEMPLATE_ERROR,
  "",
  "The selected model from LM Studio doesn't support Interpreter tools.",
  "Choose a tool-capable model in LM Studio, or switch to an Interpreter hosted model, then retry.",
].join("\n");
const IMAGE_INPUT_ROUTE_UNAVAILABLE_MESSAGE =
  "This model is not available through an image-capable route, so it cannot inspect screenshots or images.";

function eventPayloadMessage(event: UiStreamEvent | undefined): string | undefined {
  if (!event) return undefined;
  if (event.event !== "error" && event.event !== "retrying") return undefined;
  return formatTurnErrorDescriptor(event.payload.errorInfo);
}

describe("mapNotificationToUiEvents", () => {
  test("maps agent message delta", () => {
    const notification: NotificationOfMethod<
      typeof SERVER_METHOD.agentMessageDelta
    > = {
      method: SERVER_METHOD.agentMessageDelta,
      params: {
        threadId: "thr_1",
        turnId: "turn_1",
        itemId: "item_1",
        delta: "hello",
      },
    };

    assert.deepEqual(mapNotificationToUiEvents(notification), [
      { event: "delta", payload: { text: "hello", itemId: "item_1" } },
    ]);
  });

  test("maps reasoning summary delta to toolDelta", () => {
    const notification: NotificationOfMethod<
      typeof SERVER_METHOD.reasoningSummaryTextDelta
    > = {
      method: SERVER_METHOD.reasoningSummaryTextDelta,
      params: {
        threadId: "thr_1",
        turnId: "turn_1",
        itemId: "item_1",
        delta: "thinking",
        summaryIndex: 0,
      },
    };

    assert.deepEqual(mapNotificationToUiEvents(notification), [
      { event: "toolDelta", payload: { itemId: "item_1", text: "thinking", reasoningSummaryIndex: 0 } },
    ]);
  });

  test("maps reasoning text delta to toolDelta", () => {
    const notification: NotificationOfMethod<
      typeof SERVER_METHOD.reasoningTextDelta
    > = {
      method: SERVER_METHOD.reasoningTextDelta,
      params: {
        threadId: "thr_1",
        turnId: "turn_1",
        itemId: "item_1",
        delta: "thinking",
        contentIndex: 0,
      },
    };

    assert.deepEqual(mapNotificationToUiEvents(notification), [
      { event: "toolDelta", payload: { itemId: "item_1", text: "thinking" } },
    ]);
  });

  test("maps thread compacted notification", () => {
    const notification: NotificationOfMethod<
      typeof SERVER_METHOD.threadCompacted
    > = {
      method: SERVER_METHOD.threadCompacted,
      params: {
        threadId: "thr_1",
        turnId: "turn_1",
      },
    };

    assert.deepEqual(mapNotificationToUiEvents(notification), [
      {
        event: "compacted",
        payload: {
          threadId: "thr_1",
          turnId: "turn_1",
        },
      },
    ]);
  });

  test("maps plan updates", () => {
    const notification: NotificationOfMethod<
      typeof SERVER_METHOD.turnPlanUpdated
    > = {
      method: SERVER_METHOD.turnPlanUpdated,
      params: {
        threadId: "thr_1",
        turnId: "turn_1",
        explanation: "Check the deliverable before final response.",
        plan: [
          { step: "Inspect the workbook", status: "completed" },
          { step: "Write the requested values", status: "inProgress" },
        ],
      },
    };

    assert.deepEqual(mapNotificationToUiEvents(notification), [
      {
        event: "planUpdated",
        payload: {
          threadId: "thr_1",
          turnId: "turn_1",
          explanation: "Check the deliverable before final response.",
          plan: [
            { step: "Inspect the workbook", status: "completed" },
            { step: "Write the requested values", status: "inProgress" },
          ],
        },
      },
    ]);
  });

  test("maps raw custom tool input to toolInput", () => {
    const notification: NotificationOfMethod<
      typeof SERVER_METHOD.rawResponseItemCompleted
    > = {
      method: SERVER_METHOD.rawResponseItemCompleted,
      params: {
        threadId: "thr_1",
        turnId: "turn_1",
        item: {
          type: "custom_tool_call",
          call_id: "call_1",
          name: "js_repl",
          input: 'await page.goto("https://example.com");',
        },
      },
    };

    assert.deepEqual(mapNotificationToUiEvents(notification), [
      {
        event: "toolInput",
        payload: {
          itemId: "call_1",
          toolName: "js_repl",
          input: 'await page.goto("https://example.com");',
        },
      },
    ]);
  });

  test("maps command execution output delta", () => {
    const notification: NotificationOfMethod<
      typeof SERVER_METHOD.commandExecutionOutputDelta
    > = {
      method: SERVER_METHOD.commandExecutionOutputDelta,
      params: {
        threadId: "thr_1",
        turnId: "turn_1",
        itemId: "cmd_1",
        delta: "line 1",
      },
    };

    assert.deepEqual(mapNotificationToUiEvents(notification), [
      { event: "toolDelta", payload: { itemId: "cmd_1", text: "line 1" } },
    ]);
  });

  test("maps terminal interaction to terminalInteraction", () => {
    const notification: NotificationOfMethod<
      typeof SERVER_METHOD.commandExecutionTerminalInteraction
    > = {
      method: SERVER_METHOD.commandExecutionTerminalInteraction,
      params: {
        threadId: "thr_1",
        turnId: "turn_1",
        itemId: "cmd_1",
        processId: "1000",
        stdin: "",
      },
    };

    assert.deepEqual(mapNotificationToUiEvents(notification), [
      {
        event: "terminalInteraction",
        payload: { itemId: "cmd_1", processId: "1000", stdin: "" },
      },
    ]);
  });

  test("maps mcp tool progress to tool delta", () => {
    const notification: NotificationOfMethod<
      typeof SERVER_METHOD.mcpToolCallProgress
    > = {
      method: SERVER_METHOD.mcpToolCallProgress,
      params: {
        threadId: "thr_1",
        turnId: "turn_1",
        itemId: "mcp_1",
        message: "fetching...",
      },
    };

    assert.deepEqual(mapNotificationToUiEvents(notification), [
      {
        event: "toolDelta",
        payload: { itemId: "mcp_1", text: "fetching..." },
      },
    ]);
  });

  test("maps tool item lifecycle", () => {
    const started: NotificationOfMethod<typeof SERVER_METHOD.itemStarted> = {
      method: SERVER_METHOD.itemStarted,
      params: {
        threadId: "thr_1",
        turnId: "turn_1",
        item: {
          type: "commandExecution",
          id: "cmd_1",
          command: "ls",
          cwd: "/tmp",
          processId: null,
          status: "inProgress",
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      },
    };

    const startedEvent = mapNotificationToUiEvents(started);
    assert.equal(startedEvent.length, 1);
    assert.equal(startedEvent[0]?.event, "tool");
    if (startedEvent[0]?.event === "tool") {
      assert.equal(startedEvent[0].payload.phase, "started");
      assert.equal(startedEvent[0].payload.type, "commandExecution");
    }
  });

  test("maps completed agent message item", () => {
    const notification: NotificationOfMethod<
      typeof SERVER_METHOD.itemCompleted
    > = {
      method: SERVER_METHOD.itemCompleted,
      params: {
        threadId: "thr_1",
        turnId: "turn_1",
        item: {
          type: "agentMessage",
          id: "msg_1",
          text: "final response",
        },
      },
    };

    assert.deepEqual(mapNotificationToUiEvents(notification), [
      { event: "final", payload: { text: "final response", itemId: "msg_1" } },
    ]);
  });

  test("suppresses low-signal commentary agent messages", () => {
    const notification: NotificationOfMethod<
      typeof SERVER_METHOD.itemCompleted
    > = {
      method: SERVER_METHOD.itemCompleted,
      params: {
        threadId: "thr_1",
        turnId: "turn_1",
        item: {
          type: "agentMessage",
          id: "msg_2",
          text: "Using the PowerPoint workflow to create an executive one-slide deck in `.pptx` format.",
          phase: "commentary",
          memoryCitation: null,
        },
      },
    };

    assert.deepEqual(mapNotificationToUiEvents(notification), []);
  });

  test("keeps substantive commentary agent messages", () => {
    const notification: NotificationOfMethod<
      typeof SERVER_METHOD.itemCompleted
    > = {
      method: SERVER_METHOD.itemCompleted,
      params: {
        threadId: "thr_1",
        turnId: "turn_1",
        item: {
          type: "agentMessage",
          id: "msg_3",
          text: "Plan: draft the slide, build the deck, then verify the text and structure.",
          phase: "commentary",
          memoryCitation: null,
        },
      },
    };

    assert.deepEqual(mapNotificationToUiEvents(notification), [
      {
        event: "final",
        payload: {
          text: "Plan: draft the slide, build the deck, then verify the text and structure.",
          itemId: "msg_3",
        },
      },
    ]);
  });

  test("should_emit_tool_event_for_reasoning_item", () => {
    const notification: NotificationOfMethod<
      typeof SERVER_METHOD.itemStarted
    > = {
      method: SERVER_METHOD.itemStarted,
      params: {
        threadId: "thr_1",
        turnId: "turn_1",
        item: {
          type: "reasoning",
          id: "rs_1",
          summary: [],
          content: [],
        },
      },
    };

    const events = mapNotificationToUiEvents(notification);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, "tool");
    if (events[0]?.event === "tool") {
      assert.equal(events[0].payload.phase, "started");
      assert.equal(events[0].payload.type, "reasoning");
    }
  });

  test("does not emit separate paragraph-break events for reasoning parts", () => {
    const notification: NotificationOfMethod<
      typeof SERVER_METHOD.reasoningSummaryPartAdded
    > = {
      method: SERVER_METHOD.reasoningSummaryPartAdded,
      params: {
        threadId: "thr_1",
        turnId: "turn_1",
        itemId: "rs_1",
        summaryIndex: 1,
      },
    };

    assert.deepEqual(mapNotificationToUiEvents(notification), []);
  });

  test("maps completed user message item", () => {
    const notification: NotificationOfMethod<
      typeof SERVER_METHOD.itemCompleted
    > = {
      method: SERVER_METHOD.itemCompleted,
      params: {
        threadId: "thr_1",
        turnId: "turn_1",
        item: {
          type: "userMessage",
          id: "msg_1",
          content: [{
            type: "text",
            text: "follow up",
            text_elements: [],
          }],
        },
      },
    };

    assert.deepEqual(mapNotificationToUiEvents(notification), [
      { event: "userMessage", payload: { text: "follow up", itemId: "msg_1" } },
    ]);
  });

  test("maps turn completion", () => {
    const notification: NotificationOfMethod<
      typeof SERVER_METHOD.turnCompleted
    > = {
      method: SERVER_METHOD.turnCompleted,
      params: {
        threadId: "thr_1",
        turn: {
          id: "turn_1",
          items: [],
          status: "completed",
          error: null,
        },
      },
    };

    assert.deepEqual(mapNotificationToUiEvents(notification), [
      {
        event: "completed",
        payload: { turnId: "turn_1", status: "completed", error: null },
      },
    ]);
  });

  test("emits retrying when streamError has willRetry true", () => {
    const notification: NotificationOfMethod<typeof SERVER_METHOD.streamError> =
      {
        method: SERVER_METHOD.streamError,
        params: {
          threadId: "thr_1",
          turnId: "turn_1",
          willRetry: true,
          error: {
            message: "transient failure",
            codexErrorInfo: null,
            additionalDetails: null,
          },
        },
    };

    assert.deepEqual(mapNotificationToUiEvents(notification), [
      {
        event: "retrying",
        payload: { errorInfo: { kind: "raw", text: "transient failure" } },
      },
    ]);
  });

  test("emits error immediately when a retrying streamError reports exhausted Interpreter tokens", () => {
    const notification: NotificationOfMethod<typeof SERVER_METHOD.streamError> =
      {
        method: SERVER_METHOD.streamError,
        params: {
          threadId: "thr_1",
          turnId: "turn_1",
          willRetry: true,
          error: {
            message:
              'unexpected status 402 Payment Required: {"error":{"detail":"[not_enough_tokens]: Insufficient interpreter tokens"}}',
            codexErrorInfo: null,
            additionalDetails: null,
          },
        },
      };

    assert.deepEqual(mapNotificationToUiEvents(notification), [
      {
        event: "error",
        payload: {
          errorInfo: { kind: "key", key: "errors.turn.insufficientTokens" },
          additionalDetails: null,
        },
      },
    ]);
  });

  test("emits error when streamError has willRetry false", () => {
    const notification: NotificationOfMethod<typeof SERVER_METHOD.streamError> =
      {
        method: SERVER_METHOD.streamError,
        params: {
          threadId: "thr_1",
          turnId: "turn_1",
          willRetry: false,
          error: {
            message: "boom",
            codexErrorInfo: null,
            additionalDetails: null,
          },
        },
      };

    assert.deepEqual(mapNotificationToUiEvents(notification), [
      {
        event: "error",
        payload: {
          errorInfo: { kind: "raw", text: "boom" },
          additionalDetails: null,
        },
      },
    ]);
  });

  test("formats unstructured streamError auth failures", () => {
    const notification: NotificationOfMethod<typeof SERVER_METHOD.streamError> =
      {
        method: SERVER_METHOD.streamError,
        params: {
          threadId: "thr_1",
          turnId: "turn_1",
          willRetry: false,
          error: {
            message:
              "unexpected status 401 Unauthorized: Missing Authentication header, url: https://openrouter.ai/api/v1/responses",
            codexErrorInfo: null,
            additionalDetails: null,
          },
        },
      };

    const events = mapNotificationToUiEvents(notification);
    assert.deepEqual(events, [
      {
        event: "error",
        payload: {
          errorInfo: { kind: "key", key: "errors.turn.authGeneric" },
          additionalDetails: null,
        },
      },
    ]);
    assert.equal(events[0]?.event, "error");
    if (events[0]?.event === "error") {
      assert.equal(
        eventPayloadMessage(events[0]),
        "Authentication failed. Check your API key, or sign in again if using hosted models.",
      );
    }
  });

  test("maps LM Studio jinja template failure to actionable upstream error", () => {
    const notification: NotificationOfMethod<typeof SERVER_METHOD.streamError> =
      {
        method: SERVER_METHOD.streamError,
        params: {
          threadId: "thr_1",
          turnId: "turn_1",
          willRetry: false,
          error: {
            message:
              'Error rendering prompt with jinja template: "No user query found in messages."',
            codexErrorInfo: null,
            additionalDetails: null,
          },
        },
      };

    const events = mapNotificationToUiEvents(notification, {
      modelProvider: "lmstudio-5a96e840",
      providerLabel: "LM Studio",
    });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, "error");
    if (events[0]?.event === "error") {
      assert.match(eventPayloadMessage(events[0]), /selected model from LM Studio/i);
      assert.match(eventPayloadMessage(events[0]), /No user query found in messages/i);
      assert.match(eventPayloadMessage(events[0]), /Choose a tool-capable model in LM Studio/i);
    }
  });

  test("maps LM Studio single-tool-call jinja stream failure to actionable upstream error", () => {
    const notification: NotificationOfMethod<typeof SERVER_METHOD.streamError> =
      {
        method: SERVER_METHOD.streamError,
        params: {
          threadId: "thr_1",
          turnId: "turn_1",
          willRetry: false,
          error: {
            message: LMSTUDIO_SINGLE_TOOL_CALL_TEMPLATE_ERROR,
            codexErrorInfo: null,
            additionalDetails: null,
          },
        },
      };

    const events = mapNotificationToUiEvents(notification, {
      modelProvider: "lmstudio-5a96e840",
      providerLabel: "LM Studio",
    });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, "error");
    if (events[0]?.event === "error") {
      assert.equal(eventPayloadMessage(events[0]), EXPECTED_LMSTUDIO_TOOL_SUPPORT_GUIDANCE);
    }
  });

  test("maps LM Studio invalid input union after image input to image guidance", () => {
    const notification: NotificationOfMethod<typeof SERVER_METHOD.streamError> =
      {
        method: SERVER_METHOD.streamError,
        params: {
          threadId: "thr_1",
          turnId: "turn_1",
          willRetry: false,
          error: {
            message: JSON.stringify({
              error: {
                message: "Invalid type for 'input'.",
                type: "invalid_request_error",
                param: "input",
                code: "invalid_union",
              },
            }),
            codexErrorInfo: "other",
            additionalDetails: null,
          },
        },
      };

    const events = mapNotificationToUiEvents(notification, {
      hasImageInput: true,
      modelProvider: "lmstudio-5a96e840",
      providerLabel: "LM Studio",
    });

    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, "error");
    if (events[0]?.event === "error") {
      assert.equal(eventPayloadMessage(events[0]), IMAGE_INPUT_ROUTE_UNAVAILABLE_MESSAGE);
    }
  });

  test("keeps invalid input union after image input as contract guidance for other providers", () => {
    const notification: NotificationOfMethod<typeof SERVER_METHOD.streamError> =
      {
        method: SERVER_METHOD.streamError,
        params: {
          threadId: "thr_1",
          turnId: "turn_1",
          willRetry: false,
          error: {
            message: JSON.stringify({
              error: {
                message: "Invalid type for 'input'.",
                type: "invalid_request_error",
                param: "input",
                code: "invalid_union",
              },
            }),
            codexErrorInfo: "other",
            additionalDetails: null,
          },
        },
      };

    const events = mapNotificationToUiEvents(notification, {
      hasImageInput: true,
      modelProvider: "openrouter",
      providerLabel: "OpenRouter",
    });

    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, "error");
    if (events[0]?.event === "error") {
      assert.equal(
        eventPayloadMessage(events[0]),
        "The selected model on OpenRouter does not support Interpreter's Responses/tool-calling contract.",
      );
    }
  });

  // ── streamError drops codexErrorInfo ────────────────────────────────
  // When the Codex app-server sends a non-retryable streamError with
  // structured codexErrorInfo, the event mapper should use formatTurnError
  // so the UI shows a friendly message instead of the raw Codex string.

  test("should_format_streamError_with_codexErrorInfo_unauthorized", () => {
    const notification: NotificationOfMethod<typeof SERVER_METHOD.streamError> =
      {
        method: SERVER_METHOD.streamError,
        params: {
          threadId: "thr_1",
          turnId: "turn_1",
          willRetry: false,
          error: {
            message: "raw codex internal message",
            codexErrorInfo: "unauthorized",
            additionalDetails: null,
          },
        },
      };

    const events = mapNotificationToUiEvents(notification);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, "error");
    if (events[0]?.event === "error") {
      assert.equal(
        eventPayloadMessage(events[0]),
        "Authentication failed. Check your API key, or sign in again if using hosted models.",
      );
    }
  });

  test("should_format_streamError_with_httpConnectionFailed", () => {
    const notification: NotificationOfMethod<typeof SERVER_METHOD.streamError> =
      {
        method: SERVER_METHOD.streamError,
        params: {
          threadId: "thr_1",
          turnId: "turn_1",
          willRetry: false,
          error: {
            message: "terminated (code: UND_ERR_SOCKET)",
            codexErrorInfo: {
              httpConnectionFailed: { httpStatusCode: null },
            },
            additionalDetails: null,
          },
        },
      };

    const events = mapNotificationToUiEvents(notification);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, "error");
    if (events[0]?.event === "error") {
      assert.equal(eventPayloadMessage(events[0]), "Connection failed.");
    }
  });

  test("should_keep_formatted_generic_message_when_raw_structured_message_is_not_diagnostic", () => {
    const notification: NotificationOfMethod<typeof SERVER_METHOD.streamError> =
      {
        method: SERVER_METHOD.streamError,
        params: {
          threadId: "thr_1",
          turnId: "turn_1",
          willRetry: false,
          error: {
            message: "raw",
            codexErrorInfo: {
              httpConnectionFailed: { httpStatusCode: 500 },
            },
            additionalDetails: null,
          },
        },
      };

    const events = mapNotificationToUiEvents(notification);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, "error");
    if (events[0]?.event === "error") {
      assert.equal(eventPayloadMessage(events[0]), "Provider internal server error.");
    }
  });

  test("should_preserve_provider_diagnostic_message_when_structured_mapping_is_generic", () => {
    const notification: NotificationOfMethod<typeof SERVER_METHOD.streamError> =
      {
        method: SERVER_METHOD.streamError,
        params: {
          threadId: "thr_1",
          turnId: "turn_1",
          willRetry: false,
          error: {
            message:
              "We're currently experiencing high demand, which may cause temporary errors.",
            codexErrorInfo: {
              responseTooManyFailedAttempts: { httpStatusCode: 500 },
            },
            additionalDetails: null,
          },
        },
      };

    const events = mapNotificationToUiEvents(notification);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, "error");
    if (events[0]?.event === "error") {
      assert.equal(
        eventPayloadMessage(events[0]),
        "We're currently experiencing high demand, which may cause temporary errors.",
      );
    }
  });

  test("should_preserve_provider_diagnostic_message_when_internal_server_error_mapping_is_generic", () => {
    const notification: NotificationOfMethod<typeof SERVER_METHOD.streamError> =
      {
        method: SERVER_METHOD.streamError,
        params: {
          threadId: "thr_1",
          turnId: "turn_1",
          willRetry: false,
          error: {
            message:
              "We're currently experiencing high demand, which may cause temporary errors.",
            codexErrorInfo: "internalServerError",
            additionalDetails: null,
          },
        },
      };

    const events = mapNotificationToUiEvents(notification);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, "error");
    if (events[0]?.event === "error") {
      assert.equal(
        eventPayloadMessage(events[0]),
        "We're currently experiencing high demand, which may cause temporary errors.",
      );
    }
  });

  test("should_surface_hosted_high_demand_details_while_retrying", () => {
    const notification: NotificationOfMethod<typeof SERVER_METHOD.streamError> =
      {
        method: SERVER_METHOD.streamError,
        params: {
          threadId: "thr_1",
          turnId: "turn_1",
          willRetry: true,
          error: {
            message: "Reconnecting... 1/5",
            codexErrorInfo: {
              responseStreamDisconnected: { httpStatusCode: null },
            },
            additionalDetails:
              "We're currently experiencing high demand, which may cause temporary errors.",
          },
        },
      };

    const events = mapNotificationToUiEvents(notification, {
      modelProvider: "interpreter",
      providerLabel: "Hosted",
    });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, "retrying");
    if (events[0]?.event === "retrying") {
      assert.equal(eventPayloadMessage(events[0]), INTERPRETER_HOSTED_OVERLOADED_MESSAGE);
    }
  });

  test("should_format_streamError_with_responseStreamDisconnected_429", () => {
    const notification: NotificationOfMethod<typeof SERVER_METHOD.streamError> =
      {
        method: SERVER_METHOD.streamError,
        params: {
          threadId: "thr_1",
          turnId: "turn_1",
          willRetry: false,
          error: {
            message: "stream ended unexpectedly",
            codexErrorInfo: {
              responseStreamDisconnected: { httpStatusCode: 429 },
            },
            additionalDetails: null,
          },
        },
      };

    const events = mapNotificationToUiEvents(notification);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, "error");
    if (events[0]?.event === "error") {
      assert.equal(eventPayloadMessage(events[0]), "Rate limited. Try again later.");
    }
  });

  test("should_format_streamError_with_usageLimitExceeded", () => {
    const notification: NotificationOfMethod<typeof SERVER_METHOD.streamError> =
      {
        method: SERVER_METHOD.streamError,
        params: {
          threadId: "thr_1",
          turnId: "turn_1",
          willRetry: false,
          error: {
            message: "usage limit hit",
            codexErrorInfo: "usageLimitExceeded",
            additionalDetails: null,
          },
        },
      };

    const events = mapNotificationToUiEvents(notification);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, "error");
    if (events[0]?.event === "error") {
      assert.equal(
        eventPayloadMessage(events[0]),
        "Usage limit exceeded on your provider account. Try again later.",
      );
    }
  });

  test("should_format_streamError_with_usageLimitExceeded_using_chatgpt_account_context", () => {
    const notification: NotificationOfMethod<typeof SERVER_METHOD.streamError> =
      {
        method: SERVER_METHOD.streamError,
        params: {
          threadId: "thr_1",
          turnId: "turn_1",
          willRetry: false,
          error: {
            message:
              "Error running remote compact task: You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Mar 28th, 2026 1:52 PM.",
            codexErrorInfo: "usageLimitExceeded",
            additionalDetails: null,
          },
        },
      };

    const events = mapNotificationToUiEvents(notification, {
      isChatGptProfile: true,
    });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, "error");
    if (events[0]?.event === "error") {
      assert.equal(
        eventPayloadMessage(events[0]),
        "You've hit your ChatGPT usage limit. Try again at: Mar 28th, 2026 1:52 PM. This limit is set by your ChatGPT account and is separate from Interpreter plan usage shown in Settings.",
      );
    }
  });

  test("should_format_streamError_with_openai_api_usage_limit_context", () => {
    const notification: NotificationOfMethod<typeof SERVER_METHOD.streamError> =
      {
        method: SERVER_METHOD.streamError,
        params: {
          threadId: "thr_1",
          turnId: "turn_1",
          willRetry: false,
          error: {
            message: "Quota exceeded. Check your plan and billing details.",
            codexErrorInfo: "usageLimitExceeded",
            additionalDetails: null,
          },
        },
      };

    const events = mapNotificationToUiEvents(notification, {
      modelProvider: "openai-api",
      providerLabel: "OpenAI API",
    });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, "error");
    if (events[0]?.event === "error") {
      assert.equal(
        eventPayloadMessage(events[0]),
        "Usage limit exceeded on your OpenAI API account. ChatGPT Pro and Plus do not include OpenAI API usage.",
      );
    }
  });

  test("should_include_turn_error_context_on_completed_events_when_provided", () => {
    const notification: NotificationOfMethod<typeof SERVER_METHOD.turnCompleted> =
      {
        method: SERVER_METHOD.turnCompleted,
        params: {
          threadId: "thr_1",
          turn: {
            id: "turn_1",
            items: [],
            status: "failed",
            error: {
              message: "usage limit hit",
              codexErrorInfo: "usageLimitExceeded",
              additionalDetails: null,
            },
          },
        },
      };

    const events = mapNotificationToUiEvents(notification, { isChatGptProfile: true });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, "completed");
    if (events[0]?.event === "completed") {
      assert.deepEqual(events[0].payload.turnErrorContext, { isChatGptProfile: true });
    }
  });

  test("should_include_local_provider_turn_error_context_when_chatgpt_flag_is_false", () => {
    const notification: NotificationOfMethod<typeof SERVER_METHOD.turnCompleted> =
      {
        method: SERVER_METHOD.turnCompleted,
        params: {
          threadId: "thr_1",
          turn: {
            id: "turn_1",
            items: [],
            status: "failed",
            error: {
              message:
                "{\"error\":\"developer is not one of ['system', 'assistant', 'user', 'tool', 'function'] - 'messages.[0].role'\"}",
              codexErrorInfo: "other",
              additionalDetails: null,
            },
          },
        },
      };
    const turnErrorContext = {
      isChatGptProfile: false,
      modelId: "qwen3.5:4b",
      modelProvider: "ollama-62be5c93",
      providerLabel: "Ollama",
    };

    const events = mapNotificationToUiEvents(notification, turnErrorContext);

    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, "completed");
    if (events[0]?.event === "completed") {
      assert.deepEqual(events[0].payload.turnErrorContext, turnErrorContext);
    }
  });

  test("emits only completed for failed turn (no duplicate error)", () => {
    const notification: NotificationOfMethod<
      typeof SERVER_METHOD.turnCompleted
    > = {
      method: SERVER_METHOD.turnCompleted,
      params: {
        threadId: "thr_1",
        turn: {
          id: "turn_1",
          items: [],
          status: "failed",
          error: {
            message: "something broke",
            codexErrorInfo: "internalServerError",
            additionalDetails: null,
          },
        },
      },
    };

    const events = mapNotificationToUiEvents(notification);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, "completed");
    if (events[0]?.event === "completed") {
      assert.equal(events[0].payload.status, "failed");
      assert.equal(events[0].payload.error?.message, "something broke");
      assert.equal(
        events[0].payload.error?.codexErrorInfo,
        "internalServerError",
      );
    }
  });
});
