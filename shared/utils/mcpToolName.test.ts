import { describe, test } from "bun:test";
import assert from "node:assert/strict";

import { prefixToolName, parseToolName, displayToolName } from "./mcpToolName";

describe("prefixToolName", () => {
  test("should_create_prefixed_name_from_server_and_tool", () => {
    assert.equal(prefixToolName("builtin-pdf", "create_pdf"), "builtin-pdf__create_pdf");
  });

  test("should_handle_tool_names_containing_double_underscores", () => {
    assert.equal(prefixToolName("my-server", "some__tool"), "my-server__some__tool");
  });
});

describe("parseToolName", () => {
  test("should_split_prefixed_name_into_server_and_tool", () => {
    const result = parseToolName("builtin-pdf__create_pdf");
    assert.deepEqual(result, { serverId: "builtin-pdf", toolName: "create_pdf" });
  });

  test("should_handle_tool_names_containing_double_underscores", () => {
    const result = parseToolName("my-server__some__tool");
    assert.deepEqual(result, { serverId: "my-server", toolName: "some__tool" });
  });

  test("should_return_null_when_no_separator_found", () => {
    const result = parseToolName("no-separator");
    assert.equal(result, null);
  });

  test("should_roundtrip_with_prefixToolName", () => {
    const serverId = "builtin-interpreter";
    const toolName = "open_file";
    const prefixed = prefixToolName(serverId, toolName);
    const parsed = parseToolName(prefixed);
    assert.deepEqual(parsed, { serverId, toolName });
  });

  test("should_roundtrip_with_double_underscore_tool_name", () => {
    const serverId = "my-mcp";
    const toolName = "do__something__complex";
    const prefixed = prefixToolName(serverId, toolName);
    const parsed = parseToolName(prefixed);
    assert.deepEqual(parsed, { serverId, toolName });
  });
});

describe("displayToolName", () => {
  test("should_return_clean_tool_name_from_prefixed_name", () => {
    assert.equal(displayToolName("builtin-pdf__create_pdf"), "create_pdf");
  });

  test("should_preserve_double_underscores_in_tool_name", () => {
    assert.equal(displayToolName("my-server__some__tool"), "some__tool");
  });

  test("should_return_original_when_no_separator_found", () => {
    assert.equal(displayToolName("plain-tool-name"), "plain-tool-name");
  });

  test("should_return_clean_name_matching_parseToolName", () => {
    const prefixed = "builtin-interpreter__open_file";
    const parsed = parseToolName(prefixed);
    assert.equal(displayToolName(prefixed), parsed!.toolName);
  });
});
