import { describe, test } from "bun:test";
import assert from "node:assert/strict";

import {
  buildUserMessagePreview,
  buildStreamRequestBody,
  clearBackgroundProcessesFromMessage,
  clearBackgroundProcessesFromMessageByProcessIds,
  createMarketingDemoTranscriptMessage,
  describeStreamFailure,
  resolveToolCallIndex,
  draftHasVisibleContent,
  stopLoadingToolCallsInMessage,
  appendVisibleDraftMessage,
  finalizeVisibleDraftMessage,
  shouldApplyFinalText,
  isHiddenRuntimeContinuationMessage,
  forgetRuntimeRestartContinuation,
  hasRuntimeRestartContinuation,
  rememberRuntimeRestartContinuation,
  runtimeRestartContinuationStorageKey,
  mergeChatHistory,
  type ChatMessage,
  type ChatMessagePart,
  type ToolCallInfo,
} from "./use-chat";

describe("mergeChatHistory", () => {
  const message = (id: string, content: string): ChatMessage => ({
    id,
    role: "assistant",
    parts: [{ kind: "text", content }],
  });

  test("prepends unseen older messages and preserves chronological order", () => {
    const merged = mergeChatHistory(
      [message("m3", "three"), message("m4", "four")],
      [message("m1", "one"), message("m2", "two"), message("m3", "three")],
      "older",
    );
    assert.deepEqual(merged.map((entry) => entry.id), ["m1", "m2", "m3", "m4"]);
  });

  test("updates overlapping live messages and appends new messages", () => {
    const merged = mergeChatHistory(
      [message("m1", "partial")],
      [message("m1", "complete"), message("m2", "next")],
      "newer",
    );
    assert.deepEqual(merged.map((entry) => entry.id), ["m1", "m2"]);
    assert.equal(merged[0]?.parts[0]?.kind, "text");
    assert.equal((merged[0]?.parts[0] as { content: string }).content, "complete");
  });
});

function reasoning(id: string, state: ToolCallInfo["state"]): ToolCallInfo {
  return { id, type: "reasoning", label: "Thinking", state };
}

function tool(id: string, state: ToolCallInfo["state"]): ToolCallInfo {
  return { id, type: "mcpToolCall", label: "Read file", state };
}

function createStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}

describe("isHiddenRuntimeContinuationMessage", () => {
  test("detects the internal restart continuation user message", () => {
    const message: ChatMessage = {
      id: "runtime-continue",
      role: "user",
      parts: [
        {
          kind: "text",
          content:
            "Continue the previous task now that Interpreter restarted. Continue from where you left off and verify the MCP/tool changes are available.",
        },
      ],
    };

    assert.equal(isHiddenRuntimeContinuationMessage(message), true);
  });

  test("does not hide normal user messages", () => {
    const message: ChatMessage = {
      id: "user-1",
      role: "user",
      parts: [{ kind: "text", content: "Continue the previous task." }],
    };

    assert.equal(isHiddenRuntimeContinuationMessage(message), false);
  });

});

describe("runtime restart continuation storage", () => {
  test("remembers and clears a pending continuation per thread", () => {
    const storage = createStorage();
    const threadId = "thread-1";

    assert.equal(hasRuntimeRestartContinuation(threadId, storage), false);

    rememberRuntimeRestartContinuation(threadId, storage);

    assert.equal(hasRuntimeRestartContinuation(threadId, storage), true);
    assert.equal(
      storage.getItem(runtimeRestartContinuationStorageKey(threadId)) !== null,
      true,
    );

    forgetRuntimeRestartContinuation(threadId, storage);

    assert.equal(hasRuntimeRestartContinuation(threadId, storage), false);
  });

  test("keeps different thread continuations isolated", () => {
    const storage = createStorage();

    rememberRuntimeRestartContinuation("thread-a", storage);

    assert.equal(hasRuntimeRestartContinuation("thread-a", storage), true);
    assert.equal(hasRuntimeRestartContinuation("thread-b", storage), false);
  });
});

