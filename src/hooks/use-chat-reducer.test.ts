import { describe, test, beforeEach } from "bun:test";
import assert from "node:assert/strict";

import {
  applyChatEvent,
  createInitialChatState,
  type ChatState,
  type ApplyResult,
} from "./use-chat-reducer";
import { textContent, msgToolCalls } from "./use-chat";
import type { SseStreamEvent } from "@/lib/codex/event-mapper";
import type { TurnErrorFormattingContext } from "@/lib/codex/errors";
import type { v2 } from "../../server/handlers/codex-generated-types/index";
import i18n from "@/i18n";

const LMSTUDIO_SINGLE_TOOL_CALL_TEMPLATE_ERROR =
  'stream disconnected before completion: Error rendering prompt with jinja template: "This model only supports single tool-calls at once!". This is usually an issue with the model\'s chat template.';
const EXPECTED_LMSTUDIO_TOOL_SUPPORT_GUIDANCE = [
  LMSTUDIO_SINGLE_TOOL_CALL_TEMPLATE_ERROR,
  "",
  "The selected model from LM Studio doesn't support Interpreter tools.",
  "Choose a tool-capable model in LM Studio, or switch to an Interpreter hosted model, then retry.",
].join("\n");

// ---------------------------------------------------------------------------
// Extracted item variants for strong typing
// ---------------------------------------------------------------------------

type McpToolCallItem = Extract<v2.ThreadItem, { type: "mcpToolCall" }>;
type ReasoningItem = Extract<v2.ThreadItem, { type: "reasoning" }>;
type CommandExecutionItem = Extract<v2.ThreadItem, { type: "commandExecution" }>;

// ---------------------------------------------------------------------------
// Deterministic ID generator
// ---------------------------------------------------------------------------

let idCounter: number;

function testGenerateId(): string {
  return `test-id-${++idCounter}`;
}

// ---------------------------------------------------------------------------
// Event factories
// ---------------------------------------------------------------------------

function threadEvent(threadId: string): SseStreamEvent {
  return { event: "thread", payload: { threadId } };
}

function turnEvent(turnId: string): SseStreamEvent {
  return {
    event: "turn",
    payload: { threadId: "thread_1", turnId, status: "inProgress" },
  };
}

function deltaEvent(text: string, itemId?: string): SseStreamEvent {
  return { event: "delta", payload: { text, itemId } };
}

function finalEvent(text: string, itemId?: string): SseStreamEvent {
  return { event: "final", payload: { text, itemId } };
}

function compactedEvent(turnId = "turn_1"): SseStreamEvent {
  return {
    event: "compacted",
    payload: { threadId: "thread_1", turnId },
  };
}

function userMessageEvent(text: string, itemId = "user_1"): SseStreamEvent {
  return { event: "userMessage", payload: { text, itemId } };
}

function threadNameEvent(
  threadId: string,
  name: string | null,
): SseStreamEvent {
  return { event: "threadName", payload: { threadId, name } };
}

function planUpdatedEvent(): SseStreamEvent {
  return {
    event: "planUpdated",
    payload: {
      threadId: "thread_1",
      turnId: "turn_1",
      explanation: "Track the work visibly.",
      plan: [
        { step: "Inspect the source", status: "completed" },
        { step: "Patch the UI", status: "inProgress" },
        { step: "Run checks", status: "pending" },
      ],
    },
  };
}

function retryingEvent(message: string): SseStreamEvent {
  return {
    event: "retrying",
    payload: { errorInfo: { kind: "raw", text: message } },
  };
}

function errorEvent(message: string, additionalDetails?: string | null): SseStreamEvent {
  return {
    event: "error",
    payload: { errorInfo: { kind: "raw", text: message }, additionalDetails },
  };
}

function localizedRetryingEvent(
  key: "errors.turn.insufficientTokens",
): SseStreamEvent {
  return {
    event: "retrying",
    payload: { errorInfo: { kind: "key", key } },
  };
}

function localizedErrorEvent(
  key: "errors.turn.insufficientTokens",
): SseStreamEvent {
  return {
    event: "error",
    payload: { errorInfo: { kind: "key", key } },
  };
}

function completedEvent(
  status: v2.TurnStatus,
  error: v2.TurnError | null = null,
  turnErrorContext?: TurnErrorFormattingContext,
): SseStreamEvent {
  return {
    event: "completed",
    payload: { turnId: "turn_1", status, error, ...(turnErrorContext ? { turnErrorContext } : {}) },
  };
}

function toolEvent(
  phase: "started" | "completed",
  item: v2.ThreadItem,
): SseStreamEvent {
  return { event: "tool", payload: { phase, type: item.type, item } };
}

function toolDeltaEvent(itemId: string, text: string, reasoningSummaryIndex?: number): SseStreamEvent {
  return { event: "toolDelta", payload: { itemId, text, reasoningSummaryIndex } };
}

function terminalInteractionEvent(
  itemId: string,
  processId: string,
  stdin: string,
): SseStreamEvent {
  return { event: "terminalInteraction", payload: { itemId, processId, stdin } };
}

function toolInputEvent(
  itemId: string,
  input: string,
  toolName = "js_repl",
): SseStreamEvent {
  return { event: "toolInput", payload: { itemId, toolName, input } };
}

// ---------------------------------------------------------------------------
// Item factories
// ---------------------------------------------------------------------------

function mcpItem(
  id: string,
  status: McpToolCallItem["status"] = "inProgress",
): McpToolCallItem {
  return {
    type: "mcpToolCall",
    id,
    server: "test-server",
    tool: "read_file",
    status,
    arguments: { file_path: "/test.ts" },
    result: null,
    error: null,
    durationMs: null,
  };
}

function reasoningItem(id: string): ReasoningItem {
  return {
    type: "reasoning",
    id,
    summary: ["thinking about it"],
    content: ["internal thoughts"],
  };
}

