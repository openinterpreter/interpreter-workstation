import { afterAll, beforeAll, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";

import {
  CodexAppServerClient,
  StdioJsonRpcTransport,
} from "@/lib/codex/app-server-client";
import { buildProfileFromPreset, getCustomPreset, providerConfigToJsonValue } from "@/lib/codex/profiles";
import { type AppServerNotification, SERVER_METHOD } from "@/lib/codex/protocol";
import {
  interpreterAppServerTestBinaryAvailable,
  spawnInterpreterAppServerForTest,
} from "@/lib/codex/test-fixtures/interpreter-app-server-test-binary";

const OLLAMA_BASE_URL = "http://localhost:11434";
const TEST_CODEX_HOME = "/tmp/test-ollama-codex-home";

let ollamaReachable = false;
try {
  const res = execSync(`curl -sf ${OLLAMA_BASE_URL}/v1/models`, {
    timeout: 3_000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const body = JSON.parse(res.toString()) as { data?: unknown[] };
  ollamaReachable = Array.isArray(body.data);
} catch {}

const describeIf = ollamaReachable && interpreterAppServerTestBinaryAvailable ? describe : describe.skip;

function collectNotifications(client: CodexAppServerClient) {
  const notifications: AppServerNotification[] = [];
  client.subscribe((n) => notifications.push(n));
  return notifications;
}

describeIf("Ollama integration", () => {
  let transport: StdioJsonRpcTransport;
  let client: CodexAppServerClient;

  beforeAll(async () => {
    rmSync(TEST_CODEX_HOME, { recursive: true, force: true });

    transport = new StdioJsonRpcTransport(
      (_command, args, env) => spawnInterpreterAppServerForTest(args, env),
      TEST_CODEX_HOME,
    );
    client = new CodexAppServerClient(transport, null);
    await client.ensureConnected();

    const preset = getCustomPreset("ollama")!;
    const profile = buildProfileFromPreset(preset);

    await client.configValueWrite(
      `model_providers.${profile.modelProvider}`,
      providerConfigToJsonValue(profile.providerConfig!),
    );
  }, 30_000);

  afterAll(async () => {
    await transport.stop();
    rmSync(TEST_CODEX_HOME, { recursive: true, force: true });
  });

  test("should_connect_and_get_a_response", async () => {
    const preset = getCustomPreset("ollama")!;
    const profile = buildProfileFromPreset(preset);

    const notifications = collectNotifications(client);

    const threadId = await client.startThread(
      profile.model!,
      profile.modelProvider,
    );
    assert.ok(threadId, "thread should be created");

    const turn = await client.startTurn({
      threadId,
      message: "Reply with exactly one word: hello",
      model: profile.model,
    });
    assert.ok(turn.id, "turn should have an id");

    const completed = await new Promise<AppServerNotification>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("timed out waiting for turnCompleted")),
        120_000,
      );

      client.subscribe((n) => {
        if (
          n.method === SERVER_METHOD.turnCompleted &&
          "turn" in n.params &&
          n.params.turn.id === turn.id
        ) {
          clearTimeout(timeout);
          resolve(n);
        }
      });
    });

    assert.ok(completed, "should receive turnCompleted");

    const deltas = notifications.filter(
      (n) =>
        n.method === SERVER_METHOD.agentMessageDelta &&
        "turnId" in n.params &&
        n.params.turnId === turn.id,
    );
    assert.ok(deltas.length > 0, "should receive at least one agentMessageDelta");

    const text = deltas
      .map((d) => {
        if ("delta" in d.params) {
          return d.params.delta;
        }
        return "";
      })
      .join("");
    assert.ok(text.length > 0, `response text should be non-empty, got: "${text}"`);
  }, 120_000);
});