describe("draftHasVisibleContent", () => {
  test("should_return_false_when_draft_is_null", () => {
    assert.equal(draftHasVisibleContent(null), false);
  });

  test("should_return_false_when_draft_is_empty", () => {
    const draft: ChatMessage = { id: "1", role: "assistant", parts: [] };
    assert.equal(draftHasVisibleContent(draft), false);
  });

  test("should_return_false_when_draft_has_only_whitespace", () => {
    const draft: ChatMessage = {
      id: "1",
      role: "assistant",
      parts: [{ kind: "text", content: "   \n  " }],
    };
    assert.equal(draftHasVisibleContent(draft), false);
  });

  test("should_return_true_when_draft_has_text_content", () => {
    const draft: ChatMessage = {
      id: "1",
      role: "assistant",
      parts: [{ kind: "text", content: "Here is my analysis." }],
    };
    assert.equal(draftHasVisibleContent(draft), true);
  });

  test("should_return_true_when_draft_has_reasoning_in_tool_calls", () => {
    const draft: ChatMessage = {
      id: "1",
      role: "assistant",
      parts: [{ kind: "tool-call", toolCall: reasoning("rs_1", "complete") }],
    };
    assert.equal(draftHasVisibleContent(draft), true);
  });

  test("should_return_true_when_draft_has_only_non_reasoning_tool_calls", () => {
    const draft: ChatMessage = {
      id: "1",
      role: "assistant",
      parts: [{ kind: "tool-call", toolCall: tool("tc_1", "complete") }],
    };
    assert.equal(draftHasVisibleContent(draft), true);
  });

  test("should_return_true_when_draft_has_both_text_and_reasoning", () => {
    const draft: ChatMessage = {
      id: "1",
      role: "assistant",
      parts: [
        { kind: "text", content: "Done." },
        { kind: "tool-call", toolCall: reasoning("rs_1", "complete") },
      ],
    };
    assert.equal(draftHasVisibleContent(draft), true);
  });

  test("should_return_false_when_draft_has_empty_parts_array", () => {
    const draft: ChatMessage = { id: "1", role: "assistant", parts: [] };
    assert.equal(draftHasVisibleContent(draft), false);
  });
});

describe("appendVisibleDraftMessage", () => {
  test("should_append_visible_draft", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", parts: [{ kind: "text", content: "Hi" }] },
    ];
    const draft: ChatMessage = {
      id: "a1",
      role: "assistant",
      parts: [{ kind: "text", content: "Partial response" }],
    };

    const result = appendVisibleDraftMessage(messages, draft);
    assert.equal(result.length, 2);
    assert.equal(result[1]?.id, "a1");
  });

  test("should_ignore_empty_draft", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", parts: [{ kind: "text", content: "Hi" }] },
    ];
    const draft: ChatMessage = { id: "a1", role: "assistant", parts: [] };

    const result = appendVisibleDraftMessage(messages, draft);
    assert.deepEqual(result, messages);
  });

  test("should_not_duplicate_existing_draft_id", () => {
    const existingAssistant: ChatMessage = {
      id: "a1",
      role: "assistant",
      parts: [{ kind: "text", content: "Already committed" }],
    };
    const draft: ChatMessage = {
      id: "a1",
      role: "assistant",
      parts: [{ kind: "text", content: "Duplicate" }],
    };

    const result = appendVisibleDraftMessage([existingAssistant], draft);
    assert.equal(result.length, 1);
    const firstPart = result[0]?.parts[0];
    assert.equal(firstPart?.kind, "text");
    if (firstPart?.kind === "text") {
      assert.equal(firstPart.content, "Already committed");
    }
  });

  test("should_settle_loading_tool_calls_before_append", () => {
    const draft: ChatMessage = {
      id: "a1",
      role: "assistant",
      parts: [{ kind: "tool-call", toolCall: reasoning("rs_1", "loading") }],
    };

    const result = appendVisibleDraftMessage([], draft);
    assert.equal(result.length, 1);
    const firstPart = result[0]?.parts[0];
    assert.equal(firstPart?.kind, "tool-call");
    if (firstPart?.kind === "tool-call") {
      assert.equal(firstPart.toolCall.state, "complete");
    }
  });

  test("should_settle_mixed_loading_states_in_interrupted_draft", () => {
    const draft: ChatMessage = {
      id: "a1",
      role: "assistant",
      parts: [
        { kind: "tool-call", toolCall: reasoning("rs_1", "complete") },
        { kind: "tool-call", toolCall: tool("mcp_1", "loading") },
        { kind: "tool-call", toolCall: reasoning("rs_2", "loading") },
        { kind: "text", content: "Partial response" },
      ],
    };

    const result = appendVisibleDraftMessage([], draft);
    assert.equal(result.length, 1);

    const toolStates = result[0]!.parts
      .filter(
        (p): p is Extract<ChatMessagePart, { kind: "tool-call" }> =>
          p.kind === "tool-call",
      )
      .map((p) => ({ id: p.toolCall.id, state: p.toolCall.state }));

    assert.deepEqual(toolStates, [
      { id: "rs_1", state: "complete" },
      { id: "mcp_1", state: "complete" },
      { id: "rs_2", state: "complete" },
    ]);

    const textPart = result[0]!.parts[3];
    assert.equal(textPart?.kind, "text");
    if (textPart?.kind === "text") {
      assert.equal(textPart.content, "Partial response");
    }
  });
});

