import { afterAll, beforeAll, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

import {
  CodexAppServerClient,
  StdioJsonRpcTransport,
} from "@/lib/codex/app-server-client";
import {
  interpreterAppServerTestBinaryAvailable,
  spawnInterpreterAppServerForTest,
} from "@/lib/codex/test-fixtures/interpreter-app-server-test-binary";

const TEST_CODEX_HOME = "/tmp/test-interpreter-models-codex-home";

// Guards the runtime capability the provider/model port depends on: the bundled
// runtime must list models offline for unconfigured providers (quick-add presets
// with no env key), return an empty list for ids it does not own, and report a deterministic
// catalog. Drives the real app-server binary through the same client path the app
// uses, offline with no credentials. Skips when the binary is absent.
const describeIf = interpreterAppServerTestBinaryAvailable ? describe : describe.skip;

describeIf("Interpreter model listing against the real app-server", () => {
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
  }, 30_000);

  afterAll(async () => {
    await transport.stop();
    rmSync(TEST_CODEX_HOME, { recursive: true, force: true });
  });

  test("lists bundled models for an unconfigured anthropic provider", async () => {
    const { data } = await client.interpreterModelList({ modelProvider: "anthropic" });
    assert.ok(data.length > 0, "anthropic should return its bundled catalog");
    assert.ok(
      data.some((model) => model.id.includes("claude")),
      "anthropic catalog should include a Claude model",
    );
  });

  test("lists bundled OpenRouter slug models for an unconfigured openrouter provider", async () => {
    const { data } = await client.interpreterModelList({ modelProvider: "openrouter" });
    assert.ok(data.length > 0, "openrouter should return its bundled catalog");
    assert.ok(
      data.some((model) => model.id.startsWith("anthropic/")),
      "openrouter catalog should include slug-style provider ids",
    );
  });

  test("returns no models for an unknown provider id", async () => {
    const { data } = await client.interpreterModelList({
      modelProvider: "not-a-real-provider",
    });
    assert.deepEqual(data, []);
  });

  test("returns no models for app-only provider ids that must never reach the runtime", async () => {
    // builtin:* and __app:* are app-persisted/synthetic ids. The provider menu
    // guards against passing them to the runtime; this proves the runtime itself
    // also refuses them, so a guard regression fails loudly instead of silently.
    assert.deepEqual(
      (await client.interpreterModelList({ modelProvider: "builtin:hosted" })).data,
      [],
    );
    assert.deepEqual(
      (await client.interpreterModelList({ modelProvider: "__app:hosted" })).data,
      [],
    );
  });

  test("lists the bundled deepseek catalog for the no-key onboarding path", async () => {
    // This is the no-key branch of useDeepSeekModelOptions: with no API key the
    // hook lists deepseek models straight from the bundled runtime catalog.
    const { data } = await client.interpreterModelList({ modelProvider: "deepseek" });
    assert.ok(data.length > 0, "deepseek should return its bundled catalog with no key");
    assert.ok(
      data.some((model) => model.id.includes("deepseek")),
      "deepseek catalog should include a deepseek-prefixed model",
    );
  });

  test("lists models from OIX's unified OpenAI provider", async () => {
    const { data } = await client.interpreterModelList({ modelProvider: "openai" });
    assert.ok(data.length > 0, "openai should return its bundled catalog");
  });

  test("lists the bundled groq catalog for an unconfigured groq provider", async () => {
    const { data } = await client.interpreterModelList({ modelProvider: "groq" });
    assert.ok(data.length > 0, "groq should return its bundled catalog");
  });

  test("includeHidden never returns fewer models than the default view", async () => {
    const visible = await client.interpreterModelList({ modelProvider: "anthropic", includeHidden: false });
    const all = await client.interpreterModelList({ modelProvider: "anthropic", includeHidden: true });
    assert.ok(
      all.data.length >= visible.data.length,
      `includeHidden=true (${all.data.length}) must be >= default view (${visible.data.length})`,
    );
  });

  test("every model carries a non-empty id, a display name, and a hidden flag", async () => {
    const { data } = await client.interpreterModelList({ modelProvider: "anthropic" });
    for (const model of data) {
      assert.ok(
        typeof model.id === "string" && model.id.length > 0,
        `model id must be a non-empty string: ${JSON.stringify(model)}`,
      );
      assert.equal(typeof model.displayName, "string", `model ${model.id} must have a string displayName`);
      assert.equal(typeof model.hidden, "boolean", `model ${model.id} must have a boolean hidden flag`);
    }
  });

  test("marks exactly one default model per provider", async () => {
    for (const provider of ["anthropic", "deepseek", "groq", "openai", "openrouter"]) {
      const { data } = await client.interpreterModelList({ modelProvider: provider });
      const defaults = data.filter((model) => model.isDefault === true);
      assert.equal(
        defaults.length,
        1,
        `${provider} should mark exactly one default model, saw ${defaults.length}: ${defaults.map((m) => m.id).join(", ")}`,
      );
    }
  });

  test("returns a deterministic model list across repeated calls", async () => {
    const first = await client.interpreterModelList({ modelProvider: "anthropic" });
    const second = await client.interpreterModelList({ modelProvider: "anthropic" });
    assert.deepEqual(
      second.data.map((model) => model.id),
      first.data.map((model) => model.id),
      "repeated model listings should return the same ids in the same order",
    );
  });

  test("scopes the deepseek catalog to deepseek-prefixed models", async () => {
    const { data } = await client.interpreterModelList({ modelProvider: "deepseek" });
    for (const model of data) {
      assert.ok(
        model.id.startsWith("deepseek"),
        `deepseek catalog should only contain deepseek models, saw "${model.id}"`,
      );
    }
  });

  test("does not normalize wrong-case or untrimmed provider ids", async () => {
    for (const id of ["Anthropic", "ANTHROPIC", " anthropic "]) {
      const { data } = await client.interpreterModelList({ modelProvider: id });
      assert.deepEqual(
        data,
        [],
        `provider id ${JSON.stringify(id)} should not be normalized`,
      );
    }
  });

  test("lists models for the active provider when none is specified", async () => {
    const { data } = await client.interpreterModelList({});
    assert.ok(data.length > 0, "omitting modelProvider should list the active provider's models");
  });

  test("lists bundled local-provider catalogs offline without a running server", async () => {
    // ollama/lmstudio have no server reachable here; the runtime still serves a
    // bundled catalog so the picker is populated before the user points at a server.
    for (const provider of ["ollama", "lmstudio"]) {
      const { data } = await client.interpreterModelList({ modelProvider: provider });
      assert.ok(data.length > 0, `${provider} should return a bundled catalog offline`);
    }
  });
});
