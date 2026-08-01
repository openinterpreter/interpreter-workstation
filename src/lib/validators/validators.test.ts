import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";

import type {
  CreateMcpServerBody,
  OAuthLoginBody,
  UpdateMcpServerBody,
} from "@/lib/codex/api-types";

import {
  isServerRequestShape,
  isValidJsonRpcResponse,
  isValidLifecycleNotification,
  isValidNotificationShape,
  validateBackgroundTerminalStopRequestBody,
  validateCreateMcpServerBody,
  validateOAuthLoginBody,
  validateStopRequestBody,
  validateStreamRequestBody,
  validateUpdateMcpServerBody,
} from "@/lib/validators";

describe("lifecycle validators", () => {
  const origWarn = console.warn;
  let warns: unknown[][] = [];

  function captureWarns() {
    warns = [];
    console.warn = (...args: unknown[]) => warns.push(args);
  }

  afterEach(() => {
    console.warn = origWarn;
    warns = [];
  });

  test("validates thread/started with valid params", () => {
    const params = {
      thread: {
        id: "thr_1",
        preview: "",
        ephemeral: false,
        modelProvider: "openai",
        createdAt: 0,
        updatedAt: 0,
        status: { type: "idle" },
        path: null,
        cwd: "/tmp",
        cliVersion: "0.0.0",
        source: "appServer",
        gitInfo: null,
        turns: [],
      },
    };
    assert.equal(isValidLifecycleNotification("thread/started", params), true);
  });

  test("rejects thread/started with missing required fields", () => {
    captureWarns();
    assert.equal(
      isValidLifecycleNotification("thread/started", { foo: "bar" }),
      false,
    );
    assert.ok(warns.length > 0);
  });

  test("validates item/completed with valid commandExecution item", () => {
    const params = {
      threadId: "thr_1",
      turnId: "turn_1",
      item: {
        type: "commandExecution",
        id: "cmd_1",
        command: "ls",
        cwd: "/tmp",
        processId: null,
        status: "completed",
        commandActions: [],
        aggregatedOutput: null,
        exitCode: 0,
        durationMs: null,
      },
    };
    assert.equal(isValidLifecycleNotification("item/completed", params), true);
  });

  test("validates turn/completed with valid params", () => {
    const params = {
      threadId: "thr_1",
      turn: {
        id: "turn_1",
        items: [],
        status: "completed",
        error: null,
      },
    };
    assert.equal(isValidLifecycleNotification("turn/completed", params), true);
  });

  test("validates turn/started with valid params", () => {
    const params = {
      threadId: "thr_1",
      turn: {
        id: "turn_1",
        items: [],
        status: "inProgress",
      },
    };
    assert.equal(isValidLifecycleNotification("turn/started", params), true);
  });

  test("returns true for non-lifecycle method (skips validation)", () => {
    assert.equal(
      isValidLifecycleNotification("item/agentMessage/delta", {
        anything: true,
      }),
      true,
    );
  });

  test("returns false and warns for invalid lifecycle params", () => {
    captureWarns();
    assert.equal(
      isValidLifecycleNotification("turn/completed", { invalid: true }),
      false,
    );
    assert.ok(warns.length > 0);
    assert.ok(String(warns[0]?.[0]).includes("turn/completed"));
  });

  test("validates error notification with actual codex ErrorNotification shape", () => {
    const params = {
      error: {
        message: "stream disconnected before completion",
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
        additionalDetails: null,
      },
      willRetry: true,
      threadId: "thr_1",
      turnId: "turn_1",
    };
    assert.equal(isValidLifecycleNotification("error", params), true);
  });

  test("validates error notification with willRetry false", () => {
    const params = {
      error: {
        message: "unauthorized",
        codexErrorInfo: "unauthorized",
        additionalDetails: "LM Studio auth required",
      },
      willRetry: false,
      threadId: "thr_1",
      turnId: "turn_1",
    };
    assert.equal(isValidLifecycleNotification("error", params), true);
  });

  test("rejects error notification with missing error object", () => {
    captureWarns();
    assert.equal(
      isValidLifecycleNotification("error", { willRetry: true, threadId: "thr_1", turnId: "turn_1" }),
      false,
    );
    assert.ok(warns.length > 0);
  });

  test("rejects error notification with missing threadId", () => {
    captureWarns();
    assert.equal(
      isValidLifecycleNotification("error", {
        error: { message: "fail", codexErrorInfo: null, additionalDetails: null },
        willRetry: true,
        turnId: "turn_1",
      }),
      false,
    );
    assert.ok(warns.length > 0);
  });
});