describe("finalizeVisibleDraftMessage", () => {
  test("should_return_null_when_draft_is_not_visible", () => {
    assert.equal(finalizeVisibleDraftMessage(null), null);
    assert.equal(
      finalizeVisibleDraftMessage({ id: "a1", role: "assistant", parts: [] }),
      null,
    );
  });

  test("should_settle_loading_tool_calls", () => {
    const draft: ChatMessage = {
      id: "a1",
      role: "assistant",
      parts: [
        { kind: "tool-call", toolCall: reasoning("rs_1", "loading") },
        { kind: "text", content: "Partial response" },
      ],
    };

    const result = finalizeVisibleDraftMessage(draft);
    assert.ok(result);
    const firstPart = result.parts[0];
    assert.equal(firstPart?.kind, "tool-call");
    if (firstPart?.kind === "tool-call") {
      assert.equal(firstPart.toolCall.state, "complete");
    }
  });
});

describe("createMarketingDemoTranscriptMessage", () => {
  test("preserves tool-call-only assistant drafts", () => {
    const draft: ChatMessage = {
      id: "assistant-1",
      role: "assistant",
      parts: [{ kind: "tool-call", toolCall: tool("tc_1", "loading") }],
    };

    assert.deepEqual(createMarketingDemoTranscriptMessage(draft), {
      id: "assistant-1",
      role: "assistant",
      text: "",
      parts: [
        {
          kind: "tool-call",
          toolCall: {
            id: "tc_1",
            type: "mcpToolCall",
            label: "Read file",
            state: "loading",
            details: undefined,
            output: undefined,
            filePath: undefined,
            target: undefined,
          },
        },
      ],
    });
  });
});

describe("shouldApplyFinalText", () => {
  test("should_apply_when_draft_empty_and_ids_match", () => {
    assert.equal(shouldApplyFinalText("msg_1", "msg_1", ""), true);
  });

  test("should_apply_when_no_itemId_provided_and_draft_empty", () => {
    assert.equal(shouldApplyFinalText(undefined, null, ""), true);
  });

  test("should_not_apply_when_draft_already_has_content", () => {
    assert.equal(
      shouldApplyFinalText("msg_1", "msg_1", "Existing text."),
      false,
    );
  });

  test("should_apply_when_draft_has_only_whitespace", () => {
    assert.equal(shouldApplyFinalText("msg_1", "msg_1", "   \n  "), true);
  });

  test("should_not_apply_when_final_belongs_to_different_agentMessage", () => {
    assert.equal(shouldApplyFinalText("msg_1", "msg_2", ""), false);
  });

  test("should_accept_final_when_no_prior_delta_received", () => {
    assert.equal(shouldApplyFinalText("msg_1", null, ""), true);
  });
});

