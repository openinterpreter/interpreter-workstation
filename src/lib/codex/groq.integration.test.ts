import { afterAll, beforeAll, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

import {
  CodexAppServerClient,
  StdioJsonRpcTransport,
} from "@/lib/codex/app-server-client";
import {
  buildProfileFromPreset,
  getCustomPreset,
  providerConfigToJsonValue,
} from "@/lib/codex/profiles";
import { type AppServerNotification, SERVER_METHOD } from "@/lib/codex/protocol";
import { sanitizeGroqResponsesRequest } from "../../../server/utils/groqResponsesProxy";
import {
  interpreterAppServerTestBinaryAvailable,
  spawnInterpreterAppServerForTest,
} from "@/lib/codex/test-fixtures/interpreter-app-server-test-binary";

const GROQ_API_KEY = process.env.GROQ_API_KEY ?? "";
const GROQ_MODEL = process.env.GROQ_MODEL ?? "openai/gpt-oss-120b";
const TEST_CODEX_HOME = "/tmp/test-groq-codex-home";

let groqReachable = false;
let proxyBaseUrl = "";
if (GROQ_API_KEY) {
  try {
    const res = execSync(
      "curl -sf https://api.groq.com/openai/v1/models -H \"Authorization: Bearer $GROQ_API_KEY\"",
      {
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        ...process.env,
        GROQ_API_KEY,
      },
    },
    );
    const body = JSON.parse(res.toString()) as { data?: Array<{ id?: string }> };
    groqReachable = Array.isArray(body.data) && body.data.length > 0;
  } catch {}
}

const describeIf = groqReachable && interpreterAppServerTestBinaryAvailable ? describe : describe.skip;

function collectNotifications(client: CodexAppServerClient) {
  const notifications: AppServerNotification[] = [];
  client.subscribe((n) => notifications.push(n));
  return notifications;
}

describeIf("Groq integration", () => {
  let transport: StdioJsonRpcTransport;
  let client: CodexAppServerClient;
  let groqProxy: ReturnType<typeof createServer> | null = null;

  const proxyHandler = async (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? "GET";
    const targetPath = req.url ?? "/";
    const targetUrl = `https://api.groq.com/openai/v1${targetPath}`;

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const parsedBody = rawBody ? JSON.parse(rawBody) : undefined;
    const sanitizedBody =
      targetPath === "/responses"
        ? sanitizeGroqResponsesRequest(parsedBody)
        : parsedBody;

    const upstream = await fetch(targetUrl, {
      method,
      headers: {
        authorization: req.headers.authorization ?? "",
        "content-type": "application/json",
      },
      body:
        method === "GET" || method === "HEAD"
          ? undefined
          : JSON.stringify(sanitizedBody ?? {}),
    });

    res.statusCode = upstream.status;
    upstream.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (lower !== "content-length" && lower !== "content-encoding") {
        res.setHeader(key, value);
      }
    });
    if (!upstream.body) {
      res.end();
      return;
    }
    Readable.fromWeb(upstream.body as unknown as ReadableStream<Uint8Array>).pipe(res);
  };

  beforeAll(async () => {
    rmSync(TEST_CODEX_HOME, { recursive: true, force: true });

    groqProxy = createServer((req, res) => {
      void proxyHandler(req, res).catch((error) => {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      groqProxy!.once("error", reject);
      groqProxy!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = groqProxy.address() as AddressInfo;
    proxyBaseUrl = `http://127.0.0.1:${address.port}`;

    transport = new StdioJsonRpcTransport(
      (_command, args, env) =>
        spawnInterpreterAppServerForTest(args, env),
      TEST_CODEX_HOME,
    );
    client = new CodexAppServerClient(transport, null);
    await client.ensureConnected();

    const preset = getCustomPreset("groq");
    assert.ok(preset, "groq preset should exist");

    const profile = buildProfileFromPreset(preset, {
      baseUrl: proxyBaseUrl,
      apiKey: GROQ_API_KEY,
      model: GROQ_MODEL,
    });
    assert.ok(profile.modelProvider, "profile should have modelProvider");
    assert.ok(profile.providerConfig, "profile should have providerConfig");

    await client.configValueWrite(
      `model_providers.${profile.modelProvider}`,
      providerConfigToJsonValue(profile.providerConfig!),
    );

    await client.configValueWrite("web_search", "disabled");
  }, 30_000);

  afterAll(async () => {
    await transport.stop();
    groqProxy?.close();
    rmSync(TEST_CODEX_HOME, { recursive: true, force: true });
  });

  test("should_connect_and_get_a_response", async () => {
    const preset = getCustomPreset("groq");
    assert.ok(preset, "groq preset should exist");

    const profile = buildProfileFromPreset(preset, {
      baseUrl: proxyBaseUrl,
      apiKey: GROQ_API_KEY,
      model: GROQ_MODEL,
    });

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
    if ("turn" in completed.params) {
      assert.equal(
        completed.params.turn.status,
        "completed",
        JSON.stringify(completed.params.turn.error ?? null),
      );
    }

    const streamErrors = notifications.filter(
      (n) =>
        n.method === SERVER_METHOD.streamError &&
        "turnId" in n.params &&
        n.params.turnId === turn.id,
    );
    assert.equal(
      streamErrors.length,
      0,
      streamErrors.length > 0 ? JSON.stringify(streamErrors[0]?.params.error ?? null) : "",
    );

    const deltas = notifications.filter(
      (n) =>
        n.method === SERVER_METHOD.agentMessageDelta &&
        "turnId" in n.params &&
        n.params.turnId === turn.id,
    );
    assert.ok(deltas.length > 0, "should receive at least one agentMessageDelta");
  }, 120_000);
});
