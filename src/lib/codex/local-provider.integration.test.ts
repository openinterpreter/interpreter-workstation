import { afterAll, beforeAll, describe, test } from "bun:test";
import assert from "node:assert/strict";

import { CodexTestHarness } from "./test-fixtures/codex-test-harness";
import type { ScriptedScenario } from "./test-fixtures/scripted-local-provider";

const describeIf = CodexTestHarness.appServerAvailable
  ? describe
  : describe.skip;

const TEXT_SUCCESS_SCENARIO: ScriptedScenario = {
  name: "text-success",
  modelsResponse: {
    object: "list",
    data: [
      { id: "qwen3.5:4b", object: "model", created: 0, owned_by: "local" },
    ],
  },
  responseBehavior: {
    type: "text-success",
    deltas: ["Hello", ", ", "world", "!"],
    finalText: "Hello, world!",
  },
};

const CHAT_COMPLETIONS_SUCCESS_SCENARIO: ScriptedScenario = {
  name: "chat-completions-text-success",
  modelsResponse: {
    object: "list",
    data: [
      {
        id: "chat-compatible-model",
        object: "model",
        created: 0,
        owned_by: "local",
      },
    ],
  },
  responseBehavior: {
    type: "text-success",
    deltas: ["Hello", ", ", "chat", "!"],
    finalText: "Hello, chat!",
  },
};

describeIf("local provider integration - text turn", () => {
  describe("ollama preset", () => {
    let harness: CodexTestHarness;

    beforeAll(async () => {
      harness = new CodexTestHarness("/tmp/test-local-provider-ollama");
      await harness.start("ollama", TEXT_SUCCESS_SCENARIO);
    }, 30_000);

    afterAll(async () => {
      await harness.stop();
    });

    test("should_complete_text_turn_with_deltas", async () => {
      const threadId = await harness.client.startThread(
        "qwen3.5:4b",
        harness.modelProvider,
      );
      assert.ok(threadId, "thread should be created");

      const turn = await harness.client.startTurn({
        threadId,
        message: "Say hello",
        model: "qwen3.5:4b",
      });
      assert.ok(turn.id, "turn should have an id");

      const completed = await harness.recorder.waitForTurnCompleted(
        turn.id,
        30_000,
      );
      assert.ok(completed, "should receive turnCompleted");

      if ("turn" in completed.params) {
        assert.equal(
          completed.params.turn.status,
          "completed",
          JSON.stringify(completed.params.turn.error ?? null),
        );
      }

      const streamErrors = harness.recorder.getStreamErrors(turn.id);
      assert.equal(
        streamErrors.length,
        0,
        streamErrors.length > 0 ? JSON.stringify(streamErrors[0]?.params) : "",
      );

      const deltas = harness.recorder.getAgentMessageDeltas(turn.id);
      assert.ok(
        deltas.length > 0,
        "should receive at least one agentMessageDelta",
      );
    }, 60_000);

    test("should_route_through_chat_completions", () => {
      const requests = harness.fakeServer.getCapturedRequests();
      const chatReq = requests.find((r) => r.path.includes("/chat/completions"));
      assert.ok(chatReq, "should have captured a /chat/completions request");
      assert.equal(chatReq.method, "POST");

      const body = chatReq.body as Record<string, unknown>;
      assert.equal(body.model, "qwen3.5:4b");
      assert.equal(body.stream, true);
      assert.ok(
        Array.isArray(body.messages),
        "chat completions request should include messages",
      );
      assert.equal(
        "input" in body,
        false,
        "chat completions request should not use Responses input",
      );

      const responsesReq = requests.find((r) => r.path.includes("/responses"));
      assert.equal(
        responsesReq,
        undefined,
        "ollama preset should not call /responses",
      );
    });
  });

  describe("lmstudio preset", () => {
    let harness: CodexTestHarness;

    beforeAll(async () => {
      harness = new CodexTestHarness("/tmp/test-local-provider-lmstudio");
      await harness.start("lmstudio", TEXT_SUCCESS_SCENARIO);
    }, 30_000);

    afterAll(async () => {
      await harness.stop();
    });

    test("should_complete_text_turn_with_lmstudio_preset", async () => {
      const threadId = await harness.client.startThread(
        "qwen3.5:4b",
        harness.modelProvider,
      );
      assert.ok(threadId, "thread should be created");

      const turn = await harness.client.startTurn({
        threadId,
        message: "Say hello",
        model: "qwen3.5:4b",
      });
      assert.ok(turn.id, "turn should have an id");

      const completed = await harness.recorder.waitForTurnCompleted(
        turn.id,
        30_000,
      );
      assert.ok(completed, "should receive turnCompleted");

      if ("turn" in completed.params) {
        assert.equal(
          completed.params.turn.status,
          "completed",
          JSON.stringify(completed.params.turn.error ?? null),
        );
      }
    }, 60_000);

    test("should_send_lmstudio_default_auth_token", () => {
      const requests = harness.fakeServer.getCapturedRequests();
      const chatReq = requests.find((r) => r.path.includes("/chat/completions"));
      assert.ok(chatReq, "should have captured a /chat/completions request");
      assert.equal(chatReq.method, "POST");
      assert.equal(chatReq.headers.authorization, "Bearer lm-studio");

      const body = chatReq.body as Record<string, unknown>;
      assert.equal(body.model, "qwen3.5:4b");
      assert.equal(body.stream, true);
      assert.ok(
        Array.isArray(body.messages),
        "lmstudio preset should send Chat Completions messages",
      );
      assert.equal(
        "input" in body,
        false,
        "lmstudio preset should not send Responses input",
      );

      const responsesReq = requests.find((r) => r.path.includes("/responses"));
      assert.equal(responsesReq, undefined, "LM Studio should not call /responses");
    });
  });

  describe("custom Chat Completions wire API", () => {
    let harness: CodexTestHarness;

    beforeAll(async () => {
      harness = new CodexTestHarness("/tmp/test-chat-completions-provider");
      await harness.start("custom", CHAT_COMPLETIONS_SUCCESS_SCENARIO, {
        wireApi: "chat",
      });
    }, 30_000);

    afterAll(async () => {
      await harness.stop();
    });

    test("should_complete_text_turn_through_chat_completions", async () => {
      const threadId = await harness.client.startThread(
        "chat-compatible-model",
        harness.modelProvider,
      );
      assert.ok(threadId, "thread should be created");

      const turn = await harness.client.startTurn({
        threadId,
        message: "Say hello",
        model: "chat-compatible-model",
      });
      assert.ok(turn.id, "turn should have an id");

      const completed = await harness.recorder.waitForTurnCompleted(
        turn.id,
        30_000,
      );
      assert.ok(completed, "should receive turnCompleted");

      if ("turn" in completed.params) {
        assert.equal(
          completed.params.turn.status,
          "completed",
          JSON.stringify(completed.params.turn.error ?? null),
        );
      }

      const streamErrors = harness.recorder.getStreamErrors(turn.id);
      assert.equal(
        streamErrors.length,
        0,
        streamErrors.length > 0 ? JSON.stringify(streamErrors[0]?.params) : "",
      );

      const chatReq = harness.fakeServer
        .getCapturedRequests()
        .find((request) => request.path.includes("/chat/completions"));
      assert.ok(chatReq, "should have captured a /chat/completions request");
      assert.equal(chatReq.method, "POST");

      const body = chatReq.body as Record<string, unknown>;
      assert.equal(body.model, "chat-compatible-model");
      assert.equal(body.stream, true);
      assert.ok(
        Array.isArray(body.messages),
        "chat completions request should include messages",
      );
      assert.equal(
        "input" in body,
        false,
        "chat completions request should not use Responses input",
      );

      const responsesReq = harness.fakeServer
        .getCapturedRequests()
        .find((request) => request.path.includes("/responses"));
      assert.equal(
        responsesReq,
        undefined,
        "chat wire API should not call /responses",
      );
    }, 60_000);
  });
});

