import { describe, test, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";

import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { mapThreadToChatMessages } from "./thread-history-mapper";
import { enrichThreadWithReasoning } from "./enrich-thread-reasoning";
import { toolOutputFromItem } from "./tool-call-format";
import { textContent, msgToolCalls } from "../../hooks/use-chat";
import {
  extractSkillMentionsFromText,
  serializeSkillMentionToken,
} from "../../../shared/utils/skillMentions";
import type { v2 } from "../../../server/handlers/codex-generated-types/index";

function makeThread(turns: v2.Turn[]): v2.Thread {
  return {
    id: "thr_test",
    preview: "test thread",
    modelProvider: "openai",
    createdAt: 1700000000,
    updatedAt: 1700000000,
    status: { type: "idle" },
    path: null,
    cwd: "/tmp",
    cliVersion: "1.0.0",
    source: "appServer",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns,
  };
}

function makeTurn(items: v2.ThreadItem[], id = "turn_1"): v2.Turn {
  return { id, items, status: "completed", error: null };
}

describe("mapThreadToChatMessages", () => {
  test("should_return_empty_array_when_thread_has_no_turns", () => {
    const thread = makeThread([]);
    const result = mapThreadToChatMessages(thread);
    assert.deepEqual(result, []);
  });

  test("should_map_user_message_and_agent_message_to_two_chat_messages", () => {
    const thread = makeThread([
      makeTurn([
        {
          type: "userMessage",
          id: "item_1",
          content: [{ type: "text", text: "Hello", text_elements: [] }],
        },
        {
          type: "agentMessage",
          id: "item_2",
          text: "Hi there!",
          phase: "final_answer",
        },
      ]),
    ]);

    const result = mapThreadToChatMessages(thread);
    assert.equal(result.length, 2);
    assert.equal(result[0]?.role, "user");
    assert.equal(textContent(result[0]!), "Hello");
    assert.equal(result[1]?.role, "assistant");
    assert.equal(textContent(result[1]!), "Hi there!");
  });

  test("should_restore_skill_mentions_inline_when_reloading_thread_history", () => {
    const serializedMention = serializeSkillMentionToken({
      id: "project:skill-creator:/workspace/current/.agents/skills/skill-creator/SKILL.md",
      label: "Skill Creator",
      name: "skill-creator",
      path: "/workspace/current/.agents/skills/skill-creator/SKILL.md",
    });
    const extracted = extractSkillMentionsFromText(
      `Use ${serializedMention} twice: ${serializedMention}`,
    );

    const thread = makeThread([
      makeTurn([
        {
          type: "userMessage",
          id: "item_1",
          content: [
            { type: "text", text: extracted.text, text_elements: [] },
            {
              type: "skill",
              name: "skill-creator",
              path: "/workspace/current/.agents/skills/skill-creator/SKILL.md",
            },
          ],
        },
      ]),
    ]);

    const result = mapThreadToChatMessages(thread);
    assert.equal(result.length, 1);
    assert.equal(
      textContent(result[0]!),
      `Use ${serializedMention} twice: ${serializedMention}`,
    );
  });

  test("should_split_assistant_when_tools_precede_agentMessage", () => {
    const thread = makeThread([
      makeTurn([
        {
          type: "userMessage",
          id: "item_1",
          content: [{ type: "text", text: "Run tests", text_elements: [] }],
        },
        {
          type: "commandExecution",
          id: "item_2",
          command: "npm test",
          cwd: "/project",
          processId: null,
          status: "completed",
          commandActions: [],
          aggregatedOutput: "PASS",
          exitCode: 0,
          durationMs: 1000,
        },
        {
          type: "mcpToolCall",
          id: "item_3",
          server: "interpreter",
          tool: "builtin-fs__read_file",
          status: "completed",
          arguments: { path: "/tmp/test.ts" },
          result: { content: [{ type: "text", text: "file content" }], structuredContent: null },
          error: null,
          durationMs: 50,
        },
        {
          type: "agentMessage",
          id: "item_4",
          text: "Tests passed!",
          phase: "final_answer",
        },
      ]),
    ]);

    const result = mapThreadToChatMessages(thread);
    assert.equal(result.length, 3);

    const toolsOnly = result[1]!;
    assert.equal(toolsOnly.role, "assistant");
    assert.equal(textContent(toolsOnly), "");
    assert.equal(msgToolCalls(toolsOnly).length, 2);
    assert.equal(msgToolCalls(toolsOnly)[0]?.type, "commandExecution");
    assert.equal(msgToolCalls(toolsOnly)[0]?.state, "complete");
    assert.equal(msgToolCalls(toolsOnly)[1]?.type, "mcpToolCall");

    const textOnly = result[2]!;
    assert.equal(textOnly.role, "assistant");
    assert.equal(textContent(textOnly), "Tests passed!");
    assert.equal(textOnly.serverMessageId, "turn_1");
  });

  test("should_split_assistant_when_agentMessage_follows_non_reasoning_tools", () => {
    const thread = makeThread([
      makeTurn([
        {
          type: "userMessage",
          id: "item_1",
          content: [{ type: "text", text: "Explore this", text_elements: [] }],
        },
        {
          type: "agentMessage",
          id: "item_2",
          text: "I'll read the file.",
          phase: null,
        },
        {
          type: "mcpToolCall",
          id: "item_3",
          server: "interpreter",
          tool: "builtin-fs__read_file",
          status: "completed",
          arguments: { path: "/tmp/test.ts" },
          result: { content: [{ type: "text", text: "content" }], structuredContent: null },
          error: null,
          durationMs: 50,
        },
        {
          type: "agentMessage",
          id: "item_4",
          text: "Here is what I found.",
          phase: "final_answer",
        },
      ]),
    ]);

    const result = mapThreadToChatMessages(thread);
    assert.equal(result.length, 3);

    assert.equal(result[0]?.role, "user");

    const first = result[1]!;
    assert.equal(first.role, "assistant");
    assert.equal(textContent(first), "I'll read the file.");
    assert.equal(msgToolCalls(first).length, 1);
    assert.equal(msgToolCalls(first)[0]?.type, "mcpToolCall");
    assert.equal(first.serverMessageId, "turn_1");

    const second = result[2]!;
    assert.equal(second.role, "assistant");
    assert.equal(textContent(second), "Here is what I found.");
    assert.equal(second.serverMessageId, "turn_1");
  });

  test("should_preserve_post_tool_reasoning_order_in_toolCalls_array", () => {
    const thread = makeThread([
      makeTurn([
        {
          type: "userMessage",
          id: "item_1",
          content: [{ type: "text", text: "Read it", text_elements: [] }],
        },
        {
          type: "agentMessage",
          id: "item_2",
          text: "I'll read the file.",
          phase: null,
        },
        {
          type: "mcpToolCall",
          id: "item_3",
          server: "interpreter",
          tool: "builtin-fs__read_file",
          status: "completed",
          arguments: { path: "/tmp/test.ts" },
          result: { content: [{ type: "text", text: "content" }], structuredContent: null },
          error: null,
          durationMs: 50,
        },
        {
          type: "reasoning",
          id: "item_4",
          summary: ["Analyzing the file"],
          content: ["thinking about results"],
        },
        {
          type: "agentMessage",
          id: "item_5",
          text: "Here is what I found.",
          phase: "final_answer",
        },
      ]),
    ]);

    const result = mapThreadToChatMessages(thread);
    assert.equal(result.length, 3);

    const first = result[1]!;
    assert.equal(textContent(first), "I'll read the file.");
    assert.equal(msgToolCalls(first).length, 2);
    assert.equal(msgToolCalls(first)[0]?.type, "mcpToolCall");
    assert.equal(msgToolCalls(first)[1]?.type, "reasoning");
  });

  test("should_split_when_reasoning_precedes_agentMessage", () => {
    const thread = makeThread([
      makeTurn([
        {
          type: "userMessage",
          id: "item_1",
          content: [{ type: "text", text: "Think about this", text_elements: [] }],
        },
        {
          type: "reasoning",
          id: "item_2",
          summary: ["Let me think"],
          content: ["raw reasoning"],
        },
        {
          type: "agentMessage",
          id: "item_3",
          text: "Here is my answer.",
          phase: "final_answer",
        },
      ]),
    ]);

    const result = mapThreadToChatMessages(thread);
    assert.equal(result.length, 3);

    const activity = result[1]!;
    assert.equal(activity.role, "assistant");
    assert.equal(msgToolCalls(activity).length, 1);
    assert.equal(msgToolCalls(activity)[0]?.type, "reasoning");
    assert.equal(textContent(activity), "");

    const assistant = result[2]!;
    assert.equal(assistant.role, "assistant");
    assert.equal(textContent(assistant), "Here is my answer.");
  });

  test("should_map_reasoning_to_tool_call", () => {
    const thread = makeThread([
      makeTurn([
        {
          type: "userMessage",
          id: "item_1",
          content: [{ type: "text", text: "Think about this", text_elements: [] }],
        },
        {
          type: "reasoning",
          id: "item_2",
          summary: ["Let me think about it", "considering options"],
          content: ["raw reasoning content"],
        },
        {
          type: "agentMessage",
          id: "item_3",
          text: "Here is my answer.",
          phase: "final_answer",
        },
      ]),
    ]);

    const result = mapThreadToChatMessages(thread);
    assert.equal(result.length, 3);

    const activity = result[1]!;
    assert.equal(activity.role, "assistant");
    assert.equal(msgToolCalls(activity).length, 1);
    assert.equal(msgToolCalls(activity)[0]?.type, "reasoning");

    const answer = result[2]!;
    assert.equal(answer.role, "assistant");
    assert.equal(textContent(answer), "Here is my answer.");
  });

  test("should_render_context_compaction_as_a_hidden_divider_message", () => {
    const thread = makeThread([
      makeTurn([
        {
          type: "userMessage",
          id: "item_1",
          content: [{ type: "text", text: "Hello", text_elements: [] }],
        },
        { type: "imageView", id: "item_2", path: "/tmp/img.png" },
        { type: "contextCompaction", id: "item_3" },
        { type: "enteredReviewMode", id: "item_4", review: "review text" },
        { type: "exitedReviewMode", id: "item_5", review: "review text" },
        {
          type: "agentMessage",
          id: "item_6",
          text: "Done.",
          phase: "final_answer",
        },
      ]),
    ]);

    const result = mapThreadToChatMessages(thread);
    assert.equal(result.length, 4);
    assert.equal(result[0]?.role, "user");
    assert.equal(result[1]?.role, "assistant");
    assert.ok(msgToolCalls(result[1]!).length > 0);
    assert.equal(result[2]?.role, "assistant");
    assert.equal(
      textContent(result[2]!),
      '<compaction reason="context_limit"></compaction>',
    );
    assert.equal(result[3]?.role, "assistant");
    assert.equal(textContent(result[3]!), "Done.");
  });

  test("should_produce_correct_interleaved_messages_for_multi_turn", () => {
    const thread = makeThread([
      makeTurn(
        [
          {
            type: "userMessage",
            id: "item_1",
            content: [{ type: "text", text: "First question", text_elements: [] }],
          },
          {
            type: "agentMessage",
            id: "item_2",
            text: "First answer",
            phase: "final_answer",
          },
        ],
        "turn_1",
      ),
      makeTurn(
        [
          {
            type: "userMessage",
            id: "item_3",
            content: [{ type: "text", text: "Second question", text_elements: [] }],
          },
          {
            type: "agentMessage",
            id: "item_4",
            text: "Second answer",
            phase: "final_answer",
          },
        ],
        "turn_2",
      ),
      makeTurn(
        [
          {
            type: "userMessage",
            id: "item_5",
            content: [{ type: "text", text: "Third question", text_elements: [] }],
          },
          {
            type: "agentMessage",
            id: "item_6",
            text: "Third answer",
            phase: "final_answer",
          },
        ],
        "turn_3",
      ),
    ]);

    const result = mapThreadToChatMessages(thread);
    assert.equal(result.length, 6);
    assert.equal(textContent(result[0]!), "First question");
    assert.equal(textContent(result[1]!), "First answer");
    assert.equal(textContent(result[2]!), "Second question");
    assert.equal(textContent(result[3]!), "Second answer");
    assert.equal(textContent(result[4]!), "Third question");
    assert.equal(textContent(result[5]!), "Third answer");
  });

  test("should_set_serverMessageId_from_turn_id_on_assistant_messages", () => {
    const thread = makeThread([
      makeTurn(
        [
          {
            type: "userMessage",
            id: "item_1",
            content: [{ type: "text", text: "First", text_elements: [] }],
          },
          {
            type: "agentMessage",
            id: "item_2",
            text: "Reply one",
            phase: "final_answer",
          },
        ],
        "turn_abc",
      ),
      makeTurn(
        [
          {
            type: "userMessage",
            id: "item_3",
            content: [{ type: "text", text: "Second", text_elements: [] }],
          },
          {
            type: "agentMessage",
            id: "item_4",
            text: "Reply two",
            phase: "final_answer",
          },
        ],
        "turn_def",
      ),
    ]);

    const result = mapThreadToChatMessages(thread);
    assert.equal(result[0]?.serverMessageId, undefined);
    assert.equal(result[1]?.serverMessageId, "turn_abc");
    assert.equal(result[2]?.serverMessageId, undefined);
    assert.equal(result[3]?.serverMessageId, "turn_def");
  });

  test("should_map_failed_tool_item_to_error_state", () => {
    const thread = makeThread([
      makeTurn([
        {
          type: "userMessage",
          id: "item_1",
          content: [{ type: "text", text: "Run it", text_elements: [] }],
        },
        {
          type: "commandExecution",
          id: "item_2",
          command: "false",
          cwd: "/tmp",
          processId: null,
          status: "failed",
          commandActions: [],
          aggregatedOutput: "error output",
          exitCode: 1,
          durationMs: 100,
        },
      ]),
    ]);

    const result = mapThreadToChatMessages(thread);
    const assistant = result[1];
    assert.equal(msgToolCalls(assistant!)[0]?.state, "error");
  });

  test("should_map_plan_item_to_assistant_text", () => {
    const thread = makeThread([
      makeTurn([
        {
          type: "userMessage",
          id: "item_1",
          content: [{ type: "text", text: "Plan this", text_elements: [] }],
        },
        {
          type: "plan",
          id: "item_2",
          text: "1. Read code\n2. Fix bug\n3. Test",
        },
        {
          type: "agentMessage",
          id: "item_3",
          text: "Here is my plan.",
          phase: "final_answer",
        },
      ]),
    ]);

    const result = mapThreadToChatMessages(thread);
    assert.equal(result.length, 3);

    const planMsg = result[1]!;
    assert.equal(msgToolCalls(planMsg).length, 1);
    assert.equal(msgToolCalls(planMsg)[0]?.type, "plan");

    const textMsg = result[2]!;
    assert.ok(textContent(textMsg).includes("Here is my plan."));
  });

  test("should_extract_text_only_from_user_input_with_mixed_content", () => {
    const thread = makeThread([
      makeTurn([
        {
          type: "userMessage",
          id: "item_1",
          content: [
            { type: "text", text: "Check this image", text_elements: [] },
            { type: "image", url: "https://example.com/img.png" } as any,
          ],
        },
        {
          type: "agentMessage",
          id: "item_2",
          text: "I see the image.",
          phase: "final_answer",
        },
      ]),
    ]);

    const result = mapThreadToChatMessages(thread);
    assert.equal(textContent(result[0]!), "Check this image");
  });

  test("should_handle_every_thread_item_type_without_crash", () => {
    const allItems: v2.ThreadItem[] = [
      { type: "userMessage", id: "1", content: [{ type: "text", text: "hi", text_elements: [] }] },
      { type: "agentMessage", id: "2", text: "hello", phase: null },
      { type: "plan", id: "3", text: "plan text" },
      { type: "reasoning", id: "4", summary: ["think"], content: ["raw"] },
      {
        type: "commandExecution", id: "5", command: "ls", cwd: "/tmp",
        processId: null, status: "completed", commandActions: [],
        aggregatedOutput: "out", exitCode: 0, durationMs: 10,
      },
      {
        type: "fileChange", id: "6",
        changes: [{ path: "a.ts", kind: { type: "update", move_path: null }, diff: "diff" }],
        status: "completed",
      },
      {
        type: "mcpToolCall", id: "7", server: "s", tool: "t",
        status: "completed", arguments: {}, result: null, error: null, durationMs: 5,
      },
      {
        type: "collabAgentToolCall", id: "8", tool: "spawnAgent",
        status: "completed", senderThreadId: "s1", receiverThreadIds: ["r1"],
        prompt: "do stuff", agentsStates: {},
      },
      { type: "webSearch", id: "9", query: "test query", action: null },
      { type: "imageView", id: "10", path: "/img.png" },
      { type: "enteredReviewMode", id: "11", review: "rev" },
      { type: "exitedReviewMode", id: "12", review: "rev" },
      { type: "contextCompaction", id: "13" },
    ];

    const thread = makeThread([makeTurn(allItems)]);
    assert.doesNotThrow(() => mapThreadToChatMessages(thread));

    const result = mapThreadToChatMessages(thread);
    assert.ok(result.length > 0);
  });

  test("should_create_assistant_message_for_tool_only_turn", () => {
    const thread = makeThread([
      makeTurn([
        {
          type: "userMessage",
          id: "item_1",
          content: [{ type: "text", text: "Do something", text_elements: [] }],
        },
        {
          type: "commandExecution",
          id: "item_2",
          command: "echo hi",
          cwd: "/tmp",
          processId: null,
          status: "completed",
          commandActions: [],
          aggregatedOutput: "hi",
          exitCode: 0,
          durationMs: 10,
        },
      ]),
    ]);

    const result = mapThreadToChatMessages(thread);
    assert.equal(result.length, 2);
    const assistant = result[1];
    assert.equal(assistant?.role, "assistant");
    assert.equal(textContent(assistant!), "");
    assert.equal(msgToolCalls(assistant!).length, 1);
  });

  test("should_map_commandExecution_to_a_friendly_one_line_summary_when_commandActions_are_present", () => {
    const thread = makeThread([
      makeTurn([
        {
          type: "userMessage",
          id: "item_1",
          content: [{ type: "text", text: "Find commandActions usage", text_elements: [] }],
        },
        {
          type: "commandExecution",
          id: "item_2",
          command: "rg -n commandActions src",
          cwd: "/workspace",
          processId: null,
          status: "completed",
          commandActions: [
            {
              type: "search",
              command: "rg -n commandActions src",
              query: "commandActions",
              path: "/workspace/src",
            },
          ],
          aggregatedOutput: "src/lib/codex/tool-call-format.ts:1",
          exitCode: 0,
          durationMs: 10,
        },
      ]),
    ]);

    const result = mapThreadToChatMessages(thread);
    const assistant = result[1]!;
    const toolCall = msgToolCalls(assistant)[0]!;

    assert.equal(toolCall.type, "commandExecution");
    assert.equal(toolCall.label, 'Searching src for "commandActions"');
    assert.equal(toolCall.verb?.active, "Searching");
    assert.equal(toolCall.verb?.past, "Searched");
    assert.equal(toolCall.target, 'src for "commandActions"');
  });

  test("should_render_bash_wrapper_commandExecution_with_a_generic_script_target", () => {
    const thread = makeThread([
      makeTurn([
        {
          type: "userMessage",
          id: "item_1",
          content: [{ type: "text", text: "Convert the markdown", text_elements: [] }],
        },
        {
          type: "commandExecution",
          id: "item_2",
          command: `/bin/zsh -lc "set -e SRC='/Users/example/Documents/My Workspace/Notes/Research Notes.md' OUT='/Users/example/Documents/My Workspace/Notes/Research Notes.pdf' pandoc \\"$SRC\\" -o \\"$OUT\\""`,
          cwd: "/workspace",
          processId: null,
          status: "completed",
          commandActions: [],
          aggregatedOutput: "done",
          exitCode: 0,
          durationMs: 10,
        },
      ]),
    ]);

    const result = mapThreadToChatMessages(thread);
    const assistant = result[1]!;
    const toolCall = msgToolCalls(assistant)[0]!;

    assert.equal(toolCall.type, "commandExecution");
    assert.equal(toolCall.verb?.active, "Running");
    assert.equal(toolCall.verb?.past, "Ran");
    assert.equal(toolCall.target, "script");
  });

  test("should_preserve_reloaded_custom_tool_source_on_commandExecution", () => {
    const thread = makeThread([
      makeTurn([
        {
          type: "userMessage",
          id: "item_1",
          content: [{ type: "text", text: "Open the page", text_elements: [] }],
        },
        {
          type: "commandExecution",
          id: "item_2",
          command: "js_repl",
          cwd: "/workspace",
          processId: null,
          status: "completed",
          commandActions: [],
          aggregatedOutput: "ok",
          exitCode: 0,
          durationMs: 10,
          sourceInput: 'await page.goto("https://example.com");',
          sourceToolName: "js_repl",
        } as v2.ThreadItem & { sourceInput: string; sourceToolName: string },
      ]),
    ]);

    const result = mapThreadToChatMessages(thread);
    const assistant = result[1]!;
    const toolCall = msgToolCalls(assistant)[0]!;

    assert.equal(toolCall.type, "commandExecution");
    assert.equal(toolCall.sourceToolName, "js_repl");
    assert.equal(toolCall.sourceInput, 'await page.goto("https://example.com");');
  });

  test("should_map_file_change_to_tool_call", () => {
    const thread = makeThread([
      makeTurn([
        {
          type: "userMessage",
          id: "item_1",
          content: [{ type: "text", text: "Fix the file", text_elements: [] }],
        },
        {
          type: "fileChange",
          id: "item_2",
          changes: [
            { path: "src/main.ts", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-old\n+new" },
          ],
          status: "completed",
        },
      ]),
    ]);

    const result = mapThreadToChatMessages(thread);
    const assistant = result[1];
    assert.equal(msgToolCalls(assistant!)[0]?.type, "fileChange");
    assert.equal(msgToolCalls(assistant!)[0]?.state, "complete");
  });

  test("should_map_web_search_to_tool_call", () => {
    const thread = makeThread([
      makeTurn([
        {
          type: "userMessage",
          id: "item_1",
          content: [{ type: "text", text: "Search for info", text_elements: [] }],
        },
        {
          type: "webSearch",
          id: "item_2",
          query: "typescript best practices",
          action: null,
        },
        {
          type: "agentMessage",
          id: "item_3",
          text: "Here's what I found.",
          phase: "final_answer",
        },
      ]),
    ]);

    const result = mapThreadToChatMessages(thread);
    const assistant = result[1];
    assert.equal(msgToolCalls(assistant!)[0]?.type, "webSearch");
  });

  test("should_not_restore_normal_command_execution_as_background_from_process_id_alone", () => {
    const thread = makeThread([
      makeTurn([
        {
          type: "userMessage",
          id: "item_1",
          content: [{ type: "text", text: "Read it", text_elements: [] }],
        },
        {
          type: "commandExecution",
          id: "item_2",
          command: "cat README.md",
          cwd: "/tmp",
          processId: "1000",
          status: "completed",
          commandActions: [],
          aggregatedOutput: "hello",
          exitCode: 0,
          durationMs: 10,
        },
      ]),
    ]);

    const result = mapThreadToChatMessages(thread);
    assert.equal(msgToolCalls(result[1]!)[0]?.backgroundState, undefined);
  });

  test("should_map_declined_file_change_to_error_state", () => {
    const thread = makeThread([
      makeTurn([
        {
          type: "userMessage",
          id: "item_1",
          content: [{ type: "text", text: "Fix it", text_elements: [] }],
        },
        {
          type: "fileChange",
          id: "item_2",
          changes: [],
          status: "declined",
        },
      ]),
    ]);

    const result = mapThreadToChatMessages(thread);
    const assistant = result[1];
    assert.equal(msgToolCalls(assistant!)[0]?.state, "error");
  });
});

describe("toolOutputFromItem", () => {
  test("should_return_aggregatedOutput_for_commandExecution", () => {
    const item: v2.ThreadItem = {
      type: "commandExecution",
      id: "cmd_1",
      command: "ls -la",
      cwd: "/tmp",
      processId: null,
      status: "completed",
      commandActions: [],
      aggregatedOutput: "file1.txt\nfile2.txt",
      exitCode: 0,
      durationMs: 10,
    };
    assert.equal(toolOutputFromItem(item), "file1.txt\nfile2.txt");
  });

  test("should_rewrite_windows_sandbox_spawn_error_to_actionable_guidance", () => {
    const item: v2.ThreadItem = {
      type: "commandExecution",
      id: "cmd_windows_sandbox_1",
      command: "powershell.exe -Command Get-ChildItem",
      cwd: "C:\\Users\\wahee\\Documents\\My Workspace",
      processId: null,
      status: "failed",
      commandActions: [],
      aggregatedOutput:
        'execution error: Io(Custom { kind: Other, error: "windows sandbox: CreateProcessWithLogonW failed: 267" })',
      exitCode: 1,
      durationMs: 10,
    };

    const output = toolOutputFromItem(item);
    assert.ok(output);
    assert.equal(
      output,
      "Windows sandbox failed to start this command (CreateProcessWithLogonW error 267).\n"
      + "Open Settings -> Native Tools and run Windows sandbox setup, then retry.\n"
      + "If this continues, temporarily set Sandbox Mode to Full Access.",
    );
  });

  test("should_return_undefined_for_commandExecution_without_output", () => {
    const item: v2.ThreadItem = {
      type: "commandExecution",
      id: "cmd_2",
      command: "true",
      cwd: "/tmp",
      processId: null,
      status: "completed",
      commandActions: [],
      aggregatedOutput: null,
      exitCode: 0,
      durationMs: 1,
    };
    assert.equal(toolOutputFromItem(item), undefined);
  });

  test("should_return_text_content_for_mcpToolCall_result", () => {
    const item: v2.ThreadItem = {
      type: "mcpToolCall",
      id: "mcp_1",
      server: "test-server",
      tool: "read_file",
      status: "completed",
      arguments: { path: "/tmp/test.txt" },
      result: {
        content: [{ type: "text", text: "file contents here" }],
        structuredContent: null,
      },
      error: null,
      durationMs: 50,
    };
    const output = toolOutputFromItem(item);
    assert.ok(output);
    assert.equal(output, "file contents here");
  });

  test("should_return_error_message_for_failed_mcpToolCall", () => {
    const item: v2.ThreadItem = {
      type: "mcpToolCall",
      id: "mcp_2",
      server: "test-server",
      tool: "bad_tool",
      status: "failed",
      arguments: {},
      result: null,
      error: { message: "Tool not found" },
      durationMs: 5,
    };
    assert.equal(toolOutputFromItem(item), "Error: Tool not found");
  });

  test("should_return_undefined_for_mcpToolCall_without_result", () => {
    const item: v2.ThreadItem = {
      type: "mcpToolCall",
      id: "mcp_3",
      server: "test-server",
      tool: "slow_tool",
      status: "inProgress",
      arguments: {},
      result: null,
      error: null,
      durationMs: null,
    };
    assert.equal(toolOutputFromItem(item), undefined);
  });

  test("should_return_joined_diffs_for_fileChange", () => {
    const item: v2.ThreadItem = {
      type: "fileChange",
      id: "fc_1",
      changes: [
        { path: "a.ts", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-old\n+new" },
        { path: "b.ts", kind: { type: "add" }, diff: "@@ -0,0 +1 @@\n+added" },
      ],
      status: "completed",
    };
    const output = toolOutputFromItem(item);
    assert.ok(output);
    assert.ok(output.includes("-old"));
    assert.ok(output.includes("+new"));
    assert.ok(output.includes("+added"));
  });

  test("should_return_undefined_for_empty_fileChange", () => {
    const item: v2.ThreadItem = {
      type: "fileChange",
      id: "fc_2",
      changes: [],
      status: "completed",
    };
    assert.equal(toolOutputFromItem(item), undefined);
  });

  test("should_return_action_json_for_webSearch", () => {
    const item: v2.ThreadItem = {
      type: "webSearch",
      id: "ws_1",
      query: "typescript generics",
      action: { type: "search", query: "typescript generics", queries: null },
    };
    const output = toolOutputFromItem(item);
    assert.ok(output);
    const parsed = JSON.parse(output);
    assert.equal(parsed.type, "search");
    assert.equal(parsed.query, "typescript generics");
  });

  test("should_return_undefined_for_webSearch_without_action", () => {
    const item: v2.ThreadItem = {
      type: "webSearch",
      id: "ws_2",
      query: "something",
      action: null,
    };
    assert.equal(toolOutputFromItem(item), undefined);
  });

  test("should_return_agent_states_for_collabAgentToolCall", () => {
    const item: v2.ThreadItem = {
      type: "collabAgentToolCall",
      id: "ca_1",
      tool: "spawnAgent",
      status: "completed",
      senderThreadId: "thr_sender",
      receiverThreadIds: ["thr_child"],
      prompt: "Do the task",
      agentsStates: {
        thr_child: { status: "completed", message: "Done" },
      },
    };
    const output = toolOutputFromItem(item);
    assert.ok(output);
    assert.ok(output.includes("thr_child"));
    assert.ok(output.includes("completed"));
    assert.ok(output.includes("Done"));
  });

  test("should_return_undefined_for_empty_agentsStates", () => {
    const item: v2.ThreadItem = {
      type: "collabAgentToolCall",
      id: "ca_2",
      tool: "wait",
      status: "inProgress",
      senderThreadId: "thr_sender",
      receiverThreadIds: [],
      prompt: null,
      agentsStates: {},
    };
    assert.equal(toolOutputFromItem(item), undefined);
  });

  test("should_extract_content_for_unknown_item_types", () => {
    const item: v2.ThreadItem = {
      type: "agentMessage",
      id: "msg_1",
      text: "Hello",
      phase: null,
    };
    const output = toolOutputFromItem(item);
    assert.ok(output?.includes("Hello"));
  });
});

describe("enrichThreadWithReasoning", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "enrich-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true });
  });

  function writeRollout(lines: object[]): string {
    const p = join(tmpDir, "rollout.jsonl");
    writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return p;
  }

  test("should_return_unchanged_when_path_is_null", () => {
    const thread = makeThread([
      makeTurn([
        { type: "agentMessage", id: "item_1", text: "Hello", phase: "final_answer" },
      ]),
    ]);
    const result = enrichThreadWithReasoning(thread);
    assert.deepEqual(result.turns, thread.turns);
  });

  test("should_attach_custom_tool_input_to_matching_commandExecution_without_reasoning", () => {
    const rolloutPath = writeRollout([
      { timestamp: "t0", type: "turn_context", payload: { turn_id: "turn_1", cwd: "/tmp", approval_policy: "on-failure", sandbox_policy: "none", model: "gpt-4", summary: "auto" } },
      { timestamp: "t1", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Open the page" }] } },
      { timestamp: "t2", type: "response_item", payload: { type: "custom_tool_call", name: "js_repl", call_id: "cmd_1", input: 'await page.goto("https://example.com");' } },
      { timestamp: "t3", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "cmd_1", output: { type: "text", text: "ok" } } },
      { timestamp: "t4", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] } },
    ]);

    const thread = makeThread([
      makeTurn([
        {
          type: "commandExecution",
          id: "cmd_1",
          command: "js_repl",
          cwd: "/workspace",
          processId: null,
          status: "completed",
          commandActions: [],
          aggregatedOutput: "ok",
          exitCode: 0,
          durationMs: 10,
        },
        { type: "agentMessage", id: "item_2", text: "Done", phase: "final_answer" },
      ], "turn_1"),
    ]);
    thread.path = rolloutPath;

    const result = enrichThreadWithReasoning(thread);
    const tool = result.turns[0]!.items[0] as v2.ThreadItem & {
      sourceInput?: string;
      sourceToolName?: string;
    };

    assert.equal(result.turns[0]!.items.length, 2);
    assert.equal(tool.type, "commandExecution");
    assert.equal(tool.sourceToolName, "js_repl");
    assert.equal(tool.sourceInput, 'await page.goto("https://example.com");');
  });

  test("should_attach_custom_tool_input_even_when_thread_already_contains_native_reasoning", () => {
    const rolloutPath = writeRollout([
      { timestamp: "t0", type: "turn_context", payload: { turn_id: "turn_1", cwd: "/tmp", approval_policy: "on-failure", sandbox_policy: "none", model: "gpt-4", summary: "auto" } },
      { timestamp: "t1", type: "response_item", payload: { type: "custom_tool_call", name: "js_repl", call_id: "cmd_1", input: 'await page.locator("button").click();' } },
      { timestamp: "t2", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "cmd_1", output: { type: "text", text: "clicked" } } },
      { timestamp: "t3", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] } },
    ]);

    const thread = makeThread([
      makeTurn([
        {
          type: "reasoning",
          id: "native_reasoning_1",
          summary: ["thinking"],
          content: ["clicking the button"],
        },
        {
          type: "commandExecution",
          id: "cmd_1",
          command: "js_repl",
          cwd: "/workspace",
          processId: null,
          status: "completed",
          commandActions: [],
          aggregatedOutput: "clicked",
          exitCode: 0,
          durationMs: 10,
        },
        { type: "agentMessage", id: "item_2", text: "Done", phase: "final_answer" },
      ], "turn_1"),
    ]);
    thread.path = rolloutPath;

    const result = enrichThreadWithReasoning(thread);
    const tool = result.turns[0]!.items[1] as v2.ThreadItem & {
      sourceInput?: string;
      sourceToolName?: string;
    };

    assert.equal(result.turns[0]!.items[0]!.type, "reasoning");
    assert.equal(tool.type, "commandExecution");
    assert.equal(tool.sourceToolName, "js_repl");
    assert.equal(tool.sourceInput, 'await page.locator("button").click();');
  });

  test("should_inject_reasoning_before_corresponding_agent_message", () => {
    const rolloutPath = writeRollout([
      { timestamp: "t0", type: "turn_context", payload: { turn_id: "turn_1", cwd: "/tmp", approval_policy: "on-failure", sandbox_policy: "none", model: "gpt-4", summary: "auto" } },
      { timestamp: "t1", type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "Thinking about it" }], content: [{ type: "reasoning_text", text: "deep thoughts" }], encrypted_content: null } },
      { timestamp: "t2", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello" }] } },
    ]);

    const thread = makeThread([
      makeTurn([
        { type: "agentMessage", id: "item_1", text: "Hello", phase: "final_answer" },
      ], "turn_1"),
    ]);
    thread.path = rolloutPath;

    const result = enrichThreadWithReasoning(thread);
    assert.equal(result.turns[0]!.items.length, 2);

    const reasoning = result.turns[0]!.items[0]!;
    assert.equal(reasoning.type, "reasoning");
    if (reasoning.type === "reasoning") {
      assert.deepEqual(reasoning.summary, ["Thinking about it"]);
      assert.deepEqual(reasoning.content, ["deep thoughts"]);
    }
    assert.equal(result.turns[0]!.items[1]!.type, "agentMessage");
  });

  test("should_not_duplicate_reasoning_when_thread_already_contains_native_reasoning", () => {
    const rolloutPath = writeRollout([
      { timestamp: "t0", type: "turn_context", payload: { turn_id: "turn_1", cwd: "/tmp", approval_policy: "on-failure", sandbox_policy: "none", model: "gpt-4", summary: "auto" } },
      { timestamp: "t1", type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "Thinking about it" }], content: [{ type: "reasoning_text", text: "deep thoughts" }], encrypted_content: null } },
      { timestamp: "t2", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello" }] } },
    ]);

    const thread = makeThread([
      makeTurn([
        {
          type: "reasoning",
          id: "native_reasoning_1",
          summary: ["Thinking about it"],
          content: ["deep thoughts"],
        },
        { type: "agentMessage", id: "item_1", text: "Hello", phase: "final_answer" },
      ], "turn_1"),
    ]);
    thread.path = rolloutPath;

    const result = enrichThreadWithReasoning(thread);
    assert.deepEqual(result.turns[0]!.items, thread.turns[0]!.items);
  });

  test("should_append_trailing_reasoning_after_last_agent_message", () => {
    const rolloutPath = writeRollout([
      { timestamp: "t0", type: "turn_context", payload: { turn_id: "turn_1", cwd: "/tmp", approval_policy: "on-failure", sandbox_policy: "none", model: "gpt-4", summary: "auto" } },
      { timestamp: "t1", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello" }] } },
      { timestamp: "t2", type: "response_item", payload: { type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: "afterthought" }], encrypted_content: null } },
    ]);

    const thread = makeThread([
      makeTurn([
        { type: "agentMessage", id: "item_1", text: "Hello", phase: "final_answer" },
      ], "turn_1"),
    ]);
    thread.path = rolloutPath;

    const result = enrichThreadWithReasoning(thread);
    assert.equal(result.turns[0]!.items.length, 2);
    assert.equal(result.turns[0]!.items[0]!.type, "agentMessage");
    assert.equal(result.turns[0]!.items[1]!.type, "reasoning");
  });

  test("should_handle_multi_turn_with_reasoning_in_each", () => {
    const rolloutPath = writeRollout([
      { timestamp: "t0", type: "turn_context", payload: { turn_id: "turn_1", cwd: "/tmp", approval_policy: "on-failure", sandbox_policy: "none", model: "gpt-4", summary: "auto" } },
      { timestamp: "t0b", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Q1" }] } },
      { timestamp: "t1", type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "Think 1" }], content: [{ type: "reasoning_text", text: "thought 1" }], encrypted_content: null } },
      { timestamp: "t2", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Reply 1" }] } },
      { timestamp: "t3", type: "turn_context", payload: { turn_id: "turn_2", cwd: "/tmp", approval_policy: "on-failure", sandbox_policy: "none", model: "gpt-4", summary: "auto" } },
      { timestamp: "t3b", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Q2" }] } },
      { timestamp: "t4", type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "Think 2" }], content: [{ type: "reasoning_text", text: "thought 2" }], encrypted_content: null } },
      { timestamp: "t5", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Reply 2" }] } },
    ]);

    const thread = makeThread([
      makeTurn([
        { type: "userMessage", id: "u1", content: [{ type: "text", text: "Q1", text_elements: [] }] },
        { type: "agentMessage", id: "a1", text: "Reply 1", phase: "final_answer" },
      ], "turn_1"),
      makeTurn([
        { type: "userMessage", id: "u2", content: [{ type: "text", text: "Q2", text_elements: [] }] },
        { type: "agentMessage", id: "a2", text: "Reply 2", phase: "final_answer" },
      ], "turn_2"),
    ]);
    thread.path = rolloutPath;

    const result = enrichThreadWithReasoning(thread);
    assert.equal(result.turns[0]!.items.length, 3);
    assert.equal(result.turns[0]!.items[1]!.type, "reasoning");
    assert.equal(result.turns[1]!.items.length, 3);
    assert.equal(result.turns[1]!.items[1]!.type, "reasoning");
  });

  test("should_only_enrich_turns_that_still_lack_reasoning", () => {
    const rolloutPath = writeRollout([
      { timestamp: "t0", type: "turn_context", payload: { turn_id: "turn_1", cwd: "/tmp", approval_policy: "on-failure", sandbox_policy: "none", model: "gpt-4", summary: "auto" } },
      { timestamp: "t1", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Q1" }] } },
      { timestamp: "t2", type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "Native" }], content: [{ type: "reasoning_text", text: "already there" }], encrypted_content: null } },
      { timestamp: "t3", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Reply 1" }] } },
      { timestamp: "t4", type: "turn_context", payload: { turn_id: "turn_2", cwd: "/tmp", approval_policy: "on-failure", sandbox_policy: "none", model: "gpt-4", summary: "auto" } },
      { timestamp: "t5", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Q2" }] } },
      { timestamp: "t6", type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "Injected" }], content: [{ type: "reasoning_text", text: "missing from thread" }], encrypted_content: null } },
      { timestamp: "t7", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Reply 2" }] } },
    ]);

    const thread = makeThread([
      makeTurn([
        { type: "userMessage", id: "u1", content: [{ type: "text", text: "Q1", text_elements: [] }] },
        { type: "reasoning", id: "native_reasoning_1", summary: ["Native"], content: ["already there"] },
        { type: "agentMessage", id: "a1", text: "Reply 1", phase: "final_answer" },
      ], "turn_1"),
      makeTurn([
        { type: "userMessage", id: "u2", content: [{ type: "text", text: "Q2", text_elements: [] }] },
        { type: "agentMessage", id: "a2", text: "Reply 2", phase: "final_answer" },
      ], "turn_2"),
    ]);
    thread.path = rolloutPath;

    const result = enrichThreadWithReasoning(thread);
    assert.deepEqual(result.turns[0]!.items, thread.turns[0]!.items);
    assert.equal(result.turns[1]!.items.length, 3);
    assert.equal(result.turns[1]!.items[1]!.type, "reasoning");
    if (result.turns[1]!.items[1]!.type === "reasoning") {
      assert.deepEqual(result.turns[1]!.items[1]!.summary, ["Injected"]);
    }
  });

  test("should_interleave_reasoning_with_tool_calls_in_correct_order", () => {
    const rolloutPath = writeRollout([
      { timestamp: "t0", type: "turn_context", payload: { turn_id: "turn_1", cwd: "/tmp", approval_policy: "on-failure", sandbox_policy: "none", model: "gpt-4", summary: "auto" } },
      { timestamp: "t1", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Do it" }] } },
      { timestamp: "t2", type: "response_item", payload: { type: "function_call", name: "write_file", arguments: "{}", call_id: "call_1" } },
      { timestamp: "t3", type: "response_item", payload: { type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: "Now I need to read it back" }], encrypted_content: null } },
      { timestamp: "t4", type: "response_item", payload: { type: "function_call_output", call_id: "call_1", output: { type: "text", text: "ok" } } },
      { timestamp: "t5", type: "response_item", payload: { type: "function_call", name: "read_file", arguments: "{}", call_id: "call_2" } },
      { timestamp: "t6", type: "response_item", payload: { type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: "Let me continue" }], encrypted_content: null } },
      { timestamp: "t7", type: "response_item", payload: { type: "function_call_output", call_id: "call_2", output: { type: "text", text: "content" } } },
      { timestamp: "t8", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] } },
    ]);

    const thread = makeThread([
      makeTurn([
        { type: "userMessage", id: "u1", content: [{ type: "text", text: "Do it", text_elements: [] }] },
        {
          type: "mcpToolCall", id: "tc1", server: "fs", tool: "write_file",
          status: "completed", arguments: {}, result: null, error: null, durationMs: 10,
        },
        {
          type: "mcpToolCall", id: "tc2", server: "fs", tool: "read_file",
          status: "completed", arguments: {}, result: null, error: null, durationMs: 10,
        },
        { type: "agentMessage", id: "a1", text: "Done", phase: "final_answer" },
      ], "turn_1"),
    ]);
    thread.path = rolloutPath;

    const result = enrichThreadWithReasoning(thread);
    const items = result.turns[0]!.items;
    assert.equal(items.length, 6);
    assert.equal(items[0]!.type, "userMessage");
    assert.equal(items[1]!.type, "mcpToolCall");
    assert.equal(items[2]!.type, "reasoning");
    assert.equal(items[3]!.type, "mcpToolCall");
    assert.equal(items[4]!.type, "reasoning");
    assert.equal(items[5]!.type, "agentMessage");
  });

  test("should_skip_reasoning_with_whitespace_only_content", () => {
    const rolloutPath = writeRollout([
      { timestamp: "t0", type: "turn_context", payload: { turn_id: "turn_1", cwd: "/tmp", approval_policy: "on-failure", sandbox_policy: "none", model: "gpt-4", summary: "auto" } },
      { timestamp: "t1", type: "response_item", payload: { type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: "\n\n" }], encrypted_content: null } },
      { timestamp: "t2", type: "response_item", payload: { type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: "real thought" }], encrypted_content: null } },
      { timestamp: "t3", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Reply" }] } },
    ]);

    const thread = makeThread([
      makeTurn([
        { type: "agentMessage", id: "item_1", text: "Reply", phase: "final_answer" },
      ], "turn_1"),
    ]);
    thread.path = rolloutPath;

    const result = enrichThreadWithReasoning(thread);
    assert.equal(result.turns[0]!.items.length, 2);
    const reasoning = result.turns[0]!.items[0]!;
    assert.equal(reasoning.type, "reasoning");
    if (reasoning.type === "reasoning") {
      assert.deepEqual(reasoning.content, ["real thought"]);
    }
  });
});
