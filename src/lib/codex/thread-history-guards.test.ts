import { describe, test } from "bun:test";
import assert from "node:assert/strict";

import { isThreadListResponse, isThreadReadResponse } from "./thread-history-guards";

function makeValidThread() {
  return {
    id: "thr_1",
    preview: "Hello",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 2,
    status: { type: "idle" },
    path: null,
    cwd: "/tmp",
    cliVersion: "1.0.0",
    source: "appServer",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [
      {
        id: "turn_1",
        status: "completed",
        error: null,
        items: [
          {
            type: "userMessage",
            id: "item_1",
            content: [{ type: "text", text: "Hi", text_elements: [] }],
          },
        ],
      },
    ],
  };
}

describe("thread history guards", () => {
  test("should_accept_valid_thread_read_response", () => {
    const payload = { thread: makeValidThread() };
    assert.equal(isThreadReadResponse(payload), true);
  });

  test("should_reject_invalid_thread_read_response", () => {
    const payload = { thread: { id: "thr_1", turns: [] } };
    assert.equal(isThreadReadResponse(payload), false);
  });

  test("should_accept_valid_thread_list_response", () => {
    const payload = {
      data: [makeValidThread()],
      nextCursor: null,
    };
    assert.equal(isThreadListResponse(payload), true);
  });

  test("should_reject_thread_list_with_bad_cursor", () => {
    const payload = {
      data: [makeValidThread()],
      nextCursor: 42,
    };
    assert.equal(isThreadListResponse(payload), false);
  });

  test("should_reject_thread_when_turn_item_type_is_unknown", () => {
    const invalidThread = makeValidThread();
    (invalidThread.turns[0]!.items as Array<unknown>).push({ type: "unknown", id: "x" });
    assert.equal(isThreadReadResponse({ thread: invalidThread }), false);
  });

  test("should_reject_thread_when_turn_status_is_invalid", () => {
    const invalidThread = makeValidThread();
    (invalidThread.turns[0] as { status: string }).status = "done";
    assert.equal(isThreadReadResponse({ thread: invalidThread }), false);
  });
});