// Ollama defaults to Chat Completions, but Responses must keep working as an
// opt-in override. These cases run the SAME text turn over each wire API and
// assert it completes and routes to the matching endpoint (and only that one).
const OLLAMA_WIRE_API_CASES = [
  {
    wireApi: "chat" as const,
    label: "chat completions",
    endpointFragment: "/chat/completions",
    otherFragment: "/responses",
    presentField: "messages",
    absentField: "input",
  },
  {
    wireApi: "responses" as const,
    label: "responses",
    endpointFragment: "/responses",
    otherFragment: "/chat/completions",
    presentField: "input",
    absentField: "messages",
  },
];

describeIf("local provider integration - ollama wire API parity", () => {
  for (const wireCase of OLLAMA_WIRE_API_CASES) {
    describe(`${wireCase.label} wire api`, () => {
      let harness: CodexTestHarness;

      beforeAll(async () => {
        harness = new CodexTestHarness(
          `/tmp/test-ollama-parity-${wireCase.wireApi}`,
        );
        await harness.start("ollama", TEXT_SUCCESS_SCENARIO, {
          wireApi: wireCase.wireApi,
        });
      }, 30_000);

      afterAll(async () => {
        await harness.stop();
      });

      test(`should_complete_text_turn_over_${wireCase.wireApi}`, async () => {
        const threadId = await harness.client.startThread(
          "qwen3.5:4b",
          harness.modelProvider,
        );
        assert.ok(threadId, "thread should be created");

        const turn = await harness.client.startTurn({
          threadId,
          message: "Say hello",
          model: "qwen3.5:4b",
        });
        assert.ok(turn.id, "turn should have an id");

        const completed = await harness.recorder.waitForTurnCompleted(
          turn.id,
          30_000,
        );
        assert.ok(completed, "should receive turnCompleted");
        if ("turn" in completed.params) {
          assert.equal(
            completed.params.turn.status,
            "completed",
            JSON.stringify(completed.params.turn.error ?? null),
          );
        }

        const streamErrors = harness.recorder.getStreamErrors(turn.id);
        assert.equal(
          streamErrors.length,
          0,
          streamErrors.length > 0 ? JSON.stringify(streamErrors[0]?.params) : "",
        );

        assert.equal(
          harness.recorder.collectAssistantText(turn.id),
          "Hello, world!",
          "streamed deltas should reassemble into the final text",
        );
      }, 60_000);

      test(`should_route_${wireCase.wireApi}_only_to_its_endpoint`, () => {
        const requests = harness.fakeServer.getCapturedRequests();

        const hit = requests.find((r) =>
          r.path.includes(wireCase.endpointFragment),
        );
        assert.ok(hit, `should call ${wireCase.endpointFragment}`);
        assert.equal(hit.method, "POST");

        const other = requests.find((r) =>
          r.path.includes(wireCase.otherFragment),
        );
        assert.equal(
          other,
          undefined,
          `${wireCase.label} wire API should not call ${wireCase.otherFragment}`,
        );

        const body = hit.body as Record<string, unknown>;
        assert.equal(body.model, "qwen3.5:4b");
        assert.equal(
          wireCase.presentField in body,
          true,
          `${wireCase.label} request should include "${wireCase.presentField}"`,
        );
        assert.equal(
          wireCase.absentField in body,
          false,
          `${wireCase.label} request should not include "${wireCase.absentField}"`,
        );
      });
    });
  }
});

