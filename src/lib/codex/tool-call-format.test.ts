import { describe, test } from "bun:test";
import assert from "node:assert/strict";

import type { v2 } from "../../../server/handlers/codex-generated-types/index";
import {
  extractCommandActions,
  extractToolCategory,
  extractToolQuery,
  extractToolVerb,
  extractToolTarget,
  formatToolDetails,
  parseInterpreterAppServiceToolCommand,
  parseShellActions,
  parseShellCommand,
} from "./tool-call-format";

// ---------------------------------------------------------------------------
// Helpers to build minimal ThreadItem stubs
// ---------------------------------------------------------------------------

function mcpItem(overrides: Partial<Extract<v2.ThreadItem, { type: "mcpToolCall" }>> = {}): v2.ThreadItem {
  return {
    type: "mcpToolCall",
    id: "mcp-1",
    server: "builtin-fs",
    tool: "builtin-fs__Edit",
    status: "completed",
    arguments: {},
    result: null,
    error: null,
    durationMs: null,
    ...overrides,
  } as v2.ThreadItem;
}

function fileChangeItem(paths: string[]): v2.ThreadItem {
  return {
    type: "fileChange",
    id: "fc-1",
    status: "completed",
    changes: paths.map((p) => ({ path: p, kind: { type: "update" as const, move_path: null }, diff: "" })),
  } as v2.ThreadItem;
}

function commandItem(command: string): v2.ThreadItem {
  return {
    type: "commandExecution",
    id: "cmd-1",
    command,
    cwd: "/tmp",
    processId: null,
    status: "completed",
    commandActions: [],
    aggregatedOutput: null,
    exitCode: 0,
    durationMs: null,
  } as v2.ThreadItem;
}

function imageViewItem(path: string): v2.ThreadItem {
  return { type: "imageView", id: "img-1", path } as v2.ThreadItem;
}

function webSearchItem(query: string): v2.ThreadItem {
  return { type: "webSearch", id: "ws-1", query, action: null } as v2.ThreadItem;
}

function reasoningItem(): v2.ThreadItem {
  return { type: "reasoning", id: "r-1", summary: [], content: [] } as v2.ThreadItem;
}

// ---------------------------------------------------------------------------
// extractToolVerb
// ---------------------------------------------------------------------------

describe("extractToolVerb", () => {
  test("should_return_verb_from_TOOL_DISPLAY_for_known_mcp_tool", () => {
    const verb = extractToolVerb(mcpItem({ tool: "builtin-fs__Edit" }));
    assert.equal(verb.active, "Editing");
    assert.equal(verb.past, "Edited");
  });

  test("should_return_verb_from_TOOL_DISPLAY_for_read_tool", () => {
    const verb = extractToolVerb(mcpItem({ tool: "builtin-fs__Read" }));
    assert.equal(verb.active, "Reading");
    assert.equal(verb.past, "Read");
  });

  test("should_return_default_verb_for_unknown_mcp_tool", () => {
    const verb = extractToolVerb(mcpItem({ tool: "custom-server__unknown_tool" }));
    assert.equal(verb.active, "Processing");
    assert.equal(verb.past, "Processed");
  });

  test("should_return_verb_for_fileChange", () => {
    const verb = extractToolVerb(fileChangeItem(["/tmp/file.ts"]));
    assert.equal(verb.active, "Editing");
    assert.equal(verb.past, "Edited");
  });

  test("should_return_verb_for_commandExecution", () => {
    const verb = extractToolVerb(commandItem("ls -la"));
    assert.equal(verb.active, "Running");
    assert.equal(verb.past, "Ran");
  });

  test("should_return_verb_for_webSearch", () => {
    const verb = extractToolVerb(webSearchItem("test query"));
    assert.equal(verb.active, "Searching");
    assert.equal(verb.past, "Searched");
  });

  test("should_return_verb_for_imageView", () => {
    const verb = extractToolVerb(imageViewItem("/tmp/img.png"));
    assert.equal(verb.active, "Viewing");
    assert.equal(verb.past, "Viewed");
  });

  test("should_return_verb_for_reasoning", () => {
    const verb = extractToolVerb(reasoningItem());
    assert.equal(verb.active, "Reasoning");
    assert.equal(verb.past, "Reasoned");
  });
});

// ---------------------------------------------------------------------------
// extractToolTarget
// ---------------------------------------------------------------------------

