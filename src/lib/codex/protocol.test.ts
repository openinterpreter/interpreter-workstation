import { describe, test } from "bun:test";
import assert from "node:assert/strict";

import {
  type McpServerConfig,
  type McpServerEntry,
  type McpServerTomlEntry,
  mcpServerEntryToToml,
  tomlEntryToMcpServerConfig,
} from "./protocol";

describe("mcpServerEntryToToml", () => {
  test("should_convert_stdio_entry_to_toml_with_snake_case_keys", () => {
    const entry: McpServerEntry = {
      name: "my-server",
      config: {
        transport: "stdio",
        command: "npx",
        args: ["-y", "my-mcp-server"],
        env: { NODE_ENV: "production" },
        envVars: ["API_KEY"],
        cwd: "/home/user",
        enabled: true,
        startupTimeoutSec: 30,
        toolTimeoutSec: 60,
      },
    };

    const toml = mcpServerEntryToToml(entry);

    assert.equal(toml.command, "npx");
    assert.deepEqual(toml.args, ["-y", "my-mcp-server"]);
    assert.deepEqual(toml.env, { NODE_ENV: "production" });
    assert.deepEqual(toml.env_vars, ["API_KEY"]);
    assert.equal(toml.cwd, "/home/user");
    assert.equal(toml.enabled, true);
    assert.equal(toml.startup_timeout_sec, 30);
    assert.equal(toml.tool_timeout_sec, 60);
    assert.equal(toml.url, undefined);
    assert.equal("transport" in toml, false);
  });

  test("should_convert_streamable_http_entry_to_toml", () => {
    const entry: McpServerEntry = {
      name: "remote-server",
      config: {
        transport: "streamable_http",
        url: "https://mcp.example.com/sse",
        oauthResource: "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
        bearerTokenEnvVar: "MCP_TOKEN",
        httpHeaders: { "X-Custom": "value" },
        envHttpHeaders: { Authorization: "BEARER_VAR" },
        required: true,
        defaultToolsApprovalMode: "prompt",
        tools: {
          read_docs: { approvalMode: "auto" },
          write_docs: { approvalMode: "prompt" },
        },
        enabledTools: ["tool_a", "tool_b"],
        scopes: ["read", "write"],
      },
    };

    const toml = mcpServerEntryToToml(entry);

    assert.equal(toml.url, "https://mcp.example.com/sse");
    assert.equal(
      toml.oauth_resource,
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
    );
    assert.equal(toml.bearer_token_env_var, "MCP_TOKEN");
    assert.deepEqual(toml.http_headers, { "X-Custom": "value" });
    assert.deepEqual(toml.env_http_headers, { Authorization: "BEARER_VAR" });
    assert.equal(toml.required, true);
    assert.equal(toml.default_tools_approval_mode, "prompt");
    assert.deepEqual(toml.tools, {
      read_docs: { approval_mode: "auto" },
      write_docs: { approval_mode: "prompt" },
    });
    assert.deepEqual(toml.enabled_tools, ["tool_a", "tool_b"]);
    assert.deepEqual(toml.scopes, ["read", "write"]);
    assert.equal(toml.command, undefined);
    assert.equal("transport" in toml, false);
  });

  test("should_omit_undefined_optional_fields", () => {
    const entry: McpServerEntry = {
      name: "minimal",
      config: {
        transport: "stdio",
        command: "my-server",
      },
    };

    const toml = mcpServerEntryToToml(entry);

    assert.equal(toml.command, "my-server");
    assert.equal(toml.args, undefined);
    assert.equal(toml.env, undefined);
    assert.equal(toml.enabled, undefined);
    assert.equal(toml.startup_timeout_sec, undefined);

    const keys = Object.keys(toml);
    assert.equal(keys.length, 1);
    assert.equal(keys[0], "command");
  });
});