describe("HTTP validators", () => {
  test("validates StreamRequestBody with valid body", () => {
    assert.equal(
      validateStreamRequestBody({
        message: "hello",
        system: "overlay system prompt",
        threadId: "thr_1",
      }),
      true,
    );
  });
  test("rejects StopRequestBody with missing threadId", () => {
    const origWarn = console.warn;
    console.warn = () => {};
    assert.equal(validateStopRequestBody({ turnId: "turn_1" }), false);
    console.warn = origWarn;
  });

  test("validates BackgroundTerminalStopRequestBody with valid body", () => {
    assert.equal(
      validateBackgroundTerminalStopRequestBody({
        threadId: "thr_1",
      }),
      true,
    );
  });
});

describe("JSON-RPC response validator", () => {
  test("detects response with result", () => {
    assert.equal(isValidJsonRpcResponse({ id: 1, result: {} }), true);
  });

  test("detects response with error", () => {
    assert.equal(
      isValidJsonRpcResponse({ id: 1, error: { code: -1, message: "fail" } }),
      true,
    );
  });

  test("rejects notification shape (no id)", () => {
    assert.equal(isValidJsonRpcResponse({ method: "foo", params: {} }), false);
  });
});

describe("MCP validators", () => {
  const origWarn = console.warn;

  afterEach(() => {
    console.warn = origWarn;
  });

  test("validates CreateMcpServerBody with stdio config", () => {
    assert.equal(
      validateCreateMcpServerBody({
        name: "my-server",
        config: {
          transport: "stdio",
          command: "npx",
          args: ["-y", "server"],
          enabled: true,
        },
      }),
      true,
    );
  });

  test("validates CreateMcpServerBody with streamable_http config", () => {
    assert.equal(
      validateCreateMcpServerBody({
        name: "remote",
        config: {
          transport: "streamable_http",
          url: "https://mcp.example.com",
          oauthResource: "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
          bearerTokenEnvVar: "TOKEN",
        },
      }),
      true,
    );
  });

  test("rejects CreateMcpServerBody with missing name", () => {
    console.warn = () => {};
    assert.equal(
      validateCreateMcpServerBody({
        config: { transport: "stdio", command: "echo" },
      }),
      false,
    );
  });

  test("rejects CreateMcpServerBody with invalid transport", () => {
    console.warn = () => {};
    assert.equal(
      validateCreateMcpServerBody({
        name: "bad",
        config: { transport: "grpc", command: "echo" },
      }),
      false,
    );
  });

  test("validates UpdateMcpServerBody with stdio config", () => {
    assert.equal(
      validateUpdateMcpServerBody({
        transport: "stdio",
        command: "new-cmd",
        enabled: false,
      }),
      true,
    );
  });

  test("rejects UpdateMcpServerBody with missing transport", () => {
    console.warn = () => {};
    assert.equal(
      validateUpdateMcpServerBody({ command: "echo" }),
      false,
    );
  });

  test("validates OAuthLoginBody with scopes", () => {
    assert.equal(
      validateOAuthLoginBody({ scopes: ["read", "write"] }),
      true,
    );
  });

  test("validates OAuthLoginBody with empty object", () => {
    assert.equal(validateOAuthLoginBody({}), true);
  });

  test("rejects OAuthLoginBody with invalid scopes type", () => {
    console.warn = () => {};
    assert.equal(validateOAuthLoginBody({ scopes: "read" }), false);
  });

  test("accepts maximal typed CreateMcpServerBody with stdio config", () => {
    const body: CreateMcpServerBody = {
      name: "full-stdio",
      config: {
        transport: "stdio",
        command: "npx",
        args: ["-y", "server"],
        env: { NODE_ENV: "production" },
        envVars: ["API_KEY"],
        cwd: "/home/user",
        enabled: true,
        required: false,
        startupTimeoutSec: 30,
        toolTimeoutSec: 60,
        enabledTools: ["tool_a"],
        disabledTools: ["tool_b"],
        scopes: ["read"],
      },
    };
    assert.equal(validateCreateMcpServerBody(body), true);
  });

  test("accepts maximal typed CreateMcpServerBody with http config", () => {
    const body: CreateMcpServerBody = {
      name: "full-http",
      config: {
        transport: "streamable_http",
        url: "https://mcp.example.com",
        oauthResource: "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
        bearerTokenEnvVar: "TOKEN",
        httpHeaders: { "X-Custom": "value" },
        envHttpHeaders: { Authorization: "BEARER_VAR" },
        enabled: true,
        required: true,
        startupTimeoutSec: 10,
        toolTimeoutSec: 30,
        enabledTools: ["tool_a"],
        disabledTools: [],
        scopes: ["admin"],
      },
    };
    assert.equal(validateCreateMcpServerBody(body), true);
  });

  test("accepts maximal typed UpdateMcpServerBody", () => {
    const body: UpdateMcpServerBody = {
      transport: "stdio",
      command: "server-bin",
      args: ["--verbose"],
      env: { DEBUG: "1" },
      envVars: ["SECRET"],
      cwd: "/tmp",
      enabled: false,
      required: true,
      startupTimeoutSec: 5,
      toolTimeoutSec: 120,
      enabledTools: ["a", "b"],
      disabledTools: ["c"],
      scopes: ["write"],
    };
    assert.equal(validateUpdateMcpServerBody(body), true);
  });

  test("accepts maximal typed OAuthLoginBody", () => {
    const body: OAuthLoginBody = {
      scopes: ["read", "write", "admin"],
    };
    assert.equal(validateOAuthLoginBody(body), true);
  });
});