describe("extractToolTarget", () => {
  test("should_extract_basename_from_mcp_file_path_argument", () => {
    const target = extractToolTarget(mcpItem({
      tool: "builtin-fs__Edit",
      arguments: { file_path: "/Users/vic/project/src/App.tsx" },
    }));
    assert.equal(target, "App.tsx");
  });

  test("should_extract_basename_from_mcp_path_argument", () => {
    const target = extractToolTarget(mcpItem({
      tool: "builtin-fs__read_file",
      arguments: { path: "/Users/vic/notes/Note.md" },
    }));
    assert.equal(target, "Note.md");
  });

  test("should_use_command_arg_when_present_on_an_mcp_tool_call", () => {
    const target = extractToolTarget(mcpItem({
      tool: "custom__tool",
      arguments: { command: "bun test" },
    }));
    assert.equal(target, "bun test");
  });

  test("should_return_undefined_for_mcp_tool_with_no_recognizable_args", () => {
    const target = extractToolTarget(mcpItem({
      tool: "custom__tool",
      arguments: { foo: "bar" },
    }));
    assert.equal(target, undefined);
  });

  test("should_extract_basename_from_first_fileChange_path", () => {
    const target = extractToolTarget(fileChangeItem(["/Users/vic/src/index.ts", "/Users/vic/src/utils.ts"]));
    assert.equal(target, "index.ts");
  });

  test("should_return_undefined_for_empty_fileChange", () => {
    const target = extractToolTarget(fileChangeItem([]));
    assert.equal(target, undefined);
  });

  test("should_return_command_for_commandExecution", () => {
    const target = extractToolTarget(commandItem("bun run build"));
    assert.equal(target, "bun run build");
  });

  test("should_return_query_for_webSearch", () => {
    const target = extractToolTarget(webSearchItem("react hooks"));
    assert.equal(target, "react hooks");
  });

  test("should_extract_basename_from_imageView_path", () => {
    const target = extractToolTarget(imageViewItem("/Users/vic/screenshots/design.png"));
    assert.equal(target, "design.png");
  });

  test("should_return_undefined_for_reasoning", () => {
    const target = extractToolTarget(reasoningItem());
    assert.equal(target, undefined);
  });
});

describe("extractToolCategory", () => {
  test("should_use_known_mcp_category", () => {
    assert.equal(extractToolCategory(mcpItem({ tool: "builtin-fs__read_file" })), "explore");
  });

  test("should_use_command_category_for_shell", () => {
    assert.equal(extractToolCategory(commandItem("bun test")), "run");
  });
});

describe("extractToolQuery", () => {
  test("should_extract_query_from_search_tool_arguments", () => {
    const value = extractToolQuery(mcpItem({
      tool: "builtin-fs__search_files",
      arguments: { query: "needle" },
    }));

    assert.equal(value, "needle");
  });

  test("should_extract_query_from_shell_search_command", () => {
    const value = extractToolQuery(commandItem("rg tool-fallback agent/components"));
    assert.equal(value, "tool-fallback");
  });
});

describe("formatToolDetails", () => {
  test("should_not_include_mcp_tool_arguments", () => {
    const details = formatToolDetails(mcpItem({
      server: "github",
      tool: "search_issues",
      arguments: { query: "is:issue repo:openai/codex" },
    }));

    assert.equal(details?.includes("Server: github"), true);
    assert.equal(details?.includes("Tool: search_issues"), true);
    assert.equal(details?.includes("Arguments:"), false);
    assert.equal(details?.includes("is:issue repo:openai/codex"), false);
  });
});

describe("parseShellCommand", () => {
  test("should_parse_read_command", () => {
    const value = parseShellCommand("sed -n '1,40p' src/main.ts");
    assert.equal(value.kind, "read");
    assert.equal(value.path, "src/main.ts");
  });

  test("should_parse_search_command", () => {
    const value = parseShellCommand("rg ApprovalPromptDock agent/components");
    assert.equal(value.kind, "search");
    assert.equal(value.query, "ApprovalPromptDock");
    assert.equal(value.path, "agent/components");
  });

  test("should_parse_git_command", () => {
    const value = parseShellCommand("git diff src/index.css");
    assert.equal(value.kind, "git");
    assert.equal(value.subcommand, "diff");
    assert.equal(value.path, "src/index.css");
  });

  test("should_parse_test_command", () => {
    const value = parseShellCommand("pnpm test src/lib/codex/tool-call-format.test.ts");
    assert.equal(value.kind, "test");
    assert.equal(value.path, "src/lib/codex/tool-call-format.test.ts");
  });

  test("should_parse_wrapped_read_command", () => {
    const value = parseShellCommand("/bin/zsh -lc 'cat src/lib/codex/tool-call-format.ts'");
    assert.equal(value.kind, "read");
    assert.equal(value.path, "src/lib/codex/tool-call-format.ts");
  });

  test("should_parse_wrapped_search_command", () => {
    const value = parseShellCommand("/bin/zsh -lc 'rg ApprovalPromptDock agent/components'");
    assert.equal(value.kind, "search");
    assert.equal(value.query, "ApprovalPromptDock");
    assert.equal(value.path, "agent/components");
  });
});

