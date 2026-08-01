// NOTE(victor): These error scenarios reproduce the failures reported in PR #371
// (https://github.com/openinterpreter/iworkstation/pull/371).
// A Windows user with LM Studio could not connect at all:
//   - Failure 1: LM Studio 401 (auth required, no token sent)
//   - Failure 2: Error notifications silently dropped by validator
//   - Failure 4: Stream disconnects before response.completed
//   - Failure 6: 5x retry loop with no user-visible error
// The auth and validator bugs are fixed. Stream disconnect and tool output
// format issues remain upstream (LM Studio / codex binary respectively).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { CodexTestHarness } from "./test-fixtures/codex-test-harness";
import type { ScriptedScenario } from "./test-fixtures/scripted-local-provider";
import { SERVER_METHOD } from "./protocol";

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const MODELS_RESPONSE = {
  object: "list",
  data: [{ id: "test-model", object: "model", created: 0, owned_by: "local" }],
};

const PRESET_ID = "ollama" as const;
const TEST_MODEL = "test-model";

const describeIfCodex = CodexTestHarness.appServerAvailable
  ? describe
  : describe.skip;

// ---------------------------------------------------------------------------
// 1. auth-required (LM Studio 401)
// ---------------------------------------------------------------------------

describeIfCodex("local-provider error: auth-required", () => {
  const harness = new CodexTestHarness("/tmp/test-error-auth");

  const scenario: ScriptedScenario = {
    name: "auth-required",
    modelsResponse: MODELS_RESPONSE,
    responseBehavior: { type: "auth-required" },
  };

  beforeAll(async () => {
    await harness.start(PRESET_ID, scenario);
  }, 30_000);

  afterAll(async () => {
    await harness.stop();
  });

  test(
    "turn fails with auth error after retries",
    async () => {
      const threadId = await harness.client.startThread(TEST_MODEL, harness.modelProvider);
      expect(threadId).toBeTruthy();

      const turn = await harness.client.startTurn({
        threadId,
        message: "Say hello",
        model: TEST_MODEL,
      });
      expect(turn.id).toBeTruthy();

      const completed = await harness.recorder.waitForTurnCompleted(
        turn.id,
        120_000,
      );
      expect(completed).toBeTruthy();

      // Turn should NOT have completed successfully.
      if ("turn" in completed.params) {
        expect(completed.params.turn.status).not.toBe("completed");
      }

      // Should have received at least one streamError notification about auth.
      const streamErrors = harness.recorder.getStreamErrors(turn.id);
      const allNotifications = harness.recorder.all();
      const errorNotifications = allNotifications.filter(
        (n) =>
          n.method === SERVER_METHOD.streamError &&
          "turnId" in n.params &&
          n.params.turnId === turn.id,
      );

      // At least one error notification should exist.
      expect(streamErrors.length + errorNotifications.length).toBeGreaterThan(0);
    },
    120_000,
  );
});

// ---------------------------------------------------------------------------
// 1b. auth-required with lmstudio preset (verifies default bearer token in error path)
// ---------------------------------------------------------------------------

describeIfCodex("local-provider error: auth-required (lmstudio preset)", () => {
  const harness = new CodexTestHarness("/tmp/test-error-auth-lmstudio");

  const scenario: ScriptedScenario = {
    name: "auth-required-lmstudio",
    modelsResponse: MODELS_RESPONSE,
    responseBehavior: { type: "auth-required" },
  };

  beforeAll(async () => {
    await harness.start("lmstudio", scenario);
  }, 30_000);

  afterAll(async () => {
    await harness.stop();
  });

  test(
    "lmstudio preset sends default bearer token even when server returns 401",
    async () => {
      const threadId = await harness.client.startThread(TEST_MODEL, harness.modelProvider);
      expect(threadId).toBeTruthy();

      const turn = await harness.client.startTurn({
        threadId,
        message: "Say hello",
        model: TEST_MODEL,
      });
      expect(turn.id).toBeTruthy();

      const completed = await harness.recorder.waitForTurnCompleted(
        turn.id,
        120_000,
      );
      expect(completed).toBeTruthy();

      if ("turn" in completed.params) {
        expect(completed.params.turn.status).not.toBe("completed");
      }

      // Verify lmstudio default auth token was sent in the request.
      const requests = harness.fakeServer.getCapturedRequests();
      const chatReq = requests.find((r) => r.path.includes("/chat/completions"));
      expect(chatReq).toBeTruthy();
      expect(chatReq!.headers.authorization).toBe("Bearer lm-studio");

      const responsesReq = requests.find((r) => r.path.includes("/responses"));
      expect(responsesReq).toBeUndefined();

      const streamErrors = harness.recorder.getStreamErrors(turn.id);
      const allNotifications = harness.recorder.all();
      const errorNotifications = allNotifications.filter(
        (n) =>
          n.method === SERVER_METHOD.streamError &&
          "turnId" in n.params &&
          n.params.turnId === turn.id,
      );

      expect(streamErrors.length + errorNotifications.length).toBeGreaterThan(0);
    },
    120_000,
  );
});

// ---------------------------------------------------------------------------
// 2. stream-disconnect
// ---------------------------------------------------------------------------