describe("resolveToolCallIndex", () => {
  test("should_return_neg1_when_no_items_exist", () => {
    assert.equal(resolveToolCallIndex([], "rs_tmp_1", "reasoning"), -1);
  });

  test("should_match_by_id_for_non_reasoning_items", () => {
    const existing = [tool("mcp_1", "loading")];
    assert.equal(resolveToolCallIndex(existing, "mcp_1", "mcpToolCall"), 0);
  });

  test("should_return_neg1_when_id_not_found_for_non_reasoning", () => {
    const existing = [tool("mcp_1", "complete")];
    assert.equal(resolveToolCallIndex(existing, "mcp_2", "mcpToolCall"), -1);
  });

  test("should_match_by_id_for_reasoning_when_id_matches", () => {
    const existing = [reasoning("rs_tmp_1", "loading")];
    assert.equal(resolveToolCallIndex(existing, "rs_tmp_1", "reasoning"), 0);
  });

  test("should_dedup_loading_reasoning_when_id_differs", () => {
    const existing = [reasoning("rs_tmp_1", "loading")];
    assert.equal(resolveToolCallIndex(existing, "rs_perm_1", "reasoning"), 0);
  });

  test("should_not_overwrite_completed_reasoning_with_new_reasoning", () => {
    const existing = [reasoning("rs_tmp_1", "complete")];
    assert.equal(resolveToolCallIndex(existing, "rs_tmp_2", "reasoning"), -1);
  });

  test("should_not_overwrite_errored_reasoning_with_new_reasoning", () => {
    const existing = [reasoning("rs_tmp_1", "error")];
    assert.equal(resolveToolCallIndex(existing, "rs_tmp_2", "reasoning"), -1);
  });

  test("should_find_loading_reasoning_among_mixed_items", () => {
    const existing = [
      reasoning("rs_1", "complete"),
      tool("mcp_1", "complete"),
      reasoning("rs_tmp_2", "loading"),
    ];
    assert.equal(resolveToolCallIndex(existing, "rs_perm_2", "reasoning"), 2);
  });

  test("should_append_when_all_reasoning_completed", () => {
    const existing = [
      reasoning("rs_1", "complete"),
      tool("mcp_1", "complete"),
      reasoning("rs_2", "complete"),
    ];
    assert.equal(resolveToolCallIndex(existing, "rs_tmp_3", "reasoning"), -1);
  });
});

describe("buildUserMessagePreview", () => {
  test("collapses overlay launch scaffolding to the user request body", () => {
    const preview = buildUserMessagePreview(
      `<window>\n<button>Save</button>\n</window>\n\n<user_request>\n@[Screen contents](</tmp/overlay-scope.png>)\n\nSummarize this screen.\n</user_request>`,
    );

    assert.equal(
      preview,
      `@[Screen contents](</tmp/overlay-scope.png>)\n\nSummarize this screen.`,
    );
  });

  test("renders selection context as a pasted-content chip preview instead of raw XML", () => {
    const preview = buildUserMessagePreview(
      `<window>\n<text>Alpha</text>\n</window>\n\n<user_request>\n@[Selection](</tmp/overlay-selection.png>)\n\n<selected_content>\nFirst line\nSecond line\n</selected_content>\n\nWork on this.\n</user_request>`,
    );

    assert.equal(
      preview,
      `<pasted-content label="Selection">\nFirst line\nSecond line\n</pasted-content>\n\nWork on this.`,
    );
  });
});