describe("parseInterpreterAppServiceToolCommand", () => {
  test("should_parse_interpreter_app_mcp_command", () => {
    const value = parseInterpreterAppServiceToolCommand(
      "interpreter-app mcp acme list_records --json '{\"start_date\":\"2026-04-01\"}'",
    );

    assert.equal(value?.serviceLabel, "Acme");
    assert.equal(value?.toolName, "list_records");
    assert.equal(value?.active, "Listing Records...");
    assert.equal(value?.past, "Listed Records");
  });

  test("should_parse_existing_tools_syntax_for_configured_mcp_servers", () => {
    const value = parseInterpreterAppServiceToolCommand(
      "interpreter-app tools calendar create_event --json '{\"title\":\"Review\"}'",
    );

    assert.equal(value?.syntax, "tools");
    assert.equal(value?.serviceLabel, "Calendar");
    assert.equal(value?.active, "Creating Event...");
  });

  test("should_not_parse_builtin_tool_commands_as_mcp_services", () => {
    const value = parseInterpreterAppServiceToolCommand(
      "interpreter-app tools builtin-cells read_spreadsheet --json '{\"path\":\"report.xlsx\"}'",
    );

    assert.equal(value, null);
  });
});

describe("parseShellActions", () => {
  test("should_split_compound_commands_into_multiple_actions", () => {
    const value = parseShellActions("cd src && ls && cat main.ts", "/Users/vic/project");

    assert.deepEqual(
      value.map((entry) => ({ kind: entry.kind, mentions: entry.mentions.map((mention) => mention.path) })),
      [
        { kind: "list", mentions: ["/Users/vic/project/src"] },
        { kind: "read", mentions: ["/Users/vic/project/src/main.ts"] },
      ],
    );
  });

  test("should_use_cwd_for_pwd", () => {
    const value = parseShellActions("pwd", "/Users/vic/project/src");

    assert.equal(value[0]?.kind, "list");
    assert.equal(value[0]?.past, "Explored folder");
    assert.deepEqual(value[0]?.mentions.map((entry) => entry.path), ["/Users/vic/project/src"]);
    assert.equal(value[0]?.mentions[0]?.itemType, "directory");
  });

  test("should_capture_written_files_from_redirects", () => {
    const value = parseShellActions("cat notes.txt > summary.txt", "/Users/vic/project");

    assert.deepEqual(
      value[0]?.mentions.map((entry) => entry.path),
      ["/Users/vic/project/notes.txt", "/Users/vic/project/summary.txt"],
    );
  });

  test("should_not_treat_sed_replacement_expressions_as_file_mentions", () => {
    const value = parseShellActions(
      "find . -maxdepth 3 -type f | sed 's#\"^./##\"' | sort | head -200",
      "/Users/vic/project",
    );

    assert.equal(
      value.some((entry) => entry.mentions.some((mention) => mention.path.endsWith("/s#\"^./##\""))),
      false,
    );
  });

  test("should_treat_script_runners_as_script_actions", () => {
    const value = parseShellActions("osascript scripts/say_time.applescript", "/Users/vic/project");

    assert.equal(value[0]?.kind, "run");
    assert.equal(value[0]?.active, "Running script...");
    assert.deepEqual(value[0]?.mentions.map((entry) => entry.path), [
      "/Users/vic/project/scripts/say_time.applescript",
    ]);
  });

  test("should_render_interpreter_app_mcp_commands_as_service_actions", () => {
    const value = parseShellActions(
      "interpreter-app mcp acme list_records --json '{\"start_date\":\"2026-04-01\"}'",
      "/Users/vic/project",
    );

    assert.equal(value[0]?.kind, "run");
    assert.equal(value[0]?.service?.serviceLabel, "Acme");
    assert.equal(value[0]?.active, "Listing Records...");
    assert.equal(value[0]?.past, "Listed Records");
  });

  test("should_render_interpreter_app_spreadsheet_reads_as_app_actions", () => {
    const value = parseShellActions(
      "interpreter-app tools builtin-cells read_spreadsheet --json '{\"path\":\"April-2026/close.xlsx\"}'",
      "/Users/vic/project",
    );

    assert.equal(value[0]?.kind, "read");
    assert.equal(value[0]?.active, "Reading spreadsheet...");
    assert.equal(value[0]?.past, "Read spreadsheet");
    assert.deepEqual(value[0]?.mentions.map((entry) => entry.path), [
      "/Users/vic/project/April-2026/close.xlsx",
    ]);
  });

  test("should_decode_shell_wrapped_interpreter_app_json_paths", () => {
    const value = parseShellActions(
      `/bin/zsh -lc "interpreter-app tools builtin-cells read_spreadsheet --json '{\\"path\\":\\"April-2026/close.xlsx\\",\\"sheet\\":\\"Close Summary\\"}'"`,
      "/Users/vic/project",
    );

    assert.equal(value[0]?.kind, "read");
    assert.deepEqual(value[0]?.mentions.map((entry) => entry.path), [
      "/Users/vic/project/April-2026/close.xlsx",
    ]);
  });

  test("should_render_interpreter_app_spreadsheet_writes_as_app_actions", () => {
    const value = parseShellActions(
      "interpreter-app tools builtin-cells batch_edit_spreadsheet --json '{\"path\":\"April-2026/close.xlsx\"}'",
      "/Users/vic/project",
    );

    assert.equal(value[0]?.kind, "write");
    assert.equal(value[0]?.active, "Editing spreadsheet...");
    assert.equal(value[0]?.past, "Edited spreadsheet");
    assert.deepEqual(value[0]?.mentions.map((entry) => entry.path), [
      "/Users/vic/project/April-2026/close.xlsx",
    ]);
  });

  test("should_render_interpreter_refresh_file_without_raw_tool_name", () => {
    const value = parseShellActions(
      "interpreter-app tools builtin-interpreter interpreter_refresh_file --json '{\"path\":\"April-2026/close.xlsx\"}'",
      "/Users/vic/project",
    );

    assert.equal(value[0]?.label, "Refresh file view");
    assert.equal(value[0]?.active, "Refreshing file view...");
    assert.equal(value[0]?.past, "Refreshed file view");
  });

  test("should_collapse_shell_control_flow_into_a_single_summary_action", () => {
    const value = parseShellActions(
      'for cmd in magick rsvg-convert inkscape qlmanage python3; do if command -v "$cmd" >/dev/null 2>&1; then echo "$cmd: $(command -v \\"$cmd\\")"; fi; done',
      "/Users/vic/project",
    );

    assert.equal(value.length, 1);
    assert.equal(value[0]?.kind, "run");
    assert.equal(value[0]?.past, "Checked installed commands");
    assert.deepEqual(value[0]?.mentions.map((entry) => entry.path), [
      "/Users/vic/project",
    ]);
  });

  test("should_collapse_multiline_shell_scripts_into_a_single_summary_action", () => {
    const value = parseShellActions(
      'set -e\nfor cmd in magick rsvg-convert; do\n  command -v "$cmd" >/dev/null 2>&1\n done',
      "/Users/vic/project",
    );

    assert.equal(value.length, 1);
    assert.equal(value[0]?.kind, "run");
    assert.equal(value[0]?.active, "Checking installed commands...");
  });

  test("should_not_extract_bogus_mentions_from_python_raw_string_paths_in_heredocs", () => {
    const value = parseShellActions(
      "python3 - <<'PY' import zipfile, xml.etree.ElementTree as ET, re path = r'/Users/example/Documents/Research/Community Schools/sheet.xlsx' print(path) PY",
      "/Users/example/Documents/Research/Community Schools",
    );

    assert.deepEqual(value[0]?.mentions.map((entry) => entry.path), [
      "/Users/example/Documents/Research/Community Schools",
    ]);
    assert.equal(value[0]?.mentions[0]?.itemType, "directory");
  });

  test("should_collapse_multiline_python_heredoc_with_spaced_paths_to_workspace_mention", () => {
    const workspace = "/Users/example/Documents/Research/Community Schools";
    const value = parseShellActions(
      `python3 - <<'PY'
from pathlib import Path
path = r'${workspace}/Central Valley _School Sites 9.12.xlsx'
print(Path(path).name)
PY`,
      workspace,
    );

    assert.equal(value.length, 1);
    assert.equal(value[0]?.past, "Ran shell script");
    assert.deepEqual(value[0]?.mentions.map((entry) => entry.path), [workspace]);
  });

  test("should_not_extract_path_mentions_from_inline_interpreter_source", () => {
    const value = parseShellActions(
      "python3 -c \"path = '/Users/vic/project/report.xlsx'; print(path)\"",
      "/Users/vic/project",
    );

    assert.deepEqual(value[0]?.mentions, []);
  });

  test("should_not_extract_path_mentions_from_node_eval_source", () => {
    const value = parseShellActions(
      "node -e \"require('fs').readFileSync('/Users/vic/project/2025/2026/input.json')\"",
      "/Users/vic/project",
    );

    assert.deepEqual(value[0]?.mentions, []);
  });

  test("should_not_extract_module_names_as_path_mentions", () => {
    const value = parseShellActions("python3 -m http.server", "/Users/vic/project");

    assert.deepEqual(value[0]?.mentions, []);
  });

  test("should_not_extract_scoped_package_names_as_path_mentions", () => {
    const value = parseShellActions(
      "npx --package @playwright/cli playwright-cli snapshot",
      "/Users/vic/project",
    );

    assert.deepEqual(value[0]?.mentions, []);
  });

  test("should_not_extract_paths_from_powershell_wrapped_playwright_snapshot", () => {
    const value = parseShellActions(
      "powershell.exe -Command 'npx --package @playwright/cli playwright-cli snapshot'",
      "C:\\vault",
    );

    assert.deepEqual(value[0]?.mentions, []);
  });

  test("should_unwrap_windows_powershell_paths_before_extracting_mentions", () => {
    const value = parseShellActions(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -Command 'npx --package @playwright/cli playwright-cli snapshot'",
      "C:\\vault",
    );

    assert.deepEqual(value[0]?.mentions, []);
  });

  test("should_only_mention_script_file_for_script_runner_with_path_like_arguments", () => {
    const value = parseShellActions(
      "python3 scripts/analyze.py '/Users/vic/project/Research/Community Schools/input.xlsx'",
      "/Users/vic/project",
    );

    assert.deepEqual(value[0]?.mentions.map((entry) => entry.path), [
      "/Users/vic/project/scripts/analyze.py",
    ]);
  });

  test("should_not_surface_dev_null_as_a_file_mention", () => {
    const value = parseShellActions("cat notes.txt >/dev/null", "/Users/vic/project");

    assert.deepEqual(value[0]?.mentions.map((entry) => entry.path), [
      "/Users/vic/project/notes.txt",
    ]);
  });

  test("should_not_treat_jq_filters_as_file_mentions", () => {
    const value = parseShellActions("interpreter tools list | jq -r '.servers[] | .id'", "/Users/vic/project");

    assert.deepEqual(
      value.map((entry) => entry.mentions.map((mention) => mention.path)),
      [
        [],
        [],
      ],
    );
  });

  test("should_keep_real_jq_input_files_as_mentions", () => {
    const value = parseShellActions("jq -r '.servers[] | .id' data/tools.json", "/Users/vic/project");

    assert.deepEqual(value[0]?.mentions.map((entry) => entry.path), [
      "/Users/vic/project/data/tools.json",
    ]);
  });

  test("should_treat_sleep_as_wait_with_human_duration", () => {
    const value = parseShellActions("sleep 1m30s", "/Users/vic/project");

    assert.equal(value[0]?.label, "Wait");
    assert.equal(value[0]?.active, "Waiting for 1 minute 30 seconds...");
    assert.equal(value[0]?.past, "Waited for 1 minute 30 seconds");
    assert.deepEqual(value[0]?.mentions, []);
  });

  test("should_treat_clear_date_history_and_open_as_common_terminal_actions", () => {
    const cleared = parseShellActions("clear", "/Users/vic/project");
    assert.equal(cleared[0]?.label, "Clear terminal");
    assert.equal(cleared[0]?.past, "Cleared terminal");

    const dated = parseShellActions("date", "/Users/vic/project");
    assert.equal(dated[0]?.label, "Check time");
    assert.equal(dated[0]?.past, "Checked time");

    const history = parseShellActions("history", "/Users/vic/project");
    assert.equal(history[0]?.label, "View history");
    assert.equal(history[0]?.past, "Viewed history");

    const opened = parseShellActions("open README.md", "/Users/vic/project");
    assert.equal(opened[0]?.label, "Open");
    assert.deepEqual(opened[0]?.mentions.map((entry) => entry.path), [
      "/Users/vic/project/README.md",
    ]);
  });

  test("should_treat_cat_heredoc_redirect_as_file_write", () => {
    const value = parseShellActions(
      "cat > Storyboard-Summary.md <<'EOF'\n# Storyboard Summary\nHello\nEOF",
      "/Users/vic/project",
    );

    assert.equal(value[0]?.kind, "write");
    assert.equal(value[0]?.past, "Created");
    assert.deepEqual(value[0]?.mentions.map((entry) => entry.path), [
      "/Users/vic/project/Storyboard-Summary.md",
    ]);
  });
});

