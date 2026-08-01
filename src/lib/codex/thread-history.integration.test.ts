import { afterAll, beforeAll, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

import {
  CodexAppServerClient,
  StdioJsonRpcTransport,
} from "@/lib/codex/app-server-client";
import { type AppServerNotification, SERVER_METHOD } from "@/lib/codex/protocol";
import { THREAD_LIST_DEFAULTS } from "@/lib/codex/service";
import { isThreadReadResponse } from "@/lib/codex/thread-history-guards";
import { mapThreadToChatMessages } from "@/lib/codex/thread-history-mapper";
import { textContent } from "@/hooks/use-chat";
import { pollUntil } from "@/lib/codex/test-utils";
import {
  interpreterAppServerTestBinaryAvailable,
  spawnInterpreterAppServerForTest,
} from "@/lib/codex/test-fixtures/interpreter-app-server-test-binary";

const TEST_CODEX_HOME = "/tmp/test-thread-history-codex-home";
const TEST_MESSAGE = "integration test user message";
const THREAD_LIST_POLL_TIMEOUT_MS = 60_000;

const appServerAvailable = interpreterAppServerTestBinaryAvailable;
// NOTE(victor): bun test has a child_process spawning issue when running a
// single integration test file -- the app-server process exits with code 0 in ~50ms
// before responding. Running via `pnpm run test:unit` (multi-file invocation)
// works reliably. Use `pnpm run test:unit` to run these tests.
const describeIf = appServerAvailable ? describe : describe.skip;

describeIf("Thread history persistence (integration)", () => {
  let transport: StdioJsonRpcTransport;
  let client: CodexAppServerClient;
  let threadId: string;

  async function waitForThreadInList(params: Parameters<typeof client.threadList>[0]) {
    return pollUntil(
      () => client.threadList(params),
      (result) => result.data.some((t) => t.id === threadId),
      { timeoutMs: THREAD_LIST_POLL_TIMEOUT_MS },
    );
  }

  beforeAll(async () => {
    rmSync(TEST_CODEX_HOME, { recursive: true, force: true });

    transport = new StdioJsonRpcTransport(
      (_command, args, env) => spawnInterpreterAppServerForTest(args, env),
      TEST_CODEX_HOME,
    );
    client = new CodexAppServerClient(transport, null);
    await client.ensureConnected();

    threadId = await client.startThread("gpt-5.3-codex");
    assert.ok(threadId, "thread should be created");

    const turn = await client.startTurn({ threadId, message: TEST_MESSAGE });
    assert.ok(turn.id, "turn should have an id");

    // NOTE(victor): Turn will fail (no API key) but the userMessage item is
    // persisted before the LLM call, making the thread visible in thread/list.
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => resolve(), 15_000);
      client.subscribe((n: AppServerNotification) => {
        if (
          n.method === SERVER_METHOD.turnCompleted &&
          "turn" in n.params &&
          n.params.turn.id === turn.id
        ) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
  }, 70_000);

  afterAll(async () => {
    await transport.stop();
    rmSync(TEST_CODEX_HOME, { recursive: true, force: true });
  });

  test("should_list_thread_with_vscode_and_appServer_source_kinds", async () => {
    const result = await waitForThreadInList({
      sourceKinds: THREAD_LIST_DEFAULTS.sourceKinds,
    });
    assert.ok(
      result.data.some((t) => t.id === threadId),
      `thread ${threadId} should appear with sourceKinds ${JSON.stringify(THREAD_LIST_DEFAULTS.sourceKinds)}`,
    );
  }, 70_000);

  test("should_list_thread_with_empty_modelProviders", async () => {
    const result = await waitForThreadInList({
      modelProviders: THREAD_LIST_DEFAULTS.modelProviders,
    });
    assert.ok(
      result.data.some((t) => t.id === threadId),
      `thread ${threadId} should appear with modelProviders []`,
    );
  }, 70_000);

  test("should_list_thread_with_combined_correct_filters", async () => {
    const result = await waitForThreadInList(THREAD_LIST_DEFAULTS);
    assert.ok(
      result.data.some((t) => t.id === threadId),
      `thread ${threadId} should appear with THREAD_LIST_DEFAULTS`,
    );
  }, 70_000);

  test("REGRESSION_should_not_list_thread_with_only_appServer_source", async () => {
    const result = await client.threadList({
      sourceKinds: ["appServer"],
      modelProviders: [],
    });
    assert.ok(
      !result.data.some((t) => t.id === threadId),
      "thread should NOT appear when sourceKinds is only ['appServer'] (codex hardcodes vscode)",
    );
  }, 30_000);

  test("REGRESSION_should_not_list_thread_with_wrong_modelProvider", async () => {
    const result = await client.threadList({
      sourceKinds: ["vscode", "appServer"],
      modelProviders: ["nonexistent_provider"],
    });
    assert.ok(
      !result.data.some((t) => t.id === threadId),
      "thread should NOT appear when filtering for a non-matching provider",
    );
  }, 30_000);

  test("should_read_thread_with_user_message_in_turns", async () => {
    const result = await client.threadRead({ threadId, includeTurns: true });
    assert.equal(result.thread.id, threadId);
    assert.ok(result.thread.turns.length >= 1, "should have at least one turn");

    const userItem = result.thread.turns[0]?.items.find(
      (i) => i.type === "userMessage",
    );
    assert.ok(userItem, "first turn should contain a userMessage item");
    assert.ok(
      userItem.type === "userMessage" &&
        userItem.content.some(
          (c) => c.type === "text" && c.text.includes(TEST_MESSAGE),
        ),
      `userMessage should contain "${TEST_MESSAGE}"`,
    );
  }, 30_000);

  test("should_round_trip_thread_through_mapper_and_guards", async () => {
    const result = await client.threadRead({ threadId, includeTurns: true });

    assert.equal(isThreadReadResponse(result), true, "should pass type guard");

    const messages = mapThreadToChatMessages(result.thread);
    assert.ok(messages.length >= 1, "should produce at least one ChatMessage");

    const firstUser = messages.find((m) => m.role === "user");
    assert.ok(firstUser, "should have a user message");
    assert.ok(
      textContent(firstUser).includes(TEST_MESSAGE),
      `user message content should include "${TEST_MESSAGE}"`,
    );
  }, 30_000);
});