describe("buildStreamRequestBody", () => {
  test("includes active runtime overrides even when a profileId is present", () => {
    assert.deepEqual(
      buildStreamRequestBody({
        profileId: "profile-1",
        threadId: "thr_123",
        message: "hello",
        attachments: [],
        skills: [],
        options: {
          agentId: "agent-1",
          callerToken: "agtok_1",
          workspacePath: "/workspace/demo",
          system: "overlay system prompt",
          model: "gpt-5.4",
          codexProfileId: "openai-api",
          customEndpoint: "https://api.example.com/v1",
          customApiKey: "secret",
          reasoningEffort: "high",
        },
      }),
      {
        agentId: "agent-1",
        callerToken: "agtok_1",
        message: "hello",
        system: "overlay system prompt",
        skills: [],
        threadId: "thr_123",
        workspacePath: "/workspace/demo",
        attachments: [],
        reasoningEffort: "high",
        profileId: "profile-1",
        model: "gpt-5.4",
        codexProfileId: "openai-api",
        customEndpoint: "https://api.example.com/v1",
        customApiKey: "secret",
      },
    );
  });

  test("supports explicit runtime selection without a profileId", () => {
    assert.deepEqual(
      buildStreamRequestBody({
        profileId: "",
        threadId: null,
        message: "hello",
        attachments: [],
        skills: [],
        options: {
          model: "interpreter-smart",
        },
      }),
      {
        agentId: undefined,
        callerToken: undefined,
        message: "hello",
        system: undefined,
        skills: [],
        threadId: null,
        workspacePath: null,
        attachments: [],
        reasoningEffort: undefined,
        model: "interpreter-smart",
      },
    );
  });

  test("rejects agent requests that omit callerToken", () => {
    assert.throws(
      () =>
        buildStreamRequestBody({
          profileId: "",
          threadId: null,
          message: "hello",
          attachments: [],
          skills: [],
          options: {
            agentId: "agent-1",
            model: "interpreter-smart",
          },
        }),
      /Agent chat requests require both agentId and callerToken\./,
    );
  });
});

describe("describeStreamFailure", () => {
  test("prefers renderer reload message over generic network error", () => {
    assert.equal(
      describeStreamFailure(new Error("network error"), true),
      "Renderer reloaded during response.",
    );
  });

  test("uses the underlying error message when not interrupted by reload", () => {
    assert.equal(
      describeStreamFailure(new Error("network error"), false),
      "network error",
    );
  });
});

describe("clearBackgroundProcessesFromMessage", () => {
  test("clears background process markers from command execution parts", () => {
    const message: ChatMessage = {
      id: "assistant-1",
      role: "assistant",
      parts: [
        {
          kind: "tool-call",
          toolCall: {
            id: "cmd-1",
            type: "commandExecution",
            label: "sleep 30 &",
            state: "complete",
            processId: "123",
            backgroundState: "waiting",
            backgroundInput: "pwd\n",
            item: {
              type: "commandExecution",
              id: "cmd-1",
              command: "sleep 30 &",
              cwd: "/tmp",
              processId: "123",
              status: "completed",
              commandActions: [],
              aggregatedOutput: null,
              exitCode: 0,
              durationMs: 10,
            },
          },
        },
        {
          kind: "tool-call",
          toolCall: {
            id: "reason-1",
            type: "reasoning",
            label: "Reasoning",
            state: "complete",
          },
        },
      ],
    };

    const cleared = clearBackgroundProcessesFromMessage(message);
    const command = cleared.parts[0];
    const reasoning = cleared.parts[1];

    assert.equal(command?.kind, "tool-call");
    if (command?.kind === "tool-call") {
      assert.equal(command.toolCall.processId, null);
      assert.equal(command.toolCall.backgroundState, undefined);
      assert.equal(command.toolCall.backgroundInput, undefined);
      assert.equal(command.toolCall.item?.type, "commandExecution");
      if (command.toolCall.item?.type === "commandExecution") {
        assert.equal(command.toolCall.item.processId, null);
      }
    }

    assert.equal(reasoning?.kind, "tool-call");
    if (reasoning?.kind === "tool-call") {
      assert.equal(reasoning.toolCall.type, "reasoning");
    }
  });

  test("clears only the requested process ids when filtering by process id", () => {
    const message: ChatMessage = {
      id: "assistant-2",
      role: "assistant",
      parts: [
        {
          kind: "tool-call",
          toolCall: {
            id: "cmd-1",
            type: "commandExecution",
            label: "sleep 30 &",
            state: "complete",
            processId: "123",
            backgroundState: "waiting",
            item: {
              type: "commandExecution",
              id: "cmd-1",
              command: "sleep 30 &",
              cwd: "/tmp",
              processId: "123",
              status: "completed",
              commandActions: [],
              aggregatedOutput: null,
              exitCode: null,
              durationMs: null,
            },
          },
        },
        {
          kind: "tool-call",
          toolCall: {
            id: "cmd-2",
            type: "commandExecution",
            label: "sleep 60 &",
            state: "complete",
            processId: "456",
            backgroundState: "waiting",
            item: {
              type: "commandExecution",
              id: "cmd-2",
              command: "sleep 60 &",
              cwd: "/tmp",
              processId: "456",
              status: "completed",
              commandActions: [],
              aggregatedOutput: null,
              exitCode: null,
              durationMs: null,
            },
          },
        },
      ],
    };

    const cleared = clearBackgroundProcessesFromMessageByProcessIds(
      message,
      new Set(["123"]),
    );
    const first = cleared.parts[0];
    const second = cleared.parts[1];

    assert.equal(first?.kind, "tool-call");
    if (first?.kind === "tool-call") {
      assert.equal(first.toolCall.processId, null);
      assert.equal(first.toolCall.backgroundState, undefined);
    }

    assert.equal(second?.kind, "tool-call");
    if (second?.kind === "tool-call") {
      assert.equal(second.toolCall.processId, "456");
      assert.equal(second.toolCall.backgroundState, "waiting");
    }
  });
});