describeIfCodex("local-provider error: stream-disconnect", () => {
  const harness = new CodexTestHarness("/tmp/test-error-disconnect");

  const scenario: ScriptedScenario = {
    name: "stream-disconnect",
    modelsResponse: MODELS_RESPONSE,
    responseBehavior: { type: "stream-disconnect", afterDeltas: 2 },
  };

  beforeAll(async () => {
    await harness.start(PRESET_ID, scenario);
  }, 30_000);

  afterAll(async () => {
    await harness.stop();
  });

  test(
    "partial stream then disconnect results in error",
    async () => {
      const threadId = await harness.client.startThread(TEST_MODEL, harness.modelProvider);
      expect(threadId).toBeTruthy();

      const turn = await harness.client.startTurn({
        threadId,
        message: "Say hello",
        model: TEST_MODEL,
      });
      expect(turn.id).toBeTruthy();

      const completed = await harness.recorder.waitForTurnCompleted(
        turn.id,
        120_000,
      );
      expect(completed).toBeTruthy();

      // Turn should fail (not complete successfully).
      if ("turn" in completed.params) {
        expect(completed.params.turn.status).not.toBe("completed");
      }

      // Should see streamError notifications from the disconnect.
      const streamErrors = harness.recorder.getStreamErrors(turn.id);
      expect(streamErrors.length).toBeGreaterThan(0);
    },
    120_000,
  );
});

// ---------------------------------------------------------------------------
// 3. malformed-stream
// ---------------------------------------------------------------------------

describeIfCodex("local-provider error: malformed-stream", () => {
  const harness = new CodexTestHarness("/tmp/test-error-malformed");

  const scenario: ScriptedScenario = {
    name: "malformed-stream",
    modelsResponse: MODELS_RESPONSE,
    responseBehavior: { type: "malformed-stream" },
  };

  beforeAll(async () => {
    await harness.start(PRESET_ID, scenario);
  }, 30_000);

  afterAll(async () => {
    await harness.stop();
  });

  test(
    "invalid JSON in stream causes turn to fail gracefully",
    async () => {
      const threadId = await harness.client.startThread(TEST_MODEL, harness.modelProvider);
      expect(threadId).toBeTruthy();

      const turn = await harness.client.startTurn({
        threadId,
        message: "Say hello",
        model: TEST_MODEL,
      });
      expect(turn.id).toBeTruthy();

      const completed = await harness.recorder.waitForTurnCompleted(
        turn.id,
        120_000,
      );
      expect(completed).toBeTruthy();

      // Turn should fail.
      if ("turn" in completed.params) {
        expect(completed.params.turn.status).not.toBe("completed");
      }

      // Should see error notifications from the malformed data.
      const streamErrors = harness.recorder.getStreamErrors(turn.id);
      const allNotifications = harness.recorder.all();
      const errorNotifications = allNotifications.filter(
        (n) =>
          n.method === SERVER_METHOD.streamError &&
          "turnId" in n.params &&
          n.params.turnId === turn.id,
      );

      expect(streamErrors.length + errorNotifications.length).toBeGreaterThan(0);
    },
    120_000,
  );
});

// ---------------------------------------------------------------------------
// 4. error-404 (model not found)
// ---------------------------------------------------------------------------

describeIfCodex("local-provider error: error-404", () => {
  const harness = new CodexTestHarness("/tmp/test-error-404");

  const scenario: ScriptedScenario = {
    name: "error-404",
    modelsResponse: MODELS_RESPONSE,
    responseBehavior: {
      type: "error",
      httpStatus: 404,
      body: {
        error: {
          message: "Not Found",
          type: "invalid_request_error",
        },
      },
    },
  };

  beforeAll(async () => {
    await harness.start(PRESET_ID, scenario);
  }, 30_000);

  afterAll(async () => {
    await harness.stop();
  });

  test(
    "404 response causes turn to fail with not-found error",
    async () => {
      const threadId = await harness.client.startThread(TEST_MODEL, harness.modelProvider);
      expect(threadId).toBeTruthy();

      const turn = await harness.client.startTurn({
        threadId,
        message: "Say hello",
        model: TEST_MODEL,
      });
      expect(turn.id).toBeTruthy();

      const completed = await harness.recorder.waitForTurnCompleted(
        turn.id,
        120_000,
      );
      expect(completed).toBeTruthy();

      // Turn should fail.
      if ("turn" in completed.params) {
        expect(completed.params.turn.status).not.toBe("completed");
      }

      // Should have error notifications.
      const streamErrors = harness.recorder.getStreamErrors(turn.id);
      expect(streamErrors.length).toBeGreaterThan(0);
    },
    120_000,
  );
});

// ---------------------------------------------------------------------------
// 5. error-400 (context overflow)
// ---------------------------------------------------------------------------

describeIfCodex("local-provider error: error-400", () => {
  const harness = new CodexTestHarness("/tmp/test-error-400");

  const scenario: ScriptedScenario = {
    name: "error-400",
    modelsResponse: MODELS_RESPONSE,
    responseBehavior: {
      type: "error",
      httpStatus: 400,
      body: {
        error: {
          message: "context_length_exceeded",
          type: "invalid_request_error",
        },
      },
    },
  };

  beforeAll(async () => {
    await harness.start(PRESET_ID, scenario);
  }, 30_000);

  afterAll(async () => {
    await harness.stop();
  });

  test(
    "400 context overflow causes turn to fail",
    async () => {
      const threadId = await harness.client.startThread(TEST_MODEL, harness.modelProvider);
      expect(threadId).toBeTruthy();

      const turn = await harness.client.startTurn({
        threadId,
        message: "Say hello",
        model: TEST_MODEL,
      });
      expect(turn.id).toBeTruthy();

      const completed = await harness.recorder.waitForTurnCompleted(
        turn.id,
        120_000,
      );
      expect(completed).toBeTruthy();

      // Turn should fail.
      if ("turn" in completed.params) {
        expect(completed.params.turn.status).not.toBe("completed");
      }

      // Should have error notifications.
      const streamErrors = harness.recorder.getStreamErrors(turn.id);
      expect(streamErrors.length).toBeGreaterThan(0);
    },
    120_000,
  );
});