function commandItem(
  id: string,
  status: CommandExecutionItem["status"] = "completed",
  processId: string | null = null,
  command = "sleep 30",
): CommandExecutionItem {
  return {
    type: "commandExecution",
    id,
    command,
    cwd: "/tmp",
    processId,
    status,
    commandActions: [],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function apply(state: ChatState, event: SseStreamEvent): ApplyResult {
  return applyChatEvent(state, event, testGenerateId);
}

function applySequence(events: SseStreamEvent[]): ChatState {
  let state = createInitialChatState();
  for (const event of events) {
    state = applyChatEvent(state, event, testGenerateId).state;
  }
  return state;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("applyChatEvent", () => {
  beforeEach(() => {
    idCounter = 0;
    void i18n.changeLanguage("en");
  });

  // -- Thread/turn lifecycle ------------------------------------------------

  describe("Thread/turn lifecycle", () => {
    test("should_set_threadId_when_thread_event_received", () => {
      const { state } = apply(
        createInitialChatState(),
        threadEvent("thread_abc"),
      );
      assert.equal(state.threadId, "thread_abc");
    });

    test("should_emit_history_refresh_side_effect_when_thread_id_changes", () => {
      const result = apply(
        createInitialChatState(),
        threadEvent("thread_abc"),
      );

      assert.equal(result.sideEffects.length, 1);
      assert.deepEqual(result.sideEffects[0], {
        type: "conversationHistoryRefreshRequested",
      });
    });

    test("should_not_emit_history_refresh_side_effect_when_thread_id_unchanged", () => {
      const stateWithThread: ChatState = {
        ...createInitialChatState(),
        threadId: "thread_abc",
      };

      const result = apply(stateWithThread, threadEvent("thread_abc"));
      assert.equal(result.sideEffects.length, 0);
    });

    test("should_set_serverMessageId_on_draft_when_turn_event_received", () => {
      const { state } = apply(
        createInitialChatState(),
        turnEvent("turn_abc"),
      );
      assert.equal(state.draft?.serverMessageId, "turn_abc");
    });
  });

  describe("Plan updates", () => {
    test("should_store_latest_plan_checklist", () => {
      const { state } = apply(createInitialChatState(), planUpdatedEvent());

      assert.deepEqual(state.planChecklist, {
        threadId: "thread_1",
        turnId: "turn_1",
        explanation: "Track the work visibly.",
        steps: [
          { step: "Inspect the source", status: "completed" },
          { step: "Patch the UI", status: "inProgress" },
          { step: "Run checks", status: "pending" },
        ],
      });
    });

    test("should_clear_plan_checklist_when_empty_plan_received", () => {
      const withPlan = apply(createInitialChatState(), planUpdatedEvent()).state;
      const { state } = apply(withPlan, {
        event: "planUpdated",
        payload: {
          threadId: "thread_1",
          turnId: "turn_1",
          explanation: null,
          plan: [],
        },
      });

      assert.equal(state.planChecklist, null);
    });
  });

  // -- Text streaming (delta + final) --------------------------------------

  describe("Text streaming (delta + final)", () => {
    test("should_create_draft_when_first_delta_received", () => {
      const { state } = apply(createInitialChatState(), deltaEvent("Hello"));
      assert.ok(state.draft);
      assert.equal(textContent(state.draft), "Hello");
      assert.equal(state.draft.role, "assistant");
      assert.equal(state.draft.id, "test-id-1");
    });

    test("should_append_text_to_existing_draft", () => {
      const s1 = apply(createInitialChatState(), deltaEvent("Hello")).state;
      const { state } = apply(s1, deltaEvent(" world"));
      assert.equal(textContent(state.draft!), "Hello world");
    });

    test("should_set_draftAgentMessageId_from_delta_itemId", () => {
      const { state } = apply(
        createInitialChatState(),
        deltaEvent("Hi", "msg_1"),
      );
      assert.equal(state.draftAgentMessageId, "msg_1");
    });

    test("should_append_a_compaction_divider_message_when_context_is_compacted", () => {
      const state = applySequence([
        turnEvent("turn_abc"),
        deltaEvent("Working on it"),
        compactedEvent("turn_abc"),
      ]);

      assert.equal(state.messages.length, 2);
      assert.equal(textContent(state.messages[0]!), "Working on it");
      assert.equal(
        textContent(state.messages[1]!),
        '<compaction reason="context_limit"></compaction>',
      );
      assert.equal(state.draft?.serverMessageId, "turn_abc");
      assert.equal(textContent(state.draft!), "");
    });

    test("should_clear_retrying_when_delta_received", () => {
      const initial: ChatState = {
        ...createInitialChatState(),
        retrying: "Retrying...",
      };
      const { state } = apply(initial, deltaEvent("response"));
      assert.equal(state.retrying, null);
    });

    test("should_apply_final_text_when_draft_empty_and_ids_match", () => {
      const s1 = apply(
        createInitialChatState(),
        deltaEvent("", "msg_1"),
      ).state;
      const { state } = apply(s1, finalEvent("Complete response", "msg_1"));
      assert.equal(textContent(state.draft!), "Complete response");
    });

    test("should_not_apply_final_text_when_draft_already_has_content", () => {
      const s1 = apply(
        createInitialChatState(),
        deltaEvent("Streamed text", "msg_1"),
      ).state;
      const { state } = apply(s1, finalEvent("Final text", "msg_1"));
      assert.equal(textContent(state.draft!), "Streamed text");
    });

    test("should_not_apply_final_when_itemId_differs_from_draftAgentMessageId", () => {
      const s1 = apply(
        createInitialChatState(),
        deltaEvent("", "msg_1"),
      ).state;
      const { state } = apply(s1, finalEvent("Final text", "msg_2"));
      assert.equal(textContent(state.draft!), "");
    });

    test("should_apply_final_only_continuation_after_compaction_with_new_itemId", () => {
      const state = applySequence([
        turnEvent("turn_1"),
        deltaEvent("Streamed text", "msg_1"),
        compactedEvent("turn_1"),
        finalEvent("Continued after compaction", "msg_2"),
      ]);

      assert.equal(state.messages.length, 2);
      assert.equal(textContent(state.messages[0]!), "Streamed text");
      assert.equal(
        textContent(state.messages[1]!),
        '<compaction reason="context_limit"></compaction>',
      );
      assert.equal(state.draftAgentMessageId, null);
      assert.equal(textContent(state.draft!), "Continued after compaction");
    });

    test("should_apply_final_text_when_no_prior_delta", () => {
      let state = createInitialChatState();
      state = apply(state, turnEvent("turn_1")).state;
      state = apply(state, toolEvent("started", reasoningItem("rs_1"))).state;
      state = apply(state, toolEvent("completed", reasoningItem("rs_1"))).state;
      const { state: final } = apply(state, finalEvent("Answer.", "msg_1"));
      assert.equal(textContent(final.draft!), "Answer.");
    });
  });

  // -- Message splitting ---------------------------------------------------

  describe("Message splitting", () => {
    test("should_split_draft_when_new_agentMessage_arrives_with_pending_tools", () => {
      let state = createInitialChatState();
      state = apply(state, deltaEvent("First part", "msg_1")).state;
      state = apply(state, toolEvent("started", mcpItem("tool_1"))).state;

      const { state: split } = apply(
        state,
        deltaEvent("Second part", "msg_2"),
      );

      assert.equal(split.messages.length, 1);
      assert.equal(textContent(split.messages[0]!), "First part");
      assert.equal(msgToolCalls(split.messages[0]!).length, 1);
      assert.equal(textContent(split.draft!), "Second part");
      assert.equal(split.draft?.id, "test-id-2");
    });

    test("should_split_when_text_arrives_after_tools_even_if_agentMessage_id_unchanged", () => {
      let state = createInitialChatState();
      state = apply(state, deltaEvent("text", "msg_1")).state;
      state = apply(state, toolEvent("started", mcpItem("tool_1"))).state;

      const { state: split } = apply(state, deltaEvent(" more", "msg_1"));
      assert.equal(split.messages.length, 1);
      assert.equal(textContent(split.messages[0]!), "text");
      assert.equal(msgToolCalls(split.messages[0]!).length, 1);
      assert.equal(textContent(split.draft!), " more");
    });

    test("should_split_when_only_reasoning_tools_present", () => {
      let state = createInitialChatState();
      state = apply(state, deltaEvent("text", "msg_1")).state;
      state = apply(
        state,
        toolEvent("started", reasoningItem("rs_1")),
      ).state;

      const { state: split } = apply(state, deltaEvent(" more", "msg_2"));
      assert.equal(split.messages.length, 1);
      assert.equal(msgToolCalls(split.messages[0]!).length, 1);
      assert.equal(msgToolCalls(split.messages[0]!)[0]!.type, "reasoning");
      assert.equal(textContent(split.draft!), " more");
    });

    test("should_commit_current_draft_before_appending_committed_user_message", () => {
      let state = createInitialChatState();
      state = apply(state, turnEvent("turn_1")).state;
      state = apply(state, deltaEvent("before follow-up", "msg_1")).state;

      state = apply(state, userMessageEvent("follow up", "user_1")).state;
      state = apply(state, deltaEvent("after follow-up", "msg_2")).state;

      assert.equal(state.messages.length, 2);
      assert.equal(state.messages[0]?.role, "assistant");
      assert.equal(textContent(state.messages[0]!), "before follow-up");
      assert.equal(state.messages[1]?.role, "user");
      assert.equal(textContent(state.messages[1]!), "follow up");
      assert.equal(textContent(state.draft!), "after follow-up");
    });

    test("should_preserve_post_tool_reasoning_order_after_split", () => {
      let state = createInitialChatState();
      state = apply(state, deltaEvent("Checking.", "msg_1")).state;
      state = apply(state, toolEvent("started", mcpItem("tool_1"))).state;
      state = apply(state, toolEvent("completed", mcpItem("tool_1", "completed"))).state;
      state = apply(state, toolEvent("started", reasoningItem("rs_1"))).state;
      state = apply(state, toolEvent("completed", reasoningItem("rs_1"))).state;

      const { state: split } = apply(state, deltaEvent("Done.", "msg_2"));

      assert.equal(split.messages.length, 1);
      assert.equal(msgToolCalls(split.messages[0]!).length, 2);
      assert.equal(msgToolCalls(split.messages[0]!)[0]!.type, "mcpToolCall");
      assert.equal(msgToolCalls(split.messages[0]!)[1]!.type, "reasoning");
    });

    test("should_preserve_serverMessageId_across_split", () => {
      let state = createInitialChatState();
      state = apply(state, turnEvent("turn_1")).state;
      state = apply(state, deltaEvent("First", "msg_1")).state;
      state = apply(state, toolEvent("started", mcpItem("tool_1"))).state;

      const { state: split } = apply(state, deltaEvent("Second", "msg_2"));

      assert.equal(split.messages[0].serverMessageId, "turn_1");
      assert.equal(split.draft?.serverMessageId, "turn_1");
    });
  });

  describe("Tool input correlation", () => {
    test("should_attach_pending_tool_input_when_tool_starts_after_raw_input", () => {
      const sourceInput = 'await page.goto("https://example.com");';
      let state = createInitialChatState();

      state = apply(state, toolInputEvent("cmd_1", sourceInput)).state;
      state = apply(state, toolEvent("started", commandItem("cmd_1", "inProgress", null, "js_repl"))).state;

      const toolCall = msgToolCalls(state.draft!)[0];
      assert.equal(toolCall?.sourceInput, sourceInput);
      assert.equal(toolCall?.sourceToolName, "js_repl");
      assert.equal(state.pendingToolInputs.cmd_1, undefined);
    });

    test("should_update_existing_tool_call_when_raw_input_arrives_late", () => {
      const sourceInput = 'await page.getByRole("button", { name: "Continue" }).click();';
      let state = createInitialChatState();

      state = apply(state, toolEvent("started", commandItem("cmd_1", "inProgress", null, "js_repl"))).state;
      state = apply(state, toolInputEvent("cmd_1", sourceInput)).state;

      const toolCall = msgToolCalls(state.draft!)[0];
      assert.equal(toolCall?.sourceInput, sourceInput);
      assert.equal(toolCall?.sourceToolName, "js_repl");
    });

    test("should_preserve_tool_input_across_completion_updates", () => {
      const sourceInput = 'await page.getByLabel("Search").press("Enter");';
      let state = createInitialChatState();

      state = apply(state, toolInputEvent("cmd_1", sourceInput)).state;
      state = apply(state, toolEvent("started", commandItem("cmd_1", "inProgress", null, "js_repl"))).state;
      state = apply(state, toolEvent("completed", commandItem("cmd_1", "completed", null, "js_repl"))).state;

      const toolCall = msgToolCalls(state.draft!)[0];
      assert.equal(toolCall?.sourceInput, sourceInput);
      assert.equal(toolCall?.sourceToolName, "js_repl");
      assert.equal(toolCall?.state, "complete");
    });
  });

  // -- Tool events ---------------------------------------------------------

  describe("Tool events", () => {
    test("should_add_tool_call_when_tool_started", () => {
      const { state } = apply(
        createInitialChatState(),
        toolEvent("started", mcpItem("tool_1")),
      );
      assert.equal(msgToolCalls(state.draft!).length, 1);
      assert.equal(msgToolCalls(state.draft!)[0]!.id, "tool_1");
      assert.equal(msgToolCalls(state.draft!)[0]!.state, "loading");
      assert.equal(msgToolCalls(state.draft!)[0]!.type, "mcpToolCall");
    });

    test("should_update_tool_call_when_tool_completed", () => {
      let state = apply(
        createInitialChatState(),
        toolEvent("started", mcpItem("tool_1")),
      ).state;
      const { state: completed } = apply(
        state,
        toolEvent("completed", mcpItem("tool_1", "completed")),
      );
      assert.equal(msgToolCalls(completed.draft!)[0]!.state, "complete");
    });

    test("does_not_mark_normal_command_execution_as_background_from_process_id_alone", () => {
      const { state } = apply(
        createInitialChatState(),
        toolEvent("completed", commandItem("cmd_1", "completed", "1000")),
      );

      assert.equal(msgToolCalls(state.draft!)[0]!.processId, "1000");
      assert.equal(msgToolCalls(state.draft!)[0]!.backgroundState, undefined);
    });

    test("preserves_background_process_id_when_command_execution_later_finishes", () => {
      let state = apply(
        createInitialChatState(),
        toolEvent("completed", commandItem("cmd_1", "completed", "1000")),
      ).state;

      state = apply(
        state,
        toolEvent("completed", commandItem("cmd_1", "completed", null)),
      ).state;

      assert.equal(msgToolCalls(state.draft!)[0]!.processId, "1000");
      assert.equal(msgToolCalls(state.draft!)[0]!.item?.type, "commandExecution");
      if (msgToolCalls(state.draft!)[0]!.item?.type === "commandExecution") {
        assert.equal(msgToolCalls(state.draft!)[0]!.item.processId, null);
      }
    });

    test("should_mark_tool_as_error_when_failed", () => {
      let state = apply(
        createInitialChatState(),
        toolEvent("started", mcpItem("tool_1")),
      ).state;
      const { state: failed } = apply(
        state,
        toolEvent("completed", mcpItem("tool_1", "failed")),
      );
      assert.equal(msgToolCalls(failed.draft!)[0]!.state, "error");
    });

    test("should_update_committed_tool_call_when_completion_arrives_after_text_split", () => {
      let state = createInitialChatState();
      state = apply(state, deltaEvent("Running now.", "msg_1")).state;
      state = apply(state, toolEvent("started", mcpItem("tool_1"))).state;
      state = apply(state, deltaEvent("Waiting for it.", "msg_1")).state;

      const { state: completed } = apply(
        state,
        toolEvent("completed", mcpItem("tool_1", "completed")),
      );

      assert.equal(completed.messages.length, 1);
      assert.equal(msgToolCalls(completed.messages[0]!)[0]!.state, "complete");
      assert.equal(textContent(completed.draft!), "Waiting for it.");
      assert.equal(msgToolCalls(completed.draft!).length, 0);
    });

    test("should_update_committed_reasoning_when_completion_arrives_after_text_split", () => {
      let state = createInitialChatState();
      state = apply(state, deltaEvent("Checking.", "msg_1")).state;
      state = apply(state, toolEvent("started", reasoningItem("rs_tmp_1"))).state;
      state = apply(state, deltaEvent("Waiting.", "msg_1")).state;

      const { state: completed } = apply(
        state,
        toolEvent("completed", reasoningItem("rs_final_1")),
      );

      assert.equal(completed.messages.length, 1);
      assert.equal(msgToolCalls(completed.messages[0]!)[0]!.type, "reasoning");
      assert.equal(msgToolCalls(completed.messages[0]!)[0]!.state, "complete");
      assert.equal(textContent(completed.draft!), "Waiting.");
    });
  });

  // -- ToolDelta -----------------------------------------------------------

  describe("ToolDelta", () => {
    test("should_append_text_to_existing_tool_output", () => {
      let state = apply(
        createInitialChatState(),
        toolEvent("started", mcpItem("tool_1")),
      ).state;
      state = apply(state, toolDeltaEvent("tool_1", "line 1\n")).state;
      const { state: result } = apply(
        state,
        toolDeltaEvent("tool_1", "line 2\n"),
      );
      assert.equal(msgToolCalls(result.draft!)[0]!.output, "line 1\nline 2\n");
    });

    test("should_noop_when_tool_not_found", () => {
      let state = apply(
        createInitialChatState(),
        toolEvent("started", mcpItem("tool_1")),
      ).state;
      const outputBefore = msgToolCalls(state.draft!)[0]?.output;
      const { state: after } = apply(
        state,
        toolDeltaEvent("nonexistent", "text"),
      );
      assert.equal(msgToolCalls(after.draft!).length, 1);
      assert.equal(msgToolCalls(after.draft!)[0]!.output, outputBefore);
    });

    test("should_keep_complete_tool_complete_on_toolDelta", () => {
      let state = apply(
        createInitialChatState(),
        toolEvent("started", mcpItem("tool_1")),
      ).state;
      state = apply(
        state,
        toolEvent("completed", mcpItem("tool_1", "completed")),
      ).state;
      assert.equal(msgToolCalls(state.draft!)[0]!.state, "complete");

      const { state: after } = apply(
        state,
        toolDeltaEvent("tool_1", "late output"),
      );
      assert.equal(msgToolCalls(after.draft!)[0]!.state, "complete");
      assert.equal(msgToolCalls(after.draft!)[0]!.output, "late output");
    });

    test("should_append_tool_delta_to_committed_tool_after_text_split", () => {
      let state = createInitialChatState();
      state = apply(state, deltaEvent("Running now.", "msg_1")).state;
      state = apply(state, toolEvent("started", mcpItem("tool_1"))).state;
      state = apply(state, deltaEvent("Waiting for it.", "msg_1")).state;

      const { state: after } = apply(
        state,
        toolDeltaEvent("tool_1", "late output"),
      );

      assert.equal(msgToolCalls(after.messages[0]!)[0]!.output, "late output");
      assert.equal(textContent(after.draft!), "Waiting for it.");
    });

    test("maps_terminal_interaction_onto_original_command_execution", () => {
      let state = apply(
        createInitialChatState(),
        toolEvent("completed", commandItem("cmd_1", "completed", "1000")),
      ).state;

      state = apply(
        state,
        terminalInteractionEvent("cmd_1", "1000", ""),
      ).state;
      assert.equal(msgToolCalls(state.draft!)[0]!.backgroundState, "waiting");

      state = apply(
        state,
        terminalInteractionEvent("cmd_1", "1000", "pwd\n"),
      ).state;
      assert.equal(msgToolCalls(state.draft!)[0]!.backgroundState, "interacted");
      assert.equal(msgToolCalls(state.draft!)[0]!.backgroundInput, "pwd\n");
    });
  });

  // -- Reasoning dedup -----------------------------------------------------

  describe("Reasoning dedup", () => {
    test("should_dedup_reasoning_by_reusing_loading_slot", () => {
      let state = apply(
        createInitialChatState(),
        toolEvent("started", reasoningItem("rs_tmp_1")),
      ).state;
      const { state: deduped } = apply(
        state,
        toolEvent("completed", reasoningItem("rs_perm_1")),
      );
      assert.equal(msgToolCalls(deduped.draft!).length, 1);
    });

    test("should_not_dedup_when_existing_reasoning_completed", () => {
      let state = apply(
        createInitialChatState(),
        toolEvent("started", reasoningItem("rs_1")),
      ).state;
      state = apply(
        state,
        toolEvent("completed", reasoningItem("rs_1")),
      ).state;
      const { state: appended } = apply(
        state,
        toolEvent("started", reasoningItem("rs_2")),
      );
      assert.equal(msgToolCalls(appended.draft!).length, 2);
    });

    test("should_insert_paragraph_break_when_reasoning_moves_to_next_summary_part", () => {
      let state = apply(
        createInitialChatState(),
        toolEvent("started", {
          type: "reasoning",
          id: "rs_1",
          summary: [],
          content: [],
        }),
      ).state;

      state = apply(
        state,
        toolDeltaEvent("rs_1", "First paragraph", 0),
      ).state;

      state = apply(
        state,
        toolDeltaEvent("rs_1", "**Heading**", 1),
      ).state;

      assert.equal(msgToolCalls(state.draft!)[0]!.output, "First paragraph\n\n**Heading**");
    });
  });

  // -- Error/retrying ------------------------------------------------------

  describe("Error/retrying", () => {
    test("should_set_retrying_when_retrying_event_received", () => {
      const { state } = apply(
        createInitialChatState(),
        retryingEvent("Rate limited, retrying..."),
      );
      assert.equal(state.retrying, "Rate limited, retrying...");
    });

    test("should_set_error_when_error_event_received", () => {
      const { state } = apply(
        createInitialChatState(),
        errorEvent("Something went wrong"),
      );
      assert.equal(state.error, "Something went wrong");
    });

    test("should_clear_retrying_on_completed", () => {
      const initial: ChatState = {
        ...createInitialChatState(),
        retrying: "Retrying...",
      };
      const { state } = apply(initial, completedEvent("completed"));
      assert.equal(state.retrying, null);
    });

    test("should_clear_error_on_successful_completion", () => {
      const initial: ChatState = {
        ...createInitialChatState(),
        error: "Previous error",
      };
      const { state } = apply(initial, completedEvent("completed"));
      assert.equal(state.error, null);
    });

    test("should_settle_loading_tool_calls_on_turn_completion", () => {
      const state = applySequence([
        toolEvent("started", commandItem("cmd_1", "inProgress", "1000")),
        toolEvent("started", reasoningItem("rs_1")),
        deltaEvent("Done."),
        completedEvent("completed"),
      ]);

      assert.equal(state.messages.length, 1);
      assert.deepEqual(
        msgToolCalls(state.messages[0]!).map((toolCall) => [toolCall.type, toolCall.state]),
        [
          ["commandExecution", "complete"],
          ["reasoning", "complete"],
        ],
      );
    });

    test("should_treat_fake_tool_call_text_as_contract_incompatibility_instead_of_success", () => {
      const state = applySequence([
        turnEvent("turn_1"),
        finalEvent('call:shell{"command":"pwd"}', "msg_1"),
        completedEvent("completed"),
      ]);

      assert.equal(
        state.error,
        "This endpoint/model does not support Interpreter's Responses/tool-calling contract.",
      );
      assert.equal(textContent(state.draft!), "");
    });

    test("should_keep_plain_text_that_starts_with_call_colon_on_successful_completion", () => {
      const state = applySequence([
        turnEvent("turn_1"),
        finalEvent('call: {"status":"ok"} is displayed as text for the user.', "msg_1"),
        completedEvent("completed"),
      ]);

      assert.equal(state.error, null);
      assert.equal(
        textContent(state.draft!),
        'call: {"status":"ok"} is displayed as text for the user.',
      );
    });

    test("should_keep_plain_text_when_call_colon_is_followed_by_whitespace_on_successful_completion", () => {
      const state = applySequence([
        turnEvent("turn_1"),
        finalEvent('call: shell{"command":"pwd"} is displayed as text for the user.', "msg_1"),
        completedEvent("completed"),
      ]);

      assert.equal(state.error, null);
      assert.equal(
        textContent(state.draft!),
        'call: shell{"command":"pwd"} is displayed as text for the user.',
      );
    });

    test("should_keep_plain_text_when_compact_fake_tool_shape_has_trailing_text", () => {
      const state = applySequence([
        turnEvent("turn_1"),
        finalEvent('call:shell{"command":"pwd"} is displayed as text for the user.', "msg_1"),
        completedEvent("completed"),
      ]);

      assert.equal(state.error, null);
      assert.equal(
        textContent(state.draft!),
        'call:shell{"command":"pwd"} is displayed as text for the user.',
      );
    });

    test("should_keep_plain_text_when_there_is_whitespace_before_tool_args", () => {
      const state = applySequence([
        turnEvent("turn_1"),
        finalEvent('call:shell {"command":"pwd"} is displayed as text for the user.', "msg_1"),
        completedEvent("completed"),
      ]);

      assert.equal(state.error, null);
      assert.equal(
        textContent(state.draft!),
        'call:shell {"command":"pwd"} is displayed as text for the user.',
      );
    });
  });

  // -- Failed turn completion ----------------------------------------------

  describe("Failed turn completion", () => {
    test("should_set_formatted_error_when_turn_failed", () => {
      const error: v2.TurnError = {
        message: "API key invalid",
        codexErrorInfo: null,
        additionalDetails: null,
      };
      const { state } = apply(
        createInitialChatState(),
        completedEvent("failed", error),
      );
      assert.equal(state.error, "API key invalid");
      assert.equal(state.retrying, null);
    });

    test("should_use_interpreter_chatgpt_usage_limit_copy_when_turn_failed", () => {
      const error: v2.TurnError = {
        message:
          "Error running remote compact task: You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Mar 28th, 2026 1:52 PM.",
        codexErrorInfo: "usageLimitExceeded",
        additionalDetails: null,
      };
      const { state } = apply(
        createInitialChatState(),
        completedEvent("failed", error, { isChatGptProfile: true }),
      );
      assert.equal(
        state.error,
        "You've hit your ChatGPT usage limit. Try again at: Mar 28th, 2026 1:52 PM. This limit is set by your ChatGPT account and is separate from Interpreter plan usage shown in Settings.",
      );
    });

    test("should_preserve_provider_message_when_failed_turn_follows_structured_stream_error", () => {
      const providerMessage =
        "We're currently experiencing high demand, which may cause temporary errors.";
      const error: v2.TurnError = {
        message: providerMessage,
        codexErrorInfo: {
          responseTooManyFailedAttempts: { httpStatusCode: 500 },
        },
        additionalDetails: null,
      };

      const afterError = apply(
        createInitialChatState(),
        errorEvent(providerMessage),
      );
      assert.equal(afterError.state.error, providerMessage);

      const { state } = apply(
        afterError.state,
        completedEvent("failed", error),
      );
      assert.equal(state.error, providerMessage);
    });

    test("should_preserve_provider_message_when_failed_turn_uses_internal_server_error_code", () => {
      const providerMessage =
        "We're currently experiencing high demand, which may cause temporary errors.";
      const error: v2.TurnError = {
        message: providerMessage,
        codexErrorInfo: "internalServerError",
        additionalDetails: null,
      };

      const afterError = apply(
        createInitialChatState(),
        errorEvent(providerMessage),
      );
      assert.equal(afterError.state.error, providerMessage);

      const { state } = apply(
        afterError.state,
        completedEvent("failed", error),
      );
      assert.equal(state.error, providerMessage);
    });

    test("should_use_default_error_when_turn_failed_without_error_object", () => {
      const { state } = apply(
        createInitialChatState(),
        completedEvent("failed", null),
      );
      assert.equal(state.error, "Turn failed");
      assert.equal(state.retrying, null);
    });

    test("should_translate_retrying_descriptor_with_active_locale", async () => {
      await i18n.changeLanguage("ru");

      try {
        const { state } = apply(
          createInitialChatState(),
          localizedRetryingEvent("errors.turn.insufficientTokens"),
        );

        assert.equal(
          state.retrying,
          "Недостаточно токенов Interpreter. Добавьте токены в настройках биллинга.",
        );
      } finally {
        await i18n.changeLanguage("en");
      }
    });

    test("should_keep_error_descriptor_parser_stable_with_active_locale", async () => {
      await i18n.changeLanguage("ru");

      try {
        const { state } = apply(
          createInitialChatState(),
          localizedErrorEvent("errors.turn.insufficientTokens"),
        );

        assert.equal(
          state.error,
          "Insufficient interpreter tokens. Add tokens in billing settings.",
        );
      } finally {
        await i18n.changeLanguage("en");
      }
    });

    test("should_preserve_stream_error_when_turn_fails_without_error_object", () => {
      const state = applySequence([
        errorEvent("We're currently experiencing high demand, which may cause temporary errors."),
        completedEvent("failed", null),
      ]);

      assert.equal(
        state.error,
        "We're currently experiencing high demand, which may cause temporary errors.",
      );
    });

    test("should_override_stream_error_when_turn_fails_with_error_object", () => {
      const state = applySequence([
        errorEvent("We're currently experiencing high demand, which may cause temporary errors."),
        completedEvent("failed", {
          message: "API key invalid",
          codexErrorInfo: null,
          additionalDetails: null,
        }),
      ]);

      assert.equal(state.error, "API key invalid");
    });

    test("should_format_lmstudio_single_tool_call_template_error_on_failed_turn_completion", () => {
      const state = applySequence([
        completedEvent("failed", {
          message: LMSTUDIO_SINGLE_TOOL_CALL_TEMPLATE_ERROR,
          codexErrorInfo: null,
          additionalDetails: null,
        }, {
          modelProvider: "lmstudio-5a96e840",
          providerLabel: "LM Studio",
        }),
      ]);

      assert.equal(state.error, EXPECTED_LMSTUDIO_TOOL_SUPPORT_GUIDANCE);
    });
  });

  describe("Interrupted turn completion", () => {
    test("should_surface_generic_connection_error_when_turn_interrupts_after_retrying", () => {
      const state = applySequence([
        retryingEvent("Reconnecting... 1/5"),
        completedEvent("interrupted", null),
      ]);

      assert.equal(state.error, "Connection to the model provider was lost.");
      assert.equal(state.retrying, null);
      assert.equal(state.errorDetails, null);
    });

    test("should_preserve_existing_error_when_turn_interrupts_without_error_object", () => {
      const state = applySequence([
        errorEvent("Internal server error. Try again later."),
        completedEvent("interrupted", null),
      ]);

      assert.equal(state.error, "Internal server error. Try again later.");
      assert.equal(state.errorDetails, null);
    });

    test("should_use_turn_error_when_turn_interrupts_with_error_object", () => {
      const state = applySequence([
        retryingEvent("Reconnecting... 1/5"),
        completedEvent("interrupted", {
          message: "Request interrupted by provider",
          codexErrorInfo: null,
          additionalDetails: "Provider closed stream early",
        }),
      ]);

      assert.equal(state.error, "Request interrupted by provider");
      assert.equal(state.errorDetails, "Provider closed stream early");
    });

    test("should_clear_error_when_clean_interrupt_has_no_prior_error_or_retrying", () => {
      const state = applySequence([
        completedEvent("interrupted", null),
      ]);

      assert.equal(state.error, null);
      assert.equal(state.errorDetails, null);
      assert.equal(state.retrying, null);
    });

    test("should_prefer_previous_error_over_previous_retrying_when_both_exist", () => {
      const state = applySequence([
        errorEvent("Internal server error"),
        retryingEvent("Reconnecting... 1/5"),
        completedEvent("interrupted", null),
      ]);

      // error event sets state.error; retrying event sets state.retrying
      // but does NOT clear state.error. The interrupted handler checks
      // previousError before previousRetrying, so the error wins.
      assert.equal(state.error, "Internal server error");
      assert.equal(state.errorDetails, null);
      assert.equal(state.retrying, null);
    });

    test("should_preserve_error_details_when_error_event_had_additional_details", () => {
      const state = applySequence([
        errorEvent("Context window exceeded", "Model returned n_keep >= n_ctx"),
        completedEvent("interrupted", null),
      ]);

      assert.equal(state.error, "Context window exceeded");
      assert.equal(state.errorDetails, "Model returned n_keep >= n_ctx");
    });

    test("should_use_payload_error_over_both_previous_error_and_retrying", () => {
      const state = applySequence([
        errorEvent("Stream disconnected"),
        retryingEvent("Reconnecting... 3/5"),
        completedEvent("interrupted", {
          message: "Provider rate limited",
          codexErrorInfo: null,
          additionalDetails: "Retry after 30s",
        }),
      ]);

      assert.equal(state.error, "Provider rate limited");
      assert.equal(state.errorDetails, "Retry after 30s");
      assert.equal(state.retrying, null);
    });
  });

  // -- threadName side effect ----------------------------------------------

  describe("threadName side effect", () => {
    test("should_return_side_effect_for_threadName_event", () => {
      const result = apply(
        createInitialChatState(),
        threadNameEvent("thread_1", "My Chat"),
      );
      assert.equal(result.sideEffects.length, 1);
      assert.deepEqual(result.sideEffects[0], {
        type: "threadNameUpdated",
        threadId: "thread_1",
        name: "My Chat",
      });
    });

    test("should_not_modify_state_for_threadName_event", () => {
      const initial = createInitialChatState();
      const { state } = apply(
        initial,
        threadNameEvent("thread_1", "My Chat"),
      );
      assert.deepEqual(state, initial);
    });
  });

  // -- End-to-end sequences ------------------------------------------------

  describe("End-to-end sequences", () => {
    test("should_build_complete_message_through_full_event_sequence", () => {
      const state = applySequence([
        threadEvent("thread_1"),
        turnEvent("turn_1"),
        deltaEvent("Hello ", "msg_1"),
        deltaEvent("world!", "msg_1"),
        finalEvent("Hello world!", "msg_1"),
        completedEvent("completed"),
      ]);

      assert.equal(state.threadId, "thread_1");
      assert.equal(textContent(state.draft!), "Hello world!");
      assert.equal(state.draft?.serverMessageId, "turn_1");
      assert.equal(state.error, null);
      assert.equal(state.retrying, null);
    });

    test("should_handle_tool_use_sequence", () => {
      const state = applySequence([
        threadEvent("thread_1"),
        turnEvent("turn_1"),
        deltaEvent("Let me check.", "msg_1"),
        toolEvent("started", mcpItem("tool_1")),
        toolDeltaEvent("tool_1", "file contents"),
        toolEvent("completed", mcpItem("tool_1", "completed")),
        deltaEvent("Here is the result.", "msg_2"),
        finalEvent("Here is the result.", "msg_2"),
        completedEvent("completed"),
      ]);

      assert.equal(state.messages.length, 1);
      assert.equal(textContent(state.messages[0]!), "Let me check.");
      assert.equal(msgToolCalls(state.messages[0]!).length, 1);
      assert.equal(msgToolCalls(state.messages[0]!)[0]!.state, "complete");
      assert.equal(textContent(state.draft!), "Here is the result.");
    });

    test("should_accumulate_multiple_tool_calls", () => {
      const state = applySequence([
        turnEvent("turn_1"),
        toolEvent("started", mcpItem("tool_1")),
        toolEvent("completed", mcpItem("tool_1", "completed")),
        toolEvent("started", mcpItem("tool_2")),
        toolEvent("completed", mcpItem("tool_2", "completed")),
      ]);

      assert.equal(msgToolCalls(state.draft!).length, 2);
      assert.equal(msgToolCalls(state.draft!)[0]!.id, "tool_1");
      assert.equal(msgToolCalls(state.draft!)[0]!.state, "complete");
      assert.equal(msgToolCalls(state.draft!)[1]!.id, "tool_2");
      assert.equal(msgToolCalls(state.draft!)[1]!.state, "complete");
    });
  });

  // -------------------------------------------------------------------------
  // State settlement invariants
  // Ref: Issue #678 -- stale "loading" states caused ghost active indicators.
  // settleLoadingToolCalls is the safety net that runs on "completed" events.
  // These tests verify the zero-loading-after-completion invariant holds across
  // complex multi-tool, multi-message, and split-draft scenarios.
  //
  // Ref: Vercel AI SDK TestResponseController pattern -- step through the full
  // event lifecycle and assert exact state shape at the end
  // (packages/react/src/use-chat.ui.test.tsx). We apply the same approach:
  // replay a fixed event sequence, assert every tool call has terminal state.
  // -------------------------------------------------------------------------

  describe("State settlement invariants", () => {
    // Ref: Vercel AI SDK asserts tool call states transition through
    // input-streaming -> input-available -> output-available and never revert.
    // Our equivalent: loading -> complete|error, enforced on turn completion.

    function allToolCallStates(state: ChatState): Array<{ id: string; state: string }> {
      const result: Array<{ id: string; state: string }> = [];
      for (const msg of state.messages) {
        for (const tc of msgToolCalls(msg)) {
          result.push({ id: tc.id, state: tc.state });
        }
      }
      if (state.draft) {
        for (const tc of msgToolCalls(state.draft)) {
          result.push({ id: tc.id, state: tc.state });
        }
      }
      return result;
    }

    test("should_leave_zero_loading_states_after_successful_completion", () => {
      const state = applySequence([
        threadEvent("thread_1"),
        turnEvent("turn_1"),
        toolEvent("started", reasoningItem("rs_1")),
        toolEvent("started", mcpItem("tool_1")),
        toolEvent("started", commandItem("cmd_1", "inProgress", "1000")),
        deltaEvent("Working on it.", "msg_1"),
        completedEvent("completed"),
      ]);

      const states = allToolCallStates(state);
      assert.equal(states.length, 3);
      for (const tc of states) {
        assert.notEqual(tc.state, "loading", `tool ${tc.id} still loading after completion`);
      }
    });

    test("should_leave_zero_loading_states_after_failed_completion", () => {
      const state = applySequence([
        turnEvent("turn_1"),
        toolEvent("started", mcpItem("tool_1")),
        toolEvent("started", mcpItem("tool_2")),
        completedEvent("failed", {
          message: "API rate limit",
          codexErrorInfo: null,
          additionalDetails: null,
        }),
      ]);

      const states = allToolCallStates(state);
      for (const tc of states) {
        assert.notEqual(tc.state, "loading", `tool ${tc.id} still loading after failed completion`);
      }
    });

    test("should_settle_tools_across_committed_messages_and_draft", () => {
      // Simulate: text -> tool -> text split -> more tools -> completion.
      // Tools end up in both committed messages and the draft.
      const state = applySequence([
        turnEvent("turn_1"),
        deltaEvent("Checking.", "msg_1"),
        toolEvent("started", mcpItem("tool_1")),
        deltaEvent("Found it.", "msg_2"),
        toolEvent("started", mcpItem("tool_2")),
        toolEvent("started", commandItem("cmd_1", "inProgress")),
        completedEvent("completed"),
      ]);

      assert.equal(state.messages.length, 1);
      const committedTools = msgToolCalls(state.messages[0]!);
      assert.equal(committedTools.length, 1);
      assert.equal(committedTools[0]!.state, "complete");

      const draftTools = msgToolCalls(state.draft!);
      assert.equal(draftTools.length, 2);
      for (const tc of draftTools) {
        assert.notEqual(tc.state, "loading", `draft tool ${tc.id} still loading`);
      }
    });

    test("should_mark_failed_items_as_error_not_complete_during_settlement", () => {
      const state = applySequence([
        turnEvent("turn_1"),
        toolEvent("started", mcpItem("tool_1")),
        toolEvent("completed", mcpItem("tool_1", "failed")),
        toolEvent("started", mcpItem("tool_2")),
        completedEvent("completed"),
      ]);

      const states = allToolCallStates(state);
      assert.equal(states[0]!.state, "error");
      assert.equal(states[1]!.state, "complete");
    });

    test("should_preserve_chronological_tool_order_through_complex_sequence", () => {
      // Ref: Issue #678 -- "I just want chronological chunks and just the one
      // that's active (the LAST ONE) should be active, not past ones."
      const state = applySequence([
        turnEvent("turn_1"),
        toolEvent("started", reasoningItem("rs_1")),
        toolEvent("completed", reasoningItem("rs_1")),
        toolEvent("started", mcpItem("read_1")),
        toolEvent("completed", mcpItem("read_1", "completed")),
        toolEvent("started", commandItem("cmd_1", "inProgress")),
        toolEvent("completed", commandItem("cmd_1", "completed")),
        toolEvent("started", mcpItem("read_2")),
        completedEvent("completed"),
      ]);

      const ids = allToolCallStates(state).map((tc) => tc.id);
      assert.deepEqual(ids, ["rs_1", "read_1", "cmd_1", "read_2"]);
    });

    test("should_settle_draft_tools_that_never_received_completion_event", () => {
      // Simulates server dropping connection after starting tools but before
      // completing them individually. The "completed" turn event must still
      // sweep all loading states.
      const state = applySequence([
        turnEvent("turn_1"),
        toolEvent("started", mcpItem("orphan_1")),
        toolEvent("started", mcpItem("orphan_2")),
        toolEvent("started", reasoningItem("orphan_rs")),
        completedEvent("completed"),
      ]);

      const states = allToolCallStates(state);
      assert.equal(states.length, 3);
      for (const tc of states) {
        assert.equal(tc.state, "complete", `orphan tool ${tc.id} not settled`);
      }
    });

    test("should_not_regress_already_completed_tools_during_settlement", () => {
      const state = applySequence([
        turnEvent("turn_1"),
        toolEvent("started", mcpItem("tool_1")),
        toolEvent("completed", mcpItem("tool_1", "completed")),
        toolEvent("started", mcpItem("tool_2")),
        toolEvent("completed", mcpItem("tool_2", "failed")),
        completedEvent("completed"),
      ]);

      const states = allToolCallStates(state);
      assert.equal(states[0]!.state, "complete");
      assert.equal(states[1]!.state, "error");
    });

    test("during_streaming_only_the_last_tool_should_be_loading", () => {
      // Ref: Issue #678 -- at any mid-stream snapshot, completed tools must
      // not still show "loading". Only tools that have not received their
      // completion event can be loading.
      let state = createInitialChatState();
      state = apply(state, turnEvent("turn_1")).state;
      state = apply(state, toolEvent("started", mcpItem("tool_1"))).state;
      state = apply(state, toolEvent("completed", mcpItem("tool_1", "completed"))).state;
      state = apply(state, toolEvent("started", mcpItem("tool_2"))).state;

      const states = allToolCallStates(state);
      assert.equal(states[0]!.state, "complete");
      assert.equal(states[1]!.state, "loading");
    });
  });
});
