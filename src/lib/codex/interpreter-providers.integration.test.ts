import { afterAll, beforeAll, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";

import {
  CodexAppServerClient,
  StdioJsonRpcTransport,
} from "@/lib/codex/app-server-client";
import {
  interpreterAppServerTestBinaryAvailable,
  spawnInterpreterAppServerForTest,
} from "@/lib/codex/test-fixtures/interpreter-app-server-test-binary";

const TEST_CODEX_HOME = "/tmp/test-interpreter-providers-codex-home";

// Drives the real app-server provider and harness ports that onboarding and
// settings now source from the runtime. Asserts the live payload contract
// offline with no credentials, through the same client path the app uses.
// Skips when the bundled binary is absent.
const describeIf = interpreterAppServerTestBinaryAvailable ? describe : describe.skip;

// Core providers that anchor the picker; the catalog grows but these stay.
const CORE_PROVIDER_IDS = ["openai", "anthropic", "openrouter", "deepseek", "groq"];

describeIf("Interpreter provider and harness listing", () => {
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

  test("lists the bundled provider catalog including the core providers", async () => {
    // includeUnconfigured so the assertion targets the full catalog: the default
    // (configured-only) list is nondeterministic when a current provider is set.
    const { data } = await client.interpreterProviderList({ includeUnconfigured: true });
    assert.ok(data.length > 0, "provider list should return the bundled catalog");
    for (const id of CORE_PROVIDER_IDS) {
      assert.ok(
        data.some((provider) => provider.id === id),
        `provider catalog should include core provider "${id}"`,
      );
    }
  });

  test("never leaks app-only provider ids into the runtime catalog", async () => {
    const { data } = await client.interpreterProviderList({ includeUnconfigured: true });
    const leaked = data.filter(
      (provider) => provider.id.startsWith("builtin:") || provider.id.startsWith("__app:"),
    );
    assert.equal(
      leaked.length,
      0,
      `app-only ids must never appear in the runtime catalog: ${leaked.map((p) => p.id).join(", ")}`,
    );
  });

  test("includeUnconfigured never returns fewer providers than the default view", async () => {
    const configured = await client.interpreterProviderList({});
    const all = await client.interpreterProviderList({ includeUnconfigured: true });
    assert.ok(
      all.data.length >= configured.data.length,
      `includeUnconfigured (${all.data.length}) must be >= default view (${configured.data.length})`,
    );
  });

  test("every provider carries the fields the picker renders", async () => {
    const { data } = await client.interpreterProviderList({ includeUnconfigured: true });
    for (const provider of data) {
      assert.ok(
        typeof provider.id === "string" && provider.id.length > 0,
        `provider id must be a non-empty string: ${JSON.stringify(provider)}`,
      );
      assert.equal(typeof provider.name, "string", `provider ${provider.id} must have a string name`);
      assert.equal(typeof provider.configured, "boolean", `provider ${provider.id} must have a boolean configured flag`);
      assert.equal(typeof provider.isCurrent, "boolean", `provider ${provider.id} must flag current state`);
      assert.equal(typeof provider.isDefault, "boolean", `provider ${provider.id} must flag default state`);
    }
  });

  test("lists compatible harnesses for a provider", async () => {
    const { data } = await client.interpreterHarnessList({ providerId: "anthropic" });
    assert.ok(data.length > 0, "anthropic should expose at least one harness choice");
    for (const harness of data) {
      assert.equal(typeof harness.label, "string", "each harness must have a label");
      assert.equal(typeof harness.isRecommended, "boolean", "each harness must flag whether it is recommended");
    }
    assert.ok(
      data.some((harness) => harness.id === "claude-code"),
      "the Claude Code harness should be available for anthropic",
    );
  });

  test("exposes the native harness for a provider with no third-party harness", async () => {
    // An omitted `id` denotes the native (Codex) harness; OpenAI exposes it.
    const { data } = await client.interpreterHarnessList({ providerId: "openai" });
    assert.ok(data.length > 0, "openai should expose at least the native harness");
    assert.ok(
      data.some((harness) => !harness.id),
      "openai should expose the native harness (id omitted)",
    );
  });

  test("marks exactly one recommended harness per provider", async () => {
    for (const providerId of ["anthropic", "groq", "openrouter"]) {
      const { data } = await client.interpreterHarnessList({ providerId });
      const recommended = data.filter((harness) => harness.isRecommended);
      assert.equal(
        recommended.length,
        1,
        `${providerId} should mark exactly one recommended harness, saw ${recommended.length}`,
      );
    }
  });

  test("writes global provider, model, and harness selection through the OIX contract", async () => {
    await client.interpreterProviderSet({ providerId: "anthropic" });
    await client.interpreterModelSet({
      model: "claude-sonnet-4-6",
      reasoningEffort: "high",
    });
    await client.interpreterHarnessSet({ harness: "claude-code" });

    const config = readFileSync(
      path.join(TEST_CODEX_HOME, "config.toml"),
      "utf8",
    );
    assert.match(config, /model_provider\s*=\s*"anthropic"/);
    assert.match(config, /model\s*=\s*"claude-sonnet-4-6"/);
    assert.match(config, /model_reasoning_effort\s*=\s*"high"/);
    assert.match(config, /harness\s*=\s*"claude-code"/);
  });
});