describe("server request shape validator", () => {
  test("accepts server request with numeric id", () => {
    assert.equal(
      isServerRequestShape({
        id: 42,
        method: "item/commandExecution/requestApproval",
        params: { command: "ls" },
      }),
      true,
    );
  });

  test("accepts server request with string id", () => {
    assert.equal(
      isServerRequestShape({
        id: "req-abc",
        method: "applyPatchApproval",
        params: {},
      }),
      true,
    );
  });

  test("rejects response shape (has result)", () => {
    assert.equal(
      isServerRequestShape({ id: 1, method: "foo", result: {} }),
      false,
    );
  });

  test("rejects response shape (has error)", () => {
    assert.equal(
      isServerRequestShape({
        id: 1,
        method: "foo",
        error: { code: -1, message: "fail" },
      }),
      false,
    );
  });

  test("rejects notification shape (no id)", () => {
    assert.equal(
      isServerRequestShape({ method: "foo", params: {} }),
      false,
    );
  });

  test("rejects non-objects", () => {
    assert.equal(isServerRequestShape("string"), false);
    assert.equal(isServerRequestShape(null), false);
    assert.equal(isServerRequestShape(42), false);
  });
});

describe("notification shape validator", () => {
  test("accepts valid notification", () => {
    assert.equal(
      isValidNotificationShape({ method: "thread/started", params: {} }),
      true,
    );
  });

  test("rejects response shape (has id)", () => {
    assert.equal(
      isValidNotificationShape({ id: 1, method: "foo", result: {} }),
      false,
    );
  });

  test("rejects non-object", () => {
    assert.equal(isValidNotificationShape("string"), false);
    assert.equal(isValidNotificationShape(null), false);
  });
});