describe("stopLoadingToolCallsInMessage", () => {
  test("marks loading reasoning as complete", () => {
    const message: ChatMessage = {
      id: "assistant-reasoning",
      role: "assistant",
      parts: [
        {
          kind: "tool-call",
          toolCall: {
            id: "reason-1",
            type: "reasoning",
            label: "Thinking",
            state: "loading",
            item: {
              type: "reasoning",
              id: "reason-1",
              summary: ["thinking"],
              content: ["internal"],
            },
          },
        },
      ],
    };

    const stopped = stopLoadingToolCallsInMessage(message);
    const part = stopped.parts[0];

    assert.equal(part?.kind, "tool-call");
    if (part?.kind === "tool-call") {
      assert.equal(part.toolCall.state, "complete");
      assert.equal(part.toolCall.item?.type, "reasoning");
    }
  });

  test("marks loading command executions as complete and clears process markers", () => {
    const message: ChatMessage = {
      id: "assistant-command",
      role: "assistant",
      parts: [
        {
          kind: "tool-call",
          toolCall: {
            id: "cmd-1",
            type: "commandExecution",
            label: "sleep 30",
            state: "loading",
            processId: "123",
            backgroundState: "waiting",
            backgroundInput: "pwd\n",
            item: {
              type: "commandExecution",
              id: "cmd-1",
              command: "sleep 30",
              cwd: "/tmp",
              processId: "123",
              status: "inProgress",
              commandActions: [],
              aggregatedOutput: null,
              exitCode: null,
              durationMs: null,
            },
          },
        },
      ],
    };

    const stopped = stopLoadingToolCallsInMessage(message);
    const part = stopped.parts[0];

    assert.equal(part?.kind, "tool-call");
    if (part?.kind === "tool-call") {
      assert.equal(part.toolCall.state, "complete");
      assert.equal(part.toolCall.processId, null);
      assert.equal(part.toolCall.backgroundState, undefined);
      assert.equal(part.toolCall.backgroundInput, undefined);
      assert.equal(part.toolCall.item?.type, "commandExecution");
      if (part.toolCall.item?.type === "commandExecution") {
        assert.equal(part.toolCall.item.status, "completed");
        assert.equal(part.toolCall.item.processId, null);
      }
    }
  });
});