describe("extractCommandActions", () => {
  test("should_prefer_server_side_command_actions_when_available", () => {
    const item = commandItem("python script.py");
    const fallback = extractCommandActions(item);
    assert.equal(fallback[0]?.kind, "run");

    item.commandActions = [
      { type: "listFiles", command: "ls", path: "/Users/vic/project/src" },
      { type: "read", command: "cat src/main.ts", name: "main.ts", path: "/Users/vic/project/src/main.ts" },
    ];

    const parsed = extractCommandActions(item);
    assert.deepEqual(
      parsed.map((entry) => ({ kind: entry.kind, mentions: entry.mentions.map((mention) => mention.path) })),
      [
        { kind: "list", mentions: ["/Users/vic/project/src"] },
        { kind: "read", mentions: ["/Users/vic/project/src/main.ts"] },
      ],
    );
  });

  test("should_merge_server_actions_with_shell_write_hints", () => {
    const item = commandItem("cat notes.txt > summary.txt");
    item.cwd = "/Users/vic/project";
    item.commandActions = [
      { type: "read", command: "cat notes.txt > summary.txt", name: "notes.txt", path: "/Users/vic/project/notes.txt" },
    ];

    const parsed = extractCommandActions(item);
    assert.deepEqual(
      parsed.map((entry) => ({ kind: entry.kind, mentions: entry.mentions.map((mention) => mention.path) })),
      [
        { kind: "read", mentions: ["/Users/vic/project/notes.txt", "/Users/vic/project/summary.txt"] },
      ],
    );
  });

  test("should_parse_js_repl_browser_actions_from_source_input", () => {
    const item = commandItem("js_repl");
    const source = [
      'await page.goto("https://example.com/settings");',
      'const continueButton = page.getByRole("button", { name: "Continue" });',
      'await page.getByLabel("Email").fill("user@example.com");',
      'await continueButton.click();',
      'await page.getByLabel("Search").press("Enter");',
    ].join("\n");

    const parsed = extractCommandActions(item, source, "js_repl");

    assert.deepEqual(parsed.map((entry) => entry.past), [
      "Navigated to https://example.com/settings",
      "Typed in Email",
      "Clicked Continue",
      "Pressed Enter in Search",
    ]);
  });

  test("should_parse_browser_control_bootstrap_steps", () => {
    const item = commandItem("js_repl");
    const source = [
      'const playwrightModule = await import("playwright-core");',
      'const response = await fetch(`${relayHttpEndpoint}/extensions/status`);',
      'browser = await chromium.connectOverCDP(wsEndpoint);',
      'page = await ensurePage();',
      'console.log({ title: await page.title(), url: page.url() });',
    ].join("\n");

    const parsed = extractCommandActions(item, source, "js_repl");

    assert.deepEqual(parsed.map((entry) => entry.past), [
      "Loaded Playwright",
      "Inspected browser sessions",
      "Connected to browser",
      "Selected live page",
      "Read page state",
    ]);
  });

  test("should_fallback_to_ran_javascript_when_js_repl_source_is_missing", () => {
    const item = commandItem("js_repl");
    const parsed = extractCommandActions(item, undefined, "js_repl");

    assert.equal(parsed[0]?.active, "Running JavaScript...");
    assert.equal(parsed[0]?.past, "Ran JavaScript");
  });
});