// Wire-format details that silently break when a provider moves from Responses
// to Chat Completions: tool serialization shape and conversation history carry.
describeIf("local provider integration - ollama chat completions wire format", () => {
  let harness: CodexTestHarness;

  beforeAll(async () => {
    harness = new CodexTestHarness("/tmp/test-ollama-chat-format");
    await harness.start("ollama", TEXT_SUCCESS_SCENARIO);
  }, 30_000);

  afterAll(async () => {
    await harness.stop();
  });

  test("should_advertise_native_tools_in_chat_completions_function_shape", async () => {
    const threadId = await harness.client.startThread(
      "qwen3.5:4b",
      harness.modelProvider,
    );
    const turn = await harness.client.startTurn({
      threadId,
      message: "Say hello",
      model: "qwen3.5:4b",
    });
    await harness.recorder.waitForTurnCompleted(turn.id, 30_000);

    const chatReq = harness.fakeServer
      .getCapturedRequests()
      .find((r) => r.path.includes("/chat/completions"));
    assert.ok(chatReq, "should capture a /chat/completions request");

    const body = chatReq.body as Record<string, unknown>;
    const tools = body.tools as Array<Record<string, unknown>> | undefined;
    assert.ok(
      Array.isArray(tools) && tools.length > 0,
      "chat completions request should advertise native tools",
    );

    for (const tool of tools) {
      assert.equal(
        tool.type,
        "function",
        "chat completions tools must use the function type",
      );
      const fn = tool.function as { name?: unknown } | undefined;
      assert.ok(
        fn && typeof fn.name === "string" && fn.name.length > 0,
        "each tool must nest a function name (Chat Completions shape)",
      );
    }

    // Responses serializes tools flat (name at top level); Chat Completions must
    // not. This is the exact field that breaks on a wrong-wire-format switch.
    assert.equal(
      "name" in (tools[0] as object),
      false,
      "chat tools must not use the Responses flat tool shape",
    );
  }, 60_000);

  test("should_carry_prior_turn_history_into_the_next_chat_request", async () => {
    const threadId = await harness.client.startThread(
      "qwen3.5:4b",
      harness.modelProvider,
    );
    harness.fakeServer.clearCapturedRequests();

    const first = await harness.client.startTurn({
      threadId,
      message: "First message",
      model: "qwen3.5:4b",
    });
    await harness.recorder.waitForTurnCompleted(first.id, 30_000);

    const second = await harness.client.startTurn({
      threadId,
      message: "Second message",
      model: "qwen3.5:4b",
    });
    await harness.recorder.waitForTurnCompleted(second.id, 30_000);

    const chatReqs = harness.fakeServer
      .getCapturedRequests()
      .filter((r) => r.path.includes("/chat/completions"));
    assert.ok(chatReqs.length >= 2, "should capture both turns' chat requests");

    const firstMessages = (chatReqs[0]!.body as { messages: Array<{ role: string }> })
      .messages;
    const secondMessages = (chatReqs[chatReqs.length - 1]!.body as {
      messages: Array<{ role: string }>;
    }).messages;

    const userCount = (messages: Array<{ role: string }>) =>
      messages.filter((m) => m.role === "user").length;

    assert.ok(
      userCount(secondMessages) > userCount(firstMessages),
      "the second turn must carry an additional user message",
    );

    const firstJson = JSON.stringify(firstMessages);
    const secondJson = JSON.stringify(secondMessages);
    assert.equal(
      firstJson.includes("Second message"),
      false,
      "the first request must not contain the not-yet-sent second message",
    );
    assert.ok(
      secondJson.includes("First message"),
      "the second request must include the first turn's user message",
    );
    assert.ok(
      secondJson.includes("Hello, world!"),
      "the second request must include the first turn's assistant reply",
    );
  }, 90_000);
});