describe("tomlEntryToMcpServerConfig", () => {
  test("should_infer_stdio_transport_from_command_presence", () => {
    const toml: McpServerTomlEntry = {
      command: "npx",
      args: ["-y", "server"],
      env: { KEY: "val" },
      env_vars: ["SECRET"],
      cwd: "/tmp",
      enabled: true,
      startup_timeout_sec: 10,
      tool_timeout_sec: 30,
      default_tools_approval_mode: "prompt",
      tools: {
        read_docs: { approval_mode: "auto" },
        write_docs: { approval_mode: "prompt" },
      },
      enabled_tools: ["tool_1"],
      disabled_tools: ["tool_2"],
      scopes: ["scope_1"],
    };

    const config = tomlEntryToMcpServerConfig(toml);

    assert.equal(config.transport, "stdio");
    if (config.transport !== "stdio") throw new Error("unreachable");
    assert.equal(config.command, "npx");
    assert.deepEqual(config.args, ["-y", "server"]);
    assert.deepEqual(config.env, { KEY: "val" });
    assert.deepEqual(config.envVars, ["SECRET"]);
    assert.equal(config.cwd, "/tmp");
    assert.equal(config.enabled, true);
    assert.equal(config.startupTimeoutSec, 10);
    assert.equal(config.toolTimeoutSec, 30);
    assert.equal(config.defaultToolsApprovalMode, "prompt");
    assert.deepEqual(config.tools, {
      read_docs: { approvalMode: "auto" },
      write_docs: { approvalMode: "prompt" },
    });
    assert.deepEqual(config.enabledTools, ["tool_1"]);
    assert.deepEqual(config.disabledTools, ["tool_2"]);
    assert.deepEqual(config.scopes, ["scope_1"]);
  });

  test("should_infer_streamable_http_transport_from_url_presence", () => {
    const toml: McpServerTomlEntry = {
      url: "https://example.com/mcp",
      oauth_resource: "https://example.com/.well-known/oauth-protected-resource/mcp",
      bearer_token_env_var: "TOKEN_VAR",
      http_headers: { "X-Api": "key" },
      env_http_headers: { Auth: "VAR" },
      required: true,
    };

    const config = tomlEntryToMcpServerConfig(toml);

    assert.equal(config.transport, "streamable_http");
    if (config.transport !== "streamable_http") throw new Error("unreachable");
    assert.equal(config.url, "https://example.com/mcp");
    assert.equal(
      config.oauthResource,
      "https://example.com/.well-known/oauth-protected-resource/mcp",
    );
    assert.equal(config.bearerTokenEnvVar, "TOKEN_VAR");
    assert.deepEqual(config.httpHeaders, { "X-Api": "key" });
    assert.deepEqual(config.envHttpHeaders, { Auth: "VAR" });
    assert.equal(config.required, true);
  });

  test("should_roundtrip_stdio_config_through_toml_and_back", () => {
    const original: McpServerConfig = {
      transport: "stdio",
      command: "my-server",
      args: ["--port", "3000"],
      env: { HOME: "/root" },
      enabled: true,
      startupTimeoutSec: 15,
    };

    const entry: McpServerEntry = { name: "test", config: original };
    const toml = mcpServerEntryToToml(entry);
    const restored = tomlEntryToMcpServerConfig(toml);

    assert.deepEqual(restored, original);
  });

  test("should_roundtrip_http_config_through_toml_and_back", () => {
    const original: McpServerConfig = {
      transport: "streamable_http",
      url: "https://example.com",
      oauthResource: "https://example.com/.well-known/oauth-protected-resource/mcp",
      bearerTokenEnvVar: "TOK",
      httpHeaders: { "X-H": "v" },
      required: true,
      scopes: ["admin"],
    };

    const entry: McpServerEntry = { name: "test", config: original };
    const toml = mcpServerEntryToToml(entry);
    const restored = tomlEntryToMcpServerConfig(toml);

    assert.deepEqual(restored, original);
  });

  test("should_throw_on_toml_entry_with_neither_command_nor_url", () => {
    const toml: McpServerTomlEntry = { enabled: true };

    assert.throws(
      () => tomlEntryToMcpServerConfig(toml),
      /cannot infer transport/i,
    );
  });

  test("should_throw_on_toml_entry_with_both_command_and_url", () => {
    const toml = {
      command: "server",
      url: "https://example.com",
    } as McpServerTomlEntry;

    assert.throws(
      () => tomlEntryToMcpServerConfig(toml),
      /cannot infer transport/i,
    );
  });
});
